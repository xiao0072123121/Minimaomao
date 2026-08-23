const DEFAULT_USERNAME = "monitor";
const MINIMUM_PASSWORD_LENGTH = 12;
const AUTH_REALM = "muti-monitor";
const BINANCE_API_PREFIX = "/api/binance";
const CLOUD_SYNC_PATH = "/api/sync";
const CLOUD_ACCOUNT_ID = "primary";
const MAX_SYNC_BODY_BYTES = 1_500_000;
const BINANCE_API_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com"
];
const BINANCE_ENDPOINTS = new Set([
  "/fapi/v1/klines",
  "/fapi/v1/ticker/price",
  "/fapi/v1/ticker/24hr"
]);
const BINANCE_SYMBOLS = new Set(["XAUUSDT", "BTCUSDT", "SNDKUSDT", "SKHYNIXUSDT"]);
const BINANCE_INTERVALS = new Set(["15m", "1h", "4h"]);

const encoder = new TextEncoder();
let cloudSchemaReady = null;

function securityHeaders() {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function setupRequired() {
  return new Response(
    `网站管理员尚未配置有效的 ACCESS_PASSWORD（至少 ${MINIMUM_PASSWORD_LENGTH} 个字符）。`,
    {
      status: 503,
      headers: {
        ...securityHeaders(),
        "Content-Type": "text/plain; charset=UTF-8"
      }
    }
  );
}

function unauthorized() {
  return new Response("需要输入账号和密码。", {
    status: 401,
    headers: {
      ...securityHeaders(),
      "Content-Type": "text/plain; charset=UTF-8",
      "WWW-Authenticate": `Basic realm="${AUTH_REALM}", charset="UTF-8"`
    }
  });
}

function decodeBasicCredentials(authorization) {
  if (!authorization || authorization.length > 8192) return null;
  const [scheme, encoded, ...extra] = authorization.split(" ");
  if (scheme !== "Basic" || !encoded || extra.length) return null;

  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch (_) {
    return null;
  }
}

async function timingSafeEqual(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function isAuthorized(request, username, password) {
  const credentials = decodeBasicCredentials(request.headers.get("Authorization"));
  if (!credentials) return false;
  const [usernameMatches, passwordMatches] = await Promise.all([
    timingSafeEqual(credentials.username, username),
    timingSafeEqual(credentials.password, password)
  ]);
  return usernameMatches && passwordMatches;
}

function protectAssetResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) {
    headers.set(name, value);
  }
  headers.set("Vary", "Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function binanceError(message, status = 400) {
  return new Response(JSON.stringify({ code: status, msg: message }), {
    status,
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...securityHeaders(),
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

async function ensureCloudSchema(database) {
  if (!cloudSchemaReady) {
    cloudSchemaReady = database.prepare(`CREATE TABLE IF NOT EXISTS cloud_snapshots (
      account_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run().catch((error) => {
      cloudSchemaReady = null;
      throw error;
    });
  }
  await cloudSchemaReady;
}

function emptyCloudState() {
  return { capital: 100000, capitalUpdatedAt: 0, trades: [], deletedTrades: {} };
}

function validCloudState(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Array.isArray(value.trades)
    && value.deletedTrades && typeof value.deletedTrades === "object" && !Array.isArray(value.deletedTrades)
    && Number.isFinite(Number(value.capital)) && Number(value.capital) > 0;
}

async function readCloudSnapshot(database) {
  const row = await database.prepare(
    "SELECT revision, payload, updated_at FROM cloud_snapshots WHERE account_id = ?"
  ).bind(CLOUD_ACCOUNT_ID).first();
  if (!row) return { revision: 0, updatedAt: 0, state: emptyCloudState() };
  try {
    const state = JSON.parse(row.payload);
    if (!validCloudState(state)) throw new Error("invalid cloud state");
    return { revision: Number(row.revision), updatedAt: Number(row.updated_at), state };
  } catch (_) {
    throw new Error("云端交易数据格式异常");
  }
}

async function handleCloudSync(request, env) {
  if (!env.TRADING_DB) return jsonResponse({ error: "云端数据库尚未绑定" }, 503);
  try {
    await ensureCloudSchema(env.TRADING_DB);
    if (request.method === "GET") return jsonResponse(await readCloudSnapshot(env.TRADING_DB));
    if (request.method !== "PUT") return jsonResponse({ error: "仅支持GET和PUT请求" }, 405);

    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) return jsonResponse({ error: "跨站写入被拒绝" }, 403);
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SYNC_BODY_BYTES) {
      return jsonResponse({ error: "同步数据超过大小限制" }, 413);
    }
    const rawBody = await request.text();
    if (encoder.encode(rawBody).byteLength > MAX_SYNC_BODY_BYTES) return jsonResponse({ error: "同步数据超过大小限制" }, 413);
    let body;
    try { body = JSON.parse(rawBody); } catch (_) { return jsonResponse({ error: "JSON格式无效" }, 400); }
    const revision = Number(body?.revision);
    if (!Number.isSafeInteger(revision) || revision < 0 || !validCloudState(body?.state)) {
      return jsonResponse({ error: "同步数据格式无效" }, 400);
    }
    const payload = JSON.stringify(body.state);
    const updatedAt = Date.now();
    let result;
    if (revision === 0) {
      result = await env.TRADING_DB.prepare(
        "INSERT OR IGNORE INTO cloud_snapshots (account_id, revision, payload, updated_at) VALUES (?, 1, ?, ?)"
      ).bind(CLOUD_ACCOUNT_ID, payload, updatedAt).run();
    } else {
      result = await env.TRADING_DB.prepare(
        "UPDATE cloud_snapshots SET revision = revision + 1, payload = ?, updated_at = ? WHERE account_id = ? AND revision = ?"
      ).bind(payload, updatedAt, CLOUD_ACCOUNT_ID, revision).run();
    }
    if (!result.success || Number(result.meta?.changes) !== 1) {
      return jsonResponse({ error: "云端版本已更新", ...(await readCloudSnapshot(env.TRADING_DB)) }, 409);
    }
    return jsonResponse({ revision: revision + 1, updatedAt });
  } catch (error) {
    return jsonResponse({ error: error?.message || "云端同步暂不可用" }, 500);
  }
}

function validateBinanceRequest(url) {
  const endpoint = url.pathname.slice(BINANCE_API_PREFIX.length);
  if (!BINANCE_ENDPOINTS.has(endpoint)) return { error: "不支持的行情接口" };
  const symbol = url.searchParams.get("symbol");
  if (!BINANCE_SYMBOLS.has(symbol)) return { error: "不支持的交易标的" };
  if (endpoint === "/fapi/v1/klines") {
    const interval = url.searchParams.get("interval");
    if (!BINANCE_INTERVALS.has(interval)) return { error: "不支持的K线周期" };
    const limit = url.searchParams.get("limit");
    if (limit !== null && (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)))) {
      return { error: "limit参数无效" };
    }
    const requestedLimit = Number(limit || 320);
    url.searchParams.set("limit", String(Math.min(320, Math.max(1, requestedLimit))));
    for (const name of [...url.searchParams.keys()]) {
      if (!["symbol", "interval", "limit"].includes(name)) return { error: `${name}参数不受支持` };
    }
  } else {
    for (const name of [...url.searchParams.keys()]) {
      if (name !== "symbol") return { error: `${name}参数不受支持` };
    }
  }
  return { endpoint };
}

function binanceCacheTtl(endpoint, url) {
  if (endpoint === "/fapi/v1/klines") {
    return url.searchParams.has("startTime") && url.searchParams.has("endTime") ? 300 : 60;
  }
  if (endpoint === "/fapi/v1/ticker/24hr") return 30;
  return 2;
}

async function handleBinanceApi(request, executionContext) {
  if (request.method !== "GET") return binanceError("仅支持GET请求", 405);
  const incomingUrl = new URL(request.url);
  const validation = validateBinanceRequest(incomingUrl);
  if (validation.error) return binanceError(validation.error);

  const cacheTtl = binanceCacheTtl(validation.endpoint, incomingUrl);
  const cacheKey = new Request(`${incomingUrl.origin}/__binance_cache${validation.endpoint}?${incomingUrl.searchParams}`, {
    method: "GET"
  });
  const edgeCache = typeof caches !== "undefined" ? caches.default : null;
  const cached = edgeCache ? await edgeCache.match(cacheKey) : null;
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(securityHeaders()).forEach(([name, value]) => headers.set(name, value));
    headers.set("X-Market-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  let lastResponse = null;
  for (const host of BINANCE_API_HOSTS) {
    const upstreamUrl = new URL(validation.endpoint, host);
    upstreamUrl.search = incomingUrl.search;
    try {
      const response = await fetch(upstreamUrl, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      lastResponse = response;
      if (!response.ok && (response.status === 418 || response.status === 429 || response.status >= 500)) continue;
      if (!response.ok) break;

      const body = await response.arrayBuffer();
      const cacheHeaders = new Headers(response.headers);
      cacheHeaders.set("Cache-Control", `public, max-age=${cacheTtl}`);
      cacheHeaders.set("Content-Type", "application/json; charset=UTF-8");
      const cacheResponse = new Response(body.slice(0), { status: 200, headers: cacheHeaders });
      if (edgeCache) executionContext.waitUntil(edgeCache.put(cacheKey, cacheResponse));

      const clientHeaders = new Headers(cacheHeaders);
      Object.entries(securityHeaders()).forEach(([name, value]) => clientHeaders.set(name, value));
      clientHeaders.set("X-Market-Cache", "MISS");
      return new Response(body, { status: 200, headers: clientHeaders });
    } catch (_) {
      // Try the next official Binance Futures API host.
    }
  }

  if (lastResponse) {
    const body = await lastResponse.arrayBuffer();
    const headers = new Headers(lastResponse.headers);
    Object.entries(securityHeaders()).forEach(([name, value]) => headers.set(name, value));
    headers.set("Content-Type", "application/json; charset=UTF-8");
    headers.set("X-Market-Cache", "UPSTREAM-ERROR");
    return new Response(body, { status: lastResponse.status, headers });
  }
  return binanceError("Binance历史行情暂时不可用，请稍后自动重试", 503);
}

export default {
  async fetch(request, env, executionContext) {
    const password = typeof env.ACCESS_PASSWORD === "string" ? env.ACCESS_PASSWORD : "";
    if (password.length < MINIMUM_PASSWORD_LENGTH) return setupRequired();

    const username = typeof env.ACCESS_USERNAME === "string" && env.ACCESS_USERNAME.trim()
      ? env.ACCESS_USERNAME.trim()
      : DEFAULT_USERNAME;

    if (!(await isAuthorized(request, username, password))) return unauthorized();
    const pathname = new URL(request.url).pathname;
    if (pathname === CLOUD_SYNC_PATH) return handleCloudSync(request, env);
    if (pathname.startsWith(BINANCE_API_PREFIX)) {
      return handleBinanceApi(request, executionContext);
    }
    return protectAssetResponse(await env.ASSETS.fetch(request));
  }
};
