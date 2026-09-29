import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("frontend memakai kontrak update yang sesuai untuk GAS dan Pages", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(
    html,
    /runGas\('apiUpdateLetter', getStoredSessionToken\(\), id, payload\)/,
  );
  assert.match(
    html,
    /fetchJson\(`\/api\/letters\/\$\{encodeURIComponent\(id\)\}`, \{ method: 'PUT', body: JSON\.stringify\(payload\) \}\)/,
  );
  assert.match(html, /api\.updateLetter\(letterIdBeingEdited, formData\)/);
});

test("error update mengenali backend yang belum sinkron tanpa menutupi detail upstream", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /code === 'ACTION_NOT_FOUND'/);
  assert.match(html, /Aksi API tidak dikenal\|Script function not found:/);
  assert.match(html, /Deployment frontend dan backend belum sinkron/);
  assert.match(html, /Detail layanan: \$\{message\}/);
  assert.match(html, /getSubmitErrorMessage\(error, isEditing\)/);
});

test("frontend manajemen user memakai kontrak GAS dan Pages tanpa merender password", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /runGas\('apiListUsers', getStoredSessionToken\(\)\)/);
  assert.match(html, /runGas\('apiCreateUser', getStoredSessionToken\(\), payload\)/);
  assert.match(html, /runGas\('apiUpdateUser', getStoredSessionToken\(\), username, payload\)/);
  assert.match(html, /runGas\('apiResetUserPassword', getStoredSessionToken\(\), username, \{ newPassword \}\)/);
  assert.match(html, /runGas\('apiDeleteUser', getStoredSessionToken\(\), username\)/);
  assert.match(html, /fetchJson\('\/api\/users'\)/);
  assert.match(html, /`\/api\/users\/\$\{encodeURIComponent\(username\)\}\/password`/);
  assert.doesNotMatch(html, /user\.password|user\.passwordHash|user\.hash/);
});

test("view user dijaga untuk admin dan state dibersihkan saat logout", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /id="nav-users"[\s\S]*class="nav-btn hidden/);
  assert.match(html, /role === 'admin' \|\| role === 'administrator'/);
  assert.match(html, /if \(viewId === 'users' && !isAdminUser\(\)\)/);
  assert.match(html, /usersDatabase = \[\];[\s\S]*usersLoaded = false;[\s\S]*updateAdminNavigation\(\)/);
  assert.match(html, /id="user-form-password"[^>]*minlength="8"/);
  assert.match(html, /id="reset-password-new"[^>]*minlength="8"/);
  assert.match(html, /newPassword !== confirmation/);
});

test("render user mengamankan data dan argumen inline", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /const safeArg = escapeInlineHandlerArg\(username\)/);
  assert.match(html, /const username = escapeHtml\(user\.username \|\| '-'\)/);
  assert.match(html, /const namaLengkap = escapeHtml\(user\.namaLengkap \|\| '-'\)/);
  assert.match(html, /const role = escapeHtml\(user\.hakAkses \|\| user\.role \|\| '-'\)/);
});

test("401 dan error sesi ditangani terpusat tanpa memanggil logout API kembali", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /SESSION_ERROR_CODES = new Set\(\['AUTH_REQUIRED', 'SESSION_EXPIRED', 'INVALID_SESSION', 'HTTP_401'\]\)/);
  assert.match(html, /if \(httpStatus === 401\) return 'HTTP_401'/);
  assert.match(html, /function expireClientSession\(\)/);
  assert.match(html, /function clearStoredSessionToken\(\)/);
  assert.match(html, /if \(!skipSessionExpiry\) handleSessionError\(error, response\.status\)/);
  assert.match(html, /!\['apiLogin', 'apiLogout', 'apiGetSession'\]\.includes\(method\)/);
  assert.match(html, /skipSessionExpiry: true/);
  assert.match(html, /Sesi berakhir\. Silakan masuk kembali\./);
  const expiryBody = html.match(/function expireClientSession\(\) \{([\s\S]*?)\n      \}/)?.[1] || "";
  assert.doesNotMatch(expiryBody, /api\.logout|logout\(/);
});

test("session restoration memakai kontrak dual runtime dan cookie Pages", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /async getSession\(\)[\s\S]*runGas\('apiGetSession', token\)/);
  assert.match(html, /fetchJson\('\/api\/auth\/session', \{ skipSessionExpiry: true \}\)/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.doesNotMatch(html, /document\.cookie/);
});

test("token GAS dimigrasikan ke localStorage dan dibersihkan dari kedua storage", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /localStorage\.getItem\(SESSION_STORAGE_KEY\)/);
  assert.match(html, /sessionStorage\.getItem\(SESSION_STORAGE_KEY\)/);
  assert.match(html, /if \(token\) localStorage\.setItem\(SESSION_STORAGE_KEY, token\)/);
  assert.match(html, /localStorage\.removeItem\(SESSION_STORAGE_KEY\)/);
  assert.match(html, /sessionStorage\.removeItem\(SESSION_STORAGE_KEY\)/);
  assert.match(html, /storeSessionToken\(result\.sessionToken\)/);
});

test("startup memulihkan sesi sebelum navigasi memuat arsip dan anonim tetap senyap", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  const init = html.match(/async function initializeApplication\(\) \{([\s\S]*?)\n      \}/)?.[1] || "";
  const restore = html.match(/async function restoreSession\(\) \{([\s\S]*?)\n      \}/)?.[1] || "";

  assert.match(html, /populateDropdowns\(\);[\s\S]*setDefaultDates\(\);[\s\S]*initializeApplication\(\)/);
  assert.match(init, /await restoreSession\(\)/);
  assert.ok(init.indexOf("await restoreSession()") < init.indexOf("await refreshMasterGaji()"));
  assert.match(init, /if \(hasUsableInitialMasterGaji\(\)\)/);
  assert.match(html, /return isGasRuntime\(\) && !masterGajiError &&[\s\S]*masterGajiPNS\.length > 0 \|\| masterGajiPPPK\.length > 0/);
  assert.ok(restore.indexOf("await api.getSession()") < restore.indexOf("navigate('dashboard')"));
  assert.match(restore, /return false/);
  assert.doesNotMatch(restore, /expireClientSession|Sesi berakhir|showToast/);
});

test("create surat memakai requestId stabil untuk payload sama dan menghapusnya setelah sukses atau reset", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /const PENDING_LETTER_CREATE_KEY = 'sipsid_pending_letter_create'/);
  assert.match(html, /crypto\.randomUUID\(\)/);
  assert.match(html, /function getPayloadFingerprint\(payload\)/);
  assert.match(html, /Math\.imul\(hashA \^ code, 16777619\)/);
  assert.doesNotMatch(html, /return JSON\.stringify\(Object\.keys\(payload\)/);
  assert.match(html, /stored\?\.fingerprint === fingerprint[\s\S]*return stored/);
  assert.match(html, /pendingLetterRequestMemory\?\.fingerprint === fingerprint/);
  assert.match(html, /const pending = \{ fingerprint, requestId: createRequestId\(\) \}/);
  assert.match(html, /const pendingCreate = isEditing \? null : getOrCreatePendingLetterRequest\(formData\)/);
  assert.match(html, /if \(pendingCreate\) formData\.requestId = pendingCreate\.requestId/);
  assert.match(html, /clearPendingLetterRequest\(pendingCreate\?\.requestId\)/);
  const reset = html.match(/function resetForm\(showNotification = true\) \{([\s\S]*?)\n      \}/)?.[1] || "";
  assert.match(reset, /clearPendingLetterRequest\(\)/);
});

test("CSV mengutip semua sel, menggandakan kutip, dan menetralkan formula spreadsheet", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  const csv = html.match(/function csvCell\(value\) \{([\s\S]*?)\n      \}/)?.[1] || "";

  assert.match(csv, /String\(value \?\? ''\)/);
  assert.match(csv, /\^\\s\*\[=\+\\-@\\t\\r\]/);
  assert.match(csv, /text = `'\$\{text\}`/);
  assert.match(csv, /text\.replace\(\/"\/g, '""'\)/);
  assert.match(html, /headers\.map\(csvCell\)\.join\(","\)/);
  assert.match(html, /row\.map\(csvCell\)\.join\(","\)/);
  assert.match(html, /item\.kabkot \|\| '-'/);
});

test("request arsip concurrent memakai satu in-flight promise yang dapat diulang", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /let arsipSuratPromise = null/);
  assert.match(html, /if \(arsipSuratPromise\) \{[\s\S]*return arsipSuratPromise\.then/);
  assert.match(html, /arsipSuratPromise = \(async \(\) => \{/);
  assert.match(html, /\.finally\(\(\) => \{ arsipSuratPromise = null; \}\)/);
});

test("Kabupaten atau Kota opsional, mempertahankan nilai kosong, dan tampil sebagai strip", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  const kabkotMarkup = html.match(/<label[^>]*>\s*Kabupaten \/ Kota<\/label\s*>[\s\S]*?id="pegawai-kabkot"[\s\S]*?<\/select>[\s\S]*?<\/div>/)?.[0] || "";

  assert.doesNotMatch(kabkotMarkup, /\*|required/);
  assert.match(kabkotMarkup, /<option value="">Pilih Kota\/Kabupaten<\/option>/);
  assert.match(kabkotMarkup, /Jika Unit Kerja di Dinas Pendidikan dan Kebudayaan, Kabupaten\/Kota tidak wajib diisi\./);
  assert.match(html, /kabKotSelect\.innerHTML = '<option value="">Pilih Kota\/Kabupaten<\/option>'/);
  assert.match(html, /document\.getElementById\('pegawai-kabkot'\)\.value = ''/);
  assert.match(html, /kabkot: document\.getElementById\('pegawai-kabkot'\)\.value/);
  assert.match(html, /'pegawai-kabkot': item\.kabkot/);
  assert.match(html, /escapeHtml\(item\.kabkot \|\| '-'\)/);
  assert.match(html, /item\.kabkot \|\| '-'/);
  assert.match(html, /kabFilter === "" \|\| item\.kabkot === kabFilter/);
});

test("dialog user menerapkan fokus, keyboard trap, dan background inert", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /let userDialogTrigger = null/);
  assert.match(html, /document\.addEventListener\('keydown', handleUserDialogKeydown\)/);
  assert.match(html, /event\.key === 'Escape'/);
  assert.match(html, /event\.key !== 'Tab'/);
  assert.match(html, /event\.shiftKey && document\.activeElement === first/);
  assert.match(html, /!event\.shiftKey && document\.activeElement === last/);
  assert.match(html, /app\.setAttribute\('inert', ''\)/);
  assert.match(html, /app\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(html, /trigger\?\.isConnected/);
  assert.match(html, /if \(activeUserDialog && activeUserDialog !== modal\) closeUserDialog\(activeUserDialog, false\)/);
});

test("form user membatasi panjang input sesuai backend", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(html, /id="user-form-username"[^>]*maxlength="64"[^>]*pattern=/);
  assert.match(html, /id="user-form-name"[^>]*maxlength="160"/);
  assert.match(html, /id="user-form-password"[^>]*minlength="8"[^>]*maxlength="200"/);
  assert.match(html, /id="reset-password-new"[^>]*minlength="8"[^>]*maxlength="200"/);
  assert.match(html, /id="reset-password-confirm"[^>]*minlength="8"[^>]*maxlength="200"/);
});
