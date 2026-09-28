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
  ]);
  const lockState = { held: false, waitLockCalled: 0, releaseLockCalled: 0 };
  const mockSheets = new Map();

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

  return { ctx, mockSheets, letterSheet, lockState, scriptProperties };
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
  const { ctx, letterSheet } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx } = createGasEnv();

  // Missing token
  assert.throws(
    () => ctx.apiUpdateLetter("", "KGB-1", sampleLetterPayload()),
    (err) => err.code === "AUTH_REQUIRED" && /Sesi tidak valid/i.test(err.message),
  );

  // Invalid signature / tampered token
  const validToken = ctx.createSessionToken_({ username: "user", namaLengkap: "User", hakAkses: "pengelola" });
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
  const { ctx, letterSheet } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "pengelola1", namaLengkap: "Staff", hakAkses: "pengelola" });

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
  const { ctx, letterSheet } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "pengelola1", namaLengkap: "Staff", hakAkses: "pengelola" });

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
  const { ctx } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx, lockState, letterSheet } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx, letterSheet } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx, letterSheet } = createGasEnv();
  const adminToken = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });
  const staffToken = ctx.createSessionToken_({ username: "staff", namaLengkap: "Staf", hakAkses: "pengelola" });

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
  const { ctx } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
  const { ctx } = createGasEnv();
  const token = ctx.createSessionToken_({ username: "admin", namaLengkap: "Admin", hakAkses: "admin" });

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
