import { english } from "./legacy-text.mjs";
/** A view of the Python service. No client-side portfolio simulator or broker. */
const $ = (id) => document.getElementById(id);
const UNIT = 1e8;
const n = (x, d = 2) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(x);
const money = (x) => `$${n(x)}`;
const date = (x) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(x));
const labels = {
  PREPARED: "Decision saved",
  SUBMITTED: "Submitted",
  WAITING: "Awaiting response",
  PARTIAL: "Partially filled",
  FILLED: "Filled",
  REJECTED: "Rejected",
  CANCELED: "Remainder canceled",
  SKIPPED: "No order",
};
let base = null,
  token = null,
  popup = null,
  state = null,
  connected = false,
  busy = false,
  pending = null,
  polling = false,
  sequence = 0;
const isLocal = ["127.0.0.1", "localhost"].includes(location.hostname);
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
      "Use a local http://127.0.0.1:port or http://localhost:port address.",
    );
  return u.origin;
}
function notice(message) {
  $("exec-notice").textContent = english(message);
  $("exec-notice").hidden = !message;
}
function text(id, value) {
  $(id).textContent = english(value);
}
function row(values) {
  const tr = document.createElement("tr");
  for (const v of values) {
    const td = document.createElement("td");
    td.textContent = english(v);
    tr.append(td);
  }
  return tr;
}
function render() {
  const v = state?.view,
    running = state?.control.running;
  const activeConfig = state?.config
    ? ["asset", "cost", "scenario", "profile"]
        .map((key) =>
          [...$(`exec-${key}`).options].find(
            (option) => option.value === state.config[key],
          )?.textContent,
        )
        .join(" · ")
    : "";
  document.body.classList.toggle("service-stale", !connected);
  text(
    "service-state",
    connected
      ? "Connected to Python service"
      : state
        ? "Disconnected · values are stale"
        : "Not connected to Python service",
  );
  $("service-refresh").disabled = !token || busy;
  $("service-retry").hidden = !pending;
  $("exec-start").disabled = !connected || busy || !!pending || running;
  $("exec-step").disabled =
    !connected || busy || !!pending || !v || v.complete || running;
  $("exec-year").disabled =
    !connected || busy || !!pending || !v || v.complete || running;
  $("exec-stop").hidden = !running;
  $("exec-stop").disabled = !connected || busy || !!pending;
  $("exec-export").disabled = !state;
  text(
    "exec-save",
    state
      ? `Python service state · revision ${state.revision} · ${running ? "running on server" : "run paused"}${connected ? "" : " · STALE VIEW"}${activeConfig ? ` · Active run: ${activeConfig}` : ""}`
      : "No data has been read from the service yet.",
  );
  text("exec-equity", v ? money(v.equity) : "—");
  text("exec-cash", v ? money(v.account.cash) : "—");
  text(
    "exec-quantity",
    v ? `${n(v.account.units / UNIT, 8)} ${state.config.asset}` : "—",
  );
  text("exec-fees", v ? money(v.account.fees) : "—");
  text(
    "exec-weight",
    v
      ? `Weight ${n((((v.account.units / UNIT) * v.price) / v.equity) * 100)} %`
      : "Waiting for service",
  );
  text(
    "exec-reserve",
    v?.complete
      ? `Terminal reserve ${money(v.reserve)} (no sale)`
      : "Reserve calculated at period end",
  );
  text(
    "exec-reserved",
    v?.pending
      ? "An open order blocks the next decision"
      : "No open order",
  );
  text("exec-time", v ? `${date(v.time)} · UTC` : "No decisions yet");
  text(
    "exec-stage",
    v?.complete
      ? "TEST YEAR COMPLETE"
      : v?.orders.length
        ? labels[v.orders.at(-1).status]
        : "READY TO START",
  );
  text(
    "exec-reason",
    state?.control.message ?? "State will not be replaced by a browser simulation.",
  );
  text("exec-count", `${v?.orders.length ?? 0} / 13`);
  text("exec-fill-count", v?.fills.length ?? 0);
  $("exec-orders").replaceChildren();
  $("exec-fills").replaceChildren();
  for (const o of [...(v?.orders ?? [])].reverse())
    $("exec-orders").append(
      row([
        date(o.time),
        o.units ? (o.side === "BUY" ? "BUY" : "SELL") : "HOLD",
        o.reason,
        n(o.units / UNIT, 8),
        n(o.fills.reduce((a, f) => a + f.units, 0) / UNIT, 8),
        labels[o.status],
        o.id,
      ]),
    );
  for (const f of [...(v?.fills ?? [])].reverse())
    $("exec-fills").append(
      row([
        date(f.time),
        f.side === "BUY" ? "BUY" : "SELL",
        n(f.units / UNIT, 8),
        n(f.price, 4),
        n(f.fee, 4),
        f.id,
      ]),
    );
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
  if (data.service !== "kaira-v15" || data.mode !== "synthetic")
    throw Error("Unexpected execution service");
  return data;
}
function accept(data) {
  if (!state || data.revision >= state.revision) state = data;
  connected = !data.worker_error;
  if (data.worker_error) notice(data.worker_error);
  render();
}
async function refresh() {
  if (!token || polling || busy) return;
  polling = true;
  const generation = sequence;
  try {
    const data = await request("/api/status");
    if (generation === sequence) accept(data);
  } catch (error) {
    if (generation === sequence) {
      connected = false;
      notice(
        `Connection failed: ${error.message}. Check that the Python service is running. You can use the local interface.`,
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
    const data = await request("/api/" + pending.action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending.body),
    });
    pending = null;
    accept(data);
    notice(data.control.message);
  } catch (error) {
    connected = false;
    // A network/503 failure can follow a committed command: preserve its exact ID.
    if (error.status && error.status < 500) pending = null;
    notice(
      `${error.message}${pending ? " Command outcome is uncertain. Retry the same command with the same ID." : " Refresh service status before sending a new command."}`,
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
      "Replace the previous Python service run? Browser V13/V14 storage will be preserved.",
    )
  )
    return;
  const body = {
    request_id: crypto.randomUUID(),
    expected_run: state.run,
    expected_revision: state.revision,
  };
  if (action === "start")
    body.config = Object.fromEntries(
      ["asset", "cost", "scenario", "profile"].map((k) => [
        k,
        $(`exec-${k}`).value,
      ]),
    );
  pending = { action, body };
  await sendPending();
}
async function localSession() {
  base = location.origin;
  $("service-url").value = base;
  const response = await fetch("/api/session", {
    headers: { "X-Kaira-Client": "v15" },
    cache: "no-store",
  });
  if (!response.ok) throw Error("Local service is unavailable");
  token = (await response.json()).token;
  await refresh();
  if (
    new URLSearchParams(location.search).get("pair") === "1" &&
    window.opener
  ) {
    text(
      "service-help",
      "Confirm this local service connection to GitHub Pages. The access token stays in page memory only.",
    );
    text("service-connect", "Confirm Pages connection");
  }
}
$("service-connect").addEventListener("click", async () => {
  try {
    if (isLocal) {
      await localSession();
      if (
        window.opener &&
        new URLSearchParams(location.search).get("pair") === "1"
      ) {
        window.opener.postMessage(
          { type: "kaira-v15-pair", token },
          "https://anttitulenheimo.github.io",
        );
        notice("Connection confirmed. You can return to Pages.");
      }
    } else {
      if (pending)
        throw Error("Resolve the uncertain command before switching services.");
      base = endpoint($("service-url").value);
      sequence++;
      token = null;
      state = null;
      connected = false;
      render();
      popup = window.open(
        base + "/service.html?pair=1",
        "kaira-v15-pair",
        "width=900,height=800",
      );
      if (!popup)
        throw Error(
          "Allow the connection popup or use the local interface.",
        );
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
    event.data?.type !== "kaira-v15-pair" ||
    typeof event.data.token !== "string"
  )
    return;
  token = event.data.token;
  notice(
    "Connection confirmed. Your browser may still request local network permission.",
  );
  await refresh();
});
$("service-url").addEventListener("input", () => {
  try {
    $("service-local").href =
      endpoint($("service-url").value) + "/service.html";
  } catch {}
});
$("service-refresh").addEventListener("click", refresh);
$("service-retry").addEventListener("click", sendPending);
for (const [id, action] of [
  ["exec-start", "start"],
  ["exec-step", "step"],
  ["exec-year", "run"],
  ["exec-stop", "pause"],
])
  $(id).addEventListener("click", () => command(action));
$("exec-export").addEventListener("click", () => {
  if (!state) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "kaira-v15-service.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
render();
if (isLocal)
  localSession().catch((error) => {
    notice(error.message);
    render();
  });
setInterval(refresh, 1000);
