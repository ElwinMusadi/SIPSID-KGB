import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");
const PENDING_KEY = "sipsid_pending_letter_create";

function createElement(id) {
  const classes = new Set();
  const attributes = new Map();
  return {
    id, value: "", innerHTML: "", innerText: "", disabled: false, isConnected: true,
    lastChild: { textContent: "" },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      replace: (from, to) => { if (classes.delete(from)) classes.add(to); },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const add = force === undefined ? !classes.has(name) : force;
        if (add) classes.add(name); else classes.delete(name);
        return add;
      },
    },
    setCustomValidity() {},
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
    focus() {}, reset() {}, addEventListener() {}, querySelectorAll: () => [],
  };
}

function createStorage() {
  const map = new Map();
  const calls = [];
  return {
    getItem: (key) => { calls.push(["get", key]); return map.get(key) ?? null; },
    setItem: (key, value) => { calls.push(["set", key]); map.set(key, String(value)); },
    removeItem: (key) => { calls.push(["remove", key]); map.delete(key); },
    _map: map, calls,
  };
}

async function loadFrontend({ fetchImpl } = {}) {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  const script = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(script, "inline script tidak ditemukan, tanpa mengganti template marker");
  const elements = new Map();
  const consoleCalls = [];
  const fetchCalls = [];
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, removeEventListener() {}, activeElement: null,
    body: createElement("body"),
  };
  const window = { scrollTo() {}, confirm: () => true, addEventListener() {}, location: { reload() {} } };
  const consoleStub = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => consoleCalls.push({ level, args })]));
  let requestNumber = 0;
  let handler = fetchImpl || (() => { throw new Error("fetch tidak di-stub"); });
  const ctx = {
    document, window, localStorage, sessionStorage, console: consoleStub,
    setTimeout: () => 0, clearTimeout() {},
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}` },
    fetch: (url, options) => { fetchCalls.push({ url, options }); return handler(url, options); },
    Promise, JSON, Math, Date, Number, String, Boolean, Object, Array, Set, Map, RegExp, Error, TypeError,
    URLSearchParams, encodeURIComponent,
  };
  window.document = document;
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: "Index.html" });
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, run, elements, consoleCalls, fetchCalls, localStorage, sessionStorage, document, setFetch: (fn) => { handler = fn; } };
}

function jsonResponse(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body };
}
const success = (data) => jsonResponse({ ok: true, data, error: null });
const failure = (code, message, status = 422, metadata = {}) => jsonResponse({ ok: false, data: null, error: { code, message }, ...metadata }, status);

function fillForm(document, overrides = {}) {
  const values = {
    "pegawai-status": "PNS", "pegawai-nama": "Budi Santoso", "pegawai-nip": "198001012005011001",
    "pegawai-pangkat": "Penata (III/c)", "pegawai-jabatan": "Guru", "pegawai-unit": "SMA Negeri 1 Kupang",
    "pegawai-kabkot": "Kota Kupang", "sk-pejabat": "Gubernur NTT", "sk-tanggal": "2024-01-01",
    "sk-nomor": "821/1/2024", "sk-tmt": "2024-01-01", "mk-lama-thn": "10", "mk-lama-bln": "0",
    "gaji-lama": "3000000", "mk-baru-thn": "12", "mk-baru-bln": "0", "gaji-tmt-baru": "2026-01-01",
    "gaji-baru": "3200000", "surat-nomor": "800/10/2026", "surat-tanggal": "2026-01-15",
    "sign-jabatan": "Kepala Dinas", "sign-nama": "Ir. Sinta", "sign-pangkat": "Pembina (IV/a)",
    "sign-nip": "197001011995031001", "ukuran-kertas": "legal", ...overrides,
  };
  for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
  return values;
}
const snapshotForm = (document) => Object.fromEntries(Object.keys(fillFormValues).map((id) => [id, document.getElementById(id).value]));
const fillFormValues = fillForm({ getElementById: () => ({}) });
function deferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  return { promise, resolve: resolveFn, reject: rejectFn };
}
const flush = () => new Promise((res) => setImmediate(res));
async function loadSignedIn(options) {
  const env = await loadFrontend(options);
  env.run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");
  env.document.getElementById("main-app").classList.remove("hidden");
  env.document.getElementById("login-page").classList.add("hidden");
  return env;
}

function assertNoSessionStorage(env) {
  assert.deepEqual(env.sessionStorage.calls, [], "sessionStorage tidak boleh dipakai");
  assert.ok(env.localStorage.calls.every(([, key]) => key === PENDING_KEY), "hanya idempotency boleh memakai localStorage");
}

function buildError(run, props) {
  return run(`Object.assign(new Error(${JSON.stringify(props.message || "")}), ${JSON.stringify(props)})`);
}

test("fetchJson menjaga metadata API yang aman tanpa mencatat token atau payload", async () => {
  const payload = JSON.stringify({ nama: "Budi", nip: "1980", requestId: "req-rahasia" });
  const env = await loadFrontend({ fetchImpl: async () => jsonResponse({ ok: false, data: null,
    error: { code: "data_write_denied", message: "Layanan tidak memiliki izin menulis ke basis data.", ref: "BACKEND123" }, backendVersion: "3.0.0" },
  403, { "cf-ray": "8a1b2c3d4e5f6789-SIN" }) });
  const error = await env.run(`fetchJson('/api/letters', { method: 'POST', body: ${JSON.stringify(payload)} })`).catch((err) => err);
  assert.equal(error.code, "DATA_WRITE_DENIED");
  assert.equal(error.httpStatus, 403);
  assert.equal(error.backendVersion, "3.0.0");
  assert.equal(error.ref, "BACKEND123");
  assert.equal(error.gatewayRef, "8a1b2c3d4e5f6789-SIN");
  assert.equal(error.message, "Layanan tidak memiliki izin menulis ke basis data.");
  assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, stack: error.stack }), /req-rahasia|"nama":"Budi"/);
  assert.equal(env.consoleCalls.length, 0);
  assertNoSessionStorage(env);
});

test("fetchJson memakai HTTP fallback, memisahkan ref gateway, dan menyaring metadata tak aman", async () => {
  const env = await loadFrontend({ fetchImpl: async () => jsonResponse({ ok: false, error: { code: "", message: "", ref: "REF12345" }, backendVersion: "<script>" }, 502, { "cf-ray": "<secret>" }) });
  const error = await env.run("fetchJson('/api/letters')").catch((err) => err);
  assert.equal(error.code, "HTTP_502");
  assert.equal(error.httpStatus, 502);
  assert.equal(error.ref, "REF12345");
  assert.equal(error.backendVersion, undefined);
  assert.equal(error.gatewayRef, undefined);
  env.setFetch(async () => jsonResponse({ ok: false, error: { code: "internal_error", message: "hidden" } }, 500, { "cf-ray": "8abc-SIN" }));
  const gatewayOnly = await env.run("fetchJson('/api/letters')").catch((err) => err);
  assert.equal(gatewayOnly.ref, undefined);
  assert.equal(gatewayOnly.gatewayRef, "8abc-SIN");
});

test("kode dan ref hanya dari metadata API, bukan marker pesan", async () => {
  const { run } = await loadFrontend();
  const getCode = run("getApiErrorCode");
  assert.equal(getCode({ code: "forbidden", error: { code: "auth_required" } }), "FORBIDDEN");
  assert.equal(getCode({ error: { code: "validation_error" } }), "VALIDATION_ERROR");
  assert.equal(getCode({ status: "not_found" }), "NOT_FOUND");
  assert.equal(getCode({ errorCode: "AUTH_REQUIRED" }), "");
  assert.equal(getCode({ message: "Sesi berakhir. (Kode: SESSION_EXPIRED; Ref: 0000FFFF)" }), "");
  assert.equal(getCode({}, 401), "HTTP_401");
  assert.equal(run("getApiErrorRef")({ message: "x (Kode: INTERNAL_ERROR; Ref: FF00)" }), "");
});

test("pesan error internal dan jaringan memberi panduan berbeda untuk create dan update", async () => {
  const { run } = await loadFrontend();
  const getMessage = run("getSubmitErrorMessage");
  for (const code of ["INTERNAL_ERROR", "DATA_WRITE_FAILED", "DATA_SERVICE_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "HTTP_503", ""]) {
    const error = buildError(run, { message: "Exception internal document 1abc line 427", code, httpStatus: 503, backendVersion: "3.0.0", ref: "A1B2C3D4" });
    const create = getMessage(error, false);
    assert.match(create, /Penyimpanan belum dapat dipastikan/);
    assert.match(create, /Jangan ubah formulir/);
    assert.match(create, /data yang sama/);
    assert.match(create, /tidak digandakan/);
    assert.match(create, /Arsip/);
    assert.match(create, /HTTP 503, backend v3\.0\.0, ref A1B2C3D4/);
    assert.doesNotMatch(create, /Exception|1abc|line 427/);
    const update = getMessage(error, true);
    assert.match(update, /Pembaruan belum dapat dipastikan/);
    assert.match(update, /ulangi pembaruan hanya bila belum tersimpan/);
    assert.doesNotMatch(update, /pengiriman ulang|digandakan/);
  }
  const error = buildError(run, { message: "Tidak dapat terhubung ke layanan.", code: "NETWORK_ERROR" });
  assert.match(getMessage(error, false), /ulangi dengan data yang sama/);
  assert.match(getMessage(error, true), /ulangi hanya bila perubahan belum tersimpan/);
});

test("BUSY, izin, validasi dan ketidaksinkronan API tetap memberi pesan pasti", async () => {
  const { run } = await loadFrontend();
  const message = (props, edit = false) => run("getSubmitErrorMessage")(buildError(run, props), edit);
  assert.match(message({ code: "busy" }), /Proses lain sedang berlangsung.*kode BUSY/);
  assert.match(message({ code: "WRITE_DENIED" }), /tidak memiliki izin menulis ke basis data.*mengulang tidak akan memperbaikinya/);
  assert.match(message({ code: "DATA_VALIDATION_ERROR" }), /aturan validasi basis data/);
  assert.match(message({ code: "VALIDATION_ERROR", message: "NIP wajib 18 digit." }), /^NIP wajib 18 digit\./);
  assert.match(message({ code: "FORBIDDEN", message: "Hanya administrator yang dapat menghapus arsip." }, true), /^Hanya administrator/);
  assert.match(message({ code: "ACTION_NOT_FOUND", message: "Aksi API tidak dikenal: letters.update" }, true), /Deployment frontend dan backend belum sinkron.*Detail layanan: Aksi API/);
  assert.match(message({ message: "Aksi API tidak dikenal: letters.update" }, true), /Pembaruan belum dapat dipastikan/, "pesan tanpa metadata tidak ditebak kodenya");
});

test("create fetch gagal: form dan requestId bertahan, retry manual memakai ID sama lalu dibersihkan pada sukses", async () => {
  let count = 0;
  const env = await loadSignedIn({ fetchImpl: async () => ++count === 1
    ? failure("internal_error", "Exception: internal", 500, { backendVersion: "3.0.0" })
    : success({ id: "KGB-001" }) });
  fillForm(env.document);
  const before = snapshotForm(env.document);
  const button = env.document.getElementById("btn-submit-form");
  button.innerHTML = "SIMPAN";
  await env.run("submitKgbForm()");
  assert.equal(env.fetchCalls.length, 1, "tidak ada retry otomatis");
  const requestId = JSON.parse(env.fetchCalls[0].options.body).requestId;
  assert.equal(JSON.parse(env.localStorage._map.get(PENDING_KEY)).requestId, requestId);
  assert.deepEqual(snapshotForm(env.document), before);
  assert.equal(env.run("lettersDatabase.length"), 0);
  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, "SIMPAN");
  assert.equal(env.run("letterSubmitPromise"), null);
  assert.equal(env.document.getElementById("toast-title").innerText, "Penyimpanan Gagal");
  assert.match(env.document.getElementById("toast-msg").innerText, /kode INTERNAL_ERROR, HTTP 500, backend v3\.0\.0/);
  assert.doesNotMatch(env.document.getElementById("toast-msg").innerText, /Exception/);
  await env.run("submitKgbForm()");
  assert.equal(JSON.parse(env.fetchCalls[1].options.body).requestId, requestId);
  assert.equal(env.localStorage._map.has(PENDING_KEY), false);
  assert.equal(env.run("lettersDatabase[0].id"), "KGB-001");
  assert.equal(env.document.getElementById("toast-title").innerText, "Berhasil Disimpan!");
  assertNoSessionStorage(env);
});

test("requestId idempoten bertahan reload, fallback memory, payload berubah dan reset eksplisit", async () => {
  const env = await loadFrontend();
  const first = env.run("getOrCreatePendingLetterRequest({ nama: 'Budi', nip: '1980' })");
  env.run("pendingLetterRequestMemory = null");
  assert.equal(env.run("getOrCreatePendingLetterRequest({ nip: '1980', nama: 'Budi' }).requestId"), first.requestId);
  const stored = env.localStorage._map.get(PENDING_KEY);
  assert.doesNotMatch(stored, /Budi|1980/);
  const other = env.run("getOrCreatePendingLetterRequest({ nama: 'Lain' })");
  assert.notEqual(other.requestId, first.requestId);
  env.run(`clearPendingLetterRequest(${JSON.stringify(first.requestId)})`);
  assert.equal(JSON.parse(env.localStorage._map.get(PENDING_KEY)).requestId, other.requestId, "sukses request lama tidak menghapus request baru");
  env.run("resetForm(false)");
  assert.equal(env.localStorage._map.has(PENDING_KEY), false);
  assert.equal(env.run("pendingLetterRequestMemory"), null);
  env.localStorage.getItem = () => { throw new Error("blocked"); };
  env.localStorage.setItem = () => { throw new Error("blocked"); };
  const memoryId = env.run("getOrCreatePendingLetterRequest({ nama: 'Budi' }).requestId");
  assert.equal(env.run("getOrCreatePendingLetterRequest({ nama: 'Budi' }).requestId"), memoryId);
});

test("double submit memakai satu fetch dan satu promise in-flight", async () => {
  const pending = deferred();
  const env = await loadSignedIn({ fetchImpl: () => pending.promise });
  fillForm(env.document);
  const first = env.run("submitKgbForm()");
  const second = env.run("submitKgbForm()");
  const third = env.run("submitKgbForm({ preventDefault() {} })");
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(env.document.getElementById("btn-submit-form").disabled, true);
  await flush();
  assert.equal(env.fetchCalls.length, 1);
  pending.resolve(success({ id: "KGB-002" }));
  await first;
  assert.equal(env.run("letterSubmitPromise"), null);
  assert.equal(env.document.getElementById("btn-submit-form").disabled, false);
  env.setFetch(async () => success({ id: "KGB-003" }));
  await env.run("submitKgbForm()");
  assert.equal(env.fetchCalls.length, 2);
});

test("target edit ditangkap sebelum fetch sehingga perubahan editingLetterId tidak menyentuh arsip lain", async () => {
  const pending = deferred();
  const env = await loadSignedIn({ fetchImpl: () => pending.promise });
  env.run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }, { id: 'L2', nama: 'Lain', statusPegawai: 'PPPK', suratTanggal: '2026-01-01' }]; editingLetterId = 'L1'");
  fillForm(env.document, { "pegawai-nama": "Baru" });
  const submit = env.run("submitKgbForm()");
  await flush();
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].url, "/api/letters/L1");
  assert.equal(env.fetchCalls[0].options.method, "PUT");
  assert.equal("requestId" in JSON.parse(env.fetchCalls[0].options.body), false);
  env.run("editingLetterId = 'L2'");
  pending.resolve(success({ nama: "Baru" }));
  await submit;
  assert.equal(env.run("lettersDatabase[0].nama"), "Baru");
  assert.equal(env.run("lettersDatabase[0].id"), "L1");
  assert.equal(env.run("lettersDatabase[1].nama"), "Lain");
  assert.equal(env.document.getElementById("toast-title").innerText, "Berhasil Diperbarui!");
});

test("update fetch ditolak/not_found mempertahankan form, target dan daftar lokal", async () => {
  for (const [code, status, text] of [["data_write_denied", 403, "Layanan tidak memiliki izin menulis ke basis data."], ["not_found", 404, "Data surat tidak ditemukan."]]) {
    const env = await loadSignedIn({ fetchImpl: async () => failure(code, text, status) });
    env.run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]; editingLetterId = 'L1'");
    fillForm(env.document, { "pegawai-nama": "Baru" });
    const before = snapshotForm(env.document);
    await env.run("submitKgbForm()");
    assert.equal(env.run("editingLetterId"), "L1");
    assert.deepEqual(snapshotForm(env.document), before);
    assert.equal(env.run("lettersDatabase[0].nama"), "Lama");
    assert.equal(env.document.getElementById("toast-title").innerText, "Pembaruan Gagal");
    assert.ok(env.document.getElementById("toast-msg").innerText.startsWith(text));
    assert.match(env.document.getElementById("toast-msg").innerText, new RegExp(`kode ${code.toUpperCase()}, HTTP ${status}`));
    assert.notEqual(env.run("currentUser"), null);
  }
});

test("401 dan kode sesi membersihkan UI/cache tanpa logout rekursif atau menghapus requestId tertunda", async () => {
  for (const [code, status] of [["auth_required", 401], ["session_expired", 403], ["invalid_session", 403], ["", 401]]) {
    const env = await loadSignedIn({ fetchImpl: async () => failure(code, "Sesi tidak valid.", status) });
    env.run("lettersDatabase = [{ id: 'L1' }]; arsipSuratLoaded = true; usersDatabase = [{ username: 'staff' }]; usersLoaded = true; activeLetterData = {}; activeReportContext = {}; editingLetterId = 'L1'");
    env.run("getOrCreatePendingLetterRequest({ nama: 'Budi' })");
    const pending = env.localStorage._map.get(PENDING_KEY);
    await env.run("api.listLetters()").catch(() => null);
    assert.equal(env.fetchCalls.length, 1, "tidak ada request logout tambahan");
    assert.equal(env.run("currentUser"), null);
    assert.equal(env.run("lettersDatabase.length + usersDatabase.length"), 0);
    assert.equal(env.run("arsipSuratLoaded || usersLoaded || arsipSuratLoading || usersLoading"), false);
    assert.equal(env.run("activeLetterData || activeReportContext || editingLetterId"), null);
    assert.equal(env.document.getElementById("main-app").classList.contains("hidden"), true);
    assert.equal(env.document.getElementById("login-page").classList.contains("hidden"), false);
    assert.equal(env.document.getElementById("login-error-msg").lastChild.textContent, " Sesi berakhir. Silakan masuk kembali.");
    assert.equal(env.localStorage._map.get(PENDING_KEY), pending);
    assertNoSessionStorage(env);
    env.run("resetForm(false)");
    assert.equal(env.localStorage._map.has(PENDING_KEY), false);
  }
});

test("network error, HTTP504, forbidden dan message marker tidak mengakhiri sesi", async () => {
  const cases = [
    () => { throw new TypeError("Failed to fetch"); },
    async () => failure("upstream_unavailable", "Layanan tidak tersedia.", 504),
    async () => failure("forbidden", "Tidak diizinkan.", 403),
    async () => failure("", "Sesi berakhir. (Kode: SESSION_EXPIRED; Ref: 0000FFFF)", 403),
  ];
  for (const fetchImpl of cases) {
    const env = await loadSignedIn({ fetchImpl });
    const error = await env.run("api.listLetters()").catch((err) => err);
    assert.ok(error.code);
    assert.notEqual(env.run("currentUser"), null);
    assert.equal(env.document.getElementById("main-app").classList.contains("hidden"), false);
    assertNoSessionStorage(env);
  }
});

const MAINTENANCE_TEXT = "Aplikasi sedang dalam pemeliharaan. Perubahan data dinonaktifkan sementara.";
const maintenanceResponse = () => jsonResponse({ ok: false, data: null, error: { code: "maintenance", message: MAINTENANCE_TEXT }, backendVersion: "3.0.0" }, 503, { "cf-ray": "9f00aa11bb22cc33-SIN" });
function assertMaintenance(env) {
  const text = env.document.getElementById("toast-msg").innerText;
  assert.ok(text.startsWith(MAINTENANCE_TEXT));
  assert.match(text, /kode MAINTENANCE/);
  assert.doesNotMatch(text, /belum dapat dipastikan|Proses lain sedang berlangsung/);
  assert.notEqual(env.run("currentUser"), null);
  assert.equal(env.document.getElementById("main-app").classList.contains("hidden"), false);
  assertNoSessionStorage(env);
}

test("maintenance fetch create mempertahankan requestId/form/sesi dan retry manual memakai ID sama", async () => {
  const env = await loadSignedIn({ fetchImpl: async () => maintenanceResponse() });
  fillForm(env.document);
  const before = snapshotForm(env.document);
  await env.run("submitKgbForm()");
  assert.equal(env.fetchCalls.length, 1);
  const requestId = JSON.parse(env.fetchCalls[0].options.body).requestId;
  assert.equal(JSON.parse(env.localStorage._map.get(PENDING_KEY)).requestId, requestId);
  assert.deepEqual(snapshotForm(env.document), before);
  assertMaintenance(env);
  assert.match(env.document.getElementById("toast-msg").innerText, /HTTP 503, backend v3\.0\.0, gateway 9f00aa11bb22cc33-SIN/);
  assert.equal(env.document.getElementById("btn-submit-form").disabled, false);
  env.setFetch(async () => success({ id: "KGB-2026-x" }));
  await env.run("submitKgbForm()");
  assert.equal(JSON.parse(env.fetchCalls[1].options.body).requestId, requestId);
});

test("maintenance fallback adalah penolakan pasti untuk create/update", async () => {
  const { run } = await loadFrontend();
  for (const edit of [false, true]) {
    assert.equal(run("getSubmitErrorMessage")(buildError(run, { code: "MAINTENANCE" }), edit), `${MAINTENANCE_TEXT} [kode MAINTENANCE]`);
  }
  assert.equal(run("isSessionError")({ code: "MAINTENANCE" }, 503), false);
});

test("maintenance update mempertahankan edit dan data lokal", async () => {
  const env = await loadSignedIn({ fetchImpl: async () => maintenanceResponse() });
  env.run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]; editingLetterId = 'L1'");
  fillForm(env.document, { "pegawai-nama": "Baru" });
  await env.run("submitKgbForm()");
  assert.equal(env.run("editingLetterId"), "L1");
  assert.equal(env.run("lettersDatabase[0].nama"), "Lama");
  assert.equal(env.document.getElementById("toast-title").innerText, "Pembaruan Gagal");
  assertMaintenance(env);
});

test("maintenance hapus arsip dan seluruh mutasi user memakai fetch tanpa mengakhiri sesi", async () => {
  const scenarios = [
    { title: "Hapus Gagal", method: "DELETE", url: "/api/letters/L1", act: async (env) => {
      env.run("lettersDatabase = [{ id: 'L1', nama: 'Lama', suratNomor: '1', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]");
      env.run("deleteHistoryItem('L1', document.getElementById('btn-del'))");
      await flush(); await flush();
      assert.equal(env.run("lettersDatabase.length"), 1);
    } },
    ...[false, true].map((editing) => ({ title: "Penyimpanan Gagal", method: editing ? "PUT" : "POST", url: editing ? "/api/users/staff" : "/api/users", act: async (env) => {
      if (editing) env.run("editingUsername = 'staff'");
      for (const [id, value] of Object.entries({ "user-form-username": "baru", "user-form-name": "Baru", "user-form-role": "pengelola", "user-form-password": "password123" })) env.document.getElementById(id).value = value;
      await env.run("submitUserForm({ preventDefault() {}, currentTarget: { checkValidity: () => true, reportValidity() {} } })");
    } })),
    { title: "Reset Password Gagal", method: "PUT", url: "/api/users/staff/password", act: async (env) => {
      env.run("resetPasswordUsername = 'staff'");
      env.document.getElementById("reset-password-new").value = "passwordbaru1";
      env.document.getElementById("reset-password-confirm").value = "passwordbaru1";
      await env.run("submitResetPassword({ preventDefault() {}, currentTarget: { checkValidity: () => true, reportValidity() {} } })");
    } },
    { title: "Hapus User Gagal", method: "DELETE", url: "/api/users/staff", act: async (env) => { await env.run("deleteUserAccount('staff', document.getElementById('btn-del-user'))"); } },
  ];
  for (const scenario of scenarios) {
    const env = await loadSignedIn({ fetchImpl: async () => maintenanceResponse() });
    await scenario.act(env);
    assert.equal(env.fetchCalls.length, 1, scenario.title);
    assert.equal(env.fetchCalls[0].url, scenario.url);
    assert.equal(env.fetchCalls[0].options.method, scenario.method);
    assert.equal(env.document.getElementById("toast-title").innerText, scenario.title);
    assertMaintenance(env);
  }
});
