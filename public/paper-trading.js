(() => {
  "use strict";

  const DB_NAME = "paper-trading-journal";
  const DB_VERSION = 1;
  const STORE_NAME = "records";
  const STATE_KEY = "paper-account";
  const SIMULATION_STATE_KEY = "simulation-account";
  const DEFAULT_SIMULATION_CAPITAL = 100000;
  const SIMULATION_REFRESH_INTERVAL = 15000;
  const CLOUD_SYNC_INTERVAL = 30000;
  const CLOUD_SYNC_DEBOUNCE = 700;
  const SIDE_LABELS = { long: "做多", short: "做空" };
  const REASON_ORDER = ["支撑/压力", "K线反转", "RSI超买超卖", "区间高抛低吸", "突破/回踩", "其他"];
  const state = {
    trades: [], simulationTrades: [], simulationCapital: DEFAULT_SIMULATION_CAPITAL,
    simulationQuotes: new Map(), quoteHistory: new Map(), simulationSide: "long",
    selectedWeekStart: startOfWeek(Date.now()), toastTimer: null, simulationTimer: null,
    currentView: "monitor", simulationSaving: false,
    simulationCapitalUpdatedAt: 0, simulationDeletedTrades: {}, cloudRevision: 0,
    cloudSyncReady: false, cloudSyncTimer: null, cloudSyncInterval: null,
    cloudSyncInFlight: false, cloudSyncQueued: false
  };
  const $ = (id) => document.getElementById(id);
  const moneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const quantityFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function id() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatMoney(value, signed = false) {
    if (!Number.isFinite(value)) return "—";
    return `${signed && value > 0 ? "+" : ""}${moneyFormatter.format(value)} USDT`;
  }

  function formatPrice(value) {
    return Number.isFinite(value) ? priceFormatter.format(value) : "—";
  }

  function formatQuantity(value) {
    return Number.isFinite(value) ? quantityFormatter.format(value) : "—";
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}%` : "—";
  }

  function formatDate(timestamp) {
    return Number.isFinite(timestamp) ? dateFormatter.format(new Date(timestamp)).replace("24:", "00:") : "—";
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    const minutes = Math.floor(milliseconds / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    const remainder = minutes % 60;
    return `${days ? `${days}天 ` : ""}${hours ? `${hours}小时 ` : ""}${remainder}分钟`;
  }

  function startOfWeek(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    const weekday = date.getDay() || 7;
    date.setDate(date.getDate() - weekday + 1);
    return date.getTime();
  }

  function endOfWeek(weekStart) {
    return weekStart + 7 * 24 * 60 * 60 * 1000;
  }

  function formatWeek(weekStart) {
    const start = new Date(weekStart);
    const end = new Date(endOfWeek(weekStart) - 1);
    const part = (date) => `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
    return `${part(start)} – ${part(end)}`;
  }

  function confidenceLabel(count) {
    if (count < 10) return "样本不足";
    if (count < 30) return "初步倾向";
    return "较稳定";
  }

  function toLocalInput(timestamp) {
    const date = new Date(timestamp);
    const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return adjusted.toISOString().slice(0, 16);
  }

  function openDatabase() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  async function readTrades() {
    const database = await openDatabase();
    if (!database) return [];
    return new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => resolve(Array.isArray(request.result?.value?.trades) ? request.result.value.trades : []);
      request.onerror = () => resolve([]);
      transaction.oncomplete = () => database.close();
    });
  }

  async function saveTrades() {
    const database = await openDatabase();
    if (!database) return;
    const snapshot = { initialBalance: 0, realizedPnl: state.trades.reduce((sum, trade) => sum + trade.pnl, 0), positions: [], trades: state.trades };
    await new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key: STATE_KEY, value: snapshot, savedAt: Date.now() });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); resolve(); };
    });
  }

  async function readSimulationState() {
    const database = await openDatabase();
    if (!database) return { capital: DEFAULT_SIMULATION_CAPITAL, capitalUpdatedAt: 0, trades: [], deletedTrades: {} };
    return new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(SIMULATION_STATE_KEY);
      request.onsuccess = () => {
        const value = request.result?.value || {};
        const capital = Number(value.capital);
        const savedAt = Number(request.result?.savedAt) || 0;
        resolve({
          capital: Number.isFinite(capital) && capital > 0 ? capital : DEFAULT_SIMULATION_CAPITAL,
          capitalUpdatedAt: Number(value.capitalUpdatedAt) || (Number.isFinite(capital) && capital > 0 && capital !== DEFAULT_SIMULATION_CAPITAL ? savedAt : 0),
          trades: Array.isArray(value.trades) ? value.trades : [],
          deletedTrades: value.deletedTrades && typeof value.deletedTrades === "object" ? value.deletedTrades : {}
        });
      };
      request.onerror = () => resolve({ capital: DEFAULT_SIMULATION_CAPITAL, capitalUpdatedAt: 0, trades: [], deletedTrades: {} });
      transaction.oncomplete = () => database.close();
    });
  }

  function currentCloudState() {
    return window.TradingCloudSync.normalizeState({
      capital: state.simulationCapital,
      capitalUpdatedAt: state.simulationCapitalUpdatedAt,
      trades: state.simulationTrades,
      deletedTrades: state.simulationDeletedTrades
    });
  }

  async function saveSimulationState({ syncCloud = true } = {}) {
    const database = await openDatabase();
    const snapshot = currentCloudState();
    if (database) {
      await new Promise((resolve) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({ key: SIMULATION_STATE_KEY, value: snapshot, savedAt: Date.now() });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); resolve(); };
      });
    }
    if (syncCloud && state.cloudSyncReady) scheduleCloudSync();
  }

  function setCloudSyncStatus(syncState, label) {
    const element = $("cloud-sync-status");
    if (!element) return;
    element.dataset.state = syncState;
    element.innerHTML = `<i></i>${escapeHtml(label)}`;
  }

  function applyCloudState(value) {
    const normalized = window.TradingCloudSync.normalizeState(value);
    state.simulationCapital = normalized.capital;
    state.simulationCapitalUpdatedAt = normalized.capitalUpdatedAt;
    state.simulationDeletedTrades = normalized.deletedTrades;
    state.simulationTrades = normalized.trades.map(normalizeSimulationTrade).filter(Boolean);
  }

  async function requestCloudSnapshot() {
    const response = await fetch("/api/sync", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`云端读取失败（${response.status}）`);
    return response.json();
  }

  async function writeCloudSnapshot(revision, snapshot) {
    return fetch("/api/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ revision, state: snapshot })
    });
  }

  async function syncCloudState() {
    if (!state.cloudSyncReady || state.cloudSyncInFlight) {
      if (state.cloudSyncInFlight) state.cloudSyncQueued = true;
      return;
    }
    state.cloudSyncInFlight = true;
    clearTimeout(state.cloudSyncTimer);
    setCloudSyncStatus("syncing", "云端同步中");
    try {
      let envelope = await requestCloudSnapshot();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const local = currentCloudState();
        const remote = window.TradingCloudSync.normalizeState(envelope.state);
        const merged = window.TradingCloudSync.mergeStates(local, remote);
        applyCloudState(merged);
        await saveSimulationState({ syncCloud: false });
        renderAll();
        if (window.TradingCloudSync.statesEqual(remote, merged)) {
          state.cloudRevision = Number(envelope.revision) || 0;
          setCloudSyncStatus("synced", "云端已同步");
          return;
        }
        const response = await writeCloudSnapshot(Number(envelope.revision) || 0, merged);
        if (response.status === 409) {
          envelope = await requestCloudSnapshot();
          continue;
        }
        if (!response.ok) throw new Error(`云端写入失败（${response.status}）`);
        const result = await response.json();
        state.cloudRevision = Number(result.revision) || 0;
        setCloudSyncStatus("synced", "云端已同步");
        return;
      }
      throw new Error("云端版本冲突，请稍后重试");
    } catch (error) {
      setCloudSyncStatus(navigator.onLine ? "error" : "offline", navigator.onLine ? "本地已保存，等待同步" : "离线缓存中");
      console.warn("Cloud sync deferred:", error);
    } finally {
      state.cloudSyncInFlight = false;
      if (state.cloudSyncQueued) {
        state.cloudSyncQueued = false;
        scheduleCloudSync(100);
      }
    }
  }

  function scheduleCloudSync(delay = CLOUD_SYNC_DEBOUNCE) {
    if (!state.cloudSyncReady) return;
    clearTimeout(state.cloudSyncTimer);
    state.cloudSyncTimer = window.setTimeout(syncCloudState, delay);
  }

  function normalizeTrade(trade) {
    const closed = trade?.status === "open" || trade?.closed === false ? false : true;
    const openAt = Number(trade?.openAt);
    const closeAt = trade?.closeAt === null || trade?.closeAt === undefined || trade?.closeAt === "" ? NaN : Number(trade.closeAt);
    const entryPrice = Number(trade?.entryPrice);
    const closePrice = trade?.closePrice === null || trade?.closePrice === undefined || trade?.closePrice === "" ? NaN : Number(trade.closePrice);
    const pnl = Number(trade?.pnl);
    if (![openAt, entryPrice, pnl].every(Number.isFinite)) return null;
    if (closed && (![closeAt, closePrice].every(Number.isFinite) || closeAt < openAt)) return null;
    const quantity = Number(trade?.quantity);
    const leverage = Number(trade?.leverage);
    const stopLoss = Number(trade?.stopLoss);
    const takeProfit = Number(trade?.takeProfit);
    const normalizedLeverage = Number.isFinite(leverage) && leverage >= 1 ? leverage : 1;
    const risk = Number.isFinite(quantity) && quantity > 0 && Number.isFinite(stopLoss) && stopLoss > 0
      ? Math.abs(entryPrice - stopLoss) * quantity * normalizedLeverage : NaN;
    const normalizedQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : null;
    const normalizeLeg = (leg, final = false) => {
      const time = Number(leg?.time);
      const price = Number(leg?.price);
      const legQuantity = Number(leg?.quantity);
      return Number.isFinite(time) && Number.isFinite(price) && price > 0 && Number.isFinite(legQuantity) && legQuantity > 0
        ? { time, price, quantity: legQuantity, final: final || leg?.final === true }
        : null;
    };
    const storedEntries = Array.isArray(trade?.entryLegs) ? trade.entryLegs.map((leg) => normalizeLeg(leg)).filter(Boolean) : [];
    const entryLegs = storedEntries.length ? storedEntries.sort((a, b) => a.time - b.time) : [{ time: openAt, price: entryPrice, quantity: normalizedQuantity || 1, final: false }];
    const storedExits = Array.isArray(trade?.exitLegs) ? trade.exitLegs.map((leg) => normalizeLeg(leg, leg?.final === true)).filter(Boolean) : [];
    let exitLegs = storedExits.length ? storedExits.sort((a, b) => a.time - b.time) : closed ? [{ time: closeAt, price: closePrice, quantity: normalizedQuantity || 1, final: true }] : [];
    if (closed && !exitLegs.some((leg) => leg.final)) exitLegs = exitLegs.map((leg, index) => ({ ...leg, final: index === exitLegs.length - 1 }));
    if (!closed) exitLegs = exitLegs.map((leg) => ({ ...leg, final: false }));
    const calculatedRemaining = entryLegs.reduce((sum, leg) => sum + leg.quantity, 0) - exitLegs.reduce((sum, leg) => sum + leg.quantity, 0);
    const storedRemaining = Number(trade?.remainingQuantity);
    const remainingQuantity = closed ? 0 : Number.isFinite(storedRemaining) && storedRemaining > 0 ? storedRemaining : Math.max(0, calculatedRemaining);
    return {
      id: String(trade?.id || id()), symbol: String(trade?.symbol || "XAUUSDT"),
      side: trade?.side === "short" ? "short" : "long", status: closed ? "closed" : "open", closed,
      openAt, closeAt: closed ? closeAt : null, entryPrice, closePrice: Number.isFinite(closePrice) ? closePrice : null, pnl,
      quantity: normalizedQuantity, remainingQuantity, leverage: normalizedLeverage, entryLegs, exitLegs,
      stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
      takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null,
      reasons: Array.isArray(trade?.reasons) ? trade.reasons.map(String) : [],
      note: String(trade?.note || ""), exitReason: closed ? String(trade?.exitReason || "其他") : "",
      includeInAnalysis: trade?.includeInAnalysis !== false,
      rMultiple: closed && Number.isFinite(Number(trade?.rMultiple)) ? Number(trade.rMultiple) : closed && Number.isFinite(risk) && risk > 0 ? pnl / risk : null,
      lastPrice: Number.isFinite(Number(trade?.lastPrice)) ? Number(trade.lastPrice) : Number.isFinite(closePrice) ? closePrice : entryPrice,
      lastPriceAt: Number(trade?.lastPriceAt) || (closed ? closeAt : openAt)
    };
  }

  function normalizeSimulationTrade(trade) {
    const closed = trade?.status === "closed" || trade?.closed === true;
    const openAt = Number(trade?.openAt);
    const entryPrice = Number(trade?.entryPrice);
    const quantity = Number(trade?.quantity);
    const leverage = Number(trade?.leverage);
    const closeAt = closed ? Number(trade?.closeAt) : null;
    const closePrice = closed ? Number(trade?.closePrice) : null;
    const storedPnl = Number(trade?.pnl);
    if (![openAt, entryPrice, quantity, leverage].every(Number.isFinite) || entryPrice <= 0 || quantity < 0.1 || leverage < 1) return null;
    if (closed && (![closeAt, closePrice].every(Number.isFinite) || closeAt < openAt || closePrice <= 0)) return null;
    const direction = trade?.side === "short" ? -1 : 1;
    const pnl = closed && Number.isFinite(storedPnl) ? storedPnl : closed ? (closePrice - entryPrice) * quantity * leverage * direction : 0;
    const stopLoss = Number(trade?.stopLoss);
    const takeProfit = Number(trade?.takeProfit);
    const risk = Number.isFinite(stopLoss) && stopLoss > 0 ? Math.abs(entryPrice - stopLoss) * quantity * leverage : NaN;
    const lastPrice = Number(trade?.lastPrice);
    return {
      id: String(trade?.id || id()), symbol: String(trade?.symbol || "XAUUSDT"),
      side: trade?.side === "short" ? "short" : "long", status: closed ? "closed" : "open", closed,
      openAt, closeAt, entryPrice, closePrice, quantity, remainingQuantity: closed ? 0 : quantity, leverage,
      stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
      takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null,
      pnl, lastPrice: Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : entryPrice,
      lastPriceAt: Number(trade?.lastPriceAt) || openAt, exitReason: closed ? String(trade?.exitReason || "手动平仓") : "",
      reasons: Array.isArray(trade?.reasons) ? trade.reasons.map(String) : [],
      note: String(trade?.note || ""), includeInAnalysis: trade?.includeInAnalysis !== false,
      rMultiple: closed && Number.isFinite(risk) && risk > 0 ? pnl / risk : null,
      updatedAt: window.TradingCloudSync.tradeTimestamp(trade)
    };
  }

  function showToast(message, isError = false) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }

  function analysisTrades() {
    return state.simulationTrades.filter((trade) => trade.closed && trade.includeInAnalysis);
  }

  function simulationDirection(trade) {
    return trade.side === "short" ? -1 : 1;
  }

  function simulationQuoteFor(symbol) {
    return state.simulationQuotes.get(symbol) || null;
  }

  function simulationMarkPrice(trade) {
    const quote = simulationQuoteFor(trade.symbol);
    return Number(quote?.price) || Number(trade.lastPrice) || trade.entryPrice;
  }

  function simulationPnl(trade, price = simulationMarkPrice(trade)) {
    if (trade.closed) return trade.pnl;
    return (price - trade.entryPrice) * trade.quantity * trade.leverage * simulationDirection(trade);
  }

  function simulationAccountMetrics() {
    const openTrades = state.simulationTrades.filter((trade) => !trade.closed);
    const realized = state.simulationTrades.filter((trade) => trade.closed).reduce((sum, trade) => sum + trade.pnl, 0);
    const floating = openTrades.reduce((sum, trade) => sum + simulationPnl(trade), 0);
    const usedMargin = openTrades.reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0);
    const equity = state.simulationCapital + realized + floating;
    return {
      realized, floating, usedMargin, equity,
      available: equity - usedMargin,
      marginRatio: equity > 0 ? usedMargin / equity * 100 : usedMargin > 0 ? Infinity : 0
    };
  }

  function setMetricClass(element, value) {
    element.classList.toggle("metric-positive", Number.isFinite(value) && value > 0);
    element.classList.toggle("metric-negative", Number.isFinite(value) && value < 0);
  }

  function renderSimulationCapital() {
    const metrics = simulationAccountMetrics();
    if (document.activeElement !== $("simulation-capital")) $("simulation-capital").value = String(state.simulationCapital);
    $("simulation-available-funds").textContent = formatMoney(metrics.available);
    $("simulation-margin-ratio").textContent = Number.isFinite(metrics.marginRatio) ? formatPercent(metrics.marginRatio) : "∞";
    $("simulation-floating-pnl").textContent = formatMoney(metrics.floating, true);
    $("simulation-realized-pnl").textContent = formatMoney(metrics.realized, true);
    setMetricClass($("simulation-floating-pnl"), metrics.floating);
    setMetricClass($("simulation-realized-pnl"), metrics.realized);
    setMetricClass($("simulation-available-funds"), metrics.available);
  }

  function recordQuote(quote) {
    if (!quote || !Number.isFinite(Number(quote.price)) || !quote.symbol) return;
    const normalized = {
      ...state.simulationQuotes.get(quote.symbol), ...quote,
      symbol: String(quote.symbol), price: Number(quote.price), timestamp: Number(quote.timestamp) || Date.now()
    };
    state.simulationQuotes.set(normalized.symbol, normalized);
    const history = state.quoteHistory.get(normalized.symbol) || [];
    history.push({ price: normalized.price, timestamp: normalized.timestamp });
    if (history.length > 60) history.splice(0, history.length - 60);
    state.quoteHistory.set(normalized.symbol, history);
    state.simulationTrades.filter((trade) => !trade.closed && trade.symbol === normalized.symbol).forEach((trade) => {
      trade.lastPrice = normalized.price;
      trade.lastPriceAt = normalized.timestamp;
    });
  }

  function renderSimulationSpark(symbol) {
    const svg = $("simulation-price-spark");
    const values = (state.quoteHistory.get(symbol) || []).map((point) => point.price);
    if (!values.length) {
      svg.innerHTML = '<line x1="0" y1="40" x2="700" y2="40" stroke="rgba(129,159,181,.22)" stroke-dasharray="5 6"/>';
      return;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, Math.abs(max) * 0.0002, 0.01);
    const points = values.map((value, index) => `${values.length === 1 ? 0 : index / (values.length - 1) * 700},${70 - (value - min) / span * 55}`).join(" ");
    const area = `0,80 ${points} 700,80`;
    svg.innerHTML = `<defs><linearGradient id="simulation-spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2ad6a0" stop-opacity=".25"/><stop offset="100%" stop-color="#2ad6a0" stop-opacity="0"/></linearGradient></defs><polygon points="${area}" fill="url(#simulation-spark-fill)"/><polyline points="${points}" fill="none" stroke="#2ad6a0" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  function renderSimulationQuote() {
    const symbol = $("simulation-symbol").value;
    const quote = simulationQuoteFor(symbol);
    $("simulation-quote-symbol").textContent = `${symbol} · BINANCE FUTURES`;
    if (!quote) {
      $("simulation-connection").classList.remove("connected");
      $("simulation-connection").innerHTML = "<i></i>等待报价";
      $("simulation-live-price").textContent = "—";
      $("simulation-reference-price").textContent = "—";
      ["simulation-day-change", "simulation-price-time", "simulation-bid", "simulation-ask", "simulation-day-high", "simulation-day-low"].forEach((idName) => { $(idName).textContent = "—"; });
      renderSimulationSpark(symbol);
      return;
    }
    const change = Number(quote.changePercent);
    $("simulation-connection").classList.add("connected");
    $("simulation-connection").innerHTML = "<i></i>实时报价已连接";
    $("simulation-live-price").textContent = formatPrice(quote.price);
    $("simulation-reference-price").textContent = formatPrice(quote.price);
    $("simulation-day-change").textContent = Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—";
    $("simulation-day-change").className = Number.isFinite(change) && change > 0 ? "positive" : Number.isFinite(change) && change < 0 ? "negative" : "";
    $("simulation-price-time").textContent = formatDate(quote.timestamp);
    $("simulation-bid").textContent = formatPrice(Number(quote.bid));
    $("simulation-ask").textContent = formatPrice(Number(quote.ask));
    $("simulation-day-high").textContent = formatPrice(Number(quote.high));
    $("simulation-day-low").textContent = formatPrice(Number(quote.low));
    renderSimulationSpark(symbol);
  }

  function tradeDisplayMark(trade) {
    if (trade.closed) return trade.closePrice;
    return Number(simulationQuoteFor(trade.symbol)?.price) || Number(trade.lastPrice) || trade.entryPrice;
  }

  function tradeDisplayPnl(trade, mark = tradeDisplayMark(trade)) {
    if (trade.closed) return trade.pnl;
    return simulationPnl(trade, mark);
  }

  function estimatedLiquidation(trade, mark) {
    const calculator = window.BinanceLiquidationCalculator;
    if (!calculator?.estimateIsolatedLiquidation) return null;
    const estimate = calculator.estimateIsolatedLiquidation({
      entryPrice: trade.entryPrice,
      quantity: Number.isFinite(trade.remainingQuantity) ? trade.remainingQuantity : trade.quantity,
      leverage: trade.leverage,
      side: trade.side
    });
    if (!estimate) return null;
    return {
      ...estimate,
      distance: calculator.distanceFromMark(mark, estimate.price, trade.side)
    };
  }

  function liquidationPriceCell(trade, mark) {
    const estimate = estimatedLiquidation(trade, mark);
    if (!estimate) return '<td class="liquidation-price"><b>—</b><small>无法估算</small></td>';
    const distance = estimate.distance;
    const distanceText = Number.isFinite(distance)
      ? distance <= 0 ? "已越过估算线" : `距现价 ${distance.toFixed(2)}%`
      : "逐仓估算";
    const riskClass = Number.isFinite(distance) && distance <= 2
      ? " critical"
      : Number.isFinite(distance) && distance <= 5 ? " near" : "";
    const title = `按逐仓模式及 ${(estimate.maintenanceMarginRate * 100).toFixed(2)}% 基准维持保证金率估算；未计手续费、资金费率、追加保证金及账户档位调整。`;
    return `<td class="liquidation-price${riskClass}" title="${escapeHtml(title)}"><b>${escapeHtml(formatPrice(estimate.price))}</b><small>${escapeHtml(distanceText)}</small></td>`;
  }

  function unifiedRecordRow(trade, includeLiquidation = false) {
    const mark = tradeDisplayMark(trade);
    const pnl = tradeDisplayPnl(trade, mark);
    const end = trade.closed ? trade.closeAt : Date.now();
    const status = trade.closed ? `<span class="simulation-status closed">已平仓 · ${escapeHtml(trade.exitReason)}</span>` : '<span class="simulation-status open">持仓中</span>';
    const quantity = trade.closed ? trade.quantity : Number.isFinite(trade.remainingQuantity) ? trade.remainingQuantity : trade.quantity;
    const actions = `${trade.closed ? "" : `<button class="row-button" data-close-simulation="${escapeHtml(trade.id)}" type="button">按最新价平仓</button>`}<button class="row-button" data-edit-trade="${escapeHtml(trade.id)}" type="button">编辑</button><button class="row-button delete" data-delete-simulation="${escapeHtml(trade.id)}" type="button">删除</button>`;
    return `<tr>
      <td><div class="record-symbol-line"><b>${escapeHtml(trade.symbol)}</b></div>${status}</td>
      <td class="${trade.side === "long" ? "direction-long" : "direction-short"}">${SIDE_LABELS[trade.side]}</td>
      <td>${escapeHtml(formatPrice(trade.entryPrice))}</td>
      <td><div class="paired-value"><span>开 ${escapeHtml(formatDate(trade.openAt))}</span><span>${trade.closed ? `平 ${escapeHtml(formatDate(trade.closeAt))}` : "平 —"}</span></div></td>
      ${includeLiquidation ? "" : `<td>${escapeHtml(formatPrice(trade.closePrice))}</td>`}
      <td>${escapeHtml(formatQuantity(quantity))}</td><td>${escapeHtml(`${trade.leverage}x`)}</td>
      <td>${escapeHtml(formatDuration(end - trade.openAt))}</td>
      <td class="${pnl > 0 ? "metric-positive" : pnl < 0 ? "metric-negative" : ""}">${escapeHtml(formatMoney(pnl, true))}</td>
      <td><div class="paired-value"><span>损 ${escapeHtml(formatPrice(trade.stopLoss))}</span><span>盈 ${escapeHtml(formatPrice(trade.takeProfit))}</span></div></td>
      ${includeLiquidation ? liquidationPriceCell(trade, mark) : ""}
      <td class="record-reasons">${trade.reasons.length ? trade.reasons.map(escapeHtml).join(" / ") : "未填写"}</td>
      <td><div class="row-actions">${actions}</div></td>
    </tr>`;
  }

  function renderSimulation() {
    renderSimulationCapital();
    renderSimulationQuote();
    const ordered = [...state.simulationTrades].sort((a, b) => Number(a.closed) - Number(b.closed) || b.openAt - a.openAt);
    const openTrades = ordered.filter((trade) => !trade.closed);
    const closedTrades = ordered.filter((trade) => trade.closed);
    $("simulation-open-body").innerHTML = openTrades.length
      ? openTrades.map((trade) => unifiedRecordRow(trade, true)).join("")
      : '<tr class="empty-row"><td colspan="12">暂无持仓中的交易；可按最新价开仓或手动录入。</td></tr>';
    $("simulation-closed-body").innerHTML = closedTrades.length
      ? closedTrades.map((trade) => unifiedRecordRow(trade, false)).join("")
      : '<tr class="empty-row"><td colspan="12">暂无已平仓交易记录。</td></tr>';
  }

  async function refreshSimulationQuote(symbol = $("simulation-symbol").value, force = false, includeStats = true) {
    if (!window.marketMonitor?.getLatestQuote) return null;
    try {
      const quote = await window.marketMonitor.getLatestQuote(symbol, { force, includeStats });
      recordQuote(quote);
      await checkSimulationTriggers(symbol, Number(quote.price), Number(quote.timestamp) || Date.now());
      renderSimulation();
      return quote;
    } catch (error) {
      if (symbol === $("simulation-symbol").value) {
        $("simulation-connection").classList.remove("connected");
        $("simulation-connection").innerHTML = "<i></i>报价暂不可用";
      }
      return null;
    }
  }

  function readSimulationForm(entryPrice) {
    const quantity = Number($("simulation-quantity").value);
    const leverage = Number($("simulation-leverage").value);
    const stopLoss = Number($("simulation-stop").value);
    const takeProfit = Number($("simulation-target").value);
    const reasons = [...document.querySelectorAll('input[name="simulation-entry-reason"]:checked')].map((input) => input.value);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { error: "暂未取得有效报价，请刷新价格后再试。" };
    if (!Number.isFinite(quantity) || quantity < 0.1) return { error: "开仓数量最小为 0.1。" };
    if (!Number.isFinite(leverage) || leverage < 1) return { error: "杠杆倍数最小为 1。" };
    if (!reasons.length) return { error: "请至少选择一项开仓依据。" };
    const stop = Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null;
    const target = Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null;
    if (state.simulationSide === "long" && stop !== null && stop >= entryPrice) return { error: "做多止损应低于开仓价。" };
    if (state.simulationSide === "long" && target !== null && target <= entryPrice) return { error: "做多止盈应高于开仓价。" };
    if (state.simulationSide === "short" && stop !== null && stop <= entryPrice) return { error: "做空止损应高于开仓价。" };
    if (state.simulationSide === "short" && target !== null && target >= entryPrice) return { error: "做空止盈应低于开仓价。" };
    const requiredMargin = entryPrice * quantity;
    if (requiredMargin > simulationAccountMetrics().available) return { error: `可用资金不足，本次需要保证金 ${formatMoney(requiredMargin)}。` };
    return { quantity, leverage, stopLoss: stop, takeProfit: target, reasons };
  }

  async function openSimulationTrade(event) {
    event?.preventDefault();
    if (state.simulationSaving) return;
    state.simulationSaving = true;
    $("open-simulation-trade").disabled = true;
    $("simulation-form-error").textContent = "正在获取最新报价…";
    const symbol = $("simulation-symbol").value;
    const quote = await refreshSimulationQuote(symbol, true, true);
    const form = readSimulationForm(Number(quote?.price));
    if (form.error) {
      $("simulation-form-error").textContent = form.error;
      state.simulationSaving = false;
      $("open-simulation-trade").disabled = false;
      return;
    }
    const now = Number(quote.timestamp) || Date.now();
    state.simulationTrades.unshift(normalizeSimulationTrade({
      id: id(), symbol, side: state.simulationSide, status: "open", closed: false,
      openAt: now, entryPrice: Number(quote.price), quantity: form.quantity, leverage: form.leverage,
      stopLoss: form.stopLoss, takeProfit: form.takeProfit, pnl: 0, lastPrice: Number(quote.price), lastPriceAt: now,
      reasons: form.reasons, includeInAnalysis: true, updatedAt: now
    }));
    await saveSimulationState();
    $("simulation-form-error").textContent = "页面保持打开且行情连接正常时，止损/止盈触价会自动平仓；模拟盈亏暂不包含费用。";
    state.simulationSaving = false;
    $("open-simulation-trade").disabled = false;
    document.querySelectorAll('input[name="simulation-entry-reason"]').forEach((input) => { input.checked = false; });
    renderSimulation();
    showToast(`${symbol} 已按 ${formatPrice(Number(quote.price))} 模拟开仓。`);
  }

  async function settleSimulationTrade(trade, price, timestamp, reason) {
    if (!trade || trade.closed || !Number.isFinite(price) || price <= 0) return false;
    trade.lastPrice = price;
    trade.lastPriceAt = timestamp;
    trade.closePrice = price;
    trade.closeAt = timestamp;
    trade.pnl = simulationPnl(trade, price);
    trade.status = "closed";
    trade.closed = true;
    trade.remainingQuantity = 0;
    trade.exitReason = reason;
    trade.updatedAt = Date.now();
    const risk = Number.isFinite(trade.stopLoss) ? Math.abs(trade.entryPrice - trade.stopLoss) * trade.quantity * trade.leverage : NaN;
    trade.rMultiple = Number.isFinite(risk) && risk > 0 ? trade.pnl / risk : null;
    return true;
  }

  async function checkSimulationTriggers(symbol, price, timestamp) {
    let changed = false;
    for (const trade of state.simulationTrades.filter((item) => !item.closed && item.symbol === symbol)) {
      const hitStop = trade.side === "long" ? Number.isFinite(trade.stopLoss) && price <= trade.stopLoss : Number.isFinite(trade.stopLoss) && price >= trade.stopLoss;
      const hitTarget = trade.side === "long" ? Number.isFinite(trade.takeProfit) && price >= trade.takeProfit : Number.isFinite(trade.takeProfit) && price <= trade.takeProfit;
      if (hitStop || hitTarget) changed = await settleSimulationTrade(trade, price, timestamp, hitStop ? "止损" : "止盈") || changed;
    }
    if (changed) {
      await saveSimulationState();
      renderWeekly();
      renderHabits();
      showToast("模拟持仓已按止损/止盈条件自动平仓。");
    }
  }

  async function closeSimulationTrade(tradeId) {
    const trade = state.simulationTrades.find((item) => item.id === tradeId && !item.closed);
    if (!trade || !window.confirm("确定按最新价格平掉这笔模拟持仓吗？")) return;
    const quote = await refreshSimulationQuote(trade.symbol, true, trade.symbol === $("simulation-symbol").value);
    if (!quote) return showToast("最新报价获取失败，本次未平仓。", true);
    if (await settleSimulationTrade(trade, Number(quote.price), Number(quote.timestamp) || Date.now(), "手动平仓")) {
      await saveSimulationState();
      renderAll();
      showToast(`模拟持仓已按 ${formatPrice(Number(quote.price))} 平仓，并纳入分析。`);
    }
  }

  async function deleteSimulationTrade(tradeId) {
    if (!window.confirm("确定删除这笔模拟交易吗？删除后无法恢复。")) return;
    state.simulationDeletedTrades[tradeId] = Date.now();
    state.simulationTrades = state.simulationTrades.filter((trade) => trade.id !== tradeId);
    await saveSimulationState();
    renderAll();
    showToast("模拟交易记录已删除。");
  }

  async function saveSimulationCapital() {
    const capital = Number($("simulation-capital").value);
    if (!Number.isFinite(capital) || capital <= 0) return showToast("资金规模必须大于 0。", true);
    state.simulationCapital = capital;
    state.simulationCapitalUpdatedAt = Date.now();
    await saveSimulationState();
    renderSimulationCapital();
    showToast("模拟账户资金规模已更新。");
  }

  async function refreshOpenSimulationQuotes(force = false) {
    const openSymbols = state.simulationTrades.filter((trade) => !trade.closed).map((trade) => trade.symbol);
    if (state.currentView !== "simulation" && !openSymbols.length) return;
    const selected = $("simulation-symbol").value;
    const symbols = [...new Set([
      ...(state.currentView === "simulation" ? [selected] : []),
      ...openSymbols
    ])];
    for (const symbol of symbols) await refreshSimulationQuote(symbol, force, symbol === selected);
  }

  function selectedReasons() {
    return [...document.querySelectorAll('input[name="real-entry-reason"]:checked')].map((input) => input.value);
  }

  function syncTradeStatus() {
    const isOpen = $("trade-status").value === "open";
    ["trade-close-time", "trade-close-price", "trade-exit-reason"].forEach((idName) => { $(idName).disabled = isOpen; });
    $("trade-pnl-label").textContent = isOpen ? "已实现盈亏（未计费用）" : "自动盈亏（未计费用）";
    $("trade-close-price").placeholder = isOpen ? "持仓中无需填写" : "结算剩余仓位";
    if (!$("trade-edit-id").value) $("save-trade").textContent = isOpen ? "保存模拟持仓" : "保存模拟交易";
  }

  function calculateExecutionPlan() {
    const closed = $("trade-status").value !== "open";
    const openAt = new Date($("trade-open-time").value).getTime();
    const closeAt = closed ? new Date($("trade-close-time").value).getTime() : null;
    const firstEntryPrice = Number($("trade-entry-price").value);
    const finalClosePrice = closed ? Number($("trade-close-price").value) : null;
    const firstQuantity = Number($("trade-quantity").value);
    const leverage = Number($("trade-leverage").value);
    if (!Number.isFinite(openAt)) return { error: "请填写首次开仓时间。" };
    if (closed && !Number.isFinite(closeAt)) return { error: "请填写最终平仓时间。" };
    if (closed && closeAt < openAt) return { error: "最终平仓时间不能早于首次开仓时间。" };
    if (!Number.isFinite(firstEntryPrice) || firstEntryPrice <= 0) return { error: "请填写有效的首次开仓价。" };
    if (closed && (!Number.isFinite(finalClosePrice) || finalClosePrice <= 0)) return { error: "请填写有效的最终平仓价。" };
    if (!Number.isFinite(firstQuantity) || firstQuantity < 0.1) return { error: "首次开仓数量最小为 0.1。" };
    if (!Number.isFinite(leverage) || leverage < 1) return { error: "杠杆倍数最小为 1。" };
    const direction = $("trade-side").value === "short" ? -1 : 1;
    const pnl = closed ? (finalClosePrice - firstEntryPrice) * firstQuantity * leverage * direction : 0;
    const entryLegs = [{ time: openAt, price: firstEntryPrice, quantity: firstQuantity, final: false }];
    const exitLegs = closed ? [{ time: closeAt, price: finalClosePrice, quantity: firstQuantity, final: true }] : [];
    return {
      status: closed ? "closed" : "open", closed, openAt, closeAt,
      entryPrice: firstEntryPrice, closePrice: closed ? finalClosePrice : null,
      quantity: firstQuantity, remainingQuantity: closed ? 0 : firstQuantity, leverage, pnl, entryLegs, exitLegs
    };
  }

  function calculatedPnlFromForm() {
    const plan = calculateExecutionPlan();
    return plan.error ? NaN : plan.pnl;
  }

  function updateCalculatedPnl() {
    const pnl = calculatedPnlFromForm();
    $("trade-pnl").value = Number.isFinite(pnl) ? pnl.toFixed(2) : "";
    $("trade-pnl").classList.toggle("metric-positive", Number.isFinite(pnl) && pnl > 0);
    $("trade-pnl").classList.toggle("metric-negative", Number.isFinite(pnl) && pnl < 0);
  }

  function readTradeForm() {
    const symbol = $("trade-symbol").value;
    const side = $("trade-side").value;
    const plan = calculateExecutionPlan();
    if (plan.error) return plan;
    const { status, closed, openAt, closeAt, entryPrice, closePrice, pnl, quantity, remainingQuantity, leverage, entryLegs, exitLegs } = plan;
    const stopLoss = Number($("trade-stop").value);
    const takeProfit = Number($("trade-target").value);
    const reasons = selectedReasons();
    if (!reasons.length) return { error: "请至少选择一项开仓依据。" };
    const stop = Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null;
    const target = Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null;
    if (side === "long" && stop !== null && stop >= entryPrice) return { error: "做多止损应低于开仓价。" };
    if (side === "long" && target !== null && target <= entryPrice) return { error: "做多止盈应高于开仓价。" };
    if (side === "short" && stop !== null && stop <= entryPrice) return { error: "做空止损应高于开仓价。" };
    if (side === "short" && target !== null && target >= entryPrice) return { error: "做空止盈应低于开仓价。" };
    const risk = Number.isFinite(stopLoss) && stopLoss > 0 ? Math.abs(entryPrice - stopLoss) * quantity * leverage : NaN;
    return {
      id: $("trade-edit-id").value || id(), symbol, side, status, closed, openAt, closeAt, entryPrice, closePrice, pnl,
      quantity, remainingQuantity, leverage, entryLegs, exitLegs,
      stopLoss: stop,
      takeProfit: target,
      reasons, note: $("trade-note").value.trim(), exitReason: closed ? $("trade-exit-reason").value : "",
      includeInAnalysis: true, rMultiple: closed && Number.isFinite(risk) && risk > 0 ? pnl / risk : null,
      lastPrice: closed ? closePrice : Number(simulationQuoteFor(symbol)?.price) || entryPrice,
      lastPriceAt: closed ? closeAt : Date.now()
    };
  }

  function openTradeModal() {
    const modal = $("trade-modal");
    modal.hidden = false;
    document.body.classList.add("modal-open");
    window.requestAnimationFrame(() => $("trade-symbol").focus());
  }

  function closeTradeModal() {
    $("trade-modal").hidden = true;
    document.body.classList.remove("modal-open");
  }

  function resetTradeForm() {
    $("trade-edit-id").value = "";
    $("trade-symbol").value = "XAUUSDT";
    $("trade-side").value = "long";
    $("trade-status").value = "closed";
    $("trade-entry-price").value = "";
    $("trade-close-price").value = "";
    $("trade-pnl").value = "";
    $("trade-quantity").value = "";
    $("trade-leverage").value = "1";
    $("trade-stop").value = "";
    $("trade-target").value = "";
    $("trade-exit-reason").value = "止盈";
    $("trade-note").value = "";
    document.querySelectorAll('input[name="real-entry-reason"]').forEach((input) => { input.checked = false; });
    const now = Date.now();
    $("trade-close-time").value = toLocalInput(now);
    $("trade-open-time").value = toLocalInput(now - 60 * 60 * 1000);
    $("trade-form-error").textContent = "未平仓记录填写止损/止盈后，将在页面打开且行情连接时自动执行。";
    $("save-trade").textContent = "保存模拟交易";
    $("trade-entry-title").textContent = "录入模拟交易";
    syncTradeStatus();
  }

  async function saveTradeFromForm() {
    const value = readTradeForm();
    $("trade-form-error").textContent = value.error || "";
    if (value.error) return;
    const existing = state.simulationTrades.find((trade) => trade.id === value.id);
    if (existing) value.includeInAnalysis = existing.includeInAnalysis;
    value.updatedAt = Date.now();
    const normalized = normalizeSimulationTrade(value);
    if (!normalized) {
      $("trade-form-error").textContent = "交易数据不完整，请检查价格、数量、杠杆和时间。";
      return;
    }
    state.simulationTrades = [normalized, ...state.simulationTrades.filter((trade) => trade.id !== normalized.id)];
    await saveSimulationState();
    renderAll();
    closeTradeModal();
    resetTradeForm();
    navigate(normalized.closed ? "journal" : "simulation");
    showToast(existing ? "模拟交易记录已更新。" : value.closed ? "已平仓模拟交易已录入并纳入分析。" : "模拟持仓已保存，止盈止损触价后将自动执行。" );
  }

  function reviewFor(trades) {
    const count = trades.length;
    const wins = trades.filter((trade) => trade.pnl > 0).length;
    const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    let running = 0;
    let peak = 0;
    let maxDrawdown = 0;
    [...trades].sort((a, b) => a.closeAt - b.closeAt).forEach((trade) => {
      running += trade.pnl;
      peak = Math.max(peak, running);
      maxDrawdown = Math.min(maxDrawdown, running - peak);
    });
    return {
      count, winRate: count ? wins / count * 100 : NaN, pnl,
      profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : NaN,
      maxDrawdown, averageHold: count ? trades.reduce((sum, trade) => sum + trade.closeAt - trade.openAt, 0) / count : NaN
    };
  }

  function drawWeeklyChart(trades) {
    const svg = $("weekly-equity-chart");
    if (!trades.length) {
      svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#8298aa" font-size="14">本周尚无纳入分析的交易</text>';
      return;
    }
    const ordered = [...trades].sort((a, b) => a.closeAt - b.closeAt);
    let running = 0;
    const values = [0, ...ordered.map((trade) => (running += trade.pnl))];
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);
    const span = Math.max(1, max - min);
    const points = values.map((value, index) => `${40 + index / Math.max(1, values.length - 1) * 820},${190 - (value - min) / span * 150}`).join(" ");
    const zeroY = 190 - (0 - min) / span * 150;
    const color = values.at(-1) >= 0 ? "#28d69d" : "#ff6572";
    svg.innerHTML = `<line x1="40" y1="${zeroY}" x2="860" y2="${zeroY}" stroke="rgba(153,184,207,.25)" stroke-dasharray="5 5"/><polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  function countBy(trades, getter) {
    const counts = new Map();
    trades.forEach((trade) => getter(trade).forEach((key) => counts.set(key, (counts.get(key) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderWeekly() {
    const weekTrades = analysisTrades().filter((trade) => trade.closeAt >= state.selectedWeekStart && trade.closeAt < endOfWeek(state.selectedWeekStart));
    const review = reviewFor(weekTrades);
    $("week-label").textContent = formatWeek(state.selectedWeekStart);
    $("review-count").textContent = String(review.count);
    $("review-win-rate").textContent = formatPercent(review.winRate);
    $("review-pnl").textContent = formatMoney(review.pnl, true);
    $("review-pnl").className = review.pnl > 0 ? "metric-positive" : review.pnl < 0 ? "metric-negative" : "";
    $("review-profit-factor").textContent = review.profitFactor === Infinity ? "∞" : Number.isFinite(review.profitFactor) ? review.profitFactor.toFixed(2) : "—";
    $("review-drawdown").textContent = formatMoney(review.maxDrawdown);
    $("review-hold").textContent = formatDuration(review.averageHold);
    $("review-confidence").textContent = confidenceLabel(review.count);
    drawWeeklyChart(weekTrades);
    const commonReason = countBy(weekTrades, (trade) => trade.reasons)[0];
    const longTrades = weekTrades.filter((trade) => trade.side === "long");
    const shortTrades = weekTrades.filter((trade) => trade.side === "short");
    const insights = review.count ? [
      { type: review.pnl >= 0 ? "next" : "problem", title: "本周结果", text: `${review.count}笔，胜率${formatPercent(review.winRate)}，净盈亏${formatMoney(review.pnl, true)}。` },
      { type: "", title: "最常用依据", text: commonReason ? `${commonReason[0]}出现${commonReason[1]}次；仍需结合盈亏证据观察。` : "尚未形成重复依据。" },
      { type: "next", title: "方向分布", text: `做多${longTrades.length}笔，做空${shortTrades.length}笔；用于检查是否长期偏向单一方向。` }
    ] : [{ type: "", title: "等待模拟交易", text: "本周完成并纳入分析的模拟交易出现后，这里自动生成总结。" }];
    $("weekly-insights").innerHTML = insights.map((item) => `<div class="insight-item ${item.type}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.text)}</p></div>`).join("");
    $("weekly-trades-body").innerHTML = weekTrades.length ? [...weekTrades].sort((a,b) => b.closeAt - a.closeAt).map((trade) => `<tr><td>${escapeHtml(formatDate(trade.closeAt))}</td><td>${escapeHtml(trade.id.slice(0,8))}</td><td>${escapeHtml(trade.symbol)}</td><td>${SIDE_LABELS[trade.side]}</td><td>${escapeHtml(trade.reasons.join(" / ") || "模拟开仓")}</td><td>${escapeHtml(trade.exitReason)}</td><td class="${trade.pnl >= 0 ? "metric-positive" : "metric-negative"}">${escapeHtml(formatMoney(trade.pnl, true))}</td></tr>`).join("") : '<tr class="empty-row"><td colspan="7">本周暂无模拟交易证据。</td></tr>';
  }

  function renderHabits() {
    const trades = analysisTrades();
    const confidence = confidenceLabel(trades.length);
    $("habit-confidence").textContent = `${confidence} · ${trades.length}笔`;
    if (!trades.length) {
      $("habit-list").innerHTML = '<div class="empty-row">完成模拟交易后开始形成画像。</div>';
      return;
    }
    const longCount = trades.filter((trade) => trade.side === "long").length;
    const preferredSide = longCount === trades.length - longCount ? "多空数量相同" : longCount > trades.length - longCount ? `偏多（${longCount}/${trades.length}）` : `偏空（${trades.length - longCount}/${trades.length}）`;
    const reasonStats = REASON_ORDER.map((reason) => {
      const matching = trades.filter((trade) => trade.reasons.includes(reason));
      return { reason, count: matching.length, pnl: matching.reduce((sum, trade) => sum + trade.pnl, 0) };
    }).filter((item) => item.count).sort((a,b) => b.count - a.count);
    const common = reasonStats[0];
    const best = reasonStats.filter((item) => item.count >= 2).sort((a,b) => b.pnl - a.pnl)[0];
    const stopDistances = trades.filter((trade) => Number.isFinite(trade.stopLoss)).map((trade) => Math.abs(trade.entryPrice - trade.stopLoss));
    const targetDistances = trades.filter((trade) => Number.isFinite(trade.takeProfit)).map((trade) => Math.abs(trade.takeProfit - trade.entryPrice));
    const exits = countBy(trades, (trade) => [trade.exitReason]);
    const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
    const rows = [
      ["偏好方向", preferredSide, confidence],
      ["常用开仓依据", common ? `${common.reason}（${common.count}/${trades.length}）` : "暂无", confidence],
      ["当前较好证据", best ? `${best.reason}：${best.count}笔，净${formatMoney(best.pnl, true)}` : "同类样本不足2笔", confidence],
      ["平均计划止损距离", Number.isFinite(average(stopDistances)) ? `${formatPrice(average(stopDistances))} USDT` : "未录入足够止损", confidence],
      ["平均计划止盈距离", Number.isFinite(average(targetDistances)) ? `${formatPrice(average(targetDistances))} USDT` : "未录入足够止盈", confidence],
      ["平均持仓时长", formatDuration(average(trades.map((trade) => trade.closeAt - trade.openAt))), confidence],
      ["常见退出方式", exits[0] ? `${exits[0][0]}（${exits[0][1]}/${trades.length}）` : "暂无", confidence]
    ];
    $("habit-list").innerHTML = rows.map(([label, value, level]) => `<div class="habit-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><em>${escapeHtml(level)}</em></div>`).join("");
  }

  function renderAll() {
    renderSimulation();
    renderWeekly();
    renderHabits();
  }

  function navigate(view) {
    state.currentView = view;
    document.body.classList.toggle("monitor-active", view === "monitor");
    document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelectorAll("[data-app-view]").forEach((section) => section.classList.toggle("active", section.dataset.appView === view));
    if (view === "simulation") {
      renderSimulation();
      refreshOpenSimulationQuotes(false);
    }
    if (view === "journal") renderSimulation();
    if (view === "weekly") renderWeekly();
    if (view === "habits") renderHabits();
  }

  function editTrade(tradeId) {
    const trade = state.simulationTrades.find((item) => item.id === tradeId);
    if (!trade) return;
    navigate(trade.closed ? "journal" : "simulation");
    $("trade-edit-id").value = trade.id;
    $("trade-symbol").value = [...$("trade-symbol").options].some((option) => option.value === trade.symbol) ? trade.symbol : "其他";
    $("trade-side").value = trade.side;
    $("trade-status").value = trade.closed ? "closed" : "open";
    $("trade-open-time").value = toLocalInput(trade.openAt);
    $("trade-close-time").value = trade.closed ? toLocalInput(trade.closeAt) : "";
    $("trade-entry-price").value = String(trade.entryPrice);
    $("trade-close-price").value = trade.closed ? String(trade.closePrice) : "";
    $("trade-pnl").value = String(trade.pnl);
    $("trade-quantity").value = Number.isFinite(trade.quantity) ? String(trade.quantity) : "";
    $("trade-leverage").value = String(Number.isFinite(trade.leverage) ? trade.leverage : 1);
    $("trade-stop").value = Number.isFinite(trade.stopLoss) ? String(trade.stopLoss) : "";
    $("trade-target").value = Number.isFinite(trade.takeProfit) ? String(trade.takeProfit) : "";
    $("trade-exit-reason").value = [...$("trade-exit-reason").options].some((option) => option.value === trade.exitReason) ? trade.exitReason : "其他";
    $("trade-note").value = trade.note;
    document.querySelectorAll('input[name="real-entry-reason"]').forEach((input) => { input.checked = trade.reasons.includes(input.value); });
    syncTradeStatus();
    updateCalculatedPnl();
    $("save-trade").textContent = "保存修改";
    $("trade-entry-title").textContent = "编辑模拟交易";
    openTradeModal();
  }

  function bindEvents() {
    document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    $("save-trade").addEventListener("click", saveTradeFromForm);
    [$("open-trade-modal-simulation"), $("open-trade-modal-journal")].forEach((button) => button.addEventListener("click", () => {
      resetTradeForm();
      $("trade-status").value = button.dataset.tradeStatus;
      syncTradeStatus();
      openTradeModal();
    }));
    $("close-trade-modal").addEventListener("click", closeTradeModal);
    $("cancel-trade-modal").addEventListener("click", closeTradeModal);
    $("trade-modal").addEventListener("click", (event) => { if (event.target.closest("[data-close-trade-modal]")) closeTradeModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("trade-modal").hidden) closeTradeModal(); });
    $("trade-status").addEventListener("change", () => {
      syncTradeStatus();
      updateCalculatedPnl();
      $("trade-form-error").textContent = $("trade-status").value === "open"
        ? "模拟持仓填写止损/止盈后，将在页面打开且行情连接时自动执行。"
        : "自动盈亏暂不包含手续费、滑点和资金费率。";
    });
    ["trade-side", "trade-open-time", "trade-close-time", "trade-entry-price", "trade-close-price", "trade-quantity", "trade-leverage"].forEach((idName) => $(idName).addEventListener("input", updateCalculatedPnl));
    $("trade-side").addEventListener("change", updateCalculatedPnl);
    $("simulation-form").addEventListener("submit", openSimulationTrade);
    $("save-simulation-capital").addEventListener("click", saveSimulationCapital);
    $("refresh-simulation-price").addEventListener("click", () => refreshSimulationQuote($("simulation-symbol").value, true, true));
    $("simulation-symbol").addEventListener("change", () => refreshSimulationQuote($("simulation-symbol").value, true, true));
    [$("simulation-long"), $("simulation-short")].forEach((button) => button.addEventListener("click", () => {
      state.simulationSide = button.dataset.side;
      $("simulation-long").classList.toggle("active", state.simulationSide === "long");
      $("simulation-short").classList.toggle("active", state.simulationSide === "short");
    }));
    const handleRecordAction = (event) => {
      const closeButton = event.target.closest("[data-close-simulation]");
      const deleteSimulationButton = event.target.closest("[data-delete-simulation]");
      const editButton = event.target.closest("[data-edit-trade]");
      if (closeButton) closeSimulationTrade(closeButton.dataset.closeSimulation);
      if (editButton) editTrade(editButton.dataset.editTrade);
      if (deleteSimulationButton) deleteSimulationTrade(deleteSimulationButton.dataset.deleteSimulation);
    };
    [$("simulation-open-body"), $("simulation-closed-body")].forEach((body) => body.addEventListener("click", handleRecordAction));
    $("week-prev").addEventListener("click", () => { state.selectedWeekStart -= 7 * 24 * 60 * 60 * 1000; renderWeekly(); });
    $("week-next").addEventListener("click", () => { if (state.selectedWeekStart < startOfWeek(Date.now())) state.selectedWeekStart += 7 * 24 * 60 * 60 * 1000; renderWeekly(); });
    window.addEventListener("market-price", (event) => {
      const detail = event.detail || {};
      if (!detail.symbol || !Number.isFinite(Number(detail.price))) return;
      const previous = simulationQuoteFor(detail.symbol) || {};
      recordQuote({ ...previous, symbol: detail.symbol, price: Number(detail.price), timestamp: Number(detail.timestamp) || Date.now() });
      checkSimulationTriggers(detail.symbol, Number(detail.price), Number(detail.timestamp) || Date.now()).then(() => renderSimulation());
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      refreshOpenSimulationQuotes(false);
      scheduleCloudSync(100);
    });
    window.addEventListener("online", () => scheduleCloudSync(100));
    window.addEventListener("offline", () => setCloudSyncStatus("offline", "离线缓存中"));
  }

  async function start() {
    bindEvents();
    const [storedTrades, storedSimulation] = await Promise.all([readTrades(), readSimulationState()]);
    state.simulationCapital = storedSimulation.capital;
    state.simulationCapitalUpdatedAt = storedSimulation.capitalUpdatedAt;
    state.simulationDeletedTrades = storedSimulation.deletedTrades;
    const migrated = storedTrades.map(normalizeTrade).filter(Boolean);
    const combined = [...storedSimulation.trades.map(normalizeSimulationTrade).filter(Boolean), ...migrated];
    state.simulationTrades = [...new Map(combined.map((trade) => [trade.id, trade])).values()];
    if (migrated.length) {
      state.trades = [];
      await Promise.all([saveSimulationState(), saveTrades()]);
    }
    const snapshot = window.marketMonitor?.getSnapshot?.();
    if (snapshot?.price) recordQuote(snapshot);
    resetTradeForm();
    renderAll();
    state.cloudSyncReady = true;
    await syncCloudState();
    await refreshSimulationQuote($("simulation-symbol").value, false, true);
    state.simulationTimer = window.setInterval(() => refreshOpenSimulationQuotes(false), SIMULATION_REFRESH_INTERVAL);
    state.cloudSyncInterval = window.setInterval(syncCloudState, CLOUD_SYNC_INTERVAL);
  }

  window.paperTrading = {
    getPositionsForSymbol(symbol) { return JSON.parse(JSON.stringify(state.simulationTrades.filter((trade) => !trade.closed && (!symbol || trade.symbol === symbol)))); },
    getJournalSnapshot() { return JSON.parse(JSON.stringify(state.simulationTrades)); },
    getSimulationSnapshot() { return JSON.parse(JSON.stringify({ capital: state.simulationCapital, trades: state.simulationTrades })); }
  };

  start().catch((error) => showToast(`交易日志初始化失败：${error.message || "未知错误"}`, true));
})();
