"""Atomic market observations and simulated fills, independent of research state."""
import copy
from datetime import timedelta
from decimal import Decimal
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading

from . import policy
from .ledger import UNIT, accounts, advance
from .market import FeedError, bar_window, iso, timestamp, utcnow, validate


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, path, source, *, clock=utcnow, fault_hook=None):
        self.source, self.clock, self.fault_hook = source, clock, fault_hook
        self.mutex = threading.RLock()
        self.poll_lock = threading.Lock()
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = open(str(self.path) + ".lock", "a+")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise RuntimeError("Another V16 process owns this database") from None
        self.db = None
        try:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                new = True
            except FileExistsError:
                new = False
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            if new:
                with self.db:
                    self.db.execute("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)")
                    self.db.execute("CREATE TABLE commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
                    self.db.execute("CREATE TABLE events (id TEXT PRIMARY KEY, run TEXT NOT NULL, data TEXT NOT NULL)")
                    self.db.execute("CREATE INDEX events_by_run ON events(run)")
                    self._save({"schema": "v16.0", "source": source.name, "mode": source.mode,
                                "token": secrets.token_urlsafe(32), "revision": 0, "run": None,
                                "running": False, "started_at": None, "next_due": None,
                                "accounts": accounts(), "market": None, "next_poll": None,
                                "message": "Start monitoring to initialize separate shadow portfolios",
                                "health": {"state": "idle", "message": "No market data received", "last_attempt": None},
                                "failures": 0})
            state = self._read()
            if state["schema"] != "v16.0" or state["source"] != source.name or state["mode"] != source.mode:
                raise ValueError("Database version or data source mismatch; use a separate database")
            self.snapshot()
        except BaseException:
            self.close()
            raise

    def _read(self):
        row = self.db.execute("SELECT data FROM state WHERE id=1").fetchone()
        if row is None:
            raise ValueError("Required state is missing; database was not reset")
        return json.loads(row[0])

    def _save(self, state):
        self.db.execute("INSERT OR REPLACE INTO state VALUES (1,?)", (encode(state),))

    @property
    def token(self):
        with self.mutex:
            return self._read()["token"]

    def boundary(self):
        if self.source.mode == "live" and not policy.LIVE_TECHNICAL_FEED_ALLOWED:
            return policy.LIVE_BOUNDARY_MESSAGE
        if not self.source.configured:
            return "Alpaca data credentials are missing; configure them on the Python host"
        return None

    def snapshot(self):
        with self.mutex:
            state = self._read()
            if type(state["revision"]) is not int or state["revision"] < 0 or type(state["running"]) is not bool or set(state["accounts"]) != set(accounts()):
                raise ValueError("Stored service structure is invalid")
            now = self.clock()
            health = copy.deepcopy(state["health"])
            blocked = self.boundary()
            market = state["market"]
            if blocked:
                health.update(state="blocked", message=blocked)
            elif market and health["state"] == "ready":
                try:
                    age = (now - timestamp(market["observed_at"])).total_seconds()
                    if age < -2 or age > 60 or any((now - timestamp(q["quote_time"])).total_seconds() > 60 for q in market["symbols"].values()) or timestamp(next(iter(market["symbols"].values()))["bar_end"]) != bar_window(now)[1]:
                        health.update(state="stale", message="Saved market data is stale; decisions are blocked until fresh data arrives")
                except (KeyError, ValueError):
                    raise ValueError("Stored market state is invalid") from None
            values = []
            for key, account in state["accounts"].items():
                if key != f'{account["asset"]}-{account["cost"]}' or not Decimal(account["fees"]).is_finite() or Decimal(account["fees"]) < 0:
                    raise ValueError("Stored account identity or fees are invalid")
                cash, quantity = Decimal(account["cash"]), Decimal(account["units"]) / UNIT
                if not cash.is_finite() or cash < 0 or type(account["units"]) is not int or account["units"] < 0:
                    raise ValueError("Stored account state is invalid")
                quote = market["symbols"].get(account["asset"] + "/USD") if market else None
                mid = Decimal(quote["mid"]) if quote else None
                equity = cash + quantity * mid if mid is not None else None
                values.append({"id": key, **account, "quantity": str(quantity),
                               "equity": str(equity) if equity is not None else None,
                               "weight": str(quantity * mid / equity) if equity else None})
            rows = self.db.execute("SELECT data FROM events WHERE run=? ORDER BY rowid DESC LIMIT 120", (state["run"],)).fetchall()
            return {"service": "kaira-v16", "mode": state["mode"], "source": state["source"],
                    "revision": state["revision"], "run": state["run"], "running": state["running"],
                    "started_at": state["started_at"], "next_due": state["next_due"], "next_poll": state["next_poll"],
                    "message": state["message"], "health": health, "market": market,
                    "accounts": values, "events": [json.loads(row[0]) for row in rows],
                    "blocked": blocked, "server_time": iso(now)}

    def command(self, action, body):
        with self.mutex:
            if action not in ("start", "pause", "resume") or not isinstance(body, dict) or set(body) != {"request_id", "expected_run", "expected_revision"}:
                raise ValueError("Invalid command")
            request_id = body["request_id"]
            if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{8,80}", request_id):
                raise ValueError("Invalid request ID")
            payload = encode({"action": action, "body": body})
            old = self.db.execute("SELECT payload FROM commands WHERE id=?", (request_id,)).fetchone()
            if old:
                if old[0] != payload:
                    raise Conflict("Request ID is already used for a different command")
                return {**self.snapshot(), "duplicate": True}
            state = self._read()
            if body["expected_run"] != state["run"] or type(body["expected_revision"]) is not int or (action != "pause" and body["expected_revision"] != state["revision"]):
                raise Conflict("Service state changed; refresh before sending a new command")
            if action != "pause" and self.boundary():
                raise ValueError(self.boundary())
            if action == "start":
                if state["running"]:
                    raise ValueError("Pause the active run before starting another")
                state.update(run=request_id, started_at=iso(self.clock()), next_due=None,
                             accounts=accounts(), market=None, failures=0)
            elif state["run"] is None:
                raise ValueError("Start a run first")
            state["running"] = action != "pause"
            state["health"] = {"state": "waiting" if state["running"] else "paused", "message": "Waiting for a fresh validated data batch" if state["running"] else "Monitoring paused", "last_attempt": state["health"]["last_attempt"]}
            state["message"] = "Monitoring started; awaiting valid data" if state["running"] else "Monitoring paused; no data requests or simulated fills"
            state["revision"] += 1
            with self.db:
                self.db.execute("INSERT INTO commands VALUES (?,?)", (request_id, payload))
                self._save(state)
            return {**self.snapshot(), "duplicate": False}

    def tick(self):
        if not self.poll_lock.acquire(blocking=False):
            return
        try:
            with self.mutex:
                before = self._read()
                now = self.clock()
                if not before["running"] or self.boundary() or (before["next_poll"] and now < timestamp(before["next_poll"])):
                    return
                # Reserve the next request slot durably, including across pause/resume
                # or a process crash while a read-only request is in flight.
                before["next_poll"] = iso(now + timedelta(seconds=30))
                before["health"]["last_attempt"] = iso(now)
                before["revision"] += 1
                with self.db:
                    self._save(before)
                run, revision = before["run"], before["revision"]
            error, retry = None, 30
            try:
                quotes, bars = self.source.fetch(now)
                now = self.clock()  # Freshness is checked after the network response.
                market = validate(quotes, bars, now)
                old_market = before["market"]
                if old_market:
                    if now < timestamp(old_market["observed_at"]):
                        raise ValueError("Clock moved backwards; market data rejected")
                    for symbol, quote in market["symbols"].items():
                        if timestamp(quote["quote_time"]) < timestamp(old_market["symbols"][symbol]["quote_time"]):
                            raise ValueError("Quote timestamps regressed; market data rejected")
                        old_bars = {row["time"]: row for row in old_market["symbols"][symbol]["bars"]}
                        if any(row["time"] in old_bars and row != old_bars[row["time"]] for row in quote["bars"]):
                            raise ValueError("A previously observed completed bar was revised; waiting for a clean data window")
            except (FeedError, ValueError, TypeError, KeyError) as exc:
                error = str(exc) if isinstance(exc, (FeedError, ValueError)) else "Malformed market-data response"
                retry = exc.retry_after if isinstance(exc, FeedError) else 30
            with self.mutex:
                state = self._read()
                # A pause/new run during network I/O invalidates this response.
                if state["run"] != run or state["revision"] != revision or not state["running"]:
                    return
                if error:
                    state["failures"] += 1
                    retry = min(300, max(retry, 30 * 2 ** min(state["failures"] - 1, 4)))
                    state["health"] = {"state": "error", "message": error, "last_attempt": iso(now)}
                    events = []
                else:
                    state["market"], state["failures"] = market, 0
                    state["health"] = {"state": "ready", "message": "Both assets have fresh quotes and contiguous completed bars", "last_attempt": iso(now)}
                    events = advance(state, market, now)
                state["next_poll"] = iso(now + timedelta(seconds=retry))
                state["revision"] += 1
                with self.db:
                    for event in events:
                        event["source"], event["mode"] = self.source.name, self.source.mode
                        event["market_evidence"] = market["symbols"][event["account"].split("-")[0] + "/USD"] if event["status"] != "MISSED" else None
                        self.db.execute("INSERT INTO events VALUES (?,?,?)", (event["id"], run, encode(event)))
                    self._save(state)
                    if self.fault_hook:
                        self.fault_hook()
        finally:
            self.poll_lock.release()

    def close(self):
        if self.db is not None:
            self.db.close()
        self.lock.close()
