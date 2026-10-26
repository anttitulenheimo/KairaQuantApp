"""V15 synthetic service, durable command recovery and real loopback HTTP tests."""
import json
from pathlib import Path
import shutil
import subprocess
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest

from service_v15.engine import create_run, project, transition
from service_v15.server import Server, PAGES_ORIGIN
from service_v15.store import Store, Conflict

ROOT = Path(__file__).resolve().parents[1]
CONFIG = {"asset": "BTC", "cost": "base", "scenario": "waves", "profile": "normal"}


def body(store, **extra):
    state = store.snapshot()
    return {"request_id": str(uuid4()), "expected_run": state["run"], "expected_revision": state["revision"], **extra}


def step(store, action="step", **extra):
    return store.command(action, body(store, **extra))


def approx_tree(actual, expected):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys()
        for k in expected:
            approx_tree(actual[k], expected[k])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a, e in zip(actual, expected):
            approx_tree(a, e)
    elif type(expected) is float:
        assert actual == pytest.approx(expected, rel=1e-12, abs=1e-9)
    else:
        assert actual == expected


@pytest.mark.parametrize("asset", ["BTC", "ETH"])
@pytest.mark.parametrize("cost", ["base", "stress"])
@pytest.mark.parametrize("scenario", ["waves", "trend", "shock"])
@pytest.mark.parametrize("profile", ["normal", "partial", "faults"])
def test_python_matches_every_v14_transition(asset, cost, scenario, profile):
    config = dict(asset=asset, cost=cost, scenario=scenario, profile=profile)
    oracle = subprocess.run([shutil.which("node"), str(ROOT / "web/tests/v15-oracle.mjs")], input=json.dumps(config), text=True, capture_output=True, check=True, timeout=20)
    expected = json.loads(oracle.stdout)
    journal, broker = create_run(config, "parity-run-001")
    trajectory = []
    for _ in range(100):
        writes, interrupted, _ = transition(journal, broker)
        for key, value in writes:
            if key == "journal":
                journal = value
            else:
                broker = value
        view = project(journal, broker)
        trajectory.append({"account": view["account"], "time": view["time"], "stage": view["orders"][-1]["status"], "interrupted": interrupted})
        if view["complete"]:
            break
    approx_tree(trajectory, expected["trajectory"])
    approx_tree(view, expected["view"])


def test_repeated_http_command_id_does_not_advance_twice(tmp_path):
    s = Store(tmp_path / "db")
    try:
        step(s, "start", config=CONFIG)
        command = body(s)
        first = s.command("step", command)
        second = s.command("step", command)
        assert second["duplicate"]
        assert first["revision"] == second["revision"]
        assert len(second["view"]["orders"]) == 1
        with pytest.raises(Conflict):
            s.command("run", command)
    finally:
        s.close()


class Crash(BaseException):
    pass


@pytest.mark.parametrize("boundary", [-1, 0, 1, 2, 3])
def test_process_restart_recovers_command_at_each_persistence_boundary(tmp_path, boundary):
    path = tmp_path / "db"
    s = Store(path)
    step(s, "start", config=CONFIG)
    step(s)  # Prepared intent.
    command = body(s)  # Broker acceptance then journal acknowledgement.
    def crash(index, _):
        if index == boundary:
            raise Crash()
    s.fault_hook = crash
    with pytest.raises(Crash):
        s.command("step", command)
    s.close()
    resumed = Store(path)
    try:
        result = resumed.command("step", command)
        assert result["duplicate"]
        assert result["view"]["orders"][0]["status"] == "SUBMITTED"
        assert result["view"]["account"]["cash"] == 10000
        assert len(resumed._get("broker")["orders"]) == 1
        filled = step(resumed)
        assert len(filled["view"]["fills"]) == 1
    finally:
        resumed.close()


def test_running_survives_restart_but_pause_stays_paused(tmp_path):
    path = tmp_path / "db"
    s = Store(path)
    step(s, "start", config=CONFIG)
    step(s, "run")
    s.tick()
    s.close()
    s = Store(path)
    try:
        assert s.snapshot()["control"]["running"]
        s.tick()
        assert s.snapshot()["view"]["pending"]["status"] == "SUBMITTED"
        step(s, "pause")
        before = s.snapshot()
        s.tick()
        assert s.snapshot() == before
    finally:
        s.close()
    s = Store(path)
    try:
        assert not s.snapshot()["control"]["running"]
    finally:
        s.close()


def test_lost_broker_ack_pauses_worker_and_keeps_same_order(tmp_path):
    s = Store(tmp_path / "db")
    try:
        step(s, "start", config={**CONFIG, "profile": "faults"})
        step(s, "run")
        s.tick()
        result = s.tick()
        assert not result["control"]["running"]
        assert result["view"]["pending"]["status"] == "PREPARED"
        step(s)
        assert len(s._get("broker")["orders"]) == 1
    finally:
        s.close()


def test_two_clients_stale_revision_and_second_process_are_blocked(tmp_path):
    path = tmp_path / "db"
    s = Store(path)
    try:
        step(s, "start", config=CONFIG)
        old = body(s)
        step(s)
        with pytest.raises(Conflict):
            s.command("step", old)
        with pytest.raises(RuntimeError):
            Store(path)
    finally:
        s.close()


def test_corrupt_state_is_not_reset(tmp_path):
    path = tmp_path / "db"
    s = Store(path)
    step(s, "start", config=CONFIG)
    with s.db:
        s._put("broker", None)
    with pytest.raises(ValueError):
        s.snapshot()
    s.close()
    with pytest.raises(ValueError):
        Store(path)


@pytest.fixture
def http_service(tmp_path):
    store = Store(tmp_path / "service.db")
    server = Server(0, store, interval=.03)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield store, server, f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join()
    store.close()


def http(base, path, *, token=None, data=None, method=None, headers=None):
    headers = {**(headers or {})}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(base + path, data=json.dumps(data).encode() if data is not None else None, method=method, headers=headers)
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, response.headers, response.read()
    except HTTPError as error:
        return error.code, error.headers, error.read()


def test_http_auth_origins_hosts_and_private_files(http_service):
    s, _, base = http_service
    assert http(base, "/api/status")[0] == 401
    assert http(base, "/api/status", token=s.token, headers={"Origin": "https://attacker.invalid"})[0] == 403
    assert http(base, "/api/status", token=s.token, headers={"Host": "attacker.invalid"})[0] == 403
    assert http(base, "/api/session", headers={"Origin": PAGES_ORIGIN, "X-Kaira-Client": "v15"})[0] == 403
    code, _, raw = http(base, "/api/session", headers={"Origin": base, "X-Kaira-Client": "v15"})
    assert code == 200 and json.loads(raw)["token"] == s.token
    for path in ("/.env", "/../.env", "/.runtime/service.sqlite3", "/%2e%2e/.env", "/run_v15_service.py"):
        assert http(base, path)[0] == 404
    code, headers, raw = http(base, "/api/status", token=s.token, headers={"Origin": PAGES_ORIGIN})
    assert code == 200 and headers["Access-Control-Allow-Origin"] == PAGES_ORIGIN
    assert s.token.encode() not in raw
    code, headers, _ = http(base, "/api/run", method="OPTIONS", headers={"Origin": PAGES_ORIGIN})
    assert code == 204 and headers["Access-Control-Allow-Private-Network"] == "true"


def test_real_http_worker_finishes_without_browser_requests(http_service):
    s, _, base = http_service
    code, _, raw = http(base, "/api/start", token=s.token, data=body(s, config=CONFIG))
    assert code == 200
    request = body(s)
    assert http(base, "/api/run", token=s.token, data=request)[0] == 200
    # No more HTTP input; worker owns progression.
    deadline = time.monotonic() + 8
    while not s.snapshot()["view"]["complete"] and time.monotonic() < deadline:
        time.sleep(.05)
    code, _, raw = http(base, "/api/status", token=s.token)
    result = json.loads(raw)
    assert code == 200 and result["view"]["complete"]
    assert len(result["view"]["orders"]) == 13
    assert len(result["view"]["fills"]) == 13
    assert not result["control"]["running"]
    assert json.loads(http(base, "/api/run", token=s.token, data=request)[2])["duplicate"]


def test_pause_accepts_advanced_revision_but_not_another_run(tmp_path):
    s = Store(tmp_path / "db")
    try:
        step(s, "start", config=CONFIG)
        old = body(s)
        step(s, "run")
        s.tick()
        result = s.command("pause", old)
        assert not result["control"]["running"]
        step(s, "start", config=CONFIG)
        with pytest.raises(Conflict):
            s.command("pause", {**old, "request_id": str(uuid4())})
    finally:
        s.close()


def test_hard_process_exit_after_broker_commit_recovers_once(tmp_path):
    import sys
    path = tmp_path / "db"
    s = Store(path)
    step(s, "start", config=CONFIG)
    step(s)
    command = body(s)
    s.close()
    script = '''
import json, os, sys
from service_v15.store import Store
def crash(index, key):
    if key == "broker": os._exit(99)
s = Store(sys.argv[1], fault_hook=crash)
s.command("step", json.loads(sys.argv[2]))
'''
    child = subprocess.run([sys.executable, "-c", script, str(path), json.dumps(command)], cwd=ROOT, timeout=10)
    assert child.returncode == 99
    s = Store(path)
    try:
        restored = s.command("step", command)
        assert restored["duplicate"]
        assert restored["view"]["orders"][0]["status"] == "SUBMITTED"
        assert len(s._get("broker")["orders"]) == 1
        assert len(step(s)["view"]["fills"]) == 1
    finally:
        s.close()


def test_cli_worker_resumes_after_sigkill(tmp_path):
    import sys
    path = tmp_path / "db"
    processes = []
    def launch():
        process = subprocess.Popen([sys.executable, str(ROOT / "run_v15_service.py"), "--port", "0", "--db", str(path), "--interval", ".03"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(process)
        # Bound startup wait even if the service crashes before announcing its URL.
        import select
        assert select.select([process.stdout], [], [], 10)[0], "Service did not start"
        line = process.stdout.readline()
        assert line.startswith("Kaira V15:"), line
        return process, line.split()[2].removesuffix("/service.html")
    def read(base, token):
        code, _, raw = http(base, "/api/status", token=token)
        assert code == 200
        return json.loads(raw)
    def send(base, token, action, **extra):
        state = read(base, token)
        code, _, raw = http(base, "/api/" + action, token=token, data={"request_id": str(uuid4()), "expected_run": state["run"], "expected_revision": state["revision"], **extra})
        assert code == 200, raw
        return json.loads(raw)
    try:
        process, base = launch()
        token = json.loads(http(base, "/api/session", headers={"Origin": base, "X-Kaira-Client": "v15"})[2])["token"]
        started = send(base, token, "start", config=CONFIG)
        send(base, token, "run")
        deadline = time.monotonic() + 8
        while len(read(base, token)["view"]["fills"]) < 2 and time.monotonic() < deadline:
            time.sleep(.02)
        before = read(base, token)
        assert before["control"]["running"] and len(before["view"]["fills"]) >= 2
        process.kill()
        process.wait(timeout=5)
        _, base = launch()
        deadline = time.monotonic() + 8
        while not read(base, token)["view"]["complete"] and time.monotonic() < deadline:
            time.sleep(.05)
        result = read(base, token)
        assert result["run"] == started["run"]
        assert result["view"]["complete"]
        fills = result["view"]["fills"]
        assert len(fills) == len({f["id"] for f in fills}) == 13
        assert fills[:len(before["view"]["fills"])] == before["view"]["fills"]
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=5)


def test_invalid_sqlite_releases_process_lock_and_preserves_file(tmp_path):
    import sqlite3
    path = tmp_path / "db"
    path.write_bytes(b"not a sqlite database")
    for _ in range(2):
        with pytest.raises(sqlite3.DatabaseError):
            Store(path)
    assert path.read_bytes() == b"not a sqlite database"
