const DEFAULT_USERNAME = "monitor";
const MINIMUM_PASSWORD_LENGTH = 12;
const AUTH_REALM = "muti-monitor";

const encoder = new TextEncoder();

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

export default {
  async fetch(request, env) {
    const password = typeof env.ACCESS_PASSWORD === "string" ? env.ACCESS_PASSWORD : "";
    if (password.length < MINIMUM_PASSWORD_LENGTH) return setupRequired();

    const username = typeof env.ACCESS_USERNAME === "string" && env.ACCESS_USERNAME.trim()
      ? env.ACCESS_USERNAME.trim()
      : DEFAULT_USERNAME;

    if (!(await isAuthorized(request, username, password))) return unauthorized();
    return protectAssetResponse(await env.ASSETS.fetch(request));
  }
};
