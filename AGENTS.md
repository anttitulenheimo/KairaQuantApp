# Project conventions

- Write documentation, UI labels, comments and runtime messages in English.
- Preserve the shared dark theme and accessible keyboard focus.
- Preserve versioned V13/V14/V15 accounting, order intents and persisted state.
- V16 live acquisition remains blocked in `service_v16/policy.py`. Use offline fixtures.
- V8 acquisition/evaluation is forbidden before 2027-04-11 00:00 UTC; V10 before
  2027-10-15 00:00 UTC. This application export does not include those studies.
- V12 remains deferred; do not add backup or recovery work without an explicit request.
- Do not commit credentials, local state, research records or personal paths.
- Follow `docs/EXECUTION_SERVICE.md` and `docs/MARKET_MONITOR.md` for the application.
