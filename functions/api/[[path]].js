// Gateway /api/* (Cloudflare Pages Functions).
//
// Routing, cookie sesi, validasi origin, batas payload, envelope `{ ok, data, error }`, dan pemetaan
// status HTTP dipertahankan dari gateway GAS. Sejak Fase 1 (MIGRATION_PLAN.md Bagian 3, 6) setiap
// action dijalankan in-process oleh `src/server/dispatch.js` terhadap binding D1 `env.DB`; tidak ada
// lagi fetch ke GAS, timeout upstream, retry, atau secret GAS.

import { BACKEND_VERSION, dispatch } from "../../src/server/dispatch.js";
import { DEVICE_TOKEN_MAX_AGE_SECONDS } from "../../src/server/auth.js";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_SESSION_MAX_AGE = 8 * 60 * 60;
const SESSION_COOKIE = "sipsid_session";
// Cookie perangkat untuk bucket throttle login (src/server/auth.js); hanya dikirim browser ke endpoint login.
const DEVICE_COOKIE = "sipsid_device";
const DEVICE_COOKIE_PATH = "/api/auth/login";
const GENERIC_ERROR_MESSAGE = "Layanan sedang mengalami kendala. Silakan coba kembali.";

const ROUTES = new Map([
  ["POST /api/auth/login", { action: "auth.login", body: true, mutation: true }],
  ["POST /api/auth/logout", { action: "auth.logout", body: true, mutation: true }],
  ["GET /api/auth/session", { action: "auth.session" }],
  ["GET /api/bootstrap", { action: "bootstrap.get" }],
  ["GET /api/letters", { action: "letters.list" }],
  ["POST /api/letters", { action: "letters.create", body: true, mutation: true }],
  ["GET /api/users", { action: "users.list" }],
  ["POST /api/users", { action: "users.create", body: true, mutation: true }],
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

  if (method.toUpperCase() === "PUT") {
    const match = pathname.match(/^\/api\/letters\/([^/]+)$/);
    if (match) {
      try {
        const id = decodeURIComponent(match[1]).trim();
        if (id) return { action: "letters.update", body: true, mutation: true, urlId: id };
      } catch {
        return null;
      }
    }
  }

  // User management dynamic routes — URL username wins over body.
  if (method.toUpperCase() === "PUT") {
    // PUT /api/users/:username/password
    const pwMatch = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
    if (pwMatch) {
      try {
        const username = decodeURIComponent(pwMatch[1]).trim();
        if (username) return { action: "users.resetPassword", body: true, mutation: true, urlUsername: username };
      } catch {
        return null;
      }
    }
    // PUT /api/users/:username
    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      try {
        const username = decodeURIComponent(userMatch[1]).trim();
        if (username) return { action: "users.update", body: true, mutation: true, urlUsername: username };
      } catch {
        return null;
      }
    }
  }

  if (method.toUpperCase() === "DELETE") {
    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      try {
        const username = decodeURIComponent(userMatch[1]).trim();
        if (username) return { action: "users.delete", mutation: true, payload: { username } };
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

export function createDeviceCookie(token) {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=${DEVICE_COOKIE_PATH}; Max-Age=${DEVICE_TOKEN_MAX_AGE_SECONDS}`;
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

/** `extraHeaders` boleh berisi array (mis. beberapa Set-Cookie); setiap nilai ditambahkan terpisah. */
function jsonResponse(value, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  for (const [name, values] of Object.entries(extraHeaders)) {
    for (const item of [].concat(values)) headers.append(name, item);
  }
  return new Response(JSON.stringify(value), { status, headers });
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
    // Strip known sensitive field names recursively at any depth, so a backend bug
    // that includes a stored password/hash/token can never leak it to the browser.
    if (/^(?:apiSecret|secret|sessionToken|deviceToken|token|password|passwordHash|password_hash|hash|stack)$/i.test(key)) continue;
    sanitized[key] = sanitizeClientValue(item);
  }
  return sanitized;
}

/**
 * Mengubah hasil berbentuk GAS dari `dispatch` menjadi envelope `{ ok, data, error }`.
 * `backendVersion` (BACKEND_VERSION) selalu ada di root envelope; `idempotent: true` diteruskan di root.
 */
export function normalizeResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      data: null,
      error: { code: "upstream_invalid_response", message: "Respons layanan tidak valid." },
      backendVersion: BACKEND_VERSION,
    };
  }

  // idempotent: true is set by letters.create when a requestId replay finds the existing row.
  // Pass it through the envelope so the client can distinguish first-create from replay.
  const idempotent = value.idempotent === true ? true : undefined;

  const failed = value.ok === false || (typeof value.status === "string" && value.status.toLowerCase() !== "success");
  if (failed) {
    const rawCode = typeof value.error?.code === "string"
      ? value.error.code
      : typeof value.errorCode === "string"
        ? value.errorCode
        : typeof value.status === "string" && value.status.toLowerCase() === "not_found"
          ? "not_found"
          : "request_failed";
    const code = rawCode.toLowerCase();
    const message = typeof value.error?.message === "string"
      ? value.error.message
      : typeof value.errorMsg === "string"
        ? value.errorMsg
        : typeof value.message === "string"
          ? value.message
          : "Permintaan gagal.";
    return { ok: false, data: null, error: { code, message }, backendVersion: BACKEND_VERSION };
  }

  if (Object.hasOwn(value, "data")) {
    const result = { ok: true, data: sanitizeClientValue(value.data), error: null, backendVersion: BACKEND_VERSION };
    if (idempotent !== undefined) result.idempotent = idempotent;
    return result;
  }
  const data = { ...value };
  delete data.ok;
  delete data.status;
  delete data.error;
  delete data.errorMsg;
  delete data.gasBackendVersion;
  delete data.backendVersion;
  delete data.idempotent;
  const result = { ok: true, data: sanitizeClientValue(data), error: null, backendVersion: BACKEND_VERSION };
  if (idempotent !== undefined) result.idempotent = idempotent;
  return result;
}

function extractSession(result) {
  const candidates = [
    result.sessionToken,
    result.token,
    result.data?.sessionToken,
    result.data?.token,
  ];
  const token = candidates.find((value) => typeof value === "string" && value.length > 0);
  const maxAge = result.maxAge ?? result.expiresIn ?? result.data?.maxAge ?? result.data?.expiresIn;
  return { token, maxAge };
}

/** Status HTTP untuk envelope hasil `normalizeResponse`. */
export function statusForEnvelope(normalized) {
  if (normalized.ok) return 200;
  const normalizedCode = String(normalized.error?.code || "").toLowerCase();
  if (normalizedCode === "unauthorized" || normalizedCode === "auth_required" || normalizedCode === "invalid_session" || normalizedCode === "session_expired") return 401;
  if (normalizedCode === "forbidden" || normalizedCode === "unauthorized_gateway") return 403;
  // Kept for contract compatibility; practically unused on D1 (MIGRATION_PLAN.md 6.2).
  if (normalizedCode === "data_write_denied" || normalizedCode === "write_forbidden") return 403;
  // Unknown action: only reachable if ROUTES and dispatch diverge. Same status as an unknown route.
  if (normalizedCode === "not_found" || normalizedCode === "action_not_found") return 404;
  if (normalizedCode === "duplicate_user" || normalizedCode === "version_conflict") return 409;
  if (normalizedCode === "validation_error" || normalizedCode === "invalid_credentials" || normalizedCode === "bad_request") return 400;
  if (normalizedCode === "last_admin_protected" || normalizedCode === "data_validation_error") return 422;
  if (normalizedCode === "too_many_attempts") return 429;
  // Transient D1 outage. Mutations are never retried: the outcome may be committed.
  if (normalizedCode === "busy" || normalizedCode === "data_service_unavailable") return 503;
  // Write freeze (MAINTENANCE_MODE): mutation rejected before any DB access.
  // Session stays valid, so the cookie is kept.
  if (normalizedCode === "maintenance") return 503;
  // data_write_failed, internal_error, config_error, and any unclassified failure.
  return 502;
}

/** Returns true when the error code indicates the session is no longer valid. */
function isSessionInvalidCode(code) {
  const c = String(code || "").toLowerCase();
  return c === "auth_required" || c === "session_expired" || c === "invalid_session";
}

export async function handleRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = mapRoute(request.method, url.pathname);
  if (!route) return errorResponse(404, "not_found", "Route tidak ditemukan.");

  const db = env?.DB;
  if (!db || typeof db.prepare !== "function") {
    return errorResponse(500, "server_misconfigured", "Konfigurasi layanan tidak tersedia.");
  }

  if (route.mutation && !isAllowedOrigin(request, env.ALLOWED_ORIGIN)) {
    return errorResponse(403, "origin_forbidden", "Origin tidak diizinkan.");
  }

  let payload = route.payload || {};
  if (route.body) {
    const parsed = await readJsonPayload(request);
    if (parsed.error) return parsed.error;
    payload = parsed.payload;
  }
  // For routes with a URL segment id (e.g. PUT /api/letters/:id), merge the URL
  // id into the payload and ensure it always wins over any id in the body.
  if (route.urlId) {
    payload = { ...payload, id: route.urlId };
  }
  // For user routes with a URL segment username, merge it and ensure URL wins.
  if (route.urlUsername) {
    payload = { ...payload, username: route.urlUsername };
  }

  const cookies = parseCookies(request.headers.get("Cookie"));
  const sessionToken = cookies[SESSION_COOKIE] || "";
  const deviceToken = route.action === "auth.login" ? cookies[DEVICE_COOKIE] || "" : "";

  let result;
  try {
    result = await dispatch(route.action, { db, env, payload, sessionToken, deviceToken });
  } catch {
    // dispatch never throws by contract; this is a last-resort guard without exception text.
    console.error("SIPSID API error", { action: route.action, code: "INTERNAL_ERROR" });
    return jsonResponse(
      { ok: false, data: null, error: { code: "internal_error", message: GENERIC_ERROR_MESSAGE }, backendVersion: BACKEND_VERSION },
      502,
    );
  }

  const normalized = normalizeResponse(result);
  const headers = {};
  if (route.action === "auth.login" && normalized.ok) {
    const session = extractSession(result);
    if (!session.token) return errorResponse(502, "upstream_invalid_response", "Respons login tidak valid.");
    headers["Set-Cookie"] = [createSessionCookie(session.token, session.maxAge)];
    if (typeof result.deviceToken === "string" && result.deviceToken) {
      headers["Set-Cookie"].push(createDeviceCookie(result.deviceToken));
    }
    if (normalized.data && typeof normalized.data === "object") {
      normalized.data = { ...normalized.data };
      delete normalized.data.sessionToken;
      delete normalized.data.deviceToken;
      delete normalized.data.token;
      delete normalized.data.maxAge;
      delete normalized.data.expiresIn;
    }
  } else if (route.action === "auth.logout") {
    headers["Set-Cookie"] = clearSessionCookie();
  } else if (!normalized.ok && isSessionInvalidCode(normalized.error?.code)) {
    // Clear the stale session cookie so the browser does not keep sending it.
    headers["Set-Cookie"] = clearSessionCookie();
  }

  return jsonResponse(normalized, statusForEnvelope(normalized), headers);
}

export function onRequest(context) {
  return handleRequest(context);
}
