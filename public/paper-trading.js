(() => {
  "use strict";

  const DB_NAME = "paper-trading-journal";
  const DB_VERSION = 1;
  const STORE_NAME = "records";
  const STATE_KEY = "paper-account";
  const SIDE_LABELS = { long: "做多", short: "做空" };
  const REASON_ORDER = ["支撑/压力", "K线反转", "RSI超买超卖", "区间高抛低吸", "突破/回踩", "其他"];
  const state = { trades: [], selectedWeekStart: startOfWeek(Date.now()), toastTimer: null };
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

  function normalizeTrade(trade) {
    const openAt = Number(trade?.openAt);
    const closeAt = Number(trade?.closeAt);
    const entryPrice = Number(trade?.entryPrice);
    const closePrice = Number(trade?.closePrice);
    const pnl = Number(trade?.pnl);
    if (![openAt, closeAt, entryPrice, closePrice, pnl].every(Number.isFinite) || closeAt < openAt) return null;
    const quantity = Number(trade?.quantity);
    const leverage = Number(trade?.leverage);
    const stopLoss = Number(trade?.stopLoss);
    const takeProfit = Number(trade?.takeProfit);
    const normalizedLeverage = Number.isFinite(leverage) && leverage >= 1 ? leverage : 1;
    const risk = Number.isFinite(quantity) && quantity > 0 && Number.isFinite(stopLoss) && stopLoss > 0
      ? Math.abs(entryPrice - stopLoss) * quantity * normalizedLeverage : NaN;
    return {
      id: String(trade?.id || id()), symbol: String(trade?.symbol || "XAUUSDT"),
      side: trade?.side === "short" ? "short" : "long", openAt, closeAt, entryPrice, closePrice, pnl,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null, leverage: normalizedLeverage,
      stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
      takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null,
      reasons: Array.isArray(trade?.reasons) ? trade.reasons.map(String) : [],
      note: String(trade?.note || ""), exitReason: String(trade?.exitReason || "其他"),
      includeInAnalysis: trade?.includeInAnalysis !== false,
      rMultiple: Number.isFinite(Number(trade?.rMultiple)) ? Number(trade.rMultiple) : Number.isFinite(risk) && risk > 0 ? pnl / risk : null,
      source: "manual"
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

  function selectedReasons() {
    return [...document.querySelectorAll('input[name="real-entry-reason"]:checked')].map((input) => input.value);
  }

  function calculatedPnlFromForm() {
    const entryPrice = Number($("trade-entry-price").value);
    const closePrice = Number($("trade-close-price").value);
    const quantity = Number($("trade-quantity").value);
    const leverage = Number($("trade-leverage").value);
    if (![entryPrice, closePrice, quantity, leverage].every(Number.isFinite) || entryPrice <= 0 || closePrice <= 0 || quantity < 0.1 || leverage < 1) return NaN;
    const direction = $("trade-side").value === "short" ? -1 : 1;
    return (closePrice - entryPrice) * quantity * leverage * direction;
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
    const openAt = new Date($("trade-open-time").value).getTime();
    const closeAt = new Date($("trade-close-time").value).getTime();
    const entryPrice = Number($("trade-entry-price").value);
    const closePrice = Number($("trade-close-price").value);
    const pnl = calculatedPnlFromForm();
    const quantity = Number($("trade-quantity").value);
    const leverage = Number($("trade-leverage").value);
    const stopLoss = Number($("trade-stop").value);
    const takeProfit = Number($("trade-target").value);
    const reasons = selectedReasons();
    if (!Number.isFinite(openAt) || !Number.isFinite(closeAt)) return { error: "请填写完整的开仓和平仓时间。" };
    if (closeAt < openAt) return { error: "平仓时间不能早于开仓时间。" };
    if (![entryPrice, closePrice].every((value) => Number.isFinite(value) && value > 0)) return { error: "请填写有效的开仓价和平仓价。" };
    if (!Number.isFinite(quantity) || quantity < 0.1) return { error: "开仓数量最小为 0.1。" };
    if (!Number.isFinite(leverage) || leverage < 1) return { error: "杠杆倍数最小为 1。" };
    if (!Number.isFinite(pnl)) return { error: "请填写开仓价、平仓价、开仓数量和杠杆倍数。" };
    if (!reasons.length) return { error: "请至少选择一项开仓依据。" };
    const risk = Number.isFinite(stopLoss) && stopLoss > 0 ? Math.abs(entryPrice - stopLoss) * quantity * leverage : NaN;
    return {
      id: $("trade-edit-id").value || id(), symbol, side, openAt, closeAt, entryPrice, closePrice, pnl,
      quantity, leverage,
      stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
      takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null,
      reasons, note: $("trade-note").value.trim(), exitReason: $("trade-exit-reason").value,
      includeInAnalysis: true, rMultiple: Number.isFinite(risk) && risk > 0 ? pnl / risk : null, source: "manual"
    };
  }

  function resetTradeForm() {
    $("trade-edit-id").value = "";
    $("trade-symbol").value = "XAUUSDT";
    $("trade-side").value = "long";
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
    $("trade-form-error").textContent = "自动盈亏暂不包含手续费、滑点和资金费率。";
    $("save-trade").textContent = "保存实盘交易";
  }

  async function saveTradeFromForm() {
    const value = readTradeForm();
    $("trade-form-error").textContent = value.error || "";
    if (value.error) return;
    const existing = state.trades.find((trade) => trade.id === value.id);
    if (existing) value.includeInAnalysis = existing.includeInAnalysis;
    state.trades = [value, ...state.trades.filter((trade) => trade.id !== value.id)];
    await saveTrades();
    resetTradeForm();
    renderAll();
    showToast(existing ? "实盘交易记录已更新。" : "实盘交易已录入并纳入分析。" );
  }

  function journalRow(trade) {
    const r = Number.isFinite(trade.rMultiple) ? trade.rMultiple.toFixed(2) : "—";
    return `<tr>
      <td>${escapeHtml(formatDate(trade.closeAt))}</td><td>${escapeHtml(trade.id.slice(0, 8))}</td><td>${escapeHtml(trade.symbol)}</td>
      <td class="${trade.side === "long" ? "direction-long" : "direction-short"}">${SIDE_LABELS[trade.side]}</td><td>${escapeHtml(`${trade.leverage}x`)}</td>
      <td>${escapeHtml(trade.reasons.join(" / ") || "—")}</td><td>${escapeHtml(formatPrice(trade.entryPrice))} / ${escapeHtml(formatPrice(trade.closePrice))}</td>
      <td>${escapeHtml(trade.exitReason)}</td><td>${escapeHtml(formatDuration(trade.closeAt - trade.openAt))}</td>
      <td class="${trade.pnl > 0 ? "metric-positive" : trade.pnl < 0 ? "metric-negative" : ""}">${escapeHtml(formatMoney(trade.pnl, true))}</td>
      <td>${escapeHtml(r)}</td><td><input type="checkbox" data-analysis-toggle="${escapeHtml(trade.id)}" ${trade.includeInAnalysis ? "checked" : ""} aria-label="纳入分析"></td>
      <td><div class="row-actions"><button class="row-button" data-edit-trade="${escapeHtml(trade.id)}" type="button">编辑</button><button class="row-button delete" data-delete-trade="${escapeHtml(trade.id)}" type="button">删除</button></div></td>
    </tr>`;
  }

  function filteredTrades() {
    const symbol = $("journal-symbol-filter").value;
    const side = $("journal-side-filter").value;
    const result = $("journal-result-filter").value;
    return [...state.trades].filter((trade) =>
      (symbol === "all" || trade.symbol === symbol) &&
      (side === "all" || trade.side === side) &&
      (result === "all" || (result === "win" ? trade.pnl > 0 : trade.pnl < 0))
    ).sort((a, b) => b.closeAt - a.closeAt);
  }

  function renderJournal() {
    const trades = filteredTrades();
    $("journal-body").innerHTML = trades.length ? trades.map(journalRow).join("") : '<tr class="empty-row"><td colspan="13">当前筛选条件下没有实盘交易记录。</td></tr>';
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
    const weekTrades = state.trades.filter((trade) => trade.includeInAnalysis && trade.closeAt >= state.selectedWeekStart && trade.closeAt < endOfWeek(state.selectedWeekStart));
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
    ] : [{ type: "", title: "等待实盘记录", text: "本周录入并纳入分析的交易出现后，这里自动生成总结。" }];
    $("weekly-insights").innerHTML = insights.map((item) => `<div class="insight-item ${item.type}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.text)}</p></div>`).join("");
    $("weekly-trades-body").innerHTML = weekTrades.length ? [...weekTrades].sort((a,b) => b.closeAt - a.closeAt).map((trade) => `<tr><td>${escapeHtml(formatDate(trade.closeAt))}</td><td>${escapeHtml(trade.id.slice(0,8))}</td><td>${escapeHtml(trade.symbol)}</td><td>${SIDE_LABELS[trade.side]}</td><td>${escapeHtml(trade.reasons.join(" / "))}</td><td>${escapeHtml(trade.exitReason)}</td><td class="${trade.pnl >= 0 ? "metric-positive" : "metric-negative"}">${escapeHtml(formatMoney(trade.pnl, true))}</td></tr>`).join("") : '<tr class="empty-row"><td colspan="7">本周暂无交易证据。</td></tr>';
  }

  function renderHabits() {
    const trades = state.trades.filter((trade) => trade.includeInAnalysis);
    const confidence = confidenceLabel(trades.length);
    $("habit-confidence").textContent = `${confidence} · ${trades.length}笔`;
    if (!trades.length) {
      $("habit-list").innerHTML = '<div class="empty-row">录入并纳入至少一笔实盘交易后开始形成画像。</div>';
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
    renderJournal();
    renderWeekly();
    renderHabits();
  }

  function navigate(view) {
    document.body.classList.toggle("monitor-active", view === "monitor");
    document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelectorAll("[data-app-view]").forEach((section) => section.classList.toggle("active", section.dataset.appView === view));
    if (view === "journal") renderJournal();
    if (view === "weekly") renderWeekly();
    if (view === "habits") renderHabits();
  }

  function editTrade(tradeId) {
    const trade = state.trades.find((item) => item.id === tradeId);
    if (!trade) return;
    navigate("journal");
    $("trade-edit-id").value = trade.id;
    $("trade-symbol").value = [...$("trade-symbol").options].some((option) => option.value === trade.symbol) ? trade.symbol : "其他";
    $("trade-side").value = trade.side;
    $("trade-open-time").value = toLocalInput(trade.openAt);
    $("trade-close-time").value = toLocalInput(trade.closeAt);
    $("trade-entry-price").value = String(trade.entryPrice);
    $("trade-close-price").value = String(trade.closePrice);
    $("trade-pnl").value = String(trade.pnl);
    $("trade-quantity").value = Number.isFinite(trade.quantity) ? String(trade.quantity) : "";
    $("trade-leverage").value = String(Number.isFinite(trade.leverage) ? trade.leverage : 1);
    $("trade-stop").value = Number.isFinite(trade.stopLoss) ? String(trade.stopLoss) : "";
    $("trade-target").value = Number.isFinite(trade.takeProfit) ? String(trade.takeProfit) : "";
    $("trade-exit-reason").value = [...$("trade-exit-reason").options].some((option) => option.value === trade.exitReason) ? trade.exitReason : "其他";
    $("trade-note").value = trade.note;
    document.querySelectorAll('input[name="real-entry-reason"]').forEach((input) => { input.checked = trade.reasons.includes(input.value); });
    updateCalculatedPnl();
    $("save-trade").textContent = "保存修改";
    $("trade-entry-title").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteTrade(tradeId) {
    if (!window.confirm("确定删除这笔实盘交易记录吗？删除后无法恢复。")) return;
    state.trades = state.trades.filter((trade) => trade.id !== tradeId);
    await saveTrades();
    renderAll();
    showToast("交易记录已删除。" );
  }

  async function toggleAnalysis(tradeId, included) {
    const trade = state.trades.find((item) => item.id === tradeId);
    if (!trade) return;
    trade.includeInAnalysis = included;
    await saveTrades();
    renderWeekly();
    renderHabits();
  }

  function bindEvents() {
    document.querySelectorAll(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    $("save-trade").addEventListener("click", saveTradeFromForm);
    $("reset-trade-form").addEventListener("click", resetTradeForm);
    ["trade-side", "trade-entry-price", "trade-close-price", "trade-quantity", "trade-leverage"].forEach((idName) => $(idName).addEventListener("input", updateCalculatedPnl));
    $("trade-side").addEventListener("change", updateCalculatedPnl);
    ["journal-symbol-filter", "journal-side-filter", "journal-result-filter"].forEach((idName) => $(idName).addEventListener("change", renderJournal));
    $("journal-body").addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit-trade]");
      const deleteButton = event.target.closest("[data-delete-trade]");
      if (editButton) editTrade(editButton.dataset.editTrade);
      if (deleteButton) deleteTrade(deleteButton.dataset.deleteTrade);
    });
    $("journal-body").addEventListener("change", (event) => {
      const input = event.target.closest("[data-analysis-toggle]");
      if (input) toggleAnalysis(input.dataset.analysisToggle, input.checked);
    });
    $("week-prev").addEventListener("click", () => { state.selectedWeekStart -= 7 * 24 * 60 * 60 * 1000; renderWeekly(); });
    $("week-next").addEventListener("click", () => { if (state.selectedWeekStart < startOfWeek(Date.now())) state.selectedWeekStart += 7 * 24 * 60 * 60 * 1000; renderWeekly(); });
  }

  async function start() {
    bindEvents();
    state.trades = (await readTrades()).filter((trade) => trade?.source === "manual").map(normalizeTrade).filter(Boolean);
    resetTradeForm();
    renderAll();
  }

  window.paperTrading = {
    getPositionsForSymbol() { return []; },
    getJournalSnapshot() { return JSON.parse(JSON.stringify(state.trades)); }
  };

  start().catch((error) => showToast(`交易日志初始化失败：${error.message || "未知错误"}`, true));
})();
