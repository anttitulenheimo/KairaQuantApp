# Market monitor (V16)

V16 adds a read-only market-data adapter, four independent simulated portfolios,
and a dark English interface. Python owns observations, decisions and SQLite
persistence. GitHub Pages displays that state. There is no broker order endpoint.

**Delivery status: implemented and tested offline; live acquisition is blocked.**
The current [project conventions](../AGENTS.md) prohibit fetching overlapping
V8/V10 future observations before their acquisition dates. V16 does not override
that restriction. No provider data was downloaded, credentials verified, research
paths evaluated or trading activated during implementation.

## Run now with explicit offline fixtures

From the repository root on Linux/WSL with Python 3.10+:

```bash
python3 run_v16_service.py --source fixture
```

Open [the local monitor](http://127.0.0.1:8767/market.html), then choose **New
monitoring run**. The **OFFLINE FIXTURE · SYNTHETIC PRICES** badge stays visible.
This source uses invented, constant BTC/ETH quotes and bars with the current UTC
clock. It never contacts a provider. Monthly transitions, price changes and
outages are exercised with injected clocks and fixtures in tests; the browser
cannot fast-forward time.

Alternatively, open [Market Monitor on Pages](https://anttitulenheimo.github.io/KairaTrading/market.html),
choose **Connect local service**, and confirm in the local popup. Allow local
network access if prompted. If the browser blocks that connection, use the local
interface. A phone cannot reach the desktop through its own localhost.

The standard library is sufficient; the process lock requires Linux `fcntl`.
The browser can close while Python continues. Your computer and Python must stay
running. `Ctrl+C` stops the process. Restarting the same command resumes an active
run; paused runs remain paused. No scheduler, cloud process or OS autostart is
installed.

**Pause monitoring** stops new data requests and fills; an in-flight read-only
response is discarded. **Resume monitoring** retains balances and the monthly
schedule. Start a new run only after pausing; confirmation replaces the active
view while retaining old event rows in the database. **Retry the same command**
resolves an uncertain HTTP outcome with the original idempotency key.

## Default live-source boundary

```bash
python3 run_v16_service.py
```

This selects the Alpaca adapter and shows **LIVE FEED BLOCKED**. Both start/resume
and the worker check `service_v16/policy.py`; there is no HTTP or CLI override and
no date-triggered automatic unlock. Even a persisted active run cannot bypass
this gate. Fixture and Alpaca sources use separate default databases.

A future live integration requires an explicit user decision about independently
scoped technical observations that overlap V8/V10. Review and document that
boundary before changing the policy; do not change the frozen research code,
registrations, dates or consumption claims. The V8/V10 acquisition dates remain
2027-04-11 and 2027-10-15 at 00:00 UTC respectively. Overlapping observations are
not independent validation evidence. V12 remains `deferred_by_user`.

The adapter accepts `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` from the Python
process environment or an explicitly selected `--env-file`. Environment values
take precedence. It does not import the legacy trading configuration or load a
`.env` automatically. Provider credentials never enter the browser, status JSON
or Pages. Supplying credentials does not unlock the current policy. Provider
entitlements and real response behavior remain unverified.

## Fixed transport and data gates

The adapter uses Alpaca US REST, not the trading API or a WebSocket connection:

- [Latest crypto quotes](https://docs.alpaca.markets/us/reference/cryptolatestquotes-1): BTC/USD and ETH/USD in one request.
- [Historical crypto bars](https://docs.alpaca.markets/us/reference/cryptobars-1): only the latest two required completed hours for both assets, `1Hour`, ascending order, bounded pagination.

One batch starts at most once per 30 seconds, including across pause/resume and
process restarts. Failures back off for 30–300 seconds; authentication errors
wait 300 seconds. HTTP requests have a five-second socket timeout, a 1 MB response
limit and at most four bar pages. Redirects are rejected to avoid forwarding
credentials. There is no synthetic fallback for a failed live feed.

Both assets must pass the whole batch before any account can act:

- Quotes must be no more than 60 seconds old and no more than two seconds ahead
  of the receipt clock. Bid/ask must be positive, finite, uncrossed and have a
  spread no greater than 2% of the midpoint. Sizes must be nonnegative.
- Bars must be two contiguous UTC hours, in order, with valid finite OHLC/volume.
  Missing, duplicate or still-open bars fail the gate. The newest bar endpoint
  is the hour floor of receipt time minus 60 seconds.
- RFC3339 timestamps may include nanoseconds; internal timestamps are normalized
  to microseconds. Regressing quote timestamps and changes to an overlapping,
  previously observed completed bar reject the batch. A revised bar blocks
  decisions until it leaves the required two-hour window.

The 60-second bar delay is a technical policy, not a guarantee that the provider
will never revise a bar. Later revisions never rewrite saved decision evidence.
Bars are quality checks; fills use the fresh bid/ask, not a historical bar price.
A socket timeout bounds inactivity, not total wall-clock duration of an unusually
slow streaming response. After receipt, freshness is checked again.

## Simulated accounting and schedule

BTC and ETH each have separate base-cost and stress-cost accounts, each initially
holding $10,000. One-way proportional fees are 0.30% and 0.60% respectively
(nominal round-trip costs 0.60% / 1.20%). Buys use the ask, sells the bid, so the
spread is additional to these fees. The first valid batch spends 10% of initial
cash including its fee. Subsequently, the rule solves for a 10% crypto weight
at the midpoint after spread and fees. Quantities round down to eight decimal
places; a notional below $1 is skipped. These are simulation rules, not verified
broker order constraints.

After initialization, decisions are due at 00:00 UTC on the first day of each
month. A decision waits for the completed bar ending at that boundary and must
occur within five minutes of the scheduled time, inclusive. With the bar delay,
its earliest opportunity is normally 00:01 UTC. Each asset/cost account gets at
most one decision per monthly boundary. Missed windows are recorded as `MISSED`
when the next valid batch arrives, with no catch-up fill. Long outages record
each missed boundary separately. A new run starts a new schedule; it does not
reconstruct observations from an earlier run.

Each decision stores its scheduled and observed time, account, source, mode,
status, simulated quantity/price/fee, resulting balances and the exact normalized
quote and two bars used. `MISSED` records have no execution quote or evidence.
No liquidity/depth, slippage or real broker confirmations are modeled. Current
marked balances are technical state; V16 does not compute strategy performance,
passive-control results, research gates or profitability conclusions.

## Storage and recovery

Defaults are `.runtime/v16/fixture.sqlite3` and `.runtime/v16/alpaca.sqlite3`.
Use `--db` for a separate instance and `--port` for a different loopback port.
A database belongs to one schema/source and one owning process. It is never
silently reset or migrated from V13/V14/V15.

SQLite WAL with `synchronous=FULL` saves the poll reservation before network I/O.
A successful observation, all four account changes and their unique event rows
commit in one transaction. A crash before commit rolls back the whole batch;
retrying after the reserved interval cannot duplicate committed monthly events.
Commands have durable request IDs and run/revision checks. A pause or new run
during I/O invalidates the old response.

Only the latest accepted batch is retained as current market state; this is not
a continuous quote archive. Decision evidence remains in event rows, including
past runs. The interface and **Export visible state** include only the latest
120 events of the active run and are not a complete database export or restore
format. There is no browser import or automated deletion of old events.

The server binds only to loopback, validates Host/Origin, and requires an access
token for status and commands. The token is issued to the local interface and
shared with the expected Pages origin only after confirmation. It stays in page
memory and is excluded from export. Only `web/public/` is served or published.
An internal worker failure stops autonomous writes and is visible in the UI.

## Verification and development handoff — 15 October 2026

Commands from the repository root:

```bash
PYTHON_DOTENV_DISABLED=1 PYTHONPATH=. .venv/bin/python -m pytest -q
npm test --prefix web
npm run test:browser --prefix web
```

Local verification passed **551 Python tests, 21 Node tests and 25 browser tests**
(597 total; 17 pre-existing Python warnings). V16 adds 42 Python tests and five
browser tests. The final pushed commit must also pass GitHub Actions before Pages
is published.

The V16 tests cover malformed/stale/revised data, variable timestamp precision,
bounded pagination, sanitized HTTP failures, fees and buy/sell conservation,
monthly timing, missed windows, preserved backoff, pause during network I/O,
source separation, actual process termination inside a SQLite transaction,
authentication/CORS, blocked live acquisition and Pages-to-Python communication.
Provider traffic is mocked; browser tests use real local Python services with
explicit fixture and blocked-live sources. Browser tests also exercise reload,
lost responses, JSON export and the responsive dark layout.

Keep `service_v16` independent of frozen research modules and versioned V15
accounting. The next integration gate is authorization and verification of the
live data boundary, followed by one bounded provider-contract smoke check if
allowed. Offline software tests do not satisfy that gate or authorize trading.
