import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("frontend memakai kontrak update yang sesuai untuk GAS dan Pages", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");

  assert.match(
    html,
    /runGas\('apiUpdateLetter', sessionStorage\.getItem\('sipsid_session'\) \|\| '', id, payload\)/,
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

  assert.match(html, /runGas\('apiListUsers', sessionStorage\.getItem\('sipsid_session'\) \|\| ''\)/);
  assert.match(html, /runGas\('apiCreateUser', sessionStorage\.getItem\('sipsid_session'\) \|\| '', payload\)/);
  assert.match(html, /runGas\('apiUpdateUser', sessionStorage\.getItem\('sipsid_session'\) \|\| '', username, payload\)/);
  assert.match(html, /runGas\('apiResetUserPassword', sessionStorage\.getItem\('sipsid_session'\) \|\| '', username, \{ newPassword \}\)/);
  assert.match(html, /runGas\('apiDeleteUser', sessionStorage\.getItem\('sipsid_session'\) \|\| '', username\)/);
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
  assert.match(html, /sessionStorage\.removeItem\('sipsid_session'\)/);
  assert.match(html, /if \(!skipSessionExpiry\) handleSessionError\(error, response\.status\)/);
  assert.match(html, /method !== 'apiLogin' && method !== 'apiLogout'/);
  assert.match(html, /skipSessionExpiry: true/);
  assert.match(html, /Sesi berakhir\. Silakan masuk kembali\./);
  const expiryBody = html.match(/function expireClientSession\(\) \{([\s\S]*?)\n      \}/)?.[1] || "";
  assert.doesNotMatch(expiryBody, /api\.logout|logout\(/);
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
