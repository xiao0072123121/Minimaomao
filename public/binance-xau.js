(() => {
  const PAGE_LOCATION = typeof window !== "undefined" ? window.location : null;
  const USE_REST_PROXY = PAGE_LOCATION?.protocol === "https:" &&
    !["localhost", "127.0.0.1"].includes(PAGE_LOCATION.hostname);
  const REST = USE_REST_PROXY
    ? `${PAGE_LOCATION.origin}/api/binance`
    : "https://fapi.binance.com";
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const CACHE_DB = "binance-multi-asset-kline-cache";
  const CACHE_STORE = "datasets";
  const CACHE_VERSION = 1;
  const CACHE_MAX_AGE = 14 * DAY;
  const MICROSTRUCTURE_CACHE_MAX_AGE = 30 * 60 * 1000;
  const PROFILE_LOOKBACK = 30 * DAY;
  const AGG_TRADE_LOOKBACK = 6 * 60 * 60 * 1000;
  const DEPTH_HISTORY_WINDOW = 60 * 1000;
  const MAX_AGG_TRADES = 48000;
  const LOCKED_STRATEGY_STORAGE_KEY = "minimaomao-locked-intraday-strategies-v1";
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
    intradayMinimumRawRewardRiskA: 1.5,
    intradayMinimumRawRewardRiskB: 1.3,
    intradayFirstTargetCapRewardRisk: 1.5,
    intradayMinimumCostAdjustedRewardRiskA: 1.15,
    intradayMinimumCostAdjustedRewardRiskB: 1,
    intradayMaximumCostToRisk: 0.45,
    portfolioRiskPerTradeRate: 0.01,
    maximumPortfolioStopRiskRate: 0.04,
    maximumPortfolioGrossLeverage: 4
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
    microstructureLoadToken: 0,
    analysisFrames: {},
    analysisResults: {},
    marketMicrostructure: {
      symbol: "XAUUSDT",
      profileCandles: [],
      aggregateTrades: [],
      depthHistory: [],
      profileStatus: "loading",
      tradeCoverageHours: 0,
      tradeWindowsPartial: 0
    },
    currentIntradayStrategy: null,
    currentIntradayStrategies: [],
    intradayStrategyHistory: {},
    lockedStrategies: {},
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
  let aggregateTradePollInFlight = false;
  const pendingJsonRequests = new Map();
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

  async function readDatasetCache(key, maxAge = MICROSTRUCTURE_CACHE_MAX_AGE) {
    try {
      const database = await openCacheDatabase();
      if (!database) return null;
      return await new Promise((resolve) => {
        const transaction = database.transaction(CACHE_STORE, "readonly");
        const request = transaction.objectStore(CACHE_STORE).get(key);
        request.onsuccess = () => {
          const record = request.result;
          resolve(record && Date.now() - record.savedAt < maxAge ? record.payload : null);
        };
        request.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
      });
    } catch (_) {
      return null;
    }
  }

  async function writeDatasetCache(key, payload) {
    try {
      const database = await openCacheDatabase();
      if (!database) return;
      const transaction = database.transaction(CACHE_STORE, "readwrite");
      transaction.objectStore(CACHE_STORE).put({ key, savedAt: Date.now(), payload });
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

  function readLockedStrategies() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(LOCKED_STRATEGY_STORAGE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).map(([symbol, value]) => {
        const records = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
        return [symbol, records.filter((record) => record && typeof record === "object").slice(0, 20)];
      }));
    } catch (_) {
      return {};
    }
  }

  function writeLockedStrategies(strategies) {
    try {
      window.localStorage.setItem(LOCKED_STRATEGY_STORAGE_KEY, JSON.stringify(strategies));
      return true;
    } catch (_) {
      return false;
    }
  }

  function createLockedStrategySnapshot(strategy, symbol, lockedAt, referencePrice, sourceId = "", sourceFingerprint = "") {
    return {
      version: 2,
      id: `locked-${symbol}-${lockedAt}-${Math.random().toString(36).slice(2, 7)}`,
      sourceId,
      sourceFingerprint,
      symbol,
      lockedAt,
      referencePrice: Number.isFinite(referencePrice) ? referencePrice : null,
      bias: strategy.bias,
      candidateBias: strategy.candidateBias,
      strategyType: strategy.strategyType || "primary",
      strategyLabel: strategy.strategyLabel || "日内策略",
      directionLabel: strategy.directionLabel,
      priority: strategy.priority,
      entryLow: strategy.entryLow,
      entryHigh: strategy.entryHigh,
      stopLoss: strategy.stopLoss,
      takeProfit: strategy.takeProfit,
      target: strategy.target,
      rewardRisk1: strategy.rewardRisk1,
      rewardRisk2: strategy.rewardRisk2,
      summary: strategy.summary,
      trigger: strategy.trigger,
      levelNote: strategy.levelNote || "",
      portfolioRule: strategy.portfolioRule || intradayPortfolioRiskRule()
    };
  }

  function escapeStrategyHtml(value) {
    return String(value ?? "—").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    })[character]);
  }

  function lockedStrategiesForSymbol(symbol = state.symbol) {
    const records = state.lockedStrategies[symbol];
    return Array.isArray(records) ? records : records ? [records] : [];
  }

  function isStrategyRecordLocked(record) {
    if (!record) return false;
    return lockedStrategiesForSymbol(record.symbol).some((locked) =>
      locked.sourceFingerprint && locked.sourceFingerprint === record.fingerprint
    );
  }

  function strategyMetricsMarkup(strategy) {
    const entry = Number.isFinite(strategy.entryLow) && Number.isFinite(strategy.entryHigh)
      ? `${strategyPrice(strategy.entryLow)}–${strategyPrice(strategy.entryHigh)}`
      : "—";
    const takeProfit = [strategy.takeProfit, strategy.target].filter(Number.isFinite).map(strategyPrice).join(" / ") || "—";
    const rewardRisk = Number.isFinite(strategy.rewardRisk1) && Number.isFinite(strategy.rewardRisk2)
      ? `1:${strategy.rewardRisk1.toFixed(2)} / 1:${strategy.rewardRisk2.toFixed(2)}`
      : "—";
    return `
      <div class="strategy-metrics" aria-label="日内策略参数">
        <div class="strategy-metric"><span>方向</span><b class="strategy-direction-value">${escapeStrategyHtml(strategy.directionLabel)}</b></div>
        <div class="strategy-metric"><span>策略优先级</span><b>${escapeStrategyHtml(strategy.priority)}</b></div>
        <div class="strategy-metric"><span>入场区域</span><b>${escapeStrategyHtml(entry)}</b></div>
        <div class="strategy-metric"><span>止损</span><b>${escapeStrategyHtml(strategyPrice(strategy.stopLoss))}</b></div>
        <div class="strategy-metric"><span>止盈</span><b>${escapeStrategyHtml(takeProfit)}</b></div>
        <div class="strategy-metric"><span>盈亏比</span><b>${escapeStrategyHtml(rewardRisk)}</b></div>
      </div>`;
  }

  function strategyNotesMarkup(strategy, locked = false) {
    const prefix = locked ? "锁定时" : "生成时";
    return `
      <div class="strategy-body">
        <div class="strategy-note"><span>${prefix}策略依据</span><p>${escapeStrategyHtml(strategy.summary)}</p></div>
        <div class="strategy-note"><span>${prefix}执行与失效条件</span><p>${escapeStrategyHtml(strategy.trigger)}</p></div>
        <div class="strategy-note strategy-portfolio"><span>${prefix}组合风险规则</span><p>${escapeStrategyHtml(strategy.portfolioRule || intradayPortfolioRiskRule())}</p></div>
      </div>`;
  }

  function updateLockStrategyButton() {
    const button = $("lock-strategy-button");
    if (!button) return;
    const current = state.currentIntradayStrategy;
    const canLock = Boolean(current?.strategy?.actionable && current.symbol === state.symbol);
    const isLocked = canLock && isStrategyRecordLocked(current);
    button.disabled = !canLock;
    button.title = canLock
      ? "保存当前日内策略快照；后续实时策略仍会继续更新"
      : "仅可锁定当前已触发的日内策略";
    button.textContent = canLock
      ? isLocked ? "更新这条锁定" : "锁定这条策略"
      : "暂无可锁定策略";
  }

  function renderIntradayStrategyHistory() {
    const container = $("intraday-strategy-history");
    if (!container) return;
    const history = state.intradayStrategyHistory[state.symbol] || [];
    container.hidden = history.length === 0;
    container.innerHTML = history.map((record, index) => {
      const locked = isStrategyRecordLocked(record);
      const reference = Number.isFinite(record.referencePrice) ? ` · 参考价 ${strategyPrice(record.referencePrice)}` : "";
      return `
        <article class="strategy-list-item" data-bias="${escapeStrategyHtml(record.strategy.bias)}" data-strategy-id="${escapeStrategyHtml(record.id)}">
          <div class="strategy-head">
            <div><h3>此前策略 ${index + 1} · ${escapeStrategyHtml(record.strategy.strategyLabel || "日内策略")}</h3><p>${escapeStrategyHtml(formatTime(record.generatedAt, true))}${escapeStrategyHtml(reference)} · 生成时快照</p></div>
            <button class="strategy-action primary" type="button" data-lock-strategy-id="${escapeStrategyHtml(record.id)}">${locked ? "更新这条锁定" : "锁定这条策略"}</button>
          </div>
          ${strategyMetricsMarkup(record.strategy)}
          ${strategyNotesMarkup(record.strategy)}
        </article>`;
    }).join("");
  }

  function renderLockedStrategy() {
    const card = $("locked-strategy");
    if (!card) return;
    const lockedRecords = lockedStrategiesForSymbol();
    const hasLocked = lockedRecords.length > 0;
    card.dataset.empty = String(!hasLocked);
    card.dataset.bias = "neutral";
    $("locked-strategy-empty").hidden = hasLocked;
    $("locked-strategy-list").hidden = !hasLocked;
    $("clear-locked-strategy-button").disabled = !hasLocked;
    if (!hasLocked) {
      $("locked-strategy-status").textContent = `${state.symbol} 尚未锁定日内策略。`;
      $("locked-strategy-list").innerHTML = "";
      updateLockStrategyButton();
      renderActiveSupplementalStrategies(state.currentIntradayStrategies || []);
      renderIntradayStrategyHistory();
      return;
    }
    $("locked-strategy-status").textContent = `${state.symbol} · 已锁定 ${lockedRecords.length} 条策略 · 上方实时策略继续更新`;
    $("locked-strategy-list").innerHTML = lockedRecords.map((locked, index) => {
      const reference = Number.isFinite(locked.referencePrice) ? ` · 参考价 ${strategyPrice(locked.referencePrice)}` : "";
      return `
        <article class="strategy-list-item" data-bias="${escapeStrategyHtml(locked.bias || "neutral")}" data-locked-id="${escapeStrategyHtml(locked.id || `legacy-${index}`)}">
          <div class="strategy-head">
            <div><h3>锁定策略 ${index + 1} · ${escapeStrategyHtml(locked.strategyLabel || "日内策略")}</h3><p>锁定于 ${escapeStrategyHtml(formatTime(locked.lockedAt, true))}${escapeStrategyHtml(reference)}</p></div>
            <button class="strategy-action" type="button" data-remove-locked-id="${escapeStrategyHtml(locked.id || `legacy-${index}`)}">删除这条</button>
          </div>
          ${strategyMetricsMarkup(locked)}
          ${strategyNotesMarkup(locked, true)}
        </article>`;
    }).join("");
    updateLockStrategyButton();
    renderActiveSupplementalStrategies(state.currentIntradayStrategies || []);
    renderIntradayStrategyHistory();
  }

  function findIntradayStrategyRecord(strategyId) {
    const active = (state.currentIntradayStrategies || []).find((record) => record.id === strategyId);
    if (active) return active;
    if (state.currentIntradayStrategy?.id === strategyId) return state.currentIntradayStrategy;
    return (state.intradayStrategyHistory[state.symbol] || []).find((record) => record.id === strategyId) || null;
  }

  function lockIntradayStrategy(strategyId) {
    const current = findIntradayStrategyRecord(strategyId);
    if (!current?.strategy?.actionable || current.symbol !== state.symbol) return false;
    const snapshot = createLockedStrategySnapshot(
      current.strategy,
      state.symbol,
      Date.now(),
      current.referencePrice,
      current.id,
      current.fingerprint
    );
    const existing = lockedStrategiesForSymbol();
    const matchingIndex = existing.findIndex((locked) =>
      locked.sourceFingerprint && locked.sourceFingerprint === current.fingerprint
    );
    const nextRecords = [...existing];
    if (matchingIndex >= 0) {
      snapshot.id = existing[matchingIndex].id;
      nextRecords[matchingIndex] = snapshot;
    } else {
      nextRecords.unshift(snapshot);
    }
    state.lockedStrategies = { ...state.lockedStrategies, [state.symbol]: nextRecords.slice(0, 20) };
    writeLockedStrategies(state.lockedStrategies);
    renderLockedStrategy();
    return true;
  }

  function lockCurrentStrategy() {
    return state.currentIntradayStrategy ? lockIntradayStrategy(state.currentIntradayStrategy.id) : false;
  }

  function removeLockedStrategy(lockedId) {
    const existing = lockedStrategiesForSymbol();
    const nextRecords = existing.filter((locked, index) => (locked.id || `legacy-${index}`) !== lockedId);
    if (nextRecords.length === existing.length) return false;
    state.lockedStrategies = { ...state.lockedStrategies, [state.symbol]: nextRecords };
    writeLockedStrategies(state.lockedStrategies);
    renderLockedStrategy();
    return true;
  }

  function clearLockedStrategy() {
    if (!lockedStrategiesForSymbol().length) return false;
    const next = { ...state.lockedStrategies };
    delete next[state.symbol];
    state.lockedStrategies = next;
    writeLockedStrategies(state.lockedStrategies);
    renderLockedStrategy();
    return true;
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
    state.marketMicrostructure = {
      symbol: state.symbol,
      profileCandles: [],
      aggregateTrades: [],
      depthHistory: [],
      profileStatus: "loading",
      tradeCoverageHours: 0,
      tradeWindowsPartial: 0
    };
    state.currentIntradayStrategy = null;
    state.currentIntradayStrategies = [];
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
    for (const [key, config] of Object.entries(ANALYSIS_FRAMES)) {
      if (config.hidden) continue;
      $(`${key}-card`).dataset.bias = "neutral";
      $(`${key}-state`).textContent = "计算中";
      $(`${key}-direction-score`).textContent = "—";
      $(`${key}-setup-score`).textContent = "—";
      $(`${key}-confidence`).textContent = "—";
      $(`${key}-structure`).textContent = `等待${ANALYSIS_FRAMES[key].label} K线…`;
      [`${key}-opportunity`, `${key}-levels`].forEach((id) => $(id).textContent = "—");
      $(`${key}-conclusion`).textContent = "正在生成动态判断…";
    }
    renderIntradayStrategy({});
    renderLockedStrategy();
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
    loadMicrostructure();
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
    const requestUrl = String(url);
    if (pendingJsonRequests.has(requestUrl)) return pendingJsonRequests.get(requestUrl);
    const request = (async () => {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetch(requestUrl, { credentials: "same-origin" });
        if (response.ok) return response.json();
        if (response.status === 418) {
          throw new Error("Binance暂时限流（418），代理缓存将在下一次同步时自动重试");
        }
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          const retryAfter = Math.min(3000, Math.max(500, Number(response.headers.get("Retry-After")) * 1000 || 800));
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
          continue;
        }
        throw new Error(`${response.status} ${response.statusText}`);
      }
      throw new Error(`${response?.status || "网络"} 历史行情请求失败`);
    })();
    pendingJsonRequests.set(requestUrl, request);
    try {
      return await request;
    } finally {
      pendingJsonRequests.delete(requestUrl);
    }
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
    const socket = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamSymbol}@bookTicker/${streamSymbol}@ticker/${streamSymbol}@depth20@500ms`);
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
        let quoteChanged = false;
        if (stream.endsWith("@bookTicker")) {
          state.book = parseBook(payload) ?? state.book;
          state.quoteAt = Number(payload.E) || Date.now();
          quoteChanged = true;
        } else if (stream.endsWith("@ticker")) {
          state.ticker = parseTicker(payload) ?? state.ticker;
          state.quoteAt = Number(payload.E) || state.quoteAt || Date.now();
          quoteChanged = true;
        } else if (stream.includes("@depth20")) {
          recordDepthSnapshot(payload);
        }
        if (quoteChanged) updateQuoteUI();
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

  function parseAggregateTrade(payload) {
    const id = Number(payload.a);
    const price = Number(payload.p);
    const quantity = Number(payload.q);
    const time = Number(payload.T);
    if (![id, price, quantity, time].every(Number.isFinite) || quantity <= 0) return null;
    return { id, price, quantity, time, buyerMaker: Boolean(payload.m) };
  }

  function mergeAggregateTrades(...groups) {
    const byId = new Map();
    for (const trade of groups.flat()) {
      if (trade && Number.isFinite(trade.id)) byId.set(trade.id, trade);
    }
    return [...byId.values()]
      .filter((trade) => trade.time >= Date.now() - AGG_TRADE_LOOKBACK)
      .sort((a, b) => a.time - b.time)
      .slice(-MAX_AGG_TRADES);
  }

  async function fetchAggregateTradeHistory(symbol) {
    const endTime = Date.now();
    const startTime = endTime - AGG_TRADE_LOOKBACK;
    const windows = [];
    for (let cursor = startTime; cursor < endTime; cursor += HOUR) {
      windows.push({ start: cursor, end: Math.min(endTime, cursor + HOUR - 1) });
    }
    const trades = [];
    let completedWindows = 0;
    let partialWindows = 0;
    for (let index = 0; index < windows.length; index += 4) {
      const batch = windows.slice(index, index + 4);
      const results = await Promise.all(batch.map(async (windowRange) => {
        try {
          const url = new URL(`${REST}/fapi/v1/aggTrades`);
          url.searchParams.set("symbol", symbol);
          url.searchParams.set("startTime", String(windowRange.start));
          url.searchParams.set("endTime", String(windowRange.end));
          url.searchParams.set("limit", "1000");
          const payload = await fetchJson(url);
          return { payload, ok: true };
        } catch (_) {
          return { payload: [], ok: false };
        }
      }));
      for (const result of results) {
        if (!result.ok) continue;
        completedWindows += 1;
        if (result.payload.length >= 1000) partialWindows += 1;
        trades.push(...result.payload.map(parseAggregateTrade).filter(Boolean));
      }
    }
    return {
      trades: mergeAggregateTrades(trades),
      coverageHours: completedWindows,
      partialWindows
    };
  }

  async function refreshRecentAggregateTrades() {
    if (aggregateTradePollInFlight) return;
    aggregateTradePollInFlight = true;
    const symbol = state.symbol;
    try {
      const url = new URL(`${REST}/fapi/v1/aggTrades`);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("limit", "1000");
      const payload = await fetchJson(url);
      if (symbol !== state.symbol) return;
      state.marketMicrostructure.aggregateTrades = mergeAggregateTrades(
        state.marketMicrostructure.aggregateTrades,
        payload.map(parseAggregateTrade).filter(Boolean)
      );
    } catch (_) {
      // Historical profile and the existing structure model remain available.
    } finally {
      aggregateTradePollInFlight = false;
    }
  }

  function parseDepthLevels(levels) {
    return (levels || []).map(([price, quantity]) => ({
      price: Number(price),
      quantity: Number(quantity)
    })).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.quantity) && level.quantity > 0);
  }

  function recordDepthSnapshot(payload) {
    if (state.marketMicrostructure.symbol !== state.symbol) return;
    const bids = parseDepthLevels(payload.bids || payload.b);
    const asks = parseDepthLevels(payload.asks || payload.a);
    if (!bids.length || !asks.length) return;
    const now = Number(payload.E) || Date.now();
    const history = state.marketMicrostructure.depthHistory;
    history.push({ time: now, bids, asks });
    while (history.length && history[0].time < now - DEPTH_HISTORY_WINDOW) history.shift();
  }

  function microstructureStatusText() {
    const micro = state.marketMicrostructure;
    if (micro.profileStatus === "ready") {
      const exact = micro.tradeCoverageHours
        ? `真实成交已采样${micro.tradeCoverageHours}个小时窗口${micro.tradeWindowsPartial ? `（${micro.tradeWindowsPartial}个窗口达到1000条上限）` : ""}`
        : "真实成交等待补充";
      return `30日成交分布已加载 · ${exact}`;
    }
    if (micro.profileCandles.length) return "已使用本地成交分布缓存 · 正在同步真实成交";
    return "成交分布加载中 · 暂用价格结构降级判断";
  }

  function refreshAnalysisForMicrostructure() {
    if (state.analysisFrames.h4 && state.analysisFrames.h1 && state.analysisFrames.m15) {
      renderAnalysis();
      $("analysis-status").textContent = `${microstructureStatusText()} · 深度实时修正 · ${formatTime(Date.now())}`;
    }
  }

  async function loadMicrostructure() {
    const token = ++state.microstructureLoadToken;
    const symbol = state.symbol;
    const candleKey = `micro:${symbol}:5m30d:v1`;
    const tradeKey = `micro:${symbol}:agg48h:v1`;
    const [cachedCandles, cachedTrades] = await Promise.all([
      readDatasetCache(candleKey),
      readDatasetCache(tradeKey)
    ]);
    if (token !== state.microstructureLoadToken || symbol !== state.symbol) return;
    if (Array.isArray(cachedCandles)) state.marketMicrostructure.profileCandles = cachedCandles;
    if (cachedTrades?.trades) {
      state.marketMicrostructure.aggregateTrades = mergeAggregateTrades(cachedTrades.trades);
      state.marketMicrostructure.tradeCoverageHours = cachedTrades.coverageHours || 0;
      state.marketMicrostructure.tradeWindowsPartial = cachedTrades.partialWindows || 0;
    }
    if (state.marketMicrostructure.profileCandles.length) {
      state.marketMicrostructure.profileStatus = "ready";
      refreshAnalysisForMicrostructure();
    }
    if (Array.isArray(cachedCandles) && cachedCandles.length >= 500 && cachedTrades?.trades?.length) return;

    const endTime = Date.now();
    const [candleResult, tradeResult] = await Promise.allSettled([
      fetchCandles(symbol, "5m", endTime - PROFILE_LOOKBACK, endTime),
      fetchAggregateTradeHistory(symbol)
    ]);
    if (token !== state.microstructureLoadToken || symbol !== state.symbol) return;
    if (candleResult.status === "fulfilled" && candleResult.value.length >= 500) {
      state.marketMicrostructure.profileCandles = candleResult.value;
      state.marketMicrostructure.profileStatus = "ready";
      writeDatasetCache(candleKey, candleResult.value);
    } else {
      state.marketMicrostructure.profileStatus = state.marketMicrostructure.profileCandles.length ? "ready" : "degraded";
    }
    if (tradeResult.status === "fulfilled") {
      state.marketMicrostructure.aggregateTrades = mergeAggregateTrades(
        tradeResult.value.trades,
        state.marketMicrostructure.aggregateTrades
      );
      state.marketMicrostructure.tradeCoverageHours = tradeResult.value.coverageHours;
      state.marketMicrostructure.tradeWindowsPartial = tradeResult.value.partialWindows;
      writeDatasetCache(tradeKey, {
        trades: state.marketMicrostructure.aggregateTrades,
        coverageHours: tradeResult.value.coverageHours,
        partialWindows: tradeResult.value.partialWindows
      });
    }
    refreshAnalysisForMicrostructure();
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

  function levelZoneBounds(levelOrZone, atr) {
    if (levelOrZone && Number.isFinite(levelOrZone.low) && Number.isFinite(levelOrZone.high)) {
      return { low: levelOrZone.low, high: levelOrZone.high };
    }
    const level = Number(levelOrZone);
    const halfWidth = Math.max(atr * 0.18, level * 0.00025);
    return { low: level - halfWidth, high: level + halfWidth };
  }

  function distanceToLevelZone(price, zone) {
    if (!zone) return Infinity;
    if (price < zone.low) return zone.low - price;
    if (price > zone.high) return price - zone.high;
    return 0;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function addProfileVolume(profile, price, volume, binSize) {
    if (![price, volume, binSize].every(Number.isFinite) || volume <= 0 || binSize <= 0) return;
    const index = Math.round(price / binSize);
    profile.set(index, (profile.get(index) || 0) + volume);
  }

  function normalizeProfile(profile) {
    const maximum = Math.max(...profile.values(), 0);
    const normalized = new Map();
    if (!maximum) return normalized;
    for (const [index, value] of profile) normalized.set(index, value / maximum);
    return normalized;
  }

  function buildVolumeProfile(microstructure, price, atr, frameKey) {
    const profileCandles = microstructure?.profileCandles || [];
    const aggregateTrades = microstructure?.aggregateTrades || [];
    if (profileCandles.length < 100 && aggregateTrades.length < 100) return { available: false, zones: [] };
    const frameConfig = {
      d1: { lookback: 30 * DAY, exactLookback: 48 * HOUR, approximateWeight: 0.8, exactWeight: 0.2, binAtr: 0.16 },
      h4: { lookback: 30 * DAY, exactLookback: 48 * HOUR, approximateWeight: 0.7, exactWeight: 0.3, binAtr: 0.13 },
      h1: { lookback: 7 * DAY, exactLookback: 48 * HOUR, approximateWeight: 0.5, exactWeight: 0.5, binAtr: 0.11 },
      m15: { lookback: 2 * DAY, exactLookback: 24 * HOUR, approximateWeight: 0.35, exactWeight: 0.65, binAtr: 0.09 }
    }[frameKey] || { lookback: 7 * DAY, exactLookback: 48 * HOUR, approximateWeight: 0.5, exactWeight: 0.5, binAtr: 0.11 };
    const binSize = Math.max(atr * frameConfig.binAtr, price * 0.00012, 0.000001);
    const now = Date.now();
    const approximate = new Map();
    for (const candle of profileCandles) {
      if (candle.t < now - frameConfig.lookback || !Number.isFinite(candle.volume) || candle.volume <= 0) continue;
      const lowIndex = Math.round(candle.low / binSize);
      const highIndex = Math.round(candle.high / binSize);
      const typicalIndex = Math.round(((candle.high + candle.low + candle.close) / 3) / binSize);
      const startIndex = Math.min(lowIndex, highIndex);
      const endIndex = Math.max(lowIndex, highIndex);
      const count = Math.max(1, endIndex - startIndex + 1);
      const weights = [];
      let weightTotal = 0;
      for (let index = startIndex; index <= endIndex; index += 1) {
        const distance = Math.abs(index - typicalIndex) / Math.max(1, count);
        const weight = Math.max(0.2, 1 - distance * 1.6);
        weights.push([index, weight]);
        weightTotal += weight;
      }
      for (const [index, weight] of weights) {
        approximate.set(index, (approximate.get(index) || 0) + candle.volume * weight / weightTotal);
      }
    }
    const exact = new Map();
    for (const trade of aggregateTrades) {
      if (trade.time < now - frameConfig.exactLookback) continue;
      addProfileVolume(exact, trade.price, trade.quantity, binSize);
    }
    const approximateNormalized = normalizeProfile(approximate);
    const exactNormalized = normalizeProfile(exact);
    const indexes = new Set([...approximateNormalized.keys(), ...exactNormalized.keys()]);
    const combined = [...indexes].map((index) => ({
      index,
      price: index * binSize,
      score: (approximateNormalized.get(index) || 0) * frameConfig.approximateWeight +
        (exactNormalized.get(index) || 0) * frameConfig.exactWeight
    })).filter((bin) => bin.score > 0).sort((a, b) => a.index - b.index);
    if (!combined.length) return { available: false, zones: [] };
    const poc = combined.reduce((best, bin) => bin.score > best.score ? bin : best, combined[0]);
    const totalScore = combined.reduce((sum, bin) => sum + bin.score, 0);
    let valueLowIndex = combined.findIndex((bin) => bin.index === poc.index);
    let valueHighIndex = valueLowIndex;
    let accumulated = poc.score;
    while (accumulated < totalScore * 0.7 && (valueLowIndex > 0 || valueHighIndex < combined.length - 1)) {
      const lowerScore = valueLowIndex > 0 ? combined[valueLowIndex - 1].score : -1;
      const higherScore = valueHighIndex < combined.length - 1 ? combined[valueHighIndex + 1].score : -1;
      if (higherScore > lowerScore) {
        valueHighIndex += 1;
        accumulated += combined[valueHighIndex].score;
      } else {
        valueLowIndex -= 1;
        accumulated += combined[valueLowIndex].score;
      }
    }
    const valueLow = combined[valueLowIndex].price;
    const valueHigh = combined[valueHighIndex].price;
    const nodes = [];
    for (let index = 0; index < combined.length; index += 1) {
      const bin = combined[index];
      const previous = combined[index - 1]?.score || 0;
      const next = combined[index + 1]?.score || 0;
      if (bin.score >= 0.45 && bin.score >= previous && bin.score >= next) {
        nodes.push({ ...bin, type: bin.index === poc.index ? "POC" : "HVN" });
      }
    }
    for (const [edgePrice, type] of [[valueLow, "VAL"], [valueHigh, "VAH"]]) {
      if (!nodes.some((node) => Math.abs(node.price - edgePrice) <= binSize)) {
        const edge = combined.reduce((best, bin) => Math.abs(bin.price - edgePrice) < Math.abs(best.price - edgePrice) ? bin : best, combined[0]);
        nodes.push({ ...edge, type });
      }
    }
    const zones = nodes.map((node) => ({
      center: node.price,
      low: node.price - binSize * 0.65,
      high: node.price + binSize * 0.65,
      profileScore: Math.round(clamp((node.type === "POC" ? 32 : node.type === "HVN" ? 25 : 20) + node.score * 8, 0, 40)),
      nodeType: node.type,
      density: node.score
    }));
    return {
      available: true,
      binSize,
      poc: poc.price,
      valueLow,
      valueHigh,
      exactSamples: aggregateTrades.filter((trade) => trade.time >= now - frameConfig.exactLookback).length,
      zones
    };
  }

  function depthAdjustmentForZone(zone, side, price, atr, depthHistory) {
    if (!depthHistory?.length || distanceToLevelZone(price, zone) > atr * 1.2) {
      return { score: 0, label: "未进入深度观察范围", persistence: 0 };
    }
    const expandedLow = zone.low - atr * 0.18;
    const expandedHigh = zone.high + atr * 0.18;
    let strongSnapshots = 0;
    let latestRatio = 0;
    for (const snapshot of depthHistory) {
      const levels = side === "support" ? snapshot.bids : snapshot.asks;
      const baseline = median(levels.map((level) => level.quantity));
      const relevant = levels.filter((level) => level.price >= expandedLow && level.price <= expandedHigh);
      const ratio = baseline > 0 && relevant.length
        ? Math.max(...relevant.map((level) => level.quantity / baseline))
        : 0;
      if (ratio >= 2.5) strongSnapshots += 1;
      if (snapshot === depthHistory[depthHistory.length - 1]) latestRatio = ratio;
    }
    const persistence = strongSnapshots / depthHistory.length;
    const latest = depthHistory[depthHistory.length - 1];
    const bidTotal = latest.bids.reduce((sum, level) => sum + level.quantity, 0);
    const askTotal = latest.asks.reduce((sum, level) => sum + level.quantity, 0);
    const preferredShare = side === "support"
      ? bidTotal / Math.max(0.000001, bidTotal + askTotal)
      : askTotal / Math.max(0.000001, bidTotal + askTotal);
    let score = clamp((preferredShare - 0.5) * 12, -3, 3);
    let label = "深度中性";
    if (persistence >= 0.25 && latestRatio >= 2.5) {
      score += Math.min(12, persistence * 8 + Math.max(0, latestRatio - 2.5) * 1.5);
      label = `${side === "support" ? "买墙" : "卖墙"}持续${Math.round(persistence * 100)}%`;
    } else if (persistence >= 0.25 && latestRatio < 1.2) {
      score -= 6;
      label = "历史挂单墙已撤离";
    }
    return { score: Math.round(clamp(score, -15, 15)), label, persistence };
  }

  function combineStructureAndProfileZones(structureZones, profile, side, price, atr, depthHistory) {
    if (!profile.available) return structureZones.map((zone) => ({ ...zone, scoringMode: "structure" }));
    const matchDistance = Math.max(atr * 0.55, profile.binSize * 1.5);
    const candidates = [];
    for (const profileZone of profile.zones) {
      if (side === "support" ? profileZone.center >= price + atr * 0.12 : profileZone.center <= price - atr * 0.12) continue;
      const structure = [...structureZones].sort((a, b) => Math.abs(a.center - profileZone.center) - Math.abs(b.center - profileZone.center))[0];
      const matched = structure && Math.abs(structure.center - profileZone.center) <= matchDistance ? structure : null;
      const reactionScore = matched ? Math.min(25, matched.touches * 4 + matched.rejections * 6) : 0;
      const roleRecencyScore = matched
        ? Math.min(15, (matched.roleReversal ? 7 : 0) + 8 * Math.exp(-matched.age / 20))
        : 2;
      const merged = {
        ...(matched || {}),
        side,
        center: matched ? (matched.center * 0.35 + profileZone.center * 0.65) : profileZone.center,
        low: Math.min(profileZone.low, matched?.low ?? profileZone.low),
        high: Math.max(profileZone.high, matched?.high ?? profileZone.high),
        touches: matched?.touches || 0,
        rejections: matched?.rejections || 0,
        age: matched?.age ?? 999,
        roleReversal: Boolean(matched?.roleReversal),
        averageVolumeRatio: matched?.averageVolumeRatio || 1,
        nodeType: profileZone.nodeType,
        density: profileZone.density,
        source: matched ? `${profileZone.nodeType}成交密集＋价格反应` : `${profileZone.nodeType}成交密集`,
        scoringMode: "volume-profile",
        scoreComponents: {
          volumeProfile: profileZone.profileScore,
          reaction: reactionScore,
          multiFrame: 0,
          roleRecency: Math.round(roleRecencyScore),
          depth: 0
        }
      };
      const depth = depthAdjustmentForZone(merged, side, price, atr, depthHistory);
      merged.depthLabel = depth.label;
      merged.depthAdjustment = depth.score;
      merged.scoreComponents.depth = depth.score;
      merged.baseStrength = merged.scoreComponents.volumeProfile + reactionScore + roleRecencyScore;
      merged.strength = Math.round(clamp(merged.baseStrength + depth.score, 0, 100));
      candidates.push(merged);
    }
    for (const structure of structureZones) {
      if (candidates.some((zone) => Math.abs(zone.center - structure.center) <= matchDistance)) continue;
      const reactionScore = Math.min(25, structure.touches * 4 + structure.rejections * 6);
      const roleRecencyScore = Math.min(15, (structure.roleReversal ? 7 : 0) + 8 * Math.exp(-structure.age / 20));
      const depth = depthAdjustmentForZone(structure, side, price, atr, depthHistory);
      candidates.push({
        ...structure,
        scoringMode: "structure-with-profile",
        source: `${structure.source}（非成交密集）`,
        scoreComponents: { volumeProfile: 0, reaction: reactionScore, multiFrame: 0, roleRecency: Math.round(roleRecencyScore), depth: depth.score },
        depthLabel: depth.label,
        depthAdjustment: depth.score,
        baseStrength: reactionScore + roleRecencyScore,
        strength: Math.round(clamp(reactionScore + roleRecencyScore + depth.score, 0, 100))
      });
    }
    return candidates;
  }

  function clusterLevelPoints(points, candles, price, atr, lookback, side) {
    if (!points.length) return [];
    const clusterDistance = Math.max(atr * 0.28, price * 0.00035);
    const padding = Math.max(atr * 0.08, price * 0.0001);
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const point of sorted) {
      const cluster = clusters[clusters.length - 1];
      if (!cluster || Math.abs(point.price - cluster.center) > clusterDistance) {
        clusters.push({ center: point.price, points: [point] });
        continue;
      }
      cluster.points.push(point);
      const totalWeight = cluster.points.reduce((sum, item) => sum + item.weight, 0);
      cluster.center = cluster.points.reduce((sum, item) => sum + item.price * item.weight, 0) / totalWeight;
    }
    return clusters.map((cluster) => {
      const uniqueIndexes = [...new Set(cluster.points.map((point) => point.index))];
      const latestIndex = Math.max(...uniqueIndexes);
      const age = Math.max(0, candles.length - 1 - latestIndex);
      const recencyScore = 20 * Math.exp(-age / Math.max(1, lookback * 0.35));
      let rejections = 0;
      for (const index of uniqueIndexes) {
        const reaction = candles.slice(index + 1, Math.min(candles.length, index + 4));
        if (!reaction.length) continue;
        const favorableMove = side === "support"
          ? Math.max(...reaction.map((candle) => candle.high)) - cluster.center
          : cluster.center - Math.min(...reaction.map((candle) => candle.low));
        if (favorableMove >= atr * 0.55) rejections += 1;
      }
      const volumeRatios = cluster.points.map((point) => point.volumeRatio).filter(Number.isFinite);
      const averageVolumeRatio = volumeRatios.length
        ? volumeRatios.reduce((sum, value) => sum + value, 0) / volumeRatios.length
        : 1;
      const touchScore = Math.min(30, uniqueIndexes.length * 8);
      const rejectionScore = Math.min(25, rejections * 8);
      const volumeScore = clamp((averageVolumeRatio - 1) * 10, 0, 10);
      const roleReversal = cluster.points.some((point) => point.roleReversal);
      const distance = Math.abs(price - cluster.center);
      const proximityScore = clamp(15 - distance / Math.max(atr * 4, 0.000001) * 15, 0, 15);
      const strength = Math.round(clamp(
        touchScore + rejectionScore + recencyScore + volumeScore + (roleReversal ? 12 : 0) + proximityScore,
        0,
        100
      ));
      return {
        side,
        center: cluster.center,
        low: Math.min(...cluster.points.map((point) => point.price)) - padding,
        high: Math.max(...cluster.points.map((point) => point.price)) + padding,
        strength,
        touches: uniqueIndexes.length,
        rejections,
        age,
        roleReversal,
        averageVolumeRatio,
        source: roleReversal ? "角色互换" : "摆动聚类"
      };
    });
  }

  function fallbackLevelZone(level, atr, side) {
    const bounds = levelZoneBounds(level, atr);
    return {
      side,
      center: level,
      low: bounds.low,
      high: bounds.high,
      strength: 20,
      touches: 1,
      rejections: 0,
      age: 0,
      roleReversal: false,
      averageVolumeRatio: 1,
      source: "区间备用"
    };
  }

  function selectPrimaryLevelZone(zones, price, atr) {
    return [...zones].sort((a, b) => {
      const distancePenaltyA = Math.min(35, distanceToLevelZone(price, a) / Math.max(atr, 0.000001) * 7);
      const distancePenaltyB = Math.min(35, distanceToLevelZone(price, b) / Math.max(atr, 0.000001) * 7);
      const rankA = a.strength - distancePenaltyA;
      const rankB = b.strength - distancePenaltyB;
      return rankB - rankA || distanceToLevelZone(price, a) - distanceToLevelZone(price, b);
    })[0];
  }

  function findLevels(candles, price, atr, lookback, microstructure = null, frameKey = "h1") {
    const recent = candles.slice(-lookback);
    const validVolumes = recent
      .map((candle) => candle.volume)
      .filter((value) => Number.isFinite(value) && value > 0);
    const averageVolume = validVolumes.length
      ? validVolumes.reduce((sum, value) => sum + value, 0) / validVolumes.length
      : 0;
    const pivots = [];
    for (let index = 2; index < recent.length - 2; index += 1) {
      const candle = recent[index];
      const neighbors = [recent[index - 2], recent[index - 1], recent[index + 1], recent[index + 2]];
      const volumeRatio = averageVolume > 0 && Number.isFinite(candle.volume) ? candle.volume / averageVolume : 1;
      if (neighbors.every((item) => candle.low <= item.low)) {
        pivots.push({ type: "low", price: candle.low, index, volumeRatio });
      }
      if (neighbors.every((item) => candle.high >= item.high)) {
        pivots.push({ type: "high", price: candle.high, index, volumeRatio });
      }
    }
    const separation = Math.max(atr * 0.12, price * 0.0002);
    const supportPoints = [];
    const resistancePoints = [];
    for (const pivot of pivots) {
      const ageWeight = 1 + Math.max(0, 1 - (recent.length - 1 - pivot.index) / Math.max(1, lookback));
      const point = { ...pivot, weight: ageWeight + Math.min(1, pivot.volumeRatio / 2), roleReversal: false };
      if (pivot.type === "low" && pivot.price < price + separation) supportPoints.push(point);
      if (pivot.type === "high" && pivot.price > price - separation) resistancePoints.push(point);
      if (pivot.type === "high" && pivot.price < price - separation) {
        const broken = recent.slice(pivot.index + 1).some((candle) => candle.close > pivot.price + atr * 0.12);
        if (broken) supportPoints.push({ ...point, roleReversal: true });
      }
      if (pivot.type === "low" && pivot.price > price + separation) {
        const broken = recent.slice(pivot.index + 1).some((candle) => candle.close < pivot.price - atr * 0.12);
        if (broken) resistancePoints.push({ ...point, roleReversal: true });
      }
    }
    let supportZones = clusterLevelPoints(supportPoints, recent, price, atr, lookback, "support")
      .filter((zone) => zone.center < price + separation);
    let resistanceZones = clusterLevelPoints(resistancePoints, recent, price, atr, lookback, "resistance")
      .filter((zone) => zone.center > price - separation);
    if (!supportZones.length) {
      const low = Math.min(...recent.map((candle) => candle.low));
      supportZones = [fallbackLevelZone(low < price ? low : price - atr * 1.5, atr, "support")];
    }
    if (!resistanceZones.length) {
      const high = Math.max(...recent.map((candle) => candle.high));
      resistanceZones = [fallbackLevelZone(high > price ? high : price + atr * 1.5, atr, "resistance")];
    }
    const volumeProfile = buildVolumeProfile(microstructure, price, atr, frameKey);
    supportZones = combineStructureAndProfileZones(
      supportZones,
      volumeProfile,
      "support",
      price,
      atr,
      microstructure?.depthHistory
    );
    resistanceZones = combineStructureAndProfileZones(
      resistanceZones,
      volumeProfile,
      "resistance",
      price,
      atr,
      microstructure?.depthHistory
    );
    const supportZone = selectPrimaryLevelZone(supportZones, price, atr);
    const resistanceZone = selectPrimaryLevelZone(resistanceZones, price, atr);
    return {
      support: supportZone.center,
      resistance: resistanceZone.center,
      supportZone,
      resistanceZone,
      supportZones,
      resistanceZones,
      volumeProfile
    };
  }

  function formatZone(levelOrZone, atr) {
    const zone = levelZoneBounds(levelOrZone, atr);
    return `${priceFormat.format(zone.low)}–${priceFormat.format(zone.high)}`;
  }

  function formatAnalysisZone(levelOrZone, atr) {
    const zone = levelZoneBounds(levelOrZone, atr);
    return `${analysisPriceFormat.format(zone.low)}–${analysisPriceFormat.format(zone.high)}`;
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

  function analyzeIntradayPriceStructure(candles, atr, levels, swing) {
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
    const regimeCandles = candles.slice(-13);
    let pathTravel = 0;
    let overlapTotal = 0;
    let overlapPairs = 0;
    for (let index = 1; index < regimeCandles.length; index += 1) {
      const current = regimeCandles[index];
      const prior = regimeCandles[index - 1];
      pathTravel += Math.abs(current.close - prior.close);
      const currentRange = Math.max(current.high - current.low, atr * 0.04, 0.000001);
      const priorRange = Math.max(prior.high - prior.low, atr * 0.04, 0.000001);
      const overlap = Math.max(0, Math.min(current.high, prior.high) - Math.max(current.low, prior.low));
      overlapTotal += overlap / Math.max(0.000001, Math.min(currentRange, priorRange));
      overlapPairs += 1;
    }
    const regimeStart = regimeCandles[0] || last;
    const efficiencyRatio = pathTravel > 0
      ? Math.abs(last.close - regimeStart.close) / pathTravel
      : 0;
    const overlapRatio = overlapPairs ? overlapTotal / overlapPairs : 0;
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
    const swingContribution = swing.score * 0.4;
    const netMoveContribution = clamp(netMoveAtr / 2, -1, 1) * 25;
    const rangeContribution = clamp((rangePosition - 0.5) * 2, -1, 1) * 15;
    const pressureContribution = clamp(pressure, -1, 1) * 15;
    const breakoutContribution = breakoutDirection * 25;
    const rejectionContribution = (supportRejection ? 16 : 0) - (resistanceRejection ? 16 : 0);
    const chopScore = Math.round(clamp(
      (efficiencyRatio < 0.3 ? 35 : efficiencyRatio < 0.42 ? 18 : 0) +
      (overlapRatio > 0.58 ? 30 : overlapRatio > 0.45 ? 15 : 0) +
      (Math.abs(netMoveAtr) < 0.7 ? 20 : Math.abs(netMoveAtr) < 1 ? 10 : 0) +
      (!swing.direction ? 15 : 0) -
      (breakoutDirection ? 25 : 0) -
      (supportRejection || resistanceRejection ? 15 : 0),
      0,
      100
    ));
    const rangeRegime = chopScore >= 65
      ? "compression"
      : chopScore >= 45
        ? "range"
        : "directional";
    let baseScore = swingContribution + netMoveContribution + rangeContribution + pressureContribution + breakoutContribution + rejectionContribution;
    baseScore = Math.round(clamp(baseScore, -100, 100));
    const score = baseScore;
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
    const candleMetrics = (candle) => {
      const range = Math.max(candle.high - candle.low, atr * 0.04, 0.000001);
      return {
        bodyRatio: Math.abs(candle.close - candle.open) / range,
        closeLocation: (candle.close - candle.low) / range
      };
    };
    const findRecentBreakoutSetup = (direction) => {
      const firstIndex = Math.max(4, candles.length - 8);
      for (let index = candles.length - 2; index >= firstIndex; index -= 1) {
        const setupCandle = candles[index];
        const setupContext = candles.slice(Math.max(0, index - 6), index);
        if (setupContext.length < 3) continue;
        const metrics = candleMetrics(setupCandle);
        const level = direction > 0
          ? Math.max(...setupContext.map((candle) => candle.high))
          : Math.min(...setupContext.map((candle) => candle.low));
        const directionalBody = direction > 0
          ? setupCandle.close > setupCandle.open && metrics.closeLocation >= 0.62
          : setupCandle.close < setupCandle.open && metrics.closeLocation <= 0.38;
        const crossedLevel = direction > 0
          ? setupCandle.close > level + atr * 0.03
          : setupCandle.close < level - atr * 0.03;
        if (directionalBody && metrics.bodyRatio >= 0.35 && crossedLevel) {
          return { direction, level, age: candles.length - 1 - index };
        }
      }
      return null;
    };
    const bullishBreakoutSetup = findRecentBreakoutSetup(1);
    const bearishBreakoutSetup = findRecentBreakoutSetup(-1);
    const retestTouchTolerance = atr * 0.35;
    const retestCloseTolerance = atr * 0.08;
    const bullishRetest = Boolean(
      bullishBreakoutSetup &&
      last.low <= bullishBreakoutSetup.level + retestTouchTolerance &&
      last.high >= bullishBreakoutSetup.level - retestCloseTolerance &&
      last.close >= bullishBreakoutSetup.level - retestCloseTolerance &&
      last.close > last.open && lastCloseLocation >= 0.58 && last.close > previous.close
    );
    const bearishRetest = Boolean(
      bearishBreakoutSetup &&
      last.high >= bearishBreakoutSetup.level - retestTouchTolerance &&
      last.low <= bearishBreakoutSetup.level + retestCloseTolerance &&
      last.close <= bearishBreakoutSetup.level + retestCloseTolerance &&
      last.close < last.open && lastCloseLocation <= 0.42 && last.close < previous.close
    );
    const legCandles = candles.slice(-7, -2);
    const pullbackCandles = candles.slice(-3, -1);
    const legStart = legCandles[0] || previous;
    const legHigh = Math.max(...legCandles.map((candle) => candle.high));
    const legLow = Math.min(...legCandles.map((candle) => candle.low));
    const pullbackHigh = Math.max(...pullbackCandles.map((candle) => candle.high));
    const pullbackLow = Math.min(...pullbackCandles.map((candle) => candle.low));
    const bullishLegMove = legHigh - legStart.close;
    const bearishLegMove = legStart.close - legLow;
    const bullishPullbackDepth = legHigh - pullbackLow;
    const bearishPullbackDepth = pullbackHigh - legLow;
    const bullishPullbackContinuation =
      bullishLegMove >= atr * 0.7 &&
      bullishPullbackDepth >= atr * 0.2 && bullishPullbackDepth <= atr * 1.35 &&
      last.close > pullbackHigh + atr * 0.02 && bullishImpulse;
    const bearishPullbackContinuation =
      bearishLegMove >= atr * 0.7 &&
      bearishPullbackDepth >= atr * 0.2 && bearishPullbackDepth <= atr * 1.35 &&
      last.close < pullbackLow - atr * 0.02 && bearishImpulse;
    let setupDirection = 0;
    let setupType = "waiting";
    let setupLabel = "等待方向Setup与回踩/回测";
    let triggerDirection = 0;
    let triggerLabel = "等待价格触发";
    if (supportRejection) {
      setupDirection = 1;
      setupType = "level-rejection";
      setupLabel = "支撑测试Setup";
      triggerDirection = 1;
      triggerLabel = "支撑测试后出现多头拒绝K线";
    } else if (resistanceRejection) {
      setupDirection = -1;
      setupType = "level-rejection";
      setupLabel = "压力测试Setup";
      triggerDirection = -1;
      triggerLabel = "压力测试后出现空头拒绝K线";
    } else if (bullishRetest) {
      setupDirection = 1;
      setupType = "breakout-retest";
      setupLabel = `向上突破Setup（${bullishBreakoutSetup.age}根前）`;
      triggerDirection = 1;
      triggerLabel = "回测突破位后重新收复";
    } else if (bearishRetest) {
      setupDirection = -1;
      setupType = "breakout-retest";
      setupLabel = `向下跌破Setup（${bearishBreakoutSetup.age}根前）`;
      triggerDirection = -1;
      triggerLabel = "回测跌破位后重新转弱";
    } else if (bullishPullbackContinuation) {
      setupDirection = 1;
      setupType = "pullback-continuation";
      setupLabel = "多头推进后的回踩Setup";
      triggerDirection = 1;
      triggerLabel = "回踩后实体K线重新突破近端高点";
    } else if (bearishPullbackContinuation) {
      setupDirection = -1;
      setupType = "pullback-continuation";
      setupLabel = "空头推进后的反抽Setup";
      triggerDirection = -1;
      triggerLabel = "反抽后实体K线重新跌破近端低点";
    } else if (breakoutDirection || shortBreakDirection) {
      setupDirection = breakoutDirection || shortBreakDirection;
      setupType = "breakout-waiting-retest";
      setupLabel = `${setupDirection > 0 ? "向上突破" : "向下跌破"}Setup已形成`;
      triggerLabel = "直接突破不追价，等待回测或回踩确认";
    } else if (bullishBreakoutSetup || bearishBreakoutSetup) {
      const setup = bullishBreakoutSetup && bearishBreakoutSetup
        ? bullishBreakoutSetup.age <= bearishBreakoutSetup.age ? bullishBreakoutSetup : bearishBreakoutSetup
        : bullishBreakoutSetup || bearishBreakoutSetup;
      setupDirection = setup.direction;
      setupType = "breakout-waiting-retest";
      setupLabel = `${setup.direction > 0 ? "向上突破" : "向下跌破"}Setup（${setup.age}根前）`;
      triggerLabel = "等待价格回测突破位并重新确认";
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
      efficiencyRatio,
      overlapRatio,
      chopScore,
      rangeRegime,
      contextHigh,
      contextLow,
      breakoutDirection,
      breakoutContribution,
      supportRejection,
      resistanceRejection,
      rejectionContribution,
      bullishImpulse,
      bearishImpulse,
      setupDirection,
      setupType,
      setupLabel,
      bullishRetest,
      bearishRetest,
      bullishPullbackContinuation,
      bearishPullbackContinuation,
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
    score += rewardRisk >= 2 ? 18 : rewardRisk >= 1.3 ? 11 : rewardRisk >= 0.8 ? 3 : -12;
    if (sign > 0 && result.nearResistance) score -= 24;
    if (sign < 0 && result.nearSupport) score -= 24;
    if (sign > 0 && result.nearSupport) score += 10;
    if (sign < 0 && result.nearResistance) score += 10;
    if (sign < 0 && result.priceAction.resistanceRejection) score += 24;
    if (sign > 0 && result.priceAction.resistanceRejection) score -= 22;
    if (sign > 0 && result.priceAction.supportBounce) score += 24;
    if (sign < 0 && result.priceAction.supportBounce) score -= 22;
    if (result.twoCloseDirection === sign) score += 10;
    else if (result.twoCloseDirection === -sign) score -= 14;
    const baseScore = Math.round(clamp(score, 0, 100));
    return {
      bias: sign > 0 ? "bullish" : "bearish",
      sign,
      score: baseScore,
      baseScore,
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
    const atr = calculateAtr(candles);
    if (![price, ma20, ma60, atr].every(Number.isFinite)) {
      throw new Error(`${config.label}价格结构计算失败`);
    }
    const levels = findLevels(candles, price, atr, config.lookback, state.marketMicrostructure, config.key);
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

    const directionScore = trendScore;
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
    const intradayStructure = analyzeIntradayPriceStructure(candles, atr, levels, swing);
    const result = {
      ...config,
      price,
      ma20,
      ma60,
      atr,
      bias: direction.bias,
      directionTier,
      directionLabel: direction.label,
      trendScore,
      directionScore,
      twoCloseDirection,
      structure,
      swing,
      priceAction,
      intradayStructure,
      support: levels.support,
      resistance: levels.resistance,
      supportLevel: levels.supportZone,
      resistanceLevel: levels.resistanceZone,
      supportLevels: levels.supportZones,
      resistanceLevels: levels.resistanceZones,
      volumeProfile: levels.volumeProfile,
      supportZone: formatZone(levels.supportZone, atr),
      resistanceZone: formatZone(levels.resistanceZone, atr),
      analysisSupportZone: formatAnalysisZone(levels.supportZone, atr),
      analysisResistanceZone: formatAnalysisZone(levels.resistanceZone, atr),
      nearSupport: distanceToLevelZone(price, levels.supportZone) <= nearThreshold,
      nearResistance: distanceToLevelZone(price, levels.resistanceZone) <= nearThreshold,
      lastClosedAt: last.closeTime
    };
    result.longSetup = calculateDirectionalSetup(result, 1);
    result.shortSetup = calculateDirectionalSetup(result, -1);
    result.longSetupScoreBase = result.longSetup.baseScore;
    result.shortSetupScoreBase = result.shortSetup.baseScore;
    result.confidenceScore = calculateConfidence(directionScore, [
      priceComponent,
      spreadComponent,
      ma20SlopeComponent,
      ma60SlopeComponent,
      structureComponent,
      closeComponent
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

  function applySupportResistanceConfluence(results) {
    const frames = [results.h4, results.h1, results.m15].filter(Boolean);
    for (const frame of frames) {
      for (const side of ["support", "resistance"]) {
        const zones = side === "support" ? frame.supportLevels : frame.resistanceLevels;
        for (const zone of zones || []) {
          if (!zone.scoreComponents) continue;
          const alignedFrames = new Set([frame.key]);
          for (const other of frames) {
            if (other.key === frame.key) continue;
            const otherZones = side === "support" ? other.supportLevels : other.resistanceLevels;
            const threshold = Math.max(frame.atr * 0.55, other.atr * 0.35, frame.price * 0.0003);
            if ((otherZones || []).some((candidate) => Math.abs(candidate.center - zone.center) <= threshold)) {
              alignedFrames.add(other.key);
            }
          }
          zone.timeframes = [...alignedFrames];
          zone.confluence = alignedFrames.size;
          zone.scoreComponents.multiFrame = Math.min(20, (alignedFrames.size - 1) * 10);
          zone.strength = Math.round(clamp(
            zone.baseStrength + zone.scoreComponents.multiFrame + (zone.depthAdjustment || 0),
            0,
            100
          ));
        }
      }
    }
  }

  function applyMultiFrameContext(results) {
    applySupportResistanceConfluence(results);
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
      conclusions.m15 = `M15为${view.structure.label}（结构分${signed(view.structure.score, 0)}），${relation}；Setup：${view.structure.setupLabel}；触发：${view.structure.triggerLabel}，价格结构条件多${view.longScore}、空${view.shortScore}。${proximityText(m15)}`;
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

  function rankIntradayLevelZones(entry, frames, side) {
    const timeframeBonus = { h4: 18, h1: 12, m15: 6 };
    const availableFrames = frames.filter(Boolean);
    const baseAtr = Math.max(
      availableFrames.find((frame) => frame.key === "m15")?.atr || 0,
      (availableFrames.find((frame) => frame.key === "h1")?.atr || 0) * 0.45,
      entry * 0.00035
    );
    const confluenceDistance = Math.max(baseAtr * 0.45, entry * 0.00035);
    const candidates = availableFrames.flatMap((frame) => {
      const zones = side === "support" ? frame.supportLevels : frame.resistanceLevels;
      return (zones || []).map((zone) => ({ ...zone, timeframe: frame.key }));
    }).filter((zone) => side === "support" ? zone.center < entry : zone.center > entry);
    const ranked = candidates.map((zone) => {
      const nearbyFrames = new Set(candidates
        .filter((candidate) => Math.abs(candidate.center - zone.center) <= confluenceDistance)
        .map((candidate) => candidate.timeframe));
      const confluenceBonus = Math.max(0, nearbyFrames.size - 1) * 14;
      const distance = Math.abs(entry - zone.center);
      const distancePenalty = Math.min(45, distance / Math.max(baseAtr, 0.000001) * 6);
      return {
        ...zone,
        timeframes: [...nearbyFrames],
        confluence: nearbyFrames.size,
        rank: zone.strength + (timeframeBonus[zone.timeframe] || 0) + confluenceBonus - distancePenalty
      };
    }).sort((a, b) => b.rank - a.rank || Math.abs(entry - a.center) - Math.abs(entry - b.center));
    const deduped = [];
    for (const zone of ranked) {
      if (deduped.some((item) => Math.abs(item.center - zone.center) <= confluenceDistance)) continue;
      deduped.push(zone);
    }
    return deduped;
  }

  function intradayLevelBasis(zone, label, atr) {
    if (!zone) return `${label}采用ATR推算`;
    const frames = zone.timeframes?.map((key) => key.toUpperCase()).join("/") || zone.timeframe?.toUpperCase() || "当前周期";
    return `${label}参考${frames}区域 ${formatZone(zone, atr)}（强度${zone.strength}/100${zone.confluence > 1 ? `，${zone.confluence}周期共振` : ""}）`;
  }

  function calculateIntradayLevels(bias, entry, h4, h1, m15) {
    const isLong = bias === "bullish";
    const atr = Math.max(m15.atr, entry * 0.00035);
    const entryPadding = Math.max(atr * 0.12, entry * 0.00008);
    const entryLow = isLong ? entry - entryPadding : entry - entryPadding * 0.35;
    const entryHigh = isLong ? entry + entryPadding * 0.35 : entry + entryPadding;
    const supports = rankIntradayLevelZones(entry, [h4, h1, m15], "support");
    const resistances = rankIntradayLevelZones(entry, [h4, h1, m15], "resistance");
    const supportTargets = [...supports].sort((a, b) => b.high - a.high);
    const resistanceTargets = [...resistances].sort((a, b) => a.low - b.low);
    const maximumStopZoneDistance = Math.max(atr * 5, h1.atr * 2.5, entry * 0.005);
    let stopLoss;
    let takeProfit;
    if (isLong) {
      const stopZone = supports.find((zone) => distanceToLevelZone(entry, zone) <= maximumStopZoneDistance);
      const minimumRisk = Math.max(atr * 0.75, h1.atr * 0.18, entry * 0.0008);
      stopLoss = stopZone
        ? Math.min(stopZone.low - atr * 0.2, entry - minimumRisk)
        : entry - minimumRisk;
      const risk = Math.max(atr * 0.35, entry - stopLoss);
      const projectedFirst = entry + risk * STRATEGY_FILTERS.intradayFirstTargetCapRewardRisk;
      const takeProfitZone = resistanceTargets.find((zone) => zone.low > entry);
      const firstTargetCapped = Boolean(takeProfitZone && takeProfitZone.low > projectedFirst);
      takeProfit = Math.min(takeProfitZone?.low ?? projectedFirst, projectedFirst);
      const secondResistance = resistanceTargets.find((zone) => zone.low > takeProfit + atr * 0.2);
      const target = Math.max(secondResistance?.low || 0, entry + risk * 2.5);
      return {
        entryLow,
        entryHigh,
        stopLoss,
        takeProfit,
        target,
        rewardRisk1: Math.max(0, takeProfit - entry) / risk,
        rewardRisk2: Math.max(0, target - entry) / risk,
        risk,
        stopLevelZone: stopZone || null,
        takeProfitLevelZone: takeProfitZone || null,
        levelNote: `${intradayLevelBasis(stopZone, "止损", atr)}；${intradayLevelBasis(takeProfitZone, "止盈", atr)}${firstTargetCapped ? `；第一目标按${STRATEGY_FILTERS.intradayFirstTargetCapRewardRisk.toFixed(1)}R可达性上限收近` : ""}。`
      };
    }
    const stopZone = resistances.find((zone) => distanceToLevelZone(entry, zone) <= maximumStopZoneDistance);
    const minimumRisk = Math.max(atr * 0.75, h1.atr * 0.18, entry * 0.0008);
    stopLoss = stopZone
      ? Math.max(stopZone.high + atr * 0.2, entry + minimumRisk)
      : entry + minimumRisk;
    const risk = Math.max(atr * 0.35, stopLoss - entry);
    const projectedFirst = entry - risk * STRATEGY_FILTERS.intradayFirstTargetCapRewardRisk;
    const takeProfitZone = supportTargets.find((zone) => zone.high < entry);
    const firstTargetCapped = Boolean(takeProfitZone && takeProfitZone.high < projectedFirst);
    takeProfit = Math.max(takeProfitZone?.high ?? projectedFirst, projectedFirst);
    const secondSupport = supportTargets.find((zone) => zone.high < takeProfit - atr * 0.2);
    const target = Math.min(Number.isFinite(secondSupport?.high) ? secondSupport.high : Infinity, entry - risk * 2.5);
    return {
      entryLow,
      entryHigh,
      stopLoss,
      takeProfit,
      target,
      rewardRisk1: Math.max(0, entry - takeProfit) / risk,
      rewardRisk2: Math.max(0, entry - target) / risk,
      risk,
      stopLevelZone: stopZone || null,
      takeProfitLevelZone: takeProfitZone || null,
      levelNote: `${intradayLevelBasis(stopZone, "止损", atr)}；${intradayLevelBasis(takeProfitZone, "止盈", atr)}${firstTargetCapped ? `；第一目标按${STRATEGY_FILTERS.intradayFirstTargetCapRewardRisk.toFixed(1)}R可达性上限收近` : ""}。`
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

  function intradayPortfolioRiskRule() {
    return `组合执行上限：单笔风险预算最高${(STRATEGY_FILTERS.portfolioRiskPerTradeRate * 100).toFixed(0)}%，新订单进入时同时止损风险不超过${(STRATEGY_FILTERS.maximumPortfolioStopRiskRate * 100).toFixed(0)}%，总名义杠杆不超过${STRATEGY_FILTERS.maximumPortfolioGrossLeverage.toFixed(0)}倍。新信号仍会展示；额度不足时按剩余额度缩小新仓，额度为零时等待。`;
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
    const favorableBoundary = sign > 0 ? frame.nearSupport : frame.nearResistance;
    const matchingTrigger = structure.triggerDirection === sign;
    const protectedTrigger = matchingTrigger &&
      (structure.setupType === "breakout-retest" || structure.setupType === "level-rejection");
    let rangePenalty = structure.rangeRegime === "compression"
      ? 10
      : structure.rangeRegime === "range"
        ? 4
        : 0;
    if (structure.rangePosition >= 0.32 && structure.rangePosition <= 0.68) rangePenalty += 4;
    if (favorableBoundary) rangePenalty = Math.max(0, rangePenalty - 5);
    if (protectedTrigger) rangePenalty = Math.max(0, rangePenalty - 5);
    const triggerQuality = frame.key === "m15" && matchingTrigger
      ? structure.setupType === "breakout-retest"
        ? 8
        : structure.setupType === "pullback-continuation"
          ? 6
          : structure.setupType === "level-rejection"
            ? 6
            : 0
      : 0;
    baseScore += triggerQuality - rangePenalty;
    baseScore = Math.round(clamp(baseScore, 0, 100));
    return {
      baseScore,
      score: baseScore,
      rangePenalty,
      triggerQuality
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
    const regimeLabel = structure.rangeRegime === "compression"
      ? "压缩震荡"
      : structure.rangeRegime === "range"
        ? "区间震荡"
        : "方向行情";
    return `摆动结构：${result.swing.label}（${signed(structure.swingContribution, 0)}）；近8根净变动${signed(structure.netMoveAtr, 2)} ATR（${signed(structure.netMoveContribution, 0)}）；收盘位于前24根区间${Math.round(structure.rangePosition * 100)}%位置（${signed(structure.rangeContribution, 0)}）；近6根为${pressureLabel}（${signed(structure.pressureContribution, 0)}）。路径效率${Math.round(structure.efficiencyRatio * 100)}%、相邻K线重叠${Math.round(structure.overlapRatio * 100)}%，判定为${regimeLabel}（震荡分${structure.chopScore}）。${breakoutLabel}（${signed(structure.breakoutContribution, 0)}）；${rejectionLabel}（${signed(structure.rejectionContribution, 0)}）。`;
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
    const trigger = result.key === "m15"
      ? `；Setup：${structure.setupLabel}；价格触发：${structure.triggerLabel}`
      : "";
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

  function describeLevelZone(zone) {
    if (!zone) return "强度未知";
    if (zone.scoreComponents) {
      const components = zone.scoreComponents;
      const depth = components.depth > 0 ? `+${components.depth}` : String(components.depth || 0);
      const node = zone.nodeType ? `${zone.nodeType} · ` : "";
      return `${node}强度${zone.strength}/100，成交密集${components.volumeProfile}/40、价格反应${components.reaction}/25、多周期${components.multiFrame}/20、角色/时效${components.roleRecency}/15、深度${depth}（${zone.depthLabel || "中性"}）`;
    }
    const role = zone.roleReversal ? "，包含突破后角色互换" : "";
    return `结构降级：强度${zone.strength}/100，触碰${zone.touches}次、有效反应${zone.rejections}次${role}`;
  }

  function buildIntradayStrategy(results, entryPrice) {
    const { h4, h1, m15 } = results;
    if (!h4 || !h1 || !m15) return emptyIntradayStrategy();
    const h4Structure = h4.intradayStructure;
    const h1Structure = h1.intradayStructure;
    const m15Structure = m15.intradayStructure;
    const h4MainSign = h4Structure.sign;
    const candidateSign = h4MainSign || h1Structure.sign;
    const directionName = candidateSign > 0 ? "做多" : candidateSign < 0 ? "做空" : "等待";
    const candidateBias = candidateSign > 0 ? "bullish" : candidateSign < 0 ? "bearish" : "neutral";
    const stateSummary = `H4 ${h4Structure.label}，H1 ${h1Structure.label}，M15 ${m15Structure.label}。H4${h4MainSign ? `确定${directionName}主方向` : "暂未形成方向"}；M15 Setup：${m15Structure.setupLabel}；触发：${m15Structure.triggerLabel}。`;
    const waitForCandidate = (reason, trigger) => ({
      ...emptyIntradayStrategy(reason),
      candidateBias,
      directionLabel: candidateSign ? `观望 · 候选${directionName}` : "观望",
      trigger
    });
    if (!candidateSign) {
      return waitForCandidate(
        `${stateSummary} H4与H1价格结构均未形成明确方向，暂不选择方向。`,
        "等待H4形成主方向，或H1先形成价格结构后由M15触发机会。"
      );
    }
    if (h4MainSign && h1Structure.sign === -candidateSign) {
      return waitForCandidate(
        `${stateSummary} H4已确定${directionName}主方向，但H1当前明确反向，暂不提前入场。`,
        `等待H1价格结构转为${candidateSign > 0 ? "偏多" : "偏空"}，再由M15确认触发。`
      );
    }
    if (!h4MainSign && h1Structure.sign !== candidateSign) {
      return waitForCandidate(
        `${stateSummary} H1尚未形成与候选方向一致的价格结构。`,
        `等待H1摆动结构、区间位置和最近收盘共同转为${candidateSign > 0 ? "偏多" : "偏空"}。`
      );
    }
    if (m15Structure.triggerDirection !== candidateSign) {
      return waitForCandidate(
        `${stateSummary} 日内方向已经确定，但M15尚未完成同向Setup后的回踩/回测触发。`,
        candidateSign > 0
          ? `等待向上突破Setup回测收复、推进后回踩延续，或在支撑 ${m15.supportZone} 出现多头拒绝K线；直接突破不追价。`
          : `等待向下跌破Setup回测转弱、推进后反抽延续，或在压力 ${m15.resistanceZone} 出现空头拒绝K线；直接跌破不追价。`
      );
    }

    const priority = h4MainSign && h1Structure.sign === candidateSign
      ? { code: "A", label: "A · H4/H1方向顺势" }
      : { code: "B", label: h4MainSign ? "B · H4方向＋M15触发" : "B · H1价格机会" };
    const entry = Number.isFinite(entryPrice) ? entryPrice : m15.price;
    const levels = calculateIntradayLevels(candidateBias, entry, h4, h1, m15);
    const executionQuality = evaluateExecutionQuality(levels, candidateBias);
    const minimumRawRewardRisk = priority.code === "A"
      ? STRATEGY_FILTERS.intradayMinimumRawRewardRiskA
      : STRATEGY_FILTERS.intradayMinimumRawRewardRiskB;
    const minimumCostAdjustedRewardRisk = priority.code === "A"
      ? STRATEGY_FILTERS.intradayMinimumCostAdjustedRewardRiskA
      : STRATEGY_FILTERS.intradayMinimumCostAdjustedRewardRiskB;
    const structuralNote = levels.levelNote || (candidateSign > 0
      ? "止损设置在有效支撑区下方，止盈优先参考真实压力区。"
      : "止损设置在有效压力区上方，止盈优先参考真实支撑区。");
    const trigger = candidateSign > 0
      ? `Setup：${m15Structure.setupLabel}；执行触发：${m15Structure.triggerLabel}。价格进入参考区后不得跌破 ${m15.supportZone}，触及结构止损则失效。`
      : `Setup：${m15Structure.setupLabel}；执行触发：${m15Structure.triggerLabel}。价格进入参考区后不得突破 ${m15.resistanceZone}，触及结构止损则失效。`;
    if (levels.rewardRisk1 < minimumRawRewardRisk ||
        executionQuality.costAdjustedRewardRisk < minimumCostAdjustedRewardRisk ||
        executionQuality.costToRisk > STRATEGY_FILTERS.intradayMaximumCostToRisk) {
      return {
        bias: "neutral",
        candidateBias,
        actionable: false,
        directionLabel: `观望 · 候选${directionName}`,
        priority: "等待 · 成本或盈亏比不足",
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
      ...levels,
      summary: `${stateSummary} ${directionName}方向、H1位置与M15触发一致，并通过成本保护（${executionQuality.label}）。${structuralNote}`,
      trigger
    };
  }

  function counterTrendLocation(entry, counterSign, h1, m15) {
    const side = counterSign > 0 ? "support" : "resistance";
    const zones = rankIntradayLevelZones(entry, [h1, m15], side);
    const maximumDistance = Math.max(m15.atr * 1.25, h1.atr * 0.45, entry * 0.0012);
    const zone = zones.find((candidate) => distanceToLevelZone(entry, candidate) <= maximumDistance) || null;
    return { side, zone, maximumDistance };
  }

  function tightenCounterTrendLevels(levels, counterSign, entry, zone, m15) {
    const atr = Math.max(m15.atr, entry * 0.00035);
    const stopPadding = atr * 0.3;
    const minimumRisk = atr * 0.6;
    const stopLoss = counterSign > 0
      ? Math.min(zone.low - stopPadding, entry - minimumRisk)
      : Math.max(zone.high + stopPadding, entry + minimumRisk);
    const risk = Math.abs(entry - stopLoss);
    return {
      ...levels,
      stopLoss,
      risk,
      rewardRisk1: counterSign > 0
        ? Math.max(0, levels.takeProfit - entry) / risk
        : Math.max(0, entry - levels.takeProfit) / risk,
      rewardRisk2: counterSign > 0
        ? Math.max(0, levels.target - entry) / risk
        : Math.max(0, entry - levels.target) / risk,
      levelNote: `${levels.levelNote} 逆势单止损按触发区域外侧加0.30倍M15 ATR收紧。`
    };
  }

  function buildCounterTrendIntradayStrategy(results, entryPrice) {
    const { h4, h1, m15 } = results;
    if (!h4 || !h1 || !m15) return null;
    const h4Structure = h4.intradayStructure;
    const h1Structure = h1.intradayStructure;
    const m15Structure = m15.intradayStructure;
    if (!h4Structure.strong || !h4Structure.sign) return null;
    const mainSign = h4Structure.sign;
    const counterSign = -mainSign;
    const counterBias = counterSign > 0 ? "bullish" : "bearish";
    const mainDirection = mainSign > 0 ? "做多" : "做空";
    const counterDirection = counterSign > 0 ? "做多" : "做空";
    const patternName = counterSign > 0 ? "逆势反弹" : "逆势回调";
    const entry = Number.isFinite(entryPrice) ? entryPrice : m15.price;
    const location = counterTrendLocation(entry, counterSign, h1, m15);
    if (!location.zone) return null;
    const h1StillStrongWithMain = h1Structure.strong && h1Structure.sign === mainSign;
    const minimumZoneStrength = h1StillStrongWithMain ? 75 : 65;
    if (location.zone.strength < minimumZoneStrength) return null;
    const rejectionTriggered = counterSign > 0
      ? m15Structure.supportRejection
      : m15Structure.resistanceRejection;
    if (!rejectionTriggered || m15Structure.triggerDirection !== counterSign) return null;
    const h1MainExpansion = h1Structure.breakoutDirection === mainSign;
    const m15MainExpansion = m15Structure.breakoutDirection === mainSign;
    if (h1MainExpansion || m15MainExpansion) return null;

    let levels = calculateIntradayLevels(counterBias, entry, h4, h1, m15);
    levels = tightenCounterTrendLevels(levels, counterSign, entry, location.zone, m15);
    const executionQuality = evaluateExecutionQuality(levels, counterBias);
    if (levels.rewardRisk1 < STRATEGY_FILTERS.intradayMinimumRawRewardRiskB ||
        executionQuality.costAdjustedRewardRisk < STRATEGY_FILTERS.intradayMinimumCostAdjustedRewardRiskB ||
        executionQuality.costToRisk > STRATEGY_FILTERS.intradayMaximumCostToRisk) {
      return null;
    }
    const zoneLabel = formatZone(location.zone, m15.atr);
    const invalidation = counterSign > 0
      ? `M15有效跌破 ${zoneLabel} 或触及止损 ${strategyPrice(levels.stopLoss)}，策略失效。`
      : `M15有效站上 ${zoneLabel} 或触及止损 ${strategyPrice(levels.stopLoss)}，策略失效。`;
    return {
      bias: counterBias,
      candidateBias: counterBias,
      strategyType: "countertrend",
      strategyLabel: `${patternName}策略`,
      actionable: true,
      directionLabel: `${patternName}${counterDirection}`,
      priority: "B · 逆势价格机会",
      ...levels,
      summary: `H4仍以${mainDirection}为主，但价格进入${zoneLabel}的关键${location.side === "support" ? "支撑" : "压力"}区，M15形成${m15Structure.setupLabel}并由${m15Structure.triggerLabel}触发，因此生成${patternName}${counterDirection}。成交量、MACD、RSI和策略评分均不参与该判断。${executionQuality.label}。`,
      trigger: `Setup：${m15Structure.setupLabel}；执行触发：${m15Structure.triggerLabel}。仅按${patternName}处理，不视为H4趋势反转；目标优先取最近反向结构区域。${invalidation}`
    };
  }

  function buildIntradayStrategies(results, entryPrice) {
    const primary = {
      ...buildIntradayStrategy(results, entryPrice),
      strategyType: "primary",
      strategyLabel: "顺势主策略"
    };
    const counterTrend = buildCounterTrendIntradayStrategy(results, entryPrice);
    return (counterTrend ? [primary, counterTrend] : [primary]).map((strategy) => ({
      ...strategy,
      portfolioRule: intradayPortfolioRiskRule()
    }));
  }

  function strategyPrice(value) {
    return Number.isFinite(value) ? priceFormat.format(value) : "—";
  }

  function intradayStrategyFingerprint(strategy, m15) {
    const strategyType = strategy?.strategyType || "primary";
    if (!strategy?.actionable) return `waiting-${strategyType}-${strategy?.candidateBias || "neutral"}`;
    const entryCenter = (strategy.entryLow + strategy.entryHigh) / 2;
    const bucketSize = Math.max((m15?.atr || 0) * 0.6, entryCenter * 0.0005, 0.000001);
    const entryBucket = Math.round(entryCenter / bucketSize);
    const priorityCode = String(strategy.priority || "").split("·")[0].trim();
    return `${strategyType}-${strategy.bias}-${priorityCode}-${entryBucket}`;
  }

  function createIntradayStrategyRecord(strategy, entryPrice, m15) {
    const generatedAt = Date.now();
    return {
      id: `strategy-${state.symbol}-${generatedAt}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: state.symbol,
      generatedAt,
      referencePrice: Number.isFinite(entryPrice) ? entryPrice : null,
      fingerprint: intradayStrategyFingerprint(strategy, m15),
      strategy
    };
  }

  function updateIntradayStrategyFeed(nextRecords) {
    nextRecords = Array.isArray(nextRecords) ? nextRecords : [nextRecords].filter(Boolean);
    const activeRecords = Array.isArray(state.currentIntradayStrategies) ? state.currentIntradayStrategies : [];
    const previousRecords = activeRecords.length
      ? activeRecords
      : state.currentIntradayStrategy
        ? [state.currentIntradayStrategy]
        : [];
    let history = [...(state.intradayStrategyHistory[state.symbol] || [])];
    const nextFingerprints = new Set(nextRecords
      .filter((record) => record.strategy.actionable)
      .map((record) => record.fingerprint));
    for (const previous of previousRecords) {
      if (previous.strategy?.actionable && !nextFingerprints.has(previous.fingerprint)) {
        history = [previous, ...history.filter((record) => record.fingerprint !== previous.fingerprint)].slice(0, 8);
      }
    }
    const normalized = nextRecords.map((nextRecord) => {
      const previous = previousRecords.find((record) => record.fingerprint === nextRecord.fingerprint);
      if (nextRecord.strategy.actionable && previous) {
        nextRecord.id = previous.id;
        nextRecord.generatedAt = previous.generatedAt;
      }
      if (nextRecord.strategy.actionable) {
        history = history.filter((record) => record.fingerprint !== nextRecord.fingerprint);
      }
      return nextRecord;
    });
    state.currentIntradayStrategies = normalized;
    state.currentIntradayStrategy = normalized[0] || null;
    state.intradayStrategyHistory = { ...state.intradayStrategyHistory, [state.symbol]: history.slice(0, 8) };
    renderIntradayStrategyHistory();
  }

  function renderActiveSupplementalStrategies(records) {
    const container = $("active-intraday-strategies");
    if (!container) return;
    const supplemental = records.slice(1).filter((record) => record.strategy.actionable);
    container.hidden = supplemental.length === 0;
    container.innerHTML = supplemental.map((record) => {
      const strategy = record.strategy;
      const locked = isStrategyRecordLocked(record);
      return `
        <article class="strategy-list-item" data-bias="${escapeStrategyHtml(strategy.bias)}" data-strategy-id="${escapeStrategyHtml(record.id)}">
          <div class="strategy-head">
            <div><h3>${escapeStrategyHtml(strategy.strategyLabel)}</h3><p>与顺势主策略并列 · 独立止损与失效条件</p></div>
            <button class="strategy-action primary" type="button" data-lock-strategy-id="${escapeStrategyHtml(record.id)}">${locked ? "更新这条锁定" : "锁定这条策略"}</button>
          </div>
          ${strategyMetricsMarkup(strategy)}
          ${strategyNotesMarkup(strategy)}
        </article>`;
    }).join("");
  }

  function renderIntradayStrategy(results = state.analysisResults) {
    const hasFrames = Boolean(results?.h4 && results?.h1 && results?.m15);
    const entryPrice = Number.isFinite(state.book?.mid) ? state.book.mid : results?.m15?.price;
    const strategies = buildIntradayStrategies(results || {}, entryPrice);
    const strategy = strategies[0];
    const records = strategies.map((item) => createIntradayStrategyRecord(item, entryPrice, results?.m15));
    const card = $("intraday-strategy");
    card.dataset.bias = strategy.bias;
    $("primary-intraday-strategy").dataset.bias = strategy.bias;
    $("strategy-direction").textContent = strategy.directionLabel;
    $("strategy-priority").textContent = strategy.priority;
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
    $("strategy-portfolio-rule").textContent = strategy.portfolioRule || intradayPortfolioRiskRule();
    updateIntradayStrategyFeed(records);
    renderActiveSupplementalStrategies(state.currentIntradayStrategies);
    updateLockStrategyButton();
    const historyCount = (state.intradayStrategyHistory[state.symbol] || []).length;
    const activeCount = state.currentIntradayStrategies.filter((record) => record.strategy.actionable).length;
    const activeCopy = activeCount > 1 ? ` · 当前并列${activeCount}条策略` : "";
    const historyCopy = historyCount ? ` · 保留此前${historyCount}条策略` : "";
    $("strategy-status").textContent = hasFrames
      ? `日内价格行为：H4确定主方向，H1确认位置，M15负责触发；关键支撑压力配合M15反向拒绝时可并列生成逆势回调策略；${Number.isFinite(state.book?.mid) ? "入场区随实时中间价更新" : "暂用M15最近收盘作为入场参考"}${activeCopy}${historyCopy} · ${formatTime(Date.now())}`
      : "等待H4、H1与M15已收盘K线…";
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
    $(`${key}-levels`).textContent = `支撑 ${result.analysisSupportZone}（${describeLevelZone(result.supportLevel)}）；压力 ${result.analysisResistanceZone}（${describeLevelZone(result.resistanceLevel)}）；ATR(14)=${analysisPriceFormat.format(result.atr)}。`;
    $(`${key}-conclusion`).textContent = conclusion;
  }

  function renderAnalysisUnavailable(key, message) {
    $(`${key}-card`).dataset.bias = "neutral";
    $(`${key}-state`).textContent = "数据不足";
    $(`${key}-direction-score`).textContent = "—";
    $(`${key}-setup-score`).textContent = "—";
    $(`${key}-confidence`).textContent = "—";
    [`${key}-structure`, `${key}-opportunity`, `${key}-levels`].forEach((id) => $(id).textContent = "—");
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
    $("analysis-status").textContent = `${failed ? `${failed}个周期延迟 · ` : ""}${microstructureStatusText()} · 行情卡片与日内策略统一采用成交密集＋结构＋位置＋触发 · ${formatTime(Date.now())}`;
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
  $("lock-strategy-button").addEventListener("click", lockCurrentStrategy);
  $("intraday-strategy-history").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lock-strategy-id]");
    if (button) lockIntradayStrategy(button.dataset.lockStrategyId);
  });
  $("active-intraday-strategies").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lock-strategy-id]");
    if (button) lockIntradayStrategy(button.dataset.lockStrategyId);
  });
  $("locked-strategy-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-locked-id]");
    if (!button) return;
    if (window.confirm("确认删除这条已锁定的日内策略吗？")) {
      removeLockedStrategy(button.dataset.removeLockedId);
    }
  });
  $("clear-locked-strategy-button").addEventListener("click", () => {
    if (window.confirm(`确认清除 ${state.symbol} 的全部已锁定日内策略吗？`)) clearLockedStrategy();
  });

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

  state.lockedStrategies = readLockedStrategies();
  updateSymbolUI();
  renderLockedStrategy();
  updateIntervalButtons();
  updateChartCopy();
  syncTimelineInputs();
  seedCurrentData();
  loadHistory();
  loadAnalysis();
  loadMicrostructure();
  connectBinance();
  setInterval(() => {
    if (!state.wsOk) seedCurrentData();
  }, 5000);
  setInterval(setLiveStatus, 1000);
  setInterval(refreshAnalysisForMicrostructure, 10000);
  setInterval(refreshRecentAggregateTrades, 15000);
  setInterval(loadHistory, 60000);
  setInterval(loadAnalysis, 60000);
})();
