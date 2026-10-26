import { english } from "./legacy-text.mjs";
import {
  COSTS,
  SCENARIOS,
  START,
  END,
  MAX_STEP,
  syntheticBars,
  simulate,
  snapshot,
  nextMonthStep,
  schedule,
} from "./engine.mjs";
import {
  STORAGE_KEY,
  freshSession,
  parseSession,
  saveSession,
} from "./session.mjs";
const $ = (id) => document.getElementById(id);
const CAPITAL = 10000;
const number = (n, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
const money = (n) => `$${number(n * CAPITAL)}`;
const percent = (n) => `${number(n * 100)} %`;
const date = (t) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(new Date(t));
const timeOfDay = (t) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(t));
let session = freshSession(),
  asset = "BTC",
  cost = "base",
  expected = null,
  storage = null,
  blocked = false,
  saved = false;
let paths = null,
  cachedScenario = null;
function notice(message) {
  $("notice").textContent = english(message);
  $("notice").hidden = !message;
}
try {
  storage = window.localStorage;
  expected = storage.getItem(STORAGE_KEY);
  if (expected !== null) {
    session = parseSession(expected);
    saved = true;
  }
} catch {
  blocked = true;
  notice(
    "Browser storage is unavailable or corrupt. Preserve any previous JSON export before resetting. Existing storage will not be replaced automatically.",
  );
}
function buildPaths() {
  if (cachedScenario === session.scenario) return;
  const built = {};
  for (const a of ["BTC", "ETH"]) {
    const bars = syntheticBars(a, session.scenario);
    for (const [c, roundTripCost] of Object.entries(COSTS))
      for (const policy of ["monthly_target", "buy_hold"]) {
        built[`${a}-${c}-${policy}`] = simulate({
          bars,
          start: START,
          end: END,
          roundTripCost,
          policy,
        });
      }
  }
  paths = built;
  cachedScenario = session.scenario;
}
function commit(next, reset = false) {
  try {
    if (blocked && !reset)
      throw Error("Reload the page or reset before continuing.");
    if (!storage) storage = window.localStorage;
    if (reset) expected = storage.getItem(STORAGE_KEY);
    expected = saveSession(storage, next, expected);
    session = next;
    saved = true;
    blocked = false;
    notice("");
    render();
  } catch (error) {
    blocked = true;
    notice(
      `${error.message} Save failed; progress was not changed. You can export JSON.`,
    );
    render();
  }
}
const set = (id, text) => {
  $(id).textContent = english(text);
};
const signed = (n) => `${n > 0 ? "+" : ""}${percent(n)}`;
function tone(id, n) {
  $(id).classList.toggle("positive", n > 0);
  $(id).classList.toggle("negative", n < 0);
}
function svgElement(tag, attributes, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([k, v]) => element.setAttribute(k, v));
  if (text !== undefined) element.textContent = english(text);
  return element;
}
function chart(monthly, passive, current, control) {
  const svg = $("chart");
  svg.querySelectorAll("g").forEach((g) => g.remove());
  const series = (result) => [
    { time: result.start, equity: 1 },
    ...result.risk
      .filter((r) => r.phase !== "initial_capital" && r.time <= current.time)
      .map((r) => ({ time: r.time, equity: r.equity })),
  ];
  const m = series(monthly),
    p = series(passive);
  if (current.complete) {
    m.push({ time: current.time, equity: current.adjusted });
    p.push({ time: current.time, equity: control.adjusted });
  }
  const all = [...m, ...p],
    lo = Math.min(...all.map((r) => r.equity)),
    hi = Math.max(...all.map((r) => r.equity));
  const padding = Math.max(0.003, (hi - lo) * 0.15),
    bottom = lo - padding,
    top = hi + padding;
  const x = (t) =>
    66 +
    ((Date.parse(t) - Date.parse(START)) /
      (Date.parse(END) - Date.parse(START))) *
      710;
  const y = (v) => 250 - ((v - bottom) / (top - bottom)) * 220;
  const group = svgElement("g", {});
  for (let i = 0; i <= 4; i++) {
    const value = bottom + ((top - bottom) * i) / 4;
    group.append(
      svgElement("line", {
        x1: 66,
        x2: 776,
        y1: y(value),
        y2: y(value),
        class: "chart-grid",
      }),
      svgElement(
        "text",
        { x: 54, y: y(value) + 4, "text-anchor": "end", class: "chart-label" },
        number(value * CAPITAL, 0),
      ),
    );
  }
  for (const [t, label, anchor] of [
    [START, "Jan 14, 2020", "start"],
    ["2020-07-14T00:00:00Z", "Jul 14, 2020", "middle"],
    [END, "Jan 14, 2021", "end"],
  ])
    group.append(
      svgElement(
        "text",
        { x: x(t), y: 282, "text-anchor": anchor, class: "chart-label" },
        label,
      ),
    );
  const d = (rows) =>
    rows
      .map(
        (r, i) =>
          `${i ? "L" : "M"}${x(r.time).toFixed(2)},${y(r.equity).toFixed(2)}`,
      )
      .join(" ");
  group.append(
    svgElement("path", {
      d: `${d(m)} L${x(m.at(-1).time)},250 L66,250 Z`,
      class: "chart-area",
    }),
  );
  group.append(
    svgElement("path", { d: d(p), class: "chart-passive" }),
    svgElement("path", { d: d(m), class: "chart-monthly" }),
  );
  svg.append(group);
  set(
    "chart-description",
    `${asset}, ${date(current.time)}. Monthly portfolio ${money(current.equity)}, passive ${money(control.equity)}. ${current.complete ? "The final point includes the liquidation fee reserve." : ""}`,
  );
}
function journal(events) {
  $("events").replaceChildren();
  const labels = { BUY: "BUY", SELL: "SELL", NOOP: "NO CHANGE" };
  for (const e of [...events].reverse()) {
    const tr = document.createElement("tr");
    const before = (e.quantity_before * e.price) / e.equity_before;
    const reason =
      e.reason === "initial"
        ? "Initial purchase including fees: 10%"
        : e.event_type === "BUY"
          ? "Below target weight"
          : e.event_type === "SELL"
            ? "Above target weight"
            : "At target weight";
    const values = [
      `${date(e.event_time)} 00.00`,
      labels[e.event_type],
      reason,
      `${e.signed_notional > 0 ? "+" : ""}${number(e.signed_notional * CAPITAL)}`,
      number(e.fee * CAPITAL),
      `${percent(before)} → ${percent(e.weight_after)}`,
      number(e.cash_after * CAPITAL),
    ];
    values.forEach((v, i) => {
      const td = document.createElement("td");
      if (i === 1) {
        const badge = document.createElement("span");
        badge.className = `action ${e.event_type.toLowerCase()}`;
        badge.textContent = english(v);
        td.append(badge);
      } else td.textContent = english(v);
      tr.append(td);
    });
    $("events").append(tr);
  }
  set("event-count", events.length);
}
function render() {
  buildPaths();
  const monthly = paths[`${asset}-${cost}-monthly_target`],
    passive = paths[`${asset}-${cost}-buy_hold`];
  const current = snapshot(monthly, session.step),
    control = snapshot(passive, session.step);
  $("scenario").value = session.scenario;
  set("scenario-description", SCENARIOS[session.scenario].description);
  set("clock", `${date(current.time)} · ${timeOfDay(current.time)}`);
  const next = schedule(START, END).find((t) => t > current.time);
  set(
    "next-decision",
    current.complete
      ? "Test year complete · terminal reserve included"
      : next
        ? `Next rebalance ${date(next)}`
        : `Next: final valuation ${date(END)}`,
  );
  $("progress").max = MAX_STEP;
  $("progress").value = session.step;
  $("next").disabled = current.complete || blocked;
  $("finish").disabled = current.complete || blocked;
  $("scenario").disabled = blocked;
  set(
    "storage-status",
    blocked
      ? "Storage needs attention"
      : saved
        ? "Saved in this browser"
        : "Ready · saved as you advance",
  );
  for (const a of ["BTC", "ETH"])
    $(`asset-${a.toLowerCase()}`).setAttribute(
      "aria-pressed",
      String(asset === a),
    );
  set("equity", money(current.equity));
  set("equity-note", `${asset} · separate $10,000 initial capital`);
  set("return", signed(current.netReturn));
  tone("return", current.netReturn);
  set(
    "return-note",
    current.complete
      ? "After terminal liquidation reserve"
      : "After fees paid",
  );
  set("weight", percent(current.weight));
  set("drawdown", percent(current.drawdown));
  set("monthly-return", signed(current.netReturn));
  set("passive-return", signed(control.netReturn));
  const delta = (current.netReturn - control.netReturn) * 100;
  set("difference", `${delta > 0 ? "+" : ""}${number(delta)}`);
  tone("difference", delta);
  set("cash", money(current.cash));
  set("quantity", `${number(current.quantity * CAPITAL, 6)} ${asset}`);
  set("fees", money(current.fees));
  set(
    "reserve",
    current.complete ? money(current.reserve) : "Calculated at period end",
  );
  chart(monthly, passive, current, control);
  journal(current.events);
}
$("next").addEventListener("click", () =>
  commit({ ...session, step: nextMonthStep(session.step) }),
);
$("finish").addEventListener("click", () =>
  commit({ ...session, step: MAX_STEP }),
);
$("reset").addEventListener("click", () => {
  if (
    window.confirm(
      "Reset this simulation? Current browser storage will be replaced. You can export it as JSON first.",
    )
  )
    commit({ ...freshSession(), scenario: session.scenario }, true);
});
$("scenario").addEventListener("change", (event) => {
  const scenario = event.target.value;
  if (
    session.step === 0 ||
    window.confirm(
      "Changing scenario starts a new simulation. Replace current browser storage?",
    )
  )
    commit({ ...freshSession(), scenario });
  else $("scenario").value = session.scenario;
});
for (const a of ["BTC", "ETH"])
  $(`asset-${a.toLowerCase()}`).addEventListener("click", () => {
    asset = a;
    render();
  });
$("cost").addEventListener("change", (event) => {
  cost = event.target.value;
  render();
});
$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(session, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `kaira-v13-${session.scenario}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 4096)
      throw Error("JSON file is too large (maximum 4 KB).");
    const imported = parseSession(await file.text());
    if (
      window.confirm("Replace the browser simulation with the imported session?")
    )
      commit(imported);
  } catch (error) {
    notice(`Import rejected: ${error.message} The current simulation was preserved.`);
  } finally {
    event.target.value = "";
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) {
    blocked = true;
    notice(
      "The simulation changed in another tab. Reload before continuing.",
    );
    render();
  }
});
render();
