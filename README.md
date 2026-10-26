# Kaira Quant — public application

This standalone application contains the V13 monthly simulator, V14 order lab,
V15 local execution simulator and V16 offline market monitor. All runnable modes
use synthetic prices. No real orders are submitted. Synthetic results do not
establish profitability.

Python 3.10+ on Linux/WSL is sufficient for the services:

```bash
python3 run_v15_service.py
# Or, in another terminal:
python3 run_v16_service.py --source fixture
```

Open [V15 locally](http://127.0.0.1:8765/service.html) or
[V16 locally](http://127.0.0.1:8767/market.html).
For the browser-only V13/V14 interfaces:

```bash
python3 -m http.server 4173 --directory web/public --bind 127.0.0.1
```

Open [the monthly lab](http://127.0.0.1:4173/).
See [execution service](docs/EXECUTION_SERVICE.md) and
[market monitor](docs/MARKET_MONITOR.md) for operation and persistence.

Live acquisition remains blocked in `service_v16/policy.py`. Credentials do not
unlock it. Keep runtime databases and credentials on your computer. Only
`web/public/` belongs on static hosting. The Pages connection is restricted to
the configured project origin; other deployments can use the local interface.

## Development

Use Node.js 22 and Python 3.10+:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
npm ci --prefix web
npm test --prefix web
(cd web && npx playwright install chromium)
npm run test:browser --prefix web
```

## Publication boundary

This is an application export, with no inherited Git history, market datasets,
research reports, preregistrations, archived evidence, personal workstation paths
or runtime state. `PUBLIC_MANIFEST.json` records the exported files and hashes.
The source research repository must remain private and retain its original
history. This export cannot execute the registered research studies.

Before making new commits, configure your GitHub-provided noreply email for both
author and committer metadata. Do not copy the source repository's `.git`, logs,
databases, credentials or research directories into this repository.

Application updates are published automatically after the private source's
tests pass. This repository receives independent application snapshot commits;
private commit history and research-only changes are not published. Develop
changes in the private source. Direct public edits can block synchronization
until they have been reconciled there.
