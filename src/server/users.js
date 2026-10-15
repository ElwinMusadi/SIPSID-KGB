// Domain manajemen pengguna (users.*): port Code.js `normalizeHakAkses_`, `isAdmin_`,
// `validateUsername_`, `validateUsernameTarget_`, `rowToUser_`, `listUsers_`, `createUser_`,
// `updateUser_`, `resetUserPassword_`, `deleteUser_` ke D1 (MIGRATION_PLAN.md 5.2, 5.3, 5.4, 6.1, Lampiran B).
// Code.js = backend GAS lama, dihapus pada Fase 6; sumbernya ada di tag `pre-d1-cutover`.
//
// `session` = hasil `auth.requireSession(..., { admin: true })`:
//   `{ userId, username, namaLengkap, hakAkses, sessionVersion }`.
// Pengganti `revalidateActorInLock_`: guard
//   `EXISTS (SELECT 1 FROM users a WHERE a.id = actor AND a.session_version = sv AND a.role = 'admin')`
// di setiap statement mutasi. Hasil 0 baris dipetakan lewat SATU read diagnostik dengan urutan
// Code.js (Bagian 5.3): actor hilang/stale → AUTH_REQUIRED; bukan admin → FORBIDDEN;
// target tidak ada → NOT_FOUND; lalu aturan per action.
//
// Query D1 per action (hash password hanya biaya CPU, tanpa query):
//   list                         : 1
//   create (berhasil/duplikat)   : 1;  0 baris (actor stale): 2
//   update (berhasil)            : 1;  0 baris: 2
//   resetPassword (berhasil)     : 1;  0 baris: 2
//   delete (berhasil)            : 1;  0 baris: 2;  self-delete: 0

import { all, first, isUniqueViolation, nowIso } from './db.js';
import { appError, D1_ERROR_MESSAGES, fromD1Error } from './errors.js';
import { cleanText } from './format.js';
import { AUTH_MESSAGES, hashPassword, validateNewPassword } from './auth.js';

/** Pesan publik, identik dengan Code.js. */
export const USER_MESSAGES = Object.freeze({
  FORBIDDEN_ADMIN: AUTH_MESSAGES.FORBIDDEN_ADMIN,
  INVALID_USERNAME:
    'Username tidak valid. Gunakan huruf, angka, titik, underscore, atau strip (mulai dengan huruf/angka, maks 64 karakter).',
  INVALID_TARGET: 'Username target tidak valid.',
  NAMA_REQUIRED: 'Nama lengkap wajib diisi.',
  INVALID_ROLE: 'Hak akses tidak valid. Nilai yang diterima: admin, pengelola.',
  LAST_ADMIN_DEMOTE: 'Tidak dapat menurunkan hak akses admin terakhir.',
  LAST_ADMIN_DELETE: 'Tidak dapat menghapus admin terakhir.',
  SELF_DEMOTE: 'Tidak dapat menurunkan hak akses diri sendiri.',
  SELF_DELETE: 'Tidak dapat menghapus akun yang sedang digunakan.',
});

const ACTOR_GUARD = (idOrdinal, svOrdinal) =>
  `EXISTS (SELECT 1 FROM users a WHERE a.id = ?${idOrdinal} AND a.session_version = ?${svOrdinal} AND a.role = 'admin')`;

const LIST_SQL = 'SELECT username, nama_lengkap, role FROM users ORDER BY id';

// ?1 username, ?2 password_hash, ?3 nama, ?4 role, ?5 now, ?6 actor id, ?7 actor session_version.
const INSERT_SQL = `INSERT INTO users (username, password_hash, nama_lengkap, role, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?5
  WHERE ${ACTOR_GUARD(6, 7)}
  RETURNING username, nama_lengkap, role`;

// ?1 nama, ?2 role baru, ?3 now, ?4 target, ?5 actor id, ?6 actor session_version.
// Ekspresi SET memakai nilai lama, sehingga `role <> ?2` = role berubah → sesi user target dicabut.
const UPDATE_SQL = `UPDATE users SET nama_lengkap = ?1, role = ?2,
    session_version = session_version + (role <> ?2), version = version + 1, updated_at = ?3
  WHERE username = ?4
    AND ${ACTOR_GUARD(5, 6)}
    AND NOT (role = 'admin' AND ?2 <> 'admin'
             AND (id = ?5 OR (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1))
  RETURNING username, nama_lengkap, role`;

// ?1 hash, ?2 now, ?3 target, ?4 actor id, ?5 actor session_version.
const RESET_SQL = `UPDATE users SET password_hash = ?1,
    session_version = session_version + 1, version = version + 1, updated_at = ?2
  WHERE username = ?3
    AND ${ACTOR_GUARD(4, 5)}
  RETURNING username`;

// ?1 target, ?2 actor id, ?3 actor session_version. Sesi target terhapus lewat ON DELETE CASCADE.
const DELETE_SQL = `DELETE FROM users
  WHERE username = ?1 AND id <> ?2
    AND ${ACTOR_GUARD(2, 3)}
    AND (role <> 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)
  RETURNING username`;

// Read diagnostik SATU query, selalu tepat satu baris: actor live, target (NOCASE), jumlah admin.
const DIAGNOSTIC_SQL = `SELECT a.id AS actor_id, a.session_version AS actor_sv, a.role AS actor_role,
    t.id AS target_id, t.role AS target_role,
    (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admin_count
  FROM (SELECT 1) AS one
  LEFT JOIN users a ON a.id = ?1
  LEFT JOIN users t ON t.username = ?2`;

// ─── Validasi (port Code.js) ────────────────────────────────────────────────

/** Port `normalizeHakAkses_`: "administrator" → "admin"; hanya admin/pengelola; selain itu null. */
export function normalizeHakAkses(raw) {
  const value = cleanText(raw, 50).toLowerCase();
  if (value === 'administrator') return 'admin';
  if (value === 'admin' || value === 'pengelola') return value;
  return null;
}

/** Port `isAdmin_`. */
export function isAdmin(session) {
  return normalizeHakAkses(session?.hakAkses) === 'admin';
}

/** Port `validateUsername_` (create): trim, 1–64, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, tanpa pemotongan. */
export function validateUsername(raw) {
  const username = String(raw == null ? '' : raw).trim();
  if (!username || username.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) return null;
  return username;
}

/** Port `validateUsernameTarget_` (update/reset/delete): trim, 1–100, tanpa karakter kontrol 0x00–0x1F. */
export function validateUsernameTarget(raw) {
  const username = String(raw == null ? '' : raw).trim();
  if (!username || username.length > 100) return null;
  if (/[\x00-\x1F]/.test(username)) return null;
  return username;
}

/** Port `rowToUser_`: tanpa hash password. */
export function rowToUser(row) {
  return {
    username: String(row?.username ?? '').trim(),
    namaLengkap: String(row?.nama_lengkap ?? '').trim(),
    hakAkses: normalizeHakAkses(row?.role) || 'pengelola',
  };
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** `users.list`: `{ status, data: [{ username, namaLengkap, hakAkses }] }`, urutan id (= urutan sheet). */
export async function listUsers(db, env, session) {
  assertAdminSession(session);
  let rows;
  try {
    rows = await all(db, LIST_SQL);
  } catch (error) {
    throw fromD1Error(error);
  }
  return { status: 'success', data: rows.map(rowToUser) };
}

/**
 * `users.create`. Urutan Code.js: admin → username → nama → hak akses → password → hash →
 * actor (AUTH_REQUIRED/FORBIDDEN) → duplikat (DUPLICATE_USER, case-insensitive lewat NOCASE).
 * @returns {Promise<{ status: 'success', data: { username: string, namaLengkap: string, hakAkses: string } }>}
 */
export async function createUser(db, env, session, payload) {
  assertAdminSession(session);
  const source = payload !== null && typeof payload === 'object' ? payload : {};

  const username = validateUsername(source.username);
  if (!username) throw appError('VALIDATION_ERROR', USER_MESSAGES.INVALID_USERNAME);
  const namaLengkap = cleanText(source.namaLengkap, 160);
  if (!namaLengkap) throw appError('VALIDATION_ERROR', USER_MESSAGES.NAMA_REQUIRED);
  const hakAkses = normalizeHakAkses(source.hakAkses);
  if (!hakAkses) throw appError('VALIDATION_ERROR', USER_MESSAGES.INVALID_ROLE);
  const password = validateNewPassword(source.password);
  const passwordHash = await hashPassword(password, env);

  let rows;
  try {
    rows = await all(
      db,
      INSERT_SQL,
      username,
      passwordHash,
      namaLengkap,
      hakAkses,
      nowIso(),
      session.userId,
      session.sessionVersion,
    );
  } catch (error) {
    // Guard actor dievaluasi sebelum constraint: UNIQUE hanya mungkin bila actor valid (urutan Code.js).
    if (isUniqueViolation(error, 'users.username')) {
      throw appError('DUPLICATE_USER', `Username '${username}' sudah terdaftar.`);
    }
    throw fromD1Error(error);
  }
  if (rows.length > 0) return { status: 'success', data: rowToUser(rows[0]) };

  const diag = await diagnose(db, session, username);
  assertActor(diag, session);
  throw writeFailed();
}

/**
 * `users.update` (nama + hak akses). Perubahan role menaikkan `session_version` target.
 * Urutan Code.js: admin → target → nama → hak akses → actor → NOT_FOUND →
 * LAST_ADMIN_PROTECTED (422) → self-demote FORBIDDEN (403).
 * @returns {Promise<{ status: 'success', data: { username: string, namaLengkap: string, hakAkses: string } }>}
 */
export async function updateUser(db, env, session, username, payload) {
  assertAdminSession(session);
  const source = payload !== null && typeof payload === 'object' ? payload : {};

  const target = validateUsernameTarget(username);
  if (!target) throw appError('VALIDATION_ERROR', USER_MESSAGES.INVALID_TARGET);
  const namaLengkap = cleanText(source.namaLengkap, 160);
  if (!namaLengkap) throw appError('VALIDATION_ERROR', USER_MESSAGES.NAMA_REQUIRED);
  const hakAkses = normalizeHakAkses(source.hakAkses);
  if (!hakAkses) throw appError('VALIDATION_ERROR', USER_MESSAGES.INVALID_ROLE);

  let rows;
  try {
    rows = await all(
      db,
      UPDATE_SQL,
      namaLengkap,
      hakAkses,
      nowIso(),
      target,
      session.userId,
      session.sessionVersion,
    );
  } catch (error) {
    throw fromD1Error(error, { LAST_ADMIN_PROTECTED: USER_MESSAGES.LAST_ADMIN_DEMOTE });
  }
  if (rows.length > 0) return { status: 'success', data: rowToUser(rows[0]) };

  const diag = await diagnose(db, session, target);
  assertActor(diag, session);
  assertTarget(diag, target);
  if (diag.targetRole === 'admin' && hakAkses !== 'admin') {
    if (diag.adminCount <= 1) throw appError('LAST_ADMIN_PROTECTED', USER_MESSAGES.LAST_ADMIN_DEMOTE);
    if (diag.targetId === Number(session.userId)) throw appError('FORBIDDEN', USER_MESSAGES.SELF_DEMOTE);
  }
  throw writeFailed();
}

/**
 * `users.resetPassword` (payload `{ newPassword }`). Menaikkan `session_version` target sehingga
 * seluruh sesinya tidak berlaku. Urutan Code.js: admin → target → password → hash → actor → NOT_FOUND.
 * @returns {Promise<{ status: 'success', username: string }>}
 */
export async function resetPassword(db, env, session, username, payload) {
  assertAdminSession(session);
  const source = payload !== null && typeof payload === 'object' ? payload : {};

  const target = validateUsernameTarget(username);
  if (!target) throw appError('VALIDATION_ERROR', USER_MESSAGES.INVALID_TARGET);
  const password = validateNewPassword(source.newPassword);
  const passwordHash = await hashPassword(password, env);

  let rows;
  try {
    rows = await all(db, RESET_SQL, passwordHash, nowIso(), target, session.userId, session.sessionVersion);
  } catch (error) {
    throw fromD1Error(error);
  }
  if (rows.length > 0) return { status: 'success', username: String(rows[0].username) };

  const diag = await diagnose(db, session, target);
  assertActor(diag, session);
  assertTarget(diag, target);
  throw writeFailed();
}

/**
 * `users.delete`. Urutan Code.js: admin → target → self-delete FORBIDDEN (tanpa query, sebelum
 * validasi actor) → actor → NOT_FOUND → LAST_ADMIN_PROTECTED. Sesi target terhapus (CASCADE).
 * @returns {Promise<{ status: 'success', username: string }>}
 */
export async function deleteUser(db, env, session, username) {
  assertAdminSession(session);
  const target = validateUsernameTarget(username);
  if (!target) throw appError('VALIDATION_ERROR', USER_MESSAGES.INVALID_TARGET);
  if (target.toLowerCase() === String(session.username || '').toLowerCase()) {
    throw appError('FORBIDDEN', USER_MESSAGES.SELF_DELETE);
  }

  let rows;
  try {
    rows = await all(db, DELETE_SQL, target, session.userId, session.sessionVersion);
  } catch (error) {
    throw fromD1Error(error, { LAST_ADMIN_PROTECTED: USER_MESSAGES.LAST_ADMIN_DELETE });
  }
  if (rows.length > 0) return { status: 'success', username: String(rows[0].username) };

  const diag = await diagnose(db, session, target);
  assertActor(diag, session);
  assertTarget(diag, target);
  // Defensif: target = actor menurut id (cek awal sudah menangkap seluruh varian huruf, karena
  // toLowerCase JS melipat superset dari NOCASE yang hanya melipat ASCII).
  if (diag.targetId === Number(session.userId)) throw appError('FORBIDDEN', USER_MESSAGES.SELF_DELETE);
  if (diag.targetRole === 'admin' && diag.adminCount <= 1) {
    throw appError('LAST_ADMIN_PROTECTED', USER_MESSAGES.LAST_ADMIN_DELETE);
  }
  throw writeFailed();
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** Bentuk sesi + `isAdmin_` (defence-in-depth, tanpa query; role live diperiksa guard SQL). */
function assertAdminSession(session) {
  if (
    !session ||
    !Number.isSafeInteger(session.userId) ||
    !Number.isSafeInteger(session.sessionVersion) ||
    typeof session.username !== 'string' ||
    session.username === ''
  ) {
    throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_INVALID);
  }
  if (!isAdmin(session)) throw appError('FORBIDDEN', USER_MESSAGES.FORBIDDEN_ADMIN);
}

async function diagnose(db, session, target) {
  let row;
  try {
    row = await first(db, DIAGNOSTIC_SQL, session.userId, target);
  } catch (error) {
    throw fromD1Error(error);
  }
  const hasTarget = row?.target_id !== null && row?.target_id !== undefined;
  return {
    actorExists: row?.actor_id !== null && row?.actor_id !== undefined,
    actorSessionVersion: row?.actor_sv,
    actorRole: row?.actor_role,
    targetId: hasTarget ? Number(row.target_id) : null,
    targetRole: hasTarget ? row.target_role : null,
    adminCount: Number(row?.admin_count ?? 0),
  };
}

/** Port `revalidateActorInLock_(session, true)`. */
function assertActor(diag, session) {
  if (!diag.actorExists) throw appError('AUTH_REQUIRED', AUTH_MESSAGES.ACCOUNT_NOT_FOUND);
  if (Number(diag.actorSessionVersion) !== Number(session.sessionVersion)) {
    throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_STALE);
  }
  if (diag.actorRole !== 'admin') throw appError('FORBIDDEN', USER_MESSAGES.FORBIDDEN_ADMIN);
}

function assertTarget(diag, target) {
  if (diag.targetId === null) throw appError('NOT_FOUND', `Pengguna '${target}' tidak ditemukan.`);
}

function writeFailed() {
  return appError('DATA_WRITE_FAILED', D1_ERROR_MESSAGES.DATA_WRITE_FAILED);
}
