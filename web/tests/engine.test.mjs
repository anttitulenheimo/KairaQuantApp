import test from "node:test";
import assert from "node:assert/strict";
import {
  COSTS,
  START,
  END,
  HOUR,
  MAX_STEP,
  schedule,
  nextMonthStep,
  targetFill,
  syntheticBars,
  simulate,
  snapshot,
} from "../public/engine.mjs";
import {
  STORAGE_KEY,
  freshSession,
  parseSession,
  saveSession,
} from "../public/session.mjs";
const args = {
  bars: syntheticBars("BTC", "waves"),
  start: START,
  end: END,
  roundTripCost: COSTS.base,
  policy: "monthly_target",
};
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
test("UTC schedule includes leap year, excludes both window boundaries", () => {
  assert.equal(schedule(START, END).length, 12);
  assert.deepEqual(schedule("2020-01-01T00:00:00Z", "2020-03-01T00:00:00Z"), [
    "2020-02-01T00:00:00.000Z",
  ]);
  assert.throws(() => schedule("2020-01-01", END));
  assert.throws(() => schedule("2020-01-01T00:00:00+03:00", END));
  let step = 0,
    count = 0;
  while (step < MAX_STEP) {
    const next = nextMonthStep(step);
    assert.ok(next > step);
    step = next;
    count++;
  }
  assert.equal(count, 13);
  assert.equal(nextMonthStep(MAX_STEP), MAX_STEP);
});
test("buy, sell and no-op solve a post-fee 10% target and conserve cash", () => {
  for (const fee of [0.003, 0.006])
    for (const price of [50, 100, 200]) {
      const fill = targetFill(0.9, 0.001, price, fee);
      approx(fill.equity_after, 0.9 + 0.001 * price - fill.fee);
      approx(fill.weight_after, 0.1);
      assert.equal(
        fill.event_type,
        price < 100 ? "BUY" : price > 100 ? "SELL" : "NOOP",
      );
    }
  for (const price of [0, -1, NaN, Infinity])
    assert.throws(() => targetFill(0.9, 0.001, price, 0.003));
});
test("initial fee budget differs from post-fee rebalancing target", () => {
  const result = simulate(args),
    first = result.events[0];
  approx(first.signed_notional + first.fee, 0.1);
  approx(first.cash_after, 0.9);
  assert.ok(first.weight_after < 0.1);
  assert.equal(result.events.length, 13);
  assert.equal(result.valuation.length, 2196);
});
test("all deterministic scenarios support both assets/costs; controls hold quantity", () => {
  for (const scenario of ["waves", "trend", "shock"])
    for (const asset of ["BTC", "ETH"])
      for (const roundTripCost of Object.values(COSTS)) {
        const bars = syntheticBars(asset, scenario);
        assert.deepEqual(bars, syntheticBars(asset, scenario));
        const result = simulate({
          ...args,
          bars,
          roundTripCost,
          policy: "buy_hold",
        });
        const first = result.events[0],
          end = snapshot(result, MAX_STEP);
        result.events.slice(1).forEach((e) => {
          assert.equal(e.event_type, "MARK_ONLY");
          assert.equal(e.quantity_after, first.quantity_after);
        });
        approx(end.cash, 0.9);
        approx(
          end.adjusted,
          0.9 +
            first.quantity_after * bars.at(-1).close * (1 - roundTripCost / 2),
        );
        approx(end.fees, first.fee);
        assert.ok(end.drawdown >= 0);
      }
});
test("month close is marked before a gapped open and rebalance", () => {
  const bars = structuredClone(args.bars),
    start = Date.parse(START);
  const time = schedule(START, END)[0],
    index = (Date.parse(time) - start) / HOUR;
  bars[index].open *= 3;
  const result = simulate({ ...args, bars }),
    event = result.events[1],
    row = result.valuation[index / 4 - 1];
  assert.equal(row.quantity, result.events[0].quantity_after);
  assert.equal(event.price, bars[index].open);
  assert.equal(row.price, bars[index - 1].close);
  const view = snapshot(result, index / 4);
  assert.equal(view.quantity, event.quantity_after);
  approx(view.weight, 0.1);
});
test("missing, duplicate, unordered and invalid prices stop simulation", () => {
  assert.throws(() => simulate({ ...args, bars: args.bars.slice(1) }));
  for (const mutate of [
    (b) => {
      b[4].timestamp = b[3].timestamp;
    },
    (b) => {
      [b[3], b[4]] = [b[4], b[3]];
    },
    (b) => {
      b[2].open = NaN;
    },
    (b) => {
      b[8].close = -2;
    },
  ]) {
    const bars = structuredClone(args.bars);
    mutate(bars);
    assert.throws(() => simulate({ ...args, bars }));
  }
  assert.throws(() => simulate({ ...args, roundTripCost: 0 }));
});
test("terminal reserve is not a realized trade or cash debit", () => {
  const result = simulate(args),
    before = snapshot(result, MAX_STEP - 1),
    end = snapshot(result, MAX_STEP);
  assert.equal(before.reserve, 0);
  assert.ok(end.reserve > 0);
  assert.equal(end.cash, before.cash);
  assert.equal(end.events.length, before.events.length);
  approx(end.netReturn, end.equity - end.reserve - 1);
  assert.deepEqual(snapshot(result, MAX_STEP), end);
});
test("JSON round-trip replays balances and decisions exactly without duplicate fills", () => {
  const session = { ...freshSession(), step: nextMonthStep(0) },
    restored = parseSession(JSON.stringify(session));
  const result = simulate(args),
    before = snapshot(result, session.step),
    replay = snapshot(simulate(args), restored.step);
  assert.deepEqual(replay, before);
  assert.equal(replay.events.length, 2);
  const final = snapshot(result, MAX_STEP);
  assert.equal(final.events.length, 13);
});
test("imports reject unknown schemas, scenarios, fields and invalid cursors", () => {
  for (const value of [
    null,
    [],
    { ...freshSession(), version: 2 },
    { ...freshSession(), scenario: "__proto__" },
    { ...freshSession(), step: -1 },
    { ...freshSession(), step: MAX_STEP + 1 },
    { ...freshSession(), step: 1.5 },
    { ...freshSession(), fee: 0 },
  ])
    assert.throws(() => parseSession(JSON.stringify(value)));
  assert.throws(() => parseSession("broken"));
  assert.throws(() => parseSession(" ".repeat(4097)));
});
test("storage conflicts and write failures preserve previous state", () => {
  const map = new Map(),
    storage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => map.set(key, value),
    };
  const saved = saveSession(storage, freshSession(), null);
  assert.throws(() =>
    saveSession(storage, { ...freshSession(), step: 10 }, null),
  );
  assert.equal(storage.getItem(STORAGE_KEY), saved);
  storage.setItem = () => {
    throw Error("quota");
  };
  assert.throws(() =>
    saveSession(storage, { ...freshSession(), step: 10 }, saved),
  );
  assert.equal(storage.getItem(STORAGE_KEY), saved);
});
