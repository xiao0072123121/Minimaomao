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
    $("analysis-status").textContent = "正在读取 H4、H1、M15 已收盘K线…";
    for (const key of Object.keys(ANALYSIS_FRAMES)) {
      $(`${key}-card`).dataset.bias = "neutral";
      $(`${key}-state`).textContent = "计算中";
      $(`${key}-direction-score`).textContent = "—";
      $(`${key}-setup-score`).textContent = "—";
      $(`${key}-confidence`).textContent = "—";
      $(`${key}-structure`).textContent = `等待${ANALYSIS_FRAMES[key].label} K线…`;
      [`${key}-opportunity`, `${key}-rsi`, `${key}-macd`, `${key}-levels`].forEach((id) => $(id).textContent = "—");
      $(`${key}-conclusion`).textContent = "正在生成动态判断…";
    }
    renderIntradayStrategy({});
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
    $("chart-note").textContent = `数据来自 Binance Futures 公开接口；${INTERVALS[state.interval].label}，红色上涨，绿色下跌；滚轮以最右侧K线为锚点缩放，主图支持左键拖动和触边自动扩展时间范围。`;
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

  function calculateMacd(candles) {
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
    if (firstDif < 0 || closes.length - firstDif < 9) return null;
    let dea = dif.slice(firstDif, firstDif + 9).reduce((sum, value) => sum + value, 0) / 9;
    signal[firstDif + 8] = dea;
    const alpha = 2 / 10;
    for (let index = firstDif + 9; index < dif.length; index += 1) {
      dea = dif[index] * alpha + dea * (1 - alpha);
      signal[index] = dea;
    }
    const lastIndex = closes.length - 1;
    const previousIndex = lastIndex - 1;
    if (!Number.isFinite(signal[previousIndex]) || !Number.isFinite(signal[lastIndex])) return null;
    return {
      dif: dif[lastIndex],
      signal: signal[lastIndex],
      histogram: dif[lastIndex] - signal[lastIndex],
      previousDif: dif[previousIndex],
      previousSignal: signal[previousIndex],
      previousHistogram: dif[previousIndex] - signal[previousIndex]
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
    if (value >= 70) return `RSI=${number}，进入超买区，趋势虽强但需防范高位回落。`;
    if (value >= 60) return `RSI=${number}，处于偏强区域，多头动能占优。`;
    if (value >= 50) return `RSI=${number}，位于中轴上方，多方略占优势。`;
    if (value >= 40) return `RSI=${number}，处于偏弱区域，尚未进入超卖。`;
    if (value >= 30) return `RSI=${number}，弱势并接近超卖，关注止跌信号。`;
    return `RSI=${number}，进入超卖区，空头占优但反弹概率上升。`;
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
    return {
      bias: sign > 0 ? "bullish" : "bearish",
      sign,
      score: Math.round(clamp(score, 0, 100)),
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
    const best = bullish.score >= bearish.score ? bullish : bearish;
    const difference = Math.abs(bullish.score - bearish.score);
    if (best.score < 45 || difference < 6) {
      return { bias: "neutral", sign: 0, score: best.score, label: "双向等待", tone: "wait", difference };
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
    return { ...best, label, tone: setupTone(best, result), difference };
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
    result.longSetupScoreBase = result.longSetup.score;
    result.shortSetupScoreBase = result.shortSetup.score;
    result.confidenceScore = calculateConfidence(directionScore, [
      priceComponent,
      spreadComponent,
      ma20SlopeComponent,
      ma60SlopeComponent,
      structureComponent,
      closeComponent,
      momentumScore * 0.35
    ]);
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
    return `${trend}、${momentum}，${confirmation}${pattern}`;
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
      conclusions.h4 = `H4为${h4.marketState.label}（方向分${signed(h4.directionScore, 0)}）：${signalSummary(h4)}。${setupSummary(h4)}${proximityText(h4)}`;
    }
    if (h1) {
      const relation = h1.opportunityContext || "与H4尚未形成明确共振";
      conclusions.h1 = `H1为${h1.marketState.label}（方向分${signed(h1.directionScore, 0)}），${relation}：${signalSummary(h1)}。${setupSummary(h1)}${proximityText(h1)}`;
    }
    if (m15) {
      const relation = m15.opportunityContext || "上级周期尚未完全配合";
      conclusions.m15 = `M15为${m15.marketState.label}（方向分${signed(m15.directionScore, 0)}），${relation}：${signalSummary(m15)}。${setupSummary(m15)}${proximityText(m15)}`;
    }
    return conclusions;
  }

  function emptyIntradayStrategy(reason = "等待H1与M15已收盘K线完成计算。") {
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
      stopLoss = Number.isFinite(stopAnchor)
        ? Math.min(stopAnchor - atr * 0.2, entry - atr * 0.75)
        : entry - atr;
      const risk = Math.max(atr * 0.25, entry - stopLoss);
      takeProfit = resistances[0] || entry + risk * 1.5;
      const secondResistance = resistances.find((value) => value > takeProfit + atr * 0.2);
      const target = Math.max(secondResistance || 0, entry + risk * 2);
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
    stopLoss = Number.isFinite(stopAnchor)
      ? Math.max(stopAnchor + atr * 0.2, entry + atr * 0.75)
      : entry + atr;
    const risk = Math.max(atr * 0.25, stopLoss - entry);
    takeProfit = supports[0] || entry - risk * 1.5;
    const secondSupport = supports.find((value) => value < takeProfit - atr * 0.2);
    const target = Math.min(Number.isFinite(secondSupport) ? secondSupport : Infinity, entry - risk * 2);
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

  function intradayPriority(candidateBias, compositeScore, h4, h1, m15) {
    const h1Aligned = h1.opportunity.bias === candidateBias;
    const m15Aligned = m15.opportunity.bias === candidateBias;
    const h4Aligned = h4?.bias === candidateBias;
    const h4Opposed = Boolean(h4 && h4.bias !== "neutral" && h4.bias !== candidateBias);
    if (h1Aligned && m15Aligned && h4Aligned && compositeScore >= 65) {
      return { code: "A", label: "A · 顺势优先", rank: 3 };
    }
    if (h1Aligned && m15Aligned && !h4Opposed && compositeScore >= 55) {
      return { code: "B", label: "B · 同周期共振", rank: 2 };
    }
    if (h1Aligned && m15Aligned && h4Opposed) {
      return { code: "C", label: "C · 逆势谨慎", rank: 1 };
    }
    return { code: "C", label: "C · 等待强化", rank: 1 };
  }

  function buildIntradayStrategy(results, entryPrice) {
    const { h4, h1, m15 } = results;
    if (!h1 || !m15) return emptyIntradayStrategy();
    const longScore = Math.round(h1.longSetup.score * 0.6 + m15.longSetup.score * 0.4);
    const shortScore = Math.round(h1.shortSetup.score * 0.6 + m15.shortSetup.score * 0.4);
    const candidateBias = longScore >= shortScore ? "bullish" : "bearish";
    const compositeScore = Math.max(longScore, shortScore);
    const scoreEdge = Math.abs(longScore - shortScore);
    const h1Signal = h1.opportunity.bias;
    const m15Signal = m15.opportunity.bias;
    const stateSummary = `H4 ${h4?.marketState.label || "数据不足"}，H1 ${h1.marketState.label}，M15 ${m15.marketState.label}；多方综合${longScore}，空方综合${shortScore}。`;

    if (h1Signal !== "neutral" && m15Signal !== "neutral" && h1Signal !== m15Signal) {
      return {
        ...emptyIntradayStrategy(`${stateSummary} H1与M15机会方向冲突，暂不执行。`),
        longScore,
        shortScore,
        trigger: h1Signal === "bearish"
          ? `等待M15转为空方并确认跌破支撑 ${h1.supportZone}。`
          : `等待M15转为多方并确认突破压力 ${h1.resistanceZone}。`
      };
    }
    if (compositeScore < 48 || scoreEdge < 6) {
      return {
        ...emptyIntradayStrategy(`${stateSummary} 多空优势不足，暂不强行选择方向。`),
        longScore,
        shortScore,
        trigger: `等待H1与M15同向，且多空综合分差扩大到6分以上。`
      };
    }
    if (h1Signal !== "neutral" && h1Signal !== candidateBias) {
      return {
        ...emptyIntradayStrategy(`${stateSummary} 综合分与H1主要机会方向不一致，暂不执行。`),
        longScore,
        shortScore,
        trigger: "等待H1机会方向与M15触发方向重新一致。"
      };
    }

    const entry = Number.isFinite(entryPrice) ? entryPrice : m15.price;
    const levels = calculateIntradayLevels(candidateBias, entry, h1, m15);
    const priority = intradayPriority(candidateBias, compositeScore, h4, h1, m15);
    const directionName = candidateBias === "bullish" ? "做多" : "做空";
    const structuralNote = candidateBias === "bullish"
      ? `止损设置在最近有效支撑下方，第一止盈参考上方压力。`
      : `止损设置在最近有效压力上方，第一止盈参考下方支撑。`;
    const trigger = candidateBias === "bullish"
      ? `执行条件：价格进入参考区后，M15保持多方机会且未跌破 ${m15.supportZone}；跌破止损位则策略失效。`
      : `执行条件：价格进入参考区后，M15保持空方机会且未突破 ${m15.resistanceZone}；突破止损位则策略失效。`;
    if (levels.rewardRisk1 < 1.2) {
      return {
        bias: "neutral",
        candidateBias,
        actionable: false,
        directionLabel: `观望 · 候选${directionName}`,
        priority: "等待 · 盈亏比不足",
        score: compositeScore,
        longScore,
        shortScore,
        ...levels,
        summary: `${stateSummary} 候选${directionName}的第一目标盈亏比仅1:${levels.rewardRisk1.toFixed(2)}，低于1:1.20执行门槛。`,
        trigger: `等待价格改善或目标空间扩大后再评估。${structuralNote}`
      };
    }
    const rrPriority = levels.rewardRisk1 < 1.5 && priority.rank > 1
      ? priority.code === "A" ? "B · 盈亏比降级" : "C · 盈亏比一般"
      : priority.label;
    return {
      bias: candidateBias,
      candidateBias,
      actionable: true,
      directionLabel: directionName,
      priority: rrPriority,
      score: compositeScore,
      longScore,
      shortScore,
      ...levels,
      summary: `${stateSummary} ${directionName}条件领先。${structuralNote}`,
      trigger
    };
  }

  function strategyPrice(value) {
    return Number.isFinite(value) ? priceFormat.format(value) : "—";
  }

  function renderIntradayStrategy(results = state.analysisResults) {
    const hasFrames = Boolean(results?.h1 && results?.m15);
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
    $("strategy-take-profit").textContent = strategyPrice(strategy.takeProfit);
    $("strategy-target").textContent = strategyPrice(strategy.target);
    $("strategy-rr").textContent = Number.isFinite(strategy.rewardRisk1) && Number.isFinite(strategy.rewardRisk2)
      ? `1:${strategy.rewardRisk1.toFixed(2)} · 1:${strategy.rewardRisk2.toFixed(2)}`
      : "—";
    $("strategy-summary").textContent = strategy.summary;
    $("strategy-trigger").textContent = strategy.trigger;
    $("strategy-status").textContent = hasFrames
      ? `信号使用已收盘H1/M15，H4决定顺逆势；${Number.isFinite(state.book?.mid) ? "入场区随实时中间价更新" : "暂用M15最近收盘作为入场参考"} · ${formatTime(Date.now())}`
      : "等待H1与M15已收盘K线…";
  }

  function renderAnalysisCard(key, result, conclusion) {
    $(`${key}-card`).dataset.bias = result.marketState.bias;
    $(`${key}-state`).textContent = result.marketState.label;
    $(`${key}-direction-score`).textContent = signed(result.directionScore, 0);
    $(`${key}-direction-score`).className = result.directionScore >= 25
      ? "bullish"
      : result.directionScore <= -25
        ? "bearish"
        : "neutral";
    $(`${key}-setup-score`).textContent = `多${result.longSetup.score} · 空${result.shortSetup.score}`;
    $(`${key}-setup-score`).className = result.opportunity.bias;
    $(`${key}-setup-score`).dataset.tone = result.setup.tone;
    $(`${key}-setup-score`).title = result.opportunity.label;
    $(`${key}-confidence`).textContent = `${result.confidence.label} · ${result.confidenceScore}%`;
    $(`${key}-confidence`).dataset.tone = result.confidence.tone;
    $(`${key}-structure`).textContent = result.structure;
    $(`${key}-opportunity`).textContent = opportunityDetail(result);
    $(`${key}-rsi`).textContent = describeRsi(result.rsi);
    $(`${key}-macd`).textContent = describeMacd(result.macd);
    $(`${key}-levels`).textContent = `支撑 ${result.analysisSupportZone}；压力 ${result.analysisResistanceZone}；ATR(14)=${analysisPriceFormat.format(result.atr)}。`;
    $(`${key}-conclusion`).textContent = conclusion;
  }

  function renderAnalysisUnavailable(key, message) {
    $(`${key}-card`).dataset.bias = "neutral";
    $(`${key}-state`).textContent = "数据不足";
    $(`${key}-direction-score`).textContent = "—";
    $(`${key}-setup-score`).textContent = "—";
    $(`${key}-confidence`).textContent = "—";
    [`${key}-structure`, `${key}-opportunity`, `${key}-rsi`, `${key}-macd`, `${key}-levels`].forEach((id) => $(id).textContent = "—");
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
    for (const key of Object.keys(ANALYSIS_FRAMES)) {
      if (results[key]) renderAnalysisCard(key, results[key], conclusions[key]);
      else renderAnalysisUnavailable(key, errors[key] || "暂时无法生成判断，请稍后重试。");
    }
    renderIntradayStrategy(results);
  }

  async function loadAnalysis() {
    const token = ++state.analysisLoadToken;
    const symbol = state.symbol;
    $("analysis-status").textContent = "正在更新 H4、H1、M15 已收盘K线…";
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
      $("analysis-status").textContent = "已显示本地缓存 · 正在同步 H4、H1、M15 最新K线…";
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
    $("analysis-status").textContent = `${failed ? `${failed}个周期延迟 · ` : ""}已收盘K线同口径计算 · 实时价仅展示 · 置信度非胜率 · ${formatTime(Date.now())}`;
  }

  function renderRsi(candles, rsi = calculateRsi(candles)) {
    const svg = $("rsi-chart");
    const grid = $("rsi-grid-layer");
    const line = $("rsi-line");
    const area = $("rsi-area");
    const current = $("rsi-current");
    const W = 1000;
    const H = 122;
    const margin = { top: 8, right: 66, bottom: 10, left: 12 };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;
    const contentOffsetX = state.rightBlankRatio * innerW;
    const axisTextScaleX = getSvgTextScaleX(svg, W, H);
    const y = (value) => margin.top + (100 - value) / 100 * innerH;
    let gridMarkup = "";
    [70, 50, 30].forEach((value) => {
      const py = y(value);
      gridMarkup += `<line class="chart-grid" x1="${margin.left}" x2="${W - margin.right}" y1="${py}" y2="${py}"></line>`;
      const labelX = W - margin.right + 9;
      gridMarkup += `<text class="axis-text" x="${labelX}" y="${py + 3}"${axisTextTransform(labelX, axisTextScaleX)}>${value}</text>`;
    });
    grid.innerHTML = gridMarkup;
    const usable = rsi.map((value, index) => value === null ? null : { value, index }).filter(Boolean);
    if (!usable.length) {
      line.setAttribute("d", "");
      area.setAttribute("d", "");
      current.textContent = "—";
      svg._chart = null;
      return;
    }
    const x = (index) => margin.left + (index / Math.max(1, candles.length - 1)) * innerW - contentOffsetX;
    const points = usable.map(({ value, index }) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`);
    const bottom = margin.top + innerH;
    line.setAttribute("d", `M ${points.join(" L ")}`);
    area.setAttribute("d", `M ${x(usable[0].index).toFixed(2)},${bottom} L ${points.join(" L ")} L ${x(usable[usable.length - 1].index).toFixed(2)},${bottom} Z`);
    current.textContent = usable[usable.length - 1].value.toFixed(2);
    svg._chart = { rsi, x, y, W, H, margin };
  }

  function getTimelineWindow() {
    const count = state.candles.length;
    if (!count) return { startIndex: 0, endIndex: -1, candles: [], rsi: [], ma20: [], ma60: [] };
    const { startIndex, endIndex } = getTimelineIndexBounds(count);
    const fullRsi = calculateRsi(state.candles);
    const fullMa20 = calculateSmaSeries(state.candles, 20);
    const fullMa60 = calculateSmaSeries(state.candles, 60);
    return {
      startIndex,
      endIndex,
      candles: state.candles.slice(startIndex, endIndex + 1),
      rsi: fullRsi.slice(startIndex, endIndex + 1),
      ma20: fullMa20.slice(startIndex, endIndex + 1),
      ma60: fullMa60.slice(startIndex, endIndex + 1)
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
    $("chart-wrap").setPointerCapture(event.pointerId);
    $("chart-wrap").classList.add("dragging");
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
    const chartWrap = $("chart-wrap");
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
    const priceRatio = (localY - chart.margin.top) /
      (chart.H - chart.margin.top - chart.margin.bottom);
    const pointerPrice = chart.yMax - priceRatio * (chart.yMax - chart.yMin);
    $("hover-line").setAttribute("x1", localX);
    $("hover-line").setAttribute("x2", localX);
    $("hover-horizontal-line").setAttribute("y1", localY);
    $("hover-horizontal-line").setAttribute("y2", localY);
    $("hover-point").setAttribute("cx", localX);
    $("hover-point").setAttribute("cy", localY);
    $("hover-layer").setAttribute("visibility", "visible");
    const priceLabel = $("hover-price-label");
    priceLabel.textContent = priceFormat.format(pointerPrice);
    priceLabel.style.top = `${localY / chart.H * 100}%`;
    priceLabel.classList.add("visible");

    const rsiValue = chart.rsi[index];
    const rsiChart = $("rsi-chart")._chart;
    if (rsiChart) {
      const rsiX = rsiChart.x(index);
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
    $("tooltip-rsi").textContent = Number.isFinite(rsiValue) ? rsiValue.toFixed(2) : "—";
    positionTooltipAwayFromPointer(event, tooltip);
    tooltip.classList.add("visible");
  }

  function hideTooltip() {
    $("tooltip").classList.remove("visible");
    $("hover-price-label").classList.remove("visible");
    $("hover-layer").setAttribute("visibility", "hidden");
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

  $("chart-wrap").addEventListener("pointermove", showTooltip, { passive: true });
  $("chart-wrap").addEventListener("pointerleave", hideTooltip);
  $("chart-wrap").addEventListener("pointerdown", beginChartPan);
  $("chart-wrap").addEventListener("pointermove", moveChartPan, { passive: false });
  $("chart-wrap").addEventListener("pointerup", endChartPan);
  $("chart-wrap").addEventListener("pointercancel", endChartPan);
  $("chart-wrap").addEventListener("lostpointercapture", endChartPan);
  $("chart-wrap").addEventListener("wheel", zoomChartWithWheel, { passive: false });
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
