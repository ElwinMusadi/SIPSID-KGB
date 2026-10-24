import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");
const readHtml = () => readFile(resolve(root, "Index.html"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((done) => setImmediate(done));
const success = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, data, error: null }) });
const failure = (code, status = 401) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ ok: false, data: null, error: { code, message: "Permintaan ditolak." } }) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function loadFrontend({ fetchImpl = async () => success([]), html = null } = {}) {
  html ??= await readHtml();
  const script = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(script, "script utama harus dapat diekstrak tanpa penggantian template");
  const elements = new Map();
  const timers = [];
  const fetchCalls = [];
  const consoleCalls = [];
  const events = new Map();
  const blobs = [];
  const created = [];
  const storageCalls = [];
  class Element {
    constructor(id = "") {
      this.id = id;
      this.value = "";
      this.innerHTML = "";
      this.innerText = "";
      this.disabled = false;
      this.isConnected = true;
      this.attributes = new Map();
      this.style = { setProperty() {} };
      this.lastChild = { textContent: "" };
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        replace: (from, to) => { if (classes.delete(from)) classes.add(to); },
        toggle: (name, force = !classes.has(name)) => { if (force) classes.add(name); else classes.delete(name); return force; },
      };
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    hasAttribute(key) { return this.attributes.has(key); }
    setCustomValidity(value) { this.validationMessage = value; }
    getClientRects() { return [{}]; }
    querySelectorAll() { return []; }
    focus() { document.activeElement = this; }
    reset() {}
    addEventListener() {}
    appendChild() {}
    removeChild() {}
    click() { this.clicked = true; }
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, handler) => events.set(type, handler),
    removeEventListener: (type) => events.delete(type),
    createElement: (type) => { const el = new Element(type); created.push(el); return el; },
    body: new Element("body"), activeElement: null,
  };
  const storage = () => ({
    getItem(key) { storageCalls.push(["get", key]); throw new Error("unexpected storage read"); },
    setItem(key) { storageCalls.push(["set", key]); throw new Error("unexpected storage write"); },
    removeItem(key) { storageCalls.push(["remove", key]); throw new Error("unexpected storage removal"); },
  });
  const window = { document, scrollTo() {}, confirm: () => true, scrollY: 0, addEventListener() {} };
  let handler = fetchImpl;
  const ctx = {
    document, window, HTMLElement: Element, localStorage: storage(), sessionStorage: storage(),
    console: Object.fromEntries(["log", "warn", "error", "info"].map((level) => [level, (...args) => consoleCalls.push([level, ...args])])),
    fetch: (url, options) => { fetchCalls.push({ url, options }); return handler(url, options); },
    setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout() {},
    Blob, URL: { createObjectURL: (blob) => { blobs.push(blob); return "blob:local-test"; } },
    Promise, JSON, Math, Date, Number, String, Object, Array, Set, Map, RegExp, Error, TypeError, encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx, { filename: "Index.html" });
  document.getElementById("main-app").classList.add("hidden");
  document.getElementById("login-error-msg").classList.add("hidden");
  const run = (code) => vm.runInContext(code, ctx);
  return { run, ctx, document, fetchCalls, consoleCalls, storageCalls, blobs, created, events,
    setFetch: (fn) => { handler = fn; }, runTimers: () => { while (timers.length) timers.shift()(); } };
}

const letter = {
  id: "L1", statusPegawai: "PNS", nama: "Budi", nip: "198001012005011001", pangkat: "Penata (III/c)",
  jabatan: "Guru", unit: "SMA Negeri 1", kabkot: "", skPejabat: "Gubernur NTT", skTanggal: "2024-01-01",
  skNomor: "821/1", skTmt: "2024-01-01", mkLamaThn: "10", mkLamaBln: "0", gajiLama: "Rp. 3.000.000,-",
  mkBaruThn: "12", mkBaruBln: "0", gajiBaruTmt: "2026-01-01", gajiBaru: "Rp. 3.200.000,-",
  suratNomor: "800/10/2026", suratTanggal: "2026-01-15", signJabatan: "Kepala Dinas Pendidikan dan Kebudayaan",
  signNama: "Ambrosius Kodo, S.Sos., M.M.", signPangkat: "Pembina Utama Madya (IV/d)", signNip: "197102201995031002", ukuranKertas: "legal",
};
const user = { username: "admin", namaLengkap: "Admin Uji", hakAkses: "admin" };

test("frontend hanya fetch dan dapat dieksekusi dengan LF maupun CRLF tanpa template atau token storage", async () => {
  const html = await readHtml();
  assert.doesNotMatch(html, /<\?[\s\S]*?\?>|google\.script|\bGAS\b|\bisGasRuntime\b|\brunGas\b|INITIAL_SERVER_DATA|\bserverData\b|parseEmbeddedErrorMarker|EMBEDDED_ERROR_MARKER|SESSION_STORAGE_KEY|sipsid_session|sessionToken|gasBackendVersion|document\.cookie|sessionStorage/);
  for (const text of [html.replace(/\r\n/g, "\n"), html.replace(/\r?\n/g, "\r\n")]) {
    const env = await loadFrontend({ html: text });
    assert.equal(env.run("masterGajiPNS.length + masterGajiPPPK.length"), 0);
    assert.deepEqual(env.storageCalls, []);
  }
});

test("seluruh adapter API memakai route, method, payload dan cookie same-origin sesuai kontrak", async () => {
  const env = await loadFrontend();
  const payload = { nama: "Budi", requestId: "request-001" };
  const userPayload = { username: "staff", namaLengkap: "Staff", hakAkses: "pengelola", password: "password123" };
  const cases = [
    ["login", [{ username: "admin", password: "rahasia" }], "/api/auth/login", "POST", { username: "admin", password: "rahasia" }, { user }, { status: "success", user }],
    ["logout", [], "/api/auth/logout", "POST", {}, {}, { status: "success" }],
    ["getSession", [], "/api/auth/session", "GET", undefined, { user }, { status: "success", user }],
    ["getBootstrap", [], "/api/bootstrap", "GET", undefined, { gajiPNS: [], gajiPPPK: [] }, { status: "success", gajiPNS: [], gajiPPPK: [] }],
    ["listLetters", [], "/api/letters", "GET", undefined, [letter], { status: "success", data: [letter] }],
    ["createLetter", [payload], "/api/letters", "POST", payload, letter, { status: "success", data: letter }],
    ["updateLetter", ["L/1 ?", payload], "/api/letters/L%2F1%20%3F", "PUT", payload, letter, { status: "success", data: letter }],
    ["deleteLetter", ["L/1 ?"], "/api/letters/L%2F1%20%3F", "DELETE", {}, { id: "L/1 ?" }, { status: "success", id: "L/1 ?" }],
    ["listUsers", [], "/api/users", "GET", undefined, [user], { status: "success", data: [user] }],
    ["createUser", [userPayload], "/api/users", "POST", userPayload, user, { status: "success", data: user }],
    ["updateUser", ["staff/ ?", userPayload], "/api/users/staff%2F%20%3F", "PUT", userPayload, user, { status: "success", data: user }],
    ["resetUserPassword", ["staff/ ?", "password123"], "/api/users/staff%2F%20%3F/password", "PUT", { newPassword: "password123" }, { username: "staff" }, { status: "success", data: { username: "staff" } }],
    ["deleteUser", ["staff/ ?"], "/api/users/staff%2F%20%3F", "DELETE", {}, { username: "staff" }, { status: "success", data: { username: "staff" } }],
  ];
  for (const [method, args, url, httpMethod, body, data, expected] of cases) {
    env.setFetch(async () => success(data));
    const result = await env.run(`api.${method}(...${JSON.stringify(args)})`);
    assert.deepEqual(plain(result), expected, method);
    const call = env.fetchCalls.at(-1);
    assert.equal(call.url, url, method);
    assert.equal(call.options.method || "GET", httpMethod, method);
    assert.equal(call.options.credentials, "same-origin", method);
    assert.deepEqual(call.options.body === undefined ? undefined : JSON.parse(call.options.body), body, method);
    assert.deepEqual(plain(call.options.headers), { "Content-Type": "application/json" }, method);
    assert.equal("skipSessionExpiry" in call.options, false, "option internal tidak bocor ke fetch");
  }
  assert.equal(env.fetchCalls.length, cases.length);
  assert.deepEqual(env.storageCalls, [], "login/session/logout tidak membaca atau menulis token JavaScript");
});

test("startup menunggu restore sebelum protected reads dan mengambil bootstrap sekali", async () => {
  const session = deferred();
  const env = await loadFrontend({ fetchImpl: (url) => {
    if (url === "/api/auth/session") return session.promise;
    assert.equal(env.run("currentUser.username"), "admin", "protected read sesudah restore");
    if (url === "/api/letters") return Promise.resolve(success([letter]));
    if (url === "/api/bootstrap") return Promise.resolve(success({ gajiPNS: [{ pangkat: "III/c", mkg: "10", nominal: "3000000" }], gajiPPPK: [] }));
    throw new Error(`unexpected ${url}`);
  } });
  const startup = env.run("initializeApplication()");
  assert.deepEqual(env.fetchCalls.map(({ url }) => url), ["/api/auth/session"]);
  assert.equal(env.run("currentUser"), null);
  session.resolve(success({ user }));
  await startup;
  await flush();
  assert.deepEqual(env.fetchCalls.map(({ url }) => url), ["/api/auth/session", "/api/letters", "/api/bootstrap"]);
  assert.equal(env.run("masterGajiPNS.length"), 1);
  assert.equal(env.run("arsipSuratLoaded"), true);
  assert.equal(env.document.getElementById("main-app").classList.contains("hidden"), false);
  assert.equal(env.document.getElementById("login-page").classList.contains("hidden"), true);
  assert.deepEqual(env.storageCalls, []);
});

test("startup anonymous401 tetap senyap, tanpa protected read dan tanpa pesan sesi berakhir", async () => {
  const env = await loadFrontend({ fetchImpl: async (url) => url === "/api/auth/session"
    ? failure("auth_required") : success({ gajiPNS: [], gajiPPPK: [] }) });
  env.document.getElementById("toast-title").innerText = "unchanged";
  await env.run("initializeApplication()");
  assert.deepEqual(env.fetchCalls.map(({ url }) => url), ["/api/auth/session"], "bootstrap butuh sesi, jadi tidak diambil anonim");
  assert.equal(env.run("currentUser"), null);
  assert.equal(env.document.getElementById("main-app").classList.contains("hidden"), true);
  assert.equal(env.document.getElementById("login-error-msg").classList.contains("hidden"), true);
  assert.equal(env.document.getElementById("login-error-msg").lastChild.textContent, "");
  assert.equal(env.document.getElementById("toast-title").innerText, "unchanged");
  assert.deepEqual(env.consoleCalls, []);
  assert.deepEqual(env.storageCalls, []);
});

test("master gaji dimuat setelah login berhasil karena bootstrap butuh sesi", async () => {
  const env = await loadFrontend({ fetchImpl: async (url) => {
    if (url === "/api/auth/login") return success({ user });
    if (url === "/api/letters") return success([]);
    if (url === "/api/bootstrap") return success({ gajiPNS: [{ pangkat: "Penata (III/c)", mkg: "10", nominal: "3000000" }], gajiPPPK: [] });
    throw new Error(`unexpected ${url}`);
  } });
  env.document.getElementById("username").value = "admin";
  env.document.getElementById("password").value = "rahasia";
  await env.run("login({ preventDefault() {} })");
  await flush();
  assert.deepEqual(env.fetchCalls.map(({ url }) => url), ["/api/auth/login", "/api/letters", "/api/bootstrap"]);
  assert.equal(env.run("masterGajiPNS.length"), 1);
  assert.equal(env.run("masterGajiError"), "");
});

test("login/logout/getSession 401 tidak memicu expiry rekursif, UI logout mengosongkan cache", async () => {
  const env = await loadFrontend({ fetchImpl: async () => failure("auth_required") });
  for (const action of ["api.login({ username: 'x', password: 'x' })", "api.getSession()", "api.logout()"] ) {
    env.run(`currentUser = ${JSON.stringify(user)}`);
    await env.run(action).catch(() => null);
    assert.notEqual(env.run("currentUser"), null);
    assert.equal(env.document.getElementById("login-error-msg").classList.contains("hidden"), true);
  }
  env.setFetch(async () => success({}));
  env.run("lettersDatabase = [{id:'L1'}]; usersDatabase = [{username:'staff'}]; usersLoaded = true; arsipSuratLoaded = true");
  await env.run("logout()");
  assert.equal(env.run("currentUser"), null);
  assert.equal(env.run("lettersDatabase.length + usersDatabase.length"), 0);
  assert.equal(env.run("usersLoaded || arsipSuratLoaded"), false);
  assert.deepEqual(env.storageCalls, []);
});

test("bootstrap concurrent berbagi promise dan dapat diulang setelah kegagalan", async () => {
  const pending = deferred();
  const env = await loadFrontend({ fetchImpl: () => pending.promise });
  const first = env.run("refreshMasterGaji()");
  const second = env.run("refreshMasterGaji()");
  assert.equal(first, second);
  assert.equal(env.fetchCalls.length, 1);
  pending.resolve(failure("data_service_unavailable", 503));
  await first;
  assert.equal(env.run("masterGajiPromise"), null);
  assert.notEqual(env.run("masterGajiError"), "");
  env.setFetch(async () => success({ gajiPNS: [{ pangkat: "Penata (III/c)", mkg: "10", nominal: "3000000" }], gajiPPPK: [] }));
  env.document.getElementById("pegawai-status").value = "PNS";
  env.document.getElementById("pegawai-pangkat").value = "Penata (III/c)";
  env.document.getElementById("mk-lama-thn").value = "10";
  await env.run("refreshMasterGaji()");
  assert.equal(env.fetchCalls.length, 2);
  assert.equal(env.run("masterGajiError"), "");
  assert.equal(env.document.getElementById("gaji-lama").value, "Rp. 3.000.000,-");
});

test("arsip dedupe request concurrent, cache loaded, retry error dan guard anonim", async () => {
  const pending = deferred();
  const env = await loadFrontend({ fetchImpl: () => pending.promise });
  await env.run("loadArsipSurat(true)");
  assert.equal(env.fetchCalls.length, 0);
  env.run(`currentUser = ${JSON.stringify(user)}`);
  const first = env.run("loadArsipSurat()");
  const second = env.run("loadArsipSurat(true)");
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.run("arsipSuratLoading"), true);
  pending.resolve(success([letter]));
  await Promise.all([first, second]);
  assert.equal(env.run("arsipSuratPromise"), null);
  assert.equal(env.run("arsipSuratLoading"), false);
  await env.run("loadArsipSurat(true)");
  assert.equal(env.fetchCalls.length, 1);
  env.run("arsipSuratLoaded = false");
  env.setFetch(async () => failure("data_service_unavailable", 503));
  await env.run("loadArsipSurat()");
  assert.equal(env.run("arsipSuratLoaded"), false);
  assert.equal(env.run("arsipSuratPromise"), null);
  assert.match(env.document.getElementById("history-table-body").innerHTML, /Permintaan ditolak/);
  env.setFetch(async () => success([]));
  await env.run("loadArsipSurat()");
  assert.equal(env.fetchCalls.length, 3);
  assert.equal(env.run("arsipSuratLoaded"), true);
  assert.match(env.document.getElementById("history-table-body").innerHTML, /Belum ada arsip surat/);
});

test("route dan mutasi user dibatasi admin, self-delete dilarang tanpa API", async () => {
  const env = await loadFrontend();
  env.run("currentUser = { username: 'staff', namaLengkap: 'Staff', hakAkses: 'pengelola' }; arsipSuratLoaded = true");
  env.run("updateAdminNavigation(); navigate('users')");
  assert.equal(env.document.getElementById("nav-users").classList.contains("hidden"), true);
  assert.equal(env.document.getElementById("toast-title").innerText, "Akses Ditolak");
  await env.run("loadUsers(true)");
  env.run("openUserFormModal(); openResetPasswordModal('staff')");
  await env.run("submitUserForm({ preventDefault() {} })");
  await env.run("submitResetPassword({ preventDefault() {} })");
  await env.run("deleteUserAccount('staff')");
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.run("activeUserDialog"), null);
  for (const role of ["admin", "administrator"]) {
    env.run(`currentUser.hakAkses = ${JSON.stringify(role)}; updateAdminNavigation()`);
    assert.equal(env.run("isAdminUser()"), true);
    assert.equal(env.document.getElementById("nav-users").classList.contains("hidden"), false);
  }
  await env.run("deleteUserAccount('STAFF')");
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.document.getElementById("toast-title").innerText, "Aksi Ditolak");
});

test("user loading/cache/error/empty dan render desktop/mobile mengamankan nilai serta tidak merender password", async () => {
  const env = await loadFrontend();
  env.run(`currentUser = ${JSON.stringify(user)}`);
  const pending = deferred();
  env.setFetch(() => pending.promise);
  const first = env.run("loadUsers()");
  await env.run("loadUsers()");
  assert.equal(env.fetchCalls.length, 1);
  assert.match(env.document.getElementById("users-state").innerHTML, /Memuat data user/);
  const unsafe = { username: "x'\"<>&", namaLengkap: "<img src=x onerror=alert(1)>", hakAkses: "<admin>", password: "SECRET-PASSWORD", hash: "SECRET-HASH" };
  pending.resolve(success([unsafe]));
  await first;
  for (const id of ["users-table-body", "users-card-list"]) {
    const rendered = env.document.getElementById(id).innerHTML;
    assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(rendered, /&lt;admin&gt;/);
    assert.match(rendered, /x\\&#039;&quot;&lt;&gt;&amp;/);
    assert.doesNotMatch(rendered, /<img|<admin>|SECRET-PASSWORD|SECRET-HASH/);
  }
  await env.run("loadUsers()");
  assert.equal(env.fetchCalls.length, 1);
  env.setFetch(async () => failure("data_service_unavailable", 503));
  await env.run("loadUsers(true)");
  assert.equal(env.run("usersLoaded"), false);
  assert.match(env.document.getElementById("users-state").innerHTML, /Coba Lagi/);
  env.setFetch(async () => success([]));
  await env.run("loadUsers(true)");
  assert.match(env.document.getElementById("users-state").innerHTML, /Belum ada user/);
});

test("dialog user menjaga fokus, Tab/Shift+Tab, Escape dan background inert", async () => {
  const env = await loadFrontend();
  env.run(`currentUser = ${JSON.stringify(user)}; usersDatabase = [${JSON.stringify(user)}]`);
  const trigger = env.document.getElementById("open-user");
  trigger.focus();
  env.run("openUserFormModal('admin')");
  env.runTimers();
  const modal = env.document.getElementById("user-form-modal");
  const first = env.document.getElementById("user-form-name");
  const last = env.document.getElementById("user-form-submit");
  modal.querySelectorAll = () => [first, last];
  assert.equal(env.document.activeElement, first);
  assert.equal(env.document.getElementById("user-form-role").disabled, true, "akun sendiri tidak dapat menurunkan role");
  assert.equal(env.document.getElementById("main-app").hasAttribute("inert"), true);
  let prevented = 0;
  const key = (key, shiftKey = false) => env.events.get("keydown")({ key, shiftKey, preventDefault: () => { prevented++; } });
  last.focus(); key("Tab"); assert.equal(env.document.activeElement, first);
  key("Tab", true); assert.equal(env.document.activeElement, last);
  key("Escape"); env.runTimers();
  assert.equal(prevented, 3);
  assert.equal(env.run("activeUserDialog"), null);
  assert.equal(env.document.activeElement, trigger);
  assert.equal(env.document.getElementById("main-app").hasAttribute("inert"), false);
  assert.equal(modal.classList.contains("hidden"), true);
});

test("validasi user dan konfirmasi password menolak submit sebelum fetch", async () => {
  const env = await loadFrontend();
  env.run(`currentUser = ${JSON.stringify(user)}`);
  env.document.getElementById("user-form-name").value = "  ";
  let reported = 0;
  env.ctx.invalidEvent = { preventDefault() {}, currentTarget: { checkValidity: () => false, reportValidity: () => { reported++; } } };
  await env.run("submitUserForm(invalidEvent)");
  assert.equal(env.document.getElementById("user-form-name").validationMessage, "Nama lengkap wajib diisi.");
  assert.equal(reported, 1);
  env.document.getElementById("reset-password-new").value = "password111";
  env.document.getElementById("reset-password-confirm").value = "password222";
  await env.run("submitResetPassword({ preventDefault() {}, currentTarget: { checkValidity: () => true } })");
  assert.equal(env.document.getElementById("toast-title").innerText, "Konfirmasi Tidak Sama");
  assert.equal(env.fetchCalls.length, 0);
  const html = await readHtml();
  assert.match(html, /id="user-form-username"[^>]*maxlength="64"[^>]*pattern=/);
  assert.match(html, /id="user-form-name"[^>]*maxlength="160"/);
  for (const id of ["user-form-password", "reset-password-new", "reset-password-confirm"]) assert.match(html, new RegExp(`id="${id}"[^>]*minlength="8"[^>]*maxlength="200"`));
});

test("CSV semua sel dikutip, kutip digandakan dan formula dinetralkan, filter serta kabkot kosong dipertahankan", async () => {
  const env = await loadFrontend();
  const cell = env.run("csvCell");
  for (const value of ["=1+1", "+SUM(A1)", "-1", "@cmd", "  =cmd", "\tcmd", "\rmalicious"]) assert.equal(cell(value), `"'${value}"`);
  assert.equal(cell('Nama "A", B\nC'), '"Nama ""A"", B\nC"');
  assert.equal(cell(null), '""');
  assert.equal(cell(0), '"0"');
  const data = { ...letter, nama: '=HYPERLINK("bad")', unit: 'SMA "Uji", NTT' };
  env.run(`lettersDatabase = ${JSON.stringify([data, { ...letter, id: "L2", suratTanggal: "2025-01-15" }])}`);
  env.document.getElementById("report-month-filter").value = "2026-01";
  env.run("exportToCSV()");
  const csv = await env.blobs[0].text();
  assert.match(csv, /^"ID Surat","Status Pegawai","Nama Lengkap"/);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"SMA ""Uji"", NTT","'-"/);
  assert.doesNotMatch(csv, /"L2"/);
  assert.equal(env.created[0].download, "Data_SIPSID_KGB_NTT.csv");
  assert.equal(env.created[0].clicked, true);
});

test("surat mempertahankan kop resmi, data penandatangan/tanggal/pangkat, escaping, marker dan ukuran kertas", async () => {
  const env = await loadFrontend();
  const data = { ...letter, nama: '<img src=x onerror="alert(1)">', unit: "Dinas <NTT>", signNip: "1969 0807 1992 031009" };
  for (const size of ["a4", "legal"]) {
    env.run(`openPrintModal(${JSON.stringify({ ...data, ukuranKertas: size })})`);
    const sheet = env.document.getElementById("printable-letter-sheet");
    assert.equal(sheet.classList.contains(`kertas-${size}`), true);
    assert.equal(env.document.body.classList.contains(`print-${size}`), true);
    assert.match(sheet.innerHTML, /class="kop-surat__lambang" src="\/assets\/lambang-ntt\.png"/);
    assert.match(sheet.innerHTML, /15 Januari 2026/);
    assert.match(sheet.innerHTML, /1 Januari 2024/);
    assert.match(sheet.innerHTML, /Ambrosius Kodo, S\.Sos\., M\.M\./);
    assert.match(sheet.innerHTML, /Pembina Utama Madya \(IV\/d\)/);
    assert.match(sheet.innerHTML, /NIP\. 196908071992031009/);
    assert.match(sheet.innerHTML, /\$\{ttd_pengirim\}/);
    assert.match(sheet.innerHTML, /height: 125px;.*translateX\(-60px\)/);
    assert.match(sheet.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(sheet.innerHTML, /<img src=x/);
  }
  const html = await readHtml();
  assert.match(html, /\.kertas-legal\s*\{\s*width: 215\.9mm;\s*min-height: 355\.6mm;/);
  assert.match(html, /\.kertas-a4\s*\{\s*width: 210mm;\s*min-height: 297mm;/);
  assert.match(html, /padding: 10mm 20mm 20mm 20mm/);
  assert.match(html, /id="sign-pangkat"\s+value="Pembina Utama Madya \(IV\/d\)"\s+readonly/);
  assert.match(html, /id="sign-nama"\s+value="Ambrosius Kodo, S\.Sos\., M\.M\."\s+readonly/);
  assert.match(html, /id="sign-nip"\s+value="197102201995031002"/);
  const kop = env.run("kopSuratHTML");
  assert.doesNotMatch(kop, /this\.src|logo-fallback/);
  assert.match(kop, /Kop surat resmi gagal dimuat/);
  // Teks kop resmi sebagai HTML (bukan gambar), sesuai yang dikonfirmasi pengguna.
  const kopText = kop.replace(/<[^>]+>/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(kopText, [
    "PEMERINTAH PROVINSI NUSA TENGGARA TIMUR",
    "DINAS PENDIDIKAN DAN KEBUDAYAAN",
    "Jalan Jenderal Soeharto Nomor 57, Naikoten I, Kota Kupang 85118",
    "Laman: https://dindikbud.nttprov.go.id, Pos-el: dindikbud@nttprov.go.id",
  ]);
  assert.match(kop, /kop-surat__garis-tebal[\s\S]*kop-surat__garis-tipis/, "garis penutup ganda");
  assert.doesNotMatch(html, /kop-surat-ntt\.png/, "kop gambar lama tidak dipakai lagi");
  // `.kertas-cetak *` memaksa huruf normal; nama pemda dan dinas harus tetap tebal.
  assert.match(html, /\.kertas-cetak \.kop-surat__pemda,\s*\.kertas-cetak \.kop-surat__dinas\s*\{\s*font-weight: bold !important;/);
  // Lembar surat bukan flex item: di layar sempit tidak menyusut sehingga PDF tetap 1 halaman.
  const letterScroll = html.match(/<div\s+class="([^"]*)"\s*>\s*<div\s+id="printable-letter-sheet"/)?.[1];
  assert.ok(letterScroll);
  assert.doesNotMatch(letterScroll, /\bflex\b(?!-)/);
  assert.equal((html.match(/src="\/assets\/logo-sipsid-kgb\.png"/g) || []).length, 2);
  assert.doesNotMatch(html, /googleusercontent|placehold\.co|Google Drive|Spreadsheet/);
});

test("NIP penandatangan ikut dikembalikan form.reset(): input tersembunyi bukan type=hidden", async () => {
  // Pada type="hidden", mengisi .value saat edit menimpa nilai default sehingga reset tidak memulihkannya.
  const html = await readHtml();
  const input = html.match(/<input[^>]*id="sign-nip"[^>]*>/)?.[0];
  assert.ok(input);
  assert.match(input, /type="text"/);
  assert.match(input, /\shidden\s/);
  assert.doesNotMatch(html, /<input[^>]*type="hidden"/, "input type=hidden di formulir tidak dipulihkan form.reset()");
});

test("SRIKANDI geometry menjaga koordinat teks PDF dan menolak marker/batas halaman tidak valid", async () => {
  const env = await loadFrontend();
  const sheet = { querySelector: () => ({ textContent: "${ttd_pengirim}", getBoundingClientRect: () => ({ left: 410, top: 810, width: 100, height: 20 }) }),
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 800, height: 1400 }) };
  const metrics = env.run("getSrikandiMarkerMetrics")(sheet);
  assert.deepEqual(plain(metrics), { sheetWidth: 800, centerX: 450, topY: 800, bottomY: 820, baselineY: 816 });
  const calls = [];
  const pdf = Object.fromEntries(["setPage", "setFont", "setFontSize", "setTextColor", "text"].map((name) => [name, (...args) => calls.push([name, ...args])]));
  pdf.getNumberOfPages = () => 2;
  env.run("addSrikandiMarkerTextLayer")(pdf, metrics, 210, 297, 600);
  assert.deepEqual(plain(calls), [["setPage", 1], ["setFont", "helvetica", "normal"], ["setFontSize", 10], ["setTextColor", 0, 0, 0], ["text", "${ttd_pengirim}", 118.125, 214.20000000000002, { align: "center" }]]);
  assert.throws(() => env.run("addSrikandiMarkerTextLayer")(pdf, { ...metrics, topY: 1120, bottomY: 1140, baselineY: 1136 }, 210, 297, 600), /luar halaman PDF/);
  assert.throws(() => env.run("getSrikandiMarkerMetrics")({ ...sheet, querySelector: () => null }), /tidak ditemukan/);
  assert.throws(() => env.run("getSrikandiMarkerMetrics")({ ...sheet, getBoundingClientRect: () => ({ left: 10, top: 10, width: 10, height: 10 }) }), /Koordinat/);
});

test("PDF download mempertahankan html2canvas/jsPDF serta marker text layer untuk A4 dan Legal", async () => {
  for (const size of ["a4", "legal"]) {
    const env = await loadFrontend();
    const sheet = env.document.getElementById("printable-letter-sheet");
    const marker = { textContent: "${ttd_pengirim}", getBoundingClientRect: () => ({ left: 400, top: 700, width: 100, height: 20 }) };
    sheet.querySelector = () => marker;
    sheet.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 1100 });
    const calls = [];
    let canvasOptions;
    env.ctx.html2canvas = async (element, options) => {
      assert.equal(element, sheet);
      canvasOptions = options;
      const hidden = [];
      options.onclone({ getElementById: () => ({ style: { setProperty: (...args) => hidden.push(args) } }) });
      assert.deepEqual(hidden, [["visibility", "hidden", "important"]]);
      return { width: 1600, height: 2200, toDataURL: () => "data:image/jpeg;base64,test" };
    };
    env.ctx.window.jspdf = { jsPDF: class {
      constructor(options) { calls.push(["construct", plain(options)]); this.internal = { pageSize: { getWidth: () => size === "a4" ? 210 : 215.9, getHeight: () => size === "a4" ? 297 : 355.6 } }; }
      addImage(...args) { calls.push(["image", ...args]); }
      getNumberOfPages() { return 1; }
      setPage() {} setFont() {} setFontSize() {} setTextColor() {}
      text(...args) { calls.push(["text", ...args]); }
      save(name) { calls.push(["save", name]); }
    } };
    env.run(`activeLetterData = ${JSON.stringify({ ...letter, ukuranKertas: size })}`);
    await env.run("downloadLetterPdf()");
    assert.deepEqual(calls[0], ["construct", { orientation: "portrait", unit: "mm", format: size, compress: true }]);
    assert.equal(canvasOptions.scale, 3, "surat dirender ±288 dpi");
    assert.equal(canvasOptions.useCORS, true);
    assert.equal(canvasOptions.allowTaint, false);
    assert.equal(canvasOptions.logging, false);
    assert.equal(calls.find(([name]) => name === "text")[1], "${ttd_pengirim}");
    assert.deepEqual(calls.at(-1), ["save", "Surat-KGB-198001012005011001-2026-01-15.pdf"]);
    assert.equal(env.document.getElementById("btn-download-pdf").disabled, false);
    assert.equal(env.document.getElementById("toast-title").innerText, "PDF Berhasil Diunduh");
  }
});

test("laporan rekapitulasi dipecah per halaman tanpa memotong baris dan header tabel diulang", async () => {
  const env = await loadFrontend();
  const paginate = env.run("paginateReportRows");
  assert.deepEqual(plain(paginate([40, 40, 40, 40, 40], 100, 130)), [[0, 1], [2, 3, 4]]);
  assert.deepEqual(plain(paginate([60, 60, 60], 100, 100)), [[0], [1], [2]]);
  assert.deepEqual(plain(paginate([500, 10], 100, 100)), [[0], [1]], "baris lebih tinggi dari halaman tetap ditempatkan tanpa halaman kosong");
  assert.deepEqual(plain(paginate([], 100, 100)), [[]]);

  const page = env.run("buildReportPageHtml")("<div>KOP</div>", "<tr><td>1</td></tr>", "Halaman 1 dari 2");
  assert.match(page, /class="report-page kertas-cetak kertas-legal/);
  assert.match(page, /table-layout: fixed/);
  assert.equal((page.match(/<col /g) || []).length, 8);
  assert.match(page, /<thead>[\s\S]*Nama & NIP Pegawai[\s\S]*<\/thead>/);
  assert.match(page, /Halaman 1 dari 2/);
  const row = env.run("buildReportRowHtml")({ ...letter, nama: "<b>x</b>" }, 4);
  assert.match(row, />5<\/td>/);
  assert.match(row, /&lt;b&gt;x&lt;\/b&gt;/);

  const html = await readHtml();
  assert.match(html, /\.report-page\s*\{\s*height: 355\.6mm;\s*overflow: hidden;/);
  assert.doesNotMatch(html.match(/id="report-print-scroll"[^>]*>/)[0], /justify-center/);
});

test("PDF laporan merender setiap halaman pratinjau menjadi satu halaman Legal", async () => {
  const env = await loadFrontend();
  const makePage = (name) => ({ name, classList: { contains: (cls) => cls === "report-page" }, querySelectorAll: () => [] });
  const pages = [makePage("p1"), makePage("p2"), makePage("p3")];
  env.document.getElementById("printable-report-sheet").querySelectorAll = (selector) => selector === ".report-page" ? pages : [];
  const rendered = [];
  env.ctx.html2canvas = async (element, options) => {
    rendered.push(element.name);
    assert.equal(options.ignoreElements(element), false, "halaman target tidak diabaikan");
    assert.equal(pages.filter((other) => other !== element).every((other) => options.ignoreElements(other)), true, "halaman lain tidak ikut diklon");
    assert.equal(options.ignoreElements({ classList: { contains: () => false } }), false);
    return { width: 1632, height: 2688, toDataURL: () => `data:image/jpeg;base64,${element.name}` };
  };
  const calls = [];
  env.ctx.window.jspdf = { jsPDF: class {
    constructor(options) { calls.push(["construct", plain(options)]); this.internal = { pageSize: { getWidth: () => 215.9, getHeight: () => 355.6 } }; }
    addPage(...args) { calls.push(["page", ...args]); }
    addImage(...args) { calls.push(["image", args[0], ...args.slice(2, 6)]); }
    save(name) { calls.push(["save", name]); }
  } };
  env.run(`activeReportContext = ${JSON.stringify({ titleKab: "Kabupaten Alor", month: "2026-10", generatedDate: "2026-10-24", total: 30 })}`);
  await env.run("downloadReportPdf()");
  assert.deepEqual(rendered, ["p1", "p2", "p3"]);
  assert.deepEqual(plain(calls), [
    ["construct", { orientation: "portrait", unit: "mm", format: "legal", compress: true }],
    ["image", "data:image/jpeg;base64,p1", 0, 0, 215.9, 355.6],
    ["page", "legal", "portrait"],
    ["image", "data:image/jpeg;base64,p2", 0, 0, 215.9, 355.6],
    ["page", "legal", "portrait"],
    ["image", "data:image/jpeg;base64,p3", 0, 0, 215.9, 355.6],
    ["save", "Laporan-Rekapitulasi-KGB-Kabupaten-Alor-2026-10-2026-10-24.pdf"],
  ]);
  assert.equal(env.document.getElementById("toast-title").innerText, "PDF Berhasil Diunduh");
  assert.equal(env.document.getElementById("btn-download-report-pdf").disabled, false);

  env.run("activeReportContext = null");
  await env.run("downloadReportPdf()");
  assert.equal(rendered.length, 3, "tanpa pratinjau yang selesai disusun, PDF tidak dibuat");
  assert.equal(env.document.getElementById("toast-title").innerText, "PDF Gagal Dibuat");
});

test("kabkot tetap opsional dan layout responsif tidak diganti", async () => {
  const html = await readHtml();
  const kabkot = html.match(/<label[^>]*>\s*Kabupaten \/ Kota<\/label\s*>[\s\S]*?id="pegawai-kabkot"[\s\S]*?<\/select>[\s\S]*?<\/div>/)?.[0];
  assert.ok(kabkot);
  assert.doesNotMatch(kabkot, /\*|required/);
  assert.match(kabkot, /Jika Unit Kerja di Dinas Pendidikan dan Kebudayaan, Kabupaten\/Kota tidak wajib diisi\./);
  assert.match(html, /id="users-card-list"[^>]*class="[^"]*md:hidden/);
  assert.match(html, /overflow-x-auto/);
  assert.match(html, /grid-cols-1 md:grid-cols-2 lg:grid-cols-4/);
  assert.match(html, /populateDropdowns\(\);\s*setDefaultDates\(\);\s*initializeApplication\(\)/);
});
