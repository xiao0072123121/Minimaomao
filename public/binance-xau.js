(() => {
  "use strict";

  const PAGE_LOCATION = window.location;
  const USE_PROXY = PAGE_LOCATION.protocol === "https:" && !["localhost", "127.0.0.1"].includes(PAGE_LOCATION.hostname);
  const DIRECT_API = "https://fapi.binance.com";
  const API_ROOT = USE_PROXY ? `${PAGE_LOCATION.origin}/api/binance` : DIRECT_API;
  const WS_ROOT = "wss://fstream.binance.com/ws";
  const HOUR = 60 * 60 * 1000;
  const FRAME_CONFIG = Object.freeze({
    h4: { interval: "4h", ms: 4 * HOUR, limit: 240, pivotWindow: 2, label: "H4" },
    h1: { interval: "1h", ms: HOUR, limit: 320, pivotWindow: 2, label: "H1" }
  });
  const SYMBOLS = Object.freeze({
    XAUUSDT: { label: "黄金", base: "XAU" },
    SNDKUSDT: { label: "SanDisk", base: "SNDK" },
    SKHYNIXUSDT: { label: "SK hynix", base: "SKHYNIX" }
  });
  const DATABASE_NAME = "price-action-zone-cache";
  const DATABASE_VERSION = 1;
  const DATABASE_STORE = "ohlc";
  const CACHE_MAX_AGE = 7 * 24 * HOUR;
  const PRICE_FALLBACK_INTERVAL = 15 * 1000;
  const FRAME_REFRESH_INTERVAL = HOUR;
  const MAX_RECONNECT_DELAY = 30 * 1000;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    symbol: "XAUUSDT",
    price: NaN,
    priceAt: 0,
    frames: { h4: [], h1: [] },
    zones: [],
    chartFrame: "h4",
    visibleBars: 100,
    loadGeneration: 0,
    abortController: null,
    priceSocket: null,
    reconnectTimer: null,
    pricePollTimer: null,
    frameRefreshTimer: null,
    reconnectAttempt: 0,
    chartMeta: null,
    zoneRoleSignature: ""
  };

  const $ = (id) => document.getElementById(id);
  const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatPrice(value) {
    return Number.isFinite(value) ? priceFormatter.format(value) : "—";
  }

  function formatZone(zone) {
    return zone ? `${formatPrice(zone.low)} – ${formatPrice(zone.high)}` : "—";
  }

  function formatTime(timestamp) {
    return Number.isFinite(timestamp) ? dateTimeFormatter.format(new Date(timestamp)).replace("24:", "00:") : "—";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showError(message = "") {
    const banner = $("error-banner");
    banner.textContent = message;
    banner.classList.toggle("visible", Boolean(message));
  }

  function setConnection(connected, text) {
    $("live-state").classList.toggle("connected", connected);
    $("live-text").textContent = text;
  }

  function updatePrice(value, timestamp = Date.now()) {
    if (!Number.isFinite(value) || value <= 0) return;
    state.price = value;
    state.priceAt = timestamp;
    $("current-price").textContent = formatPrice(value);
    $("price-time").textContent = `更新 ${formatTime(timestamp)}`;
    setConnection(true, "实时价格已连接");
    const nextSignature = state.zones.map((zone) => zoneRole(zone, value)).join("|");
    if (nextSignature !== state.zoneRoleSignature) {
      renderZones();
      renderChart();
    }
  }

  function openDatabase() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DATABASE_STORE)) {
          database.createObjectStore(DATABASE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  async function readFrameCache(symbol, frameKey) {
    const database = await openDatabase();
    if (!database) return [];
    return new Promise((resolve) => {
      const transaction = database.transaction(DATABASE_STORE, "readonly");
      const request = transaction.objectStore(DATABASE_STORE).get(`${symbol}:${frameKey}`);
      request.onsuccess = () => {
        const record = request.result;
        const valid = record && Date.now() - record.savedAt <= CACHE_MAX_AGE && Array.isArray(record.candles);
        resolve(valid ? record.candles.slice(-FRAME_CONFIG[frameKey].limit) : []);
      };
      request.onerror = () => resolve([]);
      transaction.oncomplete = () => database.close();
    });
  }

  async function writeFrameCache(symbol, frameKey, candles) {
    const database = await openDatabase();
    if (!database) return;
    const compact = candles.slice(-FRAME_CONFIG[frameKey].limit);
    const transaction = database.transaction(DATABASE_STORE, "readwrite");
    transaction.objectStore(DATABASE_STORE).put({ key: `${symbol}:${frameKey}`, savedAt: Date.now(), candles: compact });
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  }

  async function fetchJson(path, signal) {
    const candidates = [`${API_ROOT}${path}`];
    if (USE_PROXY) candidates.push(`${DIRECT_API}${path}`);
    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { signal, headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (error.name === "AbortError") throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("行情请求失败");
  }

  function compactKline(item) {
    if (!Array.isArray(item) || item.length < 7) return null;
    const candle = {
      t: Number(item[0]),
      o: Number(item[1]),
      h: Number(item[2]),
      l: Number(item[3]),
      c: Number(item[4]),
      ct: Number(item[6])
    };
    return Object.values(candle).every(Number.isFinite) ? candle : null;
  }

  function mergeCandles(existing, incoming, limit) {
    const byTime = new Map();
    for (const candle of [...existing, ...incoming]) byTime.set(candle.t, candle);
    return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-limit);
  }

  async function requestFrame(frameKey, incremental, signal) {
    const config = FRAME_CONFIG[frameKey];
    const limit = incremental ? 4 : config.limit;
    const path = `/fapi/v1/klines?symbol=${encodeURIComponent(state.symbol)}&interval=${config.interval}&limit=${limit}`;
    const payload = await fetchJson(path, signal);
    if (!Array.isArray(payload)) throw new Error(`${config.label} K线格式无效`);
    const now = Date.now();
    return payload.map(compactKline).filter((candle) => candle && candle.ct < now);
  }

  async function loadFrames({ incremental = false, quiet = false } = {}) {
    const generation = state.loadGeneration;
    const symbol = state.symbol;
    const signal = state.abortController?.signal;
    if (!quiet) $("zone-state").textContent = "正在读取H4/H1收盘K线";

    if (!incremental) {
      const [cachedH4, cachedH1] = await Promise.all([
        readFrameCache(symbol, "h4"),
        readFrameCache(symbol, "h1")
      ]);
      if (generation !== state.loadGeneration || symbol !== state.symbol) return;
      state.frames.h4 = cachedH4;
      state.frames.h1 = cachedH1;
      if (cachedH4.length || cachedH1.length) recalculateZones();
    }

    const results = await Promise.allSettled([
      requestFrame("h4", incremental, signal),
      requestFrame("h1", incremental, signal)
    ]);
    if (generation !== state.loadGeneration || symbol !== state.symbol) return;

    const failures = [];
    for (const [index, frameKey] of ["h4", "h1"].entries()) {
      const result = results[index];
      if (result.status === "fulfilled" && result.value.length) {
        state.frames[frameKey] = mergeCandles(state.frames[frameKey], result.value, FRAME_CONFIG[frameKey].limit);
        writeFrameCache(symbol, frameKey, state.frames[frameKey]);
      } else if (!state.frames[frameKey].length) {
        failures.push(FRAME_CONFIG[frameKey].label);
      }
    }

    recalculateZones();
    if (failures.length) {
      showError(`${failures.join("/")} 历史价格暂时不可用；页面会保留本地缓存并自动重试。`);
    } else {
      showError("");
    }
  }

  async function requestPriceOnce() {
    const generation = state.loadGeneration;
    const symbol = state.symbol;
    try {
      const payload = await fetchJson(`/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`, state.abortController?.signal);
      if (generation !== state.loadGeneration || symbol !== state.symbol) return;
      updatePrice(Number(payload.price), Date.now());
    } catch (error) {
      if (error.name !== "AbortError" && !Number.isFinite(state.price)) setConnection(false, "实时价格重连中");
    }
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const delay = Math.min(MAX_RECONNECT_DELAY, 1000 * 2 ** Math.min(5, state.reconnectAttempt++));
    state.reconnectTimer = setTimeout(connectPriceSocket, delay);
  }

  function connectPriceSocket() {
    if (state.priceSocket) {
      state.priceSocket.onclose = null;
      state.priceSocket.close();
    }
    const generation = state.loadGeneration;
    const symbol = state.symbol.toLowerCase();
    const socket = new WebSocket(`${WS_ROOT}/${symbol}@markPrice@1s`);
    state.priceSocket = socket;
    socket.onopen = () => {
      if (generation !== state.loadGeneration) return socket.close();
      state.reconnectAttempt = 0;
      setConnection(true, "实时价格已连接");
    };
    socket.onmessage = (event) => {
      if (generation !== state.loadGeneration) return;
      try {
        const payload = JSON.parse(event.data);
        updatePrice(Number(payload.p), Number(payload.E) || Date.now());
      } catch (_) {}
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (generation !== state.loadGeneration) return;
      setConnection(false, "实时价格重连中");
      scheduleReconnect();
    };
  }

  function median(values) {
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return NaN;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  }

  function findPivots(frameKey, candles) {
    const config = FRAME_CONFIG[frameKey];
    const windowSize = config.pivotWindow;
    const pivots = [];
    for (let index = windowSize; index < candles.length - windowSize; index += 1) {
      const current = candles[index];
      const neighbors = candles.slice(index - windowSize, index + windowSize + 1);
      const other = neighbors.filter((_, neighborIndex) => neighborIndex !== windowSize);
      const swingHigh = other.every((candle) => current.h >= candle.h) && other.some((candle) => current.h > candle.h);
      const swingLow = other.every((candle) => current.l <= candle.l) && other.some((candle) => current.l < candle.l);
      if (swingHigh) pivots.push({ price: current.h, time: current.t, frame: frameKey, kind: "high" });
      if (swingLow) pivots.push({ price: current.l, time: current.t, frame: frameKey, kind: "low" });
    }
    return pivots;
  }

  function frameHalfWidth(frameKey, candles, referencePrice) {
    const recent = candles.slice(-120);
    const medianRange = median(recent.map((candle) => candle.h - candle.l));
    if (!Number.isFinite(medianRange) || !Number.isFinite(referencePrice)) return referencePrice * .001;
    if (frameKey === "h4") return clamp(medianRange * .16, referencePrice * .001, referencePrice * .0045);
    return clamp(medianRange * .2, referencePrice * .0007, referencePrice * .0032);
  }

  function buildZones() {
    const fallbackPrice = state.frames.h1.at(-1)?.c || state.frames.h4.at(-1)?.c;
    const referencePrice = Number.isFinite(state.price) ? state.price : fallbackPrice;
    if (!Number.isFinite(referencePrice)) return [];

    const widths = {
      h4: frameHalfWidth("h4", state.frames.h4, referencePrice),
      h1: frameHalfWidth("h1", state.frames.h1, referencePrice)
    };
    const pivots = [
      ...findPivots("h4", state.frames.h4),
      ...findPivots("h1", state.frames.h1)
    ].sort((a, b) => a.price - b.price);

    const clusters = [];
    for (const pivot of pivots) {
      const weight = pivot.frame === "h4" ? 2 : 1;
      const halfWidth = widths[pivot.frame];
      let best = null;
      let bestDistance = Infinity;
      for (const cluster of clusters) {
        const distance = Math.abs(cluster.center - pivot.price);
        if (distance <= Math.max(cluster.halfWidth, halfWidth) && distance < bestDistance) {
          best = cluster;
          bestDistance = distance;
        }
      }
      if (!best) {
        clusters.push({
          center: pivot.price,
          weightedPrice: pivot.price * weight,
          totalWeight: weight,
          halfWidth,
          pivots: [pivot]
        });
      } else {
        best.weightedPrice += pivot.price * weight;
        best.totalWeight += weight;
        best.center = best.weightedPrice / best.totalWeight;
        best.halfWidth = Math.max(best.halfWidth, halfWidth);
        best.pivots.push(pivot);
      }
    }

    return clusters
      .map((cluster) => {
        const frames = [...new Set(cluster.pivots.map((pivot) => pivot.frame))];
        const highTouches = cluster.pivots.filter((pivot) => pivot.kind === "high").length;
        const lowTouches = cluster.pivots.length - highTouches;
        const newest = Math.max(...cluster.pivots.map((pivot) => pivot.time));
        const low = cluster.center - cluster.halfWidth;
        const high = cluster.center + cluster.halfWidth;
        return {
          center: cluster.center,
          low,
          high,
          touches: cluster.pivots.length,
          frames,
          highTouches,
          lowTouches,
          newest,
          confluence: frames.length > 1
        };
      })
      .filter((zone) => zone.touches >= 2 || zone.confluence)
      .filter((zone) => zone.high - zone.low <= referencePrice * .012)
      .sort((a, b) => a.center - b.center);
  }

  function zoneRole(zone, price) {
    if (!Number.isFinite(price)) return "unknown";
    if (price < zone.low) return "resistance";
    if (price > zone.high) return "support";
    return "active";
  }

  function zoneQuality(zone) {
    if (zone.confluence && zone.touches >= 3) return "H4/H1共振";
    if (zone.frames.includes("h4") && zone.touches >= 3) return "H4重复触碰";
    if (zone.confluence) return "H4/H1重合";
    return "重复触碰";
  }

  function recalculateZones() {
    state.zones = buildZones();
    $("bar-counts").textContent = `H4 ${state.frames.h4.length} · H1 ${state.frames.h1.length}`;
    const enough = state.frames.h4.length >= 30 && state.frames.h1.length >= 60;
    $("zone-state").textContent = enough ? `已识别 ${state.zones.length} 个固定区域` : "历史样本不足，等待补充";
    $("zone-updated").textContent = formatTime(Date.now());
    renderZones();
    renderChart();
  }

  function zoneRowMarkup(zone, role) {
    const frames = zone.frames.map((frame) => FRAME_CONFIG[frame].label).join(" + ");
    return `<div class="zone-row ${role}">
      <div class="zone-price">${escapeHtml(formatZone(zone))}</div>
      <div class="zone-meta">${escapeHtml(zoneQuality(zone))} · ${zone.touches}次摆动触碰</div>
      <div class="zone-source">来源 ${escapeHtml(frames)} · 最近 ${escapeHtml(formatTime(zone.newest))}</div>
    </div>`;
  }

  function renderZones() {
    const referencePrice = Number.isFinite(state.price) ? state.price : state.frames.h1.at(-1)?.c || state.frames.h4.at(-1)?.c;
    const supports = state.zones
      .filter((zone) => zoneRole(zone, referencePrice) === "support")
      .sort((a, b) => b.high - a.high)
      .slice(0, 4);
    const resistances = state.zones
      .filter((zone) => zoneRole(zone, referencePrice) === "resistance")
      .sort((a, b) => a.low - b.low)
      .slice(0, 4);
    const active = state.zones
      .filter((zone) => zoneRole(zone, referencePrice) === "active")
      .sort((a, b) => Math.abs(a.center - referencePrice) - Math.abs(b.center - referencePrice))[0];

    $("support-list").innerHTML = supports.length
      ? supports.map((zone) => zoneRowMarkup(zone, "support")).join("")
      : '<div class="empty-zones">当前样本中没有满足重复触碰条件的下方区域</div>';
    $("resistance-list").innerHTML = resistances.length
      ? resistances.map((zone) => zoneRowMarkup(zone, "resistance")).join("")
      : '<div class="empty-zones">当前样本中没有满足重复触碰条件的上方区域</div>';
    $("support-count").textContent = `${supports.length}个邻近区域`;
    $("resistance-count").textContent = `${resistances.length}个邻近区域`;

    const nearestSupport = supports[0];
    const nearestResistance = resistances[0];
    $("nearest-support").textContent = formatZone(nearestSupport);
    $("nearest-support-meta").textContent = nearestSupport ? `${zoneQuality(nearestSupport)} · ${nearestSupport.touches}次触碰` : "暂无有效下方区域";
    $("nearest-resistance").textContent = formatZone(nearestResistance);
    $("nearest-resistance-meta").textContent = nearestResistance ? `${zoneQuality(nearestResistance)} · ${nearestResistance.touches}次触碰` : "暂无有效上方区域";
    $("active-zone").textContent = active ? "位于价格区域内" : "区域之间";
    $("active-zone-meta").textContent = active ? `${formatZone(active)} · ${zoneQuality(active)}` : "只描述位置，不生成方向或策略";
    state.zoneRoleSignature = state.zones.map((zone) => zoneRole(zone, referencePrice)).join("|");
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function renderChart() {
    const svg = $("price-chart");
    const allCandles = state.frames[state.chartFrame];
    if (!allCandles.length) {
      svg.innerHTML = '<text x="600" y="240" text-anchor="middle" fill="#8ca0b2" font-size="14">等待历史价格</text>';
      state.chartMeta = null;
      return;
    }

    const count = clamp(state.visibleBars, 30, allCandles.length);
    const candles = allCandles.slice(-count);
    const width = 1200;
    const height = 480;
    const plot = { left: 18, right: 88, top: 16, bottom: 38 };
    const plotWidth = width - plot.left - plot.right;
    const plotHeight = height - plot.top - plot.bottom;
    let minimum = Math.min(...candles.map((candle) => candle.l));
    let maximum = Math.max(...candles.map((candle) => candle.h));
    const visibleZones = state.zones.filter((zone) => zone.high >= minimum && zone.low <= maximum);
    for (const zone of visibleZones) {
      minimum = Math.min(minimum, zone.low);
      maximum = Math.max(maximum, zone.high);
    }
    const padding = Math.max((maximum - minimum) * .08, maximum * .0005);
    minimum -= padding;
    maximum += padding;
    const span = Math.max(maximum - minimum, 1e-9);
    const y = (price) => plot.top + (maximum - price) / span * plotHeight;
    const step = plotWidth / candles.length;
    const bodyWidth = clamp(step * .62, 1.4, 10);

    svg.replaceChildren();
    for (let index = 0; index <= 5; index += 1) {
      const lineY = plot.top + plotHeight * index / 5;
      const price = maximum - span * index / 5;
      svg.append(svgElement("line", { x1: plot.left, x2: width - plot.right, y1: lineY, y2: lineY, stroke: "rgba(170,195,216,.10)", "stroke-width": 1 }));
      const label = svgElement("text", { x: width - plot.right + 10, y: lineY + 4, fill: "#8ca0b2", "font-size": 11 });
      label.textContent = formatPrice(price);
      svg.append(label);
    }

    for (const zone of visibleZones) {
      const role = zoneRole(zone, Number.isFinite(state.price) ? state.price : candles.at(-1).c);
      const fill = role === "support" ? "rgba(47,214,162,.10)" : role === "resistance" ? "rgba(255,102,114,.10)" : "rgba(240,186,77,.11)";
      const stroke = role === "support" ? "rgba(47,214,162,.46)" : role === "resistance" ? "rgba(255,102,114,.46)" : "rgba(240,186,77,.50)";
      const top = y(zone.high);
      const bottom = y(zone.low);
      svg.append(svgElement("rect", { x: plot.left, y: top, width: plotWidth, height: Math.max(1, bottom - top), fill, stroke, "stroke-width": .8 }));
    }

    candles.forEach((candle, index) => {
      const x = plot.left + step * (index + .5);
      const up = candle.c >= candle.o;
      const color = up ? "#ff6672" : "#2fd6a2";
      svg.append(svgElement("line", { x1: x, x2: x, y1: y(candle.h), y2: y(candle.l), stroke: color, "stroke-width": 1.2 }));
      const bodyTop = y(Math.max(candle.o, candle.c));
      const bodyBottom = y(Math.min(candle.o, candle.c));
      svg.append(svgElement("rect", {
        x: x - bodyWidth / 2,
        y: bodyTop,
        width: bodyWidth,
        height: Math.max(1.5, bodyBottom - bodyTop),
        fill: color,
        stroke: color,
        "stroke-width": .8
      }));
    });

    const labelEvery = Math.max(1, Math.floor(candles.length / 5));
    for (let index = 0; index < candles.length; index += labelEvery) {
      const label = svgElement("text", {
        x: plot.left + step * (index + .5), y: height - 13, fill: "#8ca0b2", "font-size": 10, "text-anchor": "middle"
      });
      label.textContent = formatTime(candles[index].t);
      svg.append(label);
    }

    state.chartMeta = { candles, plot, width, height, step, y };
    $("chart-title").textContent = `${FRAME_CONFIG[state.chartFrame].label} 价格行为`;
    $("chart-note").textContent = `${candles.length}根已收盘K线 · ${formatTime(candles[0].t)} 至 ${formatTime(candles.at(-1).t)}`;
  }

  function handleChartPointer(event) {
    const meta = state.chartMeta;
    if (!meta) return;
    const bounds = $("price-chart").getBoundingClientRect();
    const localX = (event.clientX - bounds.left) / bounds.width * meta.width;
    const index = clamp(Math.floor((localX - meta.plot.left) / meta.step), 0, meta.candles.length - 1);
    const candle = meta.candles[index];
    const tooltip = $("chart-tooltip");
    tooltip.innerHTML = `<b>${escapeHtml(formatTime(candle.t))} · ${escapeHtml(FRAME_CONFIG[state.chartFrame].label)}</b>
      <div class="tooltip-grid"><span>开</span><b>${escapeHtml(formatPrice(candle.o))}</b><span>高</span><b>${escapeHtml(formatPrice(candle.h))}</b><span>低</span><b>${escapeHtml(formatPrice(candle.l))}</b><span>收</span><b>${escapeHtml(formatPrice(candle.c))}</b></div>`;
    const wrap = $("chart-wrap").getBoundingClientRect();
    const x = event.clientX - wrap.left;
    const y = event.clientY - wrap.top;
    tooltip.style.left = `${clamp(x + 18, 8, wrap.width - 190)}px`;
    tooltip.style.top = `${clamp(y + 18, 8, wrap.height - 145)}px`;
    tooltip.classList.add("visible");
  }

  function bindEvents() {
    document.querySelectorAll(".symbol-button").forEach((button) => {
      button.addEventListener("click", () => switchSymbol(button.dataset.symbol));
    });
    document.querySelectorAll(".frame-button").forEach((button) => {
      button.addEventListener("click", () => {
        state.chartFrame = button.dataset.frame;
        document.querySelectorAll(".frame-button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
        renderChart();
      });
    });
    $("price-chart").addEventListener("pointermove", handleChartPointer);
    $("price-chart").addEventListener("pointerleave", () => $("chart-tooltip").classList.remove("visible"));
    $("chart-wrap").addEventListener("wheel", (event) => {
      event.preventDefault();
      const total = state.frames[state.chartFrame].length;
      if (!total) return;
      const direction = event.deltaY > 0 ? 1 : -1;
      state.visibleBars = clamp(Math.round(state.visibleBars * (1 + direction * .12)), 30, total);
      renderChart();
    }, { passive: false });
    window.addEventListener("resize", renderChart, { passive: true });
    window.addEventListener("beforeunload", cleanup);
  }

  function cleanup() {
    state.abortController?.abort();
    clearTimeout(state.reconnectTimer);
    clearInterval(state.pricePollTimer);
    clearInterval(state.frameRefreshTimer);
    if (state.priceSocket) {
      state.priceSocket.onclose = null;
      state.priceSocket.close();
    }
  }

  async function switchSymbol(symbol) {
    if (!SYMBOLS[symbol]) return;
    state.loadGeneration += 1;
    state.abortController?.abort();
    state.abortController = new AbortController();
    clearTimeout(state.reconnectTimer);
    if (state.priceSocket) {
      state.priceSocket.onclose = null;
      state.priceSocket.close();
      state.priceSocket = null;
    }
    state.symbol = symbol;
    state.price = NaN;
    state.priceAt = 0;
    state.frames = { h4: [], h1: [] };
    state.zones = [];
    state.zoneRoleSignature = "";
    state.visibleBars = 100;
    state.reconnectAttempt = 0;
    document.querySelectorAll(".symbol-button").forEach((button) => button.classList.toggle("active", button.dataset.symbol === symbol));
    $("brand-subtitle").textContent = `${symbol} · 实时价格与H4/H1固定区域`;
    $("market-symbol").textContent = `BINANCE FUTURES · ${symbol}`;
    $("current-price").textContent = "—";
    $("price-time").textContent = "等待报价";
    $("zone-state").textContent = "正在读取H4/H1收盘K线";
    $("bar-counts").textContent = "H4 0 · H1 0";
    $("zone-updated").textContent = "—";
    showError("");
    renderZones();
    renderChart();
    setConnection(false, "正在连接实时价格");
    requestPriceOnce();
    connectPriceSocket();
    await loadFrames();
  }

  async function start() {
    bindEvents();
    state.abortController = new AbortController();
    await switchSymbol(state.symbol);
    state.pricePollTimer = setInterval(() => {
      if (!state.priceSocket || state.priceSocket.readyState !== WebSocket.OPEN || Date.now() - state.priceAt > 10_000) {
        requestPriceOnce();
      }
    }, PRICE_FALLBACK_INTERVAL);
    state.frameRefreshTimer = setInterval(() => loadFrames({ incremental: true, quiet: true }), FRAME_REFRESH_INTERVAL);
  }

  start().catch((error) => {
    showError(`页面初始化失败：${error.message || "未知错误"}`);
    setConnection(false, "行情连接失败");
  });
})();
