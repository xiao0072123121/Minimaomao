const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  estimateIsolatedLiquidation,
  distanceFromMark
} = require("../public/liquidation-calculator.js");

test("estimates a 20x isolated long liquidation price", () => {
  const result = estimateIsolatedLiquidation({
    entryPrice: 4540,
    quantity: 0.5,
    leverage: 20,
    side: "long"
  });
  const expected = 4540 * (1 - 1 / 20) / (1 - DEFAULT_MAINTENANCE_MARGIN_RATE);
  assert.ok(result);
  assert.ok(Math.abs(result.price - expected) < 1e-9);
  assert.equal(result.entryNotional, 45400);
  assert.equal(result.isolatedMargin, 2270);
});

test("estimates a 20x isolated short liquidation price", () => {
  const result = estimateIsolatedLiquidation({
    entryPrice: 4540,
    quantity: 0.5,
    leverage: 20,
    side: "short"
  });
  const expected = 4540 * (1 + 1 / 20) / (1 + DEFAULT_MAINTENANCE_MARGIN_RATE);
  assert.ok(result);
  assert.ok(Math.abs(result.price - expected) < 1e-9);
  assert.ok(result.price > 4540);
});

test("uses extra isolated margin to move liquidation farther away", () => {
  const longBase = estimateIsolatedLiquidation({ entryPrice: 100, quantity: 1, leverage: 10, side: "long" });
  const longExtra = estimateIsolatedLiquidation({ entryPrice: 100, quantity: 1, leverage: 10, side: "long", extraMargin: 20 });
  const shortBase = estimateIsolatedLiquidation({ entryPrice: 100, quantity: 1, leverage: 10, side: "short" });
  const shortExtra = estimateIsolatedLiquidation({ entryPrice: 100, quantity: 1, leverage: 10, side: "short", extraMargin: 20 });
  assert.ok(longExtra.price < longBase.price);
  assert.ok(shortExtra.price > shortBase.price);
});

test("calculates adverse distance from the current mark price", () => {
  assert.equal(distanceFromMark(100, 90, "long"), 10);
  assert.equal(distanceFromMark(100, 110, "short"), 10);
  assert.equal(distanceFromMark(100, 101, "long"), -1);
});

test("rejects incomplete or invalid position inputs", () => {
  assert.equal(estimateIsolatedLiquidation({ entryPrice: 0, quantity: 1, leverage: 20, side: "long" }), null);
  assert.equal(estimateIsolatedLiquidation({ entryPrice: 100, quantity: 0, leverage: 20, side: "long" }), null);
  assert.equal(estimateIsolatedLiquidation({ entryPrice: 100, quantity: 1, leverage: 20, side: "flat" }), null);
});
