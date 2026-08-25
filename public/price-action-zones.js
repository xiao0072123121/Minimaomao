(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PriceActionZones = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HOUR = 60 * 60 * 1000;
  const FRAME_RULES = Object.freeze({
    h4: { pivotWindow: 3, touchSeparation: 12 * HOUR, weight: 4 },
    h1: { pivotWindow: 4, touchSeparation: 4 * HOUR, weight: 1 }
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function median(values) {
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return NaN;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }

  function findPivots(frame, candles) {
    const rule = FRAME_RULES[frame];
    if (!rule) return [];
    const windowSize = rule.pivotWindow;
    const pivots = [];
    for (let index = windowSize; index < candles.length - windowSize; index += 1) {
      const current = candles[index];
      const neighbors = candles.slice(index - windowSize, index + windowSize + 1);
      const other = neighbors.filter((_, neighborIndex) => neighborIndex !== windowSize);
      const high = other.every((candle) => current.h >= candle.h) && other.some((candle) => current.h > candle.h);
      const low = other.every((candle) => current.l <= candle.l) && other.some((candle) => current.l < candle.l);
      if (high) pivots.push({ price: current.h, time: current.t, frame, kind: "high" });
      if (low) pivots.push({ price: current.l, time: current.t, frame, kind: "low" });
    }
    return pivots;
  }

  function frameBuffer(frame, candles, referencePrice) {
    const recent = candles.slice(frame === "h4" ? -240 : -180);
    const medianRange = median(recent.map((candle) => candle.h - candle.l));
    if (!Number.isFinite(medianRange)) return referencePrice * (frame === "h4" ? 0.0014 : 0.0009);
    return frame === "h4"
      ? clamp(medianRange * 0.28, referencePrice * 0.0012, referencePrice * 0.0048)
      : clamp(medianRange * 0.30, referencePrice * 0.0008, referencePrice * 0.0030);
  }

  function distinctPivots(pivots) {
    const accepted = [];
    for (const pivot of [...pivots].sort((a, b) => a.time - b.time)) {
      const separation = FRAME_RULES[pivot.frame].touchSeparation;
      const duplicate = accepted.some((item) => item.frame === pivot.frame
        && item.kind === pivot.kind
        && Math.abs(item.time - pivot.time) < separation);
      if (!duplicate) accepted.push(pivot);
    }
    return accepted;
  }

  function makeZone(pivots, buffers, referencePrice) {
    const clean = distinctPivots(pivots);
    const frames = [...new Set(clean.map((pivot) => pivot.frame))];
    const highPivots = clean.filter((pivot) => pivot.kind === "high");
    const lowPivots = clean.filter((pivot) => pivot.kind === "low");
    const h4Pivots = clean.filter((pivot) => pivot.frame === "h4");
    const h1Pivots = clean.filter((pivot) => pivot.frame === "h1");
    const buffer = Math.max(...frames.map((frame) => buffers[frame] * 0.72));
    const weightedTotal = clean.reduce((sum, pivot) => sum + pivot.price * FRAME_RULES[pivot.frame].weight, 0);
    const totalWeight = clean.reduce((sum, pivot) => sum + FRAME_RULES[pivot.frame].weight, 0);
    const center = weightedTotal / Math.max(1, totalWeight);
    const low = Math.min(...clean.map((pivot) => pivot.price)) - buffer;
    const high = Math.max(...clean.map((pivot) => pivot.price)) + buffer;
    const confluence = frames.length > 1;
    const doubleBottom = lowPivots.length >= 2 && lowPivots.length > highPivots.length;
    const doubleTop = highPivots.length >= 2 && highPivots.length > lowPivots.length;
    const strength = h4Pivots.length * 4 + h1Pivots.length
      + (confluence ? 4 : 0) + (doubleBottom || doubleTop ? 2 : 0);
    return {
      center,
      low,
      high,
      touches: clean.length,
      frames,
      highTouches: highPivots.length,
      lowTouches: lowPivots.length,
      h4HighTouches: highPivots.filter((pivot) => pivot.frame === "h4").length,
      h4LowTouches: lowPivots.filter((pivot) => pivot.frame === "h4").length,
      h1HighTouches: highPivots.filter((pivot) => pivot.frame === "h1").length,
      h1LowTouches: lowPivots.filter((pivot) => pivot.frame === "h1").length,
      newest: Math.max(...clean.map((pivot) => pivot.time)),
      oldest: Math.min(...clean.map((pivot) => pivot.time)),
      confluence,
      doubleBottom,
      doubleTop,
      strength,
      pivots: clean,
      referencePrice
    };
  }

  function shouldKeep(zone) {
    const h4Touches = zone.h4HighTouches + zone.h4LowTouches;
    const h1Touches = zone.h1HighTouches + zone.h1LowTouches;
    return h4Touches >= 2 || (zone.confluence && zone.touches >= 2) || h1Touches >= 3;
  }

  function buildZones(frames, referencePrice) {
    if (!Number.isFinite(referencePrice) || !frames?.h4?.length || !frames?.h1?.length) return [];
    const buffers = {
      h4: frameBuffer("h4", frames.h4, referencePrice),
      h1: frameBuffer("h1", frames.h1, referencePrice)
    };
    const pivots = [
      ...findPivots("h4", frames.h4),
      ...findPivots("h1", frames.h1)
    ].sort((a, b) => a.price - b.price);
    const clusters = [];
    const maximumSpan = referencePrice * 0.0065;
    for (const pivot of pivots) {
      const radius = buffers[pivot.frame] * 1.22;
      let match = null;
      let distance = Infinity;
      for (const cluster of clusters) {
        const nextMinimum = Math.min(cluster.minimum, pivot.price);
        const nextMaximum = Math.max(cluster.maximum, pivot.price);
        const currentDistance = Math.abs(cluster.center - pivot.price);
        if (currentDistance <= Math.max(cluster.radius, radius)
          && nextMaximum - nextMinimum <= maximumSpan
          && currentDistance < distance) {
          match = cluster;
          distance = currentDistance;
        }
      }
      if (!match) {
        clusters.push({ center: pivot.price, minimum: pivot.price, maximum: pivot.price, radius, pivots: [pivot] });
        continue;
      }
      match.pivots.push(pivot);
      match.minimum = Math.min(match.minimum, pivot.price);
      match.maximum = Math.max(match.maximum, pivot.price);
      match.radius = Math.max(match.radius, radius);
      const weighted = match.pivots.reduce((sum, item) => sum + item.price * FRAME_RULES[item.frame].weight, 0);
      const totalWeight = match.pivots.reduce((sum, item) => sum + FRAME_RULES[item.frame].weight, 0);
      match.center = weighted / totalWeight;
    }

    const zones = clusters.map((cluster) => makeZone(cluster.pivots, buffers, referencePrice))
      .filter(shouldKeep)
      .sort((a, b) => a.center - b.center);
    const merged = [];
    const mergeGap = referencePrice * 0.0009;
    for (const zone of zones) {
      const previous = merged.at(-1);
      const combinedSpan = previous ? Math.max(previous.high, zone.high) - Math.min(previous.low, zone.low) : Infinity;
      if (previous && zone.low - previous.high <= mergeGap && combinedSpan <= maximumSpan) {
        merged[merged.length - 1] = makeZone([...previous.pivots, ...zone.pivots], buffers, referencePrice);
      } else {
        merged.push(zone);
      }
    }
    const recentH4 = frames.h4.slice(-18);
    const recentH4High = Math.max(...recentH4.map((candle) => candle.h));
    const recentH4Low = Math.min(...recentH4.map((candle) => candle.l));
    return merged.filter(shouldKeep).map((zone) => ({ ...zone, recentH4High, recentH4Low }))
      .sort((a, b) => a.center - b.center);
  }

  function zoneRole(zone, price) {
    if (!Number.isFinite(price)) return "unknown";
    if (price < zone.low) return "resistance";
    if (price > zone.high) return "support";
    return "active";
  }

  function hasAlternatingBoxEdge(zone, zones, referencePrice) {
    if (zone.highTouches < 3 || zone.h4HighTouches < 1 || zone.highTouches < zone.lowTouches * 1.5) return false;
    return zones.some((lower) => {
      if (lower.center >= zone.center || lower.lowTouches < 2) return false;
      const height = zone.center - lower.center;
      if (height < referencePrice * 0.004 || height > referencePrice * 0.045) return false;
      const events = [
        ...zone.pivots.filter((pivot) => pivot.kind === "high").map((pivot) => ({ time: pivot.time, edge: "upper" })),
        ...lower.pivots.filter((pivot) => pivot.kind === "low").map((pivot) => ({ time: pivot.time, edge: "lower" }))
      ].sort((a, b) => a.time - b.time);
      const alternating = events.filter((event, index) => !index || event.edge !== events[index - 1].edge);
      return alternating.length >= 5
        && alternating.filter((event) => event.edge === "upper").length >= 3
        && alternating.filter((event) => event.edge === "lower").length >= 2;
    });
  }

  function resistanceKind(zone, zones, referencePrice) {
    if (zone.h4LowTouches >= 3 && zone.h4LowTouches >= Math.max(1, zone.h4HighTouches) * 2) return "support-flip";
    if (hasAlternatingBoxEdge(zone, zones, referencePrice)) return "box-upper";
    return "";
  }

  function selectDistinct(zones, limit, referencePrice) {
    const selected = [];
    const minimumDistance = referencePrice * 0.016;
    for (const zone of zones) {
      if (selected.some((item) => Math.abs(item.center - zone.center) < minimumDistance)) continue;
      selected.push(zone);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  function isSupportCandidate(zone) {
    const rejectionSupport = zone.doubleBottom && zone.lowTouches >= 2;
    const resistanceFlip = zone.highTouches >= 2 && zone.highTouches >= Math.max(1, zone.lowTouches) * 1.5;
    return rejectionSupport || resistanceFlip;
  }

  function supportSelectionScore(zone) {
    const lowScore = zone.h4LowTouches * 5 + zone.h1LowTouches * 2;
    const flipScore = zone.h4HighTouches * 3 + zone.h1HighTouches;
    const purityBonus = zone.lowTouches > zone.highTouches * 1.5 ? 6 : 0;
    return Math.max(lowScore, flipScore) + purityBonus + (zone.doubleBottom ? 5 : 0) + (zone.confluence ? 2 : 0);
  }

  function selectSupports(zones, limit, referencePrice) {
    const groupingDistance = referencePrice * 0.005;
    const groups = [];
    for (const zone of [...zones].sort((a, b) => b.center - a.center)) {
      const group = groups.find((items) => Math.abs(items[0].center - zone.center) <= groupingDistance);
      if (group) group.push(zone);
      else groups.push([zone]);
    }
    const representatives = groups.map((items) => [...items].sort((a, b) => supportSelectionScore(b) - supportSelectionScore(a))[0])
      .sort((a, b) => b.center - a.center);
    return selectDistinct(representatives, limit, referencePrice);
  }

  function mergeDisplayResistances(zones, referencePrice) {
    const merged = [];
    const maximumGap = referencePrice * 0.0045;
    const maximumSpan = referencePrice * 0.020;
    for (const zone of zones.sort((a, b) => a.low - b.low)) {
      const previous = merged.at(-1);
      if (!previous || zone.low - previous.high > maximumGap
        || Math.max(previous.high, zone.high) - Math.min(previous.low, zone.low) > maximumSpan) {
        merged.push({ ...zone });
        continue;
      }
      const combinedStrength = previous.strength + zone.strength;
      previous.center = (previous.center * previous.strength + zone.center * zone.strength) / Math.max(1, combinedStrength);
      previous.low = Math.min(previous.low, zone.low);
      previous.high = Math.max(previous.high, zone.high);
      previous.strength = combinedStrength;
      previous.touches += zone.touches;
      previous.highTouches += zone.highTouches;
      previous.lowTouches += zone.lowTouches;
      previous.h4HighTouches += zone.h4HighTouches;
      previous.h4LowTouches += zone.h4LowTouches;
      previous.h1HighTouches += zone.h1HighTouches;
      previous.h1LowTouches += zone.h1LowTouches;
      previous.frames = [...new Set([...previous.frames, ...zone.frames])];
      previous.confluence = previous.frames.length > 1;
      previous.newest = Math.max(previous.newest, zone.newest);
      previous.oldest = Math.min(previous.oldest, zone.oldest);
      previous.resistanceKind = previous.resistanceKind === "support-flip" || zone.resistanceKind === "support-flip"
        ? "support-flip" : "box-upper";
      if (previous.h4LowTouches >= 2) previous.resistanceKind = "support-flip";
    }
    return merged;
  }

  function selectForDisplay(zones, referencePrice) {
    if (!Number.isFinite(referencePrice)) return { active: null, supports: [], resistances: [] };
    const active = zones
      .filter((zone) => zoneRole(zone, referencePrice) === "active")
      .sort((a, b) => b.strength - a.strength || Math.abs(a.center - referencePrice) - Math.abs(b.center - referencePrice))[0] || null;
    const supports = selectSupports(zones
      .filter((zone) => zoneRole(zone, referencePrice) === "support")
      .filter(isSupportCandidate)
      .filter((zone) => !active || Math.abs(zone.center - active.center) >= referencePrice * 0.016)
      .sort((a, b) => b.high - a.high || b.strength - a.strength), active ? 3 : 4, referencePrice);
    const recentHigh = Math.max(...zones.map((zone) => zone.recentH4High).filter(Number.isFinite));
    const rawResistances = zones
      .filter((zone) => zoneRole(zone, referencePrice) === "resistance")
      .map((zone) => ({ ...zone, resistanceKind: resistanceKind(zone, zones, referencePrice) }))
      .filter((zone) => zone.resistanceKind)
      .filter((zone) => !Number.isFinite(recentHigh) || zone.low > recentHigh + referencePrice * 0.001)
      .sort((a, b) => a.low - b.low || b.strength - a.strength);
    const resistances = selectDistinct(mergeDisplayResistances(rawResistances, referencePrice), 2, referencePrice);
    return { active, supports, resistances };
  }

  return {
    buildZones,
    findPivots,
    hasAlternatingBoxEdge,
    resistanceKind,
    selectForDisplay,
    zoneRole
  };
});
