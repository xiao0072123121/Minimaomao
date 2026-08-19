(() => {
  "use strict";

  const DB_NAME = "paper-trading-journal";
  const DB_VERSION = 1;
  const STORE_NAME = "records";
  const STATE_KEY = "paper-account";
  const DEFAULT_BALANCE = 100000;
  const PRICE_REFRESH_INTERVAL = 15_000;
  const PAGE_LOCATION = window.location;
  const USE_PROXY = PAGE_LOCATION.protocol === "https:" && !["localhost", "127.0.0.1"].includes(PAGE_LOCATION.hostname);
  const API_ROOT = USE_PROXY ? `${PAGE_LOCATION.origin}/api/binance` : "https://fapi.binance.com";
  const SYMBOLS = ["XAUUSDT", "SNDKUSDT", "SKHYNIXUSDT"];
  const SIDE_LABELS = { long: "做多", short: "做空" };
  const REASON_ORDER = ["支撑/压力", "K线反转", "RSI超买超卖", "区间高抛低吸", "突破/回踩", "其他"];

  const state = {
    account: { initialBalance: DEFAULT_BALANCE, realizedPnl: 0, positions: [], trades: [] },
    prices: {},
    activeSymbol: "XAUUSDT",
    side: "long",
    selectedWeekStart: startOfWeek(Date.now()),
    priceTimer: null,
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const moneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatMoney(value, signed = false) {
    if (!Number.isFinite(value)) return "—";
    const sign = signed && value > 0 ? "+" : "";
    return `${sign}${moneyFormatter.format(value)} USDT`;
  }

  function formatPrice(value) {
    return Number.isFinite(value) ? priceFormatter.format(value) : "—";
  }

  function formatPercent(value, signed = false) {
    if (!Number.isFinite(value)) return "—";
    return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  }

  function formatDate(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    return dateFormatter.format(new Date(timestamp)).replace("24:", "00:");
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    const totalSeconds = Math.floor(milliseconds / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(totalSeconds % 86400 / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const seconds = totalSeconds % 60;
    return `${days ? `${days}天 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function id() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    const end = new Date(endOfWeek(weekStart) - 1);
    const start = new Date(weekStart);
    const part = (date) => `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
    return `${part(start)} – ${part(end)}`;
  }

  function confidenceLabel(count) {
    if (count < 10) return "样本不足";
    if (count < 30) return "初步倾向";
    return "较稳定";
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

  async function readAccount() {
    const database = await openDatabase();
    if (!database) return null;
    return new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => database.close();
    });
  }

  async function saveAccount() {
    const database = await openDatabase();
    if (!database) return;
    const snapshot = JSON.parse(JSON.stringify(state.account));
    await new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key: STATE_KEY, value: snapshot, savedAt: Date.now() });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); resolve(); };
    });
  }

  function normalizeAccount(value) {
    const initialBalance = Number(value?.initialBalance);
    const positions = (Array.isArray(value?.positions) ? value.positions : []).filter((position) =>
      SYMBOLS.includes(position?.symbol) && ["long", "short"].includes(position?.side) &&
      [position.notional, position.quantity, position.entryPrice, position.stopLoss, position.takeProfit, position.openAt].every((item) => Number.isFinite(Number(item)))
    ).map((position) => ({
      ...position,
      notional: Number(position.notional), quantity: Number(position.quantity), entryPrice: Number(position.entryPrice),
      stopLoss: Number(position.stopLoss), takeProfit: Number(position.takeProfit), openAt: Number(position.openAt),
      initialRisk: Number(position.initialRisk) || Math.abs(Number(position.entryPrice) - Number(position.stopLoss)) * Number(position.quantity),
      reasons: Array.isArray(position.reasons) ? position.reasons.map(String) : [], note: String(position.note || "")
    }));
    const trades = (Array.isArray(value?.trades) ? value.trades : []).filter((trade) =>
      SYMBOLS.includes(trade?.symbol) && ["long", "short"].includes(trade?.side) &&
      [trade.entryPrice, trade.closePrice, trade.openAt, trade.closeAt, trade.pnl].every((item) => Number.isFinite(Number(item)))
    ).map((trade) => ({
      ...trade,
      notional: Number(trade.notional) || 0, quantity: Number(trade.quantity) || 0, entryPrice: Number(trade.entryPrice), closePrice: Number(trade.closePrice),
      stopLoss: Number(trade.stopLoss), takeProfit: Number(trade.takeProfit), openAt: Number(trade.openAt), closeAt: Number(trade.closeAt),
      pnl: Number(trade.pnl), holdMs: Number(trade.holdMs) || Math.max(0, Number(trade.closeAt) - Number(trade.openAt)),
      rMultiple: Number(trade.rMultiple), reasons: Array.isArray(trade.reasons) ? trade.reasons.map(String) : [],
      note: String(trade.note || ""), exitReason: String(trade.exitReason || "未知"), includeInAnalysis: trade.includeInAnalysis !== false
    }));
    return {
      initialBalance: Number.isFinite(initialBalance) && initialBalance > 0 ? initialBalance : DEFAULT_BALANCE,
      realizedPnl: trades.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0),
      positions: positions.filter((position) => SYMBOLS.includes(position.symbol)),
      trades
    };
  }

  function currentPrice(symbol) {
    return Number(state.prices[symbol]);
  }

  function positionPnl(position, price = currentPrice(position.symbol)) {
    if (!Number.isFinite(price)) return 0;
    const direction = position.side === "long" ? 1 : -1;
    return (price - position.entryPrice) * position.quantity * direction;
  }

  function accountMetrics() {
    const openNotional = state.account.positions.reduce((sum, position) => sum + position.notional, 0);
    const unrealized = state.account.positions.reduce((sum, position) => sum + positionPnl(position), 0);
    const balance = state.account.initialBalance + state.account.realizedPnl;
    const equity = balance + unrealized;
    const available = Math.max(0, balance - openNotional);
    let peak = state.account.initialBalance;
    let running = state.account.initialBalance;
    let maxDrawdown = 0;
    for (const trade of [...state.account.trades].sort((a, b) => a.closeAt - b.closeAt)) {
      running += trade.pnl;
      peak = Math.max(peak, running);
      if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (running - peak) / peak * 100);
    }
    return { openNotional, unrealized, balance, equity, available, maxDrawdown };
  }

  function setMetric(idName, value, signed = false, percent = false) {
    const element = $(idName);
    element.textContent = percent ? formatPercent(value, signed) : formatMoney(value, signed);
    element.classList.toggle("metric-positive", Number.isFinite(value) && value > 0);
    element.classList.toggle("metric-negative", Number.isFinite(value) && value < 0);
  }

  function renderAccount() {
    const metrics = accountMetrics();
    setMetric("account-equity", metrics.equity);
    setMetric("account-available", metrics.available);
    setMetric("account-unrealized", metrics.unrealized, true);
    setMetric("account-realized", state.account.realizedPnl, true);
    setMetric("account-drawdown", metrics.maxDrawdown, false, true);
  }

  function renderOrderPreview() {
    const price = currentPrice(state.activeSymbol);
    const notional = Number($("order-notional").value);
    const stop = Number($("order-stop").value);
    const target = Number($("order-target").value);
    $("order-entry-preview").textContent = formatPrice(price);
    $("order-quantity-preview").textContent = Number.isFinite(price) && price > 0 && Number.isFinite(notional) ? (notional / price).toFixed(4) : "—";
    const risk = state.side === "long" ? price - stop : stop - price;
    const reward = state.side === "long" ? target - price : price - target;
    $("order-rr-preview").textContent = Number.isFinite(risk) && risk > 0 && Number.isFinite(reward) && reward > 0 ? `1 : ${(reward / risk).toFixed(2)}` : "—";
  }

  function showToast(message, isError = false) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }

  function validateOrder() {
    const price = currentPrice(state.activeSymbol);
    const notional = Number($("order-notional").value);
    const stopLoss = Number($("order-stop").value);
    const takeProfit = Number($("order-target").value);
    const reasons = [...document.querySelectorAll('input[name="entry-reason"]:checked')].map((input) => input.value);
    if (!Number.isFinite(price) || price <= 0) return { error: "尚未获得当前标的真实价格。" };
    if (!Number.isFinite(notional) || notional <= 0) return { error: "请输入有效的名义金额。" };
    if (notional > accountMetrics().available) return { error: "名义金额超过当前可用资金。" };
    if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) return { error: "止损价和止盈价均为必填项。" };
    if (state.side === "long" && !(stopLoss < price && takeProfit > price)) return { error: "做多时必须满足：止损价 < 当前价 < 止盈价。" };
    if (state.side === "short" && !(takeProfit < price && stopLoss > price)) return { error: "做空时必须满足：止盈价 < 当前价 < 止损价。" };
    if (!reasons.length) return { error: "请至少选择一项开仓理由。" };
    return { price, notional, stopLoss, takeProfit, reasons };
  }

  async function openPosition() {
    const validation = validateOrder();
    $("order-error").textContent = validation.error || "";
    if (validation.error) return;
    const position = {
      id: id(),
      symbol: state.activeSymbol,
      side: state.side,
      notional: validation.notional,
      quantity: validation.notional / validation.price,
      entryPrice: validation.price,
      stopLoss: validation.stopLoss,
      takeProfit: validation.takeProfit,
      openAt: Date.now(),
      reasons: validation.reasons,
      note: $("order-note").value.trim(),
      initialRisk: Math.abs(validation.price - validation.stopLoss) * (validation.notional / validation.price)
    };
    state.account.positions.push(position);
    await saveAccount();
    renderAll();
    window.dispatchEvent(new Event("paper-positions-changed"));
    $("order-note").value = "";
    document.querySelectorAll('input[name="entry-reason"]').forEach((input) => { input.checked = false; });
    showToast(`${position.symbol} ${SIDE_LABELS[position.side]}模拟仓位已建立。`);
  }

  async function closePosition(positionId, exitReason, executionPrice) {
    const index = state.account.positions.findIndex((position) => position.id === positionId);
    if (index < 0 || !Number.isFinite(executionPrice)) return;
    const [position] = state.account.positions.splice(index, 1);
    const direction = position.side === "long" ? 1 : -1;
    const pnl = (executionPrice - position.entryPrice) * position.quantity * direction;
    const trade = {
      ...position,
      closePrice: executionPrice,
      closeAt: Date.now(),
      exitReason,
      pnl,
      returnPct: position.notional ? pnl / position.notional * 100 : 0,
      rMultiple: position.initialRisk ? pnl / position.initialRisk : 0,
      holdMs: Date.now() - position.openAt,
      includeInAnalysis: true
    };
    state.account.trades.push(trade);
    state.account.realizedPnl = state.account.trades.reduce((sum, item) => sum + item.pnl, 0);
    await saveAccount();
    renderAll();
    window.dispatchEvent(new Event("paper-positions-changed"));
    showToast(`${position.symbol} 已${exitReason}，本笔 ${formatMoney(pnl, true)}。`, pnl < 0);
  }

  async function evaluateStops(symbol, price) {
    const triggered = state.account.positions.filter((position) => {
      if (position.symbol !== symbol) return false;
      if (position.side === "long") return price <= position.stopLoss || price >= position.takeProfit;
      return price >= position.stopLoss || price <= position.takeProfit;
    });
    for (const position of triggered) {
      const stopped = position.side === "long" ? price <= position.stopLoss : price >= position.stopLoss;
      await closePosition(position.id, stopped ? "止损触发" : "止盈触发", price);
    }
  }

  function positionRow(position) {
    const price = currentPrice(position.symbol);
    const pnl = positionPnl(position, price);
    const pnlClass = pnl > 0 ? "direction-long" : pnl < 0 ? "direction-short" : "";
    return `<tr>
      <td>${escapeHtml(position.symbol)}</td>
      <td class="direction-${escapeHtml(position.side)}">${SIDE_LABELS[position.side]}</td>
      <td>${escapeHtml(formatDate(position.openAt))}</td>
      <td>${escapeHtml(formatPrice(position.entryPrice))}</td>
      <td>${escapeHtml(formatPrice(price))}</td>
      <td>${escapeHtml(formatPrice(position.stopLoss))}</td>
      <td>${escapeHtml(formatPrice(position.takeProfit))}</td>
      <td class="${pnlClass}">${escapeHtml(formatMoney(pnl, true))}</td>
      <td>${escapeHtml(formatDuration(Date.now() - position.openAt))}</td>
      <td><div class="row-actions"><button class="row-button close" data-close-position="${escapeHtml(position.id)}" type="button">市价平仓</button><button class="row-button" data-edit-position="${escapeHtml(position.id)}" type="button">修改</button></div></td>
    </tr>`;
  }

  function renderPositions() {
    $("position-count").textContent = `(${state.account.positions.length})`;
    $("positions-body").innerHTML = state.account.positions.length
      ? state.account.positions.map(positionRow).join("")
      : '<tr class="empty-row"><td colspan="10">暂无模拟持仓</td></tr>';
  }

  async function modifyPosition(positionId) {
    const position = state.account.positions.find((item) => item.id === positionId);
    if (!position) return;
    const nextStop = Number(window.prompt("新的止损价", String(position.stopLoss)));
    if (!Number.isFinite(nextStop)) return;
    const nextTarget = Number(window.prompt("新的止盈价", String(position.takeProfit)));
    if (!Number.isFinite(nextTarget)) return;
    const price = currentPrice(position.symbol) || position.entryPrice;
    const valid = position.side === "long" ? nextStop < price && nextTarget > price : nextTarget < price && nextStop > price;
    if (!valid) return showToast("新的止盈止损与当前价格、方向不匹配。", true);
    position.stopLoss = nextStop;
    position.takeProfit = nextTarget;
    await saveAccount();
    renderPositions();
    window.dispatchEvent(new Event("paper-positions-changed"));
  }

  function filteredTrades() {
    const symbol = $("journal-symbol-filter").value;
    const side = $("journal-side-filter").value;
    const result = $("journal-result-filter").value;
    return [...state.account.trades]
      .filter((trade) => symbol === "all" || trade.symbol === symbol)
      .filter((trade) => side === "all" || trade.side === side)
      .filter((trade) => result === "all" || (result === "win" ? trade.pnl > 0 : trade.pnl < 0))
      .sort((a, b) => b.closeAt - a.closeAt);
  }

  function journalRow(trade) {
    return `<tr>
      <td>${escapeHtml(formatDate(trade.closeAt))}</td><td>${escapeHtml(trade.id.slice(0, 8))}</td><td>${escapeHtml(trade.symbol)}</td>
      <td class="direction-${escapeHtml(trade.side)}">${SIDE_LABELS[trade.side]}</td><td>${escapeHtml(trade.reasons.join("、"))}</td>
      <td>${escapeHtml(formatPrice(trade.entryPrice))} / ${escapeHtml(formatPrice(trade.closePrice))}</td><td>${escapeHtml(trade.exitReason)}</td>
      <td>${escapeHtml(formatDuration(trade.holdMs))}</td><td class="${trade.pnl >= 0 ? "direction-long" : "direction-short"}">${escapeHtml(formatMoney(trade.pnl, true))}</td>
      <td>${Number.isFinite(trade.rMultiple) ? `${trade.rMultiple.toFixed(2)}R` : "—"}</td>
      <td><label class="reason-option"><input type="checkbox" data-analysis-toggle="${escapeHtml(trade.id)}" ${trade.includeInAnalysis !== false ? "checked" : ""}>纳入</label></td>
    </tr>`;
  }

  function renderJournal() {
    const trades = filteredTrades();
    $("journal-body").innerHTML = trades.length ? trades.map(journalRow).join("") : '<tr class="empty-row"><td colspan="11">当前筛选条件下没有已完成交易。</td></tr>';
  }

  function weekTrades(weekStart = state.selectedWeekStart) {
    const weekEnd = endOfWeek(weekStart);
    return state.account.trades.filter((trade) => trade.includeInAnalysis !== false && trade.closeAt >= weekStart && trade.closeAt < weekEnd).sort((a, b) => a.closeAt - b.closeAt);
  }

  function calculateReview(trades) {
    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl < 0);
    const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
    let running = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const curve = [{ value: 0, time: state.selectedWeekStart }];
    for (const trade of trades) {
      running += trade.pnl;
      peak = Math.max(peak, running);
      maxDrawdown = Math.min(maxDrawdown, running - peak);
      curve.push({ value: running, time: trade.closeAt });
    }
    return {
      count: trades.length,
      winRate: trades.length ? wins.length / trades.length * 100 : NaN,
      pnl,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : NaN,
      maxDrawdown,
      averageHold: trades.length ? trades.reduce((sum, trade) => sum + trade.holdMs, 0) / trades.length : NaN,
      curve
    };
  }

  function mostCommonReason(trades) {
    const counts = new Map();
    for (const trade of trades) for (const reason of trade.reasons) counts.set(reason, (counts.get(reason) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  }

  function buildInsights(trades, review) {
    if (!trades.length) return [
      { type: "feature", title: "本周行为特征", text: "本周尚无已完成且纳入分析的交易。" },
      { type: "problem", title: "重复犯错", text: "没有足够证据判断重复模式。" },
      { type: "next", title: "下周只验证一件事", text: "先完整记录每笔开仓理由、止损、止盈与退出原因。" }
    ];
    const common = mostCommonReason(trades);
    const longs = trades.filter((trade) => trade.side === "long");
    const shorts = trades.length - longs.length;
    const manual = trades.filter((trade) => trade.exitReason === "手动平仓");
    const lowPlanRr = trades.filter((trade) => {
      const risk = Math.abs(trade.entryPrice - trade.stopLoss);
      const reward = Math.abs(trade.takeProfit - trade.entryPrice);
      return risk > 0 && reward / risk < 1.5;
    });
    const fastLosses = trades.filter((trade) => trade.pnl < 0 && trade.holdMs < 30 * 60 * 1000);
    const problemText = lowPlanRr.length >= 2
      ? `${lowPlanRr.length}/${trades.length}笔计划盈亏比低于1:1.5；这是重复出现的计划特征，并不直接说明交易错误。`
      : fastLosses.length >= 2
        ? `${fastLosses.length}笔亏损交易在30分钟内结束，需复核是止损过近还是提前入场。`
        : manual.length >= 2
          ? `${manual.length}笔由手动平仓结束，建议对照原计划检查退出是否一致。`
          : "暂未出现至少两次的同类问题，继续积累证据。";
    const nextText = lowPlanRr.length >= 2
      ? "下一周只比较：计划盈亏比达到1:1.5与不足1:1.5的交易结果。"
      : fastLosses.length >= 2
        ? "下一周只记录：30分钟内亏损的交易是否已经出现完整K线确认。"
        : "下一周只验证：开仓理由最多的一类信号能否保持完整记录。";
    return [
      { type: "feature", title: "本周行为特征", text: `${common ? `${common[1]}/${trades.length}笔包含“${common[0]}”` : "开仓理由较分散"}；方向分布为做多${longs.length}笔、做空${shorts}笔。` },
      { type: "problem", title: "重复犯错", text: problemText },
      { type: "next", title: "下周只验证一件事", text: nextText }
    ];
  }

  function renderWeeklyChart(curve) {
    const svg = $("weekly-equity-chart");
    const width = 900;
    const height = 220;
    const plot = { left: 45, right: 20, top: 18, bottom: 28 };
    const values = curve.map((point) => point.value);
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (max === min) { max += 1; min -= 1; }
    const pad = (max - min) * .12;
    min -= pad; max += pad;
    const x = (index) => plot.left + (width - plot.left - plot.right) * (curve.length === 1 ? 0 : index / (curve.length - 1));
    const y = (value) => plot.top + (max - value) / (max - min) * (height - plot.top - plot.bottom);
    const path = curve.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`).join(" ");
    svg.innerHTML = `<line x1="${plot.left}" x2="${width - plot.right}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(153,184,207,.18)" stroke-width="1"/>
      <path d="${path}" fill="none" stroke="#28d69d" stroke-width="2"/>
      <text x="${plot.left}" y="${height - 8}" fill="#8298aa" font-size="10">周初</text>
      <text x="${width - plot.right}" y="${height - 8}" fill="#8298aa" font-size="10" text-anchor="end">周末</text>
      <text x="${plot.left}" y="12" fill="#8298aa" font-size="10">${escapeHtml(formatMoney(max))}</text>
      <text x="${plot.left}" y="${height - plot.bottom + 16}" fill="#8298aa" font-size="10">${escapeHtml(formatMoney(min))}</text>`;
  }

  function renderWeekly() {
    $("week-label").textContent = formatWeek(state.selectedWeekStart);
    $("week-next").disabled = state.selectedWeekStart >= startOfWeek(Date.now());
    const trades = weekTrades();
    const review = calculateReview(trades);
    $("review-count").textContent = String(review.count);
    $("review-win-rate").textContent = formatPercent(review.winRate);
    $("review-pnl").textContent = formatMoney(review.pnl, true);
    $("review-pnl").className = review.pnl > 0 ? "metric-positive" : review.pnl < 0 ? "metric-negative" : "";
    $("review-profit-factor").textContent = review.profitFactor === Infinity ? "∞" : Number.isFinite(review.profitFactor) ? review.profitFactor.toFixed(2) : "—";
    $("review-drawdown").textContent = formatMoney(review.maxDrawdown);
    $("review-hold").textContent = formatDuration(review.averageHold);
    $("review-confidence").textContent = confidenceLabel(review.count);
    renderWeeklyChart(review.curve);
    $("weekly-insights").innerHTML = buildInsights(trades, review).map((insight) => `<div class="insight-item ${insight.type === "problem" ? "problem" : insight.type === "next" ? "next" : ""}"><b>${escapeHtml(insight.title)}</b><p>${escapeHtml(insight.text)}</p></div>`).join("");
    $("weekly-trades-body").innerHTML = trades.length ? trades.map((trade) => `<tr><td>${escapeHtml(formatDate(trade.closeAt))}</td><td>${escapeHtml(trade.id.slice(0,8))}</td><td>${escapeHtml(trade.symbol)}</td><td class="direction-${trade.side}">${SIDE_LABELS[trade.side]}</td><td>${escapeHtml(trade.reasons.join("、"))}</td><td>${escapeHtml(trade.exitReason)}</td><td class="${trade.pnl >= 0 ? "direction-long" : "direction-short"}">${escapeHtml(formatMoney(trade.pnl, true))}</td></tr>`).join("") : '<tr class="empty-row"><td colspan="7">本周暂无证据交易。</td></tr>';
  }

  function reasonPerformance(trades, reason) {
    const subset = trades.filter((trade) => trade.reasons.includes(reason));
    return { count: subset.length, pnl: subset.reduce((sum, trade) => sum + trade.pnl, 0), wins: subset.filter((trade) => trade.pnl > 0).length };
  }

  function renderHabits() {
    const trades = state.account.trades.filter((trade) => trade.includeInAnalysis !== false);
    const confidence = confidenceLabel(trades.length);
    $("habit-confidence").textContent = `${confidence} · ${trades.length}笔`;
    if (!trades.length) {
      $("habit-list").innerHTML = '<div class="empty-row">完成并纳入至少一笔交易后开始形成画像。</div>';
      return;
    }
    const longs = trades.filter((trade) => trade.side === "long");
    const shorts = trades.filter((trade) => trade.side === "short");
    const preferredSide = longs.length === shorts.length ? "多空均衡" : longs.length > shorts.length ? `偏多（${longs.length}/${trades.length}）` : `偏空（${shorts.length}/${trades.length}）`;
    const reasonStats = REASON_ORDER.map((reason) => ({ reason, ...reasonPerformance(trades, reason) })).sort((a, b) => b.count - a.count);
    const common = reasonStats[0];
    const best = [...reasonStats].filter((item) => item.count >= 2).sort((a, b) => b.pnl - a.pnl)[0];
    const averageStop = trades.reduce((sum, trade) => sum + Math.abs(trade.entryPrice - trade.stopLoss), 0) / trades.length;
    const averageTarget = trades.reduce((sum, trade) => sum + Math.abs(trade.takeProfit - trade.entryPrice), 0) / trades.length;
    const averageHold = trades.reduce((sum, trade) => sum + trade.holdMs, 0) / trades.length;
    const exitCounts = new Map();
    for (const trade of trades) exitCounts.set(trade.exitReason, (exitCounts.get(trade.exitReason) || 0) + 1);
    const commonExit = [...exitCounts.entries()].sort((a,b) => b[1] - a[1])[0];
    const rows = [
      ["偏好方向", preferredSide, confidence],
      ["常用开仓理由", `${common.reason}（${common.count}/${trades.length}）`, confidence],
      ["当前较好证据", best ? `${best.reason}：${best.count}笔，净${formatMoney(best.pnl, true)}` : "同类样本不足2笔", confidence],
      ["平均止损距离", `${formatPrice(averageStop)} USDT`, confidence],
      ["平均止盈距离", `${formatPrice(averageTarget)} USDT`, confidence],
      ["平均持仓时长", formatDuration(averageHold), confidence],
      ["常见退出方式", `${commonExit[0]}（${commonExit[1]}/${trades.length}）`, confidence]
    ];
    $("habit-list").innerHTML = rows.map(([label, value, level]) => `<div class="habit-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><em>${escapeHtml(level)}</em></div>`).join("");
  }

  function renderAll() {
    renderAccount();
    renderOrderPreview();
    renderPositions();
    renderJournal();
    renderWeekly();
    renderHabits();
  }

  async function handlePrice(symbol, price) {
    if (!SYMBOLS.includes(symbol) || !Number.isFinite(price) || price <= 0) return;
    state.prices[symbol] = price;
    renderAccount();
    renderPositions();
    if (symbol === state.activeSymbol) renderOrderPreview();
    await evaluateStops(symbol, price);
  }

  async function refreshInactivePrices() {
    const symbols = [...new Set(state.account.positions.map((position) => position.symbol))].filter((symbol) => symbol !== state.activeSymbol);
    await Promise.all(symbols.map(async (symbol) => {
      try {
        const response = await fetch(`${API_ROOT}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) return;
        const payload = await response.json();
        await handlePrice(symbol, Number(payload.price));
      } catch (_) {}
    }));
  }

  function navigate(view) {
    document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelectorAll("[data-app-view]").forEach((section) => section.classList.toggle("active", section.dataset.appView === view));
    if (view === "weekly") renderWeekly();
    if (view === "habits") renderHabits();
  }

  async function toggleAnalysis(tradeId, included) {
    const trade = state.account.trades.find((item) => item.id === tradeId);
    if (!trade) return;
    trade.includeInAnalysis = included;
    await saveAccount();
    renderWeekly();
    renderHabits();
  }

  async function configureAccount() {
    const hasData = state.account.positions.length || state.account.trades.length;
    if (hasData && !window.confirm("修改初始资金将清空当前模拟持仓和交易记录。请先导出备份，确定继续吗？")) return;
    const nextBalance = Number(window.prompt("设置模拟账户初始资金（USDT）", String(state.account.initialBalance)));
    if (!Number.isFinite(nextBalance) || nextBalance <= 0) return showToast("请输入大于0的初始资金。", true);
    state.account = { initialBalance: nextBalance, realizedPnl: 0, positions: [], trades: [] };
    await saveAccount();
    renderAll();
    window.dispatchEvent(new Event("paper-positions-changed"));
    showToast(`模拟账户已设置为 ${formatMoney(nextBalance)}。`);
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    download(`paper-trading-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({ version: 1, exportedAt: Date.now(), account: state.account }, null, 2), "application/json");
  }

  async function importJson(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload?.account || !Array.isArray(payload.account.positions) || !Array.isArray(payload.account.trades)) throw new Error("备份结构不完整");
      if (!window.confirm("导入会覆盖当前浏览器中的模拟账户、持仓和交易日志，确定继续吗？")) return;
      state.account = normalizeAccount(payload.account);
      await saveAccount();
      renderAll();
      window.dispatchEvent(new Event("paper-positions-changed"));
      showToast("JSON备份已导入。存量持仓会按最新真实价格继续监控。");
    } catch (error) {
      showToast(`导入失败：${error.message || "文件格式无效"}`, true);
    } finally {
      $("import-json").value = "";
    }
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  }

  function exportCsv() {
    const header = ["交易ID","标的","方向","开仓时间","平仓时间","开仓价","平仓价","止损","止盈","名义金额","盈亏","R倍数","开仓理由","退出原因","备注","纳入画像"];
    const rows = state.account.trades.map((trade) => [trade.id, trade.symbol, SIDE_LABELS[trade.side], new Date(trade.openAt).toISOString(), new Date(trade.closeAt).toISOString(), trade.entryPrice, trade.closePrice, trade.stopLoss, trade.takeProfit, trade.notional, trade.pnl, trade.rMultiple, trade.reasons.join("|"), trade.exitReason, trade.note, trade.includeInAnalysis !== false]);
    download(`paper-trading-log-${new Date().toISOString().slice(0,10)}.csv`, `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}`, "text/csv;charset=utf-8");
  }

  function bindEvents() {
    document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    document.querySelectorAll(".side-toggle").forEach((button) => button.addEventListener("click", () => {
      state.side = button.dataset.side;
      document.querySelectorAll(".side-toggle").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      renderOrderPreview();
    }));
    ["order-notional", "order-stop", "order-target"].forEach((idName) => $(idName).addEventListener("input", renderOrderPreview));
    $("open-position").addEventListener("click", openPosition);
    $("positions-body").addEventListener("click", (event) => {
      const closeButton = event.target.closest("[data-close-position]");
      if (closeButton) {
        const position = state.account.positions.find((item) => item.id === closeButton.dataset.closePosition);
        const price = position && currentPrice(position.symbol);
        if (position && Number.isFinite(price) && window.confirm(`按当前真实价格 ${formatPrice(price)} 模拟平仓？`)) closePosition(position.id, "手动平仓", price);
      }
      const editButton = event.target.closest("[data-edit-position]");
      if (editButton) modifyPosition(editButton.dataset.editPosition);
    });
    ["journal-symbol-filter", "journal-side-filter", "journal-result-filter"].forEach((idName) => $(idName).addEventListener("change", renderJournal));
    $("journal-body").addEventListener("change", (event) => {
      const input = event.target.closest("[data-analysis-toggle]");
      if (input) toggleAnalysis(input.dataset.analysisToggle, input.checked);
    });
    $("week-prev").addEventListener("click", () => { state.selectedWeekStart -= 7 * 24 * 60 * 60 * 1000; renderWeekly(); });
    $("week-next").addEventListener("click", () => { if (state.selectedWeekStart < startOfWeek(Date.now())) state.selectedWeekStart += 7 * 24 * 60 * 60 * 1000; renderWeekly(); });
    $("account-settings").addEventListener("click", configureAccount);
    $("account-settings-nav").addEventListener("click", configureAccount);
    $("export-json").addEventListener("click", exportJson);
    $("import-json").addEventListener("change", (event) => importJson(event.target.files?.[0]));
    $("export-csv").addEventListener("click", exportCsv);
    window.addEventListener("market-price", (event) => handlePrice(event.detail.symbol, Number(event.detail.price)));
    window.addEventListener("market-symbol", (event) => { state.activeSymbol = event.detail.symbol; renderOrderPreview(); });
  }

  async function start() {
    bindEvents();
    state.account = normalizeAccount(await readAccount());
    renderAll();
    state.priceTimer = setInterval(refreshInactivePrices, PRICE_REFRESH_INTERVAL);
    refreshInactivePrices();
  }

  window.paperTrading = {
    getPositionsForSymbol(symbol) { return state.account.positions.filter((position) => position.symbol === symbol); },
    getAccountSnapshot() { return JSON.parse(JSON.stringify(state.account)); }
  };

  start().catch((error) => showToast(`模拟账户初始化失败：${error.message || "未知错误"}`, true));
})();
