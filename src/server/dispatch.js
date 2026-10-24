// Dispatcher action backend D1 (pengganti `dispatchHttpAction_` + `doPost` di Code.js).
// Code.js = backend GAS lama, dihapus pada Fase 6; sumbernya ada di tag `pre-d1-cutover`.
//
// Dipanggil in-process oleh gateway `functions/api/[[path]].js` dengan binding `env.DB`
// (MIGRATION_PLAN.md Bagian 3, 6, 6.1, Fase 1 langkah 3–5). Nama action sama dengan GAS;
// `system.manifest` dihapus (K11).
//
// Kontrak hasil: SELALU objek berbentuk GAS, tidak pernah melempar.
//   - sukses / `not_found` dari domain diteruskan apa adanya;
//   - error publik (`appError` dengan kode di PUBLIC_ERROR_CODES) → `{ status:'error', errorCode, errorMsg }`;
//   - error lain (D1 mentah, bug) → kode tetap dengan pesan tetap; teks exception tidak pernah keluar.
// Log hanya `{ action, code }` untuk kegagalan non-publik dan kegagalan sisi server yang sudah dipetakan
// (DATA_*, CONFIG_ERROR, ...): tanpa payload, token, NIP, atau teks exception (redaksi GAS v2.5.3, Bagian 6.2).

import * as auth from './auth.js';
import * as letters from './letters.js';
import * as users from './users.js';
import { getBootstrap } from './salary.js';
import { appError, fromD1Error, GENERIC_ERROR_MESSAGE, isPublicError } from './errors.js';

export const BACKEND_VERSION = '3.0.0';

/** Pesan freeze, sama dengan GAS v2.5.4 tanpa marker "(Kode: MAINTENANCE)" (jalur Pages memakai error.code). */
export const MAINTENANCE_MESSAGE = 'Aplikasi sedang dalam pemeliharaan. Perubahan data dinonaktifkan sementara.';

/** Mutasi yang ditolak saat MAINTENANCE_MODE aktif. Login, logout, dan seluruh pembacaan tetap diizinkan. */
export const MUTATION_ACTIONS = Object.freeze([
  'letters.create', 'letters.update', 'letters.delete',
  'users.create', 'users.update', 'users.resetPassword', 'users.delete',
]);
const MUTATION_SET = new Set(MUTATION_ACTIONS);

const HANDLERS = new Map([
  ['auth.login', ({ db, env, payload, deviceToken, now }) => auth.login(db, env, payload, now, { deviceToken })],
  ['auth.logout', ({ db, sessionToken, now }) => auth.logout(db, sessionToken, now)],
  ['auth.session', ({ db, sessionToken, now }) => auth.getSession(db, sessionToken, now)],
  // Wajib sesi: tanpa sesi, request anonim berulang (±1.056 baris per panggilan) dapat menghabiskan
  // kuota baca harian D1. Tanpa token berbentuk sesi, penolakan terjadi tanpa query.
  ['bootstrap.get', async (ctx) => { await userSession(ctx); return getBootstrap(ctx.db); }],

  ['letters.list', async (ctx) => letters.listLetters(ctx.db, await userSession(ctx))],
  ['letters.create', async (ctx) => letters.createLetter(ctx.db, await userSession(ctx), ctx.payload, ctx.now)],
  ['letters.update', async (ctx) =>
    letters.updateLetter(ctx.db, await userSession(ctx), ctx.payload.id, ctx.payload, ctx.now)],
  ['letters.delete', async (ctx) => letters.deleteLetter(ctx.db, await userSession(ctx), ctx.payload.id)],

  ['users.list', async (ctx) => users.listUsers(ctx.db, ctx.env, await adminSession(ctx))],
  ['users.create', async (ctx) => users.createUser(ctx.db, ctx.env, await adminSession(ctx), ctx.payload)],
  ['users.update', async (ctx) =>
    users.updateUser(ctx.db, ctx.env, await adminSession(ctx), ctx.payload.username, ctx.payload)],
  ['users.resetPassword', async (ctx) =>
    users.resetPassword(ctx.db, ctx.env, await adminSession(ctx), ctx.payload.username, ctx.payload)],
  ['users.delete', async (ctx) =>
    users.deleteUser(ctx.db, ctx.env, await adminSession(ctx), ctx.payload.username)],
]);

/** Daftar action yang didukung, urutan sama dengan `dispatchHttpAction_` (tanpa `system.manifest`). */
export const SUPPORTED_ACTIONS = Object.freeze([...HANDLERS.keys()]);

/** True bila `MAINTENANCE_MODE` persis "true" (trim, case-insensitive), sama dengan GAS. */
export function isMaintenanceMode(env) {
  return String(env?.MAINTENANCE_MODE || '').trim().toLowerCase() === 'true';
}

/**
 * Menjalankan satu action.
 * @param {string} action
 * @param {{ db: object, env?: object, payload?: object, sessionToken?: string, deviceToken?: string,
 *   now?: Date|number }} context `deviceToken` = isi cookie perangkat, hanya dipakai `auth.login`.
 * @returns {Promise<object>} objek berbentuk GAS; tidak pernah melempar.
 */
export async function dispatch(action, { db, env, payload, sessionToken, deviceToken, now } = {}) {
  const name = typeof action === 'string' ? action : '';
  const handler = HANDLERS.get(name);
  if (!handler) return actionNotFound(name);

  // Freeze lebih dulu: tanpa query sesi, tanpa akses DB (sama dengan `assertWritesAllowed_`).
  if (MUTATION_SET.has(name) && isMaintenanceMode(env)) {
    return errorResult('MAINTENANCE', MAINTENANCE_MESSAGE);
  }

  const ctx = {
    db,
    env: env && typeof env === 'object' ? env : {},
    payload: isPlainObject(payload) ? payload : {},
    sessionToken: typeof sessionToken === 'string' ? sessionToken : '',
    deviceToken: typeof deviceToken === 'string' ? deviceToken : '',
    now,
  };

  try {
    const result = await handler(ctx);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return failure(name, appError('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE));
    }
    return result;
  } catch (error) {
    if (isPublicError(error)) {
      // Kegagalan sisi server yang sudah dipetakan domain (mis. error D1) tetap dicatat (tanpa teks).
      if (SERVER_FAILURE_CODES.has(error.code)) logFailure(name, error.code);
      return errorResult(error.code, String(error.message));
    }
    return failure(name, looksLikeD1Error(error) ? fromD1Error(error) : appError('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE));
  }
}

// Kode publik yang menandakan masalah server/konfigurasi, bukan kesalahan input/sesi pengguna.
const SERVER_FAILURE_CODES = new Set([
  'CONFIG_ERROR', 'SCHEMA_ERROR', 'DATA_ERROR', 'BUSY', 'DATA_WRITE_DENIED', 'DATA_VALIDATION_ERROR',
  'DATA_SERVICE_UNAVAILABLE', 'DATA_WRITE_FAILED',
]);

// ─── Internal ───────────────────────────────────────────────────────────────

function userSession(ctx) {
  return auth.requireSession(ctx.db, ctx.sessionToken, { now: ctx.now });
}

function adminSession(ctx) {
  return auth.requireSession(ctx.db, ctx.sessionToken, { admin: true, now: ctx.now });
}

function errorResult(code, message) {
  return { status: 'error', errorCode: code, errorMsg: message };
}

/** Kegagalan non-publik: log hanya action dan kode hasil pemetaan, lalu kembalikan pesan tetap. */
function failure(action, mapped) {
  logFailure(action, mapped.code);
  return errorResult(mapped.code, String(mapped.message));
}

function logFailure(action, code) {
  console.error('SIPSID API error', { action, code });
}

function actionNotFound(name) {
  // Nama action hanya dipantulkan bila berbentuk nama action yang wajar.
  const shown = /^[a-z]{1,20}\.[A-Za-z]{1,40}$/.test(name) ? `: ${name}` : '';
  return errorResult(
    'ACTION_NOT_FOUND',
    `Aksi API tidak dikenal${shown}. Backend v${BACKEND_VERSION} mendukung: ${SUPPORTED_ACTIONS.join(', ')}.`,
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Error yang berasal dari D1/SQLite dipetakan lewat `fromD1Error` (DATA_SERVICE_UNAVAILABLE /
// DATA_WRITE_FAILED / LAST_ADMIN_PROTECTED); error lain (bug, TypeError) menjadi INTERNAL_ERROR generik.
function looksLikeD1Error(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const text = typeof current === 'string' ? current : current.message;
    if (typeof text === 'string' && /\bD1(?:_[A-Z_]+)?\b|SQLITE_/.test(text)) return true;
    if (typeof current === 'string') break;
    current = current.cause;
  }
  return false;
}
