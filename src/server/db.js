// Helper D1 kecil tanpa dependensi untuk domain code (src/server/*).
//
// - Hanya placeholder posisional `?1`..`?N` (D1 tidak mendukung named parameter; MIGRATION_PLAN.md Fase 1).
//   Ordinal boleh dipakai ulang. Jumlah parameter wajib sama dengan ordinal tertinggi agar parameter
//   yang terlupa tidak diam-diam terikat sebagai NULL.
// - Maksimal 100 bound parameter per query (batas D1, Bagian 5.6).

const MAX_BOUND_PARAMETERS = 100;
const ORDINAL_CACHE_LIMIT = 256;
const ordinalCache = new Map();

/**
 * Timestamp UTC ISO panjang tetap 24 karakter: `YYYY-MM-DDTHH:MM:SS.sssZ`.
 * Sama dengan default kolom `strftime('%Y-%m-%dT%H:%M:%fZ','now')` dan CHECK length = 24.
 * @param {Date|number} [value] waktu yang diformat; default sekarang.
 */
export function nowIso(value) {
  const date = value === undefined ? new Date() : new Date(value instanceof Date ? value.getTime() : value);
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    throw new RangeError('nowIso: invalid date');
  }
  const iso = date.toISOString();
  if (iso.length !== 24) {
    // Tahun di luar 0000–9999 menghasilkan format diperluas (±YYYYYY) yang ditolak CHECK schema.
    throw new RangeError('nowIso: year out of range for fixed-length timestamp');
  }
  return iso;
}

/** Satu baris hasil, atau `null` jika tidak ada baris. */
export async function first(db, sql, ...params) {
  return prepare(db, sql, params).first();
}

/** Seluruh baris hasil sebagai array (`results` dari D1, selalu array). */
export async function all(db, sql, ...params) {
  const result = await prepare(db, sql, params).all();
  return Array.isArray(result?.results) ? result.results : [];
}

/** Menjalankan statement; mengembalikan hasil D1 apa adanya (`{ success, meta: { changes, last_row_id }, results }`). */
export async function run(db, sql, ...params) {
  return prepare(db, sql, params).run();
}

/** Prepared statement yang sudah di-bind, untuk dipakai di `db.batch([...])`. */
export function statement(db, sql, ...params) {
  return prepare(db, sql, params);
}

/**
 * True jika error berasal dari pelanggaran UNIQUE/PRIMARY KEY.
 * D1:          `D1_ERROR: UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`
 * node:sqlite: `UNIQUE constraint failed: users.username`
 * @param {unknown} error
 * @param {string} [target] opsional `tabel.kolom` yang harus disebut dalam pesan.
 */
export function isUniqueViolation(error, target) {
  return errorMessages(error).some((message) => {
    if (!/\bUNIQUE constraint failed\b/.test(message)) return false;
    if (target === undefined) return true;
    const columns = message.replace(/^.*?UNIQUE constraint failed:\s*/, '').split(/:\s*SQLITE_/)[0];
    return columns.split(/\s*,\s*/).includes(String(target));
  });
}

/**
 * True jika error berasal dari `RAISE(ABORT, '<name>')` pada trigger.
 * D1 (diverifikasi lokal, Fase 1a):
 *   `D1_ERROR: LAST_ADMIN_PROTECTED: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`
 * node:sqlite: `LAST_ADMIN_PROTECTED` (errcode 1811).
 * @param {unknown} error
 * @param {string} name pesan RAISE, mis. `LAST_ADMIN_PROTECTED`.
 */
export function isTriggerError(error, name) {
  if (typeof name !== 'string' || !/^[A-Z0-9_]+$/.test(name)) {
    throw new TypeError('isTriggerError: name must match /^[A-Z0-9_]+$/');
  }
  const pattern = new RegExp(`(?:^|[\\s:])${name}(?=$|[\\s:])`);
  return errorMessages(error).some((message) => pattern.test(message));
}

function prepare(db, sql, params) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('D1 database binding is required');
  }
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new TypeError('SQL must be a non-empty string');
  }
  const expected = maxOrdinal(sql);
  if (params.length !== expected) {
    throw new RangeError(`SQL expects ${expected} parameter(s), received ${params.length}`);
  }
  const stmt = db.prepare(sql);
  return params.length > 0 ? stmt.bind(...params) : stmt;
}

function maxOrdinal(sql) {
  const cached = ordinalCache.get(sql);
  if (cached !== undefined) return cached;

  const code = stripLiteralsAndComments(sql);
  if (/\?(?!\d)/.test(code) || /[:@$][A-Za-z_]/.test(code)) {
    throw new SyntaxError('Only positional parameters ?1..?N are supported');
  }
  let max = 0;
  for (const match of code.matchAll(/\?(\d+)/g)) {
    const ordinal = Number(match[1]);
    if (ordinal < 1 || ordinal > MAX_BOUND_PARAMETERS) {
      throw new RangeError(`Parameter ordinal ?${match[1]} out of range 1..${MAX_BOUND_PARAMETERS}`);
    }
    if (ordinal > max) max = ordinal;
  }
  if (ordinalCache.size >= ORDINAL_CACHE_LIMIT) ordinalCache.clear();
  ordinalCache.set(sql, max);
  return max;
}

function stripLiteralsAndComments(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
}

function errorMessages(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'string') {
      messages.push(current);
      break;
    }
    if (typeof current.message === 'string') messages.push(current.message);
    current = current.cause;
  }
  return messages;
}
