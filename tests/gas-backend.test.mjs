import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const codeJsPath = resolve(root, "Code.js");

class MockSheet {
  constructor(name, rows = [], maxColumns = 27) {
    this.name = name;
    this.rows = rows.map((r) => [...r]);
    this._maxColumns = maxColumns;
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getMaxColumns() { return this._maxColumns; }
  setMaxColumns(n) { this._maxColumns = n; }
  getDataRange() {
    return {
      getValues: () => this.rows.map((r) => [...r]),
      getDisplayValues: () => this.rows.map((r) => r.map((c) => String(c == null ? "" : c))),
    };
  }
  getRange(row, col, numRows, numCols) {
    const rIdx = row - 1;
    const cIdx = col - 1;
    return {
      getValues: () => {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const rowVals = this.rows[rIdx + r] || [];
          out.push(rowVals.slice(cIdx, cIdx + numCols));
        }
        return out;
      },
      getDisplayValues: () => {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const rowVals = this.rows[rIdx + r] || [];
          const sliced = rowVals.slice(cIdx, cIdx + numCols);
          out.push(sliced.map((c) => String(c == null ? "" : c)));
        }
        return out;
      },
      setValues: (values) => {
        for (let r = 0; r < numRows; r++) {
          while (this.rows.length <= rIdx + r) this.rows.push([]);
          for (let c = 0; c < numCols; c++) {
            this.rows[rIdx + r][cIdx + c] = values[r][c];
          }
        }
      },
    };
  }
  appendRow(row) {
    this.rows.push([...row]);
  }
  deleteRow(rowIndex) {
    this.rows.splice(rowIndex - 1, 1);
  }
}

const UtilitiesMock = {
  getUuid: () => crypto.randomUUID(),
  newBlob: (data) => ({
    getDataAsString: () => (Buffer.isBuffer(data) ? data.toString("utf8") : String(data)),
  }),
  base64DecodeWebSafe: (str) => {
    let s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Buffer.from(s, "base64");
  },
  base64EncodeWebSafe: (bytes) => {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  computeHmacSha256Signature: (value, secret) => {
    return crypto.createHmac("sha256", secret).update(value).digest();
  },
  computeDigest: (_algo, value) => {
    const hash = crypto.createHash("sha256").update(value).digest();
    const arr = [];
    for (let i = 0; i < hash.length; i++) {
      const b = hash[i];
      arr.push(b > 127 ? b - 256 : b);
    }
    return arr;
  },
  DigestAlgorithm: { SHA_256: "SHA_256" },
  Charset: { UTF_8: "UTF_8" },
};

const ContentServiceMock = {
  MimeType: { JSON: "JSON" },
  createTextOutput: (text) => {
    let mime = "";
    return {
      setMimeType: (m) => {
        mime = m;
        return { getContent: () => text, getMimeType: () => mime };
      },
      getContent: () => text,
    };
  },
};

function createGasEnv(initialRows = null) {
  const scriptProperties = new Map([
    ["CLOUDFLARE_API_SECRET", "test-secret-123"],
    ["SESSION_SIGNING_SECRET", "session-secret-key-1234567890"],
    ["SPREADSHEET_ID", "test-sheet-id"],
    ["PASSWORD_PEPPER", "test-pepper-abc123"],
  ]);
  const lockState = { held: false, waitLockCalled: 0, releaseLockCalled: 0 };
  const mockSheets = new Map();

  // Simple in-memory cache for login throttle tests.
  const cacheStore = new Map();
  const CacheServiceMock = {
    getScriptCache: () => ({
      get: (k) => cacheStore.has(k) ? cacheStore.get(k).value : null,
      put: (k, v, _ttl) => cacheStore.set(k, { value: String(v) }),
      remove: (k) => cacheStore.delete(k),
    }),
  };

  const code = fs.readFileSync(codeJsPath, "utf8");
  const ctx = {
    console,
    Date,
    Math,
    JSON,
    RegExp,
    String,
    Number,
    Array,
    Object,
    Error,
    Buffer,
    Utilities: UtilitiesMock,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => scriptProperties.get(k) || null,
        setProperty: (k, v) => scriptProperties.set(k, String(v)),
        deleteProperty: (k) => scriptProperties.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          lockState.held = true;
          lockState.waitLockCalled++;
        },
        hasLock: () => lockState.held,
        releaseLock: () => {
          lockState.held = false;
          lockState.releaseLockCalled++;
        },
      }),
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (n) => mockSheets.get(n) || null,
      }),
      flush: () => {},
    },
    CacheService: CacheServiceMock,
    ContentService: ContentServiceMock,
    HtmlService: {
      createTemplateFromFile: () => ({
        evaluate: () => ({
          setTitle: () => ({ addMetaTag: () => ({}) }),
        }),
      }),
    },
  };

  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  const defaultHeaders = ["Timestamp", ...ctx.LETTER_FIELDS_];
  const rows = initialRows ? initialRows : [defaultHeaders];
  const letterSheet = new MockSheet("Database_Surat", rows, 27);
  mockSheets.set("Database_Surat", letterSheet);

  // User sheet with two users: one admin, one pengelola.
  // maxColumns=4 satisfies validateUserSheet_.
  const adminHash = "sha256$testsalt$testhash";
  const staffHash = "sha256$staffsalt$staffhash";
  const userSheet = new MockSheet("Master_User", [
    ["username", "password", "namaLengkap", "hakAkses"],
    ["admin", adminHash, "Administrator", "admin"],
    ["staff", staffHash, "Staf Pengelola", "pengelola"],
  ], 4);
  mockSheets.set("Master_User", userSheet);

  return { ctx, mockSheets, letterSheet, lockState, scriptProperties, userSheet, cacheStore };
}

function sampleLetterPayload(overrides = {}) {
  return {
    statusPegawai: "PNS",
    nama: "Petrus Kanisius",
    nip: "198001012005011001",
    pangkat: "Penata Muda (III/a)",
    jabatan: "Guru Ahli Pertama",
    unit: "SMAN 1 Kupang",
    kabkot: "Kota Kupang",
    skPejabat: "Gubernur NTT",
    skTanggal: "2024-01-02",
    skNomor: "821/01/BKD/2024",
    skTmt: "2024-01-01",
    mkLamaThn: "10",
    mkLamaBln: "0",
    gajiLama: "3000000",
    mkBaruThn: "12",
    mkBaruBln: "0",
    gajiBaruTmt: "2024-01-01",
    gajiBaru: "3500000",
    suratNomor: "821/02/KGB/2024",
    suratTanggal: "2024-01-10",
    signJabatan: "Kepala Dinas",
    signNama: "Pejabat B",
    signPangkat: "Pembina Utama Muda (IV/c)",
    signNip: "197001011995011001",
    ukuranKertas: "legal",
    ...overrides,
  };
}

test("dispatchHttpAction_ mengenali letters.update dan meneruskan sessionToken, payload.id, payload", () => {
  const { ctx, letterSheet, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  const createRes = ctx.apiCreateLetter(token, sampleLetterPayload());
  assert.equal(createRes.status, "success");
  const recordId = createRes.data.id;

  const updatePayload = sampleLetterPayload({ nama: "Nama Diperbarui", id: recordId });
  const result = ctx.dispatchHttpAction_({
    action: "letters.update",
    sessionToken: token,
    payload: { id: recordId, ...updatePayload },
  });

  assert.equal(result.status, "success");
  assert.equal(result.data.nama, "Nama Diperbarui");
  assert.equal(result.data.id, recordId);
  // Row 2 Col D (nama)
  assert.equal(letterSheet.rows[1][3], "Nama Diperbarui");
});
test("auth/session ditolak ketika token kosong, signature rusak, atau expired", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.appendRow(["staff", "sha256$staffsalt$staffhash", "Staf", "pengelola"]);

  // Missing token
  assert.throws(
    () => ctx.apiUpdateLetter("", "KGB-1", sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED" && /Sesi tidak valid/i.test(err.message),
  );

  // Invalid signature / tampered token
  const validToken = makeSessionToken(ctx, userSheet, "staff");
  const parts = validToken.split(".");
  const tamperedToken = `${parts[0]}.invalidSignature`;
  assert.throws(
    () => ctx.apiUpdateLetter(tamperedToken, "KGB-1", sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED",
  );

  // Expired token
  const expiredPayload = {
    username: "user",
    namaLengkap: "User",
    hakAkses: "pengelola",
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
    nonce: "test-nonce",
  };
  const encoded = ctx.base64UrlEncode_(JSON.stringify(expiredPayload));
  const expiredToken = `${encoded}.${ctx.signValue_(encoded)}`;
  assert.throws(
    () => ctx.apiUpdateLetter(expiredToken, "KGB-1", sampleLetterPayload()),
    (err) => err.code === "SESSION_EXPIRED" && /Sesi telah berakhir/i.test(err.message),
  );
});

test("updateLetter_ menulis tepat kolom C–AA dan mempertahankan kolom A (timestamp) serta kolom B (ID)", () => {
  const { ctx, letterSheet, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "staff");

  const initial = sampleLetterPayload({ nama: "Nama Asli", gajiBaru: "3500000" });
  const created = ctx.apiCreateLetter(token, initial);
  const targetId = created.data.id;

  const originalTimestamp = letterSheet.rows[1][0];
  const originalId = letterSheet.rows[1][1];
  assert.equal(originalId, targetId);

  const updatedPayload = sampleLetterPayload({
    nama: "Nama Baru Terupdate",
    gajiBaru: "4100000",
    unit: "SMAN 2 Kupang",
    ukuranKertas: "a4",
  });

  const updateResult = ctx.apiUpdateLetter(token, targetId, updatedPayload);
  assert.equal(updateResult.status, "success");

  // Kolom A (Timestamp) dan Kolom B (ID) tidak boleh berubah
  assert.equal(letterSheet.rows[1][0], originalTimestamp);
  assert.equal(letterSheet.rows[1][1], originalId);

  // Kolom C s.d. AA (25 kolom mutable) terisi sesuai updatePayload
  assert.equal(letterSheet.rows[1][2], "PNS"); // statusPegawai
  assert.equal(letterSheet.rows[1][3], "Nama Baru Terupdate"); // nama
  assert.equal(letterSheet.rows[1][7], "SMAN 2 Kupang"); // unit
  assert.equal(letterSheet.rows[1][19], "4100000"); // gajiBaru
  assert.equal(letterSheet.rows[1][26], "a4"); // ukuranKertas
});

test("ID body tidak bisa mengganti ID URL/parameter dan ID sheet tetap kebal", () => {
  const { ctx, letterSheet, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "staff");

  const created = ctx.apiCreateLetter(token, sampleLetterPayload({ nama: "Surat 1" }));
  const realId = created.data.id;

  const hostilePayload = sampleLetterPayload({
    id: "ATTACKER_OVERRIDE_ID_999",
    nama: "Nama Diubah Penyerang",
  });

  const res = ctx.apiUpdateLetter(token, realId, hostilePayload);
  assert.equal(res.status, "success");
  assert.equal(res.data.id, realId);
  assert.notEqual(res.data.id, "ATTACKER_OVERRIDE_ID_999");

  // Kolom B pada sheet tetap realId
  assert.equal(letterSheet.rows[1][1], realId);
});

test("not found ditangani dengan benar saat sheet kosong (lastRow < 2) dan saat ID tidak ada", () => {
  const { ctx, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // Kasus 1: Sheet hanya punya header (lastRow = 1 < 2)
  const emptyRes = ctx.apiUpdateLetter(token, "KGB-2024-NONEXISTENT", sampleLetterPayload());
  assert.equal(emptyRes.status, "not_found");
  assert.match(emptyRes.errorMsg, /tidak ditemukan/i);

  // Buat satu record
  const created = ctx.apiCreateLetter(token, sampleLetterPayload());
  assert.equal(created.status, "success");

  // Kasus 2: Sheet ada data tetapi ID tidak cocok
  const missingRes = ctx.apiUpdateLetter(token, "KGB-2024-UNKNOWN-ID", sampleLetterPayload());
  assert.equal(missingRes.status, "not_found");
  assert.match(missingRes.errorMsg, /tidak ditemukan atau sudah dihapus/i);
});

test("lock dilepas ketika update/create/delete sukses maupun saat terjadi error", () => {
  const { ctx, lockState, letterSheet, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // 1. Sukses create dan update
  const created = ctx.apiCreateLetter(token, sampleLetterPayload());
  assert.equal(lockState.held, false);
  assert.equal(lockState.waitLockCalled >= 1, true);

  const updated = ctx.apiUpdateLetter(token, created.data.id, sampleLetterPayload({ nama: "Test Lock" }));
  assert.equal(updated.status, "success");
  assert.equal(lockState.held, false);

  // 2. Error pada saat update (misal sheet Database_Surat rusak atau kolom kurang)
  letterSheet.setMaxColumns(10); // Kurang dari 27 kolom -> SCHEMA_ERROR
  assert.throws(
    () => ctx.apiUpdateLetter(token, created.data.id, sampleLetterPayload()),
    (err) => err.code === "SCHEMA_ERROR",
  );
  assert.equal(lockState.held, false, "Lock harus dilepas setelah terjadi exception");

  // 3. Sukses delete
  letterSheet.setMaxColumns(27);
  const deleted = ctx.apiDeleteLetter(token, created.data.id);
  assert.equal(deleted.status, "success");
  assert.equal(lockState.held, false);
});

test("validasi tanggal kalender (isCalendarDate_) menolak tanggal non-kalender dan format salah", () => {
  const { ctx, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // Format tidak valid (bukan YYYY-MM-DD)
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ skTanggal: "01/01/2024" })),
    (err) => err.code === "VALIDATION_ERROR" && /Format tanggal skTanggal tidak valid/i.test(err.message),
  );

  // Tanggal fiktif: 30 Februari pada tahun kabisat (2024)
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ skTanggal: "2024-02-30" })),
    (err) => err.code === "VALIDATION_ERROR" && /Format tanggal skTanggal tidak valid/i.test(err.message),
  );

  // Tanggal fiktif: 29 Februari pada tahun non-kabisat (2023)
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ skTanggal: "2023-02-29" })),
    (err) => err.code === "VALIDATION_ERROR" && /Format tanggal skTanggal tidak valid/i.test(err.message),
  );

  // Tanggal valid: 29 Februari pada tahun kabisat (2024)
  const validLeap = ctx.validateAndNormalizeLetter_(sampleLetterPayload({ skTanggal: "2024-02-29" }));
  assert.equal(validLeap.skTanggal, "2024-02-29");

  // Tanggal fiktif: 31 April (April hanya 30 hari)
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ suratTanggal: "2024-04-31" })),
    (err) => err.code === "VALIDATION_ERROR" && /Format tanggal suratTanggal tidak valid/i.test(err.message),
  );

  // Bulan 13
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ skTmt: "2024-13-01" })),
    (err) => err.code === "VALIDATION_ERROR" && /Format tanggal skTmt tidak valid/i.test(err.message),
  );
});

test("validasi batas masa kerja (mkRules) menegakkan batas min-max untuk lama dan baru", () => {
  const { ctx } = createGasEnv();

  // mkLamaThn min 0 max 40
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ mkLamaThn: "41" })),
    (err) => err.code === "VALIDATION_ERROR" && /harus antara 0 dan 40/i.test(err.message),
  );
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ mkLamaThn: "abc" })),
    (err) => err.code === "VALIDATION_ERROR" && /Nilai masa kerja mkLamaThn tidak valid/i.test(err.message),
  );

  // mkLamaBln min 0 max 11
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ mkLamaBln: "12" })),
    (err) => err.code === "VALIDATION_ERROR" && /harus antara 0 dan 11/i.test(err.message),
  );

  // mkBaruThn min 1 max 40 (0 tidak boleh untuk masa kerja baru)
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ mkBaruThn: "0" })),
    (err) => err.code === "VALIDATION_ERROR" && /harus antara 1 dan 40/i.test(err.message),
  );
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ mkBaruThn: "41" })),
    (err) => err.code === "VALIDATION_ERROR" && /harus antara 1 dan 40/i.test(err.message),
  );

  // mkBaruBln min 0 max 11
  assert.throws(
    () => ctx.validateAndNormalizeLetter_(sampleLetterPayload({ mkBaruBln: "15" })),
    (err) => err.code === "VALIDATION_ERROR" && /harus antara 0 dan 11/i.test(err.message),
  );

  // Nilai batas valid: mkLamaThn: 0, mkLamaBln: 11, mkBaruThn: 1, mkBaruBln: 0
  const validEdges = ctx.validateAndNormalizeLetter_(sampleLetterPayload({
    mkLamaThn: "0",
    mkLamaBln: "11",
    mkBaruThn: "1",
    mkBaruBln: "0",
  }));
  assert.equal(validEdges.mkLamaThn, "0");
  assert.equal(validEdges.mkLamaBln, "11");
  assert.equal(validEdges.mkBaruThn, "1");
  assert.equal(validEdges.mkBaruBln, "0");
});

test("validasi ID surat (validateLetterId_) menolak ID kosong, oversized, dan karakter tidak aman", () => {
  const { ctx, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // ID kosong / whitespace
  assert.throws(
    () => ctx.apiUpdateLetter(token, "   ", sampleLetterPayload()),
    (err) => err.code === "VALIDATION_ERROR" && /ID surat tidak valid/i.test(err.message),
  );

  // ID lebih dari 200 karakter
  const oversizedId = `KGB-${"A".repeat(210)}`;
  assert.throws(
    () => ctx.apiUpdateLetter(token, oversizedId, sampleLetterPayload()),
    (err) => err.code === "VALIDATION_ERROR" && /ID surat tidak valid/i.test(err.message),
  );

  // ID dengan karakter berbahaya / injeksi (misal HTML tag, kutip tunggal, semikolon)
  assert.throws(
    () => ctx.apiUpdateLetter(token, "KGB<script>alert(1)</script>", sampleLetterPayload()),
    (err) => err.code === "VALIDATION_ERROR" && /ID surat tidak valid/i.test(err.message),
  );

  assert.throws(
    () => ctx.apiUpdateLetter(token, "KGB'; DROP TABLE--", sampleLetterPayload()),
    (err) => err.code === "VALIDATION_ERROR" && /ID surat tidak valid/i.test(err.message),
  );

  // ID valid (karakter legal: huruf, angka, strip, slash, dot, underscore, spasi)
  assert.equal(ctx.validateLetterId_("KGB-2024-001/A.1"), "KGB-2024-001/A.1");
});

test("sanitasi formula injection mencegah eksekusi formula pada spreadsheet saat update", () => {
  const { ctx, letterSheet, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  const created = ctx.apiCreateLetter(token, sampleLetterPayload());
  const recordId = created.data.id;

  const maliciousPayload = sampleLetterPayload({
    nama: "=SUM(A1:A10)",
    jabatan: "+CMD|' /C calc'!A0",
    unit: "@DDE('cmd';'/c calc';'a')",
    kabkot: "-2+5",
  });

  const updateRes = ctx.apiUpdateLetter(token, recordId, maliciousPayload);
  assert.equal(updateRes.status, "success");

  // Sheet values harus memiliki prefix apostrof "'" agar tidak diinterpretasikan sebagai formula
  assert.equal(letterSheet.rows[1][3], "'=SUM(A1:A10)"); // nama (index 3)
  assert.equal(letterSheet.rows[1][6], "'+CMD|' /C calc'!A0"); // jabatan (index 6)
  assert.equal(letterSheet.rows[1][7], "'@DDE('cmd';'/c calc';'a')"); // unit (index 7)
  assert.equal(letterSheet.rows[1][8], "'-2+5"); // kabkot (index 8)
});

test("regresi create/delete/list: otorisasi role dan alur spreadsheet berjalan normal", () => {
  const { ctx, letterSheet, userSheet } = createGasEnv();
  const adminToken = makeSessionToken(ctx, userSheet, "admin");
  const staffToken = makeSessionToken(ctx, userSheet, "staff");

  // Create dapat dilakukan oleh pengelola
  const create1 = ctx.apiCreateLetter(staffToken, sampleLetterPayload({ nama: "Surat Pertama" }));
  assert.equal(create1.status, "success");
  const id1 = create1.data.id;

  // Create kedua
  const create2 = ctx.apiCreateLetter(adminToken, sampleLetterPayload({ nama: "Surat Kedua" }));
  assert.equal(create2.status, "success");
  const id2 = create2.data.id;

  // List mengembalikan urutan reverse chronological (terbaru di awal)
  const listRes = ctx.apiListLetters(staffToken);
  assert.equal(listRes.status, "success");
  assert.equal(listRes.data.length, 2);
  assert.equal(listRes.data[0].id, id2);
  assert.equal(listRes.data[1].id, id1);

  // Delete ditolak untuk pengelola (bukan admin)
  assert.throws(
    () => ctx.apiDeleteLetter(staffToken, id1),
    (err) => err.code === "FORBIDDEN" && /Hanya administrator/i.test(err.message),
  );

  // Delete berhasil untuk admin
  const deleteRes = ctx.apiDeleteLetter(adminToken, id1);
  assert.equal(deleteRes.status, "success");
  assert.equal(deleteRes.id, id1);
  assert.equal(letterSheet.rows.length, 2); // header + id2
});

test("doPost memverifikasi API secret gateway dan mengembalikan JSON output terstruktur", () => {
  const { ctx, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // 1. Secret salah -> UNAUTHORIZED_GATEWAY
  const badSecretPost = ctx.doPost({
    postData: {
      contents: JSON.stringify({
        apiSecret: "wrong-secret",
        action: "bootstrap.get",
      }),
    },
  });
  const badSecretJson = JSON.parse(badSecretPost.getContent());
  assert.equal(badSecretJson.status, "error");
  assert.equal(badSecretJson.errorCode, "UNAUTHORIZED_GATEWAY");
  // Setiap error response menyertakan gasBackendVersion
  assert.ok(typeof badSecretJson.gasBackendVersion === "string" && badSecretJson.gasBackendVersion.length > 0,
    "Error response harus menyertakan gasBackendVersion");

  // 2. Secret benar dan action letters.create lalu letters.update
  const createPost = ctx.doPost({
    postData: {
      contents: JSON.stringify({
        apiSecret: "test-secret-123",
        action: "letters.create",
        sessionToken: token,
        payload: sampleLetterPayload({ nama: "Pegawai via doPost" }),
      }),
    },
  });
  const createJson = JSON.parse(createPost.getContent());
  assert.equal(createJson.status, "success");
  assert.ok(typeof createJson.gasBackendVersion === "string",
    "Success response harus menyertakan gasBackendVersion");
  const createdId = createJson.data.id;

  const updatePost = ctx.doPost({
    postData: {
      contents: JSON.stringify({
        apiSecret: "test-secret-123",
        action: "letters.update",
        sessionToken: token,
        payload: sampleLetterPayload({ id: createdId, nama: "Pegawai doPost Updated" }),
      }),
    },
  });
  const updateJson = JSON.parse(updatePost.getContent());
  assert.equal(updateJson.status, "success");
  assert.equal(updateJson.data.nama, "Pegawai doPost Updated");
});

test("system.manifest mengembalikan GAS_BACKEND_VERSION dan semua aksi yang dibutuhkan Cloudflare", () => {
  const { ctx } = createGasEnv();

  // system.manifest harus bisa dipanggil via dispatchHttpAction_ (hanya butuh apiSecret, bukan sessionToken)
  const result = ctx.dispatchHttpAction_({ action: "system.manifest", payload: {} });
  assert.equal(result.status, "success");
  assert.ok(typeof result.gasBackendVersion === "string" && result.gasBackendVersion.length > 0,
    "Manifest harus menyertakan gasBackendVersion");

  // GAS_BACKEND_VERSION di Code.js harus cocok dengan apa yang dilaporkan manifest
  assert.equal(result.gasBackendVersion, ctx.GAS_BACKEND_VERSION,
    "gasBackendVersion dalam manifest harus sama dengan GAS_BACKEND_VERSION di source");

  // Semua aksi yang dibutuhkan Cloudflare (dari ROUTES + dynamic routes di [[path]].js) harus terdaftar.
  // Daftar ini adalah source of truth untuk deteksi mismatch deployment.
  const CLOUDFLARE_REQUIRED_ACTIONS = [
    "auth.login",
    "auth.logout",
    "bootstrap.get",
    "letters.list",
    "letters.create",
    "letters.update",  // Aksi yang menyebabkan error produksi ACTION_NOT_FOUND
    "letters.delete",
    "system.manifest",
  ];
  for (const action of CLOUDFLARE_REQUIRED_ACTIONS) {
    assert.ok(result.supportedActions.includes(action),
      `Manifest harus mendaftarkan aksi "${action}" di supportedActions`);
  }
});

test("ACTION_NOT_FOUND error menyertakan nama aksi dan versi GAS untuk mempermudah diagnosis deployment", () => {
  const { ctx } = createGasEnv();

  assert.throws(
    () => ctx.dispatchHttpAction_({ action: "letters.nonexistent", payload: {} }),
    (err) => {
      assert.equal(err.code, "ACTION_NOT_FOUND");
      // Pesan error harus menyebut aksi yang tidak dikenali
      assert.ok(err.message.includes("letters.nonexistent"),
        "Error message harus menyebut nama aksi yang tidak dikenali");
      // Pesan error harus menyebut versi GAS sehingga operator bisa mendiagnosis mismatch
      assert.ok(err.message.includes(ctx.GAS_BACKEND_VERSION),
        "Error message harus menyertakan GAS_BACKEND_VERSION untuk diagnosis mismatch deployment");
      return true;
    }
  );
});

test("doPost menyertakan gasBackendVersion di semua jalur respons (sukses, error, aksi tidak dikenal)", () => {
  const { ctx, userSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // Jalur sukses: bootstrap.get
  const successPost = ctx.doPost({
    postData: {
      contents: JSON.stringify({
        apiSecret: "test-secret-123",
        action: "bootstrap.get",
      }),
    },
  });
  const successJson = JSON.parse(successPost.getContent());
  assert.equal(successJson.gasBackendVersion, ctx.GAS_BACKEND_VERSION,
    "Respons sukses harus menyertakan gasBackendVersion");

  // Jalur error: ACTION_NOT_FOUND — kasus yang sesuai error produksi
  const unknownActionPost = ctx.doPost({
    postData: {
      contents: JSON.stringify({
        apiSecret: "test-secret-123",
        action: "letters.unknown_future_action",
        sessionToken: token,
      }),
    },
  });
  const unknownJson = JSON.parse(unknownActionPost.getContent());
  assert.equal(unknownJson.status, "error");
  assert.equal(unknownJson.errorCode, "ACTION_NOT_FOUND");
  assert.equal(unknownJson.gasBackendVersion, ctx.GAS_BACKEND_VERSION,
    "ACTION_NOT_FOUND response harus menyertakan gasBackendVersion untuk diagnosis deployment");

  // Jalur error: VALIDATION_ERROR (tidak mengubah contract gasBackendVersion)
  const validationPost = ctx.doPost({
    postData: {
      contents: JSON.stringify({
        apiSecret: "test-secret-123",
        action: "letters.update",
        sessionToken: token,
        payload: { id: "   " }, // ID kosong -> VALIDATION_ERROR
      }),
    },
  });
  const validationJson = JSON.parse(validationPost.getContent());
  assert.equal(validationJson.status, "error");
  assert.equal(validationJson.gasBackendVersion, ctx.GAS_BACKEND_VERSION,
    "VALIDATION_ERROR response harus menyertakan gasBackendVersion");
});

// ─── User Management Tests ──────────────────────────────────────────────────

/**
 * Creates a valid admin token that passes requireAdminSession_.
 * Reads the live admin row from userSheet so sv is derived from the actual
 * stored password/hash and role, matching what login_ would produce.
 */
function makeAdminToken(ctx, userSheet, username = "admin") {
  const adminRow = userSheet.rows.find((r) => String(r[0]).trim().toLowerCase() === username.toLowerCase());
  if (!adminRow) throw new Error("Admin row not found in makeAdminToken");
  const storedPw = String(adminRow[1]);
  const role = ctx.normalizeHakAkses_(String(adminRow[3])) || "pengelola";
  const sv = ctx.computeSessionVersion_(storedPw, role);
  return ctx.createSessionToken_({ username: String(adminRow[0]).trim(), namaLengkap: String(adminRow[2]).trim(), hakAkses: role, sv });
}

/**
 * Creates a token WITHOUT sv (simulating tokens issued by older GAS versions).
 */
function makeTokenNoSv(ctx, username, hakAkses) {
  return ctx.createSessionToken_({ username, namaLengkap: username, hakAkses });
}
/**
 * Creates a valid session token for any user in the sheet (any role).
 * sv is computed from the live stored password + canonical role.
 * This is the universal helper for ALL authenticated endpoints after v2.4.
 */
function makeSessionToken(ctx, userSheet, username) {
  const row = userSheet.rows.find((r) => String(r[0]).trim().toLowerCase() === username.toLowerCase());
  if (!row) throw new Error("User row not found for: " + username);
  const storedPw = String(row[1]);
  const role = ctx.normalizeHakAkses_(String(row[3])) || "pengelola";
  const sv = ctx.computeSessionVersion_(storedPw, role);
  return ctx.createSessionToken_({ username: String(row[0]).trim(), namaLengkap: String(row[2]).trim(), hakAkses: role, sv });
}

test("users.list mengembalikan daftar tanpa password dan ditolak untuk non-admin/missing-sv", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["pengelola1", "sha256$s$h", "Staff Satu", "pengelola"]);

  const adminToken = makeAdminToken(ctx, userSheet);
  const staffToken = makeTokenNoSv(ctx, "pengelola1", "pengelola");

  const res = ctx.apiListUsers(adminToken);
  assert.equal(res.status, "success");
  assert.ok(Array.isArray(res.data));
  // Tidak boleh ada field password
  for (const u of res.data) {
    assert.ok(!Object.prototype.hasOwnProperty.call(u, "password"), "Response tidak boleh memuat password");
    assert.ok(!Object.prototype.hasOwnProperty.call(u, "passwordHash"), "Response tidak boleh memuat passwordHash");
  }
  assert.ok(res.data.some((u) => u.username === "admin"));
  assert.ok(res.data.some((u) => u.username === "pengelola1"));

  // Token tanpa sv ditolak (AUTH_REQUIRED) — termasuk token pengelola
  assert.throws(
    () => ctx.apiListUsers(staffToken),
    (err) => err.code === "AUTH_REQUIRED" || err.code === "FORBIDDEN",
  );

  // Token admin tanpa sv juga ditolak
  const adminNoSv = makeTokenNoSv(ctx, "admin", "admin");
  assert.throws(
    () => ctx.apiListUsers(adminNoSv),
    (err) => err.code === "AUTH_REQUIRED",
  );
});

test("users.create membuat user baru dengan hash password dan menolak duplikat (case-insensitive)", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  const res = ctx.apiCreateUser(adminToken, {
    username: "pengelola99",
    password: "password123",
    namaLengkap: "Staf Baru",
    hakAkses: "pengelola",
  });
  assert.equal(res.status, "success");
  assert.equal(res.data.username, "pengelola99");
  assert.equal(res.data.hakAkses, "pengelola");

  // Password di sheet harus berformat sha256$salt$hash
  const newRow = userSheet.rows.find((r) => String(r[0]).trim().toLowerCase() === "pengelola99");
  assert.ok(newRow, "Row baru harus ada di sheet");
  assert.match(String(newRow[1]), /^sha256\$[a-f0-9]+\$[a-f0-9]+$/, "Password harus berformat sha256$salt$hash");

  // Duplikat case-insensitive ditolak
  assert.throws(
    () => ctx.apiCreateUser(adminToken, {
      username: "PENGELOLA99",
      password: "password456",
      namaLengkap: "Duplikat",
      hakAkses: "pengelola",
    }),
    (err) => err.code === "DUPLICATE_USER",
  );
});

test("users.create menolak input tidak valid: username buruk, nama kosong, role salah, password pendek", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  // Username dengan karakter tidak aman
  assert.throws(
    () => ctx.apiCreateUser(adminToken, { username: "bad user!", password: "password123", namaLengkap: "X", hakAkses: "pengelola" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Username kosong
  assert.throws(
    () => ctx.apiCreateUser(adminToken, { username: "", password: "password123", namaLengkap: "X", hakAkses: "pengelola" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Nama kosong
  assert.throws(
    () => ctx.apiCreateUser(adminToken, { username: "validuser", password: "password123", namaLengkap: "", hakAkses: "pengelola" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Role tidak valid
  assert.throws(
    () => ctx.apiCreateUser(adminToken, { username: "validuser", password: "password123", namaLengkap: "Valid", hakAkses: "superuser" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Password terlalu pendek
  assert.throws(
    () => ctx.apiCreateUser(adminToken, { username: "validuser", password: "short", namaLengkap: "Valid", hakAkses: "pengelola" }),
    (err) => err.code === "VALIDATION_ERROR",
  );
});

test("validateUsername_ tidak menggunakan truncation: username 65 karakter ditolak create; target 65+ ditolak update/reset/delete tanpa mengubah row", () => {
  const { ctx, userSheet } = createGasEnv();
  // Buat user dengan username legacy valid (<=64 chars)
  userSheet.rows.push(["legacyuser", "sha256$s$h", "Legacy User", "pengelola"]);
  const adminToken = makeAdminToken(ctx, userSheet);

  const name65 = "a".repeat(65);
  const rowCountBefore = userSheet.rows.length;

  // create dengan 65 char harus VALIDATION_ERROR
  assert.throws(
    () => ctx.apiCreateUser(adminToken, { username: name65, password: "password123", namaLengkap: "X", hakAkses: "pengelola" }),
    (err) => err.code === "VALIDATION_ERROR",
  );
  assert.equal(userSheet.rows.length, rowCountBefore, "Tidak boleh menambah row baru pada username 65 char");

  // Target update dengan 101+ char ditolak
  const name101 = "a".repeat(101);
  assert.throws(
    () => ctx.apiUpdateUser(adminToken, name101, { namaLengkap: "X", hakAkses: "pengelola" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Target reset dengan 101+ char ditolak
  assert.throws(
    () => ctx.apiResetUserPassword(adminToken, name101, { newPassword: "newpassword123" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Target delete dengan 101+ char ditolak
  assert.throws(
    () => ctx.apiDeleteUser(adminToken, name101),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Row legacyuser tidak berubah
  const legacyRow = userSheet.rows.find((r) => String(r[0]).trim() === "legacyuser");
  assert.ok(legacyRow, "Row legacyuser harus masih ada");
  assert.equal(String(legacyRow[2]).trim(), "Legacy User", "namaLengkap legacyuser tidak boleh berubah");
});

test("users.create: 'administrator' dinormalisasi menjadi 'admin'", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  const res = ctx.apiCreateUser(adminToken, {
    username: "adminbaru",
    password: "password123",
    namaLengkap: "Admin Baru",
    hakAkses: "administrator",
  });
  assert.equal(res.status, "success");
  assert.equal(res.data.hakAkses, "admin");
});

test("users.create gagal CONFIG_ERROR bila PASSWORD_PEPPER tidak dikonfigurasi", () => {
  const { ctx, userSheet, scriptProperties } = createGasEnv();
  scriptProperties.delete("PASSWORD_PEPPER");
  const adminToken = makeAdminToken(ctx, userSheet);

  assert.throws(
    () => ctx.apiCreateUser(adminToken, {
      username: "newuser",
      password: "password123",
      namaLengkap: "New User",
      hakAkses: "pengelola",
    }),
    (err) => err.code === "CONFIG_ERROR",
  );
});

test("verifyPassword_ dengan sha256 hash melempar CONFIG_ERROR bila pepper kosong", () => {
  const { ctx, scriptProperties } = createGasEnv();
  scriptProperties.delete("PASSWORD_PEPPER");

  // sha256$... password tanpa pepper harus CONFIG_ERROR, bukan false/bypass
  assert.throws(
    () => ctx.verifyPassword_("anypassword", "sha256$somesalt$somehash"),
    (err) => err.code === "CONFIG_ERROR",
  );
});

test("users.update mengubah nama dan role; username immutable; menolak downgrade admin terakhir", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["pengelola1", "sha256$s$h", "Staff Satu", "pengelola"]);

  const adminToken = makeAdminToken(ctx, userSheet);

  // Update nama pengelola1
  const res = ctx.apiUpdateUser(adminToken, "pengelola1", { namaLengkap: "Staff Diubah", hakAkses: "pengelola" });
  assert.equal(res.status, "success");
  assert.equal(res.data.namaLengkap, "Staff Diubah");
  assert.equal(res.data.username, "pengelola1");

  // Sheet harus berisi nama baru di kolom C
  const updatedRow = userSheet.rows.find((r) => String(r[0]).trim() === "pengelola1");
  assert.equal(String(updatedRow[2]).trim(), "Staff Diubah");
  // Username (kolom A) tidak berubah
  assert.equal(String(updatedRow[0]).trim(), "pengelola1");

  // Coba downgrade admin terakhir -> LAST_ADMIN_PROTECTED
  assert.throws(
    () => ctx.apiUpdateUser(adminToken, "admin", { namaLengkap: "Admin", hakAkses: "pengelola" }),
    (err) => err.code === "LAST_ADMIN_PROTECTED",
  );
});

test("users.update menolak self role downgrade; token tanpa sv ditolak", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["admin2", "sha256$s$h", "Admin Dua", "admin"]);

  const adminToken = makeAdminToken(ctx, userSheet);

  // Self downgrade ditolak meski ada admin lain
  assert.throws(
    () => ctx.apiUpdateUser(adminToken, "admin", { namaLengkap: "Admin", hakAkses: "pengelola" }),
    (err) => err.code === "FORBIDDEN",
  );

  // Token tanpa sv ditolak (termasuk token dengan role admin)
  const noSvToken = makeTokenNoSv(ctx, "admin", "admin");
  assert.throws(
    () => ctx.apiUpdateUser(noSvToken, "admin2", { namaLengkap: "Admin Dua", hakAkses: "pengelola" }),
    (err) => err.code === "AUTH_REQUIRED",
  );
});

test("users.update NOT_FOUND ketika username tidak ditemukan", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  assert.throws(
    () => ctx.apiUpdateUser(adminToken, "nonexistent", { namaLengkap: "X", hakAkses: "pengelola" }),
    (err) => err.code === "NOT_FOUND",
  );
});

test("users.resetPassword mengganti hash password dan menolak non-admin atau password pendek", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["pengelola1", "sha256$oldsalt$oldhash", "Staff Satu", "pengelola"]);

  const adminToken = makeAdminToken(ctx, userSheet);

  const res = ctx.apiResetUserPassword(adminToken, "pengelola1", { newPassword: "newpassword123" });
  assert.equal(res.status, "success");

  // Hash baru harus berbeda dari lama
  const updatedRow = userSheet.rows.find((r) => String(r[0]).trim() === "pengelola1");
  assert.match(String(updatedRow[1]), /^sha256\$[a-f0-9]+\$[a-f0-9]+$/);
  assert.notEqual(String(updatedRow[1]).trim(), "sha256$oldsalt$oldhash");

  // Password pendek ditolak
  assert.throws(
    () => ctx.apiResetUserPassword(adminToken, "pengelola1", { newPassword: "short" }),
    (err) => err.code === "VALIDATION_ERROR",
  );

  // Token tanpa sv ditolak
  const noSvToken = makeTokenNoSv(ctx, "admin", "admin");
  assert.throws(
    () => ctx.apiResetUserPassword(noSvToken, "pengelola1", { newPassword: "newpassword123" }),
    (err) => err.code === "AUTH_REQUIRED",
  );
});

test("stale token setelah reset password tidak dapat mengakses users.*", () => {
  const { ctx, userSheet } = createGasEnv();
  // Token dibuat sebelum reset
  const tokenBefore = makeAdminToken(ctx, userSheet);

  // Simulasi reset password: ubah stored hash di sheet
  const adminRow = userSheet.rows.find((r) => String(r[0]).trim() === "admin");
  adminRow[1] = "sha256$newsalt$newhash"; // hash berbeda

  // Token lama harus ditolak karena sv tidak cocok lagi
  assert.throws(
    () => ctx.apiListUsers(tokenBefore),
    (err) => err.code === "AUTH_REQUIRED",
  );

  // Token baru (dibuat setelah reset) harus bisa
  const tokenAfter = makeAdminToken(ctx, userSheet);
  const res = ctx.apiListUsers(tokenAfter);
  assert.equal(res.status, "success");
});

test("stale token setelah downgrade role tidak dapat mengakses users.*", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["admin2", "sha256$s$h", "Admin Dua", "admin"]);

  // Token admin dibuat saat role masih admin
  const tokenBefore = makeAdminToken(ctx, userSheet);

  // Simulasi downgrade role di sheet (admin -> pengelola)
  const adminRow = userSheet.rows.find((r) => String(r[0]).trim() === "admin");
  adminRow[3] = "pengelola";

  // Token lama harus ditolak: sv dihitung dari role lama "admin", sekarang "pengelola"
  assert.throws(
    () => ctx.apiListUsers(tokenBefore),
    (err) => err.code === "AUTH_REQUIRED" || err.code === "FORBIDDEN",
  );
});

test("stale token setelah delete tidak dapat mengakses users.*", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["admin2", "sha256$s2$h2", "Admin Dua", "admin"]);

  // Token admin2 dibuat dulu
  const admin2Token = makeAdminToken(ctx, userSheet, "admin2");

  // Hapus admin2 dari sheet (simulasi penghapusan oleh admin lain)
  const idx = userSheet.rows.findIndex((r) => String(r[0]).trim() === "admin2");
  userSheet.rows.splice(idx, 1);

  // Token admin2 harus ditolak karena row sudah tidak ada
  assert.throws(
    () => ctx.apiListUsers(admin2Token),
    (err) => err.code === "AUTH_REQUIRED",
  );
});

test("users.delete menghapus user; menolak self-delete; melindungi admin terakhir", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["pengelola1", "sha256$s$h", "Staff Satu", "pengelola"]);

  const adminToken = makeAdminToken(ctx, userSheet);

  // Hapus pengelola1
  const res = ctx.apiDeleteUser(adminToken, "pengelola1");
  assert.equal(res.status, "success");
  assert.equal(userSheet.rows.find((r) => String(r[0]).trim() === "pengelola1"), undefined);

  // Self-delete ditolak
  assert.throws(
    () => ctx.apiDeleteUser(adminToken, "admin"),
    (err) => err.code === "FORBIDDEN",
  );

  // Hapus admin terakhir ditolak
  assert.throws(
    () => ctx.apiDeleteUser(adminToken, "admin"),
    (err) => err.code === "FORBIDDEN" || err.code === "LAST_ADMIN_PROTECTED",
  );
});

test("users.delete NOT_FOUND ketika username tidak ditemukan", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  assert.throws(
    () => ctx.apiDeleteUser(adminToken, "ghost"),
    (err) => err.code === "NOT_FOUND",
  );
});

test("users.delete melindungi admin terakhir dari penghapusan (dua admin, hapus satu lalu tolak hapus sisa)", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["admin2", "sha256$s$h", "Admin Dua", "admin"]);

  const adminToken = makeAdminToken(ctx, userSheet);

  // Dua admin, hapus admin2 berhasil
  const res = ctx.apiDeleteUser(adminToken, "admin2");
  assert.equal(res.status, "success");

  // Self-delete ditolak
  assert.throws(
    () => ctx.apiDeleteUser(adminToken, "admin"),
    (err) => err.code === "FORBIDDEN",
  );
});

test("system.manifest menyertakan semua aksi users.*", () => {
  const { ctx } = createGasEnv();
  const result = ctx.dispatchHttpAction_({ action: "system.manifest", payload: {} });
  assert.equal(result.status, "success");

  const required = ["users.list", "users.create", "users.update", "users.resetPassword", "users.delete"];
  for (const action of required) {
    assert.ok(result.supportedActions.includes(action), `Manifest harus mendaftarkan aksi "${action}"`);
  }
});

test("users.* via dispatchHttpAction_ meneruskan sessionToken dan payload dengan benar", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  // users.list via dispatch
  const listResult = ctx.dispatchHttpAction_({ action: "users.list", sessionToken: adminToken, payload: {} });
  assert.equal(listResult.status, "success");

  // users.create via dispatch
  const createResult = ctx.dispatchHttpAction_({
    action: "users.create",
    sessionToken: adminToken,
    payload: { username: "newstaff", password: "password123", namaLengkap: "Staff Baru", hakAkses: "pengelola" },
  });
  assert.equal(createResult.status, "success");

  // users.update via dispatch (URL username injected into payload.username)
  const updateResult = ctx.dispatchHttpAction_({
    action: "users.update",
    sessionToken: adminToken,
    payload: { username: "newstaff", namaLengkap: "Staff Diperbarui", hakAkses: "pengelola" },
  });
  assert.equal(updateResult.status, "success");

  // users.resetPassword via dispatch
  const resetResult = ctx.dispatchHttpAction_({
    action: "users.resetPassword",
    sessionToken: adminToken,
    payload: { username: "newstaff", newPassword: "newpassword123" },
  });
  assert.equal(resetResult.status, "success");

  // users.delete via dispatch
  const deleteResult = ctx.dispatchHttpAction_({
    action: "users.delete",
    sessionToken: adminToken,
    payload: { username: "newstaff" },
  });
  assert.equal(deleteResult.status, "success");
});

test("safeSheetValue_ dipakai saat tulis user: formula injection dicegah", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  ctx.apiCreateUser(adminToken, {
    username: "formulauser",
    password: "password123",
    namaLengkap: "=SUM(A1:A10)",
    hakAkses: "pengelola",
  });

  const newRow = userSheet.rows.find((r) => String(r[0]).trim().toLowerCase() === "formulauser");
  assert.ok(newRow, "Row harus ada");
  // namaLengkap di kolom C harus prefixed apostrof
  assert.equal(String(newRow[2]), "'=SUM(A1:A10)");
});

test("users.update mempertahankan kolom A (username) dan B (password) saat update nama/role", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  const originalUsername = String(userSheet.rows[1][0]);
  const originalPassword = String(userSheet.rows[1][1]);

  ctx.apiUpdateUser(adminToken, "admin", { namaLengkap: "Admin Diubah", hakAkses: "admin" });

  assert.equal(String(userSheet.rows[1][0]), originalUsername, "Username tidak boleh berubah");
  assert.equal(String(userSheet.rows[1][1]), originalPassword, "Password tidak boleh berubah saat update profil");
});

test("users.list: kolom ekstra di sheet dipertahankan, tidak ikut terhapus", () => {
  const { ctx, userSheet } = createGasEnv();
  // Tambahkan kolom ekstra (kolom E) yang tidak dikenali oleh skema
  userSheet.rows[1].push("extra-data-col-E");
  // maxColumns harus lebih dari 4 untuk mempertahankan kolom ekstra
  userSheet._maxColumns = 5;

  const adminToken = makeAdminToken(ctx, userSheet);
  ctx.apiUpdateUser(adminToken, "admin", { namaLengkap: "Admin Diubah", hakAkses: "admin" });

  // Kolom E harus tetap ada
  assert.equal(String(userSheet.rows[1][4]), "extra-data-col-E", "Kolom ekstra harus tetap dipertahankan");
});

test("lock dilepas pada operasi user create/update/delete bahkan saat error", () => {
  const { ctx, userSheet, lockState, mockSheets } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  // Create berhasil
  ctx.apiCreateUser(adminToken, { username: "u1", password: "password123", namaLengkap: "U1", hakAkses: "pengelola" });
  assert.equal(lockState.held, false);

  // Update berhasil
  ctx.apiUpdateUser(adminToken, "u1", { namaLengkap: "U1 Updated", hakAkses: "pengelola" });
  assert.equal(lockState.held, false);

  // Sheet hilang -> requireAdminSession_ melempar CONFIG_ERROR sebelum lock, lock tetap free
  mockSheets.delete("Master_User");
  assert.throws(() => ctx.apiCreateUser(adminToken, { username: "u2", password: "password123", namaLengkap: "U2", hakAkses: "pengelola" }));
  assert.equal(lockState.held, false, "Lock harus dilepas meski terjadi error");
});

test("validateUserSheet_: sheet dengan <4 kolom throws SCHEMA_ERROR; header invalid throws SCHEMA_ERROR", () => {
  const { ctx, mockSheets } = createGasEnv();

  // Sheet dengan hanya 3 kolom
  const badSheet = new MockSheet("Master_User", [["username", "password", "namaLengkap"]], 3);
  mockSheets.set("Master_User", badSheet);
  assert.throws(
    () => ctx.validateUserSheet_(badSheet),
    (err) => err.code === "SCHEMA_ERROR",
  );

  // Sheet tanpa baris sama sekali (lastRow=0)
  const emptySheet = new MockSheet("Master_User", [], 4);
  assert.throws(
    () => ctx.validateUserSheet_(emptySheet),
    (err) => err.code === "SCHEMA_ERROR",
  );

  // Sheet dengan header yang tidak dikenali
  const badHeaderSheet = new MockSheet("Master_User", [["user_id", "pw", "name", "level"]], 4);
  assert.throws(
    () => ctx.validateUserSheet_(badHeaderSheet),
    (err) => err.code === "SCHEMA_ERROR",
  );
});

test("validateUserSheet_: header legacy wajar diterima (case-insensitive, whitespace)", () => {
  const { ctx } = createGasEnv();

  // Header dengan variasi case dan spasi
  const legacySheet = new MockSheet("Master_User", [
    ["Username", "Password", "Nama Lengkap", "Hak Akses"],
    ["admin", "sha256$s$h", "Administrator", "admin"],
  ], 4);
  // Tidak boleh melempar
  assert.doesNotThrow(() => ctx.validateUserSheet_(legacySheet));

  // Header dengan underscore
  const underscoreSheet = new MockSheet("Master_User", [
    ["username", "password", "nama_lengkap", "hak_akses"],
    ["admin", "sha256$s$h", "Administrator", "admin"],
  ], 4);
  assert.doesNotThrow(() => ctx.validateUserSheet_(underscoreSheet));

  // "role" sebagai header D
  const roleSheet = new MockSheet("Master_User", [
    ["username", "hash", "namaLengkap", "role"],
    ["admin", "sha256$s$h", "Administrator", "admin"],
  ], 4);
  assert.doesNotThrow(() => ctx.validateUserSheet_(roleSheet));
});

test("login throttle: ditolak setelah terlalu banyak percobaan gagal", () => {
  const { ctx } = createGasEnv();

  for (let i = 0; i < 5; i++) ctx.recordLoginFailure_("__unknown_username_bucket__");

  const result = ctx.login_({ username: "unknownuser", password: "anypassword" });
  assert.equal(result.errorCode, "INVALID_CREDENTIALS");
});

test("login throttle: mereset setelah login sukses", () => {
  const { ctx, userSheet, cacheStore, scriptProperties } = createGasEnv();

  // Set throttle counter untuk admin (username yang ada di sheet)
  // Kita perlu username yang ada di sheet dengan hash yang bisa diverifikasi
  // Gunakan plaintext password karena compatibility path
  userSheet.rows.push(["throttletest", "plainpass123", "Throttle User", "pengelola"]);

  const key = ctx.throttleCacheKey_("throttletest");
  cacheStore.set(key, { value: "3" });

  // Login sukses harus membersihkan counter
  const result = ctx.login_({ username: "throttletest", password: "plainpass123" });
  assert.equal(result.status, "success");
  assert.ok(!cacheStore.has(key) || cacheStore.get(key).value === "0" ||
    !ctx.isLoginThrottled_("throttletest"), "Counter harus dihapus setelah login sukses");
});

test("login throttle: menambah counter setelah login gagal", () => {
  const { ctx } = createGasEnv();

  ctx.login_({ username: "baduser", password: "wrongpass" });
  ctx.login_({ username: "baduser", password: "wrongpass" });

  // Counter harus > 0 setelah 2 percobaan gagal
  const key = ctx.throttleCacheKey_("__unknown_username_bucket__");
  assert.ok(ctx.readThrottleCount_(key).count >= 2, "Counter bucket unknown harus >= 2 setelah 2 percobaan gagal");
});

test("login throttle: tidak permanent lockout — block hilang setelah window (simulasi cache expired)", () => {
  const { ctx, cacheStore, scriptProperties } = createGasEnv();

  for (let i = 0; i < 5; i++) ctx.recordLoginFailure_("tempblock");
  const key = ctx.throttleCacheKey_("tempblock");
  assert.ok(ctx.isLoginThrottled_("tempblock"), "Harus terblokir");

  // Cache eviction tidak boleh menghapus batas aktif; persistent TTL adalah sumber kebenaran.
  cacheStore.delete(key);
  assert.equal(ctx.isLoginThrottled_("tempblock"), true, "Cache eviction tidak boleh mereset counter aktif");

  // Simulasikan window persistent sudah kedaluwarsa.
  const throttleState = JSON.parse(scriptProperties.get(ctx.THROTTLE_STATE_PROPERTY_));
  throttleState[key].expiresAt = 1;
  scriptProperties.set(ctx.THROTTLE_STATE_PROPERTY_, JSON.stringify(throttleState));
  assert.equal(ctx.isLoginThrottled_("tempblock"), false, "Tidak terblokir setelah cache expired");
});

test("users.update: legacy username dengan spasi dapat ditarget untuk update/reset/delete", () => {
  const { ctx, userSheet } = createGasEnv();
  // Legacy username dengan spasi
  userSheet.rows.push(["nama user lama", "sha256$s$h", "User Lama", "pengelola"]);

  const adminToken = makeAdminToken(ctx, userSheet);

  // Update dengan username berspace harus berhasil (validateUsernameTarget_ lebih permisif)
  const res = ctx.apiUpdateUser(adminToken, "nama user lama", { namaLengkap: "User Lama Diperbarui", hakAkses: "pengelola" });
  assert.equal(res.status, "success");
  assert.equal(res.data.username, "nama user lama");

  // Reset password dengan username berspace
  const resetRes = ctx.apiResetUserPassword(adminToken, "nama user lama", { newPassword: "newpassword123" });
  assert.equal(resetRes.status, "success");

  // Delete dengan username berspace
  const deleteRes = ctx.apiDeleteUser(adminToken, "nama user lama");
  assert.equal(deleteRes.status, "success");
});

test("users.create menolak username 65 char (batas ketat tanpa truncation)", () => {
  const { ctx, userSheet } = createGasEnv();
  const adminToken = makeAdminToken(ctx, userSheet);

  // Tepat 64 char harus diterima
  const name64 = "a" + "b".repeat(63);
  const res = ctx.apiCreateUser(adminToken, {
    username: name64,
    password: "password123",
    namaLengkap: "Valid User",
    hakAkses: "pengelola",
  });
  assert.equal(res.status, "success");

  // 65 char harus ditolak (bukan truncated menjadi 64 dan diterima)
  const name65 = "a" + "b".repeat(64);
  assert.throws(
    () => ctx.apiCreateUser(makeAdminToken(ctx, userSheet), {
      username: name65,
      password: "password123",
      namaLengkap: "Invalid User",
      hakAkses: "pengelola",
    }),
    (err) => err.code === "VALIDATION_ERROR",
  );
});

// ─── Stale Token on Letter Endpoints ──────────────────────────────────────
// requireCurrentSession_ is now applied to ALL authenticated endpoints.
// A token becomes stale after password reset, role change, or account deletion.
// These tests verify that stale tokens cannot access letters.* after any mutation.

test("stale token setelah reset password tidak dapat mengakses letters.list/create/update/delete", () => {
  const { ctx, userSheet, letterSheet } = createGasEnv();

  // Issue token before password reset.
  const tokenBefore = makeSessionToken(ctx, userSheet, "admin");

  // Create a letter while token is still valid.
  const created = ctx.apiCreateLetter(tokenBefore, sampleLetterPayload({ nama: "Surat Asli" }));
  assert.equal(created.status, "success");
  const letterId = created.data.id;

  // Simulate password reset by changing stored hash in sheet.
  const adminRow = userSheet.rows.find((r) => String(r[0]).trim() === "admin");
  adminRow[1] = "sha256$newsalt$newhash";

  // All letter operations must now fail AUTH_REQUIRED with stale token.
  assert.throws(
    () => ctx.apiListLetters(tokenBefore),
    (err) => err.code === "AUTH_REQUIRED",
  );
  assert.throws(
    () => ctx.apiCreateLetter(tokenBefore, sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED",
  );
  assert.throws(
    () => ctx.apiUpdateLetter(tokenBefore, letterId, sampleLetterPayload({ nama: "Updated" })),
    (err) => err.code === "AUTH_REQUIRED",
  );
  assert.throws(
    () => ctx.apiDeleteLetter(tokenBefore, letterId),
    (err) => err.code === "AUTH_REQUIRED",
  );

  // Fresh token after reset must work.
  const tokenAfter = makeSessionToken(ctx, userSheet, "admin");
  const listRes = ctx.apiListLetters(tokenAfter);
  assert.equal(listRes.status, "success");
});

test("stale token setelah akun dihapus tidak dapat mengakses letters.*", () => {
  const { ctx, userSheet } = createGasEnv();

  // staff exists in default sheet; get a valid token.
  const staffToken = makeSessionToken(ctx, userSheet, "staff");

  // Letters list succeeds with valid token.
  const listRes = ctx.apiListLetters(staffToken);
  assert.equal(listRes.status, "success");

  // Remove staff from sheet.
  const staffIdx = userSheet.rows.findIndex((r) => String(r[0]).trim() === "staff");
  userSheet.rows.splice(staffIdx, 1);

  // Token is now stale — account deleted.
  assert.throws(
    () => ctx.apiListLetters(staffToken),
    (err) => err.code === "AUTH_REQUIRED",
  );
});

test("stale token setelah role downgrade tidak dapat mengakses letters.*; current pengelola boleh list/create/update tapi tidak delete", () => {
  const { ctx, userSheet } = createGasEnv();

  // Add a second admin so we can downgrade "admin" without LAST_ADMIN_PROTECTED.
  const adminToken = makeAdminToken(ctx, userSheet);
  ctx.apiCreateUser(adminToken, {
    username: "admin2",
    password: "password123",
    namaLengkap: "Admin Dua",
    hakAkses: "admin",
  });

  // Token for "admin" while still admin.
  const tokenBeforeDowngrade = makeAdminToken(ctx, userSheet, "admin");

  // Create a letter while still admin.
  const created = ctx.apiCreateLetter(tokenBeforeDowngrade, sampleLetterPayload({ nama: "Surat Admin" }));
  assert.equal(created.status, "success");
  const letterId = created.data.id;

  // Simulate role downgrade in sheet.
  const adminRow = userSheet.rows.find((r) => String(r[0]).trim() === "admin");
  adminRow[3] = "pengelola";

  // Stale token (sv computed from admin role) must be rejected — sv mismatch.
  assert.throws(
    () => ctx.apiListLetters(tokenBeforeDowngrade),
    (err) => err.code === "AUTH_REQUIRED",
  );

  // Fresh token with current pengelola role must be accepted for letters.*.
  const pengelolaToken = makeSessionToken(ctx, userSheet, "admin"); // now role=pengelola
  const listRes = ctx.apiListLetters(pengelolaToken);
  assert.equal(listRes.status, "success");

  // Pengelola can create and update.
  const createRes = ctx.apiCreateLetter(pengelolaToken, sampleLetterPayload({ nama: "Surat Pengelola" }));
  assert.equal(createRes.status, "success");
  const updateRes = ctx.apiUpdateLetter(pengelolaToken, letterId, sampleLetterPayload({ nama: "Updated" }));
  assert.equal(updateRes.status, "success");

  // Pengelola cannot delete — FORBIDDEN (business rule, not stale token).
  assert.throws(
    () => ctx.apiDeleteLetter(pengelolaToken, letterId),
    (err) => err.code === "FORBIDDEN",
  );
});

test("token tanpa sv ditolak untuk semua letters.* setelah v2.4", () => {
  const { ctx } = createGasEnv();

  // Create a token with no sv field (simulates pre-v2.4 token).
  const noSvToken = ctx.createSessionToken_({
    username: "admin",
    namaLengkap: "Admin",
    hakAkses: "admin",
    // no sv
  });

  assert.throws(
    () => ctx.apiListLetters(noSvToken),
    (err) => err.code === "AUTH_REQUIRED" && /versi credential/i.test(err.message),
  );
  assert.throws(
    () => ctx.apiCreateLetter(noSvToken, sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED",
  );
  assert.throws(
    () => ctx.apiUpdateLetter(noSvToken, "KGB-1", sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED",
  );
  assert.throws(
    () => ctx.apiDeleteLetter(noSvToken, "KGB-1"),
    (err) => err.code === "AUTH_REQUIRED",
  );
});

// ─── TOCTOU Actor Re-validation Inside Lock ────────────────────────────────

test("TOCTOU: actor downgraded between pre-check and lock: mutation rejected inside lock", () => {
  const { ctx, userSheet } = createGasEnv();

  // Add second admin to allow downgrade.
  const adminToken = makeAdminToken(ctx, userSheet);
  ctx.apiCreateUser(adminToken, {
    username: "admin2",
    password: "password123",
    namaLengkap: "Admin Dua",
    hakAkses: "admin",
  });

  // Obtain valid admin token.
  const token = makeAdminToken(ctx, userSheet, "admin");

  // Simulate race: downgrade admin in sheet BEFORE the mutation lock fires.
  // We intercept by patching sheet — in real GAS a concurrent execution would do this.
  // Mock: override getDataRange inside the lock to return downgraded actor.
  const orig = userSheet.getDataRange.bind(userSheet);
  let callCount = 0;
  userSheet.getDataRange = function() {
    callCount++;
    if (callCount === 1) {
      // First call (inside lock, TOCTOU re-read): return rows with actor downgraded.
      const rows = orig().getDisplayValues();
      const fakeRows = rows.map((r, i) => {
        if (i > 0 && String(r[0]).trim() === "admin") {
          return [r[0], r[1], r[2], "pengelola"];
        }
        return r;
      });
      return {
        getValues: () => fakeRows,
        getDisplayValues: () => fakeRows,
      };
    }
    return orig();
  };

  // The mutation must be rejected because actor's live role is pengelola inside the lock.
  assert.throws(
    () => ctx.apiCreateUser(token, {
      username: "newuser",
      password: "password123",
      namaLengkap: "New User",
      hakAkses: "pengelola",
    }),
    (err) => err.code === "FORBIDDEN" || err.code === "AUTH_REQUIRED",
  );

  // Restore original.
  userSheet.getDataRange = orig;
});

test("TOCTOU: lock always released even when actor re-validation throws", () => {
  const { ctx, userSheet, lockState } = createGasEnv();

  // Token valid but actor row will be missing from sheet (simulates concurrent delete).
  const token = makeAdminToken(ctx, userSheet, "admin");

  // Remove admin from sheet before the lock fires.
  const idx = userSheet.rows.findIndex((r) => String(r[0]).trim() === "admin");
  userSheet.rows.splice(idx, 1);

  // This will throw AUTH_REQUIRED inside the lock.
  assert.throws(
    () => ctx.apiCreateUser(token, {
      username: "x",
      password: "password123",
      namaLengkap: "X",
      hakAkses: "pengelola",
    }),
  );

  // Lock must not be held after exception.
  assert.equal(lockState.held, false, "Lock must be released after TOCTOU exception");
});

// ─── Throttle ScriptLock Usage and Fallback ────────────────────────────────

test("throttle: ScriptLock acquired/released for each read-modify-write", () => {
  const { ctx, lockState } = createGasEnv();

  const callsBefore = lockState.waitLockCalled;

  // isLoginThrottled_ acquires lock.
  ctx.isLoginThrottled_("someuser");
  assert.ok(lockState.waitLockCalled > callsBefore, "isLoginThrottled_ must acquire lock");
  assert.equal(lockState.held, false, "Lock released after isLoginThrottled_");

  const afterCheck = lockState.waitLockCalled;

  // recordLoginFailure_ acquires lock.
  ctx.recordLoginFailure_("someuser");
  assert.ok(lockState.waitLockCalled > afterCheck, "recordLoginFailure_ must acquire lock");
  assert.equal(lockState.held, false, "Lock released after recordLoginFailure_");

  const afterRecord = lockState.waitLockCalled;

  // clearLoginThrottle_ acquires lock.
  ctx.clearLoginThrottle_("someuser");
  assert.ok(lockState.waitLockCalled > afterRecord, "clearLoginThrottle_ must acquire lock");
  assert.equal(lockState.held, false, "Lock released after clearLoginThrottle_");
});

test("throttle: PropertiesService fallback used when CacheService unavailable", () => {
  const { ctx, scriptProperties } = createGasEnv();

  // Override CacheService to be unavailable.
  ctx.CacheService = null;

  // Record 5 failures — should fall through to PropertiesService.
  for (let i = 0; i < 5; i++) {
    ctx.recordLoginFailure_("propmodeuser");
  }

  // Should now be throttled via PropertiesService.
  assert.ok(ctx.isLoginThrottled_("propmodeuser"), "Must be throttled via Properties fallback");

  // Clear throttle.
  ctx.clearLoginThrottle_("propmodeuser");
  assert.equal(ctx.isLoginThrottled_("propmodeuser"), false, "Must be clear after explicit clear");
});

test("throttle: fail-closed when both CacheService and PropertiesService fail", () => {
  const { ctx } = createGasEnv();

  // Override CacheService to throw.
  ctx.CacheService = { getScriptCache: () => { throw new Error("cache unavailable"); } };

  // Override PropertiesService to throw.
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: () => { throw new Error("props unavailable"); },
      setProperty: () => { throw new Error("props unavailable"); },
      deleteProperty: () => { throw new Error("props unavailable"); },
    }),
  };

  // isLoginThrottled_ must fail-closed (return true) when both stores fail.
  // The readThrottleCount_ returns {count: THROTTLE_MAX_ATTEMPTS_, source:"error"}.
  const throttled = ctx.isLoginThrottled_("failuser");
  assert.equal(throttled, true, "Must fail-closed when both stores unavailable");
});

test("throttle: username stored only as hashed key, not plaintext", () => {
  const { ctx, cacheStore, scriptProperties } = createGasEnv();

  ctx.recordLoginFailure_("sensitive_username");

  // Cache keys must not contain the plaintext username.
  for (const key of cacheStore.keys()) {
    assert.equal(key.includes("sensitive_username"), false,
      "Cache key must not contain plaintext username: " + key);
    assert.match(key, /^lt_[a-f0-9]{32}$/, "Cache key must be hashed: " + key);
  }

  // Script property keys must also not contain plaintext username.
  for (const key of scriptProperties.keys()) {
    if (key.startsWith("lt_") || key.startsWith("ltt_")) {
      assert.equal(key.includes("sensitive_username"), false,
        "Property key must not contain plaintext username: " + key);
    }
  }
});

test("throttle: counter increments atomically and block expires correctly", () => {
  const { ctx, cacheStore, scriptProperties } = createGasEnv();

  // 4 failures — not yet blocked.
  for (let i = 0; i < 4; i++) {
    ctx.recordLoginFailure_("limituser");
  }
  assert.equal(ctx.isLoginThrottled_("limituser"), false, "Should not be blocked at 4 failures");

  // 5th failure — now blocked.
  ctx.recordLoginFailure_("limituser");
  assert.equal(ctx.isLoginThrottled_("limituser"), true, "Should be blocked at 5 failures");

  // Cache eviction must preserve the authoritative persistent counter.
  const key = ctx.throttleCacheKey_("limituser");
  cacheStore.delete(key);
  assert.equal(ctx.isLoginThrottled_("limituser"), true, "Cache eviction must not reset active block");

  // Expire the authoritative persistent TTL.
  const throttleState = JSON.parse(scriptProperties.get(ctx.THROTTLE_STATE_PROPERTY_));
  throttleState[key].expiresAt = 1;
  scriptProperties.set(ctx.THROTTLE_STATE_PROPERTY_, JSON.stringify(throttleState));
  assert.equal(ctx.isLoginThrottled_("limituser"), false, "Should not be blocked after expiry");
});

// ─── Gateway: Recursive Password Absence in users.list ────────────────────

// (Additional gateway tests are in cloudflare-api.test.mjs.
//  Here we verify the GAS backend never includes password in any nested object.)

// ─── Stale Token on Letter Endpoints — Explicit Delete/Live-role Coverage ──

test("stale sv setelah password reset: letters.list, letters.create, letters.delete masing-masing ditolak AUTH_REQUIRED", () => {
  const { ctx, userSheet, letterSheet } = createGasEnv();
  const token = makeSessionToken(ctx, userSheet, "admin");

  // Pre-populate one letter so delete has a target.
  const created = ctx.apiCreateLetter(token, sampleLetterPayload({ nama: "Pre-existing" }));
  assert.equal(created.status, "success");
  const letterId = created.data.id;

  // Mutate stored hash → sv mismatch.
  userSheet.rows.find((r) => String(r[0]).trim() === "admin")[1] = "sha256$X$Y";

  // list
  assert.throws(
    () => ctx.apiListLetters(token),
    (err) => err.code === "AUTH_REQUIRED",
    "letters.list deve rejeitar token stale",
  );

  // create
  assert.throws(
    () => ctx.apiCreateLetter(token, sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED",
    "letters.create deve rejeitar token stale",
  );

  // delete (admin was the role — stale token, not role check)
  assert.throws(
    () => ctx.apiDeleteLetter(token, letterId),
    (err) => err.code === "AUTH_REQUIRED",
    "letters.delete deve rejeitar token stale",
  );

  // Fresh token must work — list succeeds.
  const fresh = makeSessionToken(ctx, userSheet, "admin");
  assert.equal(ctx.apiListLetters(fresh).status, "success");
});

test("live role pengelola dapat list/create/update surat tapi tidak delete; downgrade dari admin melalui sv stale wajib re-login", () => {
  const { ctx, userSheet } = createGasEnv();

  // Need two admins so we can downgrade "admin" without LAST_ADMIN_PROTECTED.
  const t0 = makeAdminToken(ctx, userSheet);
  ctx.apiCreateUser(t0, { username: "admin2", password: "password123", namaLengkap: "Admin2", hakAkses: "admin" });

  // Capture token while admin.
  const staleTok = makeAdminToken(ctx, userSheet, "admin");

  // Create a letter (admin can).
  const created = ctx.apiCreateLetter(staleTok, sampleLetterPayload({ nama: "LivRoleTest" }));
  assert.equal(created.status, "success");
  const lid = created.data.id;

  // Downgrade admin→pengelola in sheet (sv changes because role component changes).
  userSheet.rows.find((r) => String(r[0]).trim() === "admin")[3] = "pengelola";

  // Stale token: sv was computed with role=admin; now role=pengelola → mismatch → AUTH_REQUIRED.
  assert.throws(
    () => ctx.apiListLetters(staleTok),
    (err) => err.code === "AUTH_REQUIRED",
  );

  // Fresh token with live role=pengelola.
  const liveTok = makeSessionToken(ctx, userSheet, "admin"); // role now pengelola
  assert.equal(ctx.apiListLetters(liveTok).status, "success");
  assert.equal(ctx.apiCreateLetter(liveTok, sampleLetterPayload({ nama: "byPengelola" })).status, "success");
  assert.equal(ctx.apiUpdateLetter(liveTok, lid, sampleLetterPayload({ nama: "updated" })).status, "success");

  // Pengelola cannot delete — live role controls this (FORBIDDEN, not AUTH_REQUIRED).
  assert.throws(
    () => ctx.apiDeleteLetter(liveTok, lid),
    (err) => err.code === "FORBIDDEN",
  );
});

// ─── TOCTOU — Actor Row Changed at waitLock Callback ──────────────────────

test("TOCTOU: actor row changed AT waitLock callback; mutation rejected inside lock via re-read", () => {
  // We need a LockService where waitLock itself mutates the actor row, simulating
  // a concurrent GAS execution that runs between the pre-check and the lock acquisition.
  const scriptProperties = new Map([
    ["CLOUDFLARE_API_SECRET", "test-secret-123"],
    ["SESSION_SIGNING_SECRET", "session-secret-key-1234567890"],
    ["SPREADSHEET_ID", "test-sheet-id"],
    ["PASSWORD_PEPPER", "test-pepper-abc123"],
  ]);
  const lockState = { held: false, waitLockCalled: 0, releaseLockCalled: 0 };
  const mockSheets = new Map();
  const cacheStore = new Map();

  const code = fs.readFileSync(codeJsPath, "utf8");

  const adminHash = "sha256$testsalt$testhash";
  const admin2Hash = "sha256$salt2$hash2";
  // userSheet exposed so waitLock can mutate it.
  const userSheet = new MockSheet("Master_User", [
    ["username", "password", "namaLengkap", "hakAkses"],
    ["admin", adminHash, "Administrator", "admin"],
    ["admin2", admin2Hash, "Admin2", "admin"],
  ], 4);
  mockSheets.set("Master_User", userSheet);

  let waitLockCallCount = 0;

  const ctx = {
    console, Date, Math, JSON, RegExp, String, Number, Array, Object, Error, Buffer,
    Utilities: UtilitiesMock,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => scriptProperties.get(k) || null,
        setProperty: (k, v) => scriptProperties.set(k, String(v)),
        deleteProperty: (k) => scriptProperties.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          waitLockCallCount++;
          lockState.held = true;
          lockState.waitLockCalled++;
          // Simulate concurrent execution: at the moment the lock is acquired,
          // another GAS execution has already downgraded the actor's role.
          if (waitLockCallCount === 1) {
            const adminRow = userSheet.rows.find((r) => String(r[0]).trim() === "admin");
            if (adminRow) adminRow[3] = "pengelola";
          }
        },
        hasLock: () => lockState.held,
        releaseLock: () => { lockState.held = false; lockState.releaseLockCalled++; },
      }),
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (n) => mockSheets.get(n) || null }),
      flush: () => {},
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cacheStore.has(k) ? cacheStore.get(k) : null, put: (k, v) => cacheStore.set(k, String(v)), remove: (k) => cacheStore.delete(k) }) },
    ContentService: ContentServiceMock,
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({ addMetaTag: () => ({}) }) }) }) },
  };

  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  mockSheets.set("Database_Surat", new MockSheet("Database_Surat", [["Timestamp", ...ctx.LETTER_FIELDS_]], 27));

  // Token for admin (valid sv at token issuance time, role=admin).
  const token = ctx.createSessionToken_({
    username: "admin",
    namaLengkap: "Administrator",
    hakAkses: "admin",
    sv: ctx.computeSessionVersion_(adminHash, "admin"),
  });

  // requireCurrentSession_ passes (sv valid before lock), but inside lock the role changed.
  assert.throws(
    () => ctx.apiCreateUser(token, {
      username: "victim",
      password: "password123",
      namaLengkap: "Victim",
      hakAkses: "pengelola",
    }),
    (err) => err.code === "FORBIDDEN" || err.code === "AUTH_REQUIRED",
    "TOCTOU: mutation must be rejected when actor role changed at waitLock",
  );

  // Lock must always be released.
  assert.equal(lockState.held, false, "Lock must be released after TOCTOU exception");
  assert.ok(lockState.waitLockCalled >= 1, "waitLock must have been called");
});

test("TOCTOU: lock always released when actor row deleted at waitLock callback", () => {
  const scriptProperties = new Map([
    ["CLOUDFLARE_API_SECRET", "test-secret-123"],
    ["SESSION_SIGNING_SECRET", "session-secret-key-1234567890"],
    ["SPREADSHEET_ID", "test-sheet-id"],
    ["PASSWORD_PEPPER", "test-pepper-abc123"],
  ]);
  const lockState = { held: false, waitLockCalled: 0, releaseLockCalled: 0 };
  const mockSheets = new Map();

  const adminHash = "sha256$testsalt$testhash";
  const userSheet = new MockSheet("Master_User", [
    ["username", "password", "namaLengkap", "hakAkses"],
    ["admin", adminHash, "Administrator", "admin"],
  ], 4);
  mockSheets.set("Master_User", userSheet);

  const code = fs.readFileSync(codeJsPath, "utf8");
  const ctx = {
    console, Date, Math, JSON, RegExp, String, Number, Array, Object, Error, Buffer,
    Utilities: UtilitiesMock,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => scriptProperties.get(k) || null,
        setProperty: (k, v) => scriptProperties.set(k, String(v)),
        deleteProperty: (k) => scriptProperties.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          lockState.held = true;
          lockState.waitLockCalled++;
          // Concurrent deletion of actor row while waiting for lock.
          const idx = userSheet.rows.findIndex((r) => String(r[0]).trim() === "admin");
          if (idx > 0) userSheet.rows.splice(idx, 1);
        },
        hasLock: () => lockState.held,
        releaseLock: () => { lockState.held = false; lockState.releaseLockCalled++; },
      }),
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (n) => mockSheets.get(n) || null }),
      flush: () => {},
    },
    CacheService: null,
    ContentService: ContentServiceMock,
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({ addMetaTag: () => ({}) }) }) }) },
  };

  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  mockSheets.set("Database_Surat", new MockSheet("Database_Surat", [["Timestamp", ...ctx.LETTER_FIELDS_]], 27));

  const token = ctx.createSessionToken_({
    username: "admin",
    namaLengkap: "Administrator",
    hakAkses: "admin",
    sv: ctx.computeSessionVersion_(adminHash, "admin"),
  });

  assert.throws(
    () => ctx.apiDeleteUser(token, "admin"),
    // FORBIDDEN (self-delete fast-path before lock) or AUTH_REQUIRED (account gone inside lock).
  );
  assert.equal(lockState.held, false, "Lock released even when actor row deleted in waitLock");
});

// ─── Throttle — ScriptLock Separateness and CacheService Failure Coverage ──

test("throttle ScriptLock: waitLock is called for isLoginThrottled_, recordLoginFailure_, clearLoginThrottle_ and lock released after each", () => {
  const { ctx, lockState } = createGasEnv();

  const before = lockState.waitLockCalled;
  ctx.isLoginThrottled_("u1");
  const after1 = lockState.waitLockCalled;
  assert.ok(after1 > before, "isLoginThrottled_ must call waitLock");
  assert.equal(lockState.held, false, "lock released after isLoginThrottled_");

  ctx.recordLoginFailure_("u1");
  const after2 = lockState.waitLockCalled;
  assert.ok(after2 > after1, "recordLoginFailure_ must call waitLock");
  assert.equal(lockState.held, false, "lock released after recordLoginFailure_");

  ctx.clearLoginThrottle_("u1");
  const after3 = lockState.waitLockCalled;
  assert.ok(after3 > after2, "clearLoginThrottle_ must call waitLock");
  assert.equal(lockState.held, false, "lock released after clearLoginThrottle_");

  // Verify throttle lock is separate from user mutation lock: both use waitLock
  // sequentially (never nested), so no deadlock.
  // After throttle ops + a user mutation, lock is still clean.
  const adminToken = makeAdminToken(ctx, createGasEnv().userSheet);
  // (fresh env for user mutation — separate mockSheet)
  const { ctx: ctx2, userSheet: us2, lockState: ls2 } = createGasEnv();
  const tok2 = makeAdminToken(ctx2, us2);
  ctx2.apiCreateUser(tok2, { username: "mu1", password: "password123", namaLengkap: "MU", hakAkses: "pengelola" });
  assert.equal(ls2.held, false, "mutation lock released after create");
});

test("throttle CacheService error → PropertiesService fallback, counts persisted and throttle works", () => {
  const { ctx, scriptProperties } = createGasEnv();

  // Make CacheService throw on every operation (simulates quota error).
  ctx.CacheService = {
    getScriptCache: () => ({
      get: () => { throw new Error("quota exceeded"); },
      put: () => { throw new Error("quota exceeded"); },
      remove: () => { throw new Error("quota exceeded"); },
    }),
  };

  // recordLoginFailure_ should fall back to PropertiesService.
  for (let i = 0; i < 5; i++) {
    ctx.recordLoginFailure_("cacheErrorUser");
  }

  // isLoginThrottled_ must also use PropertiesService fallback and return true.
  assert.equal(ctx.isLoginThrottled_("cacheErrorUser"), true,
    "Must be throttled via PropertiesService when CacheService errors");

  // clearLoginThrottle_ must clear via PropertiesService.
  ctx.clearLoginThrottle_("cacheErrorUser");
  assert.equal(ctx.isLoginThrottled_("cacheErrorUser"), false,
    "Must not be throttled after explicit clear via fallback");
});

test("throttle both stores error: fail-closed dengan respons login generik", () => {
  const { ctx, userSheet } = createGasEnv();

  // Override both stores to throw.
  ctx.CacheService = { getScriptCache: () => { throw new Error("cache down"); } };
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: () => { throw new Error("props down"); },
      setProperty: () => { throw new Error("props down"); },
      deleteProperty: () => { throw new Error("props down"); },
    }),
  };

  // isLoginThrottled_ must fail-closed.
  assert.equal(ctx.isLoginThrottled_("anyuser"), true,
    "Fail-closed: must block when both stores unavailable");

  // Public response remains generic to prevent account enumeration.
  const result = ctx.login_({ username: "anyuser", password: "anypassword" });
  assert.equal(result.errorCode, "INVALID_CREDENTIALS");
});

// ─── Helper: GAS Env with custom waitLock callback ─────────────────────────
// Used for letter-level TOCTOU tests where we need to mutate userSheet at the
// exact moment the ScriptLock is acquired inside a letter mutation.

function createGasEnvWithWaitLockCallback(onWaitLock) {
  const scriptProperties = new Map([
    ["CLOUDFLARE_API_SECRET", "test-secret-123"],
    ["SESSION_SIGNING_SECRET", "session-secret-key-1234567890"],
    ["SPREADSHEET_ID", "test-sheet-id"],
    ["PASSWORD_PEPPER", "test-pepper-abc123"],
  ]);
  const lockState = { held: false, waitLockCalled: 0, releaseLockCalled: 0 };
  const mockSheets = new Map();
  const cacheStore = new Map();

  const adminHash = "sha256$testsalt$testhash";
  const userSheet = new MockSheet("Master_User", [
    ["username", "password", "namaLengkap", "hakAkses"],
    ["admin", adminHash, "Administrator", "admin"],
  ], 4);
  mockSheets.set("Master_User", userSheet);

  const letterSheet = new MockSheet("Database_Surat", [["Timestamp", "id"]], 27);
  mockSheets.set("Database_Surat", letterSheet);

  const code = fs.readFileSync(codeJsPath, "utf8");
  const ctx = {
    console, Date, Math, JSON, RegExp, String, Number, Array, Object, Error, Buffer,
    Utilities: UtilitiesMock,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => scriptProperties.get(k) || null,
        setProperty: (k, v) => scriptProperties.set(k, String(v)),
        deleteProperty: (k) => scriptProperties.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          lockState.held = true;
          lockState.waitLockCalled++;
          if (onWaitLock) onWaitLock(userSheet, lockState.waitLockCalled);
        },
        hasLock: () => lockState.held,
        releaseLock: () => { lockState.held = false; lockState.releaseLockCalled++; },
      }),
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (n) => mockSheets.get(n) || null }),
      flush: () => {},
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cacheStore.has(k) ? cacheStore.get(k) : null,
        put: (k, v) => cacheStore.set(k, String(v)),
        remove: (k) => cacheStore.delete(k),
      }),
    },
    ContentService: ContentServiceMock,
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle: () => ({ addMetaTag: () => ({}) }) }) }) },
  };

  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  // Proper letter sheet with all required columns.
  const fullLetterSheet = new MockSheet("Database_Surat", [["Timestamp", ...ctx.LETTER_FIELDS_]], 27);
  mockSheets.set("Database_Surat", fullLetterSheet);

  return { ctx, mockSheets, userSheet, fullLetterSheet, lockState, adminHash };
}

// ─── Letter TOCTOU: Actor Changed at waitLock in create/update/delete ──────

test("letter create TOCTOU: actor row deleted at waitLock → AUTH_REQUIRED, lock released, no letter written", () => {
  let waitCallCount = 0;
  const { ctx, userSheet, fullLetterSheet, lockState, adminHash } = createGasEnvWithWaitLockCallback(
    (sheet, callCount) => {
      waitCallCount++;
      // On the letter-create waitLock, delete the actor row.
      if (waitCallCount === 1) {
        const idx = sheet.rows.findIndex((r) => String(r[0]).trim() === "admin");
        if (idx > 0) sheet.rows.splice(idx, 1);
      }
    },
  );

  const token = ctx.createSessionToken_({
    username: "admin",
    namaLengkap: "Administrator",
    hakAkses: "admin",
    sv: ctx.computeSessionVersion_(adminHash, "admin"),
  });

  const rowsBefore = fullLetterSheet.rows.length;

  assert.throws(
    () => ctx.apiCreateLetter(token, sampleLetterPayload({ nama: "ShouldNotExist" })),
    (err) => err.code === "AUTH_REQUIRED",
    "Letter create must reject when actor deleted at waitLock",
  );

  assert.equal(lockState.held, false, "Lock must be released after exception");
  assert.equal(fullLetterSheet.rows.length, rowsBefore, "No letter row must be written");
});

test("letter update TOCTOU: actor role changed to pengelola at waitLock → AUTH_REQUIRED, lock released, row unchanged", () => {
  // First create a letter with a normal env.
  const { ctx: setupCtx, userSheet: setupSheet } = createGasEnv();
  const setupToken = makeAdminToken(setupCtx, setupSheet);
  const created = setupCtx.apiCreateLetter(setupToken, sampleLetterPayload({ nama: "Original" }));
  const letterId = created.data.id;

  // Now create TOCTOU env for the update: actor role downgraded at waitLock.
  let waitCallCount = 0;
  const { ctx, userSheet, fullLetterSheet, lockState, adminHash } = createGasEnvWithWaitLockCallback(
    (sheet, callCount) => {
      waitCallCount++;
      if (waitCallCount === 1) {
        // Simulate concurrent role downgrade.
        const adminRow = sheet.rows.find((r) => String(r[0]).trim() === "admin");
        if (adminRow) adminRow[3] = "pengelola";
      }
    },
  );

  // Pre-populate letter in the TOCTOU env's sheet.
  fullLetterSheet.rows.push([new Date(), letterId, ...Array(25).fill("val")]);
  const origRow = [...fullLetterSheet.rows[1]];

  const token = ctx.createSessionToken_({
    username: "admin",
    namaLengkap: "Administrator",
    hakAkses: "admin",
    sv: ctx.computeSessionVersion_(adminHash, "admin"),
  });

  assert.throws(
    () => ctx.apiUpdateLetter(token, letterId, sampleLetterPayload({ nama: "ShouldNotUpdate" })),
    (err) => err.code === "AUTH_REQUIRED" || err.code === "FORBIDDEN",
    "Letter update must reject when actor role changed at waitLock",
  );

  assert.equal(lockState.held, false, "Lock must be released");
  // Row should be unchanged (TOCTOU exception before setValues).
  assert.equal(String(fullLetterSheet.rows[1][1]), letterId, "Letter row ID must be unchanged");
});

test("letter delete TOCTOU: actor sv invalidated at waitLock → AUTH_REQUIRED, lock released, no row deleted", () => {
  let waitCallCount = 0;
  const { ctx, userSheet, fullLetterSheet, lockState, adminHash } = createGasEnvWithWaitLockCallback(
    (sheet, callCount) => {
      waitCallCount++;
      if (waitCallCount === 1) {
        // Simulate concurrent password reset — sv changes.
        const adminRow = sheet.rows.find((r) => String(r[0]).trim() === "admin");
        if (adminRow) adminRow[1] = "sha256$differenthash$differentvalue";
      }
    },
  );

  const letterId = "KGB-2026-toctou-delete-test";
  fullLetterSheet.rows.push([new Date(), letterId, ...Array(25).fill("val")]);
  const rowsBefore = fullLetterSheet.rows.length;

  const token = ctx.createSessionToken_({
    username: "admin",
    namaLengkap: "Administrator",
    hakAkses: "admin",
    sv: ctx.computeSessionVersion_(adminHash, "admin"),
  });

  assert.throws(
    () => ctx.apiDeleteLetter(token, letterId),
    (err) => err.code === "AUTH_REQUIRED",
    "Letter delete must reject when actor sv invalidated at waitLock",
  );

  assert.equal(lockState.held, false, "Lock must be released");
  assert.equal(fullLetterSheet.rows.length, rowsBefore, "No letter row must be deleted");
});

test("letter delete: live role controls delete — pengelola rejected FORBIDDEN even with valid sv", () => {
  // Actor is pengelola in the sheet. Token carries pengelola sv.
  const { ctx, userSheet } = createGasEnv();
  // staff is pengelola in default sheet.
  const staffToken = makeSessionToken(ctx, userSheet, "staff");

  // Create a letter as admin first.
  const adminToken = makeAdminToken(ctx, userSheet);
  const created = ctx.apiCreateLetter(adminToken, sampleLetterPayload({ nama: "LetterForDelete" }));
  const letterId = created.data.id;

  // Pengelola token is valid (sv matches live sheet), but live role=pengelola → FORBIDDEN.
  assert.throws(
    () => ctx.apiDeleteLetter(staffToken, letterId),
    (err) => err.code === "FORBIDDEN",
    "Pengelola with valid token must be rejected for delete by live role check",
  );
});

// ─── consumeLoginAttempt_: atomic reserve before verify; no double-increment ─

test("consumeLoginAttempt_: reserves slot atomically; max 5 attempts reach verify; 6th is blocked", () => {
  const { ctx, cacheStore } = createGasEnv();

  // Simulate 5 sequential consumed attempts.
  const key = ctx.throttleCacheKey_("rateme");
  for (let i = 0; i < 5; i++) {
    const result = ctx.consumeLoginAttempt_("rateme");
    assert.equal(result.allowed, true, `Attempt ${i + 1} must be allowed`);
  }
  // Verify counter via production readThrottleCount_ — decoupled from mock internals.
  assert.equal(ctx.readThrottleCount_(key).count, 5, "Counter must be 5 after 5 consumed attempts");

  // 6th attempt must be blocked.
  const sixth = ctx.consumeLoginAttempt_("rateme");
  assert.equal(sixth.allowed, false, "6th attempt must be blocked");

  // Counter must still be 5 — no increment when blocked.
  assert.equal(ctx.readThrottleCount_(key).count, 5, "Counter must not increment when blocked");
});

test("consumeLoginAttempt_: slot reserved before password verify; failed login does not double-increment", () => {
  const { ctx, userSheet } = createGasEnv();
  // Add a user with a plaintext password so no pepper required.
  userSheet.rows.push(["testuser", "plaintextpass", "Test User", "pengelola"]);

  const key = ctx.throttleCacheKey_("testuser");

  // One failed login: consumeLoginAttempt_ reserves 1, then password fails.
  // login_ must NOT call recordLoginFailure_ separately.
  const result = ctx.login_({ username: "testuser", password: "wrongpassword" });
  assert.equal(result.errorCode, "INVALID_CREDENTIALS");

  // Counter must be exactly 1 (reserved by consume), not 2 (double-increment).
  assert.equal(ctx.readThrottleCount_(key).count, 1,
    "Counter must be exactly 1 after one failed login — no double-increment");
});

test("consumeLoginAttempt_: successful login clears the reserved slot", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["clearme", "correctpass", "Clear User", "pengelola"]);

  const key = ctx.throttleCacheKey_("clearme");

  // 3 failed attempts.
  for (let i = 0; i < 3; i++) {
    ctx.login_({ username: "clearme", password: "wrong" });
  }
  assert.equal(ctx.readThrottleCount_(key).count, 3, "Counter must be 3 after 3 failures");

  // Successful login clears counter.
  const success = ctx.login_({ username: "clearme", password: "correctpass" });
  assert.equal(success.status, "success", "Login must succeed with correct password");
  // After clear, readThrottleCount_ returns 0 (or source:none with count:0).
  assert.equal(ctx.readThrottleCount_(key).count, 0, "Counter must be 0 after successful login clear");
});

test("consumeLoginAttempt_: fail-closed when both stores unavailable dengan respons login generik", () => {
  const { ctx } = createGasEnv();

  ctx.CacheService = { getScriptCache: () => { throw new Error("cache down"); } };
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: () => { throw new Error("props down"); },
      setProperty: () => { throw new Error("props down"); },
      deleteProperty: () => { throw new Error("props down"); },
    }),
  };

  // consumeLoginAttempt_ fail-closed → allowed:false.
  const result = ctx.consumeLoginAttempt_("user");
  assert.equal(result.allowed, false, "consumeLoginAttempt_ must fail-closed");

  // login_ must not expose whether throttling or credential lookup failed.
  const loginResult = ctx.login_({ username: "user", password: "any" });
  assert.equal(loginResult.errorCode, "INVALID_CREDENTIALS");
});

// ─── consumeLoginAttempt_ high-level failure modes ─────────────────────────

test("consumeLoginAttempt_: LockService.getScriptLock unavailable (null) → blocked immediately", () => {
  // When getThrottleLock_() returns null, consumeLoginAttempt_ must fail-closed
  // without attempting any read or write — atomicity cannot be guaranteed.
  const { ctx } = createGasEnv();

  // Override LockService so getScriptLock returns null.
  ctx.LockService = { getScriptLock: () => null };

  const result = ctx.consumeLoginAttempt_("anyuser");
  assert.equal(result.allowed, false,
    "consumeLoginAttempt_ must be blocked when LockService.getScriptLock returns null");

  const loginResult = ctx.login_({ username: "anyuser", password: "any" });
  assert.equal(loginResult.errorCode, "INVALID_CREDENTIALS");
});

test("consumeLoginAttempt_: LockService.getScriptLock throws → blocked immediately", () => {
  const { ctx } = createGasEnv();

  // Override LockService so getScriptLock throws.
  ctx.LockService = { getScriptLock: () => { throw new Error("LockService unavailable"); } };

  const result = ctx.consumeLoginAttempt_("anyuser");
  assert.equal(result.allowed, false,
    "consumeLoginAttempt_ must be blocked when getScriptLock throws");
});

test("consumeLoginAttempt_: lock.waitLock throws → blocked, count not incremented", () => {
  const { ctx } = createGasEnv();

  // Lock exists but waitLock always throws (e.g. contention timeout).
  ctx.LockService = {
    getScriptLock: () => ({
      waitLock: () => { throw new Error("contention timeout"); },
      hasLock: () => false,
      releaseLock: () => {},
    }),
  };

  const result = ctx.consumeLoginAttempt_("anyuser");
  assert.equal(result.allowed, false,
    "consumeLoginAttempt_ must be blocked when waitLock throws");

  // Count must not have been incremented (read never happened after lock failed).
  const key = ctx.throttleCacheKey_("anyuser");
  assert.equal(ctx.readThrottleCount_(key).count, 0,
    "Count must remain 0 when waitLock throws before read");
});

test("consumeLoginAttempt_: read works but both cache.put and Properties writes fail → blocked (write fail-closed)", () => {
  const { ctx } = createGasEnv();

  // Cache readable (returns 0) but put throws.
  let readCalled = false;
  ctx.CacheService = {
    getScriptCache: () => ({
      get: () => { readCalled = true; return null; }, // null → falls to props
      put: () => { throw new Error("cache.put failed"); },
      remove: () => {},
    }),
  };

  // Properties also fail on writes.
  const scriptProps = new Map([
    ["CLOUDFLARE_API_SECRET", "test-secret-123"],
    ["SESSION_SIGNING_SECRET", "session-secret-key-1234567890"],
    ["SPREADSHEET_ID", "test-sheet-id"],
    ["PASSWORD_PEPPER", "test-pepper-abc123"],
  ]);
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => scriptProps.get(k) || null,
      setProperty: () => { throw new Error("props write failed"); },
      deleteProperty: () => {},
    }),
  };

  const result = ctx.consumeLoginAttempt_("anyuser");
  assert.equal(result.allowed, false,
    "consumeLoginAttempt_ must be blocked when writeThrottleCount_ returns false");
});

test("consumeLoginAttempt_: cache.put fails, Properties succeeds → allowed, count persisted in Properties", () => {
  const { ctx, scriptProperties } = createGasEnv();

  // Cache get returns null (no entry), cache.put throws.
  ctx.CacheService = {
    getScriptCache: () => ({
      get: () => null,
      put: () => { throw new Error("cache full"); },
      remove: () => {},
    }),
  };

  // Properties works normally (using the existing scriptProperties map from createGasEnv).

  const result = ctx.consumeLoginAttempt_("propfallback");
  assert.equal(result.allowed, true,
    "Should be allowed when Properties write succeeds after cache.put fails");

  // Count must be persisted in Properties.
  const key = ctx.throttleCacheKey_("propfallback");
  // readThrottleCount_ will check cache first (returns null), then Properties.
  const count = ctx.readThrottleCount_(key).count;
  assert.equal(count, 1,
    "Count must be 1 in Properties after cache.put fails but Properties succeeds");
});

test("writeThrottleCount_: bounded state write failure returns false without corrupting stored state", () => {
  const { ctx } = createGasEnv();

  // Cache unavailable.
  ctx.CacheService = null;

  const propStore = new Map([
    ["CLOUDFLARE_API_SECRET", "test-secret-123"],
    ["SESSION_SIGNING_SECRET", "session-secret-key-1234567890"],
    ["SPREADSHEET_ID", "test-sheet-id"],
    ["PASSWORD_PEPPER", "test-pepper-abc123"],
  ]);
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => propStore.get(k) || null,
      setProperty: () => { throw new Error("bounded state write failed"); },
      deleteProperty: (k) => propStore.delete(k),
    }),
  };

  const key = ctx.throttleCacheKey_("partialwrite");
  const written = ctx.writeThrottleCount_(key, 3);
  assert.equal(written, false, "writeThrottleCount_ must return false when bounded state cannot persist");

  assert.equal(propStore.has(ctx.THROTTLE_STATE_PROPERTY_), false,
    "Failed bounded write must not create throttle state");
});

// ─── LOGIN_THROTTLE_STATE_V1 Bounded State Tests ─────────────────────────

test("LOGIN_THROTTLE_STATE_V1: 250 unique usernames results in exactly one throttle property, <= THROTTLE_MAX_ENTRIES entries, hashed keys, and preserves unrelated properties", () => {
  const { ctx, scriptProperties } = createGasEnv();

  // Add extra unrelated custom config to verify preservation alongside standard configs
  scriptProperties.set("CUSTOM_APP_SETTING", "custom_value_42");
  const initialUnrelatedKeys = Array.from(scriptProperties.keys());
  const initialConfigSnapshot = Object.fromEntries(scriptProperties.entries());

  // Record login attempts for 250 unique usernames
  const usernames = [];
  for (let i = 0; i < 250; i++) {
    const username = `unique_user_${i}_${crypto.randomBytes(4).toString("hex")}`;
    usernames.push(username);
    const result = ctx.consumeLoginAttempt_(username);
    assert.equal(result.allowed, i < ctx.THROTTLE_MAX_ENTRIES_,
      `Attempt ${i} harus ${i < ctx.THROTTLE_MAX_ENTRIES_ ? "diizinkan" : "ditolak fail-closed"}`);
  }

  // Exactly one throttle Script Property in PropertiesService
  const throttleProp = ctx.THROTTLE_STATE_PROPERTY_;
  assert.equal(throttleProp, "LOGIN_THROTTLE_STATE_V1");
  assert.equal(scriptProperties.has(throttleProp), true, "Throttle state property must exist");

  // Verify no per-user throttle properties were created
  for (const key of scriptProperties.keys()) {
    if (key !== throttleProp) {
      assert.ok(initialUnrelatedKeys.includes(key), `Unexpected property created: ${key}`);
      assert.equal(scriptProperties.get(key), initialConfigSnapshot[key], `Unrelated property ${key} must be preserved`);
    }
  }
  assert.equal(scriptProperties.size, initialUnrelatedKeys.length + 1, "Script properties should only have config plus single throttle property");

  // Inspect throttle state payload
  const rawState = scriptProperties.get(throttleProp);
  const state = JSON.parse(rawState);
  const stateKeys = Object.keys(state);

  // State remains bounded and new keys fail closed after capacity is reached.
  assert.ok(stateKeys.length <= ctx.THROTTLE_MAX_ENTRIES_, `Entry count ${stateKeys.length} must be <= ${ctx.THROTTLE_MAX_ENTRIES_}`);
  assert.equal(stateKeys.length, ctx.THROTTLE_MAX_ENTRIES_, `Entry count must be capped at ${ctx.THROTTLE_MAX_ENTRIES_}`);

  // Keys must be hashed format /^lt_[a-f0-9]{32}$/ and contain no plaintext usernames
  for (const key of stateKeys) {
    assert.match(key, /^lt_[a-f0-9]{32}$/, `Key ${key} must match hashed format`);
    for (const u of usernames) {
      assert.equal(key.includes(u), false, `Key ${key} must not contain plaintext username ${u}`);
    }
    const entry = state[key];
    assert.equal(typeof entry.count, "number");
    assert.equal(entry.count, 1);
    assert.ok(entry.expiresAt > Date.now(), "expiresAt must be in the future");
  }
});

test("LOGIN_THROTTLE_STATE_V1: expired entries across unrelated usernames are globally cleaned on read and write access", () => {
  const { ctx, scriptProperties } = createGasEnv();
  const throttleProp = ctx.THROTTLE_STATE_PROPERTY_;

  const keyExpired1 = ctx.throttleCacheKey_("stale_user_1");
  const keyExpired2 = ctx.throttleCacheKey_("stale_user_2");
  const keyActive = ctx.throttleCacheKey_("active_user");

  const now = Date.now();
  const initialState = {
    [keyExpired1]: { count: 3, expiresAt: now - 10000 },
    [keyExpired2]: { count: 5, expiresAt: now - 1000 },
    [keyActive]: { count: 2, expiresAt: now + 60000 },
  };
  scriptProperties.set(throttleProp, JSON.stringify(initialState));

  // Scenario 2A: Access an unrelated username via read (readThrottleCount_ / isLoginThrottled_)
  const unrelatedKey = ctx.throttleCacheKey_("unrelated_reader");
  const readResult = ctx.readThrottleCount_(unrelatedKey);
  assert.equal(readResult.count, 0, "Unrelated user count should be 0");
  assert.equal(readResult.source, "none");

  // Verify expired entries were cleaned and persisted during the read
  const stateAfterRead = JSON.parse(scriptProperties.get(throttleProp));
  assert.equal(keyExpired1 in stateAfterRead, false, "Expired entry 1 must be cleaned on read");
  assert.equal(keyExpired2 in stateAfterRead, false, "Expired entry 2 must be cleaned on read");
  assert.equal(keyActive in stateAfterRead, true, "Active entry must be preserved on read");
  assert.equal(unrelatedKey in stateAfterRead, false, "Read-only access must not add entry for reader");

  // Scenario 2B: Expired entries cleaned when another unrelated username writes
  const keyExpired3 = ctx.throttleCacheKey_("stale_user_3");
  stateAfterRead[keyExpired3] = { count: 4, expiresAt: now - 5000 };
  scriptProperties.set(throttleProp, JSON.stringify(stateAfterRead));

  const writeSuccess = ctx.writeThrottleCount_(ctx.throttleCacheKey_("unrelated_writer"), 1);
  assert.equal(writeSuccess, true, "writeThrottleCount_ should succeed");

  const stateAfterWrite = JSON.parse(scriptProperties.get(throttleProp));
  assert.equal(keyExpired3 in stateAfterWrite, false, "Expired entry 3 must be cleaned on write");
  assert.equal(keyActive in stateAfterWrite, true, "Active entry must remain intact");
  assert.equal(ctx.throttleCacheKey_("unrelated_writer") in stateAfterWrite, true, "Writer entry must be present");

  // Scenario 2C: When ALL entries expire, reading an unrelated user cleans state and deletes throttle property
  const allExpiredState = {
    [keyExpired1]: { count: 1, expiresAt: now - 20000 },
    [keyExpired2]: { count: 2, expiresAt: now - 15000 },
  };
  scriptProperties.set(throttleProp, JSON.stringify(allExpiredState));

  ctx.readThrottleCount_(ctx.throttleCacheKey_("another_reader"));
  assert.equal(scriptProperties.has(throttleProp), false,
    "Throttle property must be deleted when all entries expire during read cleaning");
});

test("LOGIN_THROTTLE_STATE_V1: state penuh menolak key baru tanpa menghapus counter aktif", () => {
  const { ctx, scriptProperties } = createGasEnv();
  const maxEntries = ctx.THROTTLE_MAX_ENTRIES_;
  const throttleProp = ctx.THROTTLE_STATE_PROPERTY_;
  const now = Date.now();
  const seededState = {};
  const targetKey = ctx.throttleCacheKey_("target-account");
  seededState[targetKey] = { count: ctx.THROTTLE_MAX_ATTEMPTS_, expiresAt: now + 500000 };
  for (let i = 1; i < maxEntries; i++) {
    const hex = (i + 100).toString(16).padStart(32, "0");
    seededState[`lt_${hex}`] = { count: 1, expiresAt: now + 50000 + i };
  }
  scriptProperties.set(throttleProp, JSON.stringify(seededState));

  const newKey = ctx.throttleCacheKey_("newly_written_user");
  const writeResult = ctx.writeThrottleCount_(newKey, 1);
  assert.equal(writeResult, false, "Key baru harus ditolak saat state penuh");

  const persisted = JSON.parse(scriptProperties.get(throttleProp));
  assert.equal(Object.keys(persisted).length, maxEntries, "Persisted state must be capped at maxEntries");
  assert.equal(newKey in persisted, false, "Key baru tidak boleh menggusur entry aktif");
  assert.equal(persisted[targetKey].count, ctx.THROTTLE_MAX_ATTEMPTS_, "Akun target harus tetap diblokir");
  assert.equal(ctx.isLoginThrottled_("target-account"), true, "Flood username tidak boleh membuka blokir target");
});

test("flood username tidak dikenal memakai satu bucket dan tidak mengunci login akun sah", () => {
  const { ctx, userSheet, scriptProperties } = createGasEnv();
  userSheet.rows.push(["legitimate", "correct-password", "Pengguna Sah", "pengelola"]);

  for (let i = 0; i < 250; i++) {
    ctx.login_({ username: `random-unknown-${i}`, password: "wrong-password" });
  }

  const rawState = scriptProperties.get(ctx.THROTTLE_STATE_PROPERTY_);
  const state = JSON.parse(rawState);
  assert.equal(Object.keys(state).length, 1, "Semua username tidak dikenal harus berbagi satu bucket");
  assert.ok(state[ctx.throttleCacheKey_("__unknown_username_bucket__")]);

  const legitimateLogin = ctx.login_({ username: "legitimate", password: "correct-password" });
  assert.equal(legitimateLogin.status, "success", "Flood username acak tidak boleh mengunci akun sah");
});

test("throttle tidak membocorkan keberadaan username melalui respons login", () => {
  const { ctx, userSheet } = createGasEnv();
  userSheet.rows.push(["known-user", "correct-password", "Known User", "pengelola"]);

  for (let i = 0; i < ctx.THROTTLE_MAX_ATTEMPTS_; i++) {
    ctx.login_({ username: `unknown-${i}`, password: "wrong" });
  }
  for (let i = 0; i < ctx.THROTTLE_MAX_ATTEMPTS_; i++) {
    ctx.login_({ username: "known-user", password: "wrong" });
  }

  const unknownResponse = ctx.login_({ username: "another-unknown", password: "wrong" });
  const knownResponse = ctx.login_({ username: "known-user", password: "wrong" });
  assert.deepEqual(
    { status: unknownResponse.status, errorCode: unknownResponse.errorCode, errorMsg: unknownResponse.errorMsg },
    { status: knownResponse.status, errorCode: knownResponse.errorCode, errorMsg: knownResponse.errorMsg }
  );
});

test("LOGIN_THROTTLE_STATE_V1: corrupted JSON fails closed and recovers once valid", () => {
  const { ctx, scriptProperties } = createGasEnv();
  const throttleProp = ctx.THROTTLE_STATE_PROPERTY_;

  // 1. Corrupted / unparseable JSON
  scriptProperties.set(throttleProp, "{ bad json: missing quotes & syntax error");

  const readError = ctx.readThrottleCount_(ctx.throttleCacheKey_("any_user"));
  assert.equal(readError.count, ctx.THROTTLE_MAX_ATTEMPTS_, "Corrupted JSON must return max attempts");
  assert.equal(readError.source, "error", "Corrupted JSON must set source to error");

  assert.equal(ctx.isLoginThrottled_("any_user"), true, "isLoginThrottled_ must fail closed on corrupted JSON");

  const consumedCorrupted = ctx.consumeLoginAttempt_("any_user");
  assert.equal(consumedCorrupted.allowed, false, "consumeLoginAttempt_ must fail closed on corrupted JSON");

  const loginCorrupted = ctx.login_({ username: "admin", password: "plainpass123" });
  assert.equal(loginCorrupted.status, "error");
  assert.equal(loginCorrupted.errorCode, "INVALID_CREDENTIALS", "login_ must keep throttle failures indistinguishable");

  // 2. Non-object / Array JSON payload fails closed
  scriptProperties.set(throttleProp, JSON.stringify(["not", "an", "object"]));
  assert.equal(ctx.consumeLoginAttempt_("any_user").allowed, false, "Array throttle state must fail closed");

  scriptProperties.set(throttleProp, JSON.stringify("string_state"));
  assert.equal(ctx.consumeLoginAttempt_("any_user").allowed, false, "Primitive string state must fail closed");

  // 3. Recovery once valid
  scriptProperties.delete(throttleProp);
  const readRecovered = ctx.readThrottleCount_(ctx.throttleCacheKey_("recovered_user"));
  assert.equal(readRecovered.count, 0, "Recovered state should return count 0");
  assert.equal(readRecovered.source, "none");

  assert.equal(ctx.isLoginThrottled_("recovered_user"), false, "isLoginThrottled_ should be false after recovery");

  const consumedRecovered = ctx.consumeLoginAttempt_("recovered_user");
  assert.equal(consumedRecovered.allowed, true, "consumeLoginAttempt_ should allow attempt after recovery");

  const stateRecovered = JSON.parse(scriptProperties.get(throttleProp));
  assert.equal(typeof stateRecovered, "object");
  assert.equal(stateRecovered[ctx.throttleCacheKey_("recovered_user")].count, 1, "Counter incremented after recovery");
});

test("LOGIN_THROTTLE_STATE_V1: read and write quota failures fail closed and recover once available", () => {
  const { ctx, scriptProperties } = createGasEnv();
  const throttleProp = ctx.THROTTLE_STATE_PROPERTY_;

  const userKey = ctx.throttleCacheKey_("quota_user");
  scriptProperties.set(throttleProp, JSON.stringify({
    [userKey]: { count: 1, expiresAt: Date.now() + 60000 },
  }));

  let readQuotaError = false;
  let writeQuotaError = false;

  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => {
        if (readQuotaError && k === throttleProp) {
          throw new Error("Service invoked too many times: PropertiesService.getProperty quota exceeded");
        }
        return scriptProperties.get(k) || null;
      },
      setProperty: (k, v) => {
        if (writeQuotaError && k === throttleProp) {
          throw new Error("Service invoked too many times: PropertiesService.setProperty quota exceeded");
        }
        scriptProperties.set(k, String(v));
      },
      deleteProperty: (k) => scriptProperties.delete(k),
    }),
  };

  // 1. Read quota failure fails closed
  readQuotaError = true;
  const readFail = ctx.readThrottleCount_(userKey);
  assert.equal(readFail.count, ctx.THROTTLE_MAX_ATTEMPTS_);
  assert.equal(readFail.source, "error");
  assert.equal(ctx.isLoginThrottled_("quota_user"), true, "isLoginThrottled_ must fail closed on read quota error");
  assert.equal(ctx.consumeLoginAttempt_("quota_user").allowed, false, "consumeLoginAttempt_ must fail closed on read quota error");

  // Read quota recovery
  readQuotaError = false;
  assert.equal(ctx.isLoginThrottled_("quota_user"), false, "isLoginThrottled_ should be false after read quota recovers");

  // 2. Write quota failure fails closed
  writeQuotaError = true;
  const writeFail = ctx.writeThrottleCount_(ctx.throttleCacheKey_("new_user"), 1);
  assert.equal(writeFail, false, "writeThrottleCount_ must return false on write quota failure");

  const consumeWriteFail = ctx.consumeLoginAttempt_("new_user");
  assert.equal(consumeWriteFail.allowed, false, "consumeLoginAttempt_ must fail closed when write quota fails");

  // Read with expired-cleanup fails closed when write quota fails
  const expiredKey = ctx.throttleCacheKey_("expired_for_write_fail");
  const stateWithExpired = JSON.parse(scriptProperties.get(throttleProp));
  stateWithExpired[expiredKey] = { count: 2, expiresAt: Date.now() - 5000 };
  scriptProperties.set(throttleProp, JSON.stringify(stateWithExpired));

  const readDuringWriteQuotaFail = ctx.readThrottleCount_(ctx.throttleCacheKey_("another_user"));
  assert.equal(readDuringWriteQuotaFail.source, "error", "Read requiring expired pruning must fail closed when write quota fails");

  // Write quota recovery
  writeQuotaError = false;
  const writeRecovered = ctx.writeThrottleCount_(ctx.throttleCacheKey_("new_user"), 1);
  assert.equal(writeRecovered, true, "writeThrottleCount_ should succeed after write quota recovers");

  const consumeRecovered = ctx.consumeLoginAttempt_("new_user_2");
  assert.equal(consumeRecovered.allowed, true, "consumeLoginAttempt_ should succeed after write quota recovers");
});
