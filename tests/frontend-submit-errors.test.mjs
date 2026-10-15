import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");

const SESSION_TOKEN = "secret-session-token-ABC123";

function createElement(id) {
  const classes = new Set();
  return {
    id,
    value: "",
    innerHTML: "",
    innerText: "",
    disabled: false,
    isConnected: true,
    lastChild: { textContent: "" },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      replace: (from, to) => { if (classes.delete(from)) classes.add(to); },
      contains: (name) => classes.has(name),
      toggle: (name) => (classes.has(name) ? classes.delete(name) : classes.add(name)),
    },
    setCustomValidity() {},
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    reset() {},
    addEventListener() {},
    querySelectorAll: () => [],
  };
}

function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    _map: map,
  };
}

async function loadFrontend({ fetchImpl } = {}) {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  const start = html.indexOf("<script>\n");
  const end = html.lastIndexOf("</script>");
  assert.ok(start !== -1 && end !== -1, "inline script tidak ditemukan");
  const script = html
    .slice(start + "<script>".length, end)
    .replace("<?!= serverData ?>", "null");

  const elements = new Map();
  const consoleCalls = [];
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  localStorage.setItem("sipsid_session", SESSION_TOKEN);

  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    body: createElement("body"),
  };
  const window = {
    scrollTo() {},
    confirm: () => true,
    addEventListener() {},
    location: { reload() {} },
  };
  const consoleStub = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoleStub[level] = (...args) => consoleCalls.push({ level, args });
  }

  // Stub google.script.run so runGas dapat diuji: handler dipanggil sesuai __gasBehavior(method, args).
  const gasCalls = [];
  const google = {
    script: {
      run: {
        withSuccessHandler(onSuccess) {
          const chain = {
            withFailureHandler(onFailure) {
              return new Proxy({}, {
                get: (_target, method) => (...args) => {
                  gasCalls.push({ method, args });
                  const behavior = ctx.__gasBehavior?.(method, args);
                  queueMicrotask(() => {
                    if (behavior && behavior.failure) onFailure(behavior.failure);
                    else onSuccess(behavior ? behavior.success : { status: "success" });
                  });
                },
              });
            },
          };
          return chain;
        },
      },
    },
  };

  const ctx = {
    google,
    document,
    window,
    localStorage,
    sessionStorage,
    console: consoleStub,
    setTimeout: () => 0,
    clearTimeout() {},
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(Date.now() + Math.floor(Math.random() * 1e6)).padStart(12, "0").slice(-12)}` },
    fetch: fetchImpl || (() => { throw new Error("fetch tidak di-stub"); }),
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    Error,
    TypeError,
    URLSearchParams,
    encodeURIComponent,
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: "Index.html" });

  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, run, elements, consoleCalls, localStorage, sessionStorage, document, gasCalls };
}

// google.script.run meneruskan hanya message dari error yang dilempar backend (tanpa error.code).
function gasFailure(message) {
  return { failure: { message, name: "Exception" } };
}

function jsonResponse(body, status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function fillForm(document, overrides = {}) {
  const values = {
    "pegawai-status": "PNS",
    "pegawai-nama": "Budi Santoso",
    "pegawai-nip": "198001012005011001",
    "pegawai-pangkat": "Penata (III/c)",
    "pegawai-jabatan": "Guru",
    "pegawai-unit": "SMA Negeri 1 Kupang",
    "pegawai-kabkot": "Kota Kupang",
    "sk-pejabat": "Gubernur NTT",
    "sk-tanggal": "2024-01-01",
    "sk-nomor": "821/1/2024",
    "sk-tmt": "2024-01-01",
    "mk-lama-thn": "10",
    "mk-lama-bln": "0",
    "gaji-lama": "3000000",
    "mk-baru-thn": "12",
    "mk-baru-bln": "0",
    "gaji-tmt-baru": "2026-01-01",
    "gaji-baru": "3200000",
    "surat-nomor": "800/10/2026",
    "surat-tanggal": "2026-01-15",
    "sign-jabatan": "Kepala Dinas",
    "sign-nama": "Ir. Sinta",
    "sign-pangkat": "Pembina (IV/a)",
    "sign-nip": "197001011995031001",
    "ukuran-kertas": "legal",
    ...overrides,
  };
  for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
  return values;
}

function snapshotForm(document) {
  const ids = [
    "pegawai-status", "pegawai-nama", "pegawai-nip", "pegawai-pangkat", "pegawai-jabatan", "pegawai-unit",
    "pegawai-kabkot", "sk-pejabat", "sk-tanggal", "sk-nomor", "sk-tmt", "mk-lama-thn", "mk-lama-bln",
    "gaji-lama", "mk-baru-thn", "mk-baru-bln", "gaji-tmt-baru", "gaji-baru", "surat-nomor", "surat-tanggal",
    "sign-jabatan", "sign-nama", "sign-pangkat", "sign-nip", "ukuran-kertas",
  ];
  return Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value]));
}

function deferred() {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

const flush = () => new Promise((res) => setImmediate(res));

test("fetchJson mempertahankan code, status HTTP, backendVersion, ref tanpa mencatat token/payload", async () => {
  const payload = JSON.stringify({ nama: "Budi", nip: "1980", requestId: "req-rahasia" });
  const { run, consoleCalls } = await loadFrontend({
    fetchImpl: async () => jsonResponse(
      { ok: false, data: null, error: { code: "data_write_denied", message: "Backend tidak memiliki izin menulis ke sheet Database_Surat." }, gasBackendVersion: "2.5.2" },
      403,
      { "cf-ray": "8a1b2c3d4e5f6789-SIN" },
    ),
  });

  const error = await run(`fetchJson('/api/letters', { method: 'POST', body: ${JSON.stringify(payload)} })`).then(
    () => null,
    (err) => err,
  );
  assert.ok(error, "fetchJson harus melempar error");
  assert.equal(error.code, "DATA_WRITE_DENIED", "kode Pages (lowercase) dinormalisasi ke uppercase");
  assert.equal(error.httpStatus, 403);
  assert.equal(error.backendVersion, "2.5.2");
  assert.equal(error.gatewayRef, "8a1b2c3d4e5f6789-SIN", "cf-ray disimpan terpisah sebagai ref gateway");
  assert.equal(error.ref, undefined, "ref GAS tidak boleh diisi dari header gateway");
  assert.equal(error.message, "Backend tidak memiliki izin menulis ke sheet Database_Surat.");

  const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
  assert.doesNotMatch(serialized, /req-rahasia|"nama":"Budi"|secret-session-token/);
  assert.equal(consoleCalls.length, 0, "fetchJson tidak boleh mencatat apa pun ke console");
});

test("fetchJson memakai status HTTP sebagai kode cadangan dan mengambil ref dari envelope", async () => {
  const { run } = await loadFrontend({
    fetchImpl: async () => jsonResponse({ ok: false, data: null, error: { code: "", message: "", ref: "REF12345" } }, 502),
  });
  const error = await run("fetchJson('/api/letters', { method: 'POST', body: '{}' })").then(() => null, (err) => err);
  assert.equal(error.code, "HTTP_502");
  assert.equal(error.httpStatus, 502);
  assert.equal(error.ref, "REF12345");
});

test("getSubmitErrorMessage memberi panduan aman untuk INTERNAL_ERROR/DATA_WRITE_FAILED tanpa pesan mentah", async () => {
  const { run } = await loadFrontend();
  const build = (props) => run(`(() => { const e = new Error(${JSON.stringify(props.message || "")}); Object.assign(e, ${JSON.stringify({ ...props, message: undefined })}); return e; })()`);

  const internal = run("getSubmitErrorMessage")(build({
    message: "Exception: Service Spreadsheets failed while accessing document with id 1abc (line 427, file Code)",
    code: "INTERNAL_ERROR",
    httpStatus: 500,
    backendVersion: "2.5.2",
    ref: "A1B2C3D4",
  }), false);
  assert.match(internal, /Penyimpanan belum dapat dipastikan/);
  assert.match(internal, /Jangan ubah formulir/);
  assert.match(internal, /data yang sama/);
  assert.match(internal, /Arsip/);
  assert.match(internal, /kode INTERNAL_ERROR/);
  assert.match(internal, /HTTP 500/);
  assert.match(internal, /backend v2\.5\.2/);
  assert.match(internal, /ref A1B2C3D4/);
  assert.doesNotMatch(internal, /Exception|line 427|1abc/);

  assert.match(internal, /tidak digandakan/, "create menjelaskan pengiriman ulang dikenali backend");

  const writeFailed = run("getSubmitErrorMessage")(build({ message: "stack trace rahasia", code: "DATA_WRITE_FAILED" }), true);
  assert.match(writeFailed, /Pembaruan belum dapat dipastikan/);
  assert.match(writeFailed, /Arsip/);
  assert.match(writeFailed, /ulangi pembaruan hanya bila belum tersimpan/);
  assert.doesNotMatch(writeFailed, /pengiriman ulang|digandakan/, "update tidak idempoten: jangan janjikan dedup");
  assert.match(writeFailed, /kode DATA_WRITE_FAILED/);
  assert.doesNotMatch(writeFailed, /stack trace rahasia/);

  const serviceUnavailable = run("getSubmitErrorMessage")(build({ message: "detail", code: "DATA_SERVICE_UNAVAILABLE", httpStatus: 503 }), false);
  assert.match(serviceUnavailable, /Penyimpanan belum dapat dipastikan/);
  assert.match(serviceUnavailable, /kode DATA_SERVICE_UNAVAILABLE, HTTP 503/);

  const networkCreate = run("getSubmitErrorMessage")(build({ message: "Tidak dapat terhubung ke layanan.", code: "NETWORK_ERROR" }), false);
  assert.match(networkCreate, /ulangi dengan data yang sama/);
  const networkUpdate = run("getSubmitErrorMessage")(build({ message: "Tidak dapat terhubung ke layanan.", code: "NETWORK_ERROR" }), true);
  assert.match(networkUpdate, /Pembaruan belum dapat dipastikan/);
  assert.match(networkUpdate, /ulangi hanya bila perubahan belum tersimpan/);

  const http503 = run("getSubmitErrorMessage")(build({ message: "<html>Bad Gateway</html>", code: "HTTP_503", httpStatus: 503 }), false);
  assert.match(http503, /Penyimpanan belum dapat dipastikan/);
  assert.doesNotMatch(http503, /Bad Gateway/);

  const uncoded = run("getSubmitErrorMessage")(build({ message: "ScriptError: We're sorry, a server error occurred. Please wait a bit and try again." }), false);
  assert.match(uncoded, /Penyimpanan belum dapat dipastikan/);
  assert.doesNotMatch(uncoded, /ScriptError|server error occurred/);
});

test("getSubmitErrorMessage membedakan BUSY, izin/proteksi, dan validasi dengan pesan aman backend", async () => {
  const { run } = await loadFrontend();
  const getMessage = run("getSubmitErrorMessage");
  const build = (props) => run(`(() => { const e = new Error(${JSON.stringify(props.message || "")}); Object.assign(e, ${JSON.stringify({ ...props, message: undefined })}); return e; })()`);

  const busy = getMessage(build({ message: "Layanan sedang sibuk.", code: "BUSY", httpStatus: 503 }), false);
  assert.match(busy, /Proses lain sedang berlangsung/);
  assert.match(busy, /ulangi dengan data yang sama/);
  assert.match(busy, /kode BUSY/);

  const busyLower = getMessage(build({ message: "Layanan sedang sibuk.", code: "busy" }), true);
  assert.match(busyLower, /Proses lain sedang berlangsung/);

  const denied = getMessage(build({
    message: "Backend tidak memiliki izin menulis ke sheet Database_Surat. Hubungi administrator.",
    code: "data_write_denied",
    httpStatus: 403,
    backendVersion: "2.5.2",
  }), false);
  assert.match(denied, /^Backend tidak memiliki izin menulis ke sheet Database_Surat\. Hubungi administrator\./);
  assert.match(denied, /kode DATA_WRITE_DENIED/);
  assert.match(denied, /HTTP 403/);
  assert.doesNotMatch(denied, /Penyimpanan belum dapat dipastikan/);

  const deniedNoMessage = getMessage(build({ message: "", code: "WRITE_DENIED" }), false);
  assert.match(deniedNoMessage, /tidak memiliki izin menulis/);
  assert.match(deniedNoMessage, /mengulang tidak akan memperbaikinya/);

  const validation = getMessage(build({ message: "NIP wajib 18 digit.", code: "VALIDATION_ERROR" }), false);
  assert.match(validation, /^NIP wajib 18 digit\./);
  assert.doesNotMatch(validation, /Penyimpanan belum dapat dipastikan/);

  const sheetValidation = getMessage(build({ message: "Nilai ditolak aturan validasi sheet.", code: "DATA_VALIDATION_ERROR" }), false);
  assert.match(sheetValidation, /^Nilai ditolak aturan validasi sheet\./);

  const forbidden = getMessage(build({ message: "Hanya administrator yang dapat menghapus arsip.", code: "FORBIDDEN" }), true);
  assert.match(forbidden, /^Hanya administrator/);
});

test("getSubmitErrorMessage membaca kode dan ref yang disematkan backend GAS di errorMsg", async () => {
  const { run } = await loadFrontend();
  const getMessage = run("getSubmitErrorMessage");

  const busyEmbedded = getMessage(new Error("Proses lain sedang berjalan, coba lagi. (Kode: BUSY; Ref: 1A2B3C4D)"), false);
  assert.match(busyEmbedded, /Proses lain sedang berlangsung/);
  assert.match(busyEmbedded, /kode BUSY/);
  assert.match(busyEmbedded, /ref 1A2B3C4D/);

  const deniedEmbedded = getMessage(new Error("Backend tidak memiliki izin menulis. (Kode: DATA_WRITE_DENIED; Ref: FFEE0011)"), false);
  assert.match(deniedEmbedded, /^Backend tidak memiliki izin menulis\./);
  assert.doesNotMatch(deniedEmbedded, /\(Kode:/);
  assert.match(deniedEmbedded, /kode DATA_WRITE_DENIED, ref FFEE0011/);

  const internalEmbedded = getMessage(new Error("Detail internal yang panjang. (Kode: INTERNAL_ERROR; Ref: 0BADF00D)"), false);
  assert.match(internalEmbedded, /Penyimpanan belum dapat dipastikan/);
  assert.doesNotMatch(internalEmbedded, /Detail internal/);
  assert.match(internalEmbedded, /ref 0BADF00D/);

  const mismatch = getMessage(Object.assign(new Error("Aksi API tidak dikenal: letters.update"), { code: "ACTION_NOT_FOUND" }), true);
  assert.match(mismatch, /Deployment frontend dan backend belum sinkron/);
  assert.match(mismatch, /Detail layanan: Aksi API tidak dikenal: letters\.update/);
});

test("create gagal INTERNAL_ERROR: requestId tertunda bertahan, form utuh, tidak ada retry otomatis, pengiriman ulang memakai requestId sama", async () => {
  const { run, document, localStorage, ctx } = await loadFrontend();
  const calls = [];
  ctx.__createLetter = async (payload) => {
    calls.push({ ...payload });
    if (calls.length === 1) {
      const error = new Error("Exception: internal");
      error.code = "INTERNAL_ERROR";
      error.httpStatus = 500;
      error.backendVersion = "2.5.2";
      throw error;
    }
    return { status: "success", data: { id: "KGB-001" } };
  };
  run("api.createLetter = (payload) => __createLetter(payload)");
  run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");

  fillForm(document);
  const before = snapshotForm(document);
  const submitBtn = document.getElementById("btn-submit-form");
  submitBtn.innerHTML = "SIMPAN";

  await run("submitKgbForm()");

  assert.equal(calls.length, 1, "tidak boleh ada retry otomatis");
  const firstRequestId = calls[0].requestId;
  assert.ok(firstRequestId, "requestId harus dikirim");
  const stored = JSON.parse(localStorage.getItem("sipsid_pending_letter_create"));
  assert.equal(stored.requestId, firstRequestId, "requestId tertunda harus dipertahankan setelah gagal");
  assert.deepEqual(snapshotForm(document), before, "nilai form tidak boleh berubah");
  assert.equal(run("editingLetterId"), null);
  assert.equal(run("lettersDatabase.length"), 0);
  assert.equal(submitBtn.disabled, false);
  assert.equal(submitBtn.innerHTML, "SIMPAN");
  assert.equal(run("letterSubmitPromise"), null);
  assert.equal(document.getElementById("toast-title").innerText, "Penyimpanan Gagal");
  assert.match(document.getElementById("toast-msg").innerText, /Penyimpanan belum dapat dipastikan/);
  assert.match(document.getElementById("toast-msg").innerText, /kode INTERNAL_ERROR, HTTP 500, backend v2\.5\.2/);
  assert.doesNotMatch(document.getElementById("toast-msg").innerText, /Exception: internal/);

  await run("submitKgbForm()");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].requestId, firstRequestId, "pengiriman ulang data sama memakai requestId yang sama");
  assert.equal(localStorage.getItem("sipsid_pending_letter_create"), null, "requestId dibersihkan setelah sukses");
  assert.equal(run("lettersDatabase[0].id"), "KGB-001");
  assert.equal(document.getElementById("toast-title").innerText, "Berhasil Disimpan!");
});

test("create gagal BUSY dan status:error dari GAS tetap mempertahankan requestId dan menampilkan panduan", async () => {
  const { run, document, localStorage, ctx } = await loadFrontend();
  const calls = [];
  ctx.__createLetter = async (payload) => {
    calls.push({ ...payload });
    return { status: "error", errorCode: "BUSY", errorMsg: "Proses lain sedang berjalan. (Kode: BUSY; Ref: DEADBEEF)", gasBackendVersion: "2.5.2" };
  };
  run("api.createLetter = (payload) => __createLetter(payload)");
  fillForm(document);

  await run("submitKgbForm()");

  assert.equal(calls.length, 1);
  const stored = JSON.parse(localStorage.getItem("sipsid_pending_letter_create"));
  assert.equal(stored.requestId, calls[0].requestId);
  const toast = document.getElementById("toast-msg").innerText;
  assert.match(toast, /Proses lain sedang berlangsung/);
  assert.match(toast, /kode BUSY, backend v2\.5\.2, ref DEADBEEF/);
});

test("pengiriman ganda saat request berjalan diabaikan: satu panggilan API, satu promise bersama", async () => {
  const { run, document, ctx } = await loadFrontend();
  const pending = deferred();
  let callCount = 0;
  ctx.__createLetter = () => { callCount += 1; return pending.promise; };
  run("api.createLetter = (payload) => __createLetter(payload)");
  fillForm(document);
  const submitBtn = document.getElementById("btn-submit-form");

  const first = run("submitKgbForm()");
  assert.equal(submitBtn.disabled, true);
  assert.equal(submitBtn.classList.contains("cursor-not-allowed"), true);
  const second = run("submitKgbForm()");
  const third = run("submitKgbForm({ preventDefault() {} })");
  await flush();

  assert.equal(callCount, 1, "API hanya boleh dipanggil sekali");
  assert.equal(second, first, "submit kedua mengembalikan promise in-flight yang sama");
  assert.equal(third, first);
  assert.ok(run("letterSubmitPromise") !== null);

  pending.resolve({ status: "success", data: { id: "KGB-002" } });
  await first;
  assert.equal(run("letterSubmitPromise"), null);
  assert.equal(submitBtn.disabled, false);
  assert.equal(run("lettersDatabase[0].id"), "KGB-002");

  ctx.__createLetter = async () => { callCount += 1; return { status: "success", data: { id: "KGB-003" } }; };
  await run("submitKgbForm()");
  assert.equal(callCount, 2, "submit berikutnya setelah selesai harus kembali diizinkan");
});

test("target edit dan mode ditangkap di awal submit sehingga perubahan state selama request tidak bocor", async () => {
  const { run, document, ctx } = await loadFrontend();
  const pending = deferred();
  const updateCalls = [];
  let createCalls = 0;
  ctx.__updateLetter = (id, payload) => { updateCalls.push({ id, payload: { ...payload } }); return pending.promise; };
  ctx.__createLetter = () => { createCalls += 1; return Promise.resolve({ status: "success", data: { id: "X" } }); };
  run("api.updateLetter = (id, payload) => __updateLetter(id, payload)");
  run("api.createLetter = (payload) => __createLetter(payload)");
  run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }, { id: 'L2', nama: 'Lain', statusPegawai: 'PPPK', suratTanggal: '2026-01-01' }]");
  run("editingLetterId = 'L1'");
  fillForm(document, { "pegawai-nama": "Baru" });

  const submit = run("submitKgbForm()");
  await flush();
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, "L1");
  assert.equal("requestId" in updateCalls[0].payload, false, "update tidak memakai requestId create");

  run("editingLetterId = 'L2'");
  pending.resolve({ status: "success", data: { nama: "Baru" } });
  await submit;

  assert.equal(createCalls, 0);
  assert.equal(run("lettersDatabase[0].nama"), "Baru");
  assert.equal(run("lettersDatabase[0].id"), "L1");
  assert.equal(run("lettersDatabase[1].nama"), "Lain", "arsip lain tidak tersentuh");
  assert.equal(document.getElementById("toast-title").innerText, "Berhasil Diperbarui!");
});

test("update gagal mempertahankan mode edit dan target, serta memakai judul Pembaruan Gagal", async () => {
  const { run, document, ctx } = await loadFrontend();
  ctx.__updateLetter = async () => {
    const error = new Error("Backend tidak memiliki izin menulis ke sheet.");
    error.code = "DATA_WRITE_DENIED";
    error.httpStatus = 403;
    throw error;
  };
  run("api.updateLetter = (id, payload) => __updateLetter(id, payload)");
  run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]");
  run("editingLetterId = 'L1'");
  fillForm(document, { "pegawai-nama": "Baru" });
  const before = snapshotForm(document);

  await run("submitKgbForm()");

  assert.equal(run("editingLetterId"), "L1", "mode edit dipertahankan setelah gagal");
  assert.deepEqual(snapshotForm(document), before);
  assert.equal(run("lettersDatabase[0].nama"), "Lama");
  assert.equal(document.getElementById("toast-title").innerText, "Pembaruan Gagal");
  assert.match(document.getElementById("toast-msg").innerText, /^Backend tidak memiliki izin menulis ke sheet\./);
  assert.match(document.getElementById("toast-msg").innerText, /kode DATA_WRITE_DENIED, HTTP 403/);
});

test("getApiErrorCode membaca marker (Kode: X) dari failure google.script.run, envelope, dan status not_found", async () => {
  const { run } = await loadFrontend();
  const getCode = run("getApiErrorCode");

  assert.equal(getCode({ message: "Sesi tidak valid. (Kode: AUTH_REQUIRED)" }), "AUTH_REQUIRED");
  assert.equal(getCode({ message: "Sesi berakhir. (Kode: SESSION_EXPIRED; Ref: 0A1B2C3D)" }), "SESSION_EXPIRED");
  assert.equal(getCode({ message: "NIP wajib. (Kode: validation_error)" }), "VALIDATION_ERROR");
  assert.equal(getCode({ errorCode: "FORBIDDEN", errorMsg: "x (Kode: AUTH_REQUIRED)" }), "FORBIDDEN", "kode eksplisit menang atas marker");
  assert.equal(getCode({ status: "not_found", errorMsg: "Data surat tidak ditemukan." }), "NOT_FOUND");
  assert.equal(getCode({ status: "error", errorMsg: "Pesan tanpa marker." }), "");
  assert.equal(getCode({ message: "Teks biasa (Kode: AUTH_REQUIRED) lalu lanjut" }), "", "marker hanya diakui di akhir pesan");
  assert.equal(getCode({ message: "x (Kode: <script>)" }), "");
  assert.equal(getCode({}, 401), "HTTP_401");
});

test("failure google.script.run bermarker AUTH_REQUIRED/SESSION_EXPIRED mengakhiri sesi klien; kode lain tidak", async () => {
  for (const [marker, expectExpire] of [
    ["(Kode: AUTH_REQUIRED)", true],
    ["(Kode: SESSION_EXPIRED; Ref: ABCD1234)", true],
    ["(Kode: VALIDATION_ERROR)", false],
    ["(Kode: FORBIDDEN)", false],
    ["(Kode: CONFIG_ERROR; Ref: 11112222)", false],
    ["", false],
  ]) {
    const { run, document, localStorage, sessionStorage, ctx } = await loadFrontend();
    ctx.__gasBehavior = () => gasFailure(`Pesan backend. ${marker}`.trim());
    run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");
    document.getElementById("main-app").classList.remove("hidden");
    document.getElementById("login-page").classList.add("hidden");

    const error = await run("runGas('apiCreateLetter', getStoredSessionToken(), { nama: 'x' })").then(() => null, (err) => err);
    assert.ok(error, `runGas harus menolak untuk ${marker || "tanpa marker"}`);
    assert.equal(error.message.includes("Pesan backend."), true);

    if (expectExpire) {
      assert.equal(run("currentUser"), null, `${marker} harus membersihkan currentUser`);
      assert.equal(localStorage.getItem("sipsid_session"), null, `${marker} harus menghapus token`);
      assert.equal(sessionStorage.getItem("sipsid_session"), null);
      assert.equal(document.getElementById("login-page").classList.contains("hidden"), false);
      assert.equal(document.getElementById("main-app").classList.contains("hidden"), true);
      assert.equal(document.getElementById("login-error-msg").lastChild.textContent, " Sesi berakhir. Silakan masuk kembali.");
    } else {
      assert.notEqual(run("currentUser"), null, `${marker || "tanpa marker"} tidak boleh mengakhiri sesi`);
      assert.equal(localStorage.getItem("sipsid_session"), SESSION_TOKEN);
      assert.equal(document.getElementById("main-app").classList.contains("hidden"), false);
    }
  }
});

test("runGas success envelope bermarker AUTH_REQUIRED juga mengakhiri sesi, tetapi apiLogin/apiGetSession dikecualikan", async () => {
  const expiring = await loadFrontend();
  expiring.ctx.__gasBehavior = () => ({ success: { status: "error", errorMsg: "Sesi tidak valid. (Kode: AUTH_REQUIRED)" } });
  expiring.run("currentUser = { username: 'u', namaLengkap: 'U', hakAkses: 'pengelola' }");
  const result = await expiring.run("runGas('apiListLetters', getStoredSessionToken())");
  assert.equal(result.status, "error");
  assert.equal(expiring.run("currentUser"), null);
  assert.equal(expiring.localStorage.getItem("sipsid_session"), null);

  const login = await loadFrontend();
  login.ctx.__gasBehavior = () => gasFailure("Kredensial salah. (Kode: AUTH_REQUIRED)");
  login.run("currentUser = { username: 'u', namaLengkap: 'U', hakAkses: 'pengelola' }");
  await login.run("runGas('apiGetSession', getStoredSessionToken())").catch(() => null);
  assert.notEqual(login.run("currentUser"), null, "apiGetSession tidak memicu expireClientSession");
  assert.equal(login.localStorage.getItem("sipsid_session"), SESSION_TOKEN);
});

test("submit via GAS: failure handler bermarker menghasilkan pesan aman per kode, tidak dianggap tidak pasti", async () => {
  const cases = [
    {
      marker: "(Kode: VALIDATION_ERROR)",
      text: "NIP wajib 18 digit.",
      expect: /^NIP wajib 18 digit\. \[kode VALIDATION_ERROR\]$/,
    },
    {
      marker: "(Kode: FORBIDDEN)",
      text: "Akun tidak berhak menulis arsip.",
      expect: /^Akun tidak berhak menulis arsip\. \[kode FORBIDDEN\]$/,
    },
    {
      marker: "(Kode: CONFIG_ERROR; Ref: C0FFEE00)",
      text: "Sheet Database_Surat tidak ditemukan.",
      expect: /^Sheet Database_Surat tidak ditemukan\. \[kode CONFIG_ERROR, ref C0FFEE00\]$/,
    },
    {
      marker: "(Kode: SCHEMA_ERROR)",
      text: "Header sheet tidak sesuai.",
      expect: /^Header sheet tidak sesuai\. \[kode SCHEMA_ERROR\]$/,
    },
    {
      marker: "(Kode: DATA_WRITE_DENIED; Ref: 1234ABCD)",
      text: "Spreadsheet menolak akses atau penulisan. Perubahan kemungkinan tidak diterapkan; muat ulang arsip untuk memastikan.",
      expect: /^Spreadsheet menolak akses atau penulisan\..*\[kode DATA_WRITE_DENIED, ref 1234ABCD\]$/,
    },
    {
      marker: "(Kode: DATA_VALIDATION_ERROR; Ref: 5678EF01)",
      text: "Spreadsheet menolak nilai karena aturan validasi data pada sheet Database_Surat.",
      expect: /^Spreadsheet menolak nilai karena aturan validasi data.*\[kode DATA_VALIDATION_ERROR, ref 5678EF01\]$/,
    },
    {
      marker: "(Kode: BUSY; Ref: B0B0B0B0)",
      text: "Proses lain sedang berjalan.",
      expect: /^Proses lain sedang berlangsung.*\[kode BUSY, ref B0B0B0B0\]$/,
    },
  ];

  for (const { marker, text, expect } of cases) {
    const { run, document, localStorage, ctx, gasCalls } = await loadFrontend();
    ctx.__gasBehavior = () => gasFailure(`${text} ${marker}`);
    run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");
    fillForm(document);

    await run("submitKgbForm()");

    assert.equal(gasCalls.length, 1, "tidak ada retry otomatis");
    assert.equal(gasCalls[0].method, "apiCreateLetter");
    const toast = document.getElementById("toast-msg").innerText;
    assert.match(toast, expect, `marker ${marker}`);
    assert.doesNotMatch(toast, /Penyimpanan belum dapat dipastikan|\(Kode:/, `marker ${marker} tidak boleh dianggap tidak pasti`);
    assert.ok(localStorage.getItem("sipsid_pending_letter_create"), "requestId tertunda tetap ada setelah gagal");
    assert.notEqual(run("currentUser"), null);
  }
});

test("submit via GAS: failure handler tanpa marker atau bermarker DATA_WRITE_FAILED dianggap tidak pasti dan pesan mentah disembunyikan", async () => {
  for (const message of [
    "Exception: Service Spreadsheets failed while accessing document with id 1abc",
    "Operasi Spreadsheet gagal karena kendala yang belum teridentifikasi. (Kode: DATA_WRITE_FAILED; Ref: FA11FA11)",
  ]) {
    const { run, document, ctx } = await loadFrontend();
    ctx.__gasBehavior = () => gasFailure(message);
    run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");
    fillForm(document);
    await run("submitKgbForm()");
    const toast = document.getElementById("toast-msg").innerText;
    assert.match(toast, /Penyimpanan belum dapat dipastikan/);
    assert.doesNotMatch(toast, /Service Spreadsheets|1abc|Operasi Spreadsheet gagal/);
    if (message.includes("DATA_WRITE_FAILED")) assert.match(toast, /kode DATA_WRITE_FAILED, ref FA11FA11/);
  }
});

test("update via GAS: respons status not_found diperlakukan sebagai NOT_FOUND pasti, bukan tidak pasti", async () => {
  const { run, document, ctx, gasCalls } = await loadFrontend();
  ctx.__gasBehavior = () => ({ success: { status: "not_found", errorMsg: "Data surat tidak ditemukan atau sudah dihapus.", gasBackendVersion: "2.5.2" } });
  run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");
  run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]");
  run("editingLetterId = 'L1'");
  fillForm(document, { "pegawai-nama": "Baru" });

  await run("submitKgbForm()");

  assert.equal(gasCalls.length, 1);
  assert.equal(gasCalls[0].method, "apiUpdateLetter");
  assert.equal(gasCalls[0].args[1], "L1");
  const toast = document.getElementById("toast-msg").innerText;
  assert.equal(document.getElementById("toast-title").innerText, "Pembaruan Gagal");
  assert.match(toast, /^Data surat tidak ditemukan atau sudah dihapus\. \[kode NOT_FOUND, backend v2\.5\.2\]$/);
  assert.doesNotMatch(toast, /belum dapat dipastikan/);
  assert.equal(run("editingLetterId"), "L1");
  assert.equal(run("lettersDatabase[0].nama"), "Lama");
  assert.notEqual(run("currentUser"), null);
});

test("fetchJson Pages: error.code not_found dan marker tersemat tetap menghasilkan kode pasti", async () => {
  const notFound = await loadFrontend({
    fetchImpl: async () => jsonResponse({ ok: false, data: null, error: { code: "not_found", message: "Data surat tidak ditemukan." } }, 404),
  });
  const nfError = await notFound.run("fetchJson('/api/letters/L9', { method: 'PUT', body: '{}' })").then(() => null, (e) => e);
  assert.equal(nfError.code, "NOT_FOUND");
  assert.equal(nfError.httpStatus, 404);
  assert.match(notFound.run("getSubmitErrorMessage")(nfError, true), /^Data surat tidak ditemukan\. \[kode NOT_FOUND, HTTP 404\]$/);

  const marker = await loadFrontend({
    fetchImpl: async () => jsonResponse({ ok: false, data: null, error: { code: "", message: "Sesi berakhir. (Kode: SESSION_EXPIRED; Ref: 0000FFFF)" } }, 403),
  });
  marker.run("currentUser = { username: 'u', namaLengkap: 'U', hakAkses: 'pengelola' }");
  const mkError = await marker.run("fetchJson('/api/letters', { method: 'POST', body: '{}' })").then(() => null, (e) => e);
  assert.equal(mkError.code, "SESSION_EXPIRED");
  assert.equal(mkError.ref, "0000FFFF");
  assert.equal(marker.run("currentUser"), null, "marker SESSION_EXPIRED di Pages juga mengakhiri sesi");
});

// ─── v2.5.4: write freeze (MAINTENANCE) ────────────────────────────────────

const MAINTENANCE_TEXT = "Aplikasi sedang dalam pemeliharaan. Perubahan data dinonaktifkan sementara.";
const MAINTENANCE_GAS_MESSAGE = `${MAINTENANCE_TEXT} (Kode: MAINTENANCE)`;

function maintenancePagesResponse() {
  return jsonResponse(
    { ok: false, data: null, error: { code: "maintenance", message: MAINTENANCE_GAS_MESSAGE }, gasBackendVersion: "2.5.4" },
    503,
    { "cf-ray": "9f00aa11bb22cc33-SIN" },
  );
}

function assertSessionKept(env) {
  assert.notEqual(env.run("currentUser"), null, "MAINTENANCE tidak boleh mengakhiri sesi");
  assert.equal(env.localStorage.getItem("sipsid_session"), SESSION_TOKEN, "token sesi tetap tersimpan");
  assert.equal(env.document.getElementById("main-app").classList.contains("hidden"), false);
  assert.notEqual(env.document.getElementById("login-error-msg").lastChild.textContent, " Sesi berakhir. Silakan masuk kembali.");
}

function assertDefiniteMaintenance(text) {
  assert.ok(text.startsWith(MAINTENANCE_TEXT), `pesan harus diawali pesan pemeliharaan: ${text}`);
  assert.match(text, /kode MAINTENANCE/);
  assert.doesNotMatch(text, /belum dapat dipastikan|Proses lain sedang berlangsung|\(Kode:/);
}

async function loadSignedIn(options) {
  const env = await loadFrontend(options);
  env.run("currentUser = { username: 'admin', namaLengkap: 'Admin', hakAkses: 'admin' }");
  env.document.getElementById("main-app").classList.remove("hidden");
  env.document.getElementById("login-page").classList.add("hidden");
  return env;
}

test("getSubmitErrorMessage: MAINTENANCE (Pages envelope, marker GAS, tanpa pesan) adalah kegagalan pasti", async () => {
  const { run } = await loadFrontend();
  const getMessage = run("getSubmitErrorMessage");
  const build = (props) => run(`(() => { const e = new Error(${JSON.stringify(props.message || "")}); Object.assign(e, ${JSON.stringify({ ...props, message: undefined })}); return e; })()`);

  for (const isEditing of [false, true]) {
    const pages = getMessage(build({ message: MAINTENANCE_GAS_MESSAGE, code: "maintenance", httpStatus: 503, backendVersion: "2.5.4" }), isEditing);
    assertDefiniteMaintenance(pages);
    assert.match(pages, /HTTP 503/);

    const marker = getMessage(new Error(MAINTENANCE_GAS_MESSAGE), isEditing);
    assert.equal(marker, `${MAINTENANCE_TEXT} [kode MAINTENANCE]`);

    const empty = getMessage(build({ message: "", code: "MAINTENANCE" }), isEditing);
    assert.equal(empty, `${MAINTENANCE_TEXT} [kode MAINTENANCE]`, "fallback pesan pemeliharaan");
  }
  assert.equal(run("isSessionError")({ code: "MAINTENANCE" }, 503), false);
});

test("create via GAS: MAINTENANCE -> pesan pasti, requestId tertunda & form dipertahankan, sesi tidak berakhir", async () => {
  const env = await loadSignedIn();
  const { run, document, localStorage, ctx, gasCalls } = env;
  ctx.__gasBehavior = () => gasFailure(MAINTENANCE_GAS_MESSAGE);
  fillForm(document);
  const before = snapshotForm(document);

  await run("submitKgbForm()");

  assert.equal(gasCalls.length, 1, "tidak ada retry otomatis");
  assert.equal(gasCalls[0].method, "apiCreateLetter");
  const firstRequestId = gasCalls[0].args[1].requestId;
  assert.ok(firstRequestId);
  assert.equal(JSON.parse(localStorage.getItem("sipsid_pending_letter_create")).requestId, firstRequestId);
  assert.deepEqual(snapshotForm(document), before);
  assert.equal(document.getElementById("toast-title").innerText, "Penyimpanan Gagal");
  assertDefiniteMaintenance(document.getElementById("toast-msg").innerText);
  assert.equal(document.getElementById("btn-submit-form").disabled, false);
  assertSessionKept(env);

  // Setelah pemeliharaan selesai, pengiriman ulang memakai requestId yang sama.
  ctx.__gasBehavior = () => ({ success: { status: "success", data: { id: "KGB-2026-x" } } });
  await run("submitKgbForm()");
  assert.equal(gasCalls[1].args[1].requestId, firstRequestId);
});

test("create via Pages: HTTP 503 maintenance -> pesan pasti, requestId tertunda dipertahankan, sesi tidak berakhir", async () => {
  let fetchCalls = 0;
  const env = await loadSignedIn({ fetchImpl: async () => { fetchCalls++; return maintenancePagesResponse(); } });
  const { run, document, localStorage } = env;
  run("api.createLetter = async (payload) => ({ status: 'success', data: await fetchJson('/api/letters', { method: 'POST', body: JSON.stringify(payload) }) })");
  fillForm(document);
  const before = snapshotForm(document);

  await run("submitKgbForm()");

  assert.equal(fetchCalls, 1);
  const stored = JSON.parse(localStorage.getItem("sipsid_pending_letter_create"));
  assert.ok(stored?.requestId, "requestId tertunda tetap ada");
  assert.deepEqual(snapshotForm(document), before);
  const toast = document.getElementById("toast-msg").innerText;
  assertDefiniteMaintenance(toast);
  assert.match(toast, /HTTP 503, backend v2\.5\.4, gateway 9f00aa11bb22cc33-SIN/);
  assertSessionKept(env);
});

test("update via GAS: MAINTENANCE mempertahankan mode edit dan data lokal", async () => {
  const env = await loadSignedIn();
  const { run, document, ctx } = env;
  ctx.__gasBehavior = () => gasFailure(MAINTENANCE_GAS_MESSAGE);
  run("lettersDatabase = [{ id: 'L1', nama: 'Lama', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]");
  run("editingLetterId = 'L1'");
  fillForm(document, { "pegawai-nama": "Baru" });

  await run("submitKgbForm()");

  assert.equal(document.getElementById("toast-title").innerText, "Pembaruan Gagal");
  assertDefiniteMaintenance(document.getElementById("toast-msg").innerText);
  assert.equal(run("editingLetterId"), "L1");
  assert.equal(run("lettersDatabase[0].nama"), "Lama");
  assertSessionKept(env);
});

test("hapus arsip, simpan/reset/hapus user: MAINTENANCE (GAS & Pages) menampilkan pesan pemeliharaan tanpa mengakhiri sesi", async () => {
  const scenarios = [
    {
      title: "Hapus Gagal",
      act: async (env) => {
        env.run("lettersDatabase = [{ id: 'L1', nama: 'Lama', suratNomor: '1', statusPegawai: 'PNS', suratTanggal: '2026-01-01' }]");
        env.run("deleteHistoryItem('L1', document.getElementById('btn-del'))");
        await flush(); await flush();
        assert.equal(env.run("lettersDatabase.length"), 1, "arsip lokal tidak dihapus");
      },
    },
    {
      title: "Penyimpanan Gagal",
      act: async (env) => {
        env.document.getElementById("user-form-username").value = "baru";
        env.document.getElementById("user-form-name").value = "Baru";
        env.document.getElementById("user-form-role").value = "pengelola";
        env.document.getElementById("user-form-password").value = "password123";
        await env.run("submitUserForm({ preventDefault() {}, currentTarget: { checkValidity: () => true, reportValidity() {} } })");
      },
    },
    {
      title: "Reset Password Gagal",
      act: async (env) => {
        env.run("resetPasswordUsername = 'staff'");
        env.document.getElementById("reset-password-new").value = "passwordbaru1";
        env.document.getElementById("reset-password-confirm").value = "passwordbaru1";
        await env.run("submitResetPassword({ preventDefault() {}, currentTarget: { checkValidity: () => true, reportValidity() {} } })");
      },
    },
    {
      title: "Hapus User Gagal",
      act: async (env) => { await env.run("deleteUserAccount('staff', document.getElementById('btn-del-user'))"); },
    },
  ];

  for (const transport of ["gas-failure", "gas-envelope", "pages"]) {
    for (const scenario of scenarios) {
      let fetchCalls = 0;
      const env = await loadSignedIn({ fetchImpl: async () => { fetchCalls++; return maintenancePagesResponse(); } });
      if (transport === "gas-failure") env.ctx.__gasBehavior = () => gasFailure(MAINTENANCE_GAS_MESSAGE);
      else if (transport === "gas-envelope") env.ctx.__gasBehavior = () => ({ success: { status: "error", errorCode: "MAINTENANCE", errorMsg: MAINTENANCE_GAS_MESSAGE } });
      else env.run("google = undefined");

      await scenario.act(env);

      const label = `${transport} / ${scenario.title}`;
      if (transport === "pages") assert.equal(fetchCalls, 1, `${label}: satu request`);
      else assert.equal(env.gasCalls.length, 1, `${label}: satu panggilan GAS`);
      assert.equal(env.document.getElementById("toast-title").innerText, scenario.title, label);
      assertDefiniteMaintenance(env.document.getElementById("toast-msg").innerText);
      assertSessionKept(env);
    }
  }
});
