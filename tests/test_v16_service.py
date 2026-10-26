"""Synthetic-only operational tests. No study data, provider credentials or external traffic."""
import json
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
import subprocess
import sys
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest

from service_v16 import policy
from service_v16.ledger import UNIT
from service_v16.market import AlpacaSource, FeedError, FixtureSource, UTC, iso
from service_v16.server import Server, credentials
from service_v16.store import Store, Conflict

ROOT = Path(__file__).resolve().parents[1]


class Clock:
    def __init__(self): self.now = datetime(2020, 1, 14, 12, 3, tzinfo=UTC)
    def __call__(self): return self.now


class Source(FixtureSource):
    def __init__(self): self.calls, self.change, self.failure = 0, None, None
    def fetch(self, now):
        self.calls += 1
        if self.failure: raise self.failure
        q, b = super().fetch(now)
        if self.change: self.change(q, b)
        return q, b


@pytest.fixture
def service(tmp_path):
    clock, source = Clock(), Source()
    store = Store(tmp_path / "db", source, clock=clock)
    yield store, source, clock
    store.close()


def body(store):
    state = store.snapshot()
    return {"request_id": str(uuid4()), "expected_run": state["run"], "expected_revision": state["revision"]}


def command(store, action): return store.command(action, body(store))


def start(store):
    command(store, "start")
    store.tick()
    return store.snapshot()


def test_four_accounts_initial_budget_monthly_target_and_restart(service):
    s, source, clock = service
    initial = start(s)
    assert len(initial["events"]) == 4
    assert initial["next_due"] == "2020-02-01T00:00:00.000000Z"
    for account in initial["accounts"]:
        assert Decimal(account["cash"]) >= 9000
        assert Decimal(account["cash"]) - 9000 < Decimal("0.00001")
    def higher(q, b):
        for quote in q.values(): quote.update(bp=quote["bp"] * 1.4, ap=quote["ap"] * 1.4)
    source.change = higher
    clock.now = datetime(2020, 2, 1, 0, 2, tzinfo=UTC)
    s.tick()
    final = s.snapshot()
    assert len(final["events"]) == 8
    for account in final["accounts"]:
        assert abs(Decimal(account["weight"]) - Decimal(".1")) < Decimal(".000000001")
    # Reopen without changing the run or issuing another decision.
    path = s.path
    s.close()
    s.__init__(path, source, clock=clock)
    clock.now += timedelta(seconds=31)
    s.tick()
    assert s.snapshot()["events"] == final["events"]


def test_month_boundary_waits_for_finalized_bar(service):
    s, _, clock = service
    start(s)
    clock.now = datetime(2020, 2, 1, 0, 0, 30, tzinfo=UTC)
    s.tick()
    assert len(s.snapshot()["events"]) == 4
    assert "completed hourly bar" in s.snapshot()["message"]
    clock.now += timedelta(seconds=31)
    s.tick()
    assert len(s.snapshot()["events"]) == 8


def test_missed_months_record_no_catchup_fills(service):
    s, _, clock = service
    before = start(s)
    command(s, "pause")
    clock.now = datetime(2020, 3, 2, 0, 2, tzinfo=UTC)
    command(s, "resume")
    s.tick()
    after = s.snapshot()
    assert after["next_due"] == "2020-04-01T00:00:00.000000Z"
    assert sum(e["status"] == "MISSED" for e in after["events"]) == 8
    assert [a["units"] for a in before["accounts"]] == [a["units"] for a in after["accounts"]]


def test_stale_feed_revision_and_outage_block_decisions_with_no_fallback(service):
    s, source, clock = service
    before = start(s)
    clock.now += timedelta(seconds=31)
    source.change = lambda q, b: b["BTC/USD"][0].update(v=101)
    s.tick()
    assert "revised" in s.snapshot()["health"]["message"]
    assert s.snapshot()["events"] == before["events"]
    source.failure = FeedError("Network unavailable")
    clock.now += timedelta(seconds=61)
    s.tick()
    assert s.snapshot()["health"]["state"] == "error"
    assert s.snapshot()["events"] == before["events"]
    assert s.snapshot()["market"] == before["market"]


def test_status_marks_saved_values_stale_without_mutating_state(service):
    s, _, clock = service
    initial = start(s)
    clock.now += timedelta(seconds=61)
    stale = s.snapshot()
    assert stale["health"]["state"] == "stale"
    assert stale["revision"] == initial["revision"]
    assert stale["market"] == initial["market"]


def test_pause_during_fetch_discards_response_and_preserves_poll_rate(service):
    s, source, clock = service
    command(s, "start")
    source.change = lambda *_: command(s, "pause")
    s.tick()
    assert not s.snapshot()["running"]
    assert not s.snapshot()["events"]
    source.change = None
    command(s, "resume")
    s.tick()
    assert source.calls == 1
    clock.now += timedelta(seconds=31)
    s.tick()
    assert source.calls == 2 and len(s.snapshot()["events"]) == 4


def test_request_id_stale_clients_and_pause_revision(service):
    s, _, _ = service
    request = body(s)
    first = s.command("start", request)
    assert s.command("start", request)["duplicate"]
    with pytest.raises(Conflict): s.command("resume", request)
    old = body(s)
    s.tick()
    with pytest.raises(Conflict): s.command("resume", old)
    paused = s.command("pause", old)
    assert not paused["running"]
    assert paused["run"] == first["run"]


def test_backoff_is_durable_and_pause_resume_cannot_bypass_it(service):
    s, source, clock = service
    source.failure = FeedError("Rate limit", 120)
    command(s, "start"); s.tick()
    assert source.calls == 1
    for _ in range(3):
        command(s, "pause"); command(s, "resume"); s.tick()
    assert source.calls == 1
    clock.now += timedelta(seconds=120)
    s.tick()
    assert source.calls == 2
    assert not s.snapshot()["events"]


def test_live_boundary_blocks_commands_and_worker_even_with_credentials(tmp_path):
    class NoNetwork(AlpacaSource):
        def fetch(self, now): raise AssertionError("Provider access must remain blocked")
    s = Store(tmp_path / "db", NoNetwork("fake-key", "fake-secret"))
    try:
        assert not policy.LIVE_TECHNICAL_FEED_ALLOWED
        assert s.snapshot()["blocked"]
        with pytest.raises(ValueError, match="blocked"): command(s, "start")
        # Even an old active database cannot bypass the current policy.
        state = s._read(); state["running"] = True
        with s.db: s._save(state)
        s.tick()
        assert not s.snapshot()["events"]
        assert "fake-secret" not in json.dumps(s.snapshot())
    finally: s.close()


def test_source_identity_lock_and_corrupt_state_are_not_silently_reset(service):
    s, source, clock = service
    with pytest.raises(RuntimeError): Store(s.path, source, clock=clock)
    path = s.path
    s.close()
    with pytest.raises(ValueError, match="source mismatch"): Store(path, AlpacaSource("", ""), clock=clock)
    s.__init__(path, source, clock=clock)
    state = s._read(); del state["accounts"]["BTC-base"]
    with s.db: s._save(state)
    with pytest.raises(ValueError, match="structure"): s.snapshot()


def test_hard_exit_inside_fill_transaction_rolls_back_then_resumes_once(tmp_path):
    path = tmp_path / "db"
    clock = Clock()
    s = Store(path, FixtureSource(), clock=clock)
    command(s, "start")
    s.close()
    script = '''
import os,sys
from datetime import datetime
from service_v16.market import FixtureSource,UTC
from service_v16.store import Store
s=Store(sys.argv[1],FixtureSource(),clock=lambda:datetime(2020,1,14,12,3,tzinfo=UTC),fault_hook=lambda:os._exit(99))
s.tick()
'''
    child = subprocess.run([sys.executable, "-c", script, str(path)], cwd=ROOT, timeout=10)
    assert child.returncode == 99
    s = Store(path, FixtureSource(), clock=clock)
    try:
        assert not s.snapshot()["events"]
        assert all(a["cash"] == "10000" for a in s.snapshot()["accounts"])
        clock.now += timedelta(seconds=31)
        s.tick()
        assert len(s.snapshot()["events"]) == 4
        clock.now += timedelta(seconds=31)
        s.tick()
        assert len(s.snapshot()["events"]) == 4
    finally: s.close()


def test_credentials_loader_is_local_and_does_not_import_trading_configuration(tmp_path, monkeypatch):
    for key in ("APCA_API_KEY_ID", "APCA_API_SECRET_KEY"): monkeypatch.delenv(key, raising=False)
    path = tmp_path / "credentials.env"
    path.write_text('APCA_API_KEY_ID="fake-key"\nAPCA_API_SECRET_KEY=fake-secret\nDISCORD_WEBHOOK_URL=ignored\n')
    assert credentials(path) == ("fake-key", "fake-secret")
    monkeypatch.setenv("APCA_API_KEY_ID", "environment-key")
    assert credentials(path)[0] == "environment-key"


def http(base, path, *, token=None, data=None, headers=None, method=None):
    headers = dict(headers or {})
    if token: headers["Authorization"] = "Bearer " + token
    if data is not None: headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method), timeout=5) as response:
            return response.status, response.headers, response.read()
    except HTTPError as error: return error.code, error.headers, error.read()


def test_real_http_auth_pairing_routes_and_background_worker(service):
    s, _, _ = service
    server = Server(0, s, interval=.02)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        assert http(base, "/api/status")[0] == 401
        assert http(base, "/api/session", headers={"Origin": "https://anttitulenheimo.github.io", "X-Kaira-Client": "v16"})[0] == 403
        code, _, raw = http(base, "/api/session", headers={"Origin": base, "X-Kaira-Client": "v16"})
        assert code == 200 and json.loads(raw)["token"] == s.token
        assert http(base, "/api/start", token=s.token, data=body(s))[0] == 200
        import time
        deadline = time.monotonic() + 4
        while not s.snapshot()["events"] and time.monotonic() < deadline: time.sleep(.02)
        assert len(s.snapshot()["events"]) == 4
        code, headers, raw = http(base, "/api/status", token=s.token, headers={"Origin": "https://anttitulenheimo.github.io"})
        assert code == 200 and headers["Access-Control-Allow-Origin"] == "https://anttitulenheimo.github.io"
        assert s.token.encode() not in raw
        assert http(base, "/api/status", token=s.token, headers={"Origin": "https://attacker.invalid"})[0] == 403
        assert http(base, "/api/status", token=s.token, headers={"Host": "attacker.invalid"})[0] == 403
        for path in ("/.env", "/../.env", "/service_v16/store.py", "/.runtime/v16/alpaca.sqlite3"):
            assert http(base, path)[0] == 404
        assert http(base, "/api/orders", token=s.token, data={})[0] == 404
        assert http(base, "/api/run", token=s.token, data={})[0] == 404
    finally:
        server.shutdown(); server.server_close(); thread.join()


@pytest.mark.parametrize("cost", ["base", "stress"])
@pytest.mark.parametrize("multiplier", [Decimal("0.5"), Decimal("0.9"), Decimal("1.1"), Decimal("2")])
def test_rebalance_solves_post_fee_mid_weight_for_buys_and_sells(cost, multiplier):
    from service_v16.ledger import accounts, fill
    from service_v16.market import validate
    now = Clock()()
    q, b = FixtureSource().fetch(now)
    quote = validate(q, b, now)["symbols"]["BTC/USD"]
    account = accounts()["BTC-" + cost]
    initial = fill(account, quote, initial=True)
    assert initial["side"] == "BUY"
    for key in ("bid", "ask", "mid"): quote[key] = str(Decimal(quote[key]) * multiplier)
    before_cash, before_units, before_fees = Decimal(account["cash"]), account["units"], Decimal(account["fees"])
    result = fill(account, quote, initial=False)
    assert result["side"] == ("BUY" if multiplier < 1 else "SELL")
    cash, quantity = Decimal(account["cash"]), Decimal(account["units"]) / UNIT
    mid = Decimal(quote["mid"])
    assert abs(quantity * mid / (cash + quantity * mid) - Decimal(".1")) < Decimal("1e-9")
    notional = Decimal(result["units"]) / UNIT * Decimal(result["price"])
    direction = 1 if result["side"] == "BUY" else -1
    assert before_cash - cash == direction * notional + Decimal(result["fee"])
    assert account["units"] - before_units == direction * result["units"]
    assert Decimal(account["fees"]) - before_fees == Decimal(result["fee"])
