/**
 * Versi backend GAS. Naikkan nilai ini setiap kali ada perubahan yang memerlukan
 * pembaruan GAS deployment (bukan hanya Cloudflare). Nilai ini disertakan dalam
 * setiap respons doPost sehingga mismatch antara versi deployed dan source
 * dapat dideteksi dari log Cloudflare maupun laporan error klien.
 *
 * PENTING: setelah `npm run push:gas`, deployment aktif di GAS App Editor
 * harus diperbarui secara manual: Deploy > Manage deployments > [deployment] > Edit >
 * Version: New version > Deploy. Tanpa langkah ini, endpoint produksi masih
 * melayani versi lama dan akan mengembalikan ACTION_NOT_FOUND untuk aksi baru.
 */
var GAS_BACKEND_VERSION = "2.5.1";

var CONFIG_KEYS_ = {
  SPREADSHEET_ID: "SPREADSHEET_ID",
  CLOUDFLARE_API_SECRET: "CLOUDFLARE_API_SECRET",
  SESSION_SIGNING_SECRET: "SESSION_SIGNING_SECRET",
  PASSWORD_PEPPER: "PASSWORD_PEPPER"
};

var DEFAULT_SPREADSHEET_ID_ = "1ZwZRVDmgYivLL5NpcwA0OixR2iN6yioQs38J4ftEAvY";
var SESSION_TTL_SECONDS_ = 8 * 60 * 60;
var SHEET_NAMES_ = {
  USERS: "Master_User",
  SALARIES: "Master_Gaji_Pangkat",
  LETTERS: "Database_Surat"
};

var LETTER_FIELDS_ = [
  "id", "statusPegawai", "nama", "nip", "pangkat", "jabatan", "unit", "kabkot",
  "skPejabat", "skTanggal", "skNomor", "skTmt", "mkLamaThn", "mkLamaBln", "gajiLama",
  "mkBaruThn", "mkBaruBln", "gajiBaruTmt", "gajiBaru", "suratNomor", "suratTanggal",
  "signJabatan", "signNama", "signPangkat", "signNip", "ukuranKertas"
];

function doGet() {
  var template = HtmlService.createTemplateFromFile("Index");
  template.serverData = safeJsonForHtml_(getBootstrapData_());

  return template.evaluate()
    .setTitle("SIPSID-KGB NTT")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * HTTP entry point used only by the Cloudflare Pages Function.
 * Browser clients must never receive CLOUDFLARE_API_SECRET.
 *
 * Setiap respons menyertakan gasBackendVersion sehingga Cloudflare atau klien
 * dapat mendeteksi bila GAS deployment yang aktif masih menggunakan versi lama
 * yang belum mengenali aksi baru (misal letters.update).
 */
function doPost(e) {
  try {
    var request = parseHttpRequest_(e);
    verifyCloudflareSecret_(request.apiSecret);
    var result = dispatchHttpAction_(request);
    result.gasBackendVersion = GAS_BACKEND_VERSION;
    return jsonOutput_(result);
  } catch (error) {
    console.error("SIPSID API error", error);
    return jsonOutput_({
      status: "error",
      errorCode: error && error.code ? error.code : "INTERNAL_ERROR",
      errorMsg: publicErrorMessage_(error),
      gasBackendVersion: GAS_BACKEND_VERSION
    });
  }
}

function apiLogin(credentials) {
  return login_(credentials || {});
}

function apiLogout() {
  return { status: "success" };
}

/**
 * apiGetSession — validates sessionToken and returns the current user identity.
 *
 * Uses requireCurrentSession_ (full sv + live-sheet check) so stale tokens
 * (after password reset, role change, deletion) return AUTH_REQUIRED, not user data.
 * Response NEVER includes sessionToken or any credential material.
 *
 * Returns:
 *   { status: "success", user: { username, namaLengkap, hakAkses } }
 * Throws AUTH_REQUIRED / SESSION_EXPIRED when token is invalid or stale.
 */
function apiGetSession(sessionToken) {
  var session = requireCurrentSession_(sessionToken, false);
  return {
    status: "success",
    user: {
      username: session.username,
      namaLengkap: session.liveNama || session.namaLengkap,
      hakAkses: session.liveRole || session.hakAkses
    }
  };
}

function apiGetBootstrap() {
  return getBootstrapData_();
}

function apiListLetters(sessionToken) {
  requireCurrentSession_(sessionToken, false);
  return listLetters_();
}

function apiCreateLetter(sessionToken, payload) {
  var session = requireCurrentSession_(sessionToken, false);
  // Extract requestId before passing payload to validateAndNormalizeLetter_ so
  // the client cannot use it to choose an arbitrary letter ID via the body.
  var rawRequestId = payload ? payload.requestId : undefined;
  return createLetter_(payload || {}, session, rawRequestId);
}

function apiDeleteLetter(sessionToken, id) {
  var session = requireCurrentSession_(sessionToken, false);
  return deleteLetter_(id, session);
}

function apiUpdateLetter(sessionToken, id, payload) {
  var session = requireCurrentSession_(sessionToken, false);
  return updateLetter_(id, payload || {}, session);
}

// ─── User Management Public Wrappers (GAS direct UI) ───────────────────────

function apiListUsers(sessionToken) {
  var session = requireCurrentSession_(sessionToken, true);
  return listUsers_(session);
}

function apiCreateUser(sessionToken, payload) {
  var session = requireCurrentSession_(sessionToken, true);
  return createUser_(payload || {}, session);
}

function apiUpdateUser(sessionToken, username, payload) {
  var session = requireCurrentSession_(sessionToken, true);
  return updateUser_(username, payload || {}, session);
}

function apiResetUserPassword(sessionToken, username, payload) {
  var session = requireCurrentSession_(sessionToken, true);
  return resetUserPassword_(username, payload || {}, session);
}

function apiDeleteUser(sessionToken, username) {
  var session = requireCurrentSession_(sessionToken, true);
  return deleteUser_(username, session);
}

// Compatibility wrappers for deployments that still call the old functions.
function getMasterGaji() {
  return readMasterGaji_();
}

function getArsipSurat(request) {
  return {
    status: "error",
    errorCode: "AUTH_REQUIRED",
    errorMsg: "Gunakan API terautentikasi untuk mengakses arsip surat."
  };
}

function dispatchHttpAction_(request) {
  var action = String(request.action || "");
  var payload = request.payload || {};

  if (action === "auth.login") return login_(payload);
  if (action === "auth.logout") return { status: "success" };
  if (action === "auth.session") return apiGetSession(request.sessionToken);
  if (action === "bootstrap.get") return getBootstrapData_();
  if (action === "letters.list") return apiListLetters(request.sessionToken);
  if (action === "letters.create") return apiCreateLetter(request.sessionToken, payload);
  if (action === "letters.update") return apiUpdateLetter(request.sessionToken, payload.id, payload);
  if (action === "letters.delete") return apiDeleteLetter(request.sessionToken, payload.id);

  // User management actions — require admin session (enforced inside each function).
  if (action === "users.list") return apiListUsers(request.sessionToken);
  if (action === "users.create") return apiCreateUser(request.sessionToken, payload);
  if (action === "users.update") return apiUpdateUser(request.sessionToken, payload.username, payload);
  if (action === "users.resetPassword") return apiResetUserPassword(request.sessionToken, payload.username, payload);
  if (action === "users.delete") return apiDeleteUser(request.sessionToken, payload.username);

  // Manifest action: digunakan oleh skrip deploy/verify untuk memastikan deployment
  // aktif mengenali semua aksi. Tidak memerlukan sessionToken, hanya apiSecret
  // (sudah diverifikasi di doPost sebelum dispatcher dipanggil).
  if (action === "system.manifest") return {
    status: "success",
    gasBackendVersion: GAS_BACKEND_VERSION,
    supportedActions: [
      "auth.login", "auth.logout", "auth.session", "bootstrap.get",
      "letters.list", "letters.create", "letters.update", "letters.delete",
      "users.list", "users.create", "users.update", "users.resetPassword", "users.delete",
      "system.manifest"
    ]
  };

  throw appError_("ACTION_NOT_FOUND", "Aksi API tidak dikenal: " + action + ". GAS backend v" + GAS_BACKEND_VERSION + " mendukung: auth.login, auth.logout, auth.session, bootstrap.get, letters.list, letters.create, letters.update, letters.delete, users.list, users.create, users.update, users.resetPassword, users.delete, system.manifest.");
}

function login_(credentials) {
  var username = cleanText_(credentials.username, 100);
  var password = String(credentials.password || "");
  if (!username || !password) {
    return { status: "error", errorCode: "INVALID_CREDENTIALS", errorMsg: "Username atau password tidak valid." };
  }

  var rows;
  try {
    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.USERS);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Master_User tidak ditemukan.");
    rows = sheet.getDataRange().getDisplayValues();
  } catch (lookupError) {
    // Preserve fail-closed throttling when Script Properties/config lookup is down.
    var degradedAttempt = consumeLoginAttempt_("__unknown_username_bucket__");
    if (!degradedAttempt.allowed) {
      return { status: "error", errorCode: "INVALID_CREDENTIALS", errorMsg: "Username atau password tidak valid." };
    }
    throw lookupError;
  }
  var matchedRow = null;
  for (var rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    if (String(rows[rowIndex][0] || "").trim() === username) {
      matchedRow = rows[rowIndex];
      break;
    }
  }

  // Unknown usernames share one bounded bucket. This prevents attacker-controlled
  // random names from filling the persistent state and denying known accounts.
  var throttleIdentity = matchedRow ? username : "__unknown_username_bucket__";

  // Atomic consume: acquire throttle lock, read count, reject if >= max, THEN
  // increment (reserve) before releasing the lock. This means each login attempt
  // consumes one slot before the password is verified, so concurrent requests
  // cannot race past the limit. On successful login the counter is cleared.
  var consumed = consumeLoginAttempt_(throttleIdentity);
  if (!consumed.allowed) {
    // Keep public failure identical to bad credentials to prevent account enumeration.
    return { status: "error", errorCode: "INVALID_CREDENTIALS", errorMsg: "Username atau password tidak valid." };
  }

  if (matchedRow) {
    var storedUsername = String(matchedRow[0] || "").trim();
    if (verifyPassword_(password, String(matchedRow[1] || ""))) {

    // Login successful — clear throttle counter (the reserved slot is freed).
    clearLoginThrottle_(throttleIdentity);

    var hakAkses = normalizeHakAkses_(cleanText_(matchedRow[3], 50)) || "pengelola";
    var user = {
      username: storedUsername,
      namaLengkap: cleanText_(matchedRow[2], 160) || storedUsername,
      hakAkses: hakAkses,
      sv: computeSessionVersion_(String(matchedRow[1] || ""), hakAkses)
    };
    return {
      status: "success",
      sessionToken: createSessionToken_(user),
      expiresIn: SESSION_TTL_SECONDS_,
      user: { username: user.username, namaLengkap: user.namaLengkap, hakAkses: user.hakAkses }
    };
    }
  }

  // Login failed — slot was already consumed/incremented in consumeLoginAttempt_.
  // Do NOT call recordLoginFailure_ here to avoid double-increment.
  return { status: "error", errorCode: "INVALID_CREDENTIALS", errorMsg: "Username atau password tidak valid." };
}

function verifyPassword_(password, storedPassword) {
  var stored = String(storedPassword || "");
  if (stored.indexOf("sha256$") === 0) {
    var parts = stored.split("$");
    if (parts.length !== 3) return false;
    var pepper = getScriptProperties_().getProperty(CONFIG_KEYS_.PASSWORD_PEPPER);
    // Pepper is mandatory for hashed passwords. Missing pepper is a configuration
    // error that must surface explicitly — silently using "" would allow bypass.
    if (!pepper) throw appError_("CONFIG_ERROR", "PASSWORD_PEPPER belum dikonfigurasi. Hubungi administrator sistem.");
    var candidate = sha256Hex_(parts[1] + password + pepper);
    return constantTimeEquals_(candidate, parts[2].toLowerCase());
  }

  // Plaintext compatibility path for legacy Master_User rows that have not yet
  // been migrated with hashMasterUserPasswords(). After migration all rows are
  // sha256$salt$hash and this branch is never reached.
  return constantTimeEquals_(password, stored);
}

function hashMasterUserPasswords() {
  var props = getScriptProperties_();
  var pepper = props.getProperty(CONFIG_KEYS_.PASSWORD_PEPPER);
  if (!pepper) throw new Error("Set PASSWORD_PEPPER pada Script Properties sebelum migrasi password.");

  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.USERS);
  if (!sheet) throw new Error("Sheet Master_User tidak ditemukan.");

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { status: "success", migrated: 0 };

  var range = sheet.getRange(2, 2, lastRow - 1, 1);
  var values = range.getDisplayValues();
  var migrated = 0;
  for (var i = 0; i < values.length; i++) {
    var current = String(values[i][0] || "");
    if (!current || current.indexOf("sha256$") === 0) continue;
    var salt = Utilities.getUuid().replace(/-/g, "");
    values[i][0] = "sha256$" + salt + "$" + sha256Hex_(salt + current + pepper);
    migrated++;
  }
  range.setValues(values);
  SpreadsheetApp.flush();
  return { status: "success", migrated: migrated };
}

function getBootstrapData_() {
  var salaryPayload = readMasterGaji_();
  if (salaryPayload.status !== "success") return salaryPayload;
  return {
    status: "success",
    gajiPNS: salaryPayload.gajiPNS,
    gajiPPPK: salaryPayload.gajiPPPK,
    errorMsg: ""
  };
}

function readMasterGaji_() {
  var result = { status: "success", gajiPNS: [], gajiPPPK: [], errorMsg: "" };
  try {
    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.SALARIES);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Master_Gaji_Pangkat tidak ditemukan.");

    var range = sheet.getDataRange();
    var rawRows = range.getValues();
    var displayRows = range.getDisplayValues();
    var headers = displayRows[0] || [];

    for (var i = 1; i < rawRows.length; i++) {
      var statusPegawai = String(displayRows[i][0] || "").trim().toUpperCase();
      var pangkat = cleanText_(displayRows[i][1], 120);
      if ((statusPegawai !== "PNS" && statusPegawai !== "PPPK") || !pangkat) continue;

      for (var j = 2; j < headers.length; j++) {
        var match = String(headers[j]).match(/MKG\s*(\d+)\s*Tahun/i);
        if (!match) continue;
        var nominal = normalizeNominalGaji_(rawRows[i][j], displayRows[i][j]);
        if (nominal === null || nominal === "0") continue;
        var item = { mkg: Number(match[1]), pangkat: pangkat, nominal: nominal };
        (statusPegawai === "PNS" ? result.gajiPNS : result.gajiPPPK).push(item);
      }
    }
  } catch (error) {
    result.status = "error";
    result.errorCode = error && error.code ? error.code : "DATA_ERROR";
    result.errorMsg = publicErrorMessage_(error);
  }
  return result;
}

function listLetters_() {
  var result = { status: "success", data: [], errorMsg: "" };
  try {
    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.LETTERS);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Database_Surat tidak ditemukan.");
    validateLetterSheet_(sheet);

    var rows = sheet.getDataRange().getDisplayValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (!String(rows[i][1] || "").trim()) continue;
      result.data.push(rowToLetter_(rows[i]));
    }
  } catch (error) {
    result.status = "error";
    result.errorCode = error && error.code ? error.code : "DATA_ERROR";
    result.errorMsg = publicErrorMessage_(error);
  }
  return result;
}

function createLetter_(payload, session, rawRequestId) {
  // Validate requestId before taking the lock so invalid values are rejected early.
  var requestId = null;
  if (rawRequestId !== undefined && rawRequestId !== null && String(rawRequestId).trim() !== "") {
    requestId = validateRequestId_(rawRequestId);
    if (!requestId) {
      throw appError_("VALIDATION_ERROR", "requestId tidak valid. Gunakan UUID atau token aman (alphanum, hyphens, underscores, maks 100 karakter).");
    }
  }

  var letter = validateAndNormalizeLetter_(payload);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: re-validate actor inside the letter lock before any mutation.
    revalidateActorInLock_(session);

    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.LETTERS);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Database_Surat tidak ditemukan.");
    validateLetterSheet_(sheet);

    if (requestId) {
      // Idempotency path: derive deterministic ID from requestId.
      var derivedId = deriveLetterIdFromRequestId_(requestId);
      var found = findLetterRowByIdInSheet_(sheet, derivedId);
      if (found.rowIndex !== -1) {
        // Row already exists — return existing data without appending.
        var existing = rowToLetter_(found.rowData);
        console.info("Letter create idempotent", JSON.stringify({ id: derivedId, actor: session.username }));
        return { status: "success", data: existing, idempotent: true };
      }
      // Not found: assign the derived ID and append.
      letter.id = derivedId;
    } else {
      // Legacy path: generate a unique random ID.
      letter.id = createUniqueLetterId_(sheet);
    }

    var row = [new Date()];
    for (var i = 0; i < LETTER_FIELDS_.length; i++) {
      row.push(safeSheetValue_(letter[LETTER_FIELDS_[i]]));
    }
    sheet.appendRow(row);
    SpreadsheetApp.flush();

    console.info("Letter created", JSON.stringify({ id: letter.id, actor: session.username }));
    return { status: "success", data: letter };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function deleteLetter_(id, session) {
  var recordId = validateLetterId_(id);
  if (!recordId) throw appError_("VALIDATION_ERROR", "ID surat tidak valid.");

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: re-validate actor inside the lock. Also get live role for delete authorization.
    var liveRole = revalidateActorInLock_(session);
    if (liveRole !== "admin") {
      throw appError_("FORBIDDEN", "Hanya administrator yang dapat menghapus arsip.");
    }

    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.LETTERS);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Database_Surat tidak ditemukan.");
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: "not_found", errorMsg: "Data surat tidak ditemukan." };

    var ids = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0] || "").trim() === recordId) {
        sheet.deleteRow(i + 2);
        SpreadsheetApp.flush();
        console.info("Letter deleted", JSON.stringify({ id: recordId, actor: session.username }));
        return { status: "success", id: recordId };
      }
    }
    return { status: "not_found", errorMsg: "Data surat tidak ditemukan atau sudah dihapus." };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function updateLetter_(id, payload, session) {
  var recordId = validateLetterId_(id);
  if (!recordId) throw appError_("VALIDATION_ERROR", "ID surat tidak valid.");

  // Strip any id the payload may carry so caller cannot change the record ID.
  var safePayload = {};
  for (var k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) safePayload[k] = payload[k];
  }
  delete safePayload.id;

  var letter = validateAndNormalizeLetter_(safePayload);
  // Ensure id field in normalized result is always the URL id, not payload id.
  letter.id = recordId;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: re-validate actor inside the letter lock before any mutation.
    revalidateActorInLock_(session);

    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.LETTERS);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Database_Surat tidak ditemukan.");
    validateLetterSheet_(sheet);

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: "not_found", errorMsg: "Data surat tidak ditemukan." };

    var ids = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || "").trim() !== recordId) continue;

      var sheetRow = i + 2;
      // Build mutable columns: LETTER_FIELDS_ skipping index 0 (id).
      // Sheet layout: col A = timestamp, col B = id, col C onwards = rest of LETTER_FIELDS_.
      var mutablValues = [];
      for (var j = 1; j < LETTER_FIELDS_.length; j++) {
        mutablValues.push(safeSheetValue_(letter[LETTER_FIELDS_[j]]));
      }
      // Write from col C (column 3) to cover all mutable fields.
      sheet.getRange(sheetRow, 3, 1, mutablValues.length).setValues([mutablValues]);
      SpreadsheetApp.flush();

      console.info("Letter updated", JSON.stringify({ id: recordId, actor: session.username }));
      return { status: "success", data: letter };
    }
    return { status: "not_found", errorMsg: "Data surat tidak ditemukan atau sudah dihapus." };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function validateAndNormalizeLetter_(payload) {
  var required = [
    "statusPegawai", "nama", "nip", "pangkat", "jabatan", "unit", "skPejabat",
    "skTanggal", "skNomor", "skTmt", "gajiLama", "gajiBaruTmt", "gajiBaru", "suratNomor",
    "suratTanggal", "signJabatan", "signNama", "signPangkat", "signNip"
  ];
  var result = {};
  for (var i = 0; i < LETTER_FIELDS_.length; i++) {
    var field = LETTER_FIELDS_[i];
    result[field] = cleanText_(payload[field], field === "unit" || field === "jabatan" ? 300 : 180);
  }

  for (var j = 0; j < required.length; j++) {
    if (!result[required[j]]) throw appError_("VALIDATION_ERROR", "Field " + required[j] + " wajib diisi.");
  }
  if (result.statusPegawai !== "PNS" && result.statusPegawai !== "PPPK") {
    throw appError_("VALIDATION_ERROR", "Status pegawai tidak valid.");
  }
  ["skTanggal", "skTmt", "gajiBaruTmt", "suratTanggal"].forEach(function(fieldName) {
    if (!isCalendarDate_(result[fieldName])) {
      throw appError_("VALIDATION_ERROR", "Format tanggal " + fieldName + " tidak valid.");
    }
  });
  var mkRules = [
    { field: "mkLamaThn", min: 0, max: 40 },
    { field: "mkLamaBln", min: 0, max: 11 },
    { field: "mkBaruThn", min: 1, max: 40 },
    { field: "mkBaruBln", min: 0, max: 11 }
  ];
  for (var r = 0; r < mkRules.length; r++) {
    var rule = mkRules[r];
    var val = result[rule.field];
    if (!/^\d{1,3}$/.test(val)) {
      throw appError_("VALIDATION_ERROR", "Nilai masa kerja " + rule.field + " tidak valid.");
    }
    var num = Number(val);
    if (num < rule.min || num > rule.max) {
      throw appError_("VALIDATION_ERROR", "Nilai masa kerja " + rule.field + " harus antara " + rule.min + " dan " + rule.max + ".");
    }
  }
  result.ukuranKertas = result.ukuranKertas === "a4" ? "a4" : "legal";
  return result;
}

function rowToLetter_(row) {
  var letter = {};
  for (var i = 0; i < LETTER_FIELDS_.length; i++) {
    var value = row[i + 1];
    if (["skTanggal", "skTmt", "gajiBaruTmt", "suratTanggal"].indexOf(LETTER_FIELDS_[i]) !== -1) {
      value = normalizeDateForClient_(value);
    }
    letter[LETTER_FIELDS_[i]] = String(value == null ? "" : value).trim();
  }
  letter.mkLamaThn = letter.mkLamaThn || "0";
  letter.mkLamaBln = letter.mkLamaBln || "0";
  letter.mkBaruThn = letter.mkBaruThn || "0";
  letter.mkBaruBln = letter.mkBaruBln || "0";
  letter.ukuranKertas = (letter.ukuranKertas || "legal").toLowerCase();
  return letter;
}

function validateLetterSheet_(sheet) {
  if (sheet.getMaxColumns() < LETTER_FIELDS_.length + 1) {
    throw appError_("SCHEMA_ERROR", "Database_Surat harus memiliki kolom A sampai AA.");
  }
}

function createUniqueLetterId_(sheet) {
  var existing = {};
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
    ids.forEach(function(row) { existing[String(row[0] || "").trim()] = true; });
  }
  var id;
  do {
    id = "KGB-" + new Date().getFullYear() + "-" + Utilities.getUuid();
  } while (existing[id]);
  return id;
}

/**
 * validateRequestId_ — validates a client-supplied idempotency key.
 *
 * Accepts:
 *   - Standard UUID v4 (case-insensitive, with or without hyphens)
 *   - Safe opaque token: 1–100 chars, only [A-Za-z0-9\-_] (alphanumeric, hyphens, underscores)
 *
 * Rejects anything else (dots, slashes, spaces, control chars, oversized).
 * Returns the trimmed, lowercased canonical form on success, or null if invalid.
 *
 * The derived letter ID will be "KGB-<YYYY>-<requestId>" which is ≤ 4+1+4+1+100 = 110 chars,
 * safely within validateLetterId_'s 200-char ceiling and within its safe charset
 * ([A-Za-z0-9._\-/ \s] — hyphens are allowed).
 */
function validateRequestId_(raw) {
  if (raw == null) return null;
  var id = String(raw).trim();
  if (!id || id.length > 100) return null;
  // Only alphanum, hyphens, underscores — safe for KGB-YYYY-<id> composite.
  if (!/^[A-Za-z0-9\-_]+$/.test(id)) return null;
  return id.toLowerCase();
}

/**
 * deriveLetterIdFromRequestId_ — computes the deterministic letter ID for a requestId.
 * Format: "KGB-<current year>-<canonicalRequestId>"
 * The composite stays within validateLetterId_'s 200-char limit.
 */
function deriveLetterIdFromRequestId_(requestId) {
  return "KGB-" + new Date().getFullYear() + "-" + requestId;
}

/**
 * findLetterRowByIdInSheet_ — scans sheet col B for the given ID inside an
 * already-held ScriptLock, returning the row index (1-based) or -1 if not found.
 * Also returns the matching row data for idempotent response construction.
 */
function findLetterRowByIdInSheet_(sheet, letterId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rowIndex: -1, rowData: null };
  var ids = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "").trim() === letterId) {
      // Fetch the full row for idempotent response.
      var fullRow = sheet.getRange(i + 2, 1, 1, LETTER_FIELDS_.length + 1).getDisplayValues()[0];
      return { rowIndex: i + 2, rowData: fullRow };
    }
  }
  return { rowIndex: -1, rowData: null };
}

function createSessionToken_(user) {
  var now = Math.floor(Date.now() / 1000);
  var payload = {
    username: user.username,
    namaLengkap: user.namaLengkap,
    hakAkses: user.hakAkses,
    iat: now,
    exp: now + SESSION_TTL_SECONDS_,
    nonce: Utilities.getUuid()
  };
  // Embed credential version when provided by login_. sv is a short derived
  // fingerprint of the stored password hash + role — it does NOT expose the
  // stored password. Users.* operations verify sv against the live sheet row.
  if (user.sv) payload.sv = user.sv;
  var encoded = base64UrlEncode_(JSON.stringify(payload));
  return encoded + "." + signValue_(encoded);
}

function requireSession_(token) {
  var parts = String(token || "").split(".");
  if (parts.length !== 2 || !constantTimeEquals_(signValue_(parts[0]), parts[1])) {
    throw appError_("AUTH_REQUIRED", "Sesi tidak valid. Silakan login kembali.");
  }
  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    throw appError_("AUTH_REQUIRED", "Sesi tidak valid. Silakan login kembali.");
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw appError_("SESSION_EXPIRED", "Sesi telah berakhir. Silakan login kembali.");
  }
  return payload;
}

/**
 * requireCurrentSession_ — unified live-session gate for all authenticated endpoints.
 *
 * Steps:
 *   1. Validate token signature and expiry (requireSession_).
 *   2. Require sv field — tokens without sv (issued before v2.3+) are rejected.
 *   3. Open Master_User, validateUserSheet_, find actor row.
 *   4. Verify actor account still exists.
 *   5. Verify sv matches current credential state (storedPassword + role fingerprint).
 *      This detects stale tokens after password reset, role change, or deletion.
 *   6. If requireAdmin=true: verify current live role is "admin" (not just token role).
 *
 * Returns the decoded session payload enriched with liveRole and liveNama from sheet.
 *
 * Used by ALL authenticated actions: letters.* and users.*
 * letters.* pass requireAdmin=false; users.* pass requireAdmin=true.
 */
function requireCurrentSession_(token, requireAdmin) {
  var session = requireSession_(token);

  // sv mandatory for all authenticated endpoints post-v2.4.
  // Tokens without sv were issued by an older deployment and must re-login.
  if (!session.sv) {
    throw appError_("AUTH_REQUIRED", "Sesi tidak memiliki versi credential. Silakan login ulang.");
  }

  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.USERS);
  if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Master_User tidak ditemukan.");
  validateUserSheet_(sheet);

  var rows = sheet.getDataRange().getDisplayValues();
  var rowIdx = findUserRowIndex_(rows, session.username);
  if (rowIdx === -1) {
    throw appError_("AUTH_REQUIRED", "Akun tidak ditemukan. Silakan login kembali.");
  }

  var currentRole = normalizeHakAkses_(String(rows[rowIdx][3] || "")) || "pengelola";
  var currentSv = computeSessionVersion_(String(rows[rowIdx][1] || ""), currentRole);
  if (!constantTimeEquals_(session.sv, currentSv)) {
    throw appError_("AUTH_REQUIRED", "Sesi tidak lagi valid. Silakan login kembali.");
  }

  if (requireAdmin && currentRole !== "admin") {
    throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");
  }

  // Return enriched payload with live values so callers see current state.
  session.liveRole = currentRole;
  session.liveNama = String(rows[rowIdx][2] || "").trim() || session.username;
  // Expose live sheet rows for TOCTOU-safe callers that need to act inside lock.
  session._actorRowIdx = rowIdx;
  session._liveRows = rows;
  session._liveSheet = sheet;
  return session;
}

/**
 * requireAdminSession_ is kept as an alias for backward compatibility with
 * any direct call sites that remain. It delegates to requireCurrentSession_.
 */
function requireAdminSession_(token) {
  return requireCurrentSession_(token, true);
}

/**
 * Computes a short deterministic session-version fingerprint from the stored
 * password/hash string and the canonical role. Used to bind a token to the
 * credential state at login time.
 *
 * The fingerprint is the first 16 hex chars of SHA-256(storedPassword + "|" + role).
 * This is NOT the password hash itself: the stored value going in is already
 * "sha256$salt$hash" (or a plaintext legacy value), so the fingerprint cannot
 * be used to verify passwords. It merely lets the server detect that a credential
 * mutation (password reset, role change) has occurred since the token was issued.
 *
 * The role component ensures that a role downgrade is also detectable.
 */
function computeSessionVersion_(storedPasswordField, canonicalRole) {
  return sha256Hex_(storedPasswordField + "|" + String(canonicalRole || "")).substring(0, 16);
}

// ─── Login Throttle (ScriptLock-protected, bounded persistent state) ────────
//
// Architecture:
//   Authoritative store: one bounded JSON value in Script Properties.
//   CacheService is only a best-effort read-through optimization.
//   Concurrency   : Every read-modify-write on the counter is wrapped in a
//     ScriptLock (separate from the user-mutation lock) to prevent races.
//     The lock is ONLY acquired for throttle operations, never held simultaneously
//     with the user-mutation lock, avoiding deadlock.
//
// Failure policy:
//   - CacheService AND PropertiesService unavailable → fail-closed: treat as
//     throttled (TOO_MANY_ATTEMPTS). Availability impact is bounded: users may
//     attempt login again after any GAS execution completes the lock.
//   - Individual cache/property read errors inside a locked section → still
//     fail-closed for that attempt; the next attempt re-tries normally.
//
// Usernames are stored only as sha256Hex(username).substring(0,32) prefixed "lt_".

var THROTTLE_MAX_ATTEMPTS_ = 5;
var THROTTLE_WINDOW_SECONDS_ = 5 * 60; // 5-minute window, resets on success
var THROTTLE_STATE_PROPERTY_ = "LOGIN_THROTTLE_STATE_V1";
var THROTTLE_MAX_ENTRIES_ = 200;

function throttleCacheKey_(username) {
  return "lt_" + sha256Hex_(String(username || "")).substring(0, 32);
}

function throttlePropCountKey_(hashed) {
  return hashed; // compatibility helper retained for existing diagnostics/tests
}

function throttlePropTtlKey_(hashed) {
  return "ltt_" + hashed; // compatibility helper; no longer persisted per user
}

/**
 * Gets the ScriptLock for throttle operations.
 * Returns null if LockService is unavailable or getScriptLock throws.
 * Callers must treat null as "lock unavailable" and apply fail-closed policy.
 */
function getThrottleLock_() {
  try {
    if (!LockService || !LockService.getScriptLock) return null;
    return LockService.getScriptLock();
  } catch (e) {
    return null;
  }
}

function getThrottleCache_() {
  try {
    return CacheService && CacheService.getScriptCache ? CacheService.getScriptCache() : null;
  } catch (e) {
    return null;
  }
}

function loadThrottleState_() {
  var props = getScriptProperties_();
  var raw = props.getProperty(THROTTLE_STATE_PROPERTY_);
  var state = {};
  if (raw) {
    try {
      state = JSON.parse(raw);
    } catch (e) {
      throw appError_("CONFIG_ERROR", "State login throttle rusak.");
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw appError_("CONFIG_ERROR", "State login throttle tidak valid.");
    }
  }

  var now = Date.now();
  var changed = false;
  Object.keys(state).forEach(function (entryKey) {
    var entry = state[entryKey];
    if (!/^lt_[a-f0-9]{32}$/.test(entryKey) || !entry ||
        !isFinite(Number(entry.count)) || Number(entry.count) < 0 ||
        !isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) <= now) {
      delete state[entryKey];
      changed = true;
    }
  });
  if (Object.keys(state).length > THROTTLE_MAX_ENTRIES_) {
    throw appError_("CONFIG_ERROR", "State login throttle melebihi batas aman.");
  }
  return { props: props, state: state, changed: changed };
}

function persistThrottleState_(loaded) {
  try {
    var keys = Object.keys(loaded.state);
    if (keys.length === 0) loaded.props.deleteProperty(THROTTLE_STATE_PROPERTY_);
    else loaded.props.setProperty(THROTTLE_STATE_PROPERTY_, JSON.stringify(loaded.state));
    return true;
  } catch (e) {
    return false;
  }
}

/** Reads the target counter after globally removing expired entries. */
function readThrottleCount_(key) {
  try {
    var loaded = loadThrottleState_();
    if (loaded.changed && !persistThrottleState_(loaded)) {
      return { count: THROTTLE_MAX_ATTEMPTS_, source: "error" };
    }
    var entry = loaded.state[key];
    if (!entry) return { count: 0, source: "none" };
    var count = Number(entry.count);
    var cache = getThrottleCache_();
    if (cache) {
      try {
        var remainingSeconds = Math.max(1, Math.ceil((Number(entry.expiresAt) - Date.now()) / 1000));
        cache.put(key, String(count), remainingSeconds);
      } catch (_) {}
    }
    return { count: count, source: "props" };
  } catch (e) {
    return { count: THROTTLE_MAX_ATTEMPTS_, source: "error" };
  }
}

/**
 * Writes the updated count atomically inside a lock.
 * Returns true only after the authoritative Properties write succeeds.
 * Caller must already hold the throttle lock.
 *
 * Properties partial-write safety: if the count key write succeeds but the TTL
 * key write fails, the count key is deleted to prevent a stale entry with no
 * expiry being read as a valid non-zero count on the next request.
 */
function writeThrottleCount_(key, count) {
  try {
    var loaded = loadThrottleState_();
    // Never evict an active account counter for an attacker-controlled new key.
    // When the bounded state is full, new usernames fail closed until an entry
    // expires or a successful login clears its own counter.
    if (!loaded.state[key] && Object.keys(loaded.state).length >= THROTTLE_MAX_ENTRIES_) {
      return false;
    }
    loaded.state[key] = {
      count: Number(count),
      expiresAt: Date.now() + THROTTLE_WINDOW_SECONDS_ * 1000
    };
    if (!persistThrottleState_(loaded)) return false;

    // Cache is read-through only. Its failure cannot invalidate persistence.
    var cache = getThrottleCache_();
    if (cache) {
      try { cache.put(key, String(count), THROTTLE_WINDOW_SECONDS_); } catch (_) {}
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Clears throttle state from both stores. Caller must hold throttle lock.
 */
function clearThrottleCount_(key) {
  var cache = getThrottleCache_();
  if (cache) { try { cache.remove(key); } catch (e) {} }
  try {
    var loaded = loadThrottleState_();
    delete loaded.state[key];
    persistThrottleState_(loaded);
  } catch (e) {}
}

function isLoginThrottled_(username) {
  var key = throttleCacheKey_(username);
  var lock = getThrottleLock_();
  if (lock) {
    try {
      lock.waitLock(5000);
    } catch (e) {
      // Could not acquire lock — fail-closed.
      return true;
    }
  }
  try {
    return readThrottleCount_(key).count >= THROTTLE_MAX_ATTEMPTS_;
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function recordLoginFailure_(username) {
  var key = throttleCacheKey_(username);
  var lock = getThrottleLock_();
  if (lock) {
    try {
      lock.waitLock(5000);
    } catch (e) {
      // Could not acquire lock — still record best-effort without lock.
    }
  }
  try {
    var result = readThrottleCount_(key);
    if (result.source !== "error") {
      writeThrottleCount_(key, result.count + 1);
    }
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function clearLoginThrottle_(username) {
  var key = throttleCacheKey_(username);
  var lock = getThrottleLock_();
  if (lock) {
    try {
      lock.waitLock(5000);
    } catch (e) {
      // Best-effort.
    }
  }
  try {
    clearThrottleCount_(key);
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

/**
 * consumeLoginAttempt_ — atomic read-check-increment for login throttle.
 *
 * Fail-closed policy (returns {allowed:false}) when:
 *   - getThrottleLock_() returns null (LockService unavailable or throws)
 *   - lock.waitLock() throws (cannot acquire within timeout)
 *   - readThrottleCount_ returns source:"error" (both stores failed on read)
 *   - count >= THROTTLE_MAX_ATTEMPTS_ (rate limit reached)
 *   - writeThrottleCount_() returns false (reservation could not be persisted)
 *
 * The write-failure case is critical: if we allowed the attempt without a
 * successful write, concurrent requests could all read count=0 (stores
 * degraded but readable) and all proceed to password verification — defeating
 * the rate limit. Fail-closed on write ensures the limit is enforced.
 *
 * On successful login, clearLoginThrottle_() frees the reserved slot.
 * On failed login, the slot remains consumed — login_ must NOT call
 * recordLoginFailure_ afterwards (no double-increment).
 */
function consumeLoginAttempt_(username) {
  var key = throttleCacheKey_(username);
  var lock = getThrottleLock_();

  // Lock unavailable → cannot guarantee atomicity → fail-closed.
  if (!lock) {
    return { allowed: false };
  }

  try {
    lock.waitLock(5000);
  } catch (e) {
    // Cannot acquire lock — fail-closed.
    return { allowed: false };
  }

  try {
    var result = readThrottleCount_(key);
    if (result.source === "error") {
      // Both stores unavailable on read — fail-closed.
      return { allowed: false };
    }
    if (result.count >= THROTTLE_MAX_ATTEMPTS_) {
      return { allowed: false };
    }
    // Reserve the slot by incrementing now, before password verification.
    // If the write fails, do not allow the attempt — fail-closed.
    var written = writeThrottleCount_(key, result.count + 1);
    if (!written) {
      return { allowed: false };
    }
    return { allowed: true };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function signValue_(value) {
  var signature = Utilities.computeHmacSha256Signature(value, getSessionSecret_());
  return Utilities.base64EncodeWebSafe(signature).replace(/=+$/g, "");
}

function getSessionSecret_() {
  var props = getScriptProperties_();
  var secret = props.getProperty(CONFIG_KEYS_.SESSION_SIGNING_SECRET);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(CONFIG_KEYS_.SESSION_SIGNING_SECRET, secret);
  }
  return secret;
}

function verifyCloudflareSecret_(candidate) {
  var expected = getScriptProperties_().getProperty(CONFIG_KEYS_.CLOUDFLARE_API_SECRET);
  if (!expected) throw appError_("CONFIG_ERROR", "Integrasi Cloudflare belum dikonfigurasi.");
  if (!constantTimeEquals_(String(candidate || ""), expected)) {
    throw appError_("UNAUTHORIZED_GATEWAY", "Request gateway tidak valid.");
  }
}

function parseHttpRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw appError_("BAD_REQUEST", "Request body tidak tersedia.");
  }
  if (e.postData.contents.length > 65536) throw appError_("PAYLOAD_TOO_LARGE", "Payload terlalu besar.");
  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throw appError_("BAD_REQUEST", "Request JSON tidak valid.");
  }
}

function getSpreadsheet_() {
  var id = getScriptProperties_().getProperty(CONFIG_KEYS_.SPREADSHEET_ID) || DEFAULT_SPREADSHEET_ID_;
  return SpreadsheetApp.openById(id);
}

function getScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function safeJsonForHtml_(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function normalizeNominalGaji_(rawValue, displayValue) {
  if (typeof rawValue === "number" && isFinite(rawValue)) return String(rawValue);
  var text = String(displayValue || rawValue || "").trim();
  if (!text) return null;
  var digits = text.replace(/[^0-9]/g, "");
  return digits || null;
}

function normalizeDateForClient_(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  var local = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (local) return local[3] + "-" + pad2_(local[2]) + "-" + pad2_(local[1]);
  return text;
}

function cleanText_(value, maxLength) {
  return String(value == null ? "" : value).trim().substring(0, maxLength || 200);
}

function safeSheetValue_(value) {
  var text = String(value == null ? "" : value);
  return /^[=+@-]/.test(text) ? "'" + text : text;
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function(byte) { return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"); })
    .join("");
}

function base64UrlEncode_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/g, "");
}

function constantTimeEquals_(left, right) {
  left = String(left || "");
  right = String(right || "");
  var mismatch = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var i = 0; i < length; i++) mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return mismatch === 0;
}

function pad2_(value) {
  return ("0" + String(value)).slice(-2);
}

/**
 * Validates a letter record ID received from the client.
 * Trims whitespace, then rejects if empty, longer than 200 chars, or
 * contains characters outside the safe set (letters, digits, hyphens,
 * forward slashes, underscores, dots, and spaces).  The 200-char ceiling
 * is generous enough for any existing KGB-YYYY-<UUID> ID (≤ 46 chars)
 * and any plausible legacy ID, while still blocking oversized inputs.
 * Returns the trimmed id on success, or null if invalid.
 */
function validateLetterId_(raw) {
  var id = String(raw == null ? "" : raw).trim();
  if (!id) return null;
  if (id.length > 200) return null;
  // Allow letters (including accented), digits, hyphen, slash, underscore, dot, space.
  if (/[^\w\s\-./]/.test(id)) return null;
  return id;
}

/**
 * Returns true only when the string is a calendar-valid ISO date (YYYY-MM-DD).
 * Rejects dates like 2024-02-30 or 2024-13-01 that pass a simple regex.
 */
function isCalendarDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var parts = value.split("-");
  var year  = Number(parts[0]);
  var month = Number(parts[1]);
  var day   = Number(parts[2]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  // Use the "day-overflow" trick: construct month+1 day-0 equals last day of month.
  var lastDay = new Date(year, month, 0).getDate();
  return day <= lastDay;
}

function appError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function publicErrorMessage_(error) {
  var allowed = [
    "BAD_REQUEST", "PAYLOAD_TOO_LARGE", "ACTION_NOT_FOUND", "VALIDATION_ERROR", "AUTH_REQUIRED",
    "SESSION_EXPIRED", "FORBIDDEN", "UNAUTHORIZED_GATEWAY", "CONFIG_ERROR", "SCHEMA_ERROR", "DATA_ERROR",
    "DUPLICATE_USER", "NOT_FOUND", "LAST_ADMIN_PROTECTED", "TOO_MANY_ATTEMPTS"
  ];
  if (error && allowed.indexOf(error.code) !== -1) return error.message;
  return "Layanan sedang mengalami kendala. Silakan coba kembali.";
}

// ─── User Management Domain Logic ──────────────────────────────────────────

/**
 * Normalises hakAkses: "administrator" → "admin"; only "admin" and "pengelola" are valid.
 * Returns the normalised value or null if invalid.
 */
function normalizeHakAkses_(raw) {
  var v = cleanText_(raw, 50).toLowerCase();
  if (v === "administrator") return "admin";
  if (v === "admin" || v === "pengelola") return v;
  return null;
}

/**
 * revalidateActorInLock_ — re-reads Master_User inside an already-held lock and
 * verifies that the actor's account still exists, the sv still matches the live
 * credential state, and the actor still has the minimum required role.
 *
 * Called by letter create/update/delete AND user mutations so that a concurrent
 * execution that deletes or downgrades the actor between requireCurrentSession_
 * and the lock acquisition cannot sneak through.
 *
 * IMPORTANT: This function reads the Master_User sheet, not the letters sheet.
 * The caller holds a ScriptLock, so this read is protected from concurrent
 * writes to Master_User. There is no nested lock.
 *
 * Returns the live canonical role ("admin" or "pengelola") so callers can use
 * it for authorization decisions (e.g. deleteLetter_ checks role === "admin").
 *
 * Throws AUTH_REQUIRED if the account is gone or sv mismatches.
 * Throws FORBIDDEN if requireAdmin=true and live role is not "admin".
 */
function revalidateActorInLock_(session, requireAdmin) {
  var userSheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.USERS);
  if (!userSheet) throw appError_("CONFIG_ERROR", "Sheet Master_User tidak ditemukan.");
  validateUserSheet_(userSheet);

  var rows = userSheet.getDataRange().getDisplayValues();
  var rowIdx = findUserRowIndex_(rows, session.username);
  if (rowIdx === -1) {
    throw appError_("AUTH_REQUIRED", "Akun tidak ditemukan. Silakan login kembali.");
  }

  var liveRole = normalizeHakAkses_(String(rows[rowIdx][3] || "")) || "pengelola";
  var liveSv = computeSessionVersion_(String(rows[rowIdx][1] || ""), liveRole);
  if (!constantTimeEquals_(session.sv, liveSv)) {
    throw appError_("AUTH_REQUIRED", "Sesi tidak lagi valid. Silakan login kembali.");
  }

  if (requireAdmin && liveRole !== "admin") {
    throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");
  }

  return liveRole;
}

/**
 * Returns true when the session role is admin (or administrator, normalised).
 */
function isAdmin_(session) {
  return normalizeHakAkses_(session.hakAkses) === "admin";
}

/**
 * Validates a NEW username (create): strict charset, 1–64 chars, no truncation.
 * Does NOT call cleanText_ (which truncates); validates the raw trimmed value.
 * Returns the trimmed username on success, or null if invalid.
 */
function validateUsername_(raw) {
  var u = String(raw == null ? "" : raw).trim();
  // Reject empty, oversized, or oversized-before-trim to avoid silent truncation.
  if (!u || u.length > 64) return null;
  // Must start with letter or digit; only word chars, dot, hyphen allowed.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-]*$/.test(u)) return null;
  return u;
}

/**
 * Validates a TARGET username for update/resetPassword/delete operations.
 * More permissive than validateUsername_ to accommodate legacy usernames that
 * may contain spaces or other characters outside the strict create-charset.
 * Rules:
 *   - Trim whitespace; reject control characters (ASCII 0-31).
 *   - Reject empty or length > 100.
 *   - URL always wins over body (enforced in the gateway/dispatcher, not here).
 * Returns the trimmed username on success, or null if invalid.
 */
function validateUsernameTarget_(raw) {
  var u = String(raw == null ? "" : raw).trim();
  if (!u || u.length > 100) return null;
  // Reject control characters.
  if (/[\x00-\x1F]/.test(u)) return null;
  return u;
}

/**
 * Validates that the Master_User sheet has at least 4 columns and that the
 * header row (row 1) contains recognisable column identifiers in positions A–D.
 * Accepted header values (case-insensitive, trimmed):
 *   Col A: username
 *   Col B: password (legacy: "password", "hash", "kata sandi")
 *   Col C: namaLengkap (legacy: "nama lengkap", "nama", "nama_lengkap")
 *   Col D: hakAkses   (legacy: "hak akses", "hak_akses", "role", "akses")
 *
 * Throws SCHEMA_ERROR if the sheet is structurally invalid.
 * A sheet with only a header row (no data) is valid; it just has 0 users.
 */
function validateUserSheet_(sheet) {
  if (sheet.getMaxColumns() < 4) {
    throw appError_("SCHEMA_ERROR", "Master_User harus memiliki minimal 4 kolom (A: username, B: password, C: namaLengkap, D: hakAkses).");
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    throw appError_("SCHEMA_ERROR", "Master_User tidak memiliki baris header.");
  }
  var header = sheet.getRange(1, 1, 1, 4).getDisplayValues()[0];

  function matchHeader(cell, accepted) {
    var v = String(cell || "").trim().toLowerCase().replace(/[\s_]/g, "");
    for (var i = 0; i < accepted.length; i++) {
      if (v === accepted[i]) return true;
    }
    return false;
  }

  if (!matchHeader(header[0], ["username", "user", "namapengguna"])) {
    throw appError_("SCHEMA_ERROR", "Kolom A Master_User harus berheader 'username'.");
  }
  if (!matchHeader(header[1], ["password", "hash", "katasandi", "passwordhash"])) {
    throw appError_("SCHEMA_ERROR", "Kolom B Master_User harus berheader 'password' atau 'hash'.");
  }
  if (!matchHeader(header[2], ["namalengkap", "nama", "namalengkap", "fulname", "fullname"])) {
    throw appError_("SCHEMA_ERROR", "Kolom C Master_User harus berheader 'namaLengkap' atau 'nama'.");
  }
  if (!matchHeader(header[3], ["hakakses", "role", "akses", "access", "hak"])) {
    throw appError_("SCHEMA_ERROR", "Kolom D Master_User harus berheader 'hakAkses' atau 'role'.");
  }
}

/**
 * Reads and validates the Master_User sheet, returning the sheet object.
 */
function getUserSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.USERS);
  if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Master_User tidak ditemukan.");
  validateUserSheet_(sheet);
  return sheet;
}

/**
 * Hashes a password using sha256$salt$hash format with PASSWORD_PEPPER.
 * Format: "sha256$<32-hex-salt>$<64-hex-sha256-of-salt+password+pepper>"
 * The existing KDF is retained for compatibility. New rows always use this format.
 * Throws CONFIG_ERROR if pepper is not set.
 */
function hashPassword_(password) {
  var pepper = getScriptProperties_().getProperty(CONFIG_KEYS_.PASSWORD_PEPPER);
  if (!pepper) throw appError_("CONFIG_ERROR", "PASSWORD_PEPPER belum dikonfigurasi.");
  var salt = Utilities.getUuid().replace(/-/g, "");
  var hash = sha256Hex_(salt + password + pepper);
  return "sha256$" + salt + "$" + hash;
}

/**
 * Finds the row index (0-based in rows array) for a username, case-insensitive.
 * Returns -1 if not found.
 */
function findUserRowIndex_(rows, username) {
  var needle = String(username || "").trim().toLowerCase();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim().toLowerCase() === needle) return i;
  }
  return -1;
}

/**
 * Counts admin users in the rows array (normalises "administrator" → "admin").
 */
function countAdmins_(rows) {
  var count = 0;
  for (var i = 1; i < rows.length; i++) {
    if (normalizeHakAkses_(String(rows[i][3] || "")) === "admin") count++;
  }
  return count;
}

/**
 * Converts a sheet row to a safe user object (no password).
 */
function rowToUser_(row) {
  return {
    username: String(row[0] || "").trim(),
    namaLengkap: String(row[2] || "").trim(),
    hakAkses: normalizeHakAkses_(String(row[3] || "")) || "pengelola"
  };
}

function listUsers_(session) {
  // requireAdminSession_ is called in the public wrapper with the raw token.
  // Here session is already the decoded payload; re-check role for defence-in-depth.
  if (!isAdmin_(session)) throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");
  var sheet = getUserSheet_();
  var rows = sheet.getDataRange().getDisplayValues();
  var users = [];
  for (var i = 1; i < rows.length; i++) {
    var u = String(rows[i][0] || "").trim();
    if (!u) continue;
    users.push(rowToUser_(rows[i]));
  }
  return { status: "success", data: users };
}

function createUser_(payload, session) {
  if (!isAdmin_(session)) throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");

  var username = validateUsername_(payload.username);
  if (!username) throw appError_("VALIDATION_ERROR", "Username tidak valid. Gunakan huruf, angka, titik, underscore, atau strip (mulai dengan huruf/angka, maks 64 karakter).");

  var namaLengkap = cleanText_(payload.namaLengkap, 160);
  if (!namaLengkap) throw appError_("VALIDATION_ERROR", "Nama lengkap wajib diisi.");

  var hakAkses = normalizeHakAkses_(payload.hakAkses);
  if (!hakAkses) throw appError_("VALIDATION_ERROR", "Hak akses tidak valid. Nilai yang diterima: admin, pengelola.");

  var password = String(payload.password || "");
  if (password.length < 8) throw appError_("VALIDATION_ERROR", "Password minimal 8 karakter.");
  if (password.length > 200) throw appError_("VALIDATION_ERROR", "Password terlalu panjang (maks 200 karakter).");

  var passwordHash = hashPassword_(password);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: re-validate actor with a fresh sheet read inside the lock.
    revalidateActorInLock_(session, true);

    var sheet = getUserSheet_();
    var rows = sheet.getDataRange().getDisplayValues();

    if (findUserRowIndex_(rows, username) !== -1) {
      throw appError_("DUPLICATE_USER", "Username '" + username + "' sudah terdaftar.");
    }

    var newRow = [
      safeSheetValue_(username),
      safeSheetValue_(passwordHash),
      safeSheetValue_(namaLengkap),
      safeSheetValue_(hakAkses)
    ];
    sheet.appendRow(newRow);
    SpreadsheetApp.flush();

    console.info("User created", JSON.stringify({ username: username, actor: session.username }));
    return { status: "success", data: { username: username, namaLengkap: namaLengkap, hakAkses: hakAkses } };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function updateUser_(username, payload, session) {
  if (!isAdmin_(session)) throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");

  // Use the permissive target validator to support legacy usernames.
  var targetUsername = validateUsernameTarget_(username);
  if (!targetUsername) throw appError_("VALIDATION_ERROR", "Username target tidak valid.");

  var namaLengkap = cleanText_(payload.namaLengkap, 160);
  if (!namaLengkap) throw appError_("VALIDATION_ERROR", "Nama lengkap wajib diisi.");

  var hakAkses = normalizeHakAkses_(payload.hakAkses);
  if (!hakAkses) throw appError_("VALIDATION_ERROR", "Hak akses tidak valid. Nilai yang diterima: admin, pengelola.");

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: fresh actor re-validation inside lock.
    revalidateActorInLock_(session, true);

    var sheet = getUserSheet_();
    var rows = sheet.getDataRange().getDisplayValues();
    var rowIdx = findUserRowIndex_(rows, targetUsername);
    if (rowIdx === -1) throw appError_("NOT_FOUND", "Pengguna '" + targetUsername + "' tidak ditemukan.");

    // Protect last admin from role downgrade.
    var currentHakAkses = normalizeHakAkses_(String(rows[rowIdx][3] || "")) || "pengelola";
    if (currentHakAkses === "admin" && hakAkses !== "admin") {
      if (countAdmins_(rows) <= 1) {
        throw appError_("LAST_ADMIN_PROTECTED", "Tidak dapat menurunkan hak akses admin terakhir.");
      }
    }

    // Reject self role downgrade.
    if (String(targetUsername).toLowerCase() === String(session.username || "").toLowerCase() &&
        currentHakAkses === "admin" && hakAkses !== "admin") {
      throw appError_("FORBIDDEN", "Tidak dapat menurunkan hak akses diri sendiri.");
    }

    var sheetRow = rowIdx + 1; // 1-based
    // Update col C (namaLengkap = index 2) and col D (hakAkses = index 3), preserve A and B.
    sheet.getRange(sheetRow, 3, 1, 2).setValues([[safeSheetValue_(namaLengkap), safeSheetValue_(hakAkses)]]);
    SpreadsheetApp.flush();

    console.info("User updated", JSON.stringify({ username: targetUsername, actor: session.username }));
    return { status: "success", data: { username: targetUsername, namaLengkap: namaLengkap, hakAkses: hakAkses } };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function resetUserPassword_(username, payload, session) {
  if (!isAdmin_(session)) throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");

  var targetUsername = validateUsernameTarget_(username);
  if (!targetUsername) throw appError_("VALIDATION_ERROR", "Username target tidak valid.");

  var newPassword = String(payload.newPassword || "");
  if (newPassword.length < 8) throw appError_("VALIDATION_ERROR", "Password minimal 8 karakter.");
  if (newPassword.length > 200) throw appError_("VALIDATION_ERROR", "Password terlalu panjang (maks 200 karakter).");

  var passwordHash = hashPassword_(newPassword);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: fresh actor re-validation inside lock.
    revalidateActorInLock_(session, true);

    var sheet = getUserSheet_();
    var rows = sheet.getDataRange().getDisplayValues();
    var rowIdx = findUserRowIndex_(rows, targetUsername);
    if (rowIdx === -1) throw appError_("NOT_FOUND", "Pengguna '" + targetUsername + "' tidak ditemukan.");

    var sheetRow = rowIdx + 1;
    // Update col B (password = index 1) only.
    sheet.getRange(sheetRow, 2, 1, 1).setValues([[safeSheetValue_(passwordHash)]]);
    SpreadsheetApp.flush();

    console.info("User password reset", JSON.stringify({ username: targetUsername, actor: session.username }));
    return { status: "success", username: targetUsername };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function deleteUser_(username, session) {
  if (!isAdmin_(session)) throw appError_("FORBIDDEN", "Hanya administrator yang dapat mengelola pengguna.");

  var targetUsername = validateUsernameTarget_(username);
  if (!targetUsername) throw appError_("VALIDATION_ERROR", "Username target tidak valid.");

  // Reject self-delete (quick check before acquiring lock).
  if (String(targetUsername).toLowerCase() === String(session.username || "").toLowerCase()) {
    throw appError_("FORBIDDEN", "Tidak dapat menghapus akun yang sedang digunakan.");
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // TOCTOU: fresh actor re-validation inside lock.
    revalidateActorInLock_(session, true);

    var sheet = getUserSheet_();
    var rows = sheet.getDataRange().getDisplayValues();
    var rowIdx = findUserRowIndex_(rows, targetUsername);
    if (rowIdx === -1) throw appError_("NOT_FOUND", "Pengguna '" + targetUsername + "' tidak ditemukan.");

    // Protect last admin from deletion.
    var targetHakAkses = normalizeHakAkses_(String(rows[rowIdx][3] || "")) || "pengelola";
    if (targetHakAkses === "admin" && countAdmins_(rows) <= 1) {
      throw appError_("LAST_ADMIN_PROTECTED", "Tidak dapat menghapus admin terakhir.");
    }

    var sheetRow = rowIdx + 1;
    sheet.deleteRow(sheetRow);
    SpreadsheetApp.flush();

    console.info("User deleted", JSON.stringify({ username: targetUsername, actor: session.username }));
    return { status: "success", username: targetUsername };
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}
