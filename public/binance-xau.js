(() => {
  const REST = "https://fapi.binance.com";
  const DAY = 24 * 60 * 60 * 1000;
  const CACHE_DB = "binance-multi-asset-kline-cache";
  const CACHE_STORE = "datasets";
  const CACHE_VERSION = 1;
  const CACHE_MAX_AGE = 14 * DAY;
  const MAX_HISTORY_CANDLES = 10000;

  const SYMBOLS = {
    XAUUSDT: { label: "黄金", base: "XAU" },
    SNDKUSDT: { label: "SanDisk", base: "SNDK" },
    SKHYNIXUSDT: { label: "SK hynix", base: "SKHYNIX" }
  };

  const INTERVALS = {
    "5m": { label: "5分钟", short: "5分", ms: 5 * 60 * 1000 },
    "15m": { label: "15分钟", short: "15分", ms: 15 * 60 * 1000 },
    "1h": { label: "1小时", short: "1小时", ms: 60 * 60 * 1000 },
    "4h": { label: "4小时", short: "4小时", ms: 4 * 60 * 60 * 1000 },
    "1d": { label: "日线", short: "日线", ms: DAY }
  };

  const CHART_INTERVALS = ["5m", "15m", "1h", "4h", "1d"];
  const MIN_VISIBLE_CANDLES = 12;
  const MIN_TIMELINE_PERCENT = 0.1;
  const MAX_MINIMUM_GAP = 40;
  const WHEEL_ZOOM_SENSITIVITY = 0.0018;
  const TOOLTIP_HORIZONTAL_GAP = 64;
  const TOOLTIP_VERTICAL_GAP = 32;
  const TOOLTIP_EDGE_GAP = 12;
  const RANGE_EXPANSION_COOLDOWN = 800;
  const PAN_EXPANSION_THRESHOLD = 24;
  const MAX_RIGHT_BLANK_RATIO = 0.22;
  const STRATEGY_FILTERS = {
    estimatedRoundTripCostRate: 0.0014,
    intradayMinimumBaseScore: 50,
    intradayMinimumScoreEdge: 6,
    intradayMinimumRawRewardRiskA: 1.5,
    intradayMinimumRawRewardRiskB: 1.3,
    intradayMinimumCostAdjustedRewardRiskA: 1.15,
    intradayMinimumCostAdjustedRewardRiskB: 1,
    intradayMaximumCostToRisk: 0.45,
    positionMinimumBaseScore: 55,
    positionMinimumScoreEdge: 10,
    positionMinimumExecutionScore: 85
  };

  const RANGES = {
    "5d": { label: "5日", start: (end) => end - 5 * DAY },
    "1mo": {
      label: "1个月",
      start: (end) => {
        const date = new Date(end);
        date.setUTCMonth(date.getUTCMonth() - 1);
        return date.getTime();
      }
    },
    "3mo": {
      label: "3个月",
      start: (end) => {
        const date = new Date(end);
        date.setUTCMonth(date.getUTCMonth() - 3);
        return date.getTime();
      }
    },
    "6mo": {
      label: "6个月",
      start: (end) => {
        const date = new Date(end);
        date.setUTCMonth(date.getUTCMonth() - 6);
        return date.getTime();
      }
    },
    "1y": {
      label: "1年",
      start: (end) => {
        const date = new Date(end);
        date.setUTCFullYear(date.getUTCFullYear() - 1);
        return date.getTime();
      }
    },
    "all": {
      label: "全部",
      start: () => Date.UTC(2019, 0, 1)
    }
  };
  const RANGE_ORDER = ["5d", "1mo", "3mo", "6mo", "1y", "all"];

  const ANALYSIS_FRAMES = {
    d1: { label: "D1", interval: "1d", lookback: 120, hidden: true },
    h4: { label: "H4", interval: "4h", lookback: 45 },
    h1: { label: "H1", interval: "1h", lookback: 60 },
    m15: { label: "M15", interval: "15m", lookback: 80 }
  };

  const state = {
    symbol: "XAUUSDT",
    book: null,
    ticker: null,
    quoteAt: 0,
    wsOk: false,
    retryCount: 0,
    range: "1mo",
    interval: "1h",
    historyLimited: false,
    candles: [],
    timelineStart: 0,
    timelineEnd: 100,
    rightBlankRatio: 0,
    showMa20: true,
    showMa60: true,
    loadToken: 0,
    analysisLoadToken: 0,
    analysisFrames: {},
    analysisResults: {},
    directionStates: {},
    socket: null,
    socketGeneration: 0,
    reconnectTimer: null,
    rangeExpansionPending: false,
    lastRangeExpansionAt: 0
  };

  const $ = (id) => document.getElementById(id);
  let wheelRenderFrame = 0;
  let latestWheelPointer = null;
  let panRenderFrame = 0;
  let chartPanState = null;
  let resizeRenderFrame = 0;
  const priceFormat = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const analysisPriceFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  });
  const volumeFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    notation: "compact"
  });

  function currentSymbolConfig() {
    return SYMBOLS[state.symbol];
  }

  function openCacheDatabase() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open(CACHE_DB, CACHE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE)) {
          database.createObjectStore(CACHE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  async function readCandleCache(key) {
    try {
      const database = await openCacheDatabase();
      if (!database) return null;
      return await new Promise((resolve) => {
        const transaction = database.transaction(CACHE_STORE, "readonly");
        const request = transaction.objectStore(CACHE_STORE).get(key);
        request.onsuccess = () => {
          const record = request.result;
          const usable = record &&
            Date.now() - record.savedAt < CACHE_MAX_AGE &&
            Array.isArray(record.candles) &&
            record.candles.length > 1;
          resolve(usable ? record : null);
        };
        request.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
      });
    } catch (_) {
      return null;
    }
  }

  async function writeCandleCache(key, candles) {
    if (!Array.isArray(candles) || candles.length < 2) return;
    try {
      const database = await openCacheDatabase();
      if (!database) return;
      const transaction = database.transaction(CACHE_STORE, "readwrite");
      transaction.objectStore(CACHE_STORE).put({ key, savedAt: Date.now(), candles });
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => database.close();
    } catch (_) {}
  }

  function historyCacheKey(symbol, range, interval) {
    return `history:${symbol}:${range}:${interval}`;
  }

  function analysisCacheKey(symbol, interval) {
    return `analysis:${symbol}:${interval}`;
  }

  function formatTime(ts, withDate = false) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: withDate ? "2-digit" : undefined,
      day: withDate ? "2-digit" : undefined,
      hour: "2-digit",
      minute: "2-digit",
      second: withDate ? undefined : "2-digit",
      hour12: false
    }).format(new Date(ts));
  }

  function signed(value, digits = 2) {
    if (!Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
  }

  function setError(message = "") {
    const element = $("error-banner");
    element.textContent = message;
    element.classList.toggle("visible", Boolean(message));
  }

  function updateSymbolUI() {
    const config = currentSymbolConfig();
    document.title = `Binance ${state.symbol} 行情`;
    $("brand-subtitle").textContent = `${config.label} · ${state.symbol} · 实时报价、动态研判与K线`;
    $("market-symbol").textContent = `${state.symbol} · 买卖盘中间价`;
    $("chart-title").textContent = `${state.symbol} K线`;
    $("source-link").href = `https://www.binance.com/zh-CN/futures/${state.symbol}`;
    $("source-link").setAttribute("aria-label", `打开 Binance ${state.symbol}`);
    $("price-chart").setAttribute("aria-label", `Binance ${state.symbol} 价格K线图`);
    document.querySelectorAll("[data-symbol]").forEach((button) => {
      button.classList.toggle("active", button.dataset.symbol === state.symbol);
    });
  }

  function resetSymbolDataUI() {
    state.book = null;
    state.ticker = null;
    state.quoteAt = 0;
    state.wsOk = false;
    state.candles = [];
    state.historyLimited = false;
    state.analysisFrames = {};
    state.analysisResults = {};
    state.directionStates = {};
    state.timelineStart = 0;
    state.timelineEnd = 100;
    state.rightBlankRatio = 0;
    $("mid-price").textContent = "—";
    $("book-price").textContent = "等待买卖盘";
    $("quote-time").textContent = "等待报价";
    $("change-value").textContent = "—";
    $("change-value").classList.remove("positive", "negative");
    ["last-price", "day-high", "day-low", "day-volume"].forEach((id) => $(id).textContent = "—");
    $("analysis-status").textContent = "正在读取 D1、H4、H1、M15 已收盘K线…";
    for (const [key, config] of Object.entries(ANALYSIS_FRAMES)) {
      if (config.hidden) continue;
      $(`${key}-card`).dataset.bias = "neutral";
      $(`${key}-state`).textContent = "计算中";
      $(`${key}-direction-score`).textContent = "—";
      $(`${key}-setup-score`).textContent = "—";
      $(`${key}-confidence`).textContent = "—";
      $(`${key}-structure`).textContent = `等待${ANALYSIS_FRAMES[key].label} K线…`;
      [`${key}-opportunity`, `${key}-rsi`, `${key}-macd`, `${key}-volume`, `${key}-levels`].forEach((id) => $(id).textContent = "—");
      $(`${key}-conclusion`).textContent = "正在生成动态判断…";
    }
    renderIntradayStrategy({});
    renderPositionStrategy({});
    setError("");
    hideTooltip();
    setLiveStatus();
    syncTimelineInputs();
    renderChart();
  }

  function switchSymbol(symbol) {
    if (!SYMBOLS[symbol] || symbol === state.symbol) return;
    clearTimeout(state.reconnectTimer);
    state.symbol = symbol;
    updateSymbolUI();
    resetSymbolDataUI();
    connectBinance();
    seedCurrentData();
    loadHistory();
    loadAnalysis();
  }

  function setLiveStatus() {
    const fresh = state.quoteAt && Date.now() - state.quoteAt < 10000;
    $("live-state").classList.toggle("connected", state.wsOk || fresh);
    $("live-text").textContent = state.wsOk
      ? "实时行情已连接"
      : fresh
        ? "轮询行情已连接"
        : "行情连接中";
  }

  function updateQuoteUI() {
    if (state.book) {
      $("mid-price").textContent = priceFormat.format(state.book.mid);
      $("book-price").textContent = `买 ${priceFormat.format(state.book.bid)} · 卖 ${priceFormat.format(state.book.ask)}`;
      $("quote-time").textContent = formatTime(state.quoteAt);
    }

    if (state.ticker) {
      const change = state.ticker.changePct;
      const changeElement = $("change-value");
      changeElement.textContent = `${signed(change)}%`;
      changeElement.classList.toggle("positive", change > 0);
      changeElement.classList.toggle("negative", change < 0);
      $("last-price").textContent = priceFormat.format(state.ticker.last);
      $("day-high").textContent = `${priceFormat.format(state.ticker.high)} USDT`;
      $("day-low").textContent = `${priceFormat.format(state.ticker.low)} USDT`;
      $("day-volume").textContent = `${volumeFormat.format(state.ticker.volume)} ${currentSymbolConfig().base}`;
    }

    setLiveStatus();
    if (state.quoteAt) {
      $("last-updated").textContent = `${state.wsOk ? "实时更新" : "报价可能延迟"} · ${formatTime(state.quoteAt)}`;
    }
    if (state.analysisResults.h1 && state.analysisResults.m15) {
      renderIntradayStrategy(state.analysisResults);
    }
    if (state.analysisResults.d1 && state.analysisResults.h4 && state.analysisResults.h1) {
      renderPositionStrategy(state.analysisResults);
    }
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function parseBook(payload) {
    const bid = Number(payload.bidPrice ?? payload.b);
    const ask = Number(payload.askPrice ?? payload.a);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    return { bid, ask, mid: (bid + ask) / 2 };
  }

  function parseTicker(payload) {
    const last = Number(payload.lastPrice ?? payload.c);
    const high = Number(payload.highPrice ?? payload.h);
    const low = Number(payload.lowPrice ?? payload.l);
    const volume = Number(payload.volume ?? payload.v);
    const changePct = Number(payload.priceChangePercent ?? payload.P);
    if (![last, high, low, volume, changePct].every(Number.isFinite)) return null;
    return { last, high, low, volume, changePct };
  }

  async function seedCurrentData() {
    const symbol = state.symbol;
    try {
      const [bookPayload, tickerPayload] = await Promise.all([
        fetchJson(`${REST}/fapi/v1/ticker/bookTicker?symbol=${symbol}`),
        fetchJson(`${REST}/fapi/v1/ticker/24hr?symbol=${symbol}`)
      ]);
      if (symbol !== state.symbol) return;
      state.book = parseBook(bookPayload) ?? state.book;
      state.ticker = parseTicker(tickerPayload) ?? state.ticker;
      state.quoteAt = Number(bookPayload.time) || Date.now();
      updateQuoteUI();
      setError("");
    } catch (error) {
      if (symbol !== state.symbol) return;
      setError(`实时行情获取失败：${error.message}。页面将继续尝试连接。`);
    }
  }

  function connectBinance() {
    clearTimeout(state.reconnectTimer);
    const symbol = state.symbol;
    const generation = ++state.socketGeneration;
    if (state.socket) {
      state.socket.close();
      state.socket = null;
    }
    const streamSymbol = symbol.toLowerCase();
    const socket = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamSymbol}@bookTicker/${streamSymbol}@ticker`);
    state.socket = socket;

    socket.addEventListener("open", () => {
      if (generation !== state.socketGeneration || symbol !== state.symbol) return;
      state.wsOk = true;
      state.retryCount = 0;
      setLiveStatus();
    });

    socket.addEventListener("message", (event) => {
      if (generation !== state.socketGeneration || symbol !== state.symbol) return;
      try {
        const message = JSON.parse(event.data);
        const stream = message.stream || "";
        const payload = message.data || message;
        if (stream.endsWith("@bookTicker")) {
          state.book = parseBook(payload) ?? state.book;
          state.quoteAt = Number(payload.E) || Date.now();
        } else if (stream.endsWith("@ticker")) {
          state.ticker = parseTicker(payload) ?? state.ticker;
          state.quoteAt = Number(payload.E) || state.quoteAt || Date.now();
        }
        updateQuoteUI();
      } catch (_) {}
    });

    socket.addEventListener("close", () => {
      if (generation !== state.socketGeneration || symbol !== state.symbol) return;
      state.wsOk = false;
      setLiveStatus();
      const delay = Math.min(30000, 1000 * 2 ** state.retryCount++);
      state.reconnectTimer = setTimeout(connectBinance, delay);
    });

    socket.addEventListener("error", () => socket.close());
  }

  async function fetchCandles(symbol, interval, startTime, endTime) {
    const candles = [];
    let cursor = startTime;
    let pageCount = 0;

    while (cursor <= endTime && pageCount < 10) {
      const url = new URL(`${REST}/fapi/v1/klines`);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(endTime));
      url.searchParams.set("limit", "1500");
      const page = await fetchJson(url);
      if (!page.length) break;
      candles.push(...page);
      const next = Number(page[page.length - 1][6]) + 1;
      if (next <= cursor || page.length < 1500) break;
      cursor = next;
      pageCount += 1;
    }

    return candles.map((item) => ({
      t: Number(item[0]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5])
    })).filter((item) => [item.t, item.open, item.high, item.low, item.close].every(Number.isFinite));
  }

  async function fetchAnalysisCandles(symbol, interval, limit = 240) {
    const url = new URL(`${REST}/fapi/v1/klines`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    const page = await fetchJson(url);
    const now = Date.now();
    return page.map((item) => ({
      t: Number(item[0]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5]),
      closeTime: Number(item[6])
    })).filter((item) =>
      item.closeTime < now &&
      [item.t, item.open, item.high, item.low, item.close].every(Number.isFinite)
    );
  }

  function updateChartCopy() {
    const range = RANGES[state.range];
    const limited = state.historyLimited ? ` · 数据量保护：最近${MAX_HISTORY_CANDLES.toLocaleString("en-US")}根` : "";
    $("chart-subtitle").textContent = `${range.label} · ${INTERVALS[state.interval].label} · ${state.symbol}${limited}`;
    $("chart-note").textContent = `数据来自 Binance Futures 公开接口；${INTERVALS[state.interval].label}，红色上涨，绿色下跌；成交量、MACD与RSI附图同步主图，滚轮以最右侧K线为锚点缩放，支持左键拖动和触边自动扩展时间范围。`;
  }

  function updateRangeButtons() {
    document.querySelectorAll("[data-range]").forEach((button) => {
      button.classList.toggle("active", button.dataset.range === state.range);
    });
  }

  function getTimelineIndexBounds(count = state.candles.length) {
    if (!count) return { startIndex: 0, endIndex: -1 };
    const startIndex = Math.max(0, Math.min(count - 1, Math.floor(state.timelineStart / 100 * (count - 1))));
    const endIndex = Math.max(startIndex, Math.min(count - 1, Math.ceil(state.timelineEnd / 100 * (count - 1))));
    return { startIndex, endIndex };
  }

  function captureChartViewport() {
    const count = state.candles.length;
    if (count < 2) return null;
    const { startIndex, endIndex } = getTimelineIndexBounds(count);
    return {
      visibleCount: endIndex - startIndex + 1,
      endTime: state.candles[endIndex].t,
      followLatest: endIndex >= count - 2
    };
  }

  function findNearestCandleIndex(candles, targetTime) {
    let low = 0;
    let high = candles.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (candles[middle].t < targetTime) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    return Math.abs(candles[low].t - targetTime) < Math.abs(candles[low - 1].t - targetTime)
      ? low
      : low - 1;
  }

  function restoreChartViewport(viewport) {
    const count = state.candles.length;
    if (!viewport || count < 2) {
      state.timelineStart = 0;
      state.timelineEnd = 100;
      syncTimelineInputs();
      return;
    }
    const visibleCount = Math.max(2, Math.min(count, Math.round(viewport.visibleCount)));
    let endIndex = viewport.followLatest
      ? count - 1
      : findNearestCandleIndex(state.candles, viewport.endTime);
    let startIndex = endIndex - visibleCount + 1;
    if (startIndex < 0) {
      startIndex = 0;
      endIndex = Math.min(count - 1, visibleCount - 1);
    }
    const denominator = count - 1;
    const epsilon = 0.000001;
    state.timelineStart = startIndex === 0 ? 0 : startIndex / denominator * 100 + epsilon;
    state.timelineEnd = endIndex === count - 1 ? 100 : endIndex / denominator * 100 - epsilon;
    syncTimelineInputs();
  }

  function getNextHistoryRange() {
    const index = RANGE_ORDER.indexOf(state.range);
    return index >= 0 && index < RANGE_ORDER.length - 1 ? RANGE_ORDER[index + 1] : null;
  }

  async function expandHistoryRange() {
    const nextRange = getNextHistoryRange();
    const now = Date.now();
    if (!nextRange || state.rangeExpansionPending || now - state.lastRangeExpansionAt < RANGE_EXPANSION_COOLDOWN) {
      return false;
    }
    state.rangeExpansionPending = true;
    state.lastRangeExpansionAt = now;
    state.range = nextRange;
    updateRangeButtons();
    hideTooltip();
    try {
      await loadHistory({ anchorLatest: true });
    } finally {
      state.rangeExpansionPending = false;
    }
    return true;
  }

  async function loadHistory({ anchorLatest = false } = {}) {
    const viewport = captureChartViewport();
    if (viewport && anchorLatest) viewport.followLatest = true;
    const token = ++state.loadToken;
    const symbol = state.symbol;
    const range = RANGES[state.range];
    const endTime = Date.now();
    const interval = state.interval;
    const requestedStart = range.start(endTime);
    const protectedStart = endTime - INTERVALS[interval].ms * (MAX_HISTORY_CANDLES - 1);
    const startTime = Math.max(requestedStart, protectedStart);
    state.historyLimited = startTime > requestedStart;
    const cacheKey = historyCacheKey(symbol, state.range, interval);
    const cachePromise = readCandleCache(cacheKey);
    const networkPromise = fetchCandles(symbol, interval, startTime, endTime)
      .then((candles) => ({ candles, error: null }))
      .catch((error) => ({ candles: null, error }));
    state.candles = [];
    state.timelineStart = 0;
    state.timelineEnd = 100;
    syncTimelineInputs();
    renderChart();
    $("empty-state").textContent = "正在加载历史行情…";
    $("empty-state").style.display = "grid";
    updateChartCopy();

    try {
      const cached = await cachePromise;
      if (cached && token === state.loadToken && symbol === state.symbol && interval === state.interval) {
        state.candles = cached.candles;
        restoreChartViewport(viewport);
        renderChart();
        $("chart-subtitle").textContent = `${range.label} · ${INTERVALS[interval].label} · ${symbol} · 本地缓存，正在同步${state.historyLimited ? ` · 最近${MAX_HISTORY_CANDLES.toLocaleString("en-US")}根` : ""}`;
      }
      const networkResult = await networkPromise;
      if (networkResult.error) throw networkResult.error;
      const candles = networkResult.candles;
      if (token !== state.loadToken || symbol !== state.symbol) return;
      state.candles = candles;
      restoreChartViewport(viewport);
      renderChart();
      writeCandleCache(cacheKey, candles);
      setError("");
    } catch (error) {
      if (token !== state.loadToken || symbol !== state.symbol) return;
      if (!state.candles.length) {
        state.candles = [];
        renderChart();
      }
      setError(`历史行情同步失败：${error.message}。${state.candles.length ? "当前显示本地缓存。" : "实时报价仍会继续更新。"}`);
    }
  }

  function calculateRsi(candles, period = 14) {
    const values = Array(candles.length).fill(null);
    if (candles.length <= period) return values;
    let gains = 0;
    let losses = 0;
    for (let index = 1; index <= period; index += 1) {
      const change = candles[index].close - candles[index - 1].close;
      gains += Math.max(change, 0);
      losses += Math.max(-change, 0);
    }
    let averageGain = gains / period;
    let averageLoss = losses / period;
    const toRsi = () => {
      if (averageGain === 0 && averageLoss === 0) return 50;
      if (averageLoss === 0) return 100;
      return 100 - 100 / (1 + averageGain / averageLoss);
    };
    values[period] = toRsi();
    for (let index = period + 1; index < candles.length; index += 1) {
      const change = candles[index].close - candles[index - 1].close;
      averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
      averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
      values[index] = toRsi();
    }
    return values;
  }

  function calculateSma(candles, period) {
    if (candles.length < period) return null;
    let sum = 0;
    for (let index = candles.length - period; index < candles.length; index += 1) {
      sum += candles[index].close;
    }
    return sum / period;
  }

  function calculateSmaSeries(candles, period) {
    const output = Array(candles.length).fill(null);
    if (candles.length < period) return output;
    let sum = 0;
    for (let index = 0; index < candles.length; index += 1) {
      sum += candles[index].close;
      if (index >= period) sum -= candles[index - period].close;
      if (index >= period - 1) output[index] = sum / period;
    }
    return output;
  }

  function calculateEmaSeries(values, period) {
    const output = Array(values.length).fill(null);
    if (values.length < period) return output;
    let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    output[period - 1] = ema;
    const alpha = 2 / (period + 1);
    for (let index = period; index < values.length; index += 1) {
      ema = values[index] * alpha + ema * (1 - alpha);
      output[index] = ema;
    }
    return output;
  }

  function calculateMacdSeries(candles) {
    const closes = candles.map((candle) => candle.close);
    const fast = calculateEmaSeries(closes, 12);
    const slow = calculateEmaSeries(closes, 26);
    const dif = closes.map((_, index) =>
      Number.isFinite(fast[index]) && Number.isFinite(slow[index])
        ? fast[index] - slow[index]
        : null
    );
    const firstDif = dif.findIndex(Number.isFinite);
    const signal = Array(closes.length).fill(null);
    if (firstDif >= 0 && closes.length - firstDif >= 9) {
      let dea = dif.slice(firstDif, firstDif + 9).reduce((sum, value) => sum + value, 0) / 9;
      signal[firstDif + 8] = dea;
      const alpha = 2 / 10;
      for (let index = firstDif + 9; index < dif.length; index += 1) {
        dea = dif[index] * alpha + dea * (1 - alpha);
        signal[index] = dea;
      }
    }
    const histogram = dif.map((value, index) =>
      Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null
    );
    return { dif, signal, histogram };
  }

  function calculateMacd(candles) {
    const series = calculateMacdSeries(candles);
    const closes = candles.map((candle) => candle.close);
    const lastIndex = closes.length - 1;
    const previousIndex = lastIndex - 1;
    if (!Number.isFinite(series.signal[previousIndex]) || !Number.isFinite(series.signal[lastIndex])) return null;
    return {
      dif: series.dif[lastIndex],
      signal: series.signal[lastIndex],
      histogram: series.histogram[lastIndex],
      previousDif: series.dif[previousIndex],
      previousSignal: series.signal[previousIndex],
      previousHistogram: series.histogram[previousIndex]
    };
  }

  function calculateAtr(candles, period = 14) {
    if (candles.length <= period) return null;
    const ranges = [];
    for (let index = 1; index < candles.length; index += 1) {
      const candle = candles[index];
      const previousClose = candles[index - 1].close;
      ranges.push(Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      ));
    }
    let atr = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let index = period; index < ranges.length; index += 1) {
      atr = (atr * (period - 1) + ranges[index]) / period;
    }
    return atr;
  }

  function findLevels(candles, price, atr, lookback) {
    const recent = candles.slice(-lookback);
    const supports = [];
    const resistances = [];
    const separation = Math.max(atr * 0.15, price * 0.00025);
    for (let index = 2; index < recent.length - 2; index += 1) {
      const candle = recent[index];
      const neighbors = [recent[index - 2], recent[index - 1], recent[index + 1], recent[index + 2]];
      if (neighbors.every((item) => candle.low <= item.low) && candle.low < price - separation) {
        supports.push(candle.low);
      }
      if (neighbors.every((item) => candle.high >= item.high) && candle.high > price + separation) {
        resistances.push(candle.high);
      }
    }
    supports.sort((a, b) => b - a);
    resistances.sort((a, b) => a - b);
    let support = supports[0];
    let resistance = resistances[0];
    if (!Number.isFinite(support)) {
      const low = Math.min(...recent.map((candle) => candle.low));
      support = low < price ? low : price - atr * 1.5;
    }
    if (!Number.isFinite(resistance)) {
      const high = Math.max(...recent.map((candle) => candle.high));
      resistance = high > price ? high : price + atr * 1.5;
    }
    return { support, resistance };
  }

  function formatZone(level, atr) {
    const halfWidth = Math.max(atr * 0.18, level * 0.00025);
    return `${priceFormat.format(level - halfWidth)}–${priceFormat.format(level + halfWidth)}`;
  }

  function formatAnalysisZone(level, atr) {
    const halfWidth = Math.max(atr * 0.18, level * 0.00025);
    return `${analysisPriceFormat.format(level - halfWidth)}–${analysisPriceFormat.format(level + halfWidth)}`;
  }

  function describeRsi(value) {
    const number = value.toFixed(2);
    if (value >= 70) return `RSI=${number}，进入超买区，提示追多和高位回落风险；不据此反向做空。`;
    if (value >= 60) return `RSI=${number}，短线偏热，做多应避免远离结构入场区追价。`;
    if (value >= 40) return `RSI=${number}，处于中性区，暂无明显追涨或追跌风险。`;
    if (value >= 30) return `RSI=${number}，短线偏弱并接近超卖，做空应避免追价。`;
    return `RSI=${number}，进入超卖区，提示追空和快速反弹风险；不据此反向做多。`;
  }

  function describeMacd(macd) {
    const bullishCross = macd.previousDif <= macd.previousSignal && macd.dif > macd.signal;
    const bearishCross = macd.previousDif >= macd.previousSignal && macd.dif < macd.signal;
    const relation = bullishCross
      ? "刚形成金叉"
      : bearishCross
        ? "刚形成死叉"
        : macd.dif >= macd.signal
          ? "金叉运行"
          : "死叉运行";
    const histogram = macd.histogram >= 0
      ? macd.histogram >= macd.previousHistogram ? "多头柱扩大" : "多头柱收敛"
      : Math.abs(macd.histogram) >= Math.abs(macd.previousHistogram) ? "空头柱扩大" : "空头柱收敛";
    return `DIF=${macd.dif.toFixed(2)}，DEA=${macd.signal.toFixed(2)}，${relation}，${histogram}。`;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function calculateSwingStructure(candles, atr) {
    const recent = candles.slice(-55);
    const highs = [];
    const lows = [];
    for (let index = 2; index < recent.length - 2; index += 1) {
      const neighbors = [recent[index - 2], recent[index - 1], recent[index + 1], recent[index + 2]];
      if (neighbors.every((item) => recent[index].high >= item.high)) highs.push(recent[index].high);
      if (neighbors.every((item) => recent[index].low <= item.low)) lows.push(recent[index].low);
    }
    if (highs.length < 2 || lows.length < 2) {
      return { score: 0, label: "摆动高低点尚未形成完整序列" };
    }
    const highChange = (highs[highs.length - 1] - highs[highs.length - 2]) / atr;
    const lowChange = (lows[lows.length - 1] - lows[lows.length - 2]) / atr;
    const highDirection = highChange > 0.08 ? 1 : highChange < -0.08 ? -1 : 0;
    const lowDirection = lowChange > 0.08 ? 1 : lowChange < -0.08 ? -1 : 0;
    const alignedDirection = highDirection !== 0 && highDirection === lowDirection ? highDirection : 0;
    const score = alignedDirection
      ? Math.round((clamp(highChange / 0.8, -1, 1) + clamp(lowChange / 0.8, -1, 1)) * 50)
      : 0;
    const label = alignedDirection > 0
      ? "近期高点与低点同步抬高"
      : alignedDirection < 0
        ? "近期高点与低点同步下移"
        : "近期高低点方向不一致";
    return { score, label, direction: alignedDirection, highChange, lowChange };
  }

  function classifyDirection(score, key) {
    const previous = state.directionStates[key];
    let tier;
    if (score >= 65) tier = "strong-bullish";
    else if (score <= -65) tier = "strong-bearish";
    else if ((previous === "bullish" || previous === "strong-bullish") && score >= 15) tier = "bullish";
    else if ((previous === "bearish" || previous === "strong-bearish") && score <= -15) tier = "bearish";
    else if (score >= 25) tier = "bullish";
    else if (score <= -25) tier = "bearish";
    else tier = "neutral";
    state.directionStates[key] = tier;
    return tier;
  }

  function directionMeta(tier) {
    if (tier === "strong-bullish") return { bias: "bullish", label: "强势偏多", sign: 1 };
    if (tier === "bullish") return { bias: "bullish", label: "温和偏多", sign: 1 };
    if (tier === "strong-bearish") return { bias: "bearish", label: "强势偏空", sign: -1 };
    if (tier === "bearish") return { bias: "bearish", label: "温和偏空", sign: -1 };
    return { bias: "neutral", label: "震荡中性", sign: 0 };
  }

  function detectPriceAction(candles, levels, atr, ma20, ma60) {
    const recent = candles.slice(-6);
    const last = recent[recent.length - 1];
    const previous = recent[recent.length - 2] || last;
    const tolerance = atr * 0.35;
    const resistanceTouches = recent.filter((candle) => candle.high >= levels.resistance - tolerance).length;
    const supportTouches = recent.filter((candle) => candle.low <= levels.support + tolerance).length;
    const resistanceRetreat = (levels.resistance - last.close) / atr;
    const supportRecovery = (last.close - levels.support) / atr;
    const bearishFollowThrough = last.close < last.open && last.close < previous.close;
    const bullishFollowThrough = last.close > last.open && last.close > previous.close;
    const resistanceRejection = resistanceTouches >= 2 &&
      resistanceRetreat >= 0.65 &&
      bearishFollowThrough &&
      last.close <= Math.max(ma20, ma60) + atr * 0.1;
    const supportBounce = supportTouches >= 2 &&
      supportRecovery >= 0.65 &&
      bullishFollowThrough &&
      last.close >= Math.min(ma20, ma60) - atr * 0.1;
    const resistanceStrength = resistanceRejection
      ? resistanceTouches >= 3 && resistanceRetreat >= 1 ? "较强" : "初步"
      : "无";
    const supportStrength = supportBounce
      ? supportTouches >= 3 && supportRecovery >= 1 ? "较强" : "初步"
      : "无";
    return {
      resistanceRejection,
      supportBounce,
      resistanceStrength,
      supportStrength,
      resistanceTouches,
      supportTouches,
      resistanceRetreat,
      supportRecovery
    };
  }

  function classifyMarketState(result) {
    if (result.directionTier === "strong-bullish" || result.directionTier === "strong-bearish") {
      return { label: result.directionLabel, bias: result.bias };
    }
    if (result.priceAction.resistanceRejection && result.directionScore < 25) {
      return { label: "反弹遇压", bias: "bearish" };
    }
    if (result.priceAction.supportBounce && result.directionScore > -25) {
      return { label: "回调企稳", bias: "bullish" };
    }
    if (result.directionTier !== "neutral") return { label: result.directionLabel, bias: result.bias };
    if (result.trendScore <= -15 && result.momentumScore >= 15) return { label: "弱势反弹", bias: "bearish" };
    if (result.trendScore >= 15 && result.momentumScore <= -15) return { label: "强势回调", bias: "bullish" };
    if (result.directionScore >= 10) return { label: "震荡偏多", bias: "bullish" };
    if (result.directionScore <= -10) return { label: "震荡偏空", bias: "bearish" };
    return { label: "震荡中性", bias: "neutral" };
  }

  function confidenceMeta(score) {
    if (score >= 75) return { label: "较高", tone: "high" };
    if (score >= 55) return { label: "中等", tone: "medium" };
    return { label: "较低", tone: "low" };
  }

  function calculateConfidence(directionScore, components) {
    const active = components.filter((value) => Math.abs(value) >= 8);
    if (!active.length) return 30;
    const directionSign = directionScore >= 0 ? 1 : -1;
    const agreement = active.filter((value) => Math.sign(value) === directionSign).length / active.length;
    const boundaryPenalty = Math.abs(directionScore) < 25 ? 12 : 0;
    return Math.round(clamp(38 + agreement * 34 + Math.min(80, Math.abs(directionScore)) * 0.25 - boundaryPenalty, 25, 95));
  }

  function analyzeVolume(candles, atr, period = 20) {
    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    const baseline = candles.slice(-(period + 1), -1)
      .map((candle) => candle.volume)
      .filter((volume) => Number.isFinite(volume) && volume > 0);
    if (!last || !previous || baseline.length < period || !Number.isFinite(last.volume) || last.volume < 0) {
      return {
        available: false,
        ratio: null,
        label: "量能数据不足",
        longAdjustment: 0,
        shortAdjustment: 0,
        breakoutDirection: 0,
        priceDirection: 0
      };
    }
    const average = baseline.reduce((sum, volume) => sum + volume, 0) / baseline.length;
    if (!Number.isFinite(average) || average <= 0) {
      return {
        available: false,
        ratio: null,
        label: "量能基准无效",
        longAdjustment: 0,
        shortAdjustment: 0,
        breakoutDirection: 0,
        priceDirection: 0
      };
    }
    const ratio = last.volume / average;
    const breakoutWindow = candles.slice(-11, -1);
    const previousHigh = Math.max(...breakoutWindow.map((candle) => candle.high));
    const previousLow = Math.min(...breakoutWindow.map((candle) => candle.low));
    const breakoutDirection = last.close > previousHigh ? 1 : last.close < previousLow ? -1 : 0;
    const priceChange = last.close - previous.close;
    const priceDirection = priceChange > atr * 0.05 ? 1 : priceChange < -atr * 0.05 ? -1 : 0;
    const activeDirection = breakoutDirection || priceDirection;
    let adjustment = 0;
    let label = "量能中性";
    if (ratio >= 1.8) {
      adjustment = breakoutDirection ? 8 : activeDirection ? 6 : 0;
      label = breakoutDirection
        ? `显著放量${breakoutDirection > 0 ? "突破" : "跌破"}`
        : activeDirection
          ? `显著放量${activeDirection > 0 ? "上行" : "下行"}`
          : "显著放量，方向未确认";
    } else if (ratio >= 1.35) {
      adjustment = breakoutDirection ? 6 : activeDirection ? 4 : 0;
      label = breakoutDirection
        ? `放量${breakoutDirection > 0 ? "突破" : "跌破"}`
        : activeDirection
          ? `放量${activeDirection > 0 ? "上行" : "下行"}`
          : "放量整理";
    } else if (ratio >= 1.1) {
      adjustment = activeDirection ? 2 : 0;
      label = activeDirection ? `温和放量${activeDirection > 0 ? "上行" : "下行"}` : "温和放量整理";
    } else if (ratio <= 0.65 && breakoutDirection) {
      adjustment = -4;
      label = `缩量${breakoutDirection > 0 ? "突破" : "跌破"}，量能未确认`;
    } else if (ratio <= 0.7) {
      label = "缩量运行，暂不确认方向";
    }
    let longAdjustment = 0;
    let shortAdjustment = 0;
    if (activeDirection > 0) {
      longAdjustment = adjustment;
      if (adjustment > 0) shortAdjustment = -Math.min(3, Math.ceil(adjustment / 2));
    } else if (activeDirection < 0) {
      shortAdjustment = adjustment;
      if (adjustment > 0) longAdjustment = -Math.min(3, Math.ceil(adjustment / 2));
    }
    return {
      available: true,
      current: last.volume,
      average,
      ratio,
      label,
      longAdjustment,
      shortAdjustment,
      breakoutDirection,
      priceDirection
    };
  }

  function describeVolume(volume) {
    if (!volume?.available || !Number.isFinite(volume.ratio)) {
      return "成交量数据不足，本周期按中性处理，不影响原有判断。";
    }
    return `量比=${volume.ratio.toFixed(2)}（最近已收盘K线/前20根均量），${volume.label}；多方条件${signed(volume.longAdjustment, 0)}，空方条件${signed(volume.shortAdjustment, 0)}。`;
  }

  function analyzeIntradayPriceStructure(candles, atr, levels, volume, swing) {
    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2] || last;
    const context = candles.slice(-25, -1);
    const recent = candles.slice(-6);
    const contextHigh = Math.max(...context.map((candle) => candle.high));
    const contextLow = Math.min(...context.map((candle) => candle.low));
    const contextRange = Math.max(contextHigh - contextLow, atr * 0.5);
    const rangePosition = clamp((last.close - contextLow) / contextRange, 0, 1);
    const netBase = candles[Math.max(0, candles.length - 9)];
    const netMoveAtr = (last.close - netBase.close) / Math.max(atr, 0.000001);
    const pressure = recent.reduce((sum, candle) => {
      const range = Math.max(candle.high - candle.low, atr * 0.04, 0.000001);
      const bodyDirection = (candle.close - candle.open) / range;
      const closeLocation = ((candle.close - candle.low) / range) * 2 - 1;
      return sum + bodyDirection * 0.6 + closeLocation * 0.4;
    }, 0) / Math.max(1, recent.length);
    const lastRange = Math.max(last.high - last.low, atr * 0.04, 0.000001);
    const lastBodyRatio = Math.abs(last.close - last.open) / lastRange;
    const lastCloseLocation = (last.close - last.low) / lastRange;
    const bullishImpulse = last.close > last.open && lastBodyRatio >= 0.45 && lastCloseLocation >= 0.7;
    const bearishImpulse = last.close < last.open && lastBodyRatio >= 0.45 && lastCloseLocation <= 0.3;
    const breakoutDirection = last.close > contextHigh + atr * 0.05
      ? 1
      : last.close < contextLow - atr * 0.05
        ? -1
        : 0;
    const supportRejection = last.low <= levels.support + atr * 0.3 && bullishImpulse && last.close > previous.close;
    const resistanceRejection = last.high >= levels.resistance - atr * 0.3 && bearishImpulse && last.close < previous.close;
    const volumeDirection = volume?.breakoutDirection || volume?.priceDirection || 0;
    const volumeStrength = Number.isFinite(volume?.ratio) && volume.ratio >= 1.2 ? Math.min(8, (volume.ratio - 1) * 10) : 0;
    const swingContribution = swing.score * 0.4;
    const netMoveContribution = clamp(netMoveAtr / 2, -1, 1) * 25;
    const rangeContribution = clamp((rangePosition - 0.5) * 2, -1, 1) * 15;
    const pressureContribution = clamp(pressure, -1, 1) * 15;
    const breakoutContribution = breakoutDirection * 25;
    const rejectionContribution = (supportRejection ? 16 : 0) - (resistanceRejection ? 16 : 0);
    let baseScore = swingContribution + netMoveContribution + rangeContribution + pressureContribution + breakoutContribution + rejectionContribution;
    baseScore = Math.round(clamp(baseScore, -100, 100));
    const volumeContribution = volumeDirection * volumeStrength;
    const score = Math.round(clamp(baseScore + volumeContribution, -100, 100));
    const sign = score >= 18 ? 1 : score <= -18 ? -1 : 0;
    const strong = Math.abs(score) >= 38;

    const priorThree = candles.slice(-4, -1);
    const priorThreeHigh = Math.max(...priorThree.map((candle) => candle.high));
    const priorThreeLow = Math.min(...priorThree.map((candle) => candle.low));
    const shortBreakDirection = last.close > priorThreeHigh + atr * 0.03
      ? 1
      : last.close < priorThreeLow - atr * 0.03
        ? -1
        : 0;
    let triggerDirection = 0;
    let triggerLabel = "等待价格触发";
    if (supportRejection) {
      triggerDirection = 1;
      triggerLabel = "支撑区出现多头拒绝K线";
    } else if (resistanceRejection) {
      triggerDirection = -1;
      triggerLabel = "压力区出现空头拒绝K线";
    } else if (breakoutDirection && Number.isFinite(volume?.ratio) && volume.ratio >= 1.1) {
      triggerDirection = breakoutDirection;
      triggerLabel = `${breakoutDirection > 0 ? "向上" : "向下"}突破近期区间并获得量能确认`;
    } else if (shortBreakDirection && ((shortBreakDirection > 0 && bullishImpulse) || (shortBreakDirection < 0 && bearishImpulse))) {
      triggerDirection = shortBreakDirection;
      triggerLabel = `M15实体K线${shortBreakDirection > 0 ? "突破近3根高点" : "跌破近3根低点"}`;
    }

    const label = sign > 0
      ? strong ? "价格结构明显偏多" : "价格结构偏多"
      : sign < 0
        ? strong ? "价格结构明显偏空" : "价格结构偏空"
        : "价格结构中性";
    return {
      score,
      baseScore,
      sign,
      bias: sign > 0 ? "bullish" : sign < 0 ? "bearish" : "neutral",
      strong,
      label,
      swingContribution,
      netMoveAtr,
      netMoveContribution,
      rangePosition,
      rangeContribution,
      pressure,
      pressureContribution,
      contextHigh,
      contextLow,
      breakoutDirection,
      breakoutContribution,
      supportRejection,
      resistanceRejection,
      rejectionContribution,
      volumeContribution,
      bullishImpulse,
      bearishImpulse,
      triggerDirection,
      triggerLabel
    };
  }

  function calculateDirectionalSetup(result, sign) {
    const risk = sign > 0 ? result.price - result.support : result.resistance - result.price;
    const reward = sign > 0 ? result.resistance - result.price : result.price - result.support;
    const rewardRisk = Math.max(0, reward) / Math.max(result.atr * 0.25, risk);
    let score = 42;
    score += clamp(sign * result.directionScore * 0.22, -22, 22);
    score += clamp(sign * result.trendScore * 0.08, -8, 8);
    score += clamp(sign * result.momentumScore * 0.12, -12, 12);
    score += rewardRisk >= 2 ? 18 : rewardRisk >= 1.3 ? 11 : rewardRisk >= 0.8 ? 3 : -12;
    if (sign > 0 && result.nearResistance) score -= 24;
    if (sign < 0 && result.nearSupport) score -= 24;
    if (sign > 0 && result.nearSupport) score += 10;
    if (sign < 0 && result.nearResistance) score += 10;
    if (sign < 0 && result.priceAction.resistanceRejection) score += 24;
    if (sign > 0 && result.priceAction.resistanceRejection) score -= 22;
    if (sign > 0 && result.priceAction.supportBounce) score += 24;
    if (sign < 0 && result.priceAction.supportBounce) score -= 22;
    if ((sign > 0 && result.rsi >= 72) || (sign < 0 && result.rsi <= 28)) score -= 12;
    if (result.twoCloseDirection === sign) score += 10;
    else if (result.twoCloseDirection === -sign) score -= 14;
    const baseScore = Math.round(clamp(score, 0, 100));
    const volumeAdjustment = sign > 0
      ? result.volume.longAdjustment
      : result.volume.shortAdjustment;
    return {
      bias: sign > 0 ? "bullish" : "bearish",
      sign,
      score: Math.round(clamp(baseScore + volumeAdjustment, 0, 100)),
      baseScore,
      volumeAdjustment,
      rewardRisk
    };
  }

  function setupTone(setup, result) {
    if (setup.bias === "bullish" && result.nearResistance) return "caution";
    if (setup.bias === "bearish" && result.nearSupport) return "caution";
    if (setup.score >= 70) return "ready";
    if (setup.score >= 55) return "wait";
    return "caution";
  }

  function chooseOpportunity(result) {
    const bullish = result.longSetup;
    const bearish = result.shortSetup;
    const bullishBase = bullish.baseScore ?? bullish.score;
    const bearishBase = bearish.baseScore ?? bearish.score;
    const best = bullishBase >= bearishBase ? bullish : bearish;
    const bestBaseScore = Math.max(bullishBase, bearishBase);
    const difference = Math.abs(bullishBase - bearishBase);
    if (bestBaseScore < 45 || difference < 6) {
      return { bias: "neutral", sign: 0, score: best.score, baseScore: bestBaseScore, label: "双向等待", tone: "wait", difference };
    }
    const direction = best.bias === "bullish" ? "多方" : "空方";
    const hasPattern = best.bias === "bullish"
      ? result.priceAction.supportBounce
      : result.priceAction.resistanceRejection;
    const label = best.score >= 70
      ? `${direction}条件较好`
      : best.score >= 55
        ? `${direction}等待确认`
        : hasPattern
          ? `${direction}观察`
          : `${direction}略占优`;
    return { ...best, label, tone: setupTone(best, result), difference, baseScore: bestBaseScore };
  }

  function finalizeTradeOpportunities(result) {
    result.longSetup.score = Math.round(clamp(result.longSetup.score, 0, 100));
    result.shortSetup.score = Math.round(clamp(result.shortSetup.score, 0, 100));
    result.opportunity = chooseOpportunity(result);
    result.setupScore = result.opportunity.score;
    result.setup = result.opportunity;
  }

  function analyzeFrame(candles, config) {
    if (candles.length < 70) throw new Error(`${config.label}有效K线不足`);
    const last = candles[candles.length - 1];
    const price = last.close;
    const ma20 = calculateSma(candles, 20);
    const ma60 = calculateSma(candles, 60);
    const rsiSeries = calculateRsi(candles);
    const rsi = rsiSeries[rsiSeries.length - 1];
    const macd = calculateMacd(candles);
    const atr = calculateAtr(candles);
    if (![price, ma20, ma60, rsi, atr].every(Number.isFinite) || !macd) {
      throw new Error(`${config.label}指标计算失败`);
    }
    const levels = findLevels(candles, price, atr, config.lookback);
    const ma20Series = calculateSmaSeries(candles, 20);
    const ma60Series = calculateSmaSeries(candles, 60);
    const lastIndex = candles.length - 1;
    const slopeIndex = Math.max(0, lastIndex - 5);
    const ma20Slope = ma20 - ma20Series[slopeIndex];
    const ma60Slope = ma60 - ma60Series[slopeIndex];
    const swing = calculateSwingStructure(candles, atr);
    const lastTwoIndexes = [lastIndex - 1, lastIndex];
    const bullishCloses = lastTwoIndexes.every((index) =>
      candles[index].close >= ma20Series[index] && candles[index].close >= ma60Series[index]
    );
    const bearishCloses = lastTwoIndexes.every((index) =>
      candles[index].close <= ma20Series[index] && candles[index].close <= ma60Series[index]
    );
    const twoCloseDirection = bullishCloses ? 1 : bearishCloses ? -1 : 0;

    const priceComponent = clamp((((price - ma20) + (price - ma60)) / 2) / (atr * 1.5), -1, 1) * 15;
    const spreadComponent = clamp((ma20 - ma60) / (atr * 1.5), -1, 1) * 20;
    const ma20SlopeComponent = clamp(ma20Slope / (atr * 0.8), -1, 1) * 15;
    const ma60SlopeComponent = clamp(ma60Slope / (atr * 0.6), -1, 1) * 10;
    const structureComponent = swing.score * 0.2;
    const closeComponent = twoCloseDirection * 20;
    const trendScore = Math.round(clamp(
      priceComponent + spreadComponent + ma20SlopeComponent + ma60SlopeComponent + structureComponent + closeComponent,
      -100,
      100
    ));

    const rsiComponent = clamp((rsi - 50) / 15, -1, 1) * 30;
    const macdGapComponent = clamp(macd.histogram / (atr * 0.35), -1, 1) * 35;
    const macdZeroComponent = clamp(macd.dif / (atr * 0.75), -1, 1) * 20;
    const macdChangeComponent = clamp((macd.histogram - macd.previousHistogram) / (atr * 0.12), -1, 1) * 15;
    const momentumScore = Math.round(clamp(
      rsiComponent + macdGapComponent + macdZeroComponent + macdChangeComponent,
      -100,
      100
    ));
    const directionScore = Math.round(clamp(trendScore * 0.65 + momentumScore * 0.35, -100, 100));
    const directionTier = classifyDirection(directionScore, config.key);
    const direction = directionMeta(directionTier);
    let structure;
    if (ma20 >= ma60 && price >= ma20) {
      structure = `最近收盘 ${analysisPriceFormat.format(price)} 位于MA20(${analysisPriceFormat.format(ma20)})和MA60(${analysisPriceFormat.format(ma60)})上方，均线保持多头排列。`;
    } else if (ma20 >= ma60 && price >= ma60) {
      structure = `最近收盘 ${analysisPriceFormat.format(price)} 跌至MA20(${analysisPriceFormat.format(ma20)})下方但仍守住MA60(${analysisPriceFormat.format(ma60)})，属于多头结构中的调整。`;
    } else if (ma20 >= ma60) {
      structure = `最近收盘 ${analysisPriceFormat.format(price)} 已跌破MA20(${analysisPriceFormat.format(ma20)})和MA60(${analysisPriceFormat.format(ma60)})，原多头排列仍在但结构明显转弱。`;
    } else if (price <= ma20) {
      structure = `最近收盘 ${analysisPriceFormat.format(price)} 位于MA20(${analysisPriceFormat.format(ma20)})下方，且MA20低于MA60(${analysisPriceFormat.format(ma60)})，空头结构占优。`;
    } else if (price <= ma60) {
      structure = `最近收盘 ${analysisPriceFormat.format(price)} 反弹至MA20(${analysisPriceFormat.format(ma20)})上方，但仍受MA60(${analysisPriceFormat.format(ma60)})压制，暂按弱势反弹处理。`;
    } else {
      structure = `最近收盘 ${analysisPriceFormat.format(price)} 已站上MA20(${analysisPriceFormat.format(ma20)})和MA60(${analysisPriceFormat.format(ma60)})，但MA20尚未上穿MA60，反弹转强但多头排列仍待确认。`;
    }
    const slopeThreshold = atr * 0.06;
    const slopeText = `MA20${ma20Slope > slopeThreshold ? "上行" : ma20Slope < -slopeThreshold ? "下行" : "走平"}、MA60${ma60Slope > slopeThreshold ? "上行" : ma60Slope < -slopeThreshold ? "下行" : "走平"}`;
    structure += ` ${slopeText}；${swing.label}。`;
    const nearThreshold = Math.max(atr * 0.65, price * 0.001);
    const priceAction = detectPriceAction(candles, levels, atr, ma20, ma60);
    const volume = analyzeVolume(candles, atr);
    const intradayStructure = analyzeIntradayPriceStructure(candles, atr, levels, volume, swing);
    const result = {
      ...config,
      price,
      ma20,
      ma60,
      rsi,
      macd,
      atr,
      bias: direction.bias,
      directionTier,
      directionLabel: direction.label,
      trendScore,
      momentumScore,
      directionScore,
      twoCloseDirection,
      structure,
      swing,
      priceAction,
      volume,
      intradayStructure,
      support: levels.support,
      resistance: levels.resistance,
      supportZone: formatZone(levels.support, atr),
      resistanceZone: formatZone(levels.resistance, atr),
      analysisSupportZone: formatAnalysisZone(levels.support, atr),
      analysisResistanceZone: formatAnalysisZone(levels.resistance, atr),
      nearSupport: Math.abs(price - levels.support) <= nearThreshold,
      nearResistance: Math.abs(levels.resistance - price) <= nearThreshold,
      lastClosedAt: last.closeTime
    };
    result.marketState = classifyMarketState(result);
    result.longSetup = calculateDirectionalSetup(result, 1);
    result.shortSetup = calculateDirectionalSetup(result, -1);
    result.longSetupScoreBase = result.longSetup.baseScore;
    result.shortSetupScoreBase = result.shortSetup.baseScore;
    const confidenceBase = calculateConfidence(directionScore, [
      priceComponent,
      spreadComponent,
      ma20SlopeComponent,
      ma60SlopeComponent,
      structureComponent,
      closeComponent,
      momentumScore * 0.35
    ]);
    const directionalVolumeAdjustment = directionScore >= 10
      ? volume.longAdjustment
      : directionScore <= -10
        ? volume.shortAdjustment
        : 0;
    result.volumeConfidenceAdjustment = Math.round(clamp(directionalVolumeAdjustment * 0.75, -6, 6));
    result.confidenceScore = Math.round(clamp(confidenceBase + result.volumeConfidenceAdjustment, 25, 95));
    result.confidence = confidenceMeta(result.confidenceScore);
    finalizeTradeOpportunities(result);
    return result;
  }

  function proximityText(result) {
    if (result.nearResistance) return `当前临近压力区 ${result.analysisResistanceZone}，多方不宜追价，空方仍需等待转弱确认。`;
    if (result.nearSupport) return `当前正在测试支撑区 ${result.analysisSupportZone}，空方不宜追价，等待企稳或有效跌破。`;
    return `关注支撑 ${result.analysisSupportZone} 与压力 ${result.analysisResistanceZone}。`;
  }

  function applyMultiFrameContext(results) {
    const { h4, h1, m15 } = results;
    if (h1 && h4) {
      const opportunityBias = h1.opportunity.bias;
      h1.opportunityContext = opportunityBias === "neutral" || h4.bias === "neutral"
        ? "H4未提供明确的机会方向确认"
        : opportunityBias === h4.bias
          ? "与H4方向一致，属于顺势机会"
          : "与H4方向相反，属于逆势机会";
      if (h1.bias !== "neutral" && h1.bias === h4.bias) {
        h1.confidenceScore += 5;
      } else if (h1.bias !== "neutral" && h4.bias !== "neutral" && h1.bias !== h4.bias) {
        h1.confidenceScore -= 10;
      } else if (h4.bias === "neutral") {
        h1.confidenceScore -= 4;
      }
    }
    if (m15) {
      const higherFrames = [h4, h1].filter(Boolean);
      const aligned = higherFrames.filter((frame) => frame.bias !== "neutral" && frame.bias === m15.bias).length;
      const opposed = higherFrames.filter((frame) =>
        frame.bias !== "neutral" && m15.bias !== "neutral" && frame.bias !== m15.bias
      ).length;
      const opportunityBias = m15.opportunity.bias;
      const opportunityAligned = higherFrames.filter((frame) => frame.bias !== "neutral" && frame.bias === opportunityBias).length;
      const opportunityOpposed = higherFrames.filter((frame) =>
        frame.bias !== "neutral" && opportunityBias !== "neutral" && frame.bias !== opportunityBias
      ).length;
      m15.opportunityContext = opportunityBias === "neutral"
        ? "上级周期尚未给出明确的机会方向确认"
        : opportunityAligned === higherFrames.length && higherFrames.length === 2
          ? "与H4、H1方向一致，属于顺势机会"
          : opportunityOpposed > 0
            ? "与至少一个上级周期反向，属于逆势机会"
            : "上级周期尚未完全配合";
      if (m15.bias !== "neutral" && aligned === 2) {
        m15.confidenceScore += 8;
      } else if (opposed > 0) {
        m15.confidenceScore -= 10;
      } else if (m15.bias !== "neutral" && aligned === 0) {
        m15.confidenceScore -= 5;
      }
    }
    for (const result of Object.values(results)) {
      result.confidenceScore = Math.round(clamp(result.confidenceScore, 25, 95));
      result.confidence = confidenceMeta(result.confidenceScore);
      finalizeTradeOpportunities(result);
    }
  }

  function signalSummary(result) {
    const trend = result.trendScore >= 25
      ? "结构偏多"
      : result.trendScore <= -25
        ? "结构偏空"
        : "结构信号混合";
    const momentum = result.momentumScore >= 25
      ? "动能偏多"
      : result.momentumScore <= -25
        ? "动能偏空"
        : "动能尚未定向";
    const confirmation = result.twoCloseDirection === 1
      ? "最近两根收盘站在双均线上方"
      : result.twoCloseDirection === -1
        ? "最近两根收盘位于双均线下方"
        : "连续两根收盘尚未完成同向确认";
    const pattern = result.priceAction.resistanceRejection
      ? `，识别到${result.priceAction.resistanceStrength}压力区反弹失败`
      : result.priceAction.supportBounce
        ? `，识别到${result.priceAction.supportStrength}支撑区止跌反弹`
        : "";
    const volume = result.volume?.available ? `；量能为${result.volume.label}` : "；量能按中性处理";
    return `${trend}、${momentum}，${confirmation}${pattern}${volume}`;
  }

  function setupSummary(result) {
    const pair = `多方${result.longSetup.score}、空方${result.shortSetup.score}`;
    const opportunity = result.opportunity;
    if (opportunity.bias === "neutral") return `${pair}，两侧条件接近或都不足，暂不形成明确入场方向。`;
    const direction = opportunity.bias === "bullish" ? "多方" : "空方";
    const confirmed = result.twoCloseDirection === opportunity.sign;
    if (opportunity.score >= 70 && confirmed) {
      return `${pair}，${direction}方向、位置与连续收盘确认较一致，优先观察回踩后的延续性。`;
    }
    if (opportunity.bias === "bearish" && result.priceAction.resistanceRejection) {
      return `${pair}，压力区反弹失败令空方机会领先，但在支撑跌破前仍属于提前转弱信号。`;
    }
    if (opportunity.bias === "bullish" && result.priceAction.supportBounce) {
      return `${pair}，支撑区止跌令多方机会领先，但在压力突破前仍属于提前企稳信号。`;
    }
    return `${pair}，${direction}条件暂时领先，仍需等待连续收盘或关键位突破确认。`;
  }

  function opportunityDetail(result) {
    const opportunity = result.opportunity;
    if (opportunity.bias === "neutral") {
      return `双向等待：多方 ${result.longSetup.score}，空方 ${result.shortSetup.score}；两侧优势不足，等待关键位给出方向。`;
    }
    const direction = opportunity.bias === "bullish" ? "多方" : "空方";
    const confirmation = opportunity.bias === "bullish"
      ? result.twoCloseDirection === 1
        ? "最近两根收盘已完成多方确认。"
        : `仍需关注能否有效突破压力 ${result.analysisResistanceZone}。`
      : result.twoCloseDirection === -1
        ? "最近两根收盘已完成空方确认。"
        : `仍需关注能否有效跌破支撑 ${result.analysisSupportZone}。`;
    return `${opportunity.label}：多方 ${result.longSetup.score}，空方 ${result.shortSetup.score}；${direction}条件领先。${confirmation}`;
  }

  function buildConclusions(results) {
    const { h4, h1, m15 } = results;
    const conclusions = {};
    if (h4) {
      const view = intradayFrameView(h4);
      const direction = view.structure.strong
        ? `已形成日内${view.structure.sign > 0 ? "做多" : "做空"}主方向`
        : view.structure.sign
          ? "已有方向倾向，但尚未达到H4强方向阈值"
          : "尚未形成日内主方向";
      conclusions.h4 = `H4为${view.structure.label}（结构分${signed(view.structure.score, 0)}），${direction}；价格结构条件多${view.longScore}、空${view.shortScore}。${proximityText(h4)}`;
    }
    if (h1) {
      const view = intradayFrameView(h1);
      const relation = intradayFrameRelation(h1, [h4], "H4");
      conclusions.h1 = `H1为${view.structure.label}（结构分${signed(view.structure.score, 0)}），${relation}；价格结构条件多${view.longScore}、空${view.shortScore}。${proximityText(h1)}`;
    }
    if (m15) {
      const view = intradayFrameView(m15);
      const relation = intradayFrameRelation(m15, [h4, h1], "H4/H1");
      conclusions.m15 = `M15为${view.structure.label}（结构分${signed(view.structure.score, 0)}），${relation}；${view.structure.triggerLabel}，价格结构条件多${view.longScore}、空${view.shortScore}。${proximityText(m15)}`;
    }
    return conclusions;
  }

  function emptyIntradayStrategy(reason = "等待H4、H1与M15已收盘K线完成计算。") {
    return {
      bias: "neutral",
      candidateBias: "neutral",
      actionable: false,
      directionLabel: "观望",
      priority: "等待",
      score: null,
      longScore: null,
      shortScore: null,
      entryLow: null,
      entryHigh: null,
      stopLoss: null,
      takeProfit: null,
      target: null,
      rewardRisk1: null,
      rewardRisk2: null,
      summary: reason,
      trigger: "方向、位置与触发周期一致后再生成执行参数。"
    };
  }

  function calculateIntradayLevels(bias, entry, h1, m15) {
    const isLong = bias === "bullish";
    const atr = Math.max(m15.atr, entry * 0.00035);
    const entryPadding = Math.max(atr * 0.12, entry * 0.00008);
    const entryLow = isLong ? entry - entryPadding : entry - entryPadding * 0.35;
    const entryHigh = isLong ? entry + entryPadding * 0.35 : entry + entryPadding;
    const supports = [m15.support, h1.support]
      .filter((value) => Number.isFinite(value) && value < entry)
      .sort((a, b) => b - a);
    const resistances = [m15.resistance, h1.resistance]
      .filter((value) => Number.isFinite(value) && value > entry)
      .sort((a, b) => a - b);
    let stopLoss;
    let takeProfit;
    if (isLong) {
      const stopAnchor = supports[0];
      const minimumRisk = Math.max(atr * 0.75, h1.atr * 0.18, entry * 0.0008);
      stopLoss = Number.isFinite(stopAnchor)
        ? Math.min(stopAnchor - atr * 0.2, entry - minimumRisk)
        : entry - minimumRisk;
      const risk = Math.max(atr * 0.35, entry - stopLoss);
      const projectedFirst = entry + risk * 1.5;
      takeProfit = resistances[0] || projectedFirst;
      const secondResistance = resistances.find((value) => value > takeProfit + atr * 0.2);
      const target = Math.max(secondResistance || 0, entry + risk * 2.5);
      return {
        entryLow,
        entryHigh,
        stopLoss,
        takeProfit,
        target,
        rewardRisk1: Math.max(0, takeProfit - entry) / risk,
        rewardRisk2: Math.max(0, target - entry) / risk,
        risk
      };
    }
    const stopAnchor = resistances[0];
    const minimumRisk = Math.max(atr * 0.75, h1.atr * 0.18, entry * 0.0008);
    stopLoss = Number.isFinite(stopAnchor)
      ? Math.max(stopAnchor + atr * 0.2, entry + minimumRisk)
      : entry + minimumRisk;
    const risk = Math.max(atr * 0.35, stopLoss - entry);
    const projectedFirst = entry - risk * 1.5;
    takeProfit = supports[0] || projectedFirst;
    const secondSupport = supports.find((value) => value < takeProfit - atr * 0.2);
    const target = Math.min(Number.isFinite(secondSupport) ? secondSupport : Infinity, entry - risk * 2.5);
    return {
      entryLow,
      entryHigh,
      stopLoss,
      takeProfit,
      target,
      rewardRisk1: Math.max(0, entry - takeProfit) / risk,
      rewardRisk2: Math.max(0, entry - target) / risk,
      risk
    };
  }

  function evaluateExecutionQuality(levels, bias) {
    const entry = (levels.entryLow + levels.entryHigh) / 2;
    const riskRate = Math.abs(entry - levels.stopLoss) / entry;
    const rewardRate = Math.abs(levels.takeProfit - entry) / entry;
    const costRate = STRATEGY_FILTERS.estimatedRoundTripCostRate;
    const costToRisk = costRate / Math.max(riskRate, 0.000001);
    const costAdjustedRewardRisk = Math.max(0, rewardRate - costRate) /
      Math.max(0.000001, riskRate + costRate);
    return {
      costRate,
      costToRisk,
      costAdjustedRewardRisk,
      label: `${bias === "bullish" ? "多头" : "空头"}预估往返成本约${(costRate * 100).toFixed(2)}%，成本调整后盈亏比1:${costAdjustedRewardRisk.toFixed(2)}`
    };
  }

  function intradayConditionScore(frame, sign) {
    const structure = frame.intradayStructure;
    let baseScore = 50 + sign * structure.baseScore * 0.42;
    if (sign > 0 && frame.nearSupport) baseScore += 12;
    if (sign < 0 && frame.nearResistance) baseScore += 12;
    if (sign > 0 && frame.nearResistance) baseScore -= 14;
    if (sign < 0 && frame.nearSupport) baseScore -= 14;
    if (sign > 0 && structure.supportRejection) baseScore += 16;
    if (sign < 0 && structure.resistanceRejection) baseScore += 16;
    if (sign > 0 && structure.resistanceRejection) baseScore -= 16;
    if (sign < 0 && structure.supportRejection) baseScore -= 16;
    baseScore = Math.round(clamp(baseScore, 0, 100));
    const volumeAdjustment = sign > 0 ? frame.volume.longAdjustment : frame.volume.shortAdjustment;
    return {
      baseScore,
      score: Math.round(clamp(baseScore + volumeAdjustment, 0, 100)),
      volumeAdjustment
    };
  }

  function intradayStructureStrength(score) {
    const strength = Math.abs(score);
    if (strength >= 60) return { label: `强 · ${strength}/100`, tone: "high" };
    if (strength >= 38) return { label: `明确 · ${strength}/100`, tone: "high" };
    if (strength >= 18) return { label: `初步 · ${strength}/100`, tone: "medium" };
    return { label: `中性 · ${strength}/100`, tone: "low" };
  }

  function intradayFrameView(result) {
    const structure = result.intradayStructure;
    const longCondition = intradayConditionScore(result, 1);
    const shortCondition = intradayConditionScore(result, -1);
    return {
      structure,
      longScore: longCondition.score,
      shortScore: shortCondition.score,
      baseLongScore: longCondition.baseScore,
      baseShortScore: shortCondition.baseScore,
      bias: structure.bias,
      tone: structure.strong ? "ready" : structure.sign ? "wait" : "caution",
      strength: intradayStructureStrength(structure.score)
    };
  }

  function intradayStructureDetail(result) {
    const structure = result.intradayStructure;
    const pressureLabel = structure.pressure >= 0.12
      ? "多头压力"
      : structure.pressure <= -0.12
        ? "空头压力"
        : "多空压力均衡";
    const breakoutLabel = structure.breakoutDirection > 0
      ? "收盘突破前24根区间高点"
      : structure.breakoutDirection < 0
        ? "收盘跌破前24根区间低点"
        : "尚未突破前24根价格区间";
    const rejectionLabel = structure.supportRejection
      ? "支撑区出现多头拒绝K线"
      : structure.resistanceRejection
        ? "压力区出现空头拒绝K线"
        : "支撑压力附近暂无有效拒绝K线";
    const volumeLabel = Math.abs(structure.volumeContribution) >= 0.5
      ? `量能确认${signed(structure.volumeContribution, 0)}分`
      : "量能本次不改变结构分";
    return `摆动结构：${result.swing.label}（${signed(structure.swingContribution, 0)}）；近8根净变动${signed(structure.netMoveAtr, 2)} ATR（${signed(structure.netMoveContribution, 0)}）；收盘位于前24根区间${Math.round(structure.rangePosition * 100)}%位置（${signed(structure.rangeContribution, 0)}）；近6根为${pressureLabel}（${signed(structure.pressureContribution, 0)}）。${breakoutLabel}（${signed(structure.breakoutContribution, 0)}）；${rejectionLabel}（${signed(structure.rejectionContribution, 0)}）；${volumeLabel}。`;
  }

  function intradayOpportunityDetail(result, view = intradayFrameView(result)) {
    const structure = view.structure;
    const pair = `多方${view.longScore}、空方${view.shortScore}`;
    const location = result.nearSupport
      ? "当前靠近支撑，多方条件加分、空方避免追价"
      : result.nearResistance
        ? "当前靠近压力，空方条件加分、多方避免追价"
        : "当前未处于支撑或压力近端";
    if (!structure.sign) {
      return `双向等待：${pair}；结构分尚未达到±18方向阈值，${location}。`;
    }
    const direction = structure.sign > 0 ? "多方" : "空方";
    const threshold = structure.strong
      ? `已达到±38强方向阈值，${direction}结构明确`
      : `已达到初步方向阈值，但尚未达到±38强方向阈值`;
    const trigger = result.key === "m15" ? `；价格触发：${structure.triggerLabel}` : "";
    return `${pair}；${threshold}，${location}${trigger}。`;
  }

  function intradayFrameRelation(frame, higherFrames, label) {
    const sign = frame?.intradayStructure?.sign || 0;
    const available = higherFrames.filter((item) => item?.intradayStructure);
    if (!sign) return "本周期尚未形成明确方向";
    const directional = available.filter((item) => item.intradayStructure.sign !== 0);
    if (!directional.length) return `${label}尚未形成明确结构方向`;
    const aligned = directional.filter((item) => item.intradayStructure.sign === sign).length;
    const opposed = directional.filter((item) => item.intradayStructure.sign === -sign).length;
    if (opposed) return `与${label}至少一个结构方向相反，属于逆向信号`;
    if (aligned === available.length) return `与${label}价格结构同向`;
    return `${label}尚未完全形成同向结构`;
  }

  function intradayPriority(candidateSign, compositeScore, h4, h1, m15) {
    const h4Structure = h4?.intradayStructure;
    const h1Structure = h1.intradayStructure;
    const m15Structure = m15.intradayStructure;
    const h4StrongAligned = h4Structure?.strong && h4Structure.sign === candidateSign;
    const h4StrongOpposed = h4Structure?.strong && h4Structure.sign === -candidateSign;
    const h1Aligned = h1Structure.sign === candidateSign;
    const m15Triggered = m15Structure.triggerDirection === candidateSign;
    if (h4StrongAligned && h1Aligned && m15Triggered && compositeScore >= 60) {
      return { code: "A", label: "A · H4主趋势顺势", rank: 3 };
    }
    if (!h4StrongOpposed && h1Aligned && m15Triggered && compositeScore >= 55) {
      return { code: "B", label: "B · H1结构机会", rank: 2 };
    }
    return { code: "C", label: "C · 等待价格触发", rank: 1 };
  }

  function buildIntradayStrategy(results, entryPrice) {
    const { h4, h1, m15 } = results;
    if (!h4 || !h1 || !m15) return emptyIntradayStrategy();
    const h4Structure = h4.intradayStructure;
    const h1Structure = h1.intradayStructure;
    const m15Structure = m15.intradayStructure;
    const h4MainSign = h4Structure.strong ? h4Structure.sign : 0;
    const candidateSign = h4MainSign || (h1Structure.strong ? h1Structure.sign : 0);
    const longParts = [
      intradayConditionScore(h4, 1),
      intradayConditionScore(h1, 1),
      intradayConditionScore(m15, 1)
    ];
    const shortParts = [
      intradayConditionScore(h4, -1),
      intradayConditionScore(h1, -1),
      intradayConditionScore(m15, -1)
    ];
    const combine = (parts, field) => Math.round(parts[0][field] * 0.45 + parts[1][field] * 0.4 + parts[2][field] * 0.15);
    const baseLongScore = combine(longParts, "baseScore");
    const baseShortScore = combine(shortParts, "baseScore");
    const longScore = combine(longParts, "score");
    const shortScore = combine(shortParts, "score");
    const scoreEdge = Math.abs(baseLongScore - baseShortScore);
    const directionName = candidateSign > 0 ? "做多" : candidateSign < 0 ? "做空" : "等待";
    const candidateBias = candidateSign > 0 ? "bullish" : candidateSign < 0 ? "bearish" : "neutral";
    const compositeScore = candidateSign > 0 ? longScore : candidateSign < 0 ? shortScore : Math.max(longScore, shortScore);
    const baseCompositeScore = candidateSign > 0 ? baseLongScore : candidateSign < 0 ? baseShortScore : Math.max(baseLongScore, baseShortScore);
    const stateSummary = `H4 ${h4Structure.label}（结构分${signed(h4Structure.score, 0)}），H1 ${h1Structure.label}（结构分${signed(h1Structure.score, 0)}），M15 ${m15Structure.label}；价格结构基础多${baseLongScore}、空${baseShortScore}，量能调整后多${longScore}、空${shortScore}。H4${h4MainSign ? "已确定日内主方向" : "暂未形成强方向"}；M15：${m15Structure.triggerLabel}。`;
    const waitForCandidate = (reason, trigger) => ({
      ...emptyIntradayStrategy(reason),
      candidateBias,
      directionLabel: candidateSign ? `观望 · 候选${directionName}` : "观望",
      score: compositeScore,
      longScore,
      shortScore,
      trigger
    });

    if (!candidateSign) {
      return waitForCandidate(
        `${stateSummary} H4尚无强方向，H1价格结构也未形成明确机会，暂不选择方向。`,
        "等待H4形成明确主趋势，或H1形成强结构后由M15触发B级机会。"
      );
    }
    if (h4MainSign && h1Structure.sign !== candidateSign) {
      return waitForCandidate(
        `${stateSummary} H4已确定${directionName}主方向，但H1尚未形成同向机会，暂不提前入场。`,
        `等待H1价格结构转为${candidateSign > 0 ? "偏多" : "偏空"}，再由M15确认触发。`
      );
    }
    if (baseCompositeScore < STRATEGY_FILTERS.intradayMinimumBaseScore ||
        scoreEdge < STRATEGY_FILTERS.intradayMinimumScoreEdge) {
      return waitForCandidate(
        `${stateSummary} 当前价格结构优势不足，暂不强行选择方向。`,
        `等待结构分达到${STRATEGY_FILTERS.intradayMinimumBaseScore}分，且多空分差扩大到${STRATEGY_FILTERS.intradayMinimumScoreEdge}分以上。`
      );
    }
    if (h1Structure.sign !== candidateSign) {
      return waitForCandidate(
        `${stateSummary} H1尚未形成与候选方向一致的价格结构。`,
        `等待H1摆动结构、区间位置和最近收盘共同转为${candidateSign > 0 ? "偏多" : "偏空"}。`
      );
    }
    if (m15Structure.triggerDirection !== candidateSign) {
      return waitForCandidate(
        `${stateSummary} 日内方向已经确定，但M15尚未给出同向价格触发。`,
        candidateSign > 0
          ? `等待M15突破近3根高点、放量突破区间或在支撑 ${m15.supportZone} 出现多头拒绝K线。`
          : `等待M15跌破近3根低点、放量跌破区间或在压力 ${m15.resistanceZone} 出现空头拒绝K线。`
      );
    }

    const priority = intradayPriority(candidateSign, compositeScore, h4, h1, m15);
    if (priority.code === "C") {
      return waitForCandidate(
        `${stateSummary} 已出现方向倾向，但结构强度不足以进入A/B级执行评估。`,
        "等待H1结构增强并保留M15同向触发。"
      );
    }
    const entry = Number.isFinite(entryPrice) ? entryPrice : m15.price;
    const levels = calculateIntradayLevels(candidateBias, entry, h1, m15);
    const executionQuality = evaluateExecutionQuality(levels, candidateBias);
    const minimumRawRewardRisk = priority.code === "A"
      ? STRATEGY_FILTERS.intradayMinimumRawRewardRiskA
      : STRATEGY_FILTERS.intradayMinimumRawRewardRiskB;
    const minimumCostAdjustedRewardRisk = priority.code === "A"
      ? STRATEGY_FILTERS.intradayMinimumCostAdjustedRewardRiskA
      : STRATEGY_FILTERS.intradayMinimumCostAdjustedRewardRiskB;
    const structuralNote = candidateSign > 0
      ? "止损设置在最近有效支撑下方，止盈优先参考真实压力位。"
      : "止损设置在最近有效压力上方，止盈优先参考真实支撑位。";
    const trigger = candidateSign > 0
      ? `执行条件：${m15Structure.triggerLabel}；价格进入参考区后不得跌破 ${m15.supportZone}，触及结构止损则失效。`
      : `执行条件：${m15Structure.triggerLabel}；价格进入参考区后不得突破 ${m15.resistanceZone}，触及结构止损则失效。`;
    if (levels.rewardRisk1 < minimumRawRewardRisk ||
        executionQuality.costAdjustedRewardRisk < minimumCostAdjustedRewardRisk ||
        executionQuality.costToRisk > STRATEGY_FILTERS.intradayMaximumCostToRisk) {
      return {
        bias: "neutral",
        candidateBias,
        actionable: false,
        directionLabel: `观望 · 候选${directionName}`,
        priority: "等待 · 成本或盈亏比不足",
        score: compositeScore,
        longScore,
        shortScore,
        ...levels,
        summary: `${stateSummary} ${priority.code}级候选未通过风险保护：原始盈亏比1:${levels.rewardRisk1.toFixed(2)}，${executionQuality.label}，成本/风险=${executionQuality.costToRisk.toFixed(2)}。`,
        trigger: `等待入场价格改善、止损结构更清晰或目标空间扩大后再评估。${structuralNote}`
      };
    }
    return {
      bias: candidateBias,
      candidateBias,
      actionable: true,
      directionLabel: directionName,
      priority: priority.label,
      score: compositeScore,
      longScore,
      shortScore,
      ...levels,
      summary: `${stateSummary} ${directionName}条件达到${priority.code}级，并通过成本保护（${executionQuality.label}）。${structuralNote}`,
      trigger
    };
  }
  function strategyPrice(value) {
    return Number.isFinite(value) ? priceFormat.format(value) : "—";
  }

  function intradayRsiRisk(results, strategy) {
    const rsi = results?.m15?.rsi;
    if (!Number.isFinite(rsi)) {
      return { tone: "neutral", text: "M15 RSI数据不足；该提示不参与方向、评分或入场判断。" };
    }
    const value = rsi.toFixed(2);
    const candidate = strategy.candidateBias === "bullish"
      ? "当前候选方向为做多，"
      : strategy.candidateBias === "bearish"
        ? "当前候选方向为做空，"
        : "当前尚无候选方向，";
    if (rsi >= 70) {
      return {
        tone: "danger",
        text: `M15 RSI=${value}，处于超买区。${candidate}做多需防范追涨与高位回落；超买不等于立即做空，仍以结构、位置和价格触发为准。`
      };
    }
    if (rsi >= 60) {
      return {
        tone: "warning",
        text: `M15 RSI=${value}，短线偏热。${candidate}若计划做多，避免远离入场区追价；仅作风险提示，不计入策略评分。`
      };
    }
    if (rsi <= 30) {
      return {
        tone: "cool",
        text: `M15 RSI=${value}，处于超卖区。${candidate}做空需防范追跌与快速反弹；超卖不等于立即做多，仍以结构、位置和价格触发为准。`
      };
    }
    if (rsi <= 40) {
      return {
        tone: "cool",
        text: `M15 RSI=${value}，短线偏弱并接近超卖。${candidate}若计划做空，避免远离入场区追价；仅作风险提示，不计入策略评分。`
      };
    }
    return {
      tone: "neutral",
      text: `M15 RSI=${value}，处于中性区，暂无明显追涨或追跌风险；该提示不参与方向、评分或入场判断。`
    };
  }

  function renderIntradayStrategy(results = state.analysisResults) {
    const hasFrames = Boolean(results?.h4 && results?.h1 && results?.m15);
    const entryPrice = Number.isFinite(state.book?.mid) ? state.book.mid : results?.m15?.price;
    const strategy = buildIntradayStrategy(results || {}, entryPrice);
    const card = $("intraday-strategy");
    card.dataset.bias = strategy.bias;
    $("strategy-direction").textContent = strategy.directionLabel;
    $("strategy-priority").textContent = strategy.priority;
    $("strategy-score").textContent = Number.isFinite(strategy.score)
      ? `${strategy.score} / 100`
      : Number.isFinite(strategy.longScore) && Number.isFinite(strategy.shortScore)
        ? `多${strategy.longScore} · 空${strategy.shortScore}`
        : "—";
    $("strategy-entry").textContent = Number.isFinite(strategy.entryLow) && Number.isFinite(strategy.entryHigh)
      ? `${strategyPrice(strategy.entryLow)}–${strategyPrice(strategy.entryHigh)}`
      : "—";
    $("strategy-stop").textContent = strategyPrice(strategy.stopLoss);
    const takeProfitValues = [strategy.takeProfit, strategy.target]
      .filter(Number.isFinite)
      .map(strategyPrice);
    $("strategy-take-profit").textContent = takeProfitValues.length ? takeProfitValues.join(" / ") : "—";
    $("strategy-rr").textContent = Number.isFinite(strategy.rewardRisk1) && Number.isFinite(strategy.rewardRisk2)
      ? `1:${strategy.rewardRisk1.toFixed(2)} / 1:${strategy.rewardRisk2.toFixed(2)}`
      : "—";
    $("strategy-summary").textContent = strategy.summary;
    $("strategy-trigger").textContent = strategy.trigger;
    const rsiRisk = intradayRsiRisk(results, strategy);
    $("strategy-rsi-risk-box").dataset.tone = rsiRisk.tone;
    $("strategy-rsi-risk").textContent = rsiRisk.text;
    $("strategy-status").textContent = hasFrames
      ? `日内去均线化：H4结构定方向、H1找机会、M15价格触发；${Number.isFinite(state.book?.mid) ? "入场区随实时中间价更新" : "暂用M15最近收盘作为入场参考"} · ${formatTime(Date.now())}`
      : "等待H4、H1与M15已收盘K线…";
  }

  function emptyPositionStrategy(reason = "等待D1、H4与H1已收盘K线完成计算。") {
    return {
      bias: "neutral",
      candidateBias: "neutral",
      actionable: false,
      directionLabel: "观望",
      priority: "等待",
      score: null,
      longScore: null,
      shortScore: null,
      entryLow: null,
      entryHigh: null,
      stopLoss: null,
      takeProfit: null,
      target: null,
      rewardRisk1: null,
      rewardRisk2: null,
      summary: reason,
      trigger: "等待日线背景、H4结构与H1确认形成一致方向。"
    };
  }

  function calculatePositionLevels(bias, livePrice, d1, h4, h1) {
    const isLong = bias === "bullish";
    const volatility = Math.max(h4.atr, h1.atr * 2, livePrice * 0.001);
    const entryPadding = Math.max(h1.atr * 0.28, h4.atr * 0.1, livePrice * 0.0003);
    const pullbackAnchor = isLong
      ? Math.max(h1.support, h1.ma20)
      : Math.min(h1.resistance, h1.ma20);
    const entry = Number.isFinite(pullbackAnchor)
      ? isLong ? Math.min(livePrice, pullbackAnchor) : Math.max(livePrice, pullbackAnchor)
      : livePrice;
    const entryLow = isLong ? entry - entryPadding : entry - entryPadding * 0.4;
    const entryHigh = isLong ? entry + entryPadding * 0.4 : entry + entryPadding;
    const supports = [h1.support, h4.support, d1.support]
      .filter((value) => Number.isFinite(value) && value < entry)
      .sort((a, b) => b - a);
    const resistances = [h1.resistance, h4.resistance, d1.resistance]
      .filter((value) => Number.isFinite(value) && value > entry)
      .sort((a, b) => a - b);
    if (isLong) {
      const stopAnchor = Number.isFinite(h4.support) && h4.support < entry
        ? h4.support
        : supports[0];
      const stopLoss = Number.isFinite(stopAnchor)
        ? Math.min(stopAnchor - volatility * 0.25, entry - volatility * 0.9)
        : entry - volatility * 1.1;
      const risk = Math.max(volatility * 0.4, entry - stopLoss);
      const projectedFirst = entry + risk * 2;
      const takeProfit = Math.max(resistances[0] || projectedFirst, projectedFirst);
      const fartherResistance = resistances.find((value) => value > takeProfit + volatility * 0.2);
      const projectedSecond = entry + risk * 3;
      const target = Math.max(fartherResistance || projectedSecond, projectedSecond);
      return {
        entryLow,
        entryHigh,
        stopLoss,
        takeProfit,
        target,
        rewardRisk1: (takeProfit - entry) / risk,
        rewardRisk2: (target - entry) / risk,
        risk
      };
    }
    const stopAnchor = Number.isFinite(h4.resistance) && h4.resistance > entry
      ? h4.resistance
      : resistances[0];
    const stopLoss = Number.isFinite(stopAnchor)
      ? Math.max(stopAnchor + volatility * 0.25, entry + volatility * 0.9)
      : entry + volatility * 1.1;
    const risk = Math.max(volatility * 0.4, stopLoss - entry);
    const projectedFirst = entry - risk * 2;
    const takeProfit = Math.min(supports[0] || projectedFirst, projectedFirst);
    const fartherSupport = supports.find((value) => value < takeProfit - volatility * 0.2);
    const projectedSecond = entry - risk * 3;
    const target = Math.min(fartherSupport || projectedSecond, projectedSecond);
    return {
      entryLow,
      entryHigh,
      stopLoss,
      takeProfit,
      target,
      rewardRisk1: (entry - takeProfit) / risk,
      rewardRisk2: (entry - target) / risk,
      risk
    };
  }

  function positionPriority(candidateBias, compositeScore, d1, h4, h1) {
    const d1Bias = d1.marketState?.bias || d1.bias;
    const h4Bias = h4.marketState?.bias || h4.bias;
    const h1Bias = h1.marketState?.bias || h1.bias;
    const d1Aligned = d1Bias === candidateBias;
    const h4Aligned = h4Bias === candidateBias && h4.opportunity.bias === candidateBias;
    const h1Aligned = h1Bias === candidateBias && h1.opportunity.bias === candidateBias;
    const d1Opposed = d1Bias !== "neutral" && d1Bias !== candidateBias;
    const h1Opposed = (h1Bias !== "neutral" && h1Bias !== candidateBias) ||
      (h1.opportunity.bias !== "neutral" && h1.opportunity.bias !== candidateBias);
    if (d1Aligned && h4Aligned && h1Aligned && compositeScore >= 68) {
      return { code: "A", label: "A · 多周期顺势", rank: 3 };
    }
    if (h4Aligned && h1Aligned && !d1Opposed && compositeScore >= 58) {
      return { code: "B", label: "B · H4/H1共振", rank: 2 };
    }
    if (h4Aligned && !d1Opposed && !h1Opposed) {
      return { code: "C", label: "C · 分批关注", rank: 1 };
    }
    return { code: "C", label: "C · 等待强化", rank: 1 };
  }

  function buildPositionStrategy(results, livePrice) {
    const { d1, h4, h1, m15 } = results;
    if (!d1 || !h4 || !h1) return emptyPositionStrategy();
    const baseLongScore = Math.round((h4.longSetup.baseScore ?? h4.longSetup.score) * 0.7 + (h1.longSetup.baseScore ?? h1.longSetup.score) * 0.3);
    const baseShortScore = Math.round((h4.shortSetup.baseScore ?? h4.shortSetup.score) * 0.7 + (h1.shortSetup.baseScore ?? h1.shortSetup.score) * 0.3);
    const longScore = Math.round(h4.longSetup.score * 0.7 + h1.longSetup.score * 0.3);
    const shortScore = Math.round(h4.shortSetup.score * 0.7 + h1.shortSetup.score * 0.3);
    const candidateBias = baseLongScore >= baseShortScore ? "bullish" : "bearish";
    const baseCompositeScore = Math.max(baseLongScore, baseShortScore);
    const compositeScore = candidateBias === "bullish" ? longScore : shortScore;
    const scoreEdge = Math.abs(baseLongScore - baseShortScore);
    const volumeAdjustment = compositeScore - baseCompositeScore;
    const h4Signal = h4.opportunity.bias;
    const h1Signal = h1.opportunity.bias;
    const d1Bias = d1.marketState?.bias || d1.bias;
    const h4Bias = h4.marketState?.bias || h4.bias;
    const h1Bias = h1.marketState?.bias || h1.bias;
    const directionName = candidateBias === "bullish" ? "做多" : "做空";
    const timingText = !m15
      ? "M15数据不足"
      : m15.opportunity.bias === candidateBias
        ? "M15入场时机同向"
        : m15.opportunity.bias === "neutral"
          ? "M15尚未给出入场时机"
          : "M15入场时机反向";
    const stateSummary = `D1 ${d1.marketState.label}，H4 ${h4.marketState.label}，H1 ${h1.marketState.label}；技术面基础多${baseLongScore}、空${baseShortScore}，量能调整后多${longScore}、空${shortScore}（候选方向调整${signed(volumeAdjustment, 0)}）；${timingText}。高周期量能：D1 ${d1.volume?.label || "中性"}，H4 ${h4.volume?.label || "中性"}，H1 ${h1.volume?.label || "中性"}。`;
    const waitForCandidate = (reason, trigger) => ({
      ...emptyPositionStrategy(reason),
      candidateBias,
      directionLabel: `观望 · 候选${directionName}`,
      score: compositeScore,
      longScore,
      shortScore,
      trigger
    });

    if (h4Signal !== "neutral" && h1Signal !== "neutral" && h4Signal !== h1Signal) {
      return {
        ...emptyPositionStrategy(`${stateSummary} H4与H1机会方向冲突，中长线暂不执行。`),
        longScore,
        shortScore,
        trigger: "等待H4与H1已收盘K线重新形成同向机会。"
      };
    }
    if (baseCompositeScore < STRATEGY_FILTERS.positionMinimumBaseScore ||
        scoreEdge < STRATEGY_FILTERS.positionMinimumScoreEdge) {
      return waitForCandidate(
        `${stateSummary} 高周期多空优势不足，暂不建立中长线仓位。`,
        `等待H4/H1综合分达到${STRATEGY_FILTERS.positionMinimumBaseScore}分以上，且多空分差扩大到${STRATEGY_FILTERS.positionMinimumScoreEdge}分以上。`
      );
    }
    if (d1Bias !== "neutral" && d1Bias !== candidateBias) {
      return {
        ...emptyPositionStrategy(`${stateSummary} 候选${directionName}与D1长期背景相反，暂不逆势建立中长线仓位。`),
        longScore,
        shortScore,
        trigger: `等待D1转为${candidateBias === "bullish" ? "多方" : "空方"}，或H4/H1出现新的同向结构。`
      };
    }
    if ((h4Bias !== "neutral" && h4Bias !== candidateBias) ||
        (h1Bias !== "neutral" && h1Bias !== candidateBias)) {
      return {
        ...emptyPositionStrategy(`${stateSummary} 候选${directionName}尚未得到H4/H1最终行情状态确认，暂不执行。`),
        longScore,
        shortScore,
        trigger: `等待H4与H1行情状态共同转为${candidateBias === "bullish" ? "偏多" : "偏空"}。`
      };
    }
    if ((h4Signal !== "neutral" && h4Signal !== candidateBias) ||
        (h1Signal !== "neutral" && h1Signal !== candidateBias)) {
      return {
        ...emptyPositionStrategy(`${stateSummary} 综合分与高周期机会方向不一致，暂不执行。`),
        longScore,
        shortScore,
        trigger: "等待H4主方向与H1确认方向重新一致。"
      };
    }
    if (compositeScore < STRATEGY_FILTERS.positionMinimumExecutionScore) {
      return waitForCandidate(
        `${stateSummary} 中长线策略要求更高方向确定性，当前${directionName}评分${compositeScore}，低于${STRATEGY_FILTERS.positionMinimumExecutionScore}分执行门槛。`,
        `等待D1/H4/H1继续同向，并将策略评分提升至${STRATEGY_FILTERS.positionMinimumExecutionScore}分以上。`
      );
    }

    const entry = Number.isFinite(livePrice) ? livePrice : h1.price;
    const levels = calculatePositionLevels(candidateBias, entry, d1, h4, h1);
    const priority = positionPriority(candidateBias, compositeScore, d1, h4, h1);
    const structuralNote = candidateBias === "bullish"
      ? "止损放在H4有效支撑下方，止盈按结构压力与至少2倍、3倍风险空间取较远值。"
      : "止损放在H4有效压力上方，止盈按结构支撑与至少2倍、3倍风险空间取较远值。";
    const trigger = candidateBias === "bullish"
      ? `执行条件：D1保持非空、H4多方结构有效；价格进入参考区后等待H1转强，M15仅辅助择时。H4收盘跌破 ${h4.supportZone} 或触及止损则策略失效。`
      : `执行条件：D1保持非多、H4空方结构有效；价格进入参考区后等待H1转弱，M15仅辅助择时。H4收盘突破 ${h4.resistanceZone} 或触及止损则策略失效。`;
    if (priority.code !== "A") {
      return {
        bias: "neutral",
        candidateBias,
        actionable: false,
        directionLabel: `观察 · 候选${directionName}`,
        priority: `${priority.label} · 不执行`,
        score: compositeScore,
        longScore,
        shortScore,
        ...levels,
        summary: `${stateSummary} 当前仅达到${priority.code}级观察条件；保留方向提示但不生成执行信号。`,
        trigger: `等待D1、H4和H1形成A级同向共振后再评估。${structuralNote}`
      };
    }
    if (m15 && m15.opportunity.bias !== "neutral" && m15.opportunity.bias !== candidateBias) {
      return {
        bias: "neutral",
        candidateBias,
        actionable: false,
        directionLabel: `观望 · 候选${directionName}`,
        priority: "等待 · M15择时反向",
        score: compositeScore,
        longScore,
        shortScore,
        ...levels,
        summary: `${stateSummary} 高周期方向虽成立，但M15当前与候选方向相反，暂缓入场。`,
        trigger: `等待M15转为${candidateBias === "bullish" ? "多方" : "空方"}或回到中性后再执行。`
      };
    }
    return {
      bias: candidateBias,
      candidateBias,
      actionable: true,
      directionLabel: directionName,
      priority: priority.label,
      score: compositeScore,
      longScore,
      shortScore,
      ...levels,
      summary: `${stateSummary} ${directionName}条件领先。${structuralNote}`,
      trigger
    };
  }

  function renderPositionStrategy(results = state.analysisResults) {
    const hasFrames = Boolean(results?.d1 && results?.h4 && results?.h1);
    const livePrice = Number.isFinite(state.book?.mid) ? state.book.mid : results?.h1?.price;
    const strategy = buildPositionStrategy(results || {}, livePrice);
    const card = $("position-strategy");
    card.dataset.bias = strategy.bias;
    $("position-direction").textContent = strategy.directionLabel;
    $("position-priority").textContent = strategy.priority;
    $("position-score").textContent = Number.isFinite(strategy.score)
      ? `${strategy.score} / 100`
      : Number.isFinite(strategy.longScore) && Number.isFinite(strategy.shortScore)
        ? `多${strategy.longScore} · 空${strategy.shortScore}`
        : "—";
    $("position-entry").textContent = Number.isFinite(strategy.entryLow) && Number.isFinite(strategy.entryHigh)
      ? `${strategyPrice(strategy.entryLow)}–${strategyPrice(strategy.entryHigh)}`
      : "—";
    $("position-stop").textContent = strategyPrice(strategy.stopLoss);
    const takeProfitValues = [strategy.takeProfit, strategy.target]
      .filter(Number.isFinite)
      .map(strategyPrice);
    $("position-take-profit").textContent = takeProfitValues.length ? takeProfitValues.join(" / ") : "—";
    $("position-rr").textContent = Number.isFinite(strategy.rewardRisk1) && Number.isFinite(strategy.rewardRisk2)
      ? `1:${strategy.rewardRisk1.toFixed(2)} / 1:${strategy.rewardRisk2.toFixed(2)}`
      : "—";
    $("position-summary").textContent = strategy.summary;
    $("position-trigger").textContent = strategy.trigger;
    $("position-status").textContent = hasFrames
      ? `信号使用已收盘D1/H4/H1，M15仅辅助入场；${Number.isFinite(state.book?.mid) ? "入场区随实时中间价更新" : "暂用H1最近收盘作为入场参考"} · ${formatTime(Date.now())}`
      : "等待D1、H4与H1已收盘K线…";
  }

  function renderAnalysisCard(key, result, conclusion) {
    const view = intradayFrameView(result);
    const structure = view.structure;
    $(`${key}-card`).dataset.bias = view.bias;
    $(`${key}-state`).textContent = structure.label;
    $(`${key}-direction-score`).textContent = signed(structure.score, 0);
    $(`${key}-direction-score`).className = structure.sign > 0
      ? "bullish"
      : structure.sign < 0
        ? "bearish"
        : "neutral";
    $(`${key}-setup-score`).textContent = `多${view.longScore} · 空${view.shortScore}`;
    $(`${key}-setup-score`).className = view.bias;
    $(`${key}-setup-score`).dataset.tone = view.tone;
    $(`${key}-setup-score`).title = structure.label;
    $(`${key}-confidence`).textContent = view.strength.label;
    $(`${key}-confidence`).dataset.tone = view.strength.tone;
    $(`${key}-structure`).textContent = intradayStructureDetail(result);
    $(`${key}-opportunity`).textContent = intradayOpportunityDetail(result, view);
    $(`${key}-rsi`).textContent = describeRsi(result.rsi);
    $(`${key}-macd`).textContent = describeMacd(result.macd);
    $(`${key}-volume`).textContent = describeVolume(result.volume);
    $(`${key}-levels`).textContent = `支撑 ${result.analysisSupportZone}；压力 ${result.analysisResistanceZone}；ATR(14)=${analysisPriceFormat.format(result.atr)}。`;
    $(`${key}-conclusion`).textContent = conclusion;
  }

  function renderAnalysisUnavailable(key, message) {
    $(`${key}-card`).dataset.bias = "neutral";
    $(`${key}-state`).textContent = "数据不足";
    $(`${key}-direction-score`).textContent = "—";
    $(`${key}-setup-score`).textContent = "—";
    $(`${key}-confidence`).textContent = "—";
    [`${key}-structure`, `${key}-opportunity`, `${key}-rsi`, `${key}-macd`, `${key}-volume`, `${key}-levels`].forEach((id) => $(id).textContent = "—");
    $(`${key}-conclusion`).textContent = message;
  }

  function renderAnalysis(errors = {}) {
    const results = {};
    for (const [key, config] of Object.entries(ANALYSIS_FRAMES)) {
      const candles = state.analysisFrames[key];
      if (!candles?.length) continue;
      try {
        results[key] = analyzeFrame(candles, { ...config, key });
      } catch (error) {
        errors[key] = error.message;
      }
    }
    applyMultiFrameContext(results);
    state.analysisResults = results;
    const conclusions = buildConclusions(results);
    for (const [key, config] of Object.entries(ANALYSIS_FRAMES)) {
      if (config.hidden) continue;
      if (results[key]) renderAnalysisCard(key, results[key], conclusions[key]);
      else renderAnalysisUnavailable(key, errors[key] || "暂时无法生成判断，请稍后重试。");
    }
    renderIntradayStrategy(results);
    renderPositionStrategy(results);
  }

  async function loadAnalysis() {
    const token = ++state.analysisLoadToken;
    const symbol = state.symbol;
    $("analysis-status").textContent = "正在更新 D1、H4、H1、M15 已收盘K线…";
    const entries = Object.entries(ANALYSIS_FRAMES);
    const cached = await Promise.all(entries.map(([, config]) =>
      readCandleCache(analysisCacheKey(symbol, config.interval))
    ));
    if (token !== state.analysisLoadToken || symbol !== state.symbol) return;
    let hasCachedAnalysis = false;
    cached.forEach((record, index) => {
      if (!record) return;
      state.analysisFrames[entries[index][0]] = record.candles;
      hasCachedAnalysis = true;
    });
    if (hasCachedAnalysis) {
      renderAnalysis();
      $("analysis-status").textContent = "已显示本地缓存 · 正在同步 D1、H4、H1、M15 最新K线…";
    }
    const settled = await Promise.allSettled(entries.map(([, config]) =>
      fetchAnalysisCandles(symbol, config.interval)
    ));
    if (token !== state.analysisLoadToken || symbol !== state.symbol) return;
    const errors = {};
    settled.forEach((result, index) => {
      const key = entries[index][0];
      if (result.status === "fulfilled") {
        state.analysisFrames[key] = result.value;
        writeCandleCache(analysisCacheKey(symbol, entries[index][1].interval), result.value);
      }
      else errors[key] = `行情加载失败：${result.reason?.message || "未知错误"}`;
    });
    renderAnalysis(errors);
    const failed = Object.keys(errors).length;
    $("analysis-status").textContent = `${failed ? `${failed}个周期延迟 · ` : ""}行情卡片与日内策略统一采用结构＋位置＋触发 · RSI/MACD仅提示 · ${formatTime(Date.now())}`;
  }

  function indicatorX(index, count, margin, innerW) {
    return margin.left + ((index + 0.5) / Math.max(1, count)) * innerW - state.rightBlankRatio * innerW;
  }

  function indicatorVerticalGrid(margin, W, innerW) {
    let markup = "";
    for (let index = 0; index <= 4; index += 1) {
      const px = margin.left + innerW * index / 4;
      markup += `<line class="indicator-grid" x1="${px}" x2="${px}" y1="${margin.top}" y2="${margin.bottomY}"></line>`;
    }
    return markup;
  }

  function latestFiniteIndex(values) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      if (Number.isFinite(values[index])) return index;
    }
    return -1;
  }

  function renderVolume(candles) {
    const svg = $("volume-chart");
    const grid = $("volume-grid-layer");
    const bars = $("volume-bar-layer");
    const current = $("volume-current");
    const W = 1000;
    const H = 148;
    const margin = { top: 20, right: 66, bottom: 8, left: 12, bottomY: 140 };
    const innerW = W - margin.left - margin.right;
    const innerH = margin.bottomY - margin.top;
    const axisTextScaleX = getSvgTextScaleX(svg, W, H);
    grid.innerHTML = "";
    bars.innerHTML = "";
    if (candles.length < 2) {
      current.textContent = "—";
      current.className = "";
      svg._chart = null;
      return;
    }
    const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1) * 1.08;
    const y = (value) => margin.top + (1 - value / maxVolume) * innerH;
    const x = (index) => indicatorX(index, candles.length, margin, innerW);
    let gridMarkup = indicatorVerticalGrid(margin, W, innerW);
    [maxVolume, maxVolume / 2, 0].forEach((value) => {
      const py = y(value);
      gridMarkup += `<line class="indicator-grid" x1="${margin.left}" x2="${W - margin.right}" y1="${py}" y2="${py}"></line>`;
      const labelX = W - margin.right + 9;
      gridMarkup += `<text class="axis-text" x="${labelX}" y="${py + 3}"${axisTextTransform(labelX, axisTextScaleX)}>${volumeFormat.format(value)}</text>`;
    });
    grid.innerHTML = gridMarkup;
    const slot = innerW / candles.length;
    const width = Math.max(1.2, Math.min(8, slot * 0.7));
    bars.innerHTML = candles.map((candle, index) => {
      const top = y(candle.volume);
      const height = Math.max(1, margin.bottomY - top);
      const fill = candle.close >= candle.open ? "#ff6b70" : "#37d59a";
      return `<rect x="${(x(index) - width / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${fill}" opacity=".72"></rect>`;
    }).join("");
    const latest = candles[candles.length - 1];
    current.textContent = volumeFormat.format(latest.volume);
    current.className = latest.close >= latest.open ? "positive" : "negative";
    svg._chart = { candles, x, y, W, H, margin };
  }

  function renderMacd(candles, macd) {
    const svg = $("macd-chart");
    const grid = $("macd-grid-layer");
    const bars = $("macd-hist-layer");
    const difLine = $("macd-dif-line");
    const deaLine = $("macd-dea-line");
    const W = 1000;
    const H = 190;
    const margin = { top: 22, right: 66, bottom: 8, left: 12, bottomY: 182 };
    const innerW = W - margin.left - margin.right;
    const innerH = margin.bottomY - margin.top;
    const axisTextScaleX = getSvgTextScaleX(svg, W, H);
    const values = [...macd.dif, ...macd.signal, ...macd.histogram].filter(Number.isFinite);
    grid.innerHTML = "";
    bars.innerHTML = "";
    if (candles.length < 2 || !values.length) {
      difLine.setAttribute("d", "");
      deaLine.setAttribute("d", "");
      ["macd-hist-current", "macd-dif-current", "macd-dea-current"].forEach((id) => $(id).textContent = "—");
      svg._chart = null;
      return;
    }
    const extent = Math.max(...values.map(Math.abs), 0.0001) * 1.16;
    const yMin = -extent;
    const yMax = extent;
    const y = (value) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * innerH;
    const x = (index) => indicatorX(index, candles.length, margin, innerW);
    let gridMarkup = indicatorVerticalGrid(margin, W, innerW);
    [yMax, 0, yMin].forEach((value) => {
      const py = y(value);
      gridMarkup += `<line class="${value === 0 ? "indicator-zero" : "indicator-grid"}" x1="${margin.left}" x2="${W - margin.right}" y1="${py}" y2="${py}"></line>`;
      const labelX = W - margin.right + 9;
      gridMarkup += `<text class="axis-text" x="${labelX}" y="${py + 3}"${axisTextTransform(labelX, axisTextScaleX)}>${value.toFixed(2)}</text>`;
    });
    grid.innerHTML = gridMarkup;
    const zeroY = y(0);
    const slot = innerW / candles.length;
    const width = Math.max(1.2, Math.min(8, slot * 0.68));
    bars.innerHTML = macd.histogram.map((value, index) => {
      if (!Number.isFinite(value)) return "";
      const previous = macd.histogram[index - 1];
      const stronger = !Number.isFinite(previous) || Math.abs(value) >= Math.abs(previous);
      const fill = value >= 0
        ? stronger ? "#37d59a" : "#9debd1"
        : stronger ? "#ff6b70" : "#ffc1c3";
      const py = y(value);
      return `<rect x="${(x(index) - width / 2).toFixed(2)}" y="${Math.min(py, zeroY).toFixed(2)}" width="${width.toFixed(2)}" height="${Math.max(1, Math.abs(zeroY - py)).toFixed(2)}" fill="${fill}"></rect>`;
    }).join("");
    const linePath = (series) => {
      let started = false;
      return series.map((value, index) => {
        if (!Number.isFinite(value)) return "";
        const command = started ? "L" : "M";
        started = true;
        return `${command} ${x(index).toFixed(2)},${y(value).toFixed(2)}`;
      }).filter(Boolean).join(" ");
    };
    difLine.setAttribute("d", linePath(macd.dif));
    deaLine.setAttribute("d", linePath(macd.signal));
    const lastIndex = latestFiniteIndex(macd.histogram);
    const histogram = lastIndex >= 0 ? macd.histogram[lastIndex] : null;
    $("macd-hist-current").textContent = Number.isFinite(histogram) ? histogram.toFixed(2) : "—";
    $("macd-hist-current").className = Number.isFinite(histogram) ? histogram >= 0 ? "positive" : "negative" : "";
    $("macd-dif-current").textContent = lastIndex >= 0 ? `DIF ${macd.dif[lastIndex].toFixed(2)}` : "—";
    $("macd-dea-current").textContent = lastIndex >= 0 ? `DEA ${macd.signal[lastIndex].toFixed(2)}` : "—";
    svg._chart = { macd, x, y, W, H, margin };
  }

  function renderRsi(candles, rsi = calculateRsi(candles)) {
    const svg = $("rsi-chart");
    const grid = $("rsi-grid-layer");
    const line = $("rsi-line");
    const zone = $("rsi-zone");
    const current = $("rsi-current");
    const W = 1000;
    const H = 160;
    const margin = { top: 20, right: 66, bottom: 8, left: 12, bottomY: 152 };
    const innerW = W - margin.left - margin.right;
    const innerH = margin.bottomY - margin.top;
    const axisTextScaleX = getSvgTextScaleX(svg, W, H);
    const y = (value) => margin.top + (100 - value) / 100 * innerH;
    let gridMarkup = indicatorVerticalGrid(margin, W, innerW);
    [70, 50, 30].forEach((value) => {
      const py = y(value);
      gridMarkup += `<line class="indicator-guide" x1="${margin.left}" x2="${W - margin.right}" y1="${py}" y2="${py}"></line>`;
      const labelX = W - margin.right + 9;
      gridMarkup += `<text class="axis-text" x="${labelX}" y="${py + 3}"${axisTextTransform(labelX, axisTextScaleX)}>${value}</text>`;
    });
    grid.innerHTML = gridMarkup;
    zone.setAttribute("d", `M ${margin.left},${y(70)} H ${W - margin.right} V ${y(30)} H ${margin.left} Z`);
    const usable = rsi.map((value, index) => Number.isFinite(value) ? { value, index } : null).filter(Boolean);
    if (!usable.length) {
      line.setAttribute("d", "");
      current.textContent = "—";
      svg._chart = null;
      return;
    }
    const x = (index) => indicatorX(index, candles.length, margin, innerW);
    line.setAttribute("d", usable.map(({ value, index }, pointIndex) =>
      `${pointIndex ? "L" : "M"} ${x(index).toFixed(2)},${y(value).toFixed(2)}`
    ).join(" "));
    current.textContent = usable[usable.length - 1].value.toFixed(2);
    svg._chart = { rsi, x, y, W, H, margin };
  }

  function getTimelineWindow() {
    const count = state.candles.length;
    if (!count) return {
      startIndex: 0,
      endIndex: -1,
      candles: [],
      rsi: [],
      ma20: [],
      ma60: [],
      macd: { dif: [], signal: [], histogram: [] }
    };
    const { startIndex, endIndex } = getTimelineIndexBounds(count);
    const fullRsi = calculateRsi(state.candles);
    const fullMa20 = calculateSmaSeries(state.candles, 20);
    const fullMa60 = calculateSmaSeries(state.candles, 60);
    const fullMacd = calculateMacdSeries(state.candles);
    return {
      startIndex,
      endIndex,
      candles: state.candles.slice(startIndex, endIndex + 1),
      rsi: fullRsi.slice(startIndex, endIndex + 1),
      ma20: fullMa20.slice(startIndex, endIndex + 1),
      ma60: fullMa60.slice(startIndex, endIndex + 1),
      macd: {
        dif: fullMacd.dif.slice(startIndex, endIndex + 1),
        signal: fullMacd.signal.slice(startIndex, endIndex + 1),
        histogram: fullMacd.histogram.slice(startIndex, endIndex + 1)
      }
    };
  }

  function renderMovingAverage(pathId, candles, values, visible, x, y, intervalMs) {
    const path = $(pathId);
    if (!visible) {
      path.setAttribute("d", "");
      return;
    }
    const points = [];
    for (let index = 0; index < candles.length; index += 1) {
      if (!Number.isFinite(values[index])) continue;
      const px = x(candles[index].t + intervalMs / 2);
      const py = y(values[index]);
      points.push(`${points.length ? "L" : "M"} ${px.toFixed(2)},${py.toFixed(2)}`);
    }
    path.setAttribute("d", points.join(" "));
  }

  function syncTimelineInputs() {
    $("timeline-start").value = String(state.timelineStart);
    $("timeline-end").value = String(state.timelineEnd);
  }

  function getMinimumTimelineGap() {
    const intervals = Math.max(1, state.candles.length - 1);
    const candleGap = 100 * Math.min(MIN_VISIBLE_CANDLES, intervals) / intervals;
    return Math.min(MAX_MINIMUM_GAP, Math.max(MIN_TIMELINE_PERCENT, candleGap));
  }

  function calculateZoomWindow(start, end, anchorRatio, scale, minimumGap) {
    const currentSpan = Math.max(minimumGap, end - start);
    const nextSpan = Math.max(minimumGap, Math.min(100, currentSpan * scale));
    if (nextSpan >= 100) return { start: 0, end: 100 };

    const anchor = Math.max(0, Math.min(1, anchorRatio));
    const anchorPosition = start + currentSpan * anchor;
    let nextStart = anchorPosition - nextSpan * anchor;
    let nextEnd = nextStart + nextSpan;
    if (nextStart < 0) {
      nextEnd -= nextStart;
      nextStart = 0;
    }
    if (nextEnd > 100) {
      nextStart -= nextEnd - 100;
      nextEnd = 100;
    }
    return {
      start: Math.max(0, nextStart),
      end: Math.min(100, nextEnd)
    };
  }

  function calculatePanWindow(start, end, deltaX, plotWidth) {
    const span = Math.max(0, Math.min(100, end - start));
    if (!Number.isFinite(deltaX) || !Number.isFinite(plotWidth) || plotWidth <= 0 || span >= 100) {
      return { start, end };
    }
    const shift = -deltaX / plotWidth * span;
    const nextStart = Math.max(0, Math.min(100 - span, start + shift));
    return { start: nextStart, end: nextStart + span };
  }

  function renderTimeline() {
    const candles = state.candles;
    const line = $("timeline-line");
    const area = $("timeline-area");
    const selection = $("timeline-selection");
    selection.style.left = `${state.timelineStart}%`;
    selection.style.width = `${Math.max(0, state.timelineEnd - state.timelineStart)}%`;
    if (candles.length < 2) {
      line.setAttribute("d", "");
      area.setAttribute("d", "");
      $("timeline-start-label").textContent = "—";
      $("timeline-end-label").textContent = "—";
      $("timeline-window").textContent = "等待行情";
      return;
    }
    const W = 1000;
    const H = 48;
    const closes = candles.map((candle) => candle.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const x = (index) => index / Math.max(1, candles.length - 1) * W;
    const y = (value) => 5 + (1 - (value - min) / Math.max(0.0001, max - min)) * (H - 10);
    const points = closes.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`);
    line.setAttribute("d", `M ${points.join(" L ")}`);
    area.setAttribute("d", `M 0,${H} L ${points.join(" L ")} L ${W},${H} Z`);
    const view = getTimelineWindow();
    const start = candles[view.startIndex];
    const end = candles[view.endIndex];
    $("timeline-start-label").textContent = formatTime(start.t, true);
    $("timeline-end-label").textContent = formatTime(end.t, true);
    $("timeline-window").textContent = `${view.candles.length}根 · ${formatTime(start.t, true)} 至 ${formatTime(end.t, true)}`;
  }

  function updateTimeline(source) {
    const minimumGap = getMinimumTimelineGap();
    const startInput = $("timeline-start");
    const endInput = $("timeline-end");
    let start = Number(startInput.value);
    let end = Number(endInput.value);
    if (source === "start" && start > end - minimumGap) start = end - minimumGap;
    if (source === "end" && end < start + minimumGap) end = start + minimumGap;
    state.timelineStart = Math.max(0, Math.min(100 - minimumGap, start));
    state.timelineEnd = Math.min(100, Math.max(minimumGap, end));
    state.rightBlankRatio = 0;
    syncTimelineInputs();
    hideTooltip();
    renderChart();
  }

  function zoomChartWithWheel(event) {
    const chart = $("price-chart")._chart;
    if (!chart || state.candles.length < 2 || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();

    const anchorRatio = 1;
    const deltaMultiplier = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? Math.max(1, window.innerHeight)
        : 1;
    const normalizedDelta = Math.max(-240, Math.min(240, event.deltaY * deltaMultiplier));
    const currentSpan = state.timelineEnd - state.timelineStart;
    if (normalizedDelta > 0 && currentSpan >= 99.999 && getNextHistoryRange()) {
      latestWheelPointer = null;
      void expandHistoryRange();
      return;
    }
    const scale = Math.exp(normalizedDelta * WHEEL_ZOOM_SENSITIVITY);
    const next = calculateZoomWindow(
      state.timelineStart,
      state.timelineEnd,
      anchorRatio,
      scale,
      getMinimumTimelineGap()
    );
    state.timelineStart = next.start;
    state.timelineEnd = next.end;
    if (next.end < 99.999) state.rightBlankRatio = 0;
    syncTimelineInputs();
    hideTooltip();
    latestWheelPointer = { clientX: event.clientX, clientY: event.clientY };

    if (wheelRenderFrame) return;
    wheelRenderFrame = requestAnimationFrame(() => {
      wheelRenderFrame = 0;
      renderChart();
      if (latestWheelPointer) showTooltip(latestWheelPointer);
      latestWheelPointer = null;
    });
  }

  function beginChartPan(event) {
    const chart = $("price-chart")._chart;
    if (event.button !== 0 || !chart || state.candles.length < 2) return;
    event.preventDefault();
    chartPanState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      timelineStart: state.timelineStart,
      timelineEnd: state.timelineEnd,
      rightBlankRatio: state.rightBlankRatio
    };
    $("chart-stage").setPointerCapture(event.pointerId);
    $("chart-stage").classList.add("dragging");
    hideTooltip();
  }

  function moveChartPan(event) {
    if (!chartPanState || event.pointerId !== chartPanState.pointerId) return;
    event.preventDefault();
    const chart = $("price-chart")._chart;
    if (!chart) return;
    const rect = $("price-chart").getBoundingClientRect();
    const plotWidth = rect.width *
      (chart.W - chart.margin.left - chart.margin.right) / Math.max(1, chart.W);
    const deltaX = event.clientX - chartPanState.startX;
    const span = chartPanState.timelineEnd - chartPanState.timelineStart;
    const adjustsFutureSpace = chartPanState.rightBlankRatio > 0 ||
      (chartPanState.timelineEnd >= 99.999 && deltaX < 0);
    if (adjustsFutureSpace) {
      state.rightBlankRatio = Math.max(0, Math.min(
        MAX_RIGHT_BLANK_RATIO,
        chartPanState.rightBlankRatio - deltaX / Math.max(1, plotWidth)
      ));
      hideTooltip();
      if (panRenderFrame) return;
      panRenderFrame = requestAnimationFrame(() => {
        panRenderFrame = 0;
        renderChart();
      });
      return;
    }
    state.rightBlankRatio = 0;
    const requestedShift = -deltaX / Math.max(1, plotWidth) * span;
    const requestedStart = chartPanState.timelineStart + requestedShift;
    const reachesRangeBoundary = requestedStart < 0 || span >= 99.999;
    if (Math.abs(deltaX) >= PAN_EXPANSION_THRESHOLD && reachesRangeBoundary && getNextHistoryRange()) {
      endChartPan(event);
      void expandHistoryRange();
      return;
    }
    const next = calculatePanWindow(
      chartPanState.timelineStart,
      chartPanState.timelineEnd,
      deltaX,
      plotWidth
    );
    state.timelineStart = next.start;
    state.timelineEnd = next.end;
    syncTimelineInputs();
    hideTooltip();

    if (panRenderFrame) return;
    panRenderFrame = requestAnimationFrame(() => {
      panRenderFrame = 0;
      renderChart();
    });
  }

  function endChartPan(event) {
    if (!chartPanState || event.pointerId !== chartPanState.pointerId) return;
    const chartWrap = $("chart-stage");
    chartPanState = null;
    chartWrap.classList.remove("dragging");
    if (chartWrap.hasPointerCapture(event.pointerId)) chartWrap.releasePointerCapture(event.pointerId);
    hideTooltip();
  }

  function toggleMovingAverage(period) {
    const key = period === 20 ? "showMa20" : "showMa60";
    const button = $(period === 20 ? "ma20-toggle" : "ma60-toggle");
    state[key] = !state[key];
    button.classList.toggle("active", state[key]);
    button.setAttribute("aria-pressed", String(state[key]));
    hideTooltip();
    renderChart();
  }

  function getSvgTextScaleX(svg, width, height) {
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width / Math.max(1, width);
    const scaleY = rect.height / Math.max(1, height);
    return scaleX > 0 && scaleY > 0 ? scaleY / scaleX : 1;
  }

  function axisTextTransform(anchorX, scaleX) {
    if (!Number.isFinite(scaleX) || Math.abs(scaleX - 1) < 0.001) return "";
    const x = Number(anchorX.toFixed(2));
    return ` transform="translate(${x} 0) scale(${scaleX.toFixed(4)} 1) translate(${-x} 0)"`;
  }

  function clampTooltip(value, minimum, maximum) {
    return Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
  }

  function positionTooltipAwayFromPointer(event, tooltip) {
    const chartWrap = $("chart-wrap");
    const bounds = chartWrap.getBoundingClientRect();
    const pointerX = clampTooltip(event.clientX - bounds.left, 0, bounds.width);
    const pointerY = clampTooltip(event.clientY - bounds.top, 0, bounds.height);
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const rightPosition = pointerX + TOOLTIP_HORIZONTAL_GAP;
    const leftPosition = pointerX - tooltipWidth - TOOLTIP_HORIZONTAL_GAP;
    const belowPosition = pointerY + TOOLTIP_VERTICAL_GAP;
    const abovePosition = pointerY - tooltipHeight - TOOLTIP_VERTICAL_GAP;
    const canFitRight = rightPosition + tooltipWidth <= bounds.width - TOOLTIP_EDGE_GAP;
    const canFitLeft = leftPosition >= TOOLTIP_EDGE_GAP;
    const canFitBelow = belowPosition + tooltipHeight <= bounds.height - TOOLTIP_EDGE_GAP;
    const canFitAbove = abovePosition >= TOOLTIP_EDGE_GAP;

    let left;
    if (pointerX <= bounds.width / 2 && canFitRight) left = rightPosition;
    else if (pointerX > bounds.width / 2 && canFitLeft) left = leftPosition;
    else if (canFitRight) left = rightPosition;
    else if (canFitLeft) left = leftPosition;
    else left = pointerX <= bounds.width / 2 ? bounds.width - tooltipWidth - TOOLTIP_EDGE_GAP : TOOLTIP_EDGE_GAP;

    let top;
    if (pointerY <= bounds.height / 2 && canFitBelow) top = belowPosition;
    else if (pointerY > bounds.height / 2 && canFitAbove) top = abovePosition;
    else if (canFitBelow) top = belowPosition;
    else if (canFitAbove) top = abovePosition;
    else top = pointerY <= bounds.height / 2 ? bounds.height - tooltipHeight - TOOLTIP_EDGE_GAP : TOOLTIP_EDGE_GAP;

    tooltip.style.left = `${clampTooltip(left, TOOLTIP_EDGE_GAP, bounds.width - tooltipWidth - TOOLTIP_EDGE_GAP)}px`;
    tooltip.style.top = `${clampTooltip(top, TOOLTIP_EDGE_GAP, bounds.height - tooltipHeight - TOOLTIP_EDGE_GAP)}px`;
  }

  function renderChart() {
    const svg = $("price-chart");
    const grid = $("grid-layer");
    const candleLayer = $("candle-layer");
    const view = getTimelineWindow();
    const candles = view.candles;
    const W = 1000;
    const H = 710;
    const margin = { top: 14, right: 66, bottom: 31, left: 12 };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;
    const contentOffsetX = state.rightBlankRatio * innerW;
    const axisTextScaleX = getSvgTextScaleX(svg, W, H);
    grid.innerHTML = "";
    candleLayer.innerHTML = "";

    if (candles.length < 2) {
      $("empty-state").textContent = "当前时段没有足够的行情数据";
      $("empty-state").style.display = "grid";
      ["stat-last", "stat-max", "stat-min"].forEach((id) => $(id).textContent = "—");
      $("stat-count").textContent = "0 根";
      $("ma20-line").setAttribute("d", "");
      $("ma60-line").setAttribute("d", "");
      svg._chart = null;
      renderVolume([]);
      renderMacd([], { dif: [], signal: [], histogram: [] });
      renderRsi([]);
      renderTimeline();
      return;
    }
    $("empty-state").style.display = "none";

    const visibleStartIndex = Math.min(candles.length - 2, Math.max(0, Math.floor(state.rightBlankRatio * candles.length)));
    const verticallyVisibleCandles = candles.slice(visibleStartIndex);
    let minRaw = Infinity;
    let maxRaw = -Infinity;
    for (const candle of verticallyVisibleCandles) {
      if (candle.low < minRaw) minRaw = candle.low;
      if (candle.high > maxRaw) maxRaw = candle.high;
    }
    const overlayValues = [];
    if (state.showMa20) overlayValues.push(...view.ma20.slice(visibleStartIndex).filter(Number.isFinite));
    if (state.showMa60) overlayValues.push(...view.ma60.slice(visibleStartIndex).filter(Number.isFinite));
    for (const value of overlayValues) {
      if (value < minRaw) minRaw = value;
      if (value > maxRaw) maxRaw = value;
    }
    const padding = Math.max((maxRaw - minRaw) * 0.14, 0.5);
    let yMin = minRaw - padding;
    let yMax = maxRaw + padding;
    if (yMax === yMin) {
      yMax += 1;
      yMin -= 1;
    }

    const intervalMs = INTERVALS[state.interval].ms;
    const tMin = candles[0].t;
    const tMax = candles[candles.length - 1].t + intervalMs;
    const x = (time) => margin.left + ((time - tMin) / Math.max(1, tMax - tMin)) * innerW - contentOffsetX;
    const y = (value) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * innerH;

    let gridMarkup = "";
    for (let index = 0; index <= 4; index += 1) {
      const value = yMax - (index / 4) * (yMax - yMin);
      const py = margin.top + (index / 4) * innerH;
      gridMarkup += `<line class="chart-grid" x1="${margin.left}" x2="${W - margin.right}" y1="${py}" y2="${py}"></line>`;
      const labelX = W - margin.right + 9;
      gridMarkup += `<text class="axis-text" x="${labelX}" y="${py + 3}"${axisTextTransform(labelX, axisTextScaleX)}>${priceFormat.format(value)}</text>`;
    }
    for (let index = 0; index <= 4; index += 1) {
      const px = margin.left + innerW * index / 4;
      const dataX = px + contentOffsetX;
      const labelTime = tMin + ((dataX - margin.left) / innerW) * (tMax - tMin);
      const anchor = index === 0 ? "start" : index === 4 ? "end" : "middle";
      gridMarkup += `<line class="chart-grid" x1="${px}" x2="${px}" y1="${margin.top}" y2="${H - margin.bottom}"></line>`;
      gridMarkup += `<text class="axis-text" x="${px}" y="${H - 8}" text-anchor="${anchor}"${axisTextTransform(px, axisTextScaleX)}>${formatTime(labelTime, true)}</text>`;
    }
    grid.innerHTML = gridMarkup;

    const slot = innerW / candles.length;
    const bodyWidth = Math.max(1.4, Math.min(8, slot * 0.68));
    let candleMarkup = "";
    for (const candle of candles) {
      const center = x(candle.t + intervalMs / 2);
      const highY = y(candle.high);
      const lowY = y(candle.low);
      const openY = y(candle.open);
      const closeY = y(candle.close);
      const bodyY = Math.min(openY, closeY);
      const bodyHeight = Math.max(1.2, Math.abs(closeY - openY));
      const direction = candle.close > candle.open
        ? "candle-up"
        : candle.close < candle.open
          ? "candle-down"
          : "candle-flat";
      candleMarkup += `<g class="${direction}">`;
      candleMarkup += `<line class="candle-wick" x1="${center.toFixed(2)}" x2="${center.toFixed(2)}" y1="${highY.toFixed(2)}" y2="${lowY.toFixed(2)}"></line>`;
      candleMarkup += `<rect class="candle-body" x="${(center - bodyWidth / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}"></rect>`;
      candleMarkup += "</g>";
    }
    candleLayer.innerHTML = candleMarkup;
    renderMovingAverage("ma20-line", candles, view.ma20, state.showMa20, x, y, intervalMs);
    renderMovingAverage("ma60-line", candles, view.ma60, state.showMa60, x, y, intervalMs);

    $("stat-last").textContent = `${priceFormat.format(candles[candles.length - 1].close)} USDT`;
    $("stat-max").textContent = `${priceFormat.format(maxRaw)} USDT`;
    $("stat-min").textContent = `${priceFormat.format(minRaw)} USDT`;
    $("stat-count").textContent = `${candles.length} 根`;
    updateChartCopy();
    svg._chart = {
      candles,
      rsi: view.rsi,
      macd: view.macd,
      ma20: view.ma20,
      ma60: view.ma60,
      x,
      y,
      margin,
      W,
      H,
      yMin,
      yMax,
      tMin,
      tMax,
      contentOffsetX,
      intervalMs
    };
    renderVolume(candles);
    renderMacd(candles, view.macd);
    renderRsi(candles, view.rsi);
    renderTimeline();
  }

  function showTooltip(event) {
    if (chartPanState) return;
    const chart = $("price-chart")._chart;
    if (!chart) return;
    const rect = $("price-chart").getBoundingClientRect();
    const localX = Math.max(
      chart.margin.left,
      Math.min(chart.W - chart.margin.right, (event.clientX - rect.left) / rect.width * chart.W)
    );
    const dataLocalX = Math.min(chart.W - chart.margin.right, localX + chart.contentOffsetX);
    const localY = Math.max(
      chart.margin.top,
      Math.min(chart.H - chart.margin.bottom, (event.clientY - rect.top) / rect.height * chart.H)
    );
    const targetTime = chart.tMin +
      ((dataLocalX - chart.margin.left) / (chart.W - chart.margin.left - chart.margin.right)) *
      (chart.tMax - chart.tMin);
    let low = 0;
    let high = chart.candles.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (chart.candles[middle].t + chart.intervalMs / 2 < targetTime) low = middle + 1;
      else high = middle;
    }
    let index = low;
    if (low > 0) {
      const currentDistance = Math.abs(chart.candles[low].t + chart.intervalMs / 2 - targetTime);
      const previousDistance = Math.abs(chart.candles[low - 1].t + chart.intervalMs / 2 - targetTime);
      if (previousDistance < currentDistance) index = low - 1;
    }
    const candle = chart.candles[index];
    const pointerInPriceChart = event.clientY >= rect.top && event.clientY <= rect.bottom;
    const priceRatio = (localY - chart.margin.top) /
      (chart.H - chart.margin.top - chart.margin.bottom);
    const pointerPrice = chart.yMax - priceRatio * (chart.yMax - chart.yMin);
    $("hover-line").setAttribute("x1", localX);
    $("hover-line").setAttribute("x2", localX);
    $("hover-horizontal-line").setAttribute("y1", localY);
    $("hover-horizontal-line").setAttribute("y2", localY);
    $("hover-point").setAttribute("cx", localX);
    $("hover-point").setAttribute("cy", localY);
    $("hover-horizontal-line").style.display = pointerInPriceChart ? "block" : "none";
    $("hover-point").style.display = pointerInPriceChart ? "block" : "none";
    $("hover-layer").setAttribute("visibility", "visible");
    const priceLabel = $("hover-price-label");
    priceLabel.textContent = priceFormat.format(pointerPrice);
    priceLabel.style.top = `${localY / chart.H * 100}%`;
    priceLabel.classList.toggle("visible", pointerInPriceChart);

    const rsiValue = chart.rsi[index];
    const macdValue = chart.macd.histogram[index];
    const difValue = chart.macd.dif[index];
    const deaValue = chart.macd.signal[index];
    const volumeChart = $("volume-chart")._chart;
    if (volumeChart) {
      const volumeX = localX;
      $("volume-hover-line").setAttribute("x1", volumeX);
      $("volume-hover-line").setAttribute("x2", volumeX);
      $("volume-hover-layer").setAttribute("visibility", "visible");
    }
    const macdChart = $("macd-chart")._chart;
    if (macdChart) {
      const macdX = localX;
      $("macd-hover-line").setAttribute("x1", macdX);
      $("macd-hover-line").setAttribute("x2", macdX);
      [["macd-dif-point", difValue], ["macd-dea-point", deaValue]].forEach(([id, value]) => {
        const point = $(id);
        if (Number.isFinite(value)) {
          point.setAttribute("cx", macdX);
          point.setAttribute("cy", macdChart.y(value));
          point.style.display = "block";
        } else {
          point.style.display = "none";
        }
      });
      $("macd-hover-layer").setAttribute("visibility", "visible");
    }
    const rsiChart = $("rsi-chart")._chart;
    if (rsiChart) {
      const rsiX = localX;
      $("rsi-hover-line").setAttribute("x1", rsiX);
      $("rsi-hover-line").setAttribute("x2", rsiX);
      if (Number.isFinite(rsiValue)) {
        $("rsi-hover-point").setAttribute("cx", rsiX);
        $("rsi-hover-point").setAttribute("cy", rsiChart.y(rsiValue));
        $("rsi-hover-point").style.display = "block";
      } else {
        $("rsi-hover-point").style.display = "none";
      }
      $("rsi-hover-layer").setAttribute("visibility", "visible");
    }

    const tooltip = $("tooltip");
    $("tooltip-time").textContent = `${formatTime(candle.t, true)} · ${INTERVALS[state.interval].label}`;
    $("tooltip-open").textContent = priceFormat.format(candle.open);
    $("tooltip-high").textContent = priceFormat.format(candle.high);
    $("tooltip-low").textContent = priceFormat.format(candle.low);
    $("tooltip-close").textContent = priceFormat.format(candle.close);
    $("tooltip-change").textContent = `${signed((candle.close / candle.open - 1) * 100)}%`;
    const ma20 = chart.ma20[index];
    const ma60 = chart.ma60[index];
    $("tooltip-ma20-row").style.display = state.showMa20 && Number.isFinite(ma20) ? "flex" : "none";
    $("tooltip-ma60-row").style.display = state.showMa60 && Number.isFinite(ma60) ? "flex" : "none";
    $("tooltip-ma20").textContent = Number.isFinite(ma20) ? priceFormat.format(ma20) : "—";
    $("tooltip-ma60").textContent = Number.isFinite(ma60) ? priceFormat.format(ma60) : "—";
    $("tooltip-volume").textContent = volumeFormat.format(candle.volume);
    $("tooltip-macd").textContent = Number.isFinite(macdValue) ? macdValue.toFixed(2) : "—";
    $("tooltip-macd-lines").textContent = Number.isFinite(difValue) && Number.isFinite(deaValue)
      ? `${difValue.toFixed(2)} / ${deaValue.toFixed(2)}`
      : "—";
    $("tooltip-rsi").textContent = Number.isFinite(rsiValue) ? rsiValue.toFixed(2) : "—";
    positionTooltipAwayFromPointer(event, tooltip);
    tooltip.classList.add("visible");
  }

  function hideTooltip() {
    $("tooltip").classList.remove("visible");
    $("hover-price-label").classList.remove("visible");
    $("hover-layer").setAttribute("visibility", "hidden");
    $("volume-hover-layer").setAttribute("visibility", "hidden");
    $("macd-hover-layer").setAttribute("visibility", "hidden");
    $("rsi-hover-layer").setAttribute("visibility", "hidden");
  }

  function updateIntervalButtons() {
    $("interval-group").innerHTML = CHART_INTERVALS.map((interval) =>
      `<button class="chart-button${interval === state.interval ? " active" : ""}" data-interval="${interval}" type="button">${INTERVALS[interval].short}</button>`
    ).join("");
    $("interval-group").querySelectorAll("[data-interval]").forEach((button) => {
      button.addEventListener("click", () => {
        state.interval = button.dataset.interval;
        updateIntervalButtons();
        loadHistory({ anchorLatest: true });
      });
    });
  }

  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      updateRangeButtons();
      loadHistory({ anchorLatest: true });
    });
  });

  document.querySelectorAll("[data-symbol]").forEach((button) => {
    button.addEventListener("click", () => switchSymbol(button.dataset.symbol));
  });

  $("ma20-toggle").addEventListener("click", () => toggleMovingAverage(20));
  $("ma60-toggle").addEventListener("click", () => toggleMovingAverage(60));

  $("chart-stage").addEventListener("pointermove", showTooltip, { passive: true });
  $("chart-stage").addEventListener("pointerleave", hideTooltip);
  $("chart-stage").addEventListener("pointerdown", beginChartPan);
  $("chart-stage").addEventListener("pointermove", moveChartPan, { passive: false });
  $("chart-stage").addEventListener("pointerup", endChartPan);
  $("chart-stage").addEventListener("pointercancel", endChartPan);
  $("chart-stage").addEventListener("lostpointercapture", endChartPan);
  $("chart-stage").addEventListener("wheel", zoomChartWithWheel, { passive: false });
  $("timeline-start").addEventListener("input", () => updateTimeline("start"));
  $("timeline-end").addEventListener("input", () => updateTimeline("end"));
  window.addEventListener("resize", () => {
    if (resizeRenderFrame) return;
    resizeRenderFrame = requestAnimationFrame(() => {
      resizeRenderFrame = 0;
      hideTooltip();
      renderChart();
    });
  }, { passive: true });

  updateSymbolUI();
  updateIntervalButtons();
  updateChartCopy();
  syncTimelineInputs();
  seedCurrentData();
  loadHistory();
  loadAnalysis();
  connectBinance();
  setInterval(() => {
    if (!state.wsOk) seedCurrentData();
  }, 5000);
  setInterval(setLiveStatus, 1000);
  setInterval(loadHistory, 60000);
  setInterval(loadAnalysis, 60000);
})();
