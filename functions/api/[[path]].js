const MAX_PAYLOAD_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_MAX_AGE = 8 * 60 * 60;
const SESSION_COOKIE = "sipsid_session";

const ROUTES = new Map([
  ["POST /api/auth/login", { action: "auth.login", body: true, mutation: true }],
  ["POST /api/auth/logout", { action: "auth.logout", body: true, mutation: true }],
  ["GET /api/bootstrap", { action: "bootstrap.get" }],
  ["GET /api/letters", { action: "letters.list" }],
  ["POST /api/letters", { action: "letters.create", body: true, mutation: true }],
]);

export function mapRoute(method, pathname) {
  const route = ROUTES.get(`${method.toUpperCase()} ${pathname}`);
  if (route) return { ...route, payload: null };

  if (method.toUpperCase() === "DELETE") {
    const match = pathname.match(/^\/api\/letters\/([^/]+)$/);
    if (match) {
      try {
        const id = decodeURIComponent(match[1]).trim();
        if (id) return { action: "letters.delete", mutation: true, payload: { id } };
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const item of String(header || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      cookies[name] = item.slice(separator + 1).trim();
    }
  }
  return cookies;
}

export function createSessionCookie(token, maxAge = DEFAULT_SESSION_MAX_AGE) {
  const safeMaxAge = Number.isFinite(Number(maxAge))
    ? Math.max(1, Math.min(Math.floor(Number(maxAge)), 7 * 24 * 60 * 60))
    : DEFAULT_SESSION_MAX_AGE;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${safeMaxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function validateConfig(env) {
  if (!env?.GAS_WEB_APP_URL || !env?.CLOUDFLARE_API_SECRET) return null;
  try {
    const url = new URL(env.GAS_WEB_APP_URL);
    if (url.protocol !== "https:") return null;
    return { gasUrl: url.toString(), apiSecret: String(env.CLOUDFLARE_API_SECRET) };
  } catch {
    return null;
  }
}

export function isAllowedOrigin(request, allowedOrigin) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  let expected;
  try {
    expected = allowedOrigin ? new URL(allowedOrigin).origin : new URL(request.url).origin;
  } catch {
    return false;
  }
  return origin === expected;
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorResponse(status, code, message) {
  return jsonResponse({ ok: false, data: null, error: { code, message } }, status);
}

async function readJsonPayload(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { error: errorResponse(415, "unsupported_media_type", "Content-Type harus application/json.") };
  }

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
    return { error: errorResponse(413, "payload_too_large", "Payload melebihi 64 KiB.") };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PAYLOAD_BYTES) {
    return { error: errorResponse(413, "payload_too_large", "Payload melebihi 64 KiB.") };
  }

  if (!text.trim()) return { payload: {} };
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return { payload };
  } catch {
    return { error: errorResponse(400, "invalid_json", "Payload JSON tidak valid.") };
  }
}

function sanitizeClientValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeClientValue);
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:apiSecret|secret|sessionToken|token|password|stack)$/i.test(key)) continue;
    sanitized[key] = sanitizeClientValue(item);
  }
  return sanitized;
}

export function normalizeGasResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, data: null, error: { code: "upstream_invalid_response", message: "Respons layanan tidak valid." } };
  }

  const failed = value.ok === false || (typeof value.status === "string" && value.status.toLowerCase() !== "success");
  if (failed) {
    const code = typeof value.error?.code === "string"
      ? value.error.code
      : typeof value.errorCode === "string"
        ? value.errorCode
        : "request_failed";
    const message = typeof value.error?.message === "string"
      ? value.error.message
      : typeof value.errorMsg === "string"
        ? value.errorMsg
        : typeof value.message === "string"
          ? value.message
          : "Permintaan gagal.";
    return { ok: false, data: null, error: { code, message } };
  }

  if (Object.hasOwn(value, "data")) return { ok: true, data: sanitizeClientValue(value.data), error: null };
  const data = { ...value };
  delete data.ok;
  delete data.status;
  delete data.error;
  delete data.errorMsg;
  return { ok: true, data: sanitizeClientValue(data), error: null };
}

function extractSession(upstream) {
  const candidates = [
    upstream.sessionToken,
    upstream.token,
    upstream.data?.sessionToken,
    upstream.data?.token,
  ];
  const token = candidates.find((value) => typeof value === "string" && value.length > 0);
  const maxAge = upstream.maxAge ?? upstream.expiresIn ?? upstream.data?.maxAge ?? upstream.data?.expiresIn;
  return { token, maxAge };
}

function upstreamStatus(normalized, responseStatus) {
  if (normalized.ok) return 200;
  if (responseStatus >= 400 && responseStatus < 500) return responseStatus;
  const code = normalized.error?.code;
  const normalizedCode = String(code || "").toLowerCase();
  if (normalizedCode === "unauthorized" || normalizedCode === "auth_required" || normalizedCode === "invalid_session" || normalizedCode === "session_expired") return 401;
  if (normalizedCode === "forbidden" || normalizedCode === "unauthorized_gateway") return 403;
  if (normalizedCode === "not_found") return 404;
  if (normalizedCode === "validation_error" || normalizedCode === "invalid_credentials" || normalizedCode === "bad_request") return 400;
  return 502;
}

export async function handleRequest(context, fetchImpl = fetch) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = mapRoute(request.method, url.pathname);
  if (!route) return errorResponse(404, "not_found", "Route tidak ditemukan.");

  const config = validateConfig(env);
  if (!config) return errorResponse(500, "server_misconfigured", "Konfigurasi layanan tidak tersedia.");

  if (route.mutation && !isAllowedOrigin(request, env.ALLOWED_ORIGIN)) {
    return errorResponse(403, "origin_forbidden", "Origin tidak diizinkan.");
  }

  let payload = route.payload || {};
  if (route.body) {
    const parsed = await readJsonPayload(request);
    if (parsed.error) return parsed.error;
    payload = parsed.payload;
  }

  const sessionToken = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE] || "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstreamResponse;
  try {
    upstreamResponse = await fetchImpl(config.gasUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: route.action,
        payload,
        sessionToken,
        apiSecret: config.apiSecret,
      }),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    return errorResponse(504, "upstream_unavailable", "Layanan tidak dapat dihubungi.");
  } finally {
    clearTimeout(timeout);
  }

  let upstream;
  try {
    upstream = await upstreamResponse.json();
  } catch {
    return errorResponse(502, "upstream_invalid_response", "Respons layanan tidak valid.");
  }

  const normalized = normalizeGasResponse(upstream);
  const headers = {};
  if (route.action === "auth.login" && normalized.ok) {
    const session = extractSession(upstream);
    if (!session.token) return errorResponse(502, "upstream_invalid_response", "Respons login tidak valid.");
    headers["Set-Cookie"] = createSessionCookie(session.token, session.maxAge);
    if (normalized.data && typeof normalized.data === "object") {
      normalized.data = { ...normalized.data };
      delete normalized.data.sessionToken;
      delete normalized.data.token;
      delete normalized.data.maxAge;
      delete normalized.data.expiresIn;
    }
  } else if (route.action === "auth.logout") {
    headers["Set-Cookie"] = clearSessionCookie();
  }

  return jsonResponse(normalized, upstreamStatus(normalized, upstreamResponse.status), headers);
}

export function onRequest(context) {
  return handleRequest(context);
}
