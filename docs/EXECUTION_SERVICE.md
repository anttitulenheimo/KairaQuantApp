# Python execution service (V15)

The Pages interface controls a Python process on your computer. Python owns the
monthly decisions, simulated broker, fills and SQLite ledger. All prices are
synthetic. No real orders are submitted.

## Start and connect

From the project root on Linux or WSL, run:

```bash
python3 run_v15_service.py
```

Python 3.10+ and its standard library are sufficient. No API credentials or
additional packages are needed. The process lock uses Linux `fcntl`.

Open [the local interface](http://127.0.0.1:8765/service.html) directly, or use
[Pages](https://anttitulenheimo.github.io/KairaTrading/service.html): choose
**Connect local service**, confirm in the local popup, and allow local network
access if the browser requests it. If Pages cannot connect, use the local page.
The token stays in page memory, never in a URL, localStorage or exported JSON.
Reloading Pages requires a new connection confirmation.

Choose asset, cost, scenario and broker behavior, then **New run**. This replaces
the active service run after confirmation. The active run's settings are listed
separately from the settings for the next run. **Next step** advances one
transition; **Run on server** runs the test year independently of the browser.
**Pause server run** persists a pause.

The failure profile deliberately pauses after a lost broker acknowledgement.
Continue using the same order ID. After an uncertain HTTP response, **Retry the
same command** reuses its original request ID. **Refresh status** reads current
state. Disconnection marks displayed values stale and disables controls.

## Persistence and boundaries

Default storage: `.runtime/v15/service.sqlite3`, excluded from Git and Pages.
SQLite uses WAL and `synchronous=FULL`. A durable command plan is saved before
its effects. Replaying that plan or repeating the request ID does not duplicate
fills. A single process owns each database and serializes API/worker writes.

Only confirmed fills change balances. An open order blocks the next monthly
decision. The terminal reserve is a theoretical fee reserve, not a sale. The
synthetic broker uses 8 decimal places and a $1 order minimum; these are test
rules, not verified requirements of a real broker.

Close the browser freely while the service runs. `Ctrl+C` stops Python. Restart
with the same command and database: an active run resumes, a paused run remains
paused. Your computer and Python process must stay running. No operating-system
autostart or cloud backend is installed. A phone's localhost refers to the phone,
so this version cannot connect a phone to the desktop service.

Alternative test instance:

```bash
python3 run_v15_service.py --port 8775 --db .runtime/v15-other/service.sqlite3 --interval 0.1
```

The interval controls synthetic test progression, not a real trading schedule.
The default interval is one second. There is one active run per database. V13/V14
browser storage is separate and is not imported. JSON export is a view of service
state, not a database restore file. A corrupt database is never reset automatically.

The server binds to loopback only. API calls require a token and enforce Host and
Origin checks. Allowed browser origins are the service's own localhost addresses
and the project's GitHub Pages origin. CORS does not override browser permissions.

## Development handoff — 15 October 2026

English is the project language. The interfaces share a dark theme and
English presentation. Legacy ledger messages are translated by `legacy-text.mjs`
at display time to preserve compatibility with existing stored order intents.
Raw historical records may retain their original Finnish annotations.

The existing tests cover all 36 asset/cost/scenario/broker combinations against
the V14 engine, lost responses, process crashes, resumption, concurrency and
Pages-to-Python communication. See README for test commands. CI must pass before
publishing `web/public/` to Pages.

The market-data adapter and separate shadow ledger are now implemented as
[V16 Market Monitor](MARKET_MONITOR.md). Its explicit offline fixture mode is
available; live acquisition remains blocked under the current V8/V10 restriction.
V16 uses its own database, accounting and port 8767. V15 remains a synthetic
execution test service on port 8765. No research result or trading activation
follows from either service. V12 remains deferred.
