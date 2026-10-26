"""Loopback-only HTTP API and static UI. Standard library; no trading SDK imports."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import secrets
import signal
import threading
from urllib.parse import urlsplit

from .store import Conflict, Store
from .market import AlpacaSource, FixtureSource
import os
import shlex

PUBLIC = Path(__file__).resolve().parents[1] / "web" / "public"
PAGES_ORIGIN = "https://anttitulenheimo.github.io"


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, store, interval=1.0):
        self.store = store
        self.worker_error = None
        self.stop_worker = threading.Event()
        super().__init__(("127.0.0.1", port), Handler)
        self.local_origins = {f"http://127.0.0.1:{self.server_port}", f"http://localhost:{self.server_port}"}
        self.origins = {*self.local_origins, PAGES_ORIGIN}
        self.hosts = {urlsplit(x).netloc for x in self.local_origins}
        self.worker = threading.Thread(target=self.work, args=(interval,), daemon=True)
        self.worker.start()

    def work(self, interval):
        while not self.stop_worker.wait(interval):
            try:
                self.store.tick()
                self.worker_error = None
            except Exception:
                # A corrupt/unavailable store is never reset. Stop autonomous writes.
                self.worker_error = "Execution worker stopped after an internal error. Inspect the service before continuing."
                break

    def server_close(self):
        self.stop_worker.set()
        self.worker.join()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log credentials, query strings or request bodies.

    def respond(self, status, value, *, cors=True):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cors and self.headers.get("Origin") in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def valid_host(self):
        if self.headers.get("Host") not in self.server.hosts:
            self.respond(403, {"error": "Unknown server address"}, cors=False)
            return False
        return True

    def permitted(self):
        if not self.valid_host():
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.server.origins:
            self.respond(403, {"error": "Unknown interface origin"}, cors=False)
            return False
        supplied = self.headers.get("Authorization", "")
        if not secrets.compare_digest(supplied, "Bearer " + self.server.store.token):
            self.respond(401, {"error": "Reconnect the interface to the local service"})
            return False
        return True

    def do_OPTIONS(self):
        if not self.valid_host():
            return
        origin = self.headers.get("Origin")
        if origin not in self.server.origins or self.path == "/api/session":
            self.respond(403, {"error": "Connection not allowed"}, cors=False)
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.valid_host():
            return
        if self.path == "/api/session":
            origin = self.headers.get("Origin")
            same = origin in self.server.local_origins or (origin is None and self.headers.get("Sec-Fetch-Site") == "same-origin")
            if not same or self.headers.get("X-Kaira-Client") != "v16":
                self.respond(403, {"error": "Access tokens are issued only to the local interface"}, cors=False)
                return
            self.respond(200, {"token": self.server.store.token}, cors=False)
            return
        if self.path.startswith("/api/"):
            if not self.permitted():
                return
            if self.path != "/api/status":
                self.respond(404, {"error": "Unknown API endpoint"})
                return
            try:
                state = self.server.store.snapshot()
                self.respond(200, {**state, "worker_error": self.server.worker_error})
            except Exception:
                self.respond(503, {"error": "Cannot read service state. The database was preserved."})
            return
        name = urlsplit(self.path).path.lstrip("/") or "market.html"
        # Only single-level, versioned public assets. No repo files or symlinks.
        path = PUBLIC / name
        if "/" in name or "\\" in name or name.startswith(".") or path.is_symlink() or not path.is_file():
            self.respond(404, {"error": "Page not found"}, cors=False)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", (mimetypes.guess_type(name)[0] or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.permitted():
            return
        if self.path not in ("/api/start", "/api/resume", "/api/pause"):
            self.respond(404, {"error": "Unknown command"})
            return
        if self.server.worker_error:
            self.respond(503, {"error": self.server.worker_error})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096 or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("Command requires a small JSON body")
            self.connection.settimeout(5)
            body = json.loads(self.rfile.read(length))
            self.respond(200, self.server.store.command(self.path.removeprefix("/api/"), body))
        except Conflict as error:
            self.respond(409, {"error": str(error)})
        except (ValueError, TypeError) as error:
            self.respond(400, {"error": str(error)})
        except Exception:
            self.respond(503, {"error": "Storage was interrupted. Retry the same command; the request ID prevents duplicate effects."})


def credentials(path):
    """Read only data credentials, without importing the legacy trading configuration."""
    names = ("APCA_API_KEY_ID", "APCA_API_SECRET_KEY")
    values = {name: os.environ.get(name, "") for name in names}
    if path:
        for line in path.read_text().splitlines():
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, raw = line.split("=", 1)
            if name.strip() in names and not values[name.strip()]:
                tokens = shlex.split(raw, comments=True)
                if len(tokens) != 1:
                    raise ValueError("Invalid data credential entry")
                values[name.strip()] = tokens[0]
    return tuple(values[name] for name in names)


def main():
    parser = argparse.ArgumentParser(description="Kaira V16 — market data and simulated shadow portfolios")
    parser.add_argument("--source", choices=("alpaca", "fixture"), default="alpaca", help="Explicit source; fixture mode never contacts a provider")
    parser.add_argument("--env-file", type=Path, help="Optional local file containing APCA_API_KEY_ID and APCA_API_SECRET_KEY")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--db", type=Path, default=None)
    parser.add_argument("--interval", type=float, default=1.0, help="Worker check interval in seconds; data requests remain limited to once per 30 seconds")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535 or not .02 <= args.interval <= 60:
        parser.error("Invalid port or worker interval")
    if args.db is None:
        args.db = Path(__file__).resolve().parents[1] / f".runtime/v16/{args.source}.sqlite3"
    source = FixtureSource() if args.source == "fixture" else AlpacaSource(*credentials(args.env_file))
    store = Store(args.db, source)
    server = Server(args.port, store, args.interval)
    def shutdown(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"Kaira V16: http://127.0.0.1:{server.server_port}/market.html — simulated fills only", flush=True)
    try:
        server.serve_forever(poll_interval=.1)
    finally:
        server.server_close()
        store.close()


if __name__ == "__main__":
    main()
