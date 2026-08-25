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
      if (cluster.kind === event.kind && currentDistance <= Math.max(tolerance, cluster.tolerance) && currentDistance < distance) {
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
        weight,
        lastEventAt: event.pivotAt,
        timeframes: new Set([event.timeframe])
      });
      return;
    }
    match.center = (match.center * match.weight + event.price * weight) / (match.weight + weight);
    match.weight += weight;
    match.touches += 1;
    match.tolerance = Math.max(match.tolerance, tolerance);
    match.low = match.center - match.tolerance;
    match.high = match.center + match.tolerance;
    match.lastEventAt = Math.max(match.lastEventAt, event.pivotAt);
    match.timeframes.add(event.timeframe);
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
    if (enabled.reclaim && reclaim) return "假突破收回";
    if (enabled.engulfing && engulfing) return "M15吞没";
    if (enabled.longWick && longWick) return "M15长影线";
    return null;
  }

  function findActiveZone(clusters, kind, candle, timestamp, options) {
    const maximumAge = options.maxZoneAgeDays * DAY;
    return clusters
      .filter((zone) => zone.kind === kind && zone.touches >= options.minimumTouches)
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
    position.pnl += gross - fee;
    position.remaining -= quantity;
    position.exits.push({ time: timestamp, price: exitPrice, quantity, reason });
    return gross - fee;
  }

  function summarize(trades, equityCurve, initialCapital, finalEquity) {
    const wins = trades.filter((trade) => trade.pnl > 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    let peak = initialCapital;
    let maximumDrawdown = 0;
    for (const point of equityCurve) {
      peak = Math.max(peak, point.equity);
      maximumDrawdown = Math.min(maximumDrawdown, peak > 0 ? (point.equity / peak - 1) * 100 : 0);
    }
    return {
      initialCapital,
      finalEquity,
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

  function runBacktest(inputCandles, userOptions = {}) {
    const candles = inputCandles.filter((candle) => [candle.t, candle.o, candle.h, candle.l, candle.c].every(Number.isFinite)).sort((a, b) => a.t - b.t);
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
      maximumConcurrent: 4,
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
          position.stopPrice = position.entryPrice;
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
          const riskAmount = Math.max(cash, 0) * options.riskPct / 100;
          const quantity = riskDistance > 0 ? riskAmount / riskDistance : 0;
          if (quantity > 0 && Number.isFinite(quantity)) {
            const direction = directionValue(side);
            const target1 = entryPrice + direction * riskDistance * options.firstTargetR;
            const target2 = entryPrice + direction * riskDistance * options.secondTargetR;
            const entryFee = Math.abs(entryPrice * quantity) * options.feeRate;
            cash -= entryFee;
            const rsiValue = rsi[index];
            const position = {
              id: `${side}-${bar.t}-${qualified.zone.id}`,
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
              riskAmount,
              rsi: rsiValue,
              rsiNote: options.useRsi && Number.isFinite(rsiValue) ? rsiValue >= 70 ? "RSI超买" : rsiValue <= 30 ? "RSI超卖" : "RSI中性" : "RSI未启用",
              pnl: -entryFee,
              exits: [],
              closed: false
            };
            open.push(position);
            lastEntryByZone.set(qualified.zone.id, index);
          }
        }
      }

      const markedEquity = cash + open.reduce((sum, position) => sum + (bar.c - position.entryPrice) * position.remaining * directionValue(position.side), 0);
      equityCurve.push({ time: bar.ct, equity: markedEquity, price: bar.c });
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
      data: { m15: candles.length, h1: h1.length, h4: h4.length, start: options.analysisStart, end: finalBar.ct }
    };
  }

  return { aggregateCandles, pivotEvents, rsiSeries, reversalSignal, runBacktest, clamp };
});
