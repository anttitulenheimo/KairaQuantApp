import { english } from "./legacy-text.mjs";
import {
  JOURNAL_KEY,
  BROKER_KEY,
  LOCK_NAME,
  CAPITAL,
  UNIT,
  PROFILES,
  loadRun,
  startRun,
  advanceRun,
} from "./execution-engine.mjs";
const $ = (id) => document.getElementById(id);
const n = (value, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
const money = (value) => `$${n(value)}`;
const date = (value) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
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
let loaded = null,
  busy = false,
  stop = false,
  failed = false;
function notice(message) {
  $("exec-notice").textContent = english(message);
  $("exec-notice").hidden = !message;
}
function text(id, value) {
  $(id).textContent = english(value);
}
function controlsConfig() {
  return Object.fromEntries(
    ["asset", "cost", "scenario", "profile"].map((k) => [
      k,
      $(`exec-${k}`).value,
    ]),
  );
}
function setConfig(config) {
  for (const k of ["asset", "cost", "scenario", "profile"])
    $(`exec-${k}`).value = config[k];
}
function row(values, className = "") {
  const tr = document.createElement("tr");
  tr.className = className;
  for (const value of values) {
    const td = document.createElement("td");
    td.textContent = english(value);
    tr.append(td);
  }
  return tr;
}
function empty(table, columns, message) {
  const tr = row([message]);
  tr.firstChild.colSpan = columns;
  tr.firstChild.className = "empty";
  table.append(tr);
}
function refresh() {
  try {
    loaded = loadRun(window.localStorage);
    failed = false;
  } catch (error) {
    loaded = null;
    failed = true;
    notice(
      `Cannot resume stored state: ${error.message} Ledgers were preserved. Starting a new run replaces them only after confirmation.`,
    );
  }
  render();
}
function render() {
  const view = loaded?.view;
  $("exec-step").disabled = busy || failed || !view || view.complete;
  $("exec-year").disabled = busy || failed || !view || view.complete;
  $("exec-start").disabled = busy || !navigator.locks;
  $("exec-stop").hidden = !busy;
  $("exec-export").disabled = !loaded;
  for (const k of ["asset", "cost", "scenario", "profile"])
    $(`exec-${k}`).disabled = busy;
  if (!navigator.locks) {
    $("exec-step").disabled = true;
    $("exec-year").disabled = true;
    notice(
      "Your browser does not support Web Locks for safe concurrent access. Open this page over HTTPS in a current browser.",
    );
  }
  text(
    "exec-save",
    loaded
      ? `Saved in this browser · ${loaded.journal.config.asset} · ${loaded.journal.config.cost === "base" ? "base costs" : "stress costs"} · ${PROFILES[loaded.journal.config.profile]} · Selected settings apply to the next new run.`
      : "Choose settings and start a new run.",
  );
  text("exec-equity", money(view?.equity ?? CAPITAL));
  text("exec-cash", money(view?.account.cash ?? CAPITAL));
  text(
    "exec-quantity",
    `${n((view?.account.units ?? 0) / UNIT, 8)} ${loaded?.journal.config.asset ?? ""}`,
  );
  text(
    "exec-weight",
    `Weight ${n(view ? (((view.account.units / UNIT) * view.price) / view.equity) * 100 : 0)} %`,
  );
  text("exec-fees", money(view?.account.fees ?? 0));
  text(
    "exec-reserve",
    view?.complete
      ? `Terminal reserve ${money(view.reserve)} (no sale)`
      : "Reserve calculated at period end",
  );
  text(
    "exec-reserved",
    view?.pending
      ? "An open order blocks the next decision"
      : "No open order",
  );
  text("exec-time", view ? `${date(view.time)} · UTC` : "No decisions yet");
  const last = view?.orders.at(-1);
  text(
    "exec-stage",
    view?.complete
      ? "TEST YEAR COMPLETE"
      : last
        ? labels[last.status]
        : "READY TO START",
  );
  text(
    "exec-reason",
    view?.complete
      ? "All 13 decision points processed. Balances include only confirmed fills."
      : last
        ? `${last.reason}. ${view.pending ? "Reconcile the current order before the next decision." : `Next decision / final valuation: ${date(view.nextTime)}.`}`
        : "The decision is saved before submission to the broker.",
  );
  text("exec-count", `${view?.orders.length ?? 0} / 13`);
  text("exec-fill-count", view?.fills.length ?? 0);
  $("exec-orders").replaceChildren();
  $("exec-fills").replaceChildren();
  for (const order of [...(view?.orders ?? [])].reverse()) {
    $("exec-orders").append(
      row(
        [
          date(order.time),
          order.units ? (order.side === "BUY" ? "BUY" : "SELL") : "HOLD",
          order.reason,
          n(order.units / UNIT, 8),
          n(order.fills.reduce((sum, f) => sum + f.units, 0) / UNIT, 8),
          labels[order.status],
          order.id,
        ],
        `status-${order.status.toLowerCase()}`,
      ),
    );
  }
  for (const fill of [...(view?.fills ?? [])].reverse())
    $("exec-fills").append(
      row([
        date(fill.time),
        fill.side === "BUY" ? "BUY" : "SELL",
        n(fill.units / UNIT, 8),
        n(fill.price, 4),
        n(fill.fee, 4),
        fill.id,
      ]),
    );
  if (!view?.orders.length)
    empty(
      $("exec-orders"),
      7,
      "Decisions appear here after the first step.",
    );
  if (!view?.fills.length)
    empty(
      $("exec-fills"),
      6,
      "No confirmed fills. Submission alone does not change balances.",
    );
}
async function locked(callback) {
  if (!navigator.locks) throw Error("Web Locks is unavailable.");
  return navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, callback);
}
async function advance(year) {
  if (busy || failed) return;
  const run = loaded?.journal.run;
  busy = true;
  stop = false;
  render();
  try {
    do {
      const result = await locked(() => {
        const current = loadRun(window.localStorage);
        if (current?.journal.run !== run)
          throw Error(
            "Another tab started a new run. Review the latest state before continuing.",
          );
        return advanceRun(window.localStorage);
      });
      loaded = result;
      notice(result.message);
      render();
      if (result.interrupted || result.view.complete) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (year && !stop);
  } catch (error) {
    refresh();
    notice(
      `Execution stopped: ${error.message} Saved state was reloaded; resuming will use the same IDs.`,
    );
  } finally {
    busy = false;
    render();
  }
}
$("exec-start").addEventListener("click", async () => {
  if (busy) return;
  const config = controlsConfig();
  // Take the confirmation inside the lock, so a second tab cannot replace a newer run.
  try {
    await locked(() => {
      const exists =
        localStorage.getItem(JOURNAL_KEY) !== null ||
        localStorage.getItem(BROKER_KEY) !== null;
      if (
        exists &&
        !window.confirm(
          "Replace the previous run and simulated broker ledger? Your V13 simulation will be preserved.",
        )
      )
        return;
      loaded = startRun(localStorage, config, crypto.randomUUID());
      failed = false;
      notice("New run luotu. Aloita seuraavasta vaiheesta.");
    });
  } catch (error) {
    refresh();
    notice(`Could not save the new run: ${error.message}`);
  }
  render();
});
$("exec-step").addEventListener("click", () => advance(false));
$("exec-year").addEventListener("click", () => advance(true));
$("exec-stop").addEventListener("click", () => {
  stop = true;
});
$("exec-export").addEventListener("click", () => {
  if (!loaded) return;
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            journal: loaded.journal,
            broker: loaded.broker,
            balances: loaded.view.account,
            orders: loaded.view.orders,
            fills: loaded.view.fills,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `kaira-v14-${loaded.journal.config.asset}-${loaded.journal.run}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("storage", (event) => {
  if ([JOURNAL_KEY, BROKER_KEY, null].includes(event.key)) {
    // Read only after the writer releases its lock: no false corruption mid-transition.
    locked(() => {
      refresh();
      if (!failed) notice("Run state updated from another tab.");
    }).catch((error) => notice(error.message));
  }
});
await locked(() => {
  refresh();
  if (loaded) setConfig(loaded.journal.config);
}).catch((error) => {
  failed = true;
  notice(error.message);
  render();
});
