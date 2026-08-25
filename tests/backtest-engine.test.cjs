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
});
