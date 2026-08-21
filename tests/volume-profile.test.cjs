const test = require("node:test");
const assert = require("node:assert/strict");
const { buildVolumeProfile, selectNearestDenseBand } = require("../public/volume-profile.js");

function candle(low, high, close, volume, index = 0) {
  return { t: index * 900000, l: low, h: high, c: close, v: volume };
}

test("builds a volume profile and preserves allocated volume", () => {
  const candles = [];
  for (let index = 0; index < 80; index += 1) {
    candles.push(candle(90 + index % 3, 110 - index % 2, 100, 10, index));
  }
  for (let index = 80; index < 160; index += 1) {
    candles.push(candle(100, 104, 102, 100, index));
  }
  const profile = buildVolumeProfile(candles, { binCount: 40 });
  assert.ok(profile);
  assert.equal(profile.candlesUsed, 160);
  assert.ok(profile.poc >= 100 && profile.poc <= 104);
  assert.ok(Math.abs(profile.totalVolume - 8800) < 1e-6);
  assert.ok(profile.valueArea.low <= profile.poc && profile.valueArea.high >= profile.poc);
  assert.ok(profile.valueArea.ratio >= 0.7);
  assert.equal(profile.displayBins.length, 5);
  assert.equal(profile.displayBins.filter((bin) => bin.poc).length, 1);
});

test("returns null when fewer than 40 candles contain valid volume", () => {
  const candles = Array.from({ length: 39 }, (_, index) => candle(100, 101, 100.5, 10, index));
  assert.equal(buildVolumeProfile(candles), null);
  assert.equal(buildVolumeProfile(candles.map(({ v, ...item }) => item)), null);
});

test("supports flat candles without losing their volume", () => {
  const candles = Array.from({ length: 50 }, (_, index) => {
    const price = 100 + index * 0.1;
    return candle(price, price, price, 20, index);
  });
  const profile = buildVolumeProfile(candles, { binCount: 24 });
  assert.ok(profile);
  assert.ok(Math.abs(profile.totalVolume - 1000) < 1e-6);
});

test("selects the closest dense band to current price", () => {
  const profile = {
    denseBands: [
      { low: 90, high: 92, volume: 100 },
      { low: 105, high: 108, volume: 80 }
    ]
  };
  assert.deepEqual(selectNearestDenseBand(profile, 106), profile.denseBands[1]);
  assert.deepEqual(selectNearestDenseBand(profile, 95), profile.denseBands[0]);
  assert.deepEqual(selectNearestDenseBand(profile, NaN), profile.denseBands[0]);
});

test("caps the working sample to the configured candle limit", () => {
  const candles = Array.from({ length: 600 }, (_, index) => candle(100, 102, 101, 5, index));
  const profile = buildVolumeProfile(candles, { maxCandles: 320 });
  assert.equal(profile.candlesUsed, 320);
  assert.ok(Math.abs(profile.totalVolume - 1600) < 1e-6);
});
