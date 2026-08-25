const test = require("node:test");
const assert = require("node:assert/strict");
const zones = require("../public/price-action-zones.js");

const HOUR = 60 * 60 * 1000;

function makeZone(overrides = {}) {
  return {
    center: 4500,
    low: 4490,
    high: 4510,
    touches: 3,
    frames: ["h4", "h1"],
    highTouches: 0,
    lowTouches: 3,
    h4HighTouches: 0,
    h4LowTouches: 2,
    h1HighTouches: 0,
    h1LowTouches: 1,
    newest: 10 * HOUR,
    oldest: HOUR,
    confluence: true,
    doubleBottom: true,
    doubleTop: false,
    strength: 20,
    pivots: [],
    recentH4High: 4700,
    recentH4Low: 4400,
    ...overrides
  };
}

test("does not invent a nearby resistance from ordinary swing highs", () => {
  const ordinaryHigh = makeZone({
    center: 4680, low: 4670, high: 4690,
    highTouches: 3, lowTouches: 2,
    h4HighTouches: 2, h4LowTouches: 1,
    h1HighTouches: 1, h1LowTouches: 1,
    doubleBottom: false,
    pivots: []
  });
  const result = zones.selectForDisplay([ordinaryHigh], 4635);
  assert.equal(result.resistances.length, 0);
});

test("keeps 4630, 4530, 4450 and the stronger 4310 double bottom hierarchy", () => {
  const active = makeZone({ center: 4632, low: 4624, high: 4640, doubleBottom: false });
  const noisy4545 = makeZone({
    center: 4545, low: 4536, high: 4553,
    highTouches: 6, lowTouches: 0,
    h4HighTouches: 5, h4LowTouches: 0,
    h1HighTouches: 1, h1LowTouches: 0,
    doubleBottom: false, strength: 27
  });
  const support4530 = makeZone({ center: 4530, low: 4518, high: 4540, strength: 31 });
  const support4450 = makeZone({ center: 4452, low: 4442, high: 4462, strength: 25 });
  const noisy4420 = makeZone({ center: 4420, low: 4410, high: 4430, strength: 18, doubleBottom: false });
  const weak4330 = makeZone({ center: 4330, low: 4325, high: 4336, strength: 10 });
  const strong4310 = makeZone({
    center: 4310, low: 4300, high: 4323,
    h4LowTouches: 5, h1LowTouches: 1,
    lowTouches: 6, strength: 31
  });
  const result = zones.selectForDisplay([
    active, noisy4545, support4530, support4450, noisy4420, weak4330, strong4310
  ], 4635);
  assert.equal(result.active.center, 4632);
  assert.deepEqual(result.supports.map((zone) => zone.center), [4530, 4452, 4310]);
});

test("merges adjacent historical upper-edge references into one 4750 area", () => {
  const formerSupport = makeZone({
    center: 4740, low: 4728, high: 4750,
    highTouches: 0, lowTouches: 3,
    h4HighTouches: 0, h4LowTouches: 3,
    h1HighTouches: 0, h1LowTouches: 0,
    doubleBottom: true, doubleTop: false,
    pivots: [
      { time: 2 * HOUR, kind: "low", frame: "h4" },
      { time: 4 * HOUR, kind: "low", frame: "h4" },
      { time: 6 * HOUR, kind: "low", frame: "h4" }
    ]
  });
  const upper = (center, low, high) => makeZone({
    center, low, high,
    highTouches: 3, lowTouches: 0,
    h4HighTouches: 3, h4LowTouches: 0,
    h1HighTouches: 0, h1LowTouches: 0,
    doubleBottom: false, doubleTop: true,
    pivots: [
      { time: HOUR, kind: "high", frame: "h4" },
      { time: 3 * HOUR, kind: "high", frame: "h4" },
      { time: 5 * HOUR, kind: "high", frame: "h4" }
    ]
  });
  const result = zones.selectForDisplay([
    formerSupport,
    upper(4770, 4760, 4782)
  ], 4635);
  assert.equal(result.resistances.length, 1);
  assert.equal(result.resistances[0].low, 4728);
  assert.equal(result.resistances[0].high, 4782);
  assert.ok(result.resistances[0].center > 4740 && result.resistances[0].center < 4770);
  assert.equal(result.resistances[0].resistanceKind, "support-flip");
});

test("requires support dominance before labeling a historical support flip", () => {
  const mixed = makeZone({ h4LowTouches: 5, h4HighTouches: 3 });
  const dominant = makeZone({ h4LowTouches: 6, h4HighTouches: 2 });
  assert.equal(zones.resistanceKind(mixed, [], 4635), "");
  assert.equal(zones.resistanceKind(dominant, [], 4635), "support-flip");
});
