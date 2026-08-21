(function attachVolumeProfile(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LowLoadVolumeProfile = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const DEFAULT_BIN_COUNT = 48;
  const DEFAULT_MAX_CANDLES = 320;
  const DEFAULT_VALUE_AREA_RATIO = 0.7;
  const MINIMUM_CANDLES = 40;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function finiteCandle(candle) {
    return candle && [candle.h, candle.l, candle.c, candle.v].every(Number.isFinite) &&
      candle.h >= candle.l && candle.v > 0;
  }

  function addCandleVolume(bins, candle, minimum, binSize) {
    const highestIndex = bins.length - 1;
    const startIndex = clamp(Math.floor((candle.l - minimum) / binSize), 0, highestIndex);
    const endIndex = clamp(Math.floor((candle.h - minimum) / binSize), 0, highestIndex);
    if (startIndex === endIndex || candle.h === candle.l) {
      bins[startIndex].volume += candle.v;
      return;
    }

    const typicalPrice = (candle.h + candle.l + candle.c * 2) / 4;
    const candleRange = Math.max(candle.h - candle.l, binSize);
    const allocations = [];
    let weightTotal = 0;
    for (let index = startIndex; index <= endIndex; index += 1) {
      const bin = bins[index];
      const overlap = Math.max(0, Math.min(candle.h, bin.high) - Math.max(candle.l, bin.low));
      if (overlap <= 0) continue;
      const distance = Math.abs(bin.center - typicalPrice) / candleRange;
      const weight = overlap * (1 + Math.max(0, 1 - distance) * 0.75);
      allocations.push([index, weight]);
      weightTotal += weight;
    }

    if (weightTotal <= 0) {
      bins[clamp(Math.round((typicalPrice - minimum) / binSize), 0, highestIndex)].volume += candle.v;
      return;
    }
    for (const [index, weight] of allocations) bins[index].volume += candle.v * weight / weightTotal;
  }

  function valueAreaBounds(bins, pocIndex, targetVolume) {
    let lowIndex = pocIndex;
    let highIndex = pocIndex;
    let accumulated = bins[pocIndex].volume;
    while (accumulated < targetVolume && (lowIndex > 0 || highIndex < bins.length - 1)) {
      const lowerVolume = lowIndex > 0 ? bins[lowIndex - 1].volume : -1;
      const upperVolume = highIndex < bins.length - 1 ? bins[highIndex + 1].volume : -1;
      if (upperVolume >= lowerVolume && highIndex < bins.length - 1) {
        highIndex += 1;
        accumulated += bins[highIndex].volume;
      } else if (lowIndex > 0) {
        lowIndex -= 1;
        accumulated += bins[lowIndex].volume;
      } else {
        break;
      }
    }
    return { lowIndex, highIndex, accumulated };
  }

  function denseBands(bins, maximumVolume) {
    const threshold = maximumVolume * 0.55;
    const bands = [];
    let start = -1;
    for (let index = 0; index <= bins.length; index += 1) {
      const dense = index < bins.length && bins[index].volume >= threshold;
      if (dense && start < 0) start = index;
      if (!dense && start >= 0) {
        const end = index - 1;
        const volume = bins.slice(start, end + 1).reduce((sum, bin) => sum + bin.volume, 0);
        bands.push({ low: bins[start].low, high: bins[end].high, center: (bins[start].low + bins[end].high) / 2, volume });
        start = -1;
      }
    }
    return bands;
  }

  function displayBins(bins, pocIndex, maximumVolume) {
    const start = clamp(pocIndex - 2, 0, Math.max(0, bins.length - 5));
    return bins.slice(start, start + 5).reverse().map((bin) => ({
      low: bin.low,
      high: bin.high,
      center: bin.center,
      volume: bin.volume,
      ratio: maximumVolume > 0 ? bin.volume / maximumVolume : 0,
      poc: bin.index === pocIndex
    }));
  }

  function buildVolumeProfile(candles, options = {}) {
    if (!Array.isArray(candles)) return null;
    const maximumCandles = clamp(Number(options.maxCandles) || DEFAULT_MAX_CANDLES, MINIMUM_CANDLES, 1000);
    const sample = candles.slice(-maximumCandles).filter(finiteCandle);
    if (sample.length < MINIMUM_CANDLES) return null;

    const minimum = Math.min(...sample.map((candle) => candle.l));
    const maximum = Math.max(...sample.map((candle) => candle.h));
    const span = maximum - minimum;
    if (!Number.isFinite(span) || span <= 0) return null;

    const binCount = clamp(Math.round(Number(options.binCount) || DEFAULT_BIN_COUNT), 24, 96);
    const binSize = span / binCount;
    const bins = Array.from({ length: binCount }, (_, index) => ({
      index,
      low: minimum + binSize * index,
      high: minimum + binSize * (index + 1),
      center: minimum + binSize * (index + 0.5),
      volume: 0
    }));
    for (const candle of sample) addCandleVolume(bins, candle, minimum, binSize);

    const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
    if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;
    let pocIndex = 0;
    for (let index = 1; index < bins.length; index += 1) {
      if (bins[index].volume > bins[pocIndex].volume) pocIndex = index;
    }
    const maximumVolume = bins[pocIndex].volume;
    const valueAreaRatio = clamp(Number(options.valueAreaRatio) || DEFAULT_VALUE_AREA_RATIO, 0.5, 0.9);
    const area = valueAreaBounds(bins, pocIndex, totalVolume * valueAreaRatio);
    const bands = denseBands(bins, maximumVolume);
    const fallbackBand = {
      low: bins[Math.max(0, pocIndex - 1)].low,
      high: bins[Math.min(bins.length - 1, pocIndex + 1)].high,
      center: bins[pocIndex].center,
      volume: bins.slice(Math.max(0, pocIndex - 1), Math.min(bins.length, pocIndex + 2)).reduce((sum, bin) => sum + bin.volume, 0)
    };

    return {
      candlesUsed: sample.length,
      binSize,
      totalVolume,
      poc: bins[pocIndex].center,
      pocIndex,
      valueArea: { low: bins[area.lowIndex].low, high: bins[area.highIndex].high, ratio: area.accumulated / totalVolume },
      denseBands: bands.length ? bands : [fallbackBand],
      displayBins: displayBins(bins, pocIndex, maximumVolume),
      bins
    };
  }

  function selectNearestDenseBand(profile, price) {
    if (!profile?.denseBands?.length) return null;
    if (!Number.isFinite(price)) return profile.denseBands.slice().sort((a, b) => b.volume - a.volume)[0];
    return profile.denseBands.slice().sort((left, right) => {
      const leftDistance = price < left.low ? left.low - price : price > left.high ? price - left.high : 0;
      const rightDistance = price < right.low ? right.low - price : price > right.high ? price - right.high : 0;
      return leftDistance - rightDistance || right.volume - left.volume;
    })[0];
  }

  return { buildVolumeProfile, selectNearestDenseBand };
});
