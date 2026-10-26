/** V16 renders server observations and simulated fills; no browser portfolio engine. */
const $ = (id) => document.getElementById(id);
const PAGES = "https://anttitulenheimo.github.io";
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const format = (value, digits = 2) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(Number(value));
const time = (value) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(value))
    : "—";
let base = null,
  token = null,
  popup = null,
  state = null,
  connected = false,
  busy = false,
  pending = null,
  polling = false,
  generation = 0;
const text = (id, value) => {
  $(id).textContent = value;
};
function notice(message) {
  text("market-notice", message);
  $("market-notice").hidden = !message;
}
function endpoint(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error(
      "Use a local http://127.0.0.1:port or http://localhost:port address",
    );
  return u.origin;
}
function row(values) {
  const tr = document.createElement("tr");
  for (const value of values) {
    const td = document.createElement("td");
    td.textContent = value;
    tr.append(td);
  }
  return tr;
}
function render() {
  const stale = !connected || state?.health.state !== "ready";
  document.body.classList.toggle("market-stale", stale);
  document.body.classList.toggle("fixture-mode", state?.mode === "fixture");
  text(
    "connection-state",
    connected
      ? "Connected to market service"
      : state
        ? "Disconnected · values are stale"
        : "Not connected",
  );
  text(
    "source-badge",
    !state
      ? "NOT CONNECTED"
      : state.mode === "fixture"
        ? "OFFLINE FIXTURE · SYNTHETIC PRICES"
        : state.blocked
          ? "LIVE FEED BLOCKED"
          : "LIVE DATA · SIMULATED FILLS",
  );
  $("start").disabled =
    !connected || busy || !!pending || !!state?.running || !!state?.blocked;
  $("resume").disabled =
    !connected ||
    busy ||
    !!pending ||
    !state?.run ||
    state.running ||
    !!state.blocked;
  $("pause").disabled = !connected || busy || !!pending || !state?.running;
  $("refresh").disabled = !token || busy;
  $("retry").hidden = !pending;
  $("export").disabled = !state;
  text("policy-block", state?.blocked ?? "");
  $("policy-block").hidden = !state?.blocked;
  text(
    "run-state",
    state?.running ? "MONITORING" : state?.run ? "PAUSED" : "IDLE",
  );
  text("run-message", state?.message ?? "No run loaded.");
  text(
    "health-state",
    !connected ? "Connection unavailable" : state.health.state.toUpperCase(),
  );
  text("health-message", state?.health.message ?? "No data received.");
  text(
    "next-due",
    state?.next_due ? time(state.next_due) : "Initial allocation pending",
  );
  text(
    "last-attempt",
    `Last data attempt: ${time(state?.health.last_attempt)} UTC`,
  );
  text("data-source", state?.source ?? "—");
  text(
    "data-time",
    state?.market
      ? `${stale ? "STALE / BLOCKED · " : ""}Observed ${time(state.market.observed_at)} UTC · prices from ${state.mode === "fixture" ? "synthetic fixtures" : "Alpaca US"}`
      : "No data has been received. There is no synthetic fallback for a live feed.",
  );
  $("quotes").replaceChildren();
  for (const [symbol, quote] of Object.entries(state?.market?.symbols ?? {}))
    $("quotes").append(
      row([
        symbol,
        format(quote.bid, 4),
        format(quote.ask, 4),
        format(quote.mid, 4),
        format(quote.spread_bps),
        time(quote.quote_time),
        time(quote.bar_end),
      ]),
    );
  $("accounts").replaceChildren();
  for (const account of state?.accounts ?? []) {
    const article = document.createElement("article");
    article.className = "panel";
    const heading = document.createElement("h2");
    heading.textContent = `${account.asset} · ${account.cost === "base" ? "Base costs" : "Stress costs"}`;
    article.append(heading);
    const dl = document.createElement("dl");
    for (const [label, value] of [
      ["Cash", `$${format(account.cash)}`],
      ["Quantity", `${format(account.quantity, 8)} ${account.asset}`],
      [
        "Marked value",
        account.equity == null ? "Awaiting data" : `$${format(account.equity)}`,
      ],
      [
        "Crypto weight",
        account.weight == null
          ? "—"
          : `${format(Number(account.weight) * 100)}%`,
      ],
      ["Simulated fees", `$${format(account.fees, 4)}`],
    ]) {
      const div = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      div.append(dt, dd);
      dl.append(div);
    }
    article.append(dl);
    $("accounts").append(article);
  }
  $("decisions").replaceChildren();
  for (const event of state?.events ?? [])
    $("decisions").append(
      row([
        time(event.scheduled_at),
        time(event.observed_at),
        event.account,
        event.status.replaceAll("_", " "),
        event.side,
        format(event.units / 1e8, 8),
        format(event.price, 4),
        format(event.fee, 4),
        event.reason,
      ]),
    );
  text("event-count", state?.events.length ?? 0);
}
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = Error(data.error || "Service request failed");
    error.status = response.status;
    throw error;
  }
  if (data.service !== "kaira-v16" || !["fixture", "live"].includes(data.mode))
    throw Error("Unexpected market service");
  return data;
}
function accept(data) {
  if (!state || data.revision >= state.revision) state = data;
  connected = !data.worker_error;
  if (data.worker_error) notice(data.worker_error);
  render();
}
async function refresh() {
  if (!token || busy || polling) return;
  const current = generation;
  polling = true;
  try {
    const data = await request("/api/status");
    if (current === generation) accept(data);
  } catch (error) {
    if (current === generation) {
      connected = false;
      notice(
        `Connection failed: ${error.message}. Check the Python service or use the local interface.`,
      );
      render();
    }
  } finally {
    polling = false;
  }
}
async function sendPending() {
  if (!pending || busy) return;
  busy = true;
  render();
  try {
    const data = await request(`/api/${pending.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending.body),
    });
    pending = null;
    accept(data);
    notice(data.message);
  } catch (error) {
    connected = false;
    if (error.status && error.status < 500) pending = null;
    notice(
      `${error.message}${pending ? " Outcome uncertain; retry the same command with its original ID." : " Refresh service status before continuing."}`,
    );
  } finally {
    busy = false;
    render();
  }
}
async function command(action) {
  if (!connected || busy || pending || !state) return;
  if (
    action === "start" &&
    state.run &&
    !confirm(
      "Start new simulated portfolios? The active run will be replaced. Previous event records remain in the local database.",
    )
  )
    return;
  pending = {
    action,
    body: {
      request_id: crypto.randomUUID(),
      expected_run: state.run,
      expected_revision: state.revision,
    },
  };
  await sendPending();
}
async function localSession() {
  base = location.origin;
  $("service-url").value = base;
  const response = await fetch("/api/session", {
    headers: { "X-Kaira-Client": "v16" },
    cache: "no-store",
  });
  if (!response.ok) throw Error("Local market service is unavailable");
  token = (await response.json()).token;
  await refresh();
  if (
    window.opener &&
    new URLSearchParams(location.search).get("pair") === "1"
  ) {
    text("connect", "Confirm Pages connection");
    text(
      "connection-help",
      "Confirm this local service connection to GitHub Pages. Its token remains in page memory only.",
    );
  }
}
$("connect").addEventListener("click", async () => {
  try {
    if (local) {
      await localSession();
      if (
        window.opener &&
        new URLSearchParams(location.search).get("pair") === "1"
      ) {
        window.opener.postMessage({ type: "kaira-v16-pair", token }, PAGES);
        notice("Connection confirmed. Return to Pages.");
      }
    } else {
      if (pending)
        throw Error("Resolve the uncertain command before switching services");
      base = endpoint($("service-url").value);
      generation++;
      token = null;
      state = null;
      connected = false;
      render();
      popup = window.open(
        `${base}/market.html?pair=1`,
        "kaira-v16-pair",
        "width=900,height=800",
      );
      if (!popup)
        throw Error("Allow the connection popup or open the local interface");
      notice("Confirm the connection in the local window.");
    }
  } catch (error) {
    notice(error.message);
  }
});
window.addEventListener("message", async (event) => {
  if (
    event.source !== popup ||
    event.origin !== base ||
    event.data?.type !== "kaira-v16-pair" ||
    typeof event.data.token !== "string"
  )
    return;
  token = event.data.token;
  notice("Connection confirmed. Allow local network access if prompted.");
  await refresh();
});
$("service-url").addEventListener("input", () => {
  try {
    $("local-link").href = endpoint($("service-url").value) + "/market.html";
  } catch {}
});
$("refresh").addEventListener("click", refresh);
$("retry").addEventListener("click", sendPending);
for (const action of ["start", "pause", "resume"])
  $(action).addEventListener("click", () => command(action));
$("export").addEventListener("click", () => {
  if (!state) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "kaira-v16-visible-state.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
render();
if (local) localSession().catch((error) => notice(error.message));
setInterval(refresh, 1000);
