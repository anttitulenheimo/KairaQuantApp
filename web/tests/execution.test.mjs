import test from "node:test";
import assert from "node:assert/strict";
import {
  JOURNAL_KEY,
  BROKER_KEY,
  CAPITAL,
  UNIT,
  sizeOrder,
  createRun,
  project,
  loadRun,
  startRun,
  advanceRun,
  brokerResponse,
} from "../public/execution-engine.mjs";
import {
  COSTS,
  START,
  END,
  syntheticBars,
  simulate,
  snapshot,
} from "../public/engine.mjs";
const config = {
  asset: "BTC",
  cost: "base",
  scenario: "waves",
  profile: "normal",
};
function storage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
}
function finish(s) {
  let result;
  for (let i = 0; i < 120; i++) {
    result = advanceRun(s);
    if (result.view.complete) return result;
  }
  throw Error("Run did not complete");
}
function started(profile = "normal") {
  const s = storage();
  startRun(s, { ...config, profile }, "test-run-0001");
  return s;
}
const near = (a, b, tol = 1e-8) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
test("sizes are rounded down, fee-inclusive and bounded by cash/position", () => {
  for (const feeRate of [0.003, 0.006]) {
    const initial = sizeOrder({
      cash: 10000,
      quantity: 0,
      price: 123.45,
      feeRate,
      initial: true,
    });
    assert.ok((initial.units / UNIT) * 123.45 * (1 + feeRate) <= 1000);
    assert.ok(
      1000 - (initial.units / UNIT) * 123.45 * (1 + feeRate) < 0.000002,
    );
    for (const quantity of [0, 1, 500]) {
      const d = sizeOrder({ cash: 5, quantity, price: 100, feeRate });
      if (d.side === "BUY")
        assert.ok((d.units / UNIT) * 100 * (1 + feeRate) <= 5);
      else assert.ok(d.units / UNIT <= quantity);
    }
  }
  assert.equal(
    sizeOrder({
      cash: 1,
      quantity: 0,
      price: 100,
      feeRate: 0.003,
      initial: true,
    }).units,
    0,
  );
  for (const price of [NaN, Infinity, 0, -1])
    assert.throws(() =>
      sizeOrder({ cash: 10000, quantity: 0, price, feeRate: 0.003 }),
    );
});
test("decision and submission never debit balances; confirmed fills do", () => {
  const s = started();
  let r = advanceRun(s);
  assert.equal(r.view.pending.status, "PREPARED");
  assert.equal(Object.keys(r.broker.orders).length, 0);
  r = advanceRun(s);
  assert.equal(r.view.pending.status, "SUBMITTED");
  assert.equal(r.view.account.cash, CAPITAL);
  assert.equal(r.view.fills.length, 0);
  r = advanceRun(s);
  assert.equal(r.view.orders[0].status, "FILLED");
  assert.ok(r.view.account.cash < CAPITAL);
  assert.equal(r.view.fills.length, 1);
});
test("partial fills affect only actual quantity and lock the next monthly decision", () => {
  const s = started("partial");
  advanceRun(s);
  advanceRun(s);
  let r = advanceRun(s);
  assert.equal(r.view.pending.status, "PARTIAL");
  assert.equal(r.view.orders.length, 1);
  assert.equal(r.view.account.units, r.view.fills[0].units);
  assert.ok(r.view.account.units < r.view.orders[0].units);
  const partial = r.view.account.cash;
  r = advanceRun(s);
  assert.equal(r.view.orders.length, 1);
  assert.equal(r.view.orders[0].status, "FILLED");
  assert.ok(r.view.account.cash < partial);
  r = advanceRun(s);
  assert.equal(r.view.orders.length, 2);
});
test("lost acceptance acknowledgement survives reload and retry without a second submission", () => {
  const s = started("faults");
  advanceRun(s);
  let r = advanceRun(s);
  assert.equal(r.interrupted, true);
  assert.equal(r.view.pending.status, "PREPARED");
  assert.equal(Object.keys(r.broker.orders).length, 1);
  const copy = storage();
  for (const [k, v] of s.data) copy.setItem(k, v);
  r = advanceRun(copy);
  assert.equal(r.view.pending.status, "SUBMITTED");
  assert.equal(Object.keys(r.broker.orders).length, 1);
  r = advanceRun(copy);
  assert.equal(r.view.fills.length, 1);
  assert.equal(new Set(r.view.fills.map((f) => f.id)).size, 1);
});
test("each persistence transition type recovers to the same final ledger after a write failure", () => {
  const expected = finish(started("partial")).view;
  // Exercise failed writes before/after broker acceptance and each partial fill acknowledgement.
  for (let failure = 1; failure <= 12; failure++) {
    const s = started("partial"),
      write = s.setItem;
    let count = 0;
    s.setItem = (k, v) => {
      if (++count === failure) throw Error("disk full");
      write(k, v);
    };
    let complete = false;
    for (let i = 0; i < 150 && !complete; i++) {
      try {
        complete = advanceRun(s).view.complete;
      } catch (e) {
        assert.match(e.message, /disk full/);
      }
      // A full process restart re-parses both durable records on every iteration.
      loadRun(s);
    }
    assert.ok(complete);
    assert.deepEqual(loadRun(s).view, expected);
  }
});
test("failed initial two-record creation blocks rather than silently resets", () => {
  const s = storage(),
    write = s.setItem;
  s.setItem = (k, v) => {
    if (k === JOURNAL_KEY) throw Error("quota");
    write(k, v);
  };
  assert.throws(() => startRun(s, config, "test-run-0001"));
  assert.throws(() => loadRun(s), /puuttuu/);
  assert.ok(s.getItem(BROKER_KEY));
});
test("rejection, delayed response and partial cancellation preserve accounting", () => {
  const r = finish(started("faults"));
  const rejected = r.view.orders.find((o) => o.status === "REJECTED");
  assert.ok(rejected);
  assert.equal(rejected.fills.length, 0);
  const canceled = r.view.orders.find((o) => o.status === "CANCELED");
  assert.ok(canceled);
  assert.equal(canceled.fills.length, 1);
  assert.ok(canceled.fills[0].units < canceled.units);
  const delayed = r.view.orders[3];
  assert.equal(delayed.status, "FILLED");
  assert.equal(
    Date.parse(delayed.fills[0].time) - Date.parse(delayed.time),
    2 * 3600000,
  );
  const intent = r.broker.orders[delayed.id].intent;
  assert.equal(brokerResponse(intent, r.journal.config, 1).status, "WAITING");
  assert.equal(brokerResponse(intent, r.journal.config, 2).fills.length, 0);
});
test("rising execution price cannot spend more cash or invent a negative balance", () => {
  const made = createRun({ ...config, profile: "partial" }, "test-run-0001");
  const intent = {
    id: "test-run-0001:0",
    index: 0,
    time: START,
    price: 100,
    cashBefore: 100,
    unitsBefore: 0,
    side: "BUY",
    units: Math.floor((100 / (100 * 1.003)) * UNIT),
  };
  const response = brokerResponse(intent, made.journal.config, 2);
  assert.equal(response.status, "REJECTED");
  assert.equal(response.fills.length, 1);
  assert.ok(response.fills[0].units < intent.units);
});
test("all assets, costs, price paths and broker profiles finish a year and conserve balances", () => {
  for (const asset of ["BTC", "ETH"])
    for (const cost of ["base", "stress"])
      for (const scenario of ["waves", "trend", "shock"])
        for (const profile of ["normal", "partial", "faults"]) {
          const s = storage();
          startRun(s, { asset, cost, scenario, profile }, "test-run-0001");
          const r = finish(s);
          let cash = CAPITAL,
            units = 0,
            fees = 0;
          for (const f of r.view.fills) {
            cash +=
              (((f.side === "BUY" ? -1 : 1) * f.units) / UNIT) * f.price -
              f.fee;
            units += (f.side === "BUY" ? 1 : -1) * f.units;
            fees += f.fee;
          }
          near(r.view.account.cash, cash);
          assert.equal(r.view.account.units, units);
          near(r.view.account.fees, fees);
          assert.equal(r.view.orders.length, 13);
          assert.equal(
            new Set(r.view.fills.map((f) => f.id)).size,
            r.view.fills.length,
          );
          assert.ok(Object.keys(r.broker.orders).length <= 13);
          assert.ok(cash >= 0 && units >= 0);
          assert.ok(r.view.reserve > 0);
          const before = [...s.data];
          advanceRun(s);
          assert.deepEqual([...s.data], before);
        }
});
test("ideal execution matches V13 reference within quantity-rounding error", () => {
  for (const asset of ["BTC", "ETH"])
    for (const cost of ["base", "stress"]) {
      const s = storage();
      startRun(s, { ...config, asset, cost }, "test-run-0001");
      const actual = finish(s).view;
      const result = simulate({
        bars: syntheticBars(asset, "waves"),
        start: START,
        end: END,
        roundTripCost: COSTS[cost],
        policy: "monthly_target",
      });
      const reference = snapshot(result, result.valuation.length);
      near(actual.equity, CAPITAL * reference.equity, 0.0001);
      near(actual.account.cash, CAPITAL * reference.cash, 0.0001);
      near(actual.account.fees, CAPITAL * reference.fees, 0.0001);
    }
});
test("missing, corrupt, mismatched and unrecognized states fail closed", () => {
  for (const mutate of [
    (s) => s.data.delete(BROKER_KEY),
    (s) => s.setItem(JOURNAL_KEY, "broken"),
    (s) => {
      const b = JSON.parse(s.getItem(BROKER_KEY));
      b.run = "other-run";
      s.setItem(BROKER_KEY, JSON.stringify(b));
    },
    (s) => {
      const j = JSON.parse(s.getItem(JOURNAL_KEY));
      j.complete = true;
      s.setItem(JOURNAL_KEY, JSON.stringify(j));
    },
    (s) => {
      const b = JSON.parse(s.getItem(BROKER_KEY));
      b.orders.fake = {};
      s.setItem(BROKER_KEY, JSON.stringify(b));
    },
    (s) => {
      const j = JSON.parse(s.getItem(JOURNAL_KEY));
      j.orders[0].polls = 3;
      s.setItem(JOURNAL_KEY, JSON.stringify(j));
    },
  ]) {
    const s = started();
    advanceRun(s);
    mutate(s);
    const before = [...s.data];
    assert.throws(() => advanceRun(s));
    assert.deepEqual([...s.data], before);
  }
});
