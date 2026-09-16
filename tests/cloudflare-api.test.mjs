import test from "node:test";
import assert from "node:assert/strict";

import {
  clearSessionCookie,
  createSessionCookie,
  handleRequest,
  isAllowedOrigin,
  mapRoute,
  validateConfig,
} from "../functions/api/[[path]].js";

const env = {
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/example/exec",
  CLOUDFLARE_API_SECRET: "server-secret",
};

function request(path, init = {}) {
  return new Request(`https://app.example${path}`, init);
}

function gasResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("maps all supported browser routes to GAS actions", () => {
  assert.equal(mapRoute("POST", "/api/auth/login").action, "auth.login");
  assert.equal(mapRoute("POST", "/api/auth/logout").action, "auth.logout");
  assert.equal(mapRoute("GET", "/api/bootstrap").action, "bootstrap.get");
  assert.equal(mapRoute("GET", "/api/letters").action, "letters.list");
  assert.equal(mapRoute("POST", "/api/letters").action, "letters.create");
  assert.deepEqual(mapRoute("DELETE", "/api/letters/ABC%201").payload, { id: "ABC 1" });
  assert.equal(mapRoute("PUT", "/api/letters"), null);
});

test("creates and clears hardened session cookies", () => {
  assert.equal(
    createSessionCookie("a b", 3600),
    "sipsid_session=a%20b; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600",
  );
  assert.equal(
    clearSessionCookie(),
    "sipsid_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  );
});

test("requires complete HTTPS upstream configuration", () => {
  assert.equal(validateConfig({}), null);
  assert.equal(validateConfig({ GAS_WEB_APP_URL: "http://example.test", CLOUDFLARE_API_SECRET: "x" }), null);
  assert.deepEqual(validateConfig(env), {
    gasUrl: "https://script.google.com/macros/s/example/exec",
    apiSecret: "server-secret",
  });
});

test("validates mutation origin against request origin or ALLOWED_ORIGIN", () => {
  const sameOrigin = request("/api/letters", { headers: { Origin: "https://app.example" } });
  assert.equal(isAllowedOrigin(sameOrigin), true);
  assert.equal(isAllowedOrigin(sameOrigin, "https://app.example/some-path"), true);
  assert.equal(isAllowedOrigin(sameOrigin, "https://other.example"), false);
  assert.equal(isAllowedOrigin(request("/api/letters")), false);
});

test("proxies login envelope and keeps secret and token out of response", async () => {
  let captured;
  const mockFetch = async (url, init) => {
    captured = { url, init, envelope: JSON.parse(init.body) };
    return gasResponse({ status: "success", data: { sessionToken: "signed-token", user: { name: "Admin" } }, expiresIn: 1200 });
  };
  const response = await handleRequest({
    request: request("/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://app.example", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "password" }),
    }),
    env,
  }, mockFetch);

  assert.equal(response.status, 200);
  assert.equal(captured.url, env.GAS_WEB_APP_URL);
  assert.equal(captured.init.redirect, "follow");
  assert.deepEqual(captured.envelope, {
    action: "auth.login",
    payload: { username: "admin", password: "password" },
    sessionToken: "",
    apiSecret: env.CLOUDFLARE_API_SECRET,
  });
  assert.match(response.headers.get("Set-Cookie"), /^sipsid_session=signed-token;/);
  const text = await response.text();
  assert.equal(text.includes("server-secret"), false);
  assert.equal(text.includes("signed-token"), false);
  assert.deepEqual(JSON.parse(text), { ok: true, data: { user: { name: "Admin" } }, error: null });
});

test("forwards cookie session and route payload", async () => {
  let envelope;
  const response = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "DELETE",
      headers: { Origin: "https://app.example", Cookie: "other=x; sipsid_session=session%20token" },
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", id: "LETTER-1" });
  });

  assert.equal(response.status, 200);
  assert.deepEqual(envelope, {
    action: "letters.delete",
    payload: { id: "LETTER-1" },
    sessionToken: "session token",
    apiSecret: env.CLOUDFLARE_API_SECRET,
  });
});

test("rejects invalid origin before contacting GAS", async () => {
  let called = false;
  const response = await handleRequest({
    request: request("/api/letters", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
  }, async () => {
    called = true;
    return gasResponse({ status: "success" });
  });

  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("rejects non-JSON and payloads over 64 KiB", async () => {
  const mockFetch = async () => gasResponse({ status: "success" });
  const unsupported = await handleRequest({
    request: request("/api/letters", {
      method: "POST",
      headers: { Origin: "https://app.example", "Content-Type": "text/plain" },
      body: "{}",
    }),
    env,
  }, mockFetch);
  assert.equal(unsupported.status, 415);

  const oversized = await handleRequest({
    request: request("/api/letters", {
      method: "POST",
      headers: { Origin: "https://app.example", "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(64 * 1024) }),
    }),
    env,
  }, mockFetch);
  assert.equal(oversized.status, 413);
});

test("logout clears cookie", async () => {
  const response = await handleRequest({
    request: request("/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://app.example", "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
  }, async () => gasResponse({ status: "success" }));

  assert.equal(response.headers.get("Set-Cookie"), clearSessionCookie());
});
