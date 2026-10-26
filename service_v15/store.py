"""SQLite-backed single-writer service, durable command plans and HTTP idempotency."""
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import uuid

from .engine import check, create_run, project, transition


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, path, fault_hook=None):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.mutex = threading.RLock()
        self.fault_hook = fault_hook  # Tests only, never exposed over HTTP.
        self.lock_file = open(str(self.path) + ".lock", "a+")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            raise RuntimeError("Toinen palvelu käyttää jo tätä tietokantaa") from None
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
                    self.db.execute("BEGIN IMMEDIATE")
                    self.db.execute("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                    self.db.execute("CREATE TABLE commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL, plan TEXT NOT NULL, done INTEGER NOT NULL)")
                    for key, value in {"schema": "v15.0", "journal": None, "broker": None, "control": {"running": False, "message": "Valmis aloittamaan."}, "revision": 0, "token": secrets.token_urlsafe(32)}.items():
                        self._put(key, value)
            check(self._get("schema") == "v15.0", "Tuntematon tietokantaversio")
            self._recover()
            self.snapshot()
        except BaseException:
            self.close()
            raise

    def _get(self, key):
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        check(row is not None, "Tietokannasta puuttuu pakollinen tieto")
        return json.loads(row[0])

    def _put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO state VALUES (?,?)", (key, encode(value)))

    @property
    def token(self):
        with self.mutex:
            return self._get("token")

    def _apply(self, request_id, plan):
        # Replaying a pending plan sets exactly the same values, never adds fills.
        for index, (key, value) in enumerate(plan):
            check(key in ("journal", "broker", "control", "revision"), "Virheellinen tallennussuunnitelma")
            with self.db:
                self._put(key, value)
            if self.fault_hook:
                self.fault_hook(index, key)
        with self.db:
            self.db.execute("UPDATE commands SET done=1 WHERE id=?", (request_id,))

    def _recover(self):
        rows = self.db.execute("SELECT id, plan FROM commands WHERE done=0 ORDER BY rowid").fetchall()
        check(len(rows) <= 1, "Ristiriitaisia keskeneräisiä komentoja")
        for request_id, plan in rows:
            self._apply(request_id, json.loads(plan))

    def snapshot(self):
        with self.mutex:
            self._recover()
            journal, broker = self._get("journal"), self._get("broker")
            check((journal is None) == (broker is None), "Toinen suoritusloki puuttuu")
            view = project(journal, broker) if journal is not None else None
            control, revision = self._get("control"), self._get("revision")
            check(type(revision) is int and revision >= 0 and isinstance(control, dict) and set(control) == {"running", "message"} and type(control["running"]) is bool and isinstance(control["message"], str), "Virheellinen palvelutila")
            check(not control["running"] or (view is not None and not view["complete"]), "Virheellinen ajotila")
            return {"service": "kaira-v15", "mode": "synthetic", "revision": revision, "run": journal["run"] if journal else None,
                    "config": journal["config"] if journal else None, "control": control, "view": view}

    def command(self, action, body, *, internal=False):
        with self.mutex:
            self._recover()
            check(action in ("start", "step", "run", "pause"), "Tuntematon komento")
            fields = {"request_id", "expected_run", "expected_revision"} | ({"config"} if action == "start" else set())
            check(isinstance(body, dict) and set(body) == fields, "Virheellinen komentomuoto")
            request_id = body["request_id"]
            check(isinstance(request_id, str) and re.fullmatch(r"[a-zA-Z0-9-]{8,80}", request_id), "Virheellinen pyyntötunniste")
            payload = encode({"action": action, "body": body, "internal": internal})
            old = self.db.execute("SELECT payload FROM commands WHERE id=?", (request_id,)).fetchone()
            if old:
                if old[0] != payload:
                    raise Conflict("Pyyntötunniste on jo käytössä eri komennolla")
                return {**self.snapshot(), "duplicate": True}
            current = self.snapshot()
            if body["expected_run"] != current["run"] or type(body["expected_revision"]) is not int or (action != "pause" and body["expected_revision"] != current["revision"]):
                raise Conflict("Palvelun tila muuttui. Päivitä näkymä ennen uutta komentoa.")
            control = dict(current["control"])
            writes = []
            if action == "start":
                check(not control["running"], "Pysäytä nykyinen ajo ennen uutta suoritusta")
                journal, broker = create_run(body["config"], request_id)
                writes = [("broker", broker), ("journal", journal)]
                control = {"running": False, "message": "Uusi suoritus tallennettu Python-palveluun."}
            else:
                check(current["view"] is not None, "Aloita ensin uusi suoritus")
                if action == "pause":
                    control = {"running": False, "message": "Ajo pysäytetty. Tilasta voi jatkaa."}
                elif action == "run":
                    check(not current["view"]["complete"], "Testivuosi on jo valmis")
                    control = {"running": True, "message": "Python suorittaa testivuotta. Voit sulkea selaimen."}
                else:
                    check(internal or not control["running"], "Pysäytä automaattinen ajo ennen yksittäistä vaihetta")
                    writes, interrupted, message = transition(self._get("journal"), self._get("broker"))
                    complete = any(k == "journal" and v["complete"] for k, v in writes) or current["view"]["complete"]
                    control = {"running": control["running"] and not interrupted and not complete, "message": message}
            plan = writes + [("control", control), ("revision", current["revision"] + 1)]
            # The intent to apply this exact command is durable before any effect.
            with self.db:
                self.db.execute("INSERT INTO commands VALUES (?,?,?,0)", (request_id, payload, encode(plan)))
            if self.fault_hook:
                self.fault_hook(-1, "plan")
            self._apply(request_id, plan)
            return {**self.snapshot(), "duplicate": False}

    def tick(self):
        with self.mutex:
            current = self.snapshot()
            if current["control"]["running"]:
                return self.command("step", {"request_id": str(uuid.uuid4()), "expected_run": current["run"], "expected_revision": current["revision"]}, internal=True)
            return current

    def close(self):
        if self.db is not None:
            self.db.close()
        self.lock_file.close()
