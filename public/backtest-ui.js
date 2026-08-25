(function () {
  "use strict";

  const engine = window.BacktestEngine;
  if (!engine) return;

  const DAY = 86_400_000;
  const M15 = 900_000;
  const DB_NAME = "minimaomao-backtest-cache";
  const STORE_NAME = "datasets";
  const SETTINGS_KEY = "minimaomao-backtest-settings-v1";
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const apiRoot = isLocal ? "https://fapi.binance.com" : `${location.origin}/api/binance`;
  const byId = (id) => document.getElementById(id);
  const nodes = {
    form: byId("backtest-form"), run: byId("backtest-run"), save: byId("backtest-save-settings"),
    progress: byId("backtest-progress"), chart: byId("backtest-equity-chart"), trades: byId("backtest-trades-body"),
    main: byId("backtest-main-screen"), detail: byId("backtest-detail-screen"), openDetails: byId("backtest-open-details"),
    detailMetrics: byId("backtest-detail-metrics"), rolling: byId("backtest-rolling-chart"), stages: byId("backtest-stage-list"),
    drawdowns: byId("backtest-drawdown-list"), groups: byId("backtest-groups-body"), review: byId("backtest-review-content")
  };
  let currentResult = null;
  let reviewIndex = 0;
  let activeController = null;

  function openDatabase() {
    if (!window.indexedDB) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "symbol" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  async function readCache(symbol) {
    const db = await openDatabase();
    if (!db) return null;
    return new Promise((resolve) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(symbol);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async function writeCache(symbol, candles, coveredStart) {
    const db = await openDatabase();
    if (!db) return;
    const cutoff = Date.now() - 400 * DAY;
    const compact = candles.filter((candle) => candle.t >= cutoff);
    await new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ symbol, savedAt: Date.now(), coveredStart, candles: compact });
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
    });
  }

  function setProgress(message, visible = true) {
    if (!nodes.progress) return;
    nodes.progress.hidden = !visible;
    const text = nodes.progress.querySelector("span");
    if (text) text.textContent = message;
  }

  function normalizeKline(row) {
    return { t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) || 0, ct: Number(row[6]) };
  }

  function mergeCandles(left, right, start) {
    const map = new Map();
    for (const candle of [...left, ...right]) if (candle.t >= start && candle.ct < Date.now()) map.set(candle.t, candle);
    return [...map.values()].sort((a, b) => a.t - b.t);
  }

  async function fetchPage(symbol, startTime, endTime, signal) {
    const query = new URLSearchParams({ symbol, interval: "15m", limit: "1000", startTime: String(startTime), endTime: String(endTime) });
    const response = await fetch(`${apiRoot}/fapi/v1/klines?${query}`, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`历史行情请求失败（${response.status}）`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("历史行情格式异常");
    return payload.map(normalizeKline).filter((candle) => [candle.t, candle.o, candle.h, candle.l, candle.c, candle.ct].every(Number.isFinite));
  }

  async function loadCandles(symbol, days, signal) {
    const end = Date.now();
    const start = end - (days + 35) * DAY;
    const cache = await readCache(symbol);
    let candles = cache && Array.isArray(cache.candles) ? cache.candles : [];
    const cacheCoversStart = candles.length && Number(cache.coveredStart ?? candles[0].t) <= start + M15;
    if (!cacheCoversStart) candles = [];
    let cursor = candles.length ? Math.max(start, candles[candles.length - 1].t + M15) : start;
    const isFresh = candles.length && candles[candles.length - 1].ct >= end - 30 * 60_000;
    if (cacheCoversStart && isFresh) {
      setProgress(`使用本地缓存 · ${candles.length.toLocaleString()} 根M15 K线`);
      return candles.filter((candle) => candle.t >= start);
    }
    const downloaded = [];
    let page = 0;
    while (cursor < end && page < 48) {
      page += 1;
      setProgress(`同步历史行情 · 第 ${page} 批 · 已读取 ${(candles.length + downloaded.length).toLocaleString()} 根`);
      const rows = await fetchPage(symbol, cursor, end, signal);
      if (!rows.length) break;
      downloaded.push(...rows);
      const next = rows[rows.length - 1].t + M15;
      if (next <= cursor) break;
      cursor = next;
      if (rows.length < 1000) break;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    candles = mergeCandles(candles, downloaded, start);
    if (candles.length < 200) throw new Error("可用M15历史K线不足，无法回测");
    await writeCache(symbol, candles, start);
    return candles;
  }

  function number(id, fallback) {
    const value = Number(byId(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function readSettings() {
    return {
      symbol: byId("backtest-symbol").value,
      days: number("backtest-days", 180), capital: number("backtest-capital", 100000), risk: number("backtest-risk", 1),
      fee: number("backtest-fee", 0.04), slippage: number("backtest-slippage", 0.5), targetOne: number("backtest-target-one", 1),
      targetTwo: number("backtest-target-two", 2), split: number("backtest-split", 0.5), useRsi: byId("backtest-rsi").checked,
      longWick: byId("backtest-long-wick").checked, engulfing: byId("backtest-engulfing").checked, reclaim: byId("backtest-reclaim").checked
    };
  }

  function validateSettings(settings) {
    if (![settings.longWick, settings.engulfing, settings.reclaim].some(Boolean)) throw new Error("至少启用一种M15反转形态");
    if (settings.targetTwo <= settings.targetOne) throw new Error("第二目标必须高于第一目标");
    if (settings.capital <= 0 || settings.risk <= 0 || settings.risk > 5) throw new Error("请检查初始资金和单笔风险");
  }

  function saveSettings(showMessage = true) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
    if (showMessage) setProgress("方案已保存在本机浏览器", true), setTimeout(() => setProgress("", false), 900);
  }

  function restoreSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!settings) return;
      const mapping = { symbol: "backtest-symbol", days: "backtest-days", capital: "backtest-capital", risk: "backtest-risk", fee: "backtest-fee", slippage: "backtest-slippage", targetOne: "backtest-target-one", targetTwo: "backtest-target-two", split: "backtest-split" };
      for (const [key, id] of Object.entries(mapping)) if (settings[key] !== undefined && byId(id)) byId(id).value = settings[key];
      for (const [key, id] of [["useRsi", "backtest-rsi"], ["longWick", "backtest-long-wick"], ["engulfing", "backtest-engulfing"], ["reclaim", "backtest-reclaim"]]) if (settings[key] !== undefined) byId(id).checked = settings[key];
    } catch (_) {}
  }

  const formatPct = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
  const formatMoney = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` : "—";
  const formatPrice = (value) => Number.isFinite(value) ? value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const formatPF = (value) => value === Infinity ? "∞" : Number.isFinite(value) ? value.toFixed(3) : "—";
  const formatTime = (value, withDate = true) => new Intl.DateTimeFormat("zh-CN", { month: withDate ? "2-digit" : undefined, day: withDate ? "2-digit" : undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  function formatDuration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    return minutes >= 1440 ? `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时` : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
  }

  function tone(element, value) {
    if (!element) return;
    element.classList.toggle("positive", value > 0);
    element.classList.toggle("negative", value < 0);
  }

  function downsample(points, maximum = 260) {
    if (points.length <= maximum) return points;
    const output = [];
    const step = (points.length - 1) / (maximum - 1);
    for (let index = 0; index < maximum; index += 1) output.push(points[Math.round(index * step)]);
    return output;
  }

  function pathFor(points, x, y) {
    return points.map((point, index) => `${index ? "L" : "M"}${x(point, index).toFixed(1)},${y(point).toFixed(1)}`).join(" ");
  }

  function drawEquity(result) {
    const svg = nodes.chart;
    const points = downsample(result.equityCurve);
    if (!points.length) return;
    const values = points.map((point) => point.equity);
    const prices = points.map((point) => point.price);
    const min = Math.min(...values, result.options.initialCapital) * 0.997;
    const max = Math.max(...values, result.options.initialCapital) * 1.003;
    const x = (_, index) => 58 + index / Math.max(1, points.length - 1) * 876;
    const y = (point) => 278 - (point.equity - min) / Math.max(1, max - min) * 238;
    const benchmark = points.map((point, index) => ({ ...point, equity: result.options.initialCapital * (prices[index] / prices[0]) }));
    const by = (point) => 278 - (point.equity - min) / Math.max(1, max - min) * 238;
    let peak = -Infinity;
    const draw = points.map((point) => { peak = Math.max(peak, point.equity); return { ...point, equity: point.equity / peak - 1 }; });
    const worst = Math.min(-0.0001, ...draw.map((point) => point.equity));
    const dy = (point) => 318 - point.equity / worst * 28;
    const grid = [0, 1, 2, 3, 4].map((step) => `<line x1="58" y1="${40 + step * 59.5}" x2="934" y2="${40 + step * 59.5}"/>`).join("");
    svg.innerHTML = `<g class="backtest-grid">${grid}</g><path class="backtest-dd-area" d="${pathFor(draw, x, dy)} L934,318 L58,318 Z"/><path class="backtest-benchmark-line" d="${pathFor(benchmark, x, by)}"/><path class="backtest-strategy-line" d="${pathFor(points, x, y)}"/><g class="backtest-axis"><text x="4" y="45">${formatMoney(max)}</text><text x="4" y="282">${formatMoney(min)}</text><text x="58" y="326">${formatTime(points[0].time)}</text><text x="850" y="326">${formatTime(points[points.length - 1].time)}</text></g>`;
  }

  function renderMetrics(result) {
    const summary = result.summary;
    const metrics = [["backtest-net-return", summary.netReturn, formatPct], ["backtest-max-drawdown", summary.maximumDrawdown, formatPct], ["backtest-trade-count", summary.tradeCount, (value) => `${value}笔`], ["backtest-win-rate", summary.winRate, (value) => `${value.toFixed(2)}%`], ["backtest-profit-factor", summary.profitFactor, formatPF]];
    for (const [id, value, formatter] of metrics) { const node = byId(id); node.textContent = formatter(value); if (["backtest-net-return", "backtest-max-drawdown"].includes(id)) tone(node, value); }
    byId("backtest-data-summary").textContent = `${result.data.m15.toLocaleString()}根M15 · H1 ${result.data.h1.toLocaleString()} · H4 ${result.data.h4.toLocaleString()} · 北京时间`;
    const long = result.groups.find((group) => group.label === "支撑位做多");
    const short = result.groups.find((group) => group.label === "压力位做空");
    const range = result.stages.find((stage) => stage.label === "震荡阶段");
    byId("backtest-long-stats").textContent = `${long.count}笔 · ${formatPct(long.netReturn)}`;
    byId("backtest-short-stats").textContent = `${short.count}笔 · ${formatPct(short.netReturn)}`;
    byId("backtest-range-stats").textContent = range ? `${range.profitablePct.toFixed(0)}%窗口盈利` : "样本不足";
  }

  function tradeRow(trade) {
    const result = trade.pnl > 0 ? "盈利" : trade.pnl < 0 ? "亏损" : "持平";
    return `<tr><td>${formatTime(trade.openAt)}</td><td class="${trade.side === "long" ? "positive" : "negative"}">${trade.side === "long" ? "做多" : "做空"}</td><td>${trade.zoneLabel}<small>${formatPrice(trade.zoneLow)}–${formatPrice(trade.zoneHigh)}</small></td><td>${formatPrice(trade.entryPrice)}</td><td>${formatPrice(trade.initialStop)}</td><td>${formatPrice(trade.target1)}</td><td>${formatPrice(trade.target2)}</td><td class="${trade.pnl > 0 ? "positive" : trade.pnl < 0 ? "negative" : ""}">${result}<small>${formatMoney(trade.pnl)} · ${trade.rMultiple.toFixed(2)}R</small></td><td>${formatDuration(trade.closeAt - trade.openAt)}</td><td>${trade.signal}<small>${trade.rsiNote}</small></td></tr>`;
  }

  function renderTrades(result) {
    nodes.trades.innerHTML = result.trades.length ? result.trades.slice().reverse().slice(0, 10).map(tradeRow).join("") : `<tr class="empty-row"><td colspan="10">该参数组合没有触发交易，请先检查区域与形态条件，不要为增加笔数盲目放宽。</td></tr>`;
  }

  function computeDrawdowns(result) {
    let peak = result.options.initialCapital;
    let active = null;
    const periods = [];
    for (const point of result.equityCurve) {
      if (point.equity >= peak) {
        peak = point.equity;
        if (active) periods.push({ ...active, end: point.time });
        active = null;
      } else {
        const depth = (point.equity / peak - 1) * 100;
        if (!active) active = { start: point.time, end: point.time, depth };
        if (depth < active.depth) active.depth = depth, active.end = point.time;
      }
    }
    if (active) periods.push(active);
    return periods.sort((a, b) => a.depth - b.depth).slice(0, 3);
  }

  function drawRolling(result) {
    const svg = nodes.rolling;
    const points = downsample(result.windows, 120);
    if (!points.length) { svg.innerHTML = `<text x="30" y="60" fill="#7890a0">不足30天，暂无滚动窗口</text>`; return; }
    const maximum = Math.max(1, ...points.map((point) => Math.abs(point.returnPct)));
    const x = (_, index) => 45 + index / Math.max(1, points.length - 1) * 842;
    const y = (point) => 150 - point.returnPct / maximum * 105;
    const bars = points.map((point, index) => `<rect x="${x(point, index) - 2}" y="${Math.min(150, y(point))}" width="4" height="${Math.max(1, Math.abs(y(point) - 150))}" class="${point.returnPct >= 0 ? "positive" : "negative"}"/>`).join("");
    svg.innerHTML = `<g class="backtest-grid"><line x1="45" y1="45" x2="887" y2="45"/><line x1="45" y1="150" x2="887" y2="150"/><line x1="45" y1="255" x2="887" y2="255"/></g>${bars}<path class="backtest-rolling-line" d="${pathFor(points, x, y)}"/><g class="backtest-axis"><text x="5" y="49">+${maximum.toFixed(1)}%</text><text x="15" y="154">0%</text><text x="5" y="259">-${maximum.toFixed(1)}%</text><text x="45" y="294">${formatTime(points[0].start)}</text><text x="805" y="294">${formatTime(points[points.length - 1].finish)}</text></g>`;
  }

  function renderReview() {
    const trades = currentResult?.trades || [];
    if (!trades.length) { nodes.review.innerHTML = `<div class="empty-row">暂无交易可复核。</div>`; return; }
    reviewIndex = Math.max(0, Math.min(reviewIndex, trades.length - 1));
    const trade = trades[reviewIndex];
    byId("backtest-review-count").textContent = `第 ${reviewIndex + 1} / ${trades.length} 笔`;
    const steps = [
      ["区域确认", formatPrice((trade.zoneLow + trade.zoneHigh) / 2)], ["M15触发", trade.signal], ["进场", formatPrice(trade.entryPrice)],
      ["第一目标", trade.target1Hit ? formatPrice(trade.target1) : "未到达"], ["第二目标", trade.exitReason], ["平仓", formatPrice(trade.closePrice)]
    ];
    nodes.review.innerHTML = `<div class="backtest-review-layout"><div class="backtest-review-timeline">${steps.map(([label, value], index) => `<div class="backtest-review-step"><span>${label}</span><b>${index + 1}</b><em>${value}</em><small>${index === 0 ? formatTime(trade.openAt) : ""}</small></div>`).join("")}</div><div class="backtest-review-metrics"><div><span>方向</span><b>${trade.side === "long" ? "做多" : "做空"}</b></div><div><span>结果</span><b class="${trade.pnl >= 0 ? "positive" : "negative"}">${formatMoney(trade.pnl)}</b></div><div><span>R倍数</span><b>${trade.rMultiple.toFixed(2)}R</b></div><div><span>持仓</span><b>${formatDuration(trade.closeAt - trade.openAt)}</b></div></div><div class="backtest-review-note">依据：${trade.zoneLabel}重复触碰区域内出现${trade.signal}；${trade.rsiNote}。止损设在确认结构外侧，分批目标为${currentResult.options.firstTargetR}R / ${currentResult.options.secondTargetR}R。</div></div>`;
  }

  function renderDetails(result) {
    const summary = result.summary;
    nodes.detailMetrics.innerHTML = [["净收益", formatPct(summary.netReturn)], ["最大回撤", formatPct(summary.maximumDrawdown)], ["交易", `${summary.tradeCount}笔`], ["胜率", `${summary.winRate.toFixed(2)}%`], ["利润因子", formatPF(summary.profitFactor)], ["平均持仓", formatDuration(summary.averageHoldMs)]].map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join("");
    drawRolling(result);
    nodes.stages.innerHTML = result.stages.map((stage) => `<div><span>${stage.label} · ${stage.count}个窗口</span><b>${stage.count ? `${stage.profitablePct.toFixed(1)}%盈利` : "样本不足"}</b></div>`).join("");
    const drawdowns = computeDrawdowns(result);
    nodes.drawdowns.innerHTML = drawdowns.length ? drawdowns.map((item) => `<div><span>${formatTime(item.start)} – ${formatTime(item.end)}</span><b class="negative">${item.depth.toFixed(2)}%</b></div>`).join("") : `<div><span>无显著回撤</span><b>—</b></div>`;
    nodes.groups.innerHTML = result.groups.map((group) => `<tr><td>${group.label}</td><td>${group.count}</td><td>${group.winRate.toFixed(2)}%</td><td class="${group.netReturn >= 0 ? "positive" : "negative"}">${formatPct(group.netReturn)}</td><td>${formatPF(group.profitFactor)}</td></tr>`).join("");
    renderReview();
  }

  function renderResult(result) {
    currentResult = result;
    renderMetrics(result); drawEquity(result); renderTrades(result); renderDetails(result);
    nodes.openDetails.disabled = false;
  }

  function engineOptions(settings) {
    return { symbol: settings.symbol, initialCapital: settings.capital, riskPct: settings.risk, feeRate: settings.fee / 100, slippage: settings.slippage, firstTargetR: settings.targetOne, secondTargetR: settings.targetTwo, firstExitShare: settings.split, useRsi: settings.useRsi, enabled: { longWick: settings.longWick, engulfing: settings.engulfing, reclaim: settings.reclaim }, analysisStart: Date.now() - settings.days * DAY };
  }

  async function runWithCandles(candles, suppliedSettings) {
    const settings = { ...readSettings(), ...(suppliedSettings || {}) };
    validateSettings(settings);
    setProgress("本地计算H1/H4区域与M15反转信号…");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = engine.runBacktest(candles, engineOptions(settings));
    renderResult(result);
    setProgress("", false);
    return result;
  }

  async function run() {
    const settings = readSettings();
    try {
      validateSettings(settings);
      if (activeController) activeController.abort();
      activeController = new AbortController();
      nodes.run.disabled = true;
      saveSettings(false);
      setProgress("检查本地历史数据缓存…");
      const candles = await loadCandles(settings.symbol, settings.days, activeController.signal);
      await runWithCandles(candles, settings);
    } catch (error) {
      if (error.name !== "AbortError") setProgress(error.message || "回测失败", true);
    } finally {
      nodes.run.disabled = false;
    }
  }

  function exportCsv() {
    if (!currentResult) return;
    const header = ["时间", "方向", "区域", "进场价", "止损", "第一目标", "第二目标", "平仓价", "盈亏", "R倍数", "持仓分钟", "形态"];
    const rows = currentResult.trades.map((trade) => [new Date(trade.openAt).toISOString(), trade.side, trade.zoneLabel, trade.entryPrice, trade.initialStop, trade.target1, trade.target2, trade.closePrice, trade.pnl, trade.rMultiple, Math.round((trade.closeAt - trade.openAt) / 60_000), trade.signal]);
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    link.download = `${currentResult.options.symbol || "backtest"}-backtest-${Date.now()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 500);
  }

  nodes.form?.addEventListener("submit", (event) => event.preventDefault());
  nodes.run?.addEventListener("click", run);
  nodes.save?.addEventListener("click", () => saveSettings(true));
  nodes.openDetails?.addEventListener("click", () => { nodes.main.hidden = true; nodes.detail.hidden = false; window.scrollTo({ top: 0, behavior: "smooth" }); });
  byId("backtest-back-main")?.addEventListener("click", () => { nodes.detail.hidden = true; nodes.main.hidden = false; window.scrollTo({ top: 0, behavior: "smooth" }); });
  byId("backtest-export")?.addEventListener("click", exportCsv);
  byId("backtest-review-prev")?.addEventListener("click", () => { reviewIndex -= 1; renderReview(); });
  byId("backtest-review-next")?.addEventListener("click", () => { reviewIndex += 1; renderReview(); });
  byId("backtest-days")?.addEventListener("change", () => { const days = number("backtest-days", 180); byId("backtest-memory-estimate").textContent = days <= 90 ? "120 MB以内" : days <= 180 ? "220 MB以内" : "380 MB以内"; });

  restoreSettings();
  window.backtestApp = { run, runWithCandles, getResult: () => currentResult, loadCandles };
})();
