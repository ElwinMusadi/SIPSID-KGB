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
 */
function doPost(e) {
  try {
    var request = parseHttpRequest_(e);
    verifyCloudflareSecret_(request.apiSecret);
    var result = dispatchHttpAction_(request);
    return jsonOutput_(result);
  } catch (error) {
    console.error("SIPSID API error", error);
    return jsonOutput_({
      status: "error",
      errorCode: error && error.code ? error.code : "INTERNAL_ERROR",
      errorMsg: publicErrorMessage_(error)
    });
  }
}

function apiLogin(credentials) {
  return login_(credentials || {});
}

function apiLogout() {
  return { status: "success" };
}

function apiGetBootstrap() {
  return getBootstrapData_();
}

function apiListLetters(sessionToken) {
  requireSession_(sessionToken);
  return listLetters_();
}

function apiCreateLetter(sessionToken, payload) {
  var session = requireSession_(sessionToken);
  return createLetter_(payload || {}, session);
}

function apiDeleteLetter(sessionToken, id) {
  var session = requireSession_(sessionToken);
  return deleteLetter_(id, session);
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
  if (action === "bootstrap.get") return getBootstrapData_();
  if (action === "letters.list") return apiListLetters(request.sessionToken);
  if (action === "letters.create") return apiCreateLetter(request.sessionToken, payload);
  if (action === "letters.delete") return apiDeleteLetter(request.sessionToken, payload.id);

  throw appError_("ACTION_NOT_FOUND", "Aksi API tidak dikenal.");
}

function login_(credentials) {
  var username = cleanText_(credentials.username, 100);
  var password = String(credentials.password || "");
  if (!username || !password) {
    return { status: "error", errorCode: "INVALID_CREDENTIALS", errorMsg: "Username atau password tidak valid." };
  }

  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.USERS);
  if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Master_User tidak ditemukan.");

  var rows = sheet.getDataRange().getDisplayValues();
  for (var i = 1; i < rows.length; i++) {
    var storedUsername = String(rows[i][0] || "").trim();
    if (storedUsername !== username) continue;

    if (!verifyPassword_(password, String(rows[i][1] || ""))) break;

    var user = {
      username: storedUsername,
      namaLengkap: cleanText_(rows[i][2], 160) || storedUsername,
      hakAkses: cleanText_(rows[i][3], 50).toLowerCase() || "pengelola"
    };
    return {
      status: "success",
      sessionToken: createSessionToken_(user),
      expiresIn: SESSION_TTL_SECONDS_,
      user: user
    };
  }

  return { status: "error", errorCode: "INVALID_CREDENTIALS", errorMsg: "Username atau password tidak valid." };
}

function verifyPassword_(password, storedPassword) {
  var stored = String(storedPassword || "");
  if (stored.indexOf("sha256$") === 0) {
    var parts = stored.split("$");
    if (parts.length !== 3) return false;
    var pepper = getScriptProperties_().getProperty(CONFIG_KEYS_.PASSWORD_PEPPER) || "";
    var candidate = sha256Hex_(parts[1] + password + pepper);
    return constantTimeEquals_(candidate, parts[2].toLowerCase());
  }

  // Compatibility for existing Master_User rows. Migrate with hashMasterUserPasswords().
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

function createLetter_(payload, session) {
  var letter = validateAndNormalizeLetter_(payload);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES_.LETTERS);
    if (!sheet) throw appError_("CONFIG_ERROR", "Sheet Database_Surat tidak ditemukan.");
    validateLetterSheet_(sheet);

    letter.id = createUniqueLetterId_(sheet);
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
  var recordId = cleanText_(id, 100);
  if (!recordId) throw appError_("VALIDATION_ERROR", "ID surat tidak valid.");
  if (session.hakAkses !== "admin") {
    throw appError_("FORBIDDEN", "Hanya administrator yang dapat menghapus arsip.");
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
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

function validateAndNormalizeLetter_(payload) {
  var required = [
    "statusPegawai", "nama", "nip", "pangkat", "jabatan", "unit", "kabkot", "skPejabat",
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result[fieldName])) {
      throw appError_("VALIDATION_ERROR", "Format tanggal " + fieldName + " tidak valid.");
    }
  });
  ["mkLamaThn", "mkLamaBln", "mkBaruThn", "mkBaruBln"].forEach(function(fieldName) {
    if (!/^\d{1,2}$/.test(result[fieldName])) {
      throw appError_("VALIDATION_ERROR", "Nilai masa kerja tidak valid.");
    }
  });
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

function appError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function publicErrorMessage_(error) {
  var allowed = [
    "BAD_REQUEST", "PAYLOAD_TOO_LARGE", "ACTION_NOT_FOUND", "VALIDATION_ERROR", "AUTH_REQUIRED",
    "SESSION_EXPIRED", "FORBIDDEN", "UNAUTHORIZED_GATEWAY", "CONFIG_ERROR", "SCHEMA_ERROR", "DATA_ERROR"
  ];
  if (error && allowed.indexOf(error.code) !== -1) return error.message;
  return "Layanan sedang mengalami kendala. Silakan coba kembali.";
}
