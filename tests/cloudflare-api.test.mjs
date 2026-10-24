// Kontrak gateway /api/* (functions/api/[[path]].js) dengan dispatch in-process ke D1.
// D1 = node:sqlite (tests/helpers/d1-sqlite.mjs) dengan data sintetis; tidak ada GAS.

import test from "node:test";
import assert from "node:assert/strict";

import {
  clearSessionCookie,
  createSessionCookie,
  handleRequest,
  isAllowedOrigin,
  mapRoute,
  normalizeResponse,
  parseCookies,
  statusForEnvelope,
} from "../functions/api/[[path]].js";
import {
  BACKEND_VERSION,
  ORIGIN,
  PASSWORD,
  apiRequest,
  callApi,
  findSensitiveKey,
  letterPayload,
  setupApi,
  tokenFor,
  untouchableDb,
} from "./helpers/api-fixture.mjs";

const NINE_HOURS_AGO = () => new Date(Date.now() - 9 * 60 * 60 * 1000);

async function createLetterVia(env, token, overrides = {}) {
  const res = await callApi(env, "/api/letters", { method: "POST", cookie: token, body: letterPayload(overrides) });
  assert.equal(res.status, 200, res.text);
  return res.body.data;
}

// ─── Routing ────────────────────────────────────────────────────────────────

test("maps all supported browser routes to actions", () => {
  assert.equal(mapRoute("POST", "/api/auth/login").action, "auth.login");
  assert.equal(mapRoute("POST", "/api/auth/logout").action, "auth.logout");
  assert.equal(mapRoute("GET", "/api/bootstrap").action, "bootstrap.get");
  assert.equal(mapRoute("GET", "/api/letters").action, "letters.list");
  assert.equal(mapRoute("POST", "/api/letters").action, "letters.create");
  assert.deepEqual(mapRoute("DELETE", "/api/letters/ABC%201").payload, { id: "ABC 1" });
  assert.equal(mapRoute("PUT", "/api/letters"), null);
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").action, "letters.update");
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").urlId, "LETTER-1");
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").mutation, true);
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").body, true);
  assert.equal(mapRoute("PUT", "/api/letters/KGB%202024%2F1").urlId, "KGB 2024/1");
  assert.equal(mapRoute("GET", "/api/system/manifest"), null, "system.manifest dihapus (K11)");
  assert.equal(mapRoute("DELETE", "/api/letters/%E0%A4%A"), null, "URL encoding rusak ditolak");
});

test("mapRoute memetakan semua rute users.* dengan benar", () => {
  assert.equal(mapRoute("GET", "/api/users").action, "users.list");

  const createRoute = mapRoute("POST", "/api/users");
  assert.equal(createRoute.action, "users.create");
  assert.equal(createRoute.mutation, true);
  assert.equal(createRoute.body, true);

  const updateRoute = mapRoute("PUT", "/api/users/someuser");
  assert.equal(updateRoute.action, "users.update");
  assert.equal(updateRoute.mutation, true);
  assert.equal(updateRoute.urlUsername, "someuser");

  const pwRoute = mapRoute("PUT", "/api/users/someuser/password");
  assert.equal(pwRoute.action, "users.resetPassword");
  assert.equal(pwRoute.mutation, true);
  assert.equal(pwRoute.urlUsername, "someuser");

  const deleteRoute = mapRoute("DELETE", "/api/users/someuser");
  assert.equal(deleteRoute.action, "users.delete");
  assert.equal(deleteRoute.mutation, true);
  assert.deepEqual(deleteRoute.payload, { username: "someuser" });

  assert.equal(mapRoute("PUT", "/api/users"), null);
  assert.equal(mapRoute("PUT", "/api/users/nama%20user").urlUsername, "nama user");
});

test("GET /api/auth/session dipetakan ke action auth.session", () => {
  const route = mapRoute("GET", "/api/auth/session");
  assert.ok(route !== null);
  assert.equal(route.action, "auth.session");
  assert.equal(route.mutation, undefined);
  assert.equal(route.body, undefined);
});

test("route tidak dikenal → 404 not_found tanpa menyentuh DB", async () => {
  const { db, calls } = untouchableDb();
  const response = await handleRequest({ request: apiRequest("/api/unknown"), env: { DB: db } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { ok: false, data: null, error: { code: "not_found", message: "Route tidak ditemukan." } });
  assert.deepEqual(calls, []);
});

// ─── Cookie, origin, konfigurasi ────────────────────────────────────────────

test("creates and clears hardened session cookies", () => {
  assert.equal(
    createSessionCookie("a b", 3600),
    "sipsid_session=a%20b; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600",
  );
  assert.equal(
    clearSessionCookie(),
    "sipsid_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  );
  assert.match(createSessionCookie("t", 10 ** 9), /Max-Age=604800$/, "Max-Age dibatasi 7 hari");
  assert.match(createSessionCookie("t", "x"), /Max-Age=28800$/, "Max-Age tidak valid → default 8 jam");
});

test("parseCookies membaca cookie ter-encode dan mengabaikan item rusak", () => {
  assert.deepEqual(parseCookies("other=x; sipsid_session=session%20token; broken"), {
    other: "x",
    sipsid_session: "session token",
  });
  assert.deepEqual(parseCookies(""), {});
});

test("validates mutation origin against request origin or ALLOWED_ORIGIN", () => {
  const sameOrigin = new Request(`${ORIGIN}/api/letters`, { headers: { Origin: ORIGIN } });
  assert.equal(isAllowedOrigin(sameOrigin), true);
  assert.equal(isAllowedOrigin(sameOrigin, `${ORIGIN}/some-path`), true);
  assert.equal(isAllowedOrigin(sameOrigin, "https://other.example"), false);
  assert.equal(isAllowedOrigin(new Request(`${ORIGIN}/api/letters`)), false);
});

test("binding DB tidak ada → 500 server_misconfigured tanpa stack", async () => {
  for (const env of [{}, { DB: null }, { DB: {} }, undefined]) {
    const response = await handleRequest({ request: apiRequest("/api/bootstrap"), env });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: false,
      data: null,
      error: { code: "server_misconfigured", message: "Konfigurasi layanan tidak tersedia." },
    });
  }
});

test("GAS env lama tidak lagi dibutuhkan; handleRequest mengabaikan argumen fetch tambahan", async () => {
  const { env, pengToken } = await setupApi();
  let fetchCalled = false;
  const response = await handleRequest(
    { request: apiRequest("/api/bootstrap", { cookie: pengToken }), env },
    async () => { fetchCalled = true; throw new Error("no fetch"); },
  );
  assert.equal(response.status, 200);
  assert.equal(fetchCalled, false);
});

test("rejects invalid origin before touching DB (semua mutasi termasuk login/logout)", async () => {
  const cases = [
    ["POST", "/api/auth/login", "{}"],
    ["POST", "/api/auth/logout", "{}"],
    ["POST", "/api/letters", "{}"],
    ["PUT", "/api/letters/LETTER-1", "{}"],
    ["DELETE", "/api/letters/LETTER-1", undefined],
    ["POST", "/api/users", "{}"],
    ["PUT", "/api/users/u1", "{}"],
    ["PUT", "/api/users/u1/password", "{}"],
    ["DELETE", "/api/users/u1", undefined],
  ];
  for (const [method, path, body] of cases) {
    for (const origin of ["https://evil.example", null]) {
      const { db, calls } = untouchableDb();
      const response = await handleRequest({ request: apiRequest(path, { method, body, origin }), env: { DB: db } });
      assert.equal(response.status, 403, `${method} ${path} origin=${origin}`);
      assert.equal((await response.json()).error.code, "origin_forbidden");
      assert.deepEqual(calls, [], "DB tidak boleh disentuh saat origin ditolak");
    }
  }
});

test("ALLOWED_ORIGIN membatasi origin mutasi", async () => {
  const { env } = await setupApi({ ALLOWED_ORIGIN: "https://sipsid-kgb.pages.dev" });
  const rejected = await callApi(env, "/api/auth/logout", { method: "POST", body: {} });
  assert.equal(rejected.status, 403);
  const accepted = await callApi(env, "/api/auth/logout", { method: "POST", body: {}, origin: "https://sipsid-kgb.pages.dev" });
  assert.equal(accepted.status, 200);
});

test("GET tidak memerlukan Origin header (bukan mutation)", async () => {
  const { env, pengToken } = await setupApi();
  const res = await callApi(env, "/api/auth/session", { cookie: pengToken });
  assert.equal(res.status, 200);
});

// ─── Payload ────────────────────────────────────────────────────────────────

test("rejects non-JSON, oversized, and invalid JSON payloads before touching DB", async () => {
  const { db, calls } = untouchableDb();
  const env = { DB: db };
  const run = (path, method, body, contentType) =>
    handleRequest({ request: apiRequest(path, { method, body, contentType }), env });

  assert.equal((await run("/api/letters", "POST", "{}", "text/plain")).status, 415);
  assert.equal((await run("/api/letters/LETTER-1", "PUT", "{}", "text/plain")).status, 415);
  const oversized = await run("/api/letters", "POST", { value: "x".repeat(64 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "payload_too_large");
  const declared = await handleRequest({
    request: new Request(`${ORIGIN}/api/letters`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "Content-Length": String(64 * 1024 + 1) },
      body: "{}",
    }),
    env,
  });
  assert.equal(declared.status, 413);
  for (const body of ["{bad", "[]", "null", "42"]) {
    const res = await run("/api/letters", "POST", body);
    assert.equal(res.status, 400, body);
    assert.equal((await res.json()).error.code, "invalid_json");
  }
  assert.deepEqual(calls, []);
});

test("body kosong pada route body diperlakukan sebagai {}", async () => {
  const { env } = await setupApi();
  const res = await callApi(env, "/api/auth/logout", { method: "POST", body: "" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {});
});

// ─── Login / logout / session ───────────────────────────────────────────────

test("cookie perangkat dari login sebelumnya melewati bucket akun yang dihabiskan orang lain", async () => {
  const { env } = await setupApi();
  const body = { username: "admin1", password: PASSWORD };
  const first = await callApi(env, "/api/auth/login", { method: "POST", body });
  const deviceCookie = first.setCookies[1].split(";")[0];
  assert.match(deviceCookie, /^sipsid_device=v1\./);

  for (let i = 0; i < 5; i += 1) {
    const wrong = await callApi(env, "/api/auth/login", { method: "POST", body: { username: "admin1", password: "salah" } });
    assert.equal(wrong.status, 400);
  }
  const attacker = await callApi(env, "/api/auth/login", { method: "POST", body });
  assert.equal(attacker.status, 400, "tanpa cookie perangkat, akun terkunci seperti sebelumnya");
  assert.equal(attacker.setCookie, null);

  const owner = await callApi(env, "/api/auth/login", { method: "POST", body, cookie: deviceCookie });
  assert.equal(owner.status, 200);
  assert.match(owner.setCookie, /^sipsid_session=/);
  assert.match(owner.setCookies[1], /^sipsid_device=v1\./, "token perangkat diperbarui setiap login berhasil");

  // Cookie perangkat hanya dibaca untuk login: endpoint lain tidak menganggapnya sesi.
  const session = await callApi(env, "/api/auth/session", { cookie: deviceCookie });
  assert.equal(session.status, 401);
});

test("login sets cookie and keeps token out of response", async () => {
  const { env, db } = await setupApi();
  const res = await callApi(env, "/api/auth/login", { method: "POST", body: { username: "admin1", password: PASSWORD } });
  assert.equal(res.status, 200);
  const match = /^sipsid_session=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/.exec(res.setCookie);
  assert.ok(match, res.setCookie);
  assert.equal(res.setCookies.length, 2);
  const device = /^sipsid_device=(v1\.1\.1\.\d+\.[A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=\/api\/auth\/login; Max-Age=15552000$/.exec(res.setCookies[1]);
  assert.ok(device, res.setCookies[1]);
  assert.equal(res.text.includes(match[1]), false, "token tidak boleh ada di body");
  assert.equal(res.text.includes(device[1]), false, "token perangkat tidak boleh ada di body");
  assert.equal(res.text.includes(PASSWORD), false);
  assert.deepEqual(res.body, {
    ok: true,
    data: { user: { username: "admin1", namaLengkap: "Admin Satu", hakAkses: "admin" } },
    error: null,
    backendVersion: BACKEND_VERSION,
  });
  // Cookie yang di-set benar-benar dapat dipakai.
  const session = await callApi(env, "/api/auth/session", { cookie: match[1] });
  assert.equal(session.status, 200);
  assert.equal(session.body.data.user.username, "admin1");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 3);
});

test("login gagal: password salah dan username tidak dikenal → 400 invalid_credentials identik, tanpa cookie", async () => {
  const { env } = await setupApi();
  const wrong = await callApi(env, "/api/auth/login", { method: "POST", body: { username: "admin1", password: "salah-salah" } });
  const unknown = await callApi(env, "/api/auth/login", { method: "POST", body: { username: "hantu", password: "salah-salah" } });
  for (const res of [wrong, unknown]) {
    assert.equal(res.status, 400);
    assert.equal(res.setCookie, null);
  }
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.error.code, "invalid_credentials");
});

test("logout clears cookie and revokes the session", async () => {
  const { env, adminToken } = await setupApi();
  const res = await callApi(env, "/api/auth/logout", { method: "POST", body: {}, cookie: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.setCookie, clearSessionCookie());
  assert.deepEqual(res.body, { ok: true, data: {}, error: null, backendVersion: BACKEND_VERSION });
  const after = await callApi(env, "/api/auth/session", { cookie: adminToken });
  assert.equal(after.status, 401);
});

test("GET /api/auth/session: sesi valid tanpa token di body dan tanpa Set-Cookie", async () => {
  const { env, adminToken } = await setupApi();
  const res = await callApi(env, "/api/auth/session", { cookie: `other=x; sipsid_session=${adminToken}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user.username, "admin1");
  assert.equal(res.text.includes("sessionToken"), false);
  assert.equal(res.text.includes(adminToken), false);
  assert.equal(res.setCookie, null);
});

test("GET /api/auth/session: tanpa cookie / token tidak dikenal → 401 auth_required, cookie dihapus", async () => {
  const { env } = await setupApi();
  for (const cookie of [undefined, "stale-token", "A".repeat(43)]) {
    const res = await callApi(env, "/api/auth/session", { cookie });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "auth_required");
    assert.match(res.body.error.message, /Sesi tidak valid/);
    assert.equal(res.setCookie, clearSessionCookie());
  }
});

test("session_expired → 401 dan cookie dihapus (session, letters, users)", async () => {
  const { env, db } = await setupApi();
  const expired = await tokenFor(db, 1, NINE_HOURS_AGO());
  for (const path of ["/api/auth/session", "/api/letters", "/api/users"]) {
    const res = await callApi(env, path, { cookie: expired });
    assert.equal(res.status, 401, path);
    assert.equal(res.body.error.code, "session_expired");
    assert.equal(res.setCookie, clearSessionCookie());
  }
});

test("sukses tidak menghapus session cookie", async () => {
  const { env, pengToken } = await setupApi();
  const res = await callApi(env, "/api/letters", { cookie: pengToken });
  assert.equal(res.status, 200);
  assert.equal(res.setCookie, null);
});

// ─── Letters ────────────────────────────────────────────────────────────────

test("POST /api/letters meneruskan requestId; replay → idempotent:true di envelope root", async () => {
  const { env, pengToken } = await setupApi();
  const requestId = "550e8400-e29b-41d4-a716-446655440001";
  const first = await callApi(env, "/api/letters", { method: "POST", cookie: pengToken, body: letterPayload({ requestId }) });
  assert.equal(first.status, 200);
  assert.match(first.body.data.id, new RegExp(`^KGB-\\d{4}-${requestId}$`));
  assert.equal(first.body.idempotent, undefined);
  const replay = await callApi(env, "/api/letters", { method: "POST", cookie: pengToken, body: letterPayload({ requestId }) });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.data.idempotent, undefined);
  assert.deepEqual(replay.body.data, first.body.data);
});

test("PUT /api/letters/:id: URL id menang atas body id", async () => {
  const { env, db, pengToken } = await setupApi();
  const real = await createLetterVia(env, pengToken);
  const other = await createLetterVia(env, pengToken, { nama: "Pegawai Lain" });
  const res = await callApi(env, `/api/letters/${encodeURIComponent(real.id)}`, {
    method: "PUT",
    cookie: pengToken,
    body: letterPayload({ id: other.id, nama: "Nama Baru" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, real.id);
  assert.equal(res.body.data.nama, "Nama Baru");
  const names = db.sqlite.prepare("SELECT id, nama FROM letters ORDER BY seq").all().map((r) => ({ ...r }));
  assert.deepEqual(names, [{ id: real.id, nama: "Nama Baru" }, { id: other.id, nama: "Pegawai Lain" }]);
});

test("PUT /api/letters/:id: tidak ditemukan → 404 not_found; validasi → 400; tanpa sesi → 401", async () => {
  const { env, pengToken } = await setupApi();
  const missing = await callApi(env, "/api/letters/MISSING-ID", { method: "PUT", cookie: pengToken, body: letterPayload() });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body.error, { code: "not_found", message: "Data surat tidak ditemukan." });
  assert.equal(missing.setCookie, null);

  const invalid = await callApi(env, "/api/letters/LETTER-1", { method: "PUT", cookie: pengToken, body: letterPayload({ nama: "" }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error, { code: "validation_error", message: "Field nama wajib diisi." });

  const noSession = await callApi(env, "/api/letters/LETTER-1", { method: "PUT", body: letterPayload() });
  assert.equal(noSession.status, 401);
  assert.equal(noSession.body.error.code, "auth_required");
  assert.equal(noSession.setCookie, clearSessionCookie());
});

test("DELETE /api/letters/:id: pengelola → 403 forbidden tanpa hapus cookie; admin → 200; ulang → 404", async () => {
  const { env, pengToken, adminToken } = await setupApi();
  const letter = await createLetterVia(env, pengToken);
  const path = `/api/letters/${encodeURIComponent(letter.id)}`;

  const forbidden = await callApi(env, path, { method: "DELETE", cookie: pengToken });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(forbidden.body.error, { code: "forbidden", message: "Hanya administrator yang dapat menghapus arsip." });
  assert.equal(forbidden.setCookie, null);

  const ok = await callApi(env, path, { method: "DELETE", cookie: `other=x; sipsid_session=${encodeURIComponent(adminToken)}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data, { id: letter.id });

  const again = await callApi(env, path, { method: "DELETE", cookie: adminToken });
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, "not_found");
});

// ─── Users ──────────────────────────────────────────────────────────────────

test("PUT /api/users/:username: URL username menang atas body username", async () => {
  const { env, db, adminToken } = await setupApi();
  const res = await callApi(env, "/api/users/peng1", {
    method: "PUT",
    cookie: adminToken,
    body: { username: "admin1", namaLengkap: "Nama Baru", hakAkses: "pengelola" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { username: "peng1", namaLengkap: "Nama Baru", hakAkses: "pengelola" });
  assert.equal(db.sqlite.prepare("SELECT nama_lengkap FROM users WHERE id = 1").get().nama_lengkap, "Admin Satu");
});

test("PUT /api/users/:username/password: URL username menang atas body username", async () => {
  const { env, adminToken } = await setupApi();
  const res = await callApi(env, "/api/users/peng1/password", {
    method: "PUT",
    cookie: adminToken,
    body: { username: "admin1", newPassword: "password-baru-1" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { username: "peng1" });
  // Admin masih dapat login dengan password lama; peng1 dengan password baru.
  const adminLogin = await callApi(env, "/api/auth/login", { method: "POST", body: { username: "admin1", password: PASSWORD } });
  assert.equal(adminLogin.status, 200);
  const pengLogin = await callApi(env, "/api/auth/login", { method: "POST", body: { username: "peng1", password: "password-baru-1" } });
  assert.equal(pengLogin.status, 200);
});

test("DELETE /api/users/:username meneruskan username; tidak ditemukan → 404", async () => {
  const { env, adminToken } = await setupApi();
  const ok = await callApi(env, "/api/users/peng1", { method: "DELETE", cookie: adminToken });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data, { username: "peng1" });
  const ghost = await callApi(env, "/api/users/ghost", { method: "DELETE", cookie: adminToken });
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.body.error, { code: "not_found", message: "Pengguna 'ghost' tidak ditemukan." });
});

test("DUPLICATE_USER → 409; LAST_ADMIN_PROTECTED → 422", async () => {
  const { env, adminToken } = await setupApi();
  const dup = await callApi(env, "/api/users", {
    method: "POST",
    cookie: adminToken,
    body: { username: "PENG1", password: "password123", namaLengkap: "X", hakAkses: "pengelola" },
  });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body.error, { code: "duplicate_user", message: "Username 'PENG1' sudah terdaftar." });

  const demote = await callApi(env, "/api/users/admin1", {
    method: "PUT",
    cookie: adminToken,
    body: { namaLengkap: "Admin", hakAkses: "pengelola" },
  });
  assert.equal(demote.status, 422);
  assert.equal(demote.body.error.code, "last_admin_protected");
  assert.equal(demote.setCookie, null);
});

test("users.* oleh pengelola → 403 forbidden tanpa menghapus cookie", async () => {
  const { env, pengToken } = await setupApi();
  const res = await callApi(env, "/api/users", { cookie: pengToken });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body.error, { code: "forbidden", message: "Hanya administrator yang dapat mengelola pengguna." });
  assert.equal(res.setCookie, null);
});

test("users.list: tidak ada password/hash/token di response", async () => {
  const { env, adminToken } = await setupApi();
  const res = await callApi(env, "/api/users", { cookie: adminToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [
    { username: "admin1", namaLengkap: "Admin Satu", hakAkses: "admin" },
    { username: "peng1", namaLengkap: "Pengelola Satu", hakAkses: "pengelola" },
  ]);
  assert.equal(findSensitiveKey(res.body), null);
  assert.equal(/sha256\$/.test(res.text), false);
});

// ─── D1 failure mapping (stub DB yang melempar error berbentuk D1) ──────────

function failingDb(message) {
  const fail = () => { throw new Error(message, { cause: new Error(message.replace(/^D1_ERROR: /, "")) }); };
  return { prepare: fail, batch: fail };
}

test("error D1 sementara → 503 data_service_unavailable; lainnya → 502 data_write_failed; tanpa teks D1", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const cases = [
      ["D1_ERROR: Network connection lost.", 503, "data_service_unavailable"],
      ["D1 DB is overloaded. Too many requests queued.", 503, "data_service_unavailable"],
      ["D1_ERROR: no such table: salary_grades: SQLITE_ERROR", 502, "data_write_failed"],
    ];
    // Token berbentuk sesi agar query sesi (query pertama bootstrap) benar-benar menyentuh D1 yang gagal.
    const cookie = "A".repeat(43);
    for (const [message, status, code] of cases) {
      const response = await handleRequest({ request: apiRequest("/api/bootstrap", { cookie }), env: { DB: failingDb(message) } });
      const text = await response.text();
      assert.equal(response.status, status, message);
      assert.equal(JSON.parse(text).error.code, code);
      assert.equal(text.includes("D1"), false);
      assert.equal(text.includes("SQLITE"), false);
      assert.equal(text.includes("salary_grades"), false);
      assert.equal(response.headers.get("Set-Cookie"), null);
    }
    assert.ok(errors.length >= 3);
    for (const args of errors) assert.equal(JSON.stringify(args).includes("D1_ERROR"), false);
  } finally {
    console.error = original;
  }
});

// ─── normalizeResponse / status mapping (unit) ──────────────────────────────

test("alias transisi normalizeGasResponse sudah dihapus (Fase 6)", async () => {
  const gateway = await import("../functions/api/[[path]].js");
  assert.equal("normalizeGasResponse" in gateway, false);
});

test("normalizeResponse: backendVersion di root envelope, tidak di data; gasBackendVersion tidak dipancarkan", () => {
  const success = normalizeResponse({ status: "success", data: { id: "KGB-001" }, gasBackendVersion: "2.5.4" });
  assert.deepEqual(success, { ok: true, data: { id: "KGB-001" }, error: null, backendVersion: BACKEND_VERSION });

  const rootData = normalizeResponse({ status: "success", backendVersion: "x", gasBackendVersion: "y", otherField: "bukan-secret" });
  assert.deepEqual(rootData, { ok: true, data: { otherField: "bukan-secret" }, error: null, backendVersion: BACKEND_VERSION });

  const error = normalizeResponse({ status: "error", errorCode: "ACTION_NOT_FOUND", errorMsg: "Aksi API tidak dikenal: x.y." });
  assert.deepEqual(error, {
    ok: false,
    data: null,
    error: { code: "action_not_found", message: "Aksi API tidak dikenal: x.y." },
    backendVersion: BACKEND_VERSION,
  });
});

test("normalizeResponse: idempotent hanya true yang diteruskan, di root envelope", () => {
  const replay = normalizeResponse({ status: "success", idempotent: true, data: { id: "KGB-2026-req-001" } });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.data.idempotent, undefined);
  assert.equal(normalizeResponse({ status: "success", data: { id: "x" } }).idempotent, undefined);
  assert.equal(normalizeResponse({ status: "success", idempotent: false, data: { id: "x" } }).idempotent, undefined);
  assert.equal(normalizeResponse({ status: "success", idempotent: "true", data: { id: "x" } }).idempotent, undefined);
});

test("normalizeResponse: not_found tanpa errorCode, dan input tidak valid", () => {
  assert.deepEqual(normalizeResponse({ status: "not_found", errorMsg: "Data surat tidak ditemukan." }).error, {
    code: "not_found",
    message: "Data surat tidak ditemukan.",
  });
  for (const value of [null, "x", [], 1]) {
    const result = normalizeResponse(value);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "upstream_invalid_response");
  }
});

test("normalizeResponse: password/hash/token distrip rekursif dari data", () => {
  const result = normalizeResponse({
    status: "success",
    data: [
      {
        username: "admin",
        hakAkses: "admin",
        password: "X",
        password_hash: "X",
        passwordHash: "X",
        hash: "X",
        token: "X",
        sessionToken: "X",
        nested: { password: "X", deep: { secret: "X", stack: "X", apiSecret: "X", keep: 1 } },
      },
    ],
  });
  assert.equal(findSensitiveKey(result), null);
  assert.deepEqual(result.data, [{ username: "admin", hakAkses: "admin", nested: { deep: { keep: 1 } } }]);
});

test("statusForEnvelope memetakan setiap kode ke status HTTP", () => {
  const expected = {
    auth_required: 401,
    session_expired: 401,
    invalid_session: 401,
    unauthorized: 401,
    forbidden: 403,
    unauthorized_gateway: 403,
    data_write_denied: 403,
    write_forbidden: 403,
    not_found: 404,
    action_not_found: 404,
    duplicate_user: 409,
    version_conflict: 409,
    validation_error: 400,
    invalid_credentials: 400,
    bad_request: 400,
    last_admin_protected: 422,
    data_validation_error: 422,
    too_many_attempts: 429,
    busy: 503,
    data_service_unavailable: 503,
    maintenance: 503,
    data_write_failed: 502,
    internal_error: 502,
    config_error: 502,
    request_failed: 502,
  };
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(statusForEnvelope({ ok: false, error: { code } }), status, code);
  }
  assert.equal(statusForEnvelope({ ok: true }), 200);
});

test("seluruh respons /api memakai Cache-Control: no-store", async () => {
  const { env, adminToken } = await setupApi();
  const cases = [
    ["/api/bootstrap", {}],
    ["/api/letters", { cookie: adminToken }],
    ["/api/letters", {}],
    ["/api/nope", {}],
    ["/api/letters", { method: "POST", body: "{}", contentType: "text/plain" }],
  ];
  for (const [path, options] of cases) {
    const res = await callApi(env, path, options);
    assert.equal(res.cacheControl, "no-store", path);
  }
});
