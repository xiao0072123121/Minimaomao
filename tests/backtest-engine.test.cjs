const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../public/backtest-engine.js");

const M15 = 15 * 60 * 1000;

function syntheticCandles(count = 5000) {
  const start = Date.UTC(2026, 0, 1);
  const candles = [];
  let previous = 4500;
  for (let index = 0; index < count; index += 1) {
    const close = 4500 + 45 * Math.sin(index * Math.PI / 48) + 8 * Math.sin(index * Math.PI / 600);
    const open = previous;
    let high = Math.max(open, close) + 2;
    let low = Math.min(open, close) - 2;
    if (index % 96 === 24) high += 12;
    if (index % 96 === 72) low -= 12;
    candles.push({ t: start + index * M15, o: open, h: high, l: low, c: close, v: 100 + index % 20, ct: start + (index + 1) * M15 - 1 });
    previous = close;
  }
  return candles;
}

function seededMarketCandles(count = 8000) {
  const start = Date.UTC(2026, 0, 1);
  const candles = [];
  let seed = 12345;
  let previous = 4500;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let index = 0; index < count; index += 1) {
    const open = previous;
    const close = open + (random() - 0.5) * 8 + 0.05 * Math.sin(index / 500);
    let high = Math.max(open, close) + random() * 5;
    let low = Math.min(open, close) - random() * 5;
    if (index % 50 === 0) high += 12;
    if (index % 73 === 0) low -= 12;
    candles.push({ t: start + index * M15, o: open, h: high, l: low, c: close, v: 100, ct: start + (index + 1) * M15 - 1 });
    previous = close;
  }
  return candles;
}

function maximumConcurrent(trades) {
  const events = trades.flatMap((trade) => [[trade.openAt, 1], [trade.closeAt, -1]])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let active = 0;
  let maximum = 0;
  for (const [, delta] of events) {
    active += delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

test("aggregates M15 candles into aligned H1 candles", () => {
  const candles = syntheticCandles(12);
  const result = engine.aggregateCandles(candles, 60);
  assert.equal(result.length, 3);
  assert.equal(result[0].o, candles[0].o);
  assert.equal(result[0].c, candles[3].c);
  assert.equal(result[0].h, Math.max(...candles.slice(0, 4).map((item) => item.h)));
  assert.equal(result[0].v, candles.slice(0, 4).reduce((sum, item) => sum + item.v, 0));
});

test("does not expose a pivot before right-side confirmation", () => {
  const start = Date.UTC(2026, 0, 1);
  const highs = [1, 2, 5, 3, 2];
  const candles = highs.map((high, index) => ({ t: start + index * 3600000, o: 1, h: high, l: 0, c: 1, ct: start + (index + 1) * 3600000 - 1 }));
  const events = engine.pivotEvents(candles, "H1", 2);
  const resistance = events.find((event) => event.kind === "resistance");
  assert.ok(resistance);
  assert.equal(resistance.pivotAt, candles[2].t);
  assert.equal(resistance.confirmedAt, candles[4].ct);
  assert.ok(resistance.confirmedAt > resistance.pivotAt);
});

test("recognizes a bearish rejection wick only after its candle closes", () => {
  const zone = { low: 4498, high: 4502 };
  const previous = { o: 4498, h: 4500, l: 4497, c: 4499 };
  const candle = { o: 4500, h: 4512, l: 4497, c: 4498 };
  assert.equal(engine.reversalSignal("short", candle, previous, zone, { longWick: true, engulfing: false, reclaim: false }), "M15长影线");
});

test("requires repeated physical touches before a zone is strong", () => {
  const h1Only = { touchTimes: [1, 2], timeframes: new Set(["H1"]) };
  const confluenceOneTouch = { touchTimes: [1], timeframes: new Set(["H1", "H4"]) };
  assert.equal(engine.isStrongZone(h1Only), false);
  assert.equal(engine.isStrongZone({ ...h1Only, touchTimes: [1, 2, 3] }), true);
  assert.equal(engine.isStrongZone(confluenceOneTouch), false);
  assert.equal(engine.isStrongZone({ ...confluenceOneTouch, touchTimes: [1, 2] }), true);
});

test("runs a deterministic, finite price-action backtest", () => {
  const candles = syntheticCandles();
  const options = { analysisStart: candles[500].t, slippage: 0.2 };
  const first = engine.runBacktest(candles, options);
  const second = engine.runBacktest(candles, options);
  assert.ok(first.summary.tradeCount > 20);
  assert.ok(Number.isFinite(first.summary.finalEquity));
  assert.ok(Number.isFinite(first.summary.maximumDrawdown));
  assert.equal(first.summary.tradeCount, first.trades.length);
  assert.equal(first.summary.finalEquity, second.summary.finalEquity);
  assert.deepEqual(first.trades.map((trade) => trade.id), second.trades.map((trade) => trade.id));
  assert.ok(first.trades.every((trade) => trade.openAt >= options.analysisStart));
  assert.ok(first.trades.every((trade) => trade.closeAt >= trade.openAt));
  assert.ok(first.summary.totalCosts >= 0);
  assert.ok(Math.abs(first.summary.grossBeforeCosts - first.summary.totalCosts - (first.summary.finalEquity - first.summary.initialCapital)) < 1e-6);
});

test("cost-aware risk, portfolio cap and true break-even remain internally consistent", () => {
  const candles = seededMarketCandles();
  const result = engine.runBacktest(candles, { analysisStart: candles[1000].t });
  const stopped = result.trades.filter((trade) => trade.exitReason === "止损");
  const breakEven = result.trades.filter((trade) => trade.exitReason === "保本/止损");
  assert.ok(stopped.length > 0);
  assert.ok(breakEven.length > 0);
  assert.ok(stopped.every((trade) => trade.rMultiple >= -1.000001));
  assert.ok(breakEven.every((trade) => Math.abs(trade.pnl) < 1e-6));
  assert.ok(maximumConcurrent(result.trades) <= result.options.maximumConcurrent);
  assert.ok(result.trades.every((trade) => trade.commission >= 0 && trade.slippageCost >= 0));
});
