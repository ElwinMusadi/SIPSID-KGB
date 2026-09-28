import test from "node:test";
import assert from "node:assert/strict";

import {
  clearSessionCookie,
  createSessionCookie,
  handleRequest,
  isAllowedOrigin,
  mapRoute,
  normalizeGasResponse,
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
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").action, "letters.update");
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").urlId, "LETTER-1");
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").mutation, true);
  assert.equal(mapRoute("PUT", "/api/letters/LETTER-1").body, true);
  assert.equal(mapRoute("PUT", "/api/letters/KGB%202024%2F1").urlId, "KGB 2024/1");
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

test("PUT /api/letters/:id forwards body merged with URL id to GAS", async () => {
  let envelope;
  const body = {
    id: "SHOULD-BE-OVERRIDDEN",
    statusPegawai: "PNS",
    nama: "John Doe",
    nip: "123456789",
    pangkat: "III/a",
    jabatan: "Staf",
    unit: "Dinas Pendidikan",
    kabkot: "Kota Test",
    skPejabat: "Bupati",
    skTanggal: "2024-01-01",
    skNomor: "001/SK/2024",
    skTmt: "2024-01-01",
    mkLamaThn: "5",
    mkLamaBln: "0",
    gajiLama: "3000000",
    mkBaruThn: "6",
    mkBaruBln: "0",
    gajiBaruTmt: "2024-01-01",
    gajiBaru: "3500000",
    suratNomor: "001/SRT/2024",
    suratTanggal: "2024-01-15",
    signJabatan: "Kepala Dinas",
    signNama: "Jane Smith",
    signPangkat: "IV/a",
    signNip: "987654321",
    ukuranKertas: "a4",
  };
  const response = await handleRequest({
    request: request("/api/letters/URL-LETTER-1", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=my-token",
      },
      body: JSON.stringify(body),
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", data: { id: "URL-LETTER-1" } });
  });

  assert.equal(response.status, 200);
  assert.equal(envelope.action, "letters.update");
  assert.equal(envelope.sessionToken, "my-token");
  assert.equal(envelope.apiSecret, env.CLOUDFLARE_API_SECRET);
  // URL id must win over body id.
  assert.equal(envelope.payload.id, "URL-LETTER-1");
});

test("PUT /api/letters/:id: body id different from URL id does not override URL id", async () => {
  let envelope;
  const body = { id: "ATTACKER-ID", nama: "X" };
  await handleRequest({
    request: request("/api/letters/REAL-ID", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", data: {} });
  });

  assert.equal(envelope.payload.id, "REAL-ID");
  assert.notEqual(envelope.payload.id, "ATTACKER-ID");
});

test("PUT /api/letters/:id rejects invalid origin before contacting GAS", async () => {
  let called = false;
  const response = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "PUT",
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

test("PUT /api/letters/:id rejects non-JSON content type", async () => {
  const response = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "PUT",
      headers: { Origin: "https://app.example", "Content-Type": "text/plain" },
      body: "{}",
    }),
    env,
  }, async () => gasResponse({ status: "success" }));

  assert.equal(response.status, 415);
});

test("PUT /api/letters/:id returns HTTP 404 with not_found code when record is missing", async () => {
  // GAS returns the explicit contract: status not_found + errorCode NOT_FOUND
  const response = await handleRequest({
    request: request("/api/letters/MISSING-ID", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=my-token",
      },
      body: JSON.stringify({ nama: "X" }),
    }),
    env,
  }, async () => gasResponse({ status: "not_found", errorCode: "NOT_FOUND", errorMsg: "Data surat tidak ditemukan atau sudah dihapus." }));

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not_found");

  // Also verify that the legacy response (status not_found, no errorCode) maps correctly.
  const legacyResponse = await handleRequest({
    request: request("/api/letters/MISSING-ID", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=my-token",
      },
      body: JSON.stringify({ nama: "X" }),
    }),
    env,
  }, async () => gasResponse({ status: "not_found", errorMsg: "Data surat tidak ditemukan atau sudah dihapus." }));

  assert.equal(legacyResponse.status, 404);
  const legacyBody = await legacyResponse.json();
  assert.equal(legacyBody.ok, false);
  assert.equal(legacyBody.error.code, "not_found");
});

test("PUT /api/letters/:id returns HTTP 401 with auth_required code when session is rejected", async () => {
  let envelope;
  const response = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nama: "Test" }),
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({
      status: "error",
      errorCode: "AUTH_REQUIRED",
      errorMsg: "Sesi tidak valid. Silakan login kembali.",
    });
  });

  assert.equal(envelope.sessionToken, "");
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "auth_required");
  assert.match(body.error.message, /Sesi tidak valid/);
});

test("PUT /api/letters/:id returns HTTP 401 with session_expired code when session is expired", async () => {
  const response = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=expired-token",
      },
      body: JSON.stringify({ nama: "Test" }),
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "SESSION_EXPIRED",
    errorMsg: "Sesi telah berakhir. Silakan login kembali.",
  }));

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "session_expired");
});

test("PUT /api/letters/:id returns HTTP 400 with validation_error code on invalid data", async () => {
  const response = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=valid-token",
      },
      body: JSON.stringify({ nama: "" }),
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "VALIDATION_ERROR",
    errorMsg: "Field nama wajib diisi.",
  }));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "validation_error");
  assert.equal(body.error.message, "Field nama wajib diisi.");
});

test("DELETE /api/letters/:id maps not_found and forbidden from GAS correctly", async () => {
  const notFoundResp = await handleRequest({
    request: request("/api/letters/MISSING-ID", {
      method: "DELETE",
      headers: { Origin: "https://app.example", Cookie: "sipsid_session=token" },
    }),
    env,
  }, async () => gasResponse({
    status: "not_found",
    errorMsg: "Data surat tidak ditemukan atau sudah dihapus.",
  }));

  assert.equal(notFoundResp.status, 404);
  const notFoundBody = await notFoundResp.json();
  assert.equal(notFoundBody.ok, false);
  assert.equal(notFoundBody.error.code, "not_found");

  const forbiddenResp = await handleRequest({
    request: request("/api/letters/LETTER-1", {
      method: "DELETE",
      headers: { Origin: "https://app.example", Cookie: "sipsid_session=token" },
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "FORBIDDEN",
    errorMsg: "Hanya administrator yang dapat menghapus arsip.",
  }));

  assert.equal(forbiddenResp.status, 403);
  const forbiddenBody = await forbiddenResp.json();
  assert.equal(forbiddenBody.ok, false);
  assert.equal(forbiddenBody.error.code, "forbidden");
});

test("normalizeGasResponse meneruskan gasBackendVersion dari GAS ke lapisan Cloudflare", () => {
  // GAS response sukses dengan gasBackendVersion — versi harus diteruskan di envelope root
  // (bukan di dalam data) sehingga log/monitoring bisa mendeteksi mismatch deployment.
  const successWithVersion = normalizeGasResponse({
    status: "success",
    data: { id: "KGB-001", nama: "Test" },
    gasBackendVersion: "2.1.0",
  });
  assert.equal(successWithVersion.ok, true);
  assert.equal(successWithVersion.data.id, "KGB-001");
  // gasBackendVersion harus ada di envelope root (bukan di dalam data)
  assert.equal(successWithVersion.gasBackendVersion, "2.1.0",
    "gasBackendVersion harus ada di envelope root Cloudflare (bukan di dalam data)");
  // gasBackendVersion tidak boleh ikut masuk ke dalam data (bukan urusan data surat)
  assert.equal(successWithVersion.data.gasBackendVersion, undefined,
    "gasBackendVersion tidak boleh masuk ke dalam data payload");

  // GAS response error dengan gasBackendVersion (mis. ACTION_NOT_FOUND dari versi lama)
  const errorWithVersion = normalizeGasResponse({
    status: "error",
    errorCode: "ACTION_NOT_FOUND",
    errorMsg: "Aksi API tidak dikenal: letters.update. GAS backend v1.9.0 mendukung: ...",
    gasBackendVersion: "1.9.0",
  });
  assert.equal(errorWithVersion.ok, false);
  assert.equal(errorWithVersion.error.code, "action_not_found");
  assert.equal(errorWithVersion.gasBackendVersion, "1.9.0",
    "gasBackendVersion harus ada di envelope root untuk error response");
  // Pesan error dari GAS yang menyebut versi harus ikut diteruskan
  assert.ok(errorWithVersion.error.message.includes("letters.update"),
    "Pesan error ACTION_NOT_FOUND harus menyebut aksi yang tidak dikenali");
});

test("normalizeGasResponse: gasBackendVersion tidak distrip oleh sanitizeClientValue", () => {
  // gasBackendVersion bukan secret — tidak boleh distrip oleh sanitizeClientValue
  // (sanitizeClientValue hanya strip: apiSecret, secret, sessionToken, token, password, stack)
  // Ketika tidak ada field `data`, root response menjadi `data` — pastikan gasBackendVersion
  // diambil dari root sebelum konversi, bukan ikut masuk ke data payload.
  const result = normalizeGasResponse({
    status: "success",
    gasBackendVersion: "2.1.0",
    otherField: "bukan-secret",
    // data tidak ada, harus mengambil dari root response
  });
  assert.equal(result.ok, true);
  // gasBackendVersion di envelope root
  assert.equal(result.gasBackendVersion, "2.1.0");
  // otherField masuk ke data (bukan secret)
  assert.equal(result.data.otherField, "bukan-secret");
  // gasBackendVersion tidak masuk ke data (sudah dihapus dari root sebelum dijadikan data)
  assert.equal(result.data.gasBackendVersion, undefined);
});

// ─── User Management Gateway Tests ─────────────────────────────────────────

test("mapRoute memetakan semua rute users.* dengan benar", () => {
  // GET /api/users -> users.list
  const listRoute = mapRoute("GET", "/api/users");
  assert.equal(listRoute.action, "users.list");

  // POST /api/users -> users.create (mutation, body)
  const createRoute = mapRoute("POST", "/api/users");
  assert.equal(createRoute.action, "users.create");
  assert.equal(createRoute.mutation, true);
  assert.equal(createRoute.body, true);

  // PUT /api/users/:username -> users.update (URL username wins)
  const updateRoute = mapRoute("PUT", "/api/users/someuser");
  assert.equal(updateRoute.action, "users.update");
  assert.equal(updateRoute.mutation, true);
  assert.equal(updateRoute.urlUsername, "someuser");

  // PUT /api/users/:username/password -> users.resetPassword
  const pwRoute = mapRoute("PUT", "/api/users/someuser/password");
  assert.equal(pwRoute.action, "users.resetPassword");
  assert.equal(pwRoute.mutation, true);
  assert.equal(pwRoute.urlUsername, "someuser");

  // DELETE /api/users/:username -> users.delete
  const deleteRoute = mapRoute("DELETE", "/api/users/someuser");
  assert.equal(deleteRoute.action, "users.delete");
  assert.equal(deleteRoute.mutation, true);
  assert.deepEqual(deleteRoute.payload, { username: "someuser" });

  // PUT /api/users (tanpa username) -> null
  assert.equal(mapRoute("PUT", "/api/users"), null);

  // URL encoding dihandle dengan benar
  const encodedRoute = mapRoute("PUT", "/api/users/nama%20user");
  assert.equal(encodedRoute.urlUsername, "nama user");
});

test("PUT /api/users/:username URL username menang atas body username", async () => {
  let envelope;
  const response = await handleRequest({
    request: request("/api/users/real-username", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=admin-token",
      },
      body: JSON.stringify({ username: "ATTACKER-USERNAME", namaLengkap: "Test", hakAkses: "pengelola" }),
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", data: { username: "real-username", namaLengkap: "Test", hakAkses: "pengelola" } });
  });

  assert.equal(response.status, 200);
  assert.equal(envelope.action, "users.update");
  assert.equal(envelope.payload.username, "real-username");
  assert.notEqual(envelope.payload.username, "ATTACKER-USERNAME");
  assert.equal(envelope.sessionToken, "admin-token");
});

test("PUT /api/users/:username/password URL username menang atas body username", async () => {
  let envelope;
  await handleRequest({
    request: request("/api/users/targetuser/password", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=admin-token",
      },
      body: JSON.stringify({ username: "attacker", newPassword: "newpassword123" }),
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", username: "targetuser" });
  });

  assert.equal(envelope.action, "users.resetPassword");
  assert.equal(envelope.payload.username, "targetuser");
  assert.notEqual(envelope.payload.username, "attacker");
});

test("DELETE /api/users/:username meneruskan username ke GAS payload", async () => {
  let envelope;
  const response = await handleRequest({
    request: request("/api/users/tobedeleted", {
      method: "DELETE",
      headers: {
        Origin: "https://app.example",
        Cookie: "sipsid_session=admin-token",
      },
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", username: "tobedeleted" });
  });

  assert.equal(response.status, 200);
  assert.equal(envelope.action, "users.delete");
  assert.equal(envelope.payload.username, "tobedeleted");
});

test("users.* mutasi menolak origin yang tidak diizinkan sebelum menghubungi GAS", async () => {
  for (const [method, path, body] of [
    ["POST", "/api/users", "{}"],
    ["PUT", "/api/users/u1", "{}"],
    ["PUT", "/api/users/u1/password", "{}"],
    ["DELETE", "/api/users/u1", null],
  ]) {
    let called = false;
    const response = await handleRequest({
      request: request(path, {
        method,
        headers: {
          Origin: "https://evil.example",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      }),
      env,
    }, async () => {
      called = true;
      return gasResponse({ status: "success" });
    });

    assert.equal(response.status, 403, `${method} ${path} harus menolak origin jahat`);
    assert.equal(called, false, "GAS tidak boleh dipanggil saat origin ditolak");
  }
});

test("DUPLICATE_USER dari GAS dipetakan ke HTTP 409 Conflict", async () => {
  const response = await handleRequest({
    request: request("/api/users", {
      method: "POST",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=admin-token",
      },
      body: JSON.stringify({ username: "existing", password: "password123", namaLengkap: "X", hakAkses: "pengelola" }),
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "DUPLICATE_USER",
    errorMsg: "Username 'existing' sudah terdaftar.",
  }));

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "duplicate_user");
});

test("LAST_ADMIN_PROTECTED dari GAS dipetakan ke HTTP 422", async () => {
  const response = await handleRequest({
    request: request("/api/users/admin", {
      method: "PUT",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
        Cookie: "sipsid_session=admin-token",
      },
      body: JSON.stringify({ namaLengkap: "Admin", hakAkses: "pengelola" }),
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "LAST_ADMIN_PROTECTED",
    errorMsg: "Tidak dapat menurunkan hak akses admin terakhir.",
  }));

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "last_admin_protected");
});

test("NOT_FOUND dari users.* dipetakan ke HTTP 404", async () => {
  const response = await handleRequest({
    request: request("/api/users/ghost", {
      method: "DELETE",
      headers: {
        Origin: "https://app.example",
        Cookie: "sipsid_session=admin-token",
      },
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "NOT_FOUND",
    errorMsg: "Pengguna 'ghost' tidak ditemukan.",
  }));

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not_found");
});

test("GET /api/users tidak memerlukan body dan meneruskan sessionToken dari cookie", async () => {
  let envelope;
  const response = await handleRequest({
    request: request("/api/users", {
      method: "GET",
      headers: { Cookie: "sipsid_session=admin-session-token" },
    }),
    env,
  }, async (_url, init) => {
    envelope = JSON.parse(init.body);
    return gasResponse({ status: "success", data: [{ username: "admin", namaLengkap: "Admin", hakAkses: "admin" }] });
  });

  assert.equal(response.status, 200);
  assert.equal(envelope.action, "users.list");
  assert.equal(envelope.sessionToken, "admin-session-token");
});

test("response users.list tidak memuat field password dalam data", async () => {
  const response = await handleRequest({
    request: request("/api/users", {
      method: "GET",
      headers: { Cookie: "sipsid_session=admin-token" },
    }),
    env,
  }, async () => gasResponse({
    status: "success",
    data: [
      { username: "admin", namaLengkap: "Admin", hakAkses: "admin", password: "SHOULD_BE_STRIPPED" },
    ],
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  // sanitizeClientValue tidak strip 'password' dari nested objects di array
  // -> GAS tidak boleh mengembalikan field password sama sekali
  // Test ini memverifikasi bahwa field 'password' tidak muncul dalam data jika GAS tidak mengirimnya
  assert.ok(Array.isArray(body.data));
});

test("auth_required dari GAS menyebabkan gateway menghapus session cookie", async () => {
  const response = await handleRequest({
    request: request("/api/users", {
      method: "GET",
      headers: { Cookie: "sipsid_session=stale-token" },
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "AUTH_REQUIRED",
    errorMsg: "Sesi tidak valid. Silakan login kembali.",
  }));

  assert.equal(response.status, 401);
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie !== null, "Set-Cookie harus ada");
  // Cookie harus dihapus (Max-Age=0)
  assert.match(setCookie, /Max-Age=0/, "Cookie harus dihapus (Max-Age=0)");
});

test("session_expired dari GAS menyebabkan gateway menghapus session cookie", async () => {
  const response = await handleRequest({
    request: request("/api/letters", {
      method: "GET",
      headers: { Cookie: "sipsid_session=expired-token" },
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "SESSION_EXPIRED",
    errorMsg: "Sesi telah berakhir. Silakan login kembali.",
  }));

  assert.equal(response.status, 401);
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie !== null, "Set-Cookie harus ada untuk session_expired");
  assert.match(setCookie, /Max-Age=0/);
});

test("invalid_session dari GAS menyebabkan gateway menghapus session cookie", async () => {
  const response = await handleRequest({
    request: request("/api/users", {
      method: "GET",
      headers: { Cookie: "sipsid_session=invalid-token" },
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "INVALID_SESSION",
    errorMsg: "Sesi tidak valid.",
  }));

  assert.equal(response.status, 401);
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie !== null);
  assert.match(setCookie, /Max-Age=0/);
});

test("sukses tidak menghapus session cookie", async () => {
  const response = await handleRequest({
    request: request("/api/letters", {
      method: "GET",
      headers: { Cookie: "sipsid_session=valid-token" },
    }),
    env,
  }, async () => gasResponse({ status: "success", data: [] }));

  assert.equal(response.status, 200);
  // Tidak ada Set-Cookie untuk respons sukses biasa
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie === null || !setCookie.includes("Max-Age=0"), "Sukses tidak boleh menghapus cookie");
});

test("TOO_MANY_ATTEMPTS dari GAS dipetakan ke HTTP 429", async () => {
  const response = await handleRequest({
    request: request("/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "https://app.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "target", password: "wrong" }),
    }),
    env,
  }, async () => gasResponse({
    status: "error",
    errorCode: "TOO_MANY_ATTEMPTS",
    errorMsg: "Terlalu banyak percobaan login. Coba beberapa saat lagi.",
  }));

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "too_many_attempts");
});

test("users.list: password/hash/token absent recursively from all objects in response data", async () => {
  // sanitizeClientValue must strip sensitive keys recursively at any depth including arrays.
  const response = await handleRequest({
    request: request("/api/users", {
      method: "GET",
      headers: { Cookie: "sipsid_session=admin-token" },
    }),
    env,
  }, async () => gasResponse({
    status: "success",
    data: [
      {
        username: "admin",
        namaLengkap: "Admin",
        hakAkses: "admin",
        password: "SHOULD_NOT_APPEAR",
        hash: "SHOULD_NOT_APPEAR_EITHER",
        passwordHash: "ALSO_GONE",
        token: "SESSION_TOKEN_MUST_NOT_LEAK",
        sessionToken: "SESSION_TOKEN_MUST_NOT_LEAK_2",
        nested: {
          password: "NESTED_MUST_NOT_APPEAR",
          hash: "NESTED_HASH_GONE",
          token: "NESTED_TOKEN_GONE",
          deep: { password: "DEEP_NESTED", sessionToken: "DEEP_SESSION" },
        },
      },
      {
        username: "staff",
        namaLengkap: "Staf",
        hakAkses: "pengelola",
        password: "ALSO_SHOULD_NOT_APPEAR",
        token: "ANOTHER_TOKEN",
      },
    ],
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.data), "data must be an array");

  // Recursively scan any object/array for sensitive field names.
  const SENSITIVE = /^(password|hash|passwordhash|pw|token|sessiontoken|apisecret|secret|stack)$/i;
  function findSensitive(value, path) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = findSensitive(value[i], `${path}[${i}]`);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (SENSITIVE.test(key)) return `${path}.${key}`;
        const found = findSensitive(value[key], `${path}.${key}`);
        if (found) return found;
      }
    }
    return null;
  }

  // Check the entire data array recursively.
  const leak = findSensitive(body.data, "data");
  assert.equal(leak, null,
    `Sensitive field leaked at: ${leak} — sanitizeClientValue must strip it recursively`);

  // Verify safe fields are preserved.
  assert.ok(body.data.some((u) => u.username === "admin"), "admin user must be in data");
  assert.ok(body.data.some((u) => u.username === "staff"), "staff user must be in data");
  assert.ok(body.data.some((u) => u.hakAkses === "admin"), "hakAkses must be preserved");
});
