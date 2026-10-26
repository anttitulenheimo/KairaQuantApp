/** V13 software simulator. No market downloads, broker calls or study state. */
export const COSTS = Object.freeze({ base: 0.006, stress: 0.012 });
export const HOUR = 3_600_000;
export const START = "2020-01-14T00:00:00.000Z";
export const END = "2021-01-14T00:00:00.000Z";
export const SCENARIOS = Object.freeze({
  waves: {
    name: "Aaltoileva markkina",
    description:
      "Nousuja ja laskuja. Näe, milloin tavoitepaino johtaa ostoon tai myyntiin.",
  },
  trend: {
    name: "Nouseva markkina",
    description:
      "Pitkä nousu. Passiivinen positio kasvaa, kuukausisääntö palauttaa painon.",
  },
  shock: {
    name: "Lasku ja palautuminen",
    description:
      "Äkillinen pudotus ja hidas palautuminen. Seuraa painoa ja arvonlaskua.",
  },
});
const iso = (n) => new Date(n).toISOString();
const finite = (v) => typeof v === "number" && Number.isFinite(v);
function utc(value) {
  if (
    typeof value !== "string" ||
    !/(Z|\+00:00)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error("Aikaleiman on oltava UTC-ajassa.");
  return Date.parse(value);
}
export function schedule(start, end) {
  const a = utc(start),
    b = utc(end);
  if (a % (24 * HOUR) || b % (24 * HOUR) || b <= a)
    throw Error("Jakso tarvitsee kasvavat UTC-vuorokausirajat.");
  const first = new Date(a);
  let t = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
  const out = [];
  while (t < b) {
    out.push(iso(t));
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}
export function targetFill(cash, quantity, price, feeRate) {
  if (
    ![cash, quantity, price, feeRate].every(finite) ||
    cash < 0 ||
    quantity < 0 ||
    price <= 0 ||
    ![0.003, 0.006].includes(feeRate)
  )
    throw Error("Virheelliset tasapainotuksen lähtötiedot.");
  const equity = cash + quantity * price;
  if (!finite(equity) || equity <= 0) throw Error("Salkun arvo ei kelpaa.");
  const difference = 0.1 * equity - quantity * price;
  const signed_notional =
    Math.abs(difference) <= 1e-12 * equity
      ? 0
      : difference / (difference > 0 ? 1 + 0.1 * feeRate : 1 - 0.1 * feeRate);
  const fee = Math.abs(signed_notional) * feeRate;
  const cash_after = cash - signed_notional - fee;
  const quantity_after = quantity + signed_notional / price;
  const equity_after = cash_after + quantity_after * price;
  if (
    ![cash_after, quantity_after, equity_after].every(finite) ||
    cash_after < 0 ||
    quantity_after < 0 ||
    equity_after <= 0
  )
    throw Error("Tasapainotus tuotti virheellisen saldon.");
  return {
    signed_notional,
    quantity_change: signed_notional / price,
    fee,
    cash_after,
    quantity_after,
    equity_after,
    weight_after: (quantity_after * price) / equity_after,
    event_type:
      signed_notional > 0 ? "BUY" : signed_notional < 0 ? "SELL" : "NOOP",
  };
}
/** Deterministic hourly synthetic prices, intentionally unrelated to actual 2020 prices. */
export function syntheticBars(asset, scenario) {
  if (!["BTC", "ETH"].includes(asset) || !Object.hasOwn(SCENARIOS, scenario))
    throw Error("Tuntematon synteettinen skenaario.");
  const start = Date.parse(START),
    end = Date.parse(END),
    hours = (end - start) / HOUR;
  const base = asset === "BTC" ? 100 : 40,
    phase = asset === "BTC" ? 0 : 1.3;
  function price(h) {
    const x = h / hours;
    let logChange =
      0.22 * Math.sin(x * 7 * Math.PI + phase) +
      0.08 * Math.sin(x * 23 * Math.PI);
    if (scenario === "trend")
      logChange = 0.85 * x + 0.09 * Math.sin(9 * Math.PI * x + phase);
    if (scenario === "shock")
      logChange =
        0.18 * x +
        0.045 * Math.sin(18 * x + phase) -
        (x >= 0.36 ? 0.72 * Math.exp(-(x - 0.36) * 2.4) : 0);
    return Number((base * Math.exp(logChange)).toFixed(8));
  }
  return Array.from({ length: hours }, (_, i) => ({
    timestamp: iso(start + i * HOUR),
    open: price(i),
    close: price(i + 0.8),
  }));
}
export function simulate({ bars, start, end, roundTripCost, policy }) {
  const months = new Set(schedule(start, end)),
    a = utc(start),
    b = utc(end);
  if (
    !Object.values(COSTS).includes(roundTripCost) ||
    !["monthly_target", "buy_hold"].includes(policy)
  )
    throw Error("Tuntematon kulu tai sääntö.");
  if (!Array.isArray(bars) || bars.length !== (b - a) / HOUR)
    throw Error("Tuntihintoja puuttuu.");
  bars.forEach((bar, i) => {
    if (
      utc(bar.timestamp) !== a + i * HOUR ||
      ![bar.open, bar.close].every((p) => finite(p) && p > 0)
    )
      throw Error(
        "Hintasarjassa on puuttuva, väärässä järjestyksessä oleva tai virheellinen hinta.",
      );
  });
  const feeRate = roundTripCost / 2,
    p0 = bars[0].open;
  let quantity = 0.1 / (p0 * (1 + feeRate)),
    cash = 0.9;
  const notional = quantity * p0;
  const events = [
    {
      event_time: iso(a),
      event_type: "BUY",
      price: p0,
      cash_before: 1,
      quantity_before: 0,
      equity_before: 1,
      signed_notional: notional,
      quantity_change: quantity,
      fee: notional * feeRate,
      cash_after: cash,
      quantity_after: quantity,
      equity_after: cash + notional,
      weight_after: notional / (cash + notional),
      reason: "initial",
    },
  ];
  const risk = [
    { time: iso(a), phase: "initial_capital", equity: 1 },
    { time: iso(a), phase: "entry_post", equity: cash + notional },
  ];
  const valuation = [];
  for (let h = 4; h <= bars.length; h += 4) {
    const time = iso(a + h * HOUR),
      price = bars[h - 1].close,
      equity = cash + quantity * price;
    valuation.push({
      valuation_time: time,
      price,
      cash,
      quantity,
      equity,
      exposure: (quantity * price) / equity,
    });
    risk.push({ time, phase: "completed_close", equity });
    if (months.has(time)) {
      const price = bars[h].open,
        before = cash + quantity * price;
      const fill =
        policy === "monthly_target"
          ? targetFill(cash, quantity, price, feeRate)
          : {
              signed_notional: 0,
              quantity_change: 0,
              fee: 0,
              cash_after: cash,
              quantity_after: quantity,
              equity_after: before,
              weight_after: (quantity * price) / before,
              event_type: "MARK_ONLY",
            };
      events.push({
        event_time: time,
        price,
        cash_before: cash,
        quantity_before: quantity,
        equity_before: before,
        ...fill,
        reason: "monthly",
      });
      risk.push(
        { time, phase: "execution_pre", equity: before },
        { time, phase: "execution_post", equity: fill.equity_after },
      );
      cash = fill.cash_after;
      quantity = fill.quantity_after;
    }
  }
  return {
    start: iso(a),
    end: iso(b),
    roundTripCost,
    policy,
    events,
    risk,
    valuation,
  };
}
export function snapshot(result, step) {
  if (!Number.isInteger(step) || step < 0 || step > result.valuation.length)
    throw Error("Virheellinen etenemiskohta.");
  const time = step ? result.valuation[step - 1].valuation_time : result.start;
  const events = result.events.filter((e) => e.event_time <= time);
  const event = events.at(-1),
    row = step ? result.valuation[step - 1] : null;
  const price = event.event_time === time ? event.price : row.price;
  const cash = event.cash_after,
    quantity = event.quantity_after,
    equity = cash + quantity * price;
  const complete = step === result.valuation.length;
  const reserve = complete ? (quantity * price * result.roundTripCost) / 2 : 0;
  const adjusted = equity - reserve;
  let peak = 1,
    drawdown = 0;
  for (const r of result.risk) {
    if (r.time > time) break;
    peak = Math.max(peak, r.equity);
    drawdown = Math.max(drawdown, 1 - r.equity / peak);
  }
  if (complete) drawdown = Math.max(drawdown, 1 - adjusted / peak);
  return {
    time,
    cash,
    quantity,
    price,
    equity,
    weight: (quantity * price) / equity,
    fees: events.reduce((total, e) => total + e.fee, 0),
    reserve,
    adjusted,
    netReturn: adjusted - 1,
    drawdown,
    events,
    complete,
  };
}
export const MAX_STEP = (Date.parse(END) - Date.parse(START)) / (4 * HOUR);
export function nextMonthStep(step) {
  if (!Number.isInteger(step) || step < 0 || step > MAX_STEP)
    throw Error("Virheellinen etenemiskohta.");
  const time = Date.parse(START) + step * 4 * HOUR;
  const next =
    schedule(START, END)
      .map(Date.parse)
      .find((t) => t > time) ?? Date.parse(END);
  return (next - Date.parse(START)) / (4 * HOUR);
}
