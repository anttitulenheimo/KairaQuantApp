/** V14: durable order intents + a deterministic, local-only broker adapter.
 * Journal acknowledgements and broker effects are deliberately separate writes.
 * Balances are reconstructed from acknowledged fills, never from submitted qty.
 */
import {
  COSTS,
  SCENARIOS,
  START,
  END,
  HOUR,
  schedule,
  syntheticBars,
  targetFill,
} from "./engine.mjs";
export const JOURNAL_KEY = "kaira.v14.journal";
export const BROKER_KEY = "kaira.v14.broker";
export const LOCK_NAME = "kaira.v14.execution";
export const CAPITAL = 10000;
export const UNIT = 1e8;
export const PROFILES = {
  normal: "Tavallinen toteutus",
  partial: "Osittaiset toteutukset",
  faults: "Keskeytykset ja virhetilanteet",
};
export const TERMINAL = new Set(["FILLED", "REJECTED", "CANCELED", "SKIPPED"]);
const TIMES = [START, ...schedule(START, END)];
const cache = new Map();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function require(condition, message) {
  if (!condition) throw Error(message);
}
function keys(object, expected) {
  require(object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).sort().join(",") ===
      expected.split(",").sort().join(","), "Tallennuksen rakenne ei kelpaa.");
}
export function validateConfig(config) {
  keys(config, "asset,cost,scenario,profile");
  require(Object.values(config).every((value) => typeof value === "string") &&
    ["BTC", "ETH"].includes(config.asset) &&
    Object.hasOwn(COSTS, config.cost) &&
    Object.hasOwn(SCENARIOS, config.scenario) &&
    Object.hasOwn(PROFILES, config.profile), "Tuntematon suoritusasetus.");
  return {
    asset: config.asset,
    cost: config.cost,
    scenario: config.scenario,
    profile: config.profile,
  };
}
function barsFor(config) {
  const key = `${config.asset}/${config.scenario}`;
  if (!cache.has(key))
    cache.set(key, syntheticBars(config.asset, config.scenario));
  return cache.get(key);
}
function priceAt(config, time, delay = 0) {
  const index = (Date.parse(time) - Date.parse(START)) / HOUR + delay;
  const price = barsFor(config)[index]?.open;
  require(Number.isFinite(price) &&
    price > 0, "Kelvollinen toteutushinta puuttuu.");
  return price;
}
export function sizeOrder({ cash, quantity, price, feeRate, initial = false }) {
  require([cash, quantity, price, feeRate].every(Number.isFinite) &&
    cash >= 0 &&
    quantity >= 0 &&
    price > 0 &&
    [0.003, 0.006].includes(feeRate), "Virheellinen salkku tai hinta.");
  const change = initial
    ? (0.1 * cash) / (1 + feeRate)
    : targetFill(cash, quantity, price, feeRate).signed_notional;
  const side = change < 0 ? "SELL" : "BUY";
  const capacity = side === "BUY" ? cash / (price * (1 + feeRate)) : quantity;
  const units = Math.floor(Math.min(Math.abs(change) / price, capacity) * UNIT);
  require(Number.isSafeInteger(units) &&
    units >= 0, "Määrä ei mahdu sallittuun tarkkuuteen.");
  const notional = (units / UNIT) * price;
  return {
    side,
    units: notional >= 1 ? units : 0,
    reason:
      notional < 1
        ? "Alle 1 $ testiminimin tai paino tavoitteessa"
        : initial
          ? "Alkuosto kuluineen 10 %"
          : side === "BUY"
            ? "Paino alle 10 % tavoitteen"
            : "Paino yli 10 % tavoitteen",
  };
}
function decision(account, config, index, run) {
  const time = TIMES[index],
    price = priceAt(config, time);
  return {
    id: `${run}:${index}`,
    index,
    time,
    price,
    cashBefore: account.cash,
    unitsBefore: account.units,
    ...sizeOrder({
      cash: account.cash,
      quantity: account.units / UNIT,
      price,
      feeRate: COSTS[config.cost] / 2,
      initial: index === 0,
    }),
  };
}
function behavior(config, index) {
  if (config.profile === "normal") return "normal";
  if (config.profile === "partial") return "partial";
  return ["lost_ack", "partial", "rejected", "delayed", "canceled"][index % 5];
}
/** A cumulative broker response; repeated reads of the same revision are identical. */
export function brokerResponse(intent, config, polls) {
  validateConfig(config);
  require(Number.isSafeInteger(intent.units) &&
    intent.units > 0 &&
    Number.isSafeInteger(intent.unitsBefore) &&
    intent.unitsBefore >= 0 &&
    Number.isFinite(intent.cashBefore) &&
    intent.cashBefore >= 0 &&
    ["BUY", "SELL"].includes(intent.side) &&
    Number.isInteger(intent.index) &&
    intent.index >= 0 &&
    intent.index < TIMES.length &&
    intent.time ===
      TIMES[
        intent.index
      ], "Virheellinen välittäjälle lähetettävä toimeksianto.");
  require(Number.isInteger(polls) &&
    polls >= 0 &&
    polls <= 3, "Välittäjän vastausversio ei kelpaa.");
  const mode = behavior(config, intent.index),
    fills = [];
  let status = "SUBMITTED",
    cash = intent.cashBefore,
    held = intent.unitsBefore;
  function fill(units, delay) {
    const price = priceAt(config, intent.time, delay),
      notional = (units / UNIT) * price,
      fee = (notional * COSTS[config.cost]) / 2;
    if (
      (intent.side === "BUY" && notional + fee > cash + 1e-9) ||
      (intent.side === "SELL" && units > held)
    ) {
      status = "REJECTED";
      return false;
    }
    const time = new Date(Date.parse(intent.time) + delay * HOUR).toISOString();
    fills.push({
      id: `${intent.id}/fill/${fills.length + 1}`,
      orderId: intent.id,
      time,
      side: intent.side,
      units,
      price,
      fee,
    });
    cash += intent.side === "BUY" ? -notional - fee : notional - fee;
    held += intent.side === "BUY" ? units : -units;
    return true;
  }
  if (polls > 0) {
    if (mode === "rejected") status = "REJECTED";
    else if (mode === "delayed" && polls < 3) status = "WAITING";
    else if (mode === "partial" || mode === "canceled") {
      const first = Math.max(1, Math.floor(intent.units / 2));
      if (fill(first, 0)) {
        status = first === intent.units ? "FILLED" : "PARTIAL";
        if (polls >= 2 && status !== "FILLED") {
          if (mode === "canceled") status = "CANCELED";
          else if (fill(intent.units - first, 1)) status = "FILLED";
        }
      }
    } else if (fill(intent.units, mode === "delayed" ? 2 : 0))
      status = "FILLED";
  }
  return { status, fills };
}
function applyFills(account, fills) {
  const next = { ...account };
  for (const f of fills) {
    const notional = (f.units / UNIT) * f.price;
    next.cash += f.side === "BUY" ? -notional - f.fee : notional - f.fee;
    next.units += f.side === "BUY" ? f.units : -f.units;
    next.fees += f.fee;
  }
  require(Number.isFinite(next.cash) &&
    next.cash >= -1e-9 &&
    Number.isSafeInteger(next.units) &&
    next.units >= 0, "Toteutus rikkoisi salkun saldot.");
  if (next.cash < 0) next.cash = 0;
  return next;
}
export function createRun(config, run) {
  const clean = validateConfig(config);
  require(typeof run === "string" &&
    /^[a-zA-Z0-9-]{8,80}$/.test(run), "Ajotunniste puuttuu.");
  return {
    journal: {
      version: 1,
      engine: "v14.0",
      run,
      config: clean,
      orders: [],
      complete: false,
    },
    broker: { version: 1, run, orders: {} },
  };
}
/** Verify both stores and rebuild all decisions/fills; persisted balances are not trusted. */
export function project(journal, broker) {
  keys(journal, "version,engine,run,config,orders,complete");
  keys(broker, "version,run,orders");
  validateConfig(journal.config);
  require(journal.version === 1 &&
    journal.engine === "v14.0" &&
    broker.version === 1 &&
    /^[a-zA-Z0-9-]{8,80}$/.test(journal.run) &&
    broker.run ===
      journal.run, "Suorituslokin ja välittäjän ajot eivät täsmää.");
  require(Array.isArray(journal.orders) &&
    journal.orders.length <= TIMES.length &&
    typeof journal.complete === "boolean", "Virheellinen päätösloki.");
  require(broker.orders &&
    typeof broker.orders === "object" &&
    !Array.isArray(broker.orders), "Välittäjän loki ei kelpaa.");
  let account = { cash: CAPITAL, units: 0, fees: 0 };
  const orders = [],
    fills = [],
    expectedBrokerIds = new Set();
  for (const [index, ack] of journal.orders.entries()) {
    keys(ack, "sent,polls");
    require(typeof ack.sent === "boolean" &&
      Number.isInteger(ack.polls) &&
      ack.polls >= 0 &&
      ack.polls <= 3 &&
      (ack.sent || ack.polls === 0), "Virheellinen kuittaus.");
    const intent = decision(account, journal.config, index, journal.run),
      remote = broker.orders[intent.id];
    let response = { status: intent.units ? "PREPARED" : "SKIPPED", fills: [] };
    if (remote) {
      keys(remote, "intent,polls,lostAck");
      expectedBrokerIds.add(intent.id);
      require(intent.units > 0 &&
        equal(remote.intent, intent) &&
        typeof remote.lostAck === "boolean" &&
        Number.isInteger(remote.polls) &&
        remote.polls >= ack.polls &&
        remote.polls <= 3, "Välittäjän toimeksianto tai versio ei täsmää.");
      require(remote.lostAck ===
        (behavior(journal.config, index) ===
          "lost_ack"), "Virheellinen keskeytyskuittaus.");
    }
    if (ack.sent) {
      require(remote &&
        intent.units > 0, "Lähetetyn toimeksiannon välittäjätieto puuttuu.");
      response = brokerResponse(intent, journal.config, ack.polls);
    }
    require(index === journal.orders.length - 1 ||
      TERMINAL.has(
        response.status,
      ), "Uusi päätös keskeneräisen toimeksiannon aikana.");
    orders.push({ ...intent, ...response, brokerPolls: remote?.polls ?? null });
    account = applyFills(account, response.fills);
    fills.push(...response.fills);
  }
  require(Object.keys(broker.orders).every((id) =>
    expectedBrokerIds.has(id),
  ), "Välittäjällä on tuntematon toimeksianto.");
  const pending =
    orders.length && !TERMINAL.has(orders.at(-1).status) ? orders.at(-1) : null;
  require(!journal.complete ||
    (orders.length === TIMES.length &&
      !pending), "Keskeneräistä ajoa ei voi merkitä valmiiksi.");
  const acknowledgedPolls = journal.orders.at(-1)?.polls ?? 0;
  const pollTime = orders.length
    ? new Date(
        Date.parse(orders.at(-1).time) +
          Math.max(0, acknowledgedPolls - 1) * HOUR,
      ).toISOString()
    : START;
  const time = journal.complete
    ? END
    : orders.length
      ? [pollTime, ...fills.map((f) => f.time)].sort().at(-1)
      : START;
  const price = journal.complete
    ? barsFor(journal.config).at(-1).close
    : priceAt(journal.config, time);
  const equity = account.cash + (account.units / UNIT) * price;
  const reserve = journal.complete
    ? ((account.units / UNIT) * price * COSTS[journal.config.cost]) / 2
    : 0;
  return {
    account,
    orders,
    fills,
    pending,
    time,
    price,
    equity,
    reserve,
    complete: journal.complete,
    nextTime: TIMES[orders.length] ?? END,
  };
}
export function loadRun(storage) {
  const rawJournal = storage.getItem(JOURNAL_KEY),
    rawBroker = storage.getItem(BROKER_KEY);
  if (rawJournal === null && rawBroker === null) return null;
  require(rawJournal !== null &&
    rawBroker !==
      null, "Toinen suoritusloki puuttuu. Automaattinen jatkaminen estettiin.");
  require(rawJournal.length < 100000 &&
    rawBroker.length < 100000, "Suoritusloki on liian suuri.");
  const journal = JSON.parse(rawJournal),
    broker = JSON.parse(rawBroker);
  const view = project(journal, broker);
  return { journal, broker, view };
}
/** Caller must hold LOCK_NAME via Web Locks across load + writes. */
export function startRun(storage, config, run) {
  const { journal, broker } = createRun(config, run);
  // A crash between writes leaves mismatched run IDs and is explicitly blocked.
  storage.setItem(BROKER_KEY, JSON.stringify(broker));
  storage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  return loadRun(storage);
}
/** One durable transition. Broker writes precede journal acknowledgements.
 * Retrying after either write fails reconciles the same ID and cumulative fills.
 */
export function advanceRun(storage) {
  const loaded = loadRun(storage);
  require(loaded, "Aloita ensin uusi suoritus.");
  const { journal, broker, view } = loaded;
  if (view.complete) return { ...loaded, message: "Testivuosi on jo valmis." };
  const saveJournal = () =>
    storage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  const saveBroker = () => storage.setItem(BROKER_KEY, JSON.stringify(broker));
  let message;
  if (!view.pending) {
    if (journal.orders.length === TIMES.length) {
      journal.complete = true;
      message = "Testivuosi valmis. Loppumyynnin kuluvaraus laskettu.";
    } else {
      journal.orders.push({ sent: false, polls: 0 });
      message = "Kuukausipäätös tallennettu ennen lähetystä.";
    }
    saveJournal();
  } else {
    const intent = { ...view.pending };
    for (const key of ["status", "fills", "brokerPolls"]) delete intent[key];
    const ack = journal.orders.at(-1);
    if (!ack.sent) {
      if (!broker.orders[intent.id]) {
        const lostAck = behavior(journal.config, intent.index) === "lost_ack";
        broker.orders[intent.id] = { intent, polls: 0, lostAck };
        saveBroker();
        if (lostAck)
          return {
            ...loadRun(storage),
            interrupted: true,
            message:
              "Testikeskeytys: välittäjä hyväksyi toimeksiannon, mutta kuittaus katosi. Lataa sivu uudelleen tai jatka seuraava vaihe; sama tunniste estää kaksoislähetyksen.",
          };
      }
      ack.sent = true;
      saveJournal();
      message =
        "Toimeksianto lähetetty ja tunniste täsmäytetty. Toteutusta odotetaan.";
    } else {
      const remote = broker.orders[intent.id];
      // An unacknowledged broker response is replayed before asking for another.
      if (remote.polls === ack.polls) {
        remote.polls += 1;
        saveBroker();
      }
      ack.polls = remote.polls;
      saveJournal();
      message =
        "Välittäjän vastaus täsmäytetty. Vain toteutuneet määrät kirjattiin.";
    }
  }
  return { ...loadRun(storage), message };
}
