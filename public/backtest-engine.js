(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BacktestEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const directionValue = (side) => side === "long" ? 1 : -1;
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const TOUCH_SEPARATION = 4 * 60 * MINUTE;

  function aggregateCandles(candles, minutes) {
    const interval = minutes * MINUTE;
    const result = [];
    let active = null;
    for (const candle of candles) {
      const bucket = Math.floor(candle.t / interval) * interval;
      if (!active || active.t !== bucket) {
        if (active) result.push(active);
        active = { t: bucket, o: candle.o, h: candle.h, l: candle.l, c: candle.c, v: candle.v || 0, ct: bucket + interval - 1 };
      } else {
        active.h = Math.max(active.h, candle.h);
        active.l = Math.min(active.l, candle.l);
        active.c = candle.c;
        active.v += candle.v || 0;
      }
    }
    if (active) result.push(active);
    return result;
  }

  function pivotEvents(candles, timeframe, window = 2) {
    const events = [];
    for (let index = window; index < candles.length - window; index += 1) {
      const candle = candles[index];
      let high = true;
      let low = true;
      for (let offset = 1; offset <= window; offset += 1) {
        high = high && candle.h > candles[index - offset].h && candle.h >= candles[index + offset].h;
        low = low && candle.l < candles[index - offset].l && candle.l <= candles[index + offset].l;
      }
      const confirmedAt = candles[index + window].ct;
      if (high) events.push({ kind: "resistance", price: candle.h, pivotAt: candle.t, confirmedAt, timeframe });
      if (low) events.push({ kind: "support", price: candle.l, pivotAt: candle.t, confirmedAt, timeframe });
    }
    return events;
  }

  function addPivotToClusters(clusters, event, widthPct) {
    const tolerance = Math.max(Math.abs(event.price) * widthPct, 0.01);
    let match = null;
    let distance = Infinity;
    for (const cluster of clusters) {
      const currentDistance = Math.abs(cluster.center - event.price);
      if (cluster.active && cluster.kind === event.kind && currentDistance <= Math.max(tolerance, cluster.tolerance) && currentDistance < distance) {
        match = cluster;
        distance = currentDistance;
      }
    }
    const weight = event.timeframe === "H4" ? 2 : 1;
    if (!match) {
      clusters.push({
        id: `${event.kind}-${event.timeframe}-${event.pivotAt}`,
        kind: event.kind,
        center: event.price,
        low: event.price - tolerance,
        high: event.price + tolerance,
        tolerance,
        touches: 1,
        touchTimes: [event.pivotAt],
        weight,
        lastEventAt: event.pivotAt,
        timeframes: new Set([event.timeframe]),
        active: true,
        armed: true,
        invalidatedAt: 0
      });
      return;
    }
    match.center = (match.center * match.weight + event.price * weight) / (match.weight + weight);
    match.weight += weight;
    match.touches += 1;
    if (!match.touchTimes.some((timestamp) => Math.abs(timestamp - event.pivotAt) < TOUCH_SEPARATION)) {
      match.touchTimes.push(event.pivotAt);
    }
    match.tolerance = Math.max(match.tolerance, tolerance);
    match.low = match.center - match.tolerance;
    match.high = match.center + match.tolerance;
    match.lastEventAt = Math.max(match.lastEventAt, event.pivotAt);
    match.timeframes.add(event.timeframe);
  }

  function isStrongZone(zone) {
    const physicalTouches = zone.touchTimes?.length || 0;
    const hasH4 = zone.timeframes.has("H4");
    const hasH1 = zone.timeframes.has("H1");
    if (hasH4 && hasH1) return physicalTouches >= 2;
    if (hasH4) return physicalTouches >= 2;
    return physicalTouches >= 3;
  }

  function updateZoneLifecycle(clusters, candle, options) {
    for (const zone of clusters) {
      if (!zone.active) continue;
      const breakBuffer = Math.max(zone.tolerance * options.zoneBreakBuffer, Math.abs(zone.center) * 0.0002);
      const broken = zone.kind === "support"
        ? candle.c < zone.low - breakBuffer
        : candle.c > zone.high + breakBuffer;
      if (broken) {
        zone.active = false;
        zone.armed = false;
        zone.invalidatedAt = candle.ct;
        continue;
      }
      if (!zone.armed) {
        const rearmBuffer = zone.tolerance * options.zoneRearmDistance;
        const leftZone = zone.kind === "support"
          ? candle.l > zone.high + rearmBuffer
          : candle.h < zone.low - rearmBuffer;
        if (leftZone) zone.armed = true;
      }
    }
  }

  function rsiSeries(candles, period = 14) {
    const result = Array(candles.length).fill(NaN);
    if (candles.length <= period) return result;
    let gain = 0;
    let loss = 0;
    for (let index = 1; index <= period; index += 1) {
      const change = candles[index].c - candles[index - 1].c;
      gain += Math.max(change, 0);
      loss += Math.max(-change, 0);
    }
    gain /= period;
    loss /= period;
    result[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let index = period + 1; index < candles.length; index += 1) {
      const change = candles[index].c - candles[index - 1].c;
      gain = (gain * (period - 1) + Math.max(change, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
      result[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return result;
  }

  function reversalSignal(side, candle, previous, zone, enabled) {
    const range = Math.max(candle.h - candle.l, Number.EPSILON);
    const body = Math.max(Math.abs(candle.c - candle.o), range * 0.06);
    const upperWick = candle.h - Math.max(candle.o, candle.c);
    const lowerWick = Math.min(candle.o, candle.c) - candle.l;
    const longWick = side === "long"
      ? lowerWick >= body * 1.5 && candle.c >= candle.l + range * 0.55
      : upperWick >= body * 1.5 && candle.c <= candle.l + range * 0.45;
    const engulfing = side === "long"
      ? candle.c > candle.o && previous.c < previous.o && candle.o <= previous.c && candle.c >= previous.o
      : candle.c < candle.o && previous.c > previous.o && candle.o >= previous.c && candle.c <= previous.o;
    const reclaim = side === "long"
      ? candle.l < zone.low && candle.c > zone.low && candle.c > candle.o
      : candle.h > zone.high && candle.c < zone.high && candle.c < candle.o;
    const rejectedZone = side === "long" ? candle.c >= zone.low : candle.c <= zone.high;
    if (!rejectedZone) return null;
    if (enabled.reclaim && reclaim) return "假突破收回";
    if (enabled.engulfing && engulfing) return "M15吞没";
    if (enabled.longWick && longWick) return "M15长影线";
    return null;
  }

  function findActiveZone(clusters, kind, candle, timestamp, options) {
    const maximumAge = options.maxZoneAgeDays * DAY;
    return clusters
      .filter((zone) => zone.active && zone.armed && zone.kind === kind && isStrongZone(zone))
      .filter((zone) => timestamp - zone.lastEventAt <= maximumAge)
      .filter((zone) => candle.h >= zone.low && candle.l <= zone.high)
      .sort((left, right) => right.weight - left.weight || Math.abs(candle.c - left.center) - Math.abs(candle.c - right.center))[0] || null;
  }

  function priceWithSlippage(rawPrice, side, isEntry, slippage) {
    const direction = directionValue(side);
    return rawPrice + slippage * direction * (isEntry ? 1 : -1);
  }

  function closePart(position, rawPrice, quantity, timestamp, reason, options) {
    const exitPrice = priceWithSlippage(rawPrice, position.side, false, options.slippage);
    const gross = (exitPrice - position.entryPrice) * quantity * directionValue(position.side);
    const fee = Math.abs(exitPrice * quantity) * options.feeRate;
    const slippageCost = Math.abs(exitPrice - rawPrice) * quantity;
    position.pnl += gross - fee;
    position.commission += fee;
    position.slippageCost += slippageCost;
    position.remaining -= quantity;
    position.exits.push({ time: timestamp, rawPrice, price: exitPrice, quantity, fee, slippageCost, reason });
    return gross - fee;
  }

  function projectedPnlAtStop(position, rawStop, options) {
    if (position.remaining <= 0) return position.pnl;
    const exitPrice = priceWithSlippage(rawStop, position.side, false, options.slippage);
    const gross = (exitPrice - position.entryPrice) * position.remaining * directionValue(position.side);
    const fee = Math.abs(exitPrice * position.remaining) * options.feeRate;
    return position.pnl + gross - fee;
  }

  function breakEvenRawStop(position, options) {
    const quantity = position.remaining;
    if (quantity <= 0) return position.entryPrice;
    let executionPrice;
    if (position.side === "long") {
      executionPrice = (position.entryPrice * quantity - position.pnl) / Math.max(Number.EPSILON, quantity * (1 - options.feeRate));
      return executionPrice + options.slippage;
    }
    executionPrice = (position.pnl + position.entryPrice * quantity) / (quantity * (1 + options.feeRate));
    return executionPrice - options.slippage;
  }

  function summarize(trades, equityCurve, initialCapital, finalEquity) {
    const wins = trades.filter((trade) => trade.pnl > 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    const commission = trades.reduce((sum, trade) => sum + trade.commission, 0);
    const slippageCost = trades.reduce((sum, trade) => sum + trade.slippageCost, 0);
    const netPnl = finalEquity - initialCapital;
    let peak = initialCapital;
    let maximumDrawdown = 0;
    for (const point of equityCurve) {
      peak = Math.max(peak, point.equity);
      maximumDrawdown = Math.min(maximumDrawdown, peak > 0 ? (point.equity / peak - 1) * 100 : 0);
    }
    return {
      initialCapital,
      finalEquity,
      grossBeforeCosts: netPnl + commission + slippageCost,
      commission,
      slippageCost,
      totalCosts: commission + slippageCost,
      netReturn: (finalEquity / initialCapital - 1) * 100,
      maximumDrawdown,
      tradeCount: trades.length,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      averageHoldMs: trades.length ? trades.reduce((sum, trade) => sum + trade.closeAt - trade.openAt, 0) / trades.length : 0
    };
  }

  function groupedPerformance(trades, initialCapital) {
    const definitions = [
      ["支撑位做多", (trade) => trade.side === "long"],
      ["压力位做空", (trade) => trade.side === "short"],
      ["M15长影线", (trade) => trade.signal === "M15长影线"],
      ["M15吞没", (trade) => trade.signal === "M15吞没"],
      ["假突破收回", (trade) => trade.signal === "假突破收回"]
    ];
    return definitions.map(([label, predicate]) => {
      const group = trades.filter(predicate);
      const profit = group.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
      const loss = Math.abs(group.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
      return {
        label,
        count: group.length,
        winRate: group.length ? group.filter((trade) => trade.pnl > 0).length / group.length * 100 : 0,
        netReturn: group.reduce((sum, trade) => sum + trade.pnl, 0) / initialCapital * 100,
        profitFactor: loss ? profit / loss : profit > 0 ? Infinity : 0
      };
    });
  }

  function rollingWindows(trades, candles, analysisStart, initialCapital) {
    if (!candles.length) return { windows: [], stages: [] };
    const end = candles[candles.length - 1].ct;
    const windows = [];
    const firstAvailable = Math.max(analysisStart, candles[0].t);
    for (let start = firstAvailable; start + 30 * DAY <= end + 30 * MINUTE; start += DAY) {
      const finish = Math.min(start + 30 * DAY, end);
      const windowTrades = trades.filter((trade) => trade.closeAt >= start && trade.closeAt < finish);
      const first = candles.find((candle) => candle.t >= start);
      let last = null;
      for (const candle of candles) {
        if (candle.t >= finish) break;
        if (candle.t >= start) last = candle;
      }
      const marketReturn = first && last ? (last.c / first.o - 1) * 100 : 0;
      const stage = marketReturn > 4 ? "上涨阶段" : marketReturn < -4 ? "急跌阶段" : "震荡阶段";
      const pnl = windowTrades.reduce((sum, trade) => sum + trade.pnl, 0);
      windows.push({ start, finish, returnPct: pnl / initialCapital * 100, winRate: windowTrades.length ? windowTrades.filter((trade) => trade.pnl > 0).length / windowTrades.length * 100 : 0, count: windowTrades.length, stage });
    }
    const stages = ["上涨阶段", "震荡阶段", "急跌阶段"].map((label) => {
      const matching = windows.filter((window) => window.stage === label);
      return { label, count: matching.length, profitablePct: matching.length ? matching.filter((window) => window.returnPct > 0).length / matching.length * 100 : 0 };
    });
    return { windows, stages };
  }

  function cleanCandles(inputCandles) {
    return inputCandles
      .filter((candle) => [candle.t, candle.o, candle.h, candle.l, candle.c].every(Number.isFinite))
      .sort((left, right) => left.t - right.t);
  }

  function runRsiBacktest(inputCandles, userOptions = {}) {
    const candles = cleanCandles(inputCandles);
    if (candles.length < 200) throw new Error("至少需要200根M15收盘K线");
    const options = {
      initialCapital: 100000,
      feeRate: 0.0004,
      slippage: 0.5,
      analysisStart: candles[0].t,
      symbol: "XAUUSDT",
      strategyMode: "rsi-reversal",
      rsiPeriod: 14,
      rsiShortEntry: 75,
      rsiShortExit: 35,
      rsiLongEntry: 30,
      rsiLongExit: 60,
      rsiStopBuffer: 0.01,
      ...userOptions,
      maximumConcurrent: 1,
      maximumLeverage: 1
    };
    const rsi = rsiSeries(candles, options.rsiPeriod);
    const h1 = aggregateCandles(candles, 60);
    const h4 = aggregateCandles(candles, 240);
    const trades = [];
    const equityCurve = [];
    let cash = options.initialCapital;
    let position = null;

    const finishPosition = (bar, rawPrice, reason, timestamp = bar.t) => {
      const closed = position;
      cash += closePart(closed, rawPrice, closed.remaining, timestamp, reason, options);
      closed.closed = true;
      closed.closeAt = timestamp;
      closed.closePrice = closed.exits[closed.exits.length - 1].price;
      closed.exitReason = reason;
      const initialNotional = Math.abs(closed.entryPrice * closed.quantity);
      closed.returnPct = initialNotional ? closed.pnl / initialNotional * 100 : 0;
      closed.rMultiple = closed.riskAmount ? closed.pnl / closed.riskAmount : NaN;
      trades.push(closed);
      position = null;
    };

    for (let index = options.rsiPeriod + 2; index < candles.length; index += 1) {
      const bar = candles[index];
      const signalIndex = index - 1;
      const previousSignalIndex = index - 2;
      const signalRsi = rsi[signalIndex];
      const previousRsi = rsi[previousSignalIndex];
      let closedThisBar = false;

      if (position && Number.isFinite(signalRsi) && Number.isFinite(previousRsi)) {
        const exitLong = position.side === "long" && previousRsi < options.rsiLongExit && signalRsi >= options.rsiLongExit;
        const exitShort = position.side === "short" && previousRsi > options.rsiShortExit && signalRsi <= options.rsiShortExit;
        if (exitLong || exitShort) {
          finishPosition(bar, bar.o, exitLong ? `RSI≥${options.rsiLongExit}` : `RSI≤${options.rsiShortExit}`);
          closedThisBar = true;
        }
      }

      if (position && !closedThisBar) {
        const stopHit = position.side === "long" ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;
        if (stopHit) {
          const rawStopFill = position.side === "long"
            ? Math.min(position.stopPrice, bar.o)
            : Math.max(position.stopPrice, bar.o);
          finishPosition(bar, rawStopFill, "触发K线止损", bar.ct);
          closedThisBar = true;
        }
      }

      if (!position && !closedThisBar && bar.t >= options.analysisStart && Number.isFinite(signalRsi) && Number.isFinite(previousRsi)) {
        const signalCandle = candles[signalIndex];
        const shortSignal = previousRsi >= options.rsiShortEntry
          && signalRsi < previousRsi
          && signalCandle.c < signalCandle.o;
        const longSignal = previousRsi <= options.rsiLongEntry
          && signalRsi > previousRsi
          && signalCandle.c > signalCandle.o;
        const side = shortSignal ? "short" : longSignal ? "long" : null;
        if (side && cash > 0) {
          const rawEntry = bar.o;
          const entryPrice = priceWithSlippage(rawEntry, side, true, options.slippage);
          const stopPrice = side === "long"
            ? signalCandle.l - options.rsiStopBuffer
            : signalCandle.h + options.rsiStopBuffer;
          const invalidBeforeEntry = side === "long" ? rawEntry <= stopPrice : rawEntry >= stopPrice;
          if (!invalidBeforeEntry) {
            const quantity = cash / Math.max(Math.abs(entryPrice), Number.EPSILON);
            const entryFee = Math.abs(entryPrice * quantity) * options.feeRate;
            const entrySlippageCost = Math.abs(entryPrice - rawEntry) * quantity;
            const stopExecutionPrice = priceWithSlippage(stopPrice, side, false, options.slippage);
            const lossPerUnit = Math.abs(entryPrice - stopExecutionPrice)
              + Math.abs(entryPrice) * options.feeRate
              + Math.abs(stopExecutionPrice) * options.feeRate;
            cash -= entryFee;
            position = {
              id: `rsi-${side}-${bar.t}`,
              strategyMode: "rsi-reversal",
              symbol: options.symbol,
              side,
              signal: side === "short" ? `RSI≥${options.rsiShortEntry}后转弱` : `RSI≤${options.rsiLongEntry}后转强`,
              signalAt: signalCandle.ct,
              signalLow: signalCandle.l,
              signalHigh: signalCandle.h,
              zoneLabel: side === "short" ? "M15 RSI超买" : "M15 RSI超卖",
              zoneLow: NaN,
              zoneHigh: NaN,
              openAt: bar.t,
              entryIndex: index,
              entryPrice,
              quantity,
              remaining: quantity,
              initialStop: stopPrice,
              stopPrice,
              target1: NaN,
              target2: NaN,
              target1Label: side === "short" ? `RSI≤${options.rsiShortExit}` : `RSI≥${options.rsiLongExit}`,
              target2Label: "—",
              target1Hit: false,
              riskAmount: quantity * lossPerUnit,
              rsi: signalRsi,
              previousRsi,
              rsiNote: `RSI ${previousRsi.toFixed(2)}→${signalRsi.toFixed(2)} · ${side === "short" ? "收阴" : "收阳"}`,
              pnl: -entryFee,
              commission: entryFee,
              slippageCost: entrySlippageCost,
              exits: [],
              closed: false
            };
            const sameBarStopHit = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
            if (sameBarStopHit) finishPosition(bar, stopPrice, "触发K线止损", bar.ct);
          }
        }
      }

      if (bar.t >= options.analysisStart) {
        const unrealized = position ? (bar.c - position.entryPrice) * position.remaining * directionValue(position.side) : 0;
        equityCurve.push({ time: bar.ct, equity: cash + unrealized, price: bar.c });
      }
    }

    const finalBar = candles[candles.length - 1];
    if (position) finishPosition(finalBar, finalBar.c, "区间结束", finalBar.ct);
    const finalEquity = cash;
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = finalEquity;
    trades.sort((left, right) => left.closeAt - right.closeAt);
    const summary = summarize(trades, equityCurve, options.initialCapital, finalEquity);
    const rolling = rollingWindows(trades, candles, options.analysisStart, options.initialCapital);
    return {
      options,
      summary,
      trades,
      equityCurve,
      groups: groupedPerformance(trades, options.initialCapital),
      windows: rolling.windows,
      stages: rolling.stages,
      data: { m15: candles.length, h1: h1.length, h4: h4.length, zones: 0, strongZones: 0, start: options.analysisStart, end: finalBar.ct }
    };
  }

  function runBacktest(inputCandles, userOptions = {}) {
    if (userOptions.strategyMode === "rsi-reversal") return runRsiBacktest(inputCandles, userOptions);
    const candles = cleanCandles(inputCandles);
    if (candles.length < 200) throw new Error("至少需要200根M15收盘K线");
    const options = {
      initialCapital: 100000,
      riskPct: 1,
      feeRate: 0.0004,
      slippage: 0.5,
      firstTargetR: 1,
      secondTargetR: 2,
      firstExitShare: 0.5,
      minimumTouches: 2,
      zoneWidthPct: 0.0012,
      maxZoneAgeDays: 90,
      cooldownBars: 8,
      zoneBreakBuffer: 0.25,
      zoneRearmDistance: 0.5,
      maximumConcurrent: 2,
      maximumPortfolioRiskPct: 2,
      maximumLeverage: 4,
      useRsi: true,
      enabled: { longWick: true, engulfing: true, reclaim: true },
      analysisStart: candles[0].t,
      ...userOptions,
      enabled: { longWick: true, engulfing: true, reclaim: true, ...(userOptions.enabled || {}) }
    };
    const h1 = aggregateCandles(candles, 60);
    const h4 = aggregateCandles(candles, 240);
    const events = [...pivotEvents(h1, "H1"), ...pivotEvents(h4, "H4")].sort((a, b) => a.confirmedAt - b.confirmedAt);
    const rsi = rsiSeries(candles);
    const clusters = [];
    const open = [];
    const trades = [];
    const lastEntryByZone = new Map();
    const equityCurve = [];
    let eventIndex = 0;
    let cash = options.initialCapital;

    const finishPosition = (position, bar, rawPrice, reason) => {
      const delta = closePart(position, rawPrice, position.remaining, bar.ct, reason, options);
      cash += delta;
      position.closed = true;
      position.closeAt = bar.ct;
      position.closePrice = position.exits[position.exits.length - 1].price;
      position.exitReason = reason;
      position.rMultiple = position.riskAmount ? position.pnl / position.riskAmount : 0;
      trades.push(position);
    };

    for (let index = 1; index < candles.length; index += 1) {
      const bar = candles[index];
      while (eventIndex < events.length && events[eventIndex].confirmedAt <= bar.t) {
        addPivotToClusters(clusters, events[eventIndex], options.zoneWidthPct);
        eventIndex += 1;
      }
      updateZoneLifecycle(clusters, bar, options);

      for (let positionIndex = open.length - 1; positionIndex >= 0; positionIndex -= 1) {
        const position = open[positionIndex];
        if (index <= position.entryIndex) continue;
        const stopHit = position.side === "long" ? bar.l <= position.stopPrice : bar.h >= position.stopPrice;
        if (stopHit) {
          finishPosition(position, bar, position.stopPrice, position.target1Hit ? "保本/止损" : "止损");
          open.splice(positionIndex, 1);
          continue;
        }
        const target2Hit = position.side === "long" ? bar.h >= position.target2 : bar.l <= position.target2;
        const target1Hit = position.side === "long" ? bar.h >= position.target1 : bar.l <= position.target1;
        if (!position.target1Hit && target1Hit) {
          const quantity = Math.min(position.remaining, position.quantity * options.firstExitShare);
          cash += closePart(position, position.target1, quantity, bar.ct, "第一目标", options);
          position.target1Hit = true;
          const breakEven = breakEvenRawStop(position, options);
          position.stopPrice = position.side === "long"
            ? Math.max(position.stopPrice, breakEven)
            : Math.min(position.stopPrice, breakEven);
        }
        if (target2Hit && position.remaining > 0) {
          finishPosition(position, bar, position.target2, "第二目标");
          open.splice(positionIndex, 1);
        }
      }

      if (bar.t >= options.analysisStart && open.length < options.maximumConcurrent) {
        const candidates = [
          { side: "long", zone: findActiveZone(clusters, "support", bar, bar.t, options) },
          { side: "short", zone: findActiveZone(clusters, "resistance", bar, bar.t, options) }
        ].filter((candidate) => candidate.zone);
        const qualified = candidates.map((candidate) => ({
          ...candidate,
          signal: reversalSignal(candidate.side, bar, candles[index - 1], candidate.zone, options.enabled)
        })).filter((candidate) => candidate.signal)
          .filter((candidate) => !open.some((position) => position.zoneId === candidate.zone.id))
          .filter((candidate) => index - (lastEntryByZone.get(candidate.zone.id) ?? -Infinity) >= options.cooldownBars)
          .sort((left, right) => right.zone.weight - left.zone.weight)[0];

        if (qualified) {
          const side = qualified.side;
          const rawEntry = bar.c;
          const entryPrice = priceWithSlippage(rawEntry, side, true, options.slippage);
          const structuralBuffer = Math.max(Math.abs(entryPrice) * 0.0005, 0.01);
          const stopPrice = side === "long"
            ? Math.min(qualified.zone.low, bar.l) - structuralBuffer
            : Math.max(qualified.zone.high, bar.h) + structuralBuffer;
          const riskDistance = Math.abs(entryPrice - stopPrice);
          const markedEquity = cash + open.reduce((sum, position) => sum + (bar.c - position.entryPrice) * position.remaining * directionValue(position.side), 0);
          const committedRisk = open.reduce((sum, position) => sum + Math.max(0, -projectedPnlAtStop(position, position.stopPrice, options)), 0);
          const availableRisk = Math.max(0, markedEquity * options.maximumPortfolioRiskPct / 100 - committedRisk);
          const riskBudget = Math.min(Math.max(markedEquity, 0) * options.riskPct / 100, availableRisk);
          const stopExecutionPrice = priceWithSlippage(stopPrice, side, false, options.slippage);
          const lossPerUnit = Math.abs(entryPrice - stopExecutionPrice)
            + Math.abs(entryPrice) * options.feeRate
            + Math.abs(stopExecutionPrice) * options.feeRate;
          const desiredQuantity = lossPerUnit > 0 ? riskBudget / lossPerUnit : 0;
          const openNotional = open.reduce((sum, position) => sum + Math.abs(bar.c * position.remaining), 0);
          const availableNotional = Math.max(0, markedEquity * options.maximumLeverage - openNotional);
          const quantity = Math.min(desiredQuantity, availableNotional / Math.max(Math.abs(entryPrice), Number.EPSILON));
          if (quantity > 0 && Number.isFinite(quantity)) {
            const direction = directionValue(side);
            const target1 = entryPrice + direction * riskDistance * options.firstTargetR;
            const target2 = entryPrice + direction * riskDistance * options.secondTargetR;
            const entryFee = Math.abs(entryPrice * quantity) * options.feeRate;
            const entrySlippageCost = Math.abs(entryPrice - rawEntry) * quantity;
            const plannedRisk = quantity * lossPerUnit;
            cash -= entryFee;
            const rsiValue = rsi[index];
            const position = {
              id: `${side}-${bar.t}-${qualified.zone.id}`,
              zoneId: qualified.zone.id,
              symbol: options.symbol || "XAUUSDT",
              side,
              signal: qualified.signal,
              zoneLabel: `${[...qualified.zone.timeframes].sort().join("/")} ${qualified.zone.kind === "support" ? "支撑" : "压力"}`,
              zoneLow: qualified.zone.low,
              zoneHigh: qualified.zone.high,
              openAt: bar.ct,
              entryIndex: index,
              entryPrice,
              quantity,
              remaining: quantity,
              initialStop: stopPrice,
              stopPrice,
              target1,
              target2,
              target1Hit: false,
              riskAmount: plannedRisk,
              rsi: rsiValue,
              rsiNote: options.useRsi && Number.isFinite(rsiValue) ? rsiValue >= 70 ? "RSI超买" : rsiValue <= 30 ? "RSI超卖" : "RSI中性" : "RSI未启用",
              pnl: -entryFee,
              commission: entryFee,
              slippageCost: entrySlippageCost,
              exits: [],
              closed: false
            };
            open.push(position);
            qualified.zone.armed = false;
            qualified.zone.lastTriggeredAt = bar.ct;
            lastEntryByZone.set(qualified.zone.id, index);
          }
        }
      }

      if (bar.t >= options.analysisStart) {
        const markedEquity = cash + open.reduce((sum, position) => sum + (bar.c - position.entryPrice) * position.remaining * directionValue(position.side), 0);
        equityCurve.push({ time: bar.ct, equity: markedEquity, price: bar.c });
      }
    }

    const finalBar = candles[candles.length - 1];
    for (const position of [...open]) finishPosition(position, finalBar, finalBar.c, "区间结束");
    const finalEquity = cash;
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = finalEquity;
    trades.sort((a, b) => a.closeAt - b.closeAt);
    const summary = summarize(trades, equityCurve, options.initialCapital, finalEquity);
    const rolling = rollingWindows(trades, candles, options.analysisStart, options.initialCapital);
    return {
      options,
      summary,
      trades,
      equityCurve,
      groups: groupedPerformance(trades, options.initialCapital),
      windows: rolling.windows,
      stages: rolling.stages,
      data: {
        m15: candles.length,
        h1: h1.length,
        h4: h4.length,
        zones: clusters.length,
        strongZones: clusters.filter((zone) => zone.active && isStrongZone(zone)).length,
        start: options.analysisStart,
        end: finalBar.ct
      }
    };
  }

  return { aggregateCandles, pivotEvents, rsiSeries, reversalSignal, isStrongZone, runRsiBacktest, runBacktest, clamp };
});
