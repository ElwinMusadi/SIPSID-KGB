// Domain surat (letters.*): port Code.js `validateAndNormalizeLetter_`, `rowToLetter_`,
// `validateLetterId_`, `validateRequestId_`, `deriveLetterIdFromRequestId_`, `createUniqueLetterId_`,
// `listLetters_`, `createLetter_`, `updateLetter_`, `deleteLetter_` ke D1
// (MIGRATION_PLAN.md 5.2, 5.3, 6.1, 6.2, Lampiran B).
//
// `session` = hasil `auth.requireSession`: `{ userId, username, namaLengkap, hakAkses, sessionVersion }`.
// Pengganti `revalidateActorInLock_`: guard `EXISTS (users.id + session_version [+ role])` di setiap
// statement mutasi; hasil 0 baris dipetakan lewat SATU read diagnostik dengan urutan Bagian 5.3.
//
// Query D1 per action:
//   list                          : 1
//   create (berhasil)             : 1
//   create (replay / 0 baris)     : 2 (INSERT + 1 read diagnostik)
//   update (berhasil)             : 1;  0 baris: 2
//   delete (berhasil)             : 1;  0 baris: 2

import { all, first, nowIso } from './db.js';
import { appError, D1_ERROR_MESSAGES, fromD1Error } from './errors.js';
import { cleanText, formatRupiah, isCalendarDate, normalizeDateForClient, parseRupiahToInteger, witaYear } from './format.js';
import { AUTH_MESSAGES } from './auth.js';

/** Urutan field surat, identik dengan `LETTER_FIELDS_` Code.js. */
export const LETTER_FIELDS = Object.freeze([
  'id', 'statusPegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'kabkot',
  'skPejabat', 'skTanggal', 'skNomor', 'skTmt', 'mkLamaThn', 'mkLamaBln', 'gajiLama',
  'mkBaruThn', 'mkBaruBln', 'gajiBaruTmt', 'gajiBaru', 'suratNomor', 'suratTanggal',
  'signJabatan', 'signNama', 'signPangkat', 'signNip', 'ukuranKertas',
]);

/** Pesan publik, identik dengan Code.js. */
export const LETTER_MESSAGES = Object.freeze({
  INVALID_ID: 'ID surat tidak valid.',
  INVALID_REQUEST_ID:
    'requestId tidak valid. Gunakan UUID atau token aman (alphanum, hyphens, underscores, maks 100 karakter).',
  INVALID_STATUS: 'Status pegawai tidak valid.',
  FORBIDDEN_DELETE: 'Hanya administrator yang dapat menghapus arsip.',
  NOT_FOUND_EMPTY: 'Data surat tidak ditemukan.',
  NOT_FOUND: 'Data surat tidak ditemukan atau sudah dihapus.',
});

const REQUIRED_FIELDS = Object.freeze([
  'statusPegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'skPejabat',
  'skTanggal', 'skNomor', 'skTmt', 'gajiLama', 'gajiBaruTmt', 'gajiBaru', 'suratNomor',
  'suratTanggal', 'signJabatan', 'signNama', 'signPangkat', 'signNip',
]);
const DATE_FIELDS = Object.freeze(['skTanggal', 'skTmt', 'gajiBaruTmt', 'suratTanggal']);
const MK_RULES = Object.freeze([
  { field: 'mkLamaThn', min: 0, max: 40 },
  { field: 'mkLamaBln', min: 0, max: 11 },
  { field: 'mkBaruThn', min: 1, max: 40 },
  { field: 'mkBaruBln', min: 0, max: 11 },
]);
const GAJI_FIELDS = Object.freeze(['gajiLama', 'gajiBaru']);

// Field data (tanpa `id`) → kolom D1, urutan LETTER_FIELDS_. 25 kolom.
const DATA_COLUMNS = Object.freeze([
  ['statusPegawai', 'status_pegawai'],
  ['nama', 'nama'],
  ['nip', 'nip'],
  ['pangkat', 'pangkat'],
  ['jabatan', 'jabatan'],
  ['unit', 'unit'],
  ['kabkot', 'kabkot'],
  ['skPejabat', 'sk_pejabat'],
  ['skTanggal', 'sk_tanggal'],
  ['skNomor', 'sk_nomor'],
  ['skTmt', 'sk_tmt'],
  ['mkLamaThn', 'mk_lama_thn'],
  ['mkLamaBln', 'mk_lama_bln'],
  ['gajiLama', 'gaji_lama'],
  ['mkBaruThn', 'mk_baru_thn'],
  ['mkBaruBln', 'mk_baru_bln'],
  ['gajiBaruTmt', 'gaji_baru_tmt'],
  ['gajiBaru', 'gaji_baru'],
  ['suratNomor', 'surat_nomor'],
  ['suratTanggal', 'surat_tanggal'],
  ['signJabatan', 'sign_jabatan'],
  ['signNama', 'sign_nama'],
  ['signPangkat', 'sign_pangkat'],
  ['signNip', 'sign_nip'],
  ['ukuranKertas', 'ukuran_kertas'],
]);

const DATA_COLUMN_NAMES = DATA_COLUMNS.map(([, column]) => column).join(', ');

// ?1 id, ?2 request_id, ?3..?27 data, ?28 actor username, ?29 now, ?30 user id, ?31 session_version.
const INSERT_SQL = `INSERT INTO letters (id, request_id, seq, ${DATA_COLUMN_NAMES},
    created_by, updated_by, created_at, updated_at)
  SELECT ?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM letters),
    ${DATA_COLUMNS.map((_, i) => `?${i + 3}`).join(', ')},
    ?28, ?28, ?29, ?29
  WHERE EXISTS (SELECT 1 FROM users WHERE id = ?30 AND session_version = ?31)
  ON CONFLICT DO NOTHING
  RETURNING *`;

// ?1..?25 data, ?26 actor username, ?27 now, ?28 letter id, ?29 user id, ?30 session_version.
const UPDATE_SQL = `UPDATE letters SET
    ${DATA_COLUMNS.map(([, column], i) => `${column} = ?${i + 1}`).join(', ')},
    version = version + 1, updated_by = ?26, updated_at = ?27
  WHERE id = ?28
    AND EXISTS (SELECT 1 FROM users WHERE id = ?29 AND session_version = ?30)
  RETURNING *`;

const DELETE_SQL = `DELETE FROM letters
  WHERE id = ?1
    AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND session_version = ?3 AND role = 'admin')
  RETURNING id`;

// Read diagnostik SATU query: actor live (users) + baris surat lengkap + apakah tabel letters kosong.
// Selalu tepat satu baris (FROM subquery 1 baris, LEFT JOIN). Surat dicari lewat request_id
// (diprioritaskan) atau id (Lampiran B: `WHERE request_id = ?rid OR id = ?id`); ?3 NULL = tanpa request_id.
// Alias actor_* / any_letters tidak bentrok dengan nama kolom letters.
const DIAGNOSTIC_SQL = `SELECT u.id AS actor_id, u.session_version AS actor_sv, u.role AS actor_role,
    EXISTS (SELECT 1 FROM letters) AS any_letters, l.*
  FROM (SELECT 1) AS one
  LEFT JOIN users u ON u.id = ?1
  LEFT JOIN letters l ON l.id = (
    SELECT x.id FROM letters x
     WHERE x.id = ?2 OR (?3 IS NOT NULL AND x.request_id = ?3)
     ORDER BY CASE WHEN x.request_id = ?3 THEN 0 ELSE 1 END
     LIMIT 1)`;

// ─── Validasi (port Code.js) ────────────────────────────────────────────────

/**
 * Port `validateLetterId_`: trim, 1–200 karakter, hanya `[\w\s\-./]` (ASCII \w seperti GAS).
 * @returns {string|null}
 */
export function validateLetterId(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (!id) return null;
  if (id.length > 200) return null;
  if (/[^\w\s\-./]/.test(id)) return null;
  return id;
}

/**
 * Port `validateRequestId_`: trim, 1–100 karakter `[A-Za-z0-9_-]`, dikembalikan lowercase.
 * @returns {string|null}
 */
export function validateRequestId(raw) {
  if (raw == null) return null;
  const id = String(raw).trim();
  if (!id || id.length > 100) return null;
  if (!/^[A-Za-z0-9\-_]+$/.test(id)) return null;
  return id.toLowerCase();
}

/** Port `deriveLetterIdFromRequestId_` dengan tahun WITA (UTC+8), bukan tahun UTC runtime. */
export function deriveLetterIdFromRequestId(requestId, now) {
  return `KGB-${witaYear(now)}-${requestId}`;
}

/** Port `createUniqueLetterId_`: `KGB-<tahun WITA>-<uuid v4>`. Keunikan dijamin PK + ON CONFLICT. */
export function createLetterId(now) {
  return `KGB-${witaYear(now)}-${crypto.randomUUID()}`;
}

/**
 * Port `validateAndNormalizeLetter_` (aturan dan pesan identik), ditambah parsing gaji ke INTEGER (K5).
 * - Teks di-trim dan dipotong (bukan ditolak) ke 300 karakter untuk `unit`/`jabatan`, 180 lainnya.
 * - Urutan cek: wajib diisi → status pegawai → tanggal kalender → masa kerja → gaji.
 * - `ukuranKertas`: hanya `"a4"` persis yang dipertahankan; selain itu `"legal"`.
 * - `kabkot` opsional (`""` bila kosong; disimpan NULL).
 * - `id` dari payload tidak pernah disertakan (create membuat ID sendiri; update memakai ID URL).
 * @param {object} payload
 * @param {{ forCreate?: boolean }} [options] tidak mengubah aturan validasi (sama seperti Code.js,
 *   create dan update memakai validator yang sama); disediakan untuk keterbacaan pemanggil.
 * @returns {{ statusPegawai: string, nama: string, nip: string, pangkat: string, jabatan: string,
 *   unit: string, kabkot: string, skPejabat: string, skTanggal: string, skNomor: string, skTmt: string,
 *   mkLamaThn: number, mkLamaBln: number, gajiLama: number, mkBaruThn: number, mkBaruBln: number,
 *   gajiBaruTmt: string, gajiBaru: number, suratNomor: string, suratTanggal: string, signJabatan: string,
 *   signNama: string, signPangkat: string, signNip: string, ukuranKertas: 'a4'|'legal' }}
 * @throws VALIDATION_ERROR
 */
export function validateLetter(payload, options = {}) { // eslint-disable-line no-unused-vars
  const source = payload !== null && typeof payload === 'object' ? payload : {};
  const text = {};
  for (const field of LETTER_FIELDS) {
    if (field === 'id') continue;
    const value = Object.hasOwn(source, field) ? source[field] : undefined;
    text[field] = cleanText(value, field === 'unit' || field === 'jabatan' ? 300 : 180);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!text[field]) throw appError('VALIDATION_ERROR', `Field ${field} wajib diisi.`);
  }
  if (text.statusPegawai !== 'PNS' && text.statusPegawai !== 'PPPK') {
    throw appError('VALIDATION_ERROR', LETTER_MESSAGES.INVALID_STATUS);
  }
  for (const field of DATE_FIELDS) {
    if (!isCalendarDate(text[field])) throw appError('VALIDATION_ERROR', `Format tanggal ${field} tidak valid.`);
  }

  const result = { ...text };
  for (const rule of MK_RULES) {
    const value = text[rule.field];
    if (!/^\d{1,3}$/.test(value)) {
      throw appError('VALIDATION_ERROR', `Nilai masa kerja ${rule.field} tidak valid.`);
    }
    const num = Number(value);
    if (num < rule.min || num > rule.max) {
      throw appError('VALIDATION_ERROR', `Nilai masa kerja ${rule.field} harus antara ${rule.min} dan ${rule.max}.`);
    }
    result[rule.field] = num;
  }
  for (const field of GAJI_FIELDS) {
    result[field] = parseRupiahToInteger(text[field], field);
  }
  result.ukuranKertas = text.ukuranKertas === 'a4' ? 'a4' : 'legal';
  return result;
}

// ─── Mapping baris D1 → klien ───────────────────────────────────────────────

/**
 * Port `rowToLetter_`: hanya field LETTER_FIELDS_ (camelCase), semua string.
 * Gaji → `Rp. x.xxx.xxx,-`; tanggal → `YYYY-MM-DD`; masa kerja → string (default "0");
 * kabkot NULL → ""; ukuranKertas lowercase (default "legal"). Kolom internal (request_id, seq,
 * version, created_*, updated_*) tidak pernah dikirim, sama seperti GAS yang tidak mengirim timestamp kolom A.
 */
export function rowToLetter(row) {
  const letter = { id: toText(row.id) };
  for (const [field, column] of DATA_COLUMNS) {
    let value = row[column];
    if (field === 'gajiLama' || field === 'gajiBaru') {
      value = toRupiah(value);
    } else if (DATE_FIELDS.includes(field)) {
      value = normalizeDateForClient(value);
    }
    letter[field] = toText(value);
  }
  letter.mkLamaThn = letter.mkLamaThn || '0';
  letter.mkLamaBln = letter.mkLamaBln || '0';
  letter.mkBaruThn = letter.mkBaruThn || '0';
  letter.mkBaruBln = letter.mkBaruBln || '0';
  letter.ukuranKertas = (letter.ukuranKertas || 'legal').toLowerCase();
  return letter;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** `letters.list`: `{ status, data }`, urutan `seq DESC` (baris terbawah sheet di atas). 1 query. */
export async function listLetters(db, session) {
  assertSession(session);
  let rows;
  try {
    rows = await all(db, 'SELECT * FROM letters ORDER BY seq DESC');
  } catch (error) {
    throw fromD1Error(error);
  }
  return { status: 'success', data: rows.map(rowToLetter) };
}

/**
 * `letters.create` (Lampiran B). `payload.requestId` opsional menentukan ID deterministik
 * `KGB-<tahun WITA>-<requestId>`; replay mengembalikan surat yang ada dengan `idempotent: true`
 * (juga lintas tahun, karena `request_id` unik global, dan untuk data lama ber-`request_id` NULL
 * dengan `id` sama). `payload.id` selalu diabaikan.
 * @returns {Promise<{ status: 'success', data: object, idempotent?: true }>}
 */
export async function createLetter(db, session, payload, now) {
  assertSession(session);
  const at = now === undefined ? new Date() : now;
  const source = payload !== null && typeof payload === 'object' ? payload : {};

  // Seperti Code.js: requestId divalidasi sebelum payload.
  let requestId = null;
  const rawRequestId = Object.hasOwn(source, 'requestId') ? source.requestId : undefined;
  if (rawRequestId !== undefined && rawRequestId !== null && String(rawRequestId).trim() !== '') {
    requestId = validateRequestId(rawRequestId);
    if (!requestId) throw appError('VALIDATION_ERROR', LETTER_MESSAGES.INVALID_REQUEST_ID);
  }

  const letter = validateLetter(source, { forCreate: true });
  const id = requestId ? deriveLetterIdFromRequestId(requestId, at) : createLetterId(at);
  const timestamp = nowIso(at);

  let rows;
  try {
    rows = await all(
      db,
      INSERT_SQL,
      id,
      requestId,
      ...dataParams(letter),
      session.username,
      timestamp,
      session.userId,
      session.sessionVersion,
    );
  } catch (error) {
    throw fromD1Error(error);
  }
  if (rows.length > 0) return { status: 'success', data: rowToLetter(rows[0]) };

  // 0 baris: actor stale (guard) atau bentrok id/request_id. Diagnostik + ambil surat yang ada.
  const diag = await diagnose(db, session, id, requestId);
  assertActor(diag, session);
  if (requestId && diag.letter) {
    return { status: 'success', data: rowToLetter(diag.letter), idempotent: true };
  }
  // Tanpa requestId, bentrok hanya mungkin pada UUID acak/seq; jangan kembalikan surat orang lain.
  throw writeFailed();
}

/**
 * `letters.update`: last-write-wins (K6), `version + 1`. Tidak mengubah id, request_id, seq, created_*.
 * @returns {Promise<{ status: 'success', data: object } | { status: 'not_found', errorCode: 'NOT_FOUND', errorMsg: string }>}
 */
export async function updateLetter(db, session, id, payload, now) {
  assertSession(session);
  const recordId = validateLetterId(id);
  if (!recordId) throw appError('VALIDATION_ERROR', LETTER_MESSAGES.INVALID_ID);
  const letter = validateLetter(payload, { forCreate: false });
  const timestamp = nowIso(now === undefined ? new Date() : now);

  let rows;
  try {
    rows = await all(
      db,
      UPDATE_SQL,
      ...dataParams(letter),
      session.username,
      timestamp,
      recordId,
      session.userId,
      session.sessionVersion,
    );
  } catch (error) {
    throw fromD1Error(error);
  }
  if (rows.length > 0) return { status: 'success', data: rowToLetter(rows[0]) };

  const diag = await diagnose(db, session, recordId, null);
  assertActor(diag, session);
  if (!diag.letter) return notFound(diag);
  // Surat ada dan actor valid tetapi UPDATE 0 baris: hanya mungkin bila surat dihapus lalu dibuat
  // ulang di antara dua statement; laporkan sebagai kegagalan tulis, bukan sukses palsu.
  throw writeFailed();
}

/**
 * `letters.delete` (admin; role diperiksa terhadap baris users LIVE di dalam statement).
 * @returns {Promise<{ status: 'success', id: string } | { status: 'not_found', errorCode: 'NOT_FOUND', errorMsg: string }>}
 */
export async function deleteLetter(db, session, id) {
  assertSession(session);
  const recordId = validateLetterId(id);
  if (!recordId) throw appError('VALIDATION_ERROR', LETTER_MESSAGES.INVALID_ID);

  let rows;
  try {
    rows = await all(db, DELETE_SQL, recordId, session.userId, session.sessionVersion);
  } catch (error) {
    throw fromD1Error(error);
  }
  if (rows.length > 0) return { status: 'success', id: String(rows[0].id) };

  // Urutan Bagian 5.3: actor stale → bukan admin → tidak ditemukan.
  const diag = await diagnose(db, session, recordId, null);
  assertActor(diag, session);
  if (diag.role !== 'admin') throw appError('FORBIDDEN', LETTER_MESSAGES.FORBIDDEN_DELETE);
  if (!diag.letter) return notFound(diag);
  throw writeFailed();
}

// ─── Internal ───────────────────────────────────────────────────────────────

function assertSession(session) {
  if (
    !session ||
    !Number.isSafeInteger(session.userId) ||
    !Number.isSafeInteger(session.sessionVersion) ||
    typeof session.username !== 'string' ||
    session.username === ''
  ) {
    throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_INVALID);
  }
}

/** Satu read diagnostik (1 query): actor live dan baris surat lengkap bila ada. */
async function diagnose(db, session, id, requestId) {
  let row;
  try {
    row = await first(db, DIAGNOSTIC_SQL, session.userId, id, requestId);
  } catch (error) {
    throw fromD1Error(error);
  }
  return {
    actorExists: row?.actor_id !== null && row?.actor_id !== undefined,
    sessionVersion: row?.actor_sv,
    role: row?.actor_role,
    anyLetters: Number(row?.any_letters) === 1,
    letter: row && row.id !== null && row.id !== undefined ? row : null,
  };
}

function writeFailed() {
  return appError('DATA_WRITE_FAILED', D1_ERROR_MESSAGES.DATA_WRITE_FAILED);
}

function assertActor(diag, session) {
  if (!diag.actorExists) throw appError('AUTH_REQUIRED', AUTH_MESSAGES.ACCOUNT_NOT_FOUND);
  if (Number(diag.sessionVersion) !== Number(session.sessionVersion)) {
    throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_STALE);
  }
}

function notFound(diag) {
  return {
    status: 'not_found',
    errorCode: 'NOT_FOUND',
    errorMsg: diag.anyLetters ? LETTER_MESSAGES.NOT_FOUND : LETTER_MESSAGES.NOT_FOUND_EMPTY,
  };
}

function dataParams(letter) {
  return DATA_COLUMNS.map(([field]) => (field === 'kabkot' && letter.kabkot === '' ? null : letter[field]));
}

function toRupiah(value) {
  if (value === null || value === undefined || value === '') return '';
  const num = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isSafeInteger(num) && num >= 0 ? formatRupiah(num) : String(value);
}

function toText(value) {
  return String(value == null ? '' : value).trim();
}
