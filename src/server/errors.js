// Error aplikasi untuk domain code (src/server/*).
//
// Port dari Code.js: `appError_`, `PUBLIC_ERROR_CODES_`, `isPublicAppError_`, `publicErrorMessage_`.
// Code.js = backend GAS lama, dihapus pada Fase 6; sumbernya ada di tag `pre-d1-cutover`.
// Pesan error publik aman ditampilkan apa adanya; error lain (termasuk error D1 mentah) hanya
// boleh keluar sebagai pesan generik. `fromD1Error` mengubah error D1 menjadi kode publik dengan
// pesan tetap, tanpa pernah menyertakan teks error D1 (MIGRATION_PLAN.md Bagian 5.3 dan 6.2).

import { isTriggerError } from './db.js';

export const GENERIC_ERROR_MESSAGE = 'Layanan sedang mengalami kendala. Silakan coba kembali.';

/** Kode yang pesannya aman dikirim ke klien: daftar Code.js + kode baru Cloudflare. */
export const PUBLIC_ERROR_CODES = Object.freeze([
  'BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'ACTION_NOT_FOUND', 'VALIDATION_ERROR', 'AUTH_REQUIRED',
  'SESSION_EXPIRED', 'FORBIDDEN', 'UNAUTHORIZED_GATEWAY', 'CONFIG_ERROR', 'SCHEMA_ERROR', 'DATA_ERROR',
  'DUPLICATE_USER', 'NOT_FOUND', 'LAST_ADMIN_PROTECTED', 'TOO_MANY_ATTEMPTS',
  'BUSY', 'DATA_WRITE_DENIED', 'DATA_VALIDATION_ERROR', 'DATA_SERVICE_UNAVAILABLE', 'DATA_WRITE_FAILED',
  'MAINTENANCE',
  'INVALID_CREDENTIALS', 'VERSION_CONFLICT',
]);

const PUBLIC_CODE_SET = new Set(PUBLIC_ERROR_CODES);

/** Pesan tetap untuk error D1 yang dipetakan. Tidak pernah memuat teks error D1. */
export const D1_ERROR_MESSAGES = Object.freeze({
  LAST_ADMIN_PROTECTED: 'Tidak dapat menghapus atau menurunkan hak akses admin terakhir.',
  DATA_SERVICE_UNAVAILABLE: 'Layanan basis data sedang tidak tersedia sementara. Silakan coba kembali beberapa saat lagi.',
  DATA_WRITE_FAILED: 'Operasi basis data gagal karena kendala yang belum teridentifikasi. Silakan coba kembali.',
});

// Error D1 yang bersifat sementara (jaringan, timeout, overload, reset Durable Object).
// Contoh pesan D1: "D1_ERROR: Network connection lost.", "D1 DB is overloaded. Too many requests queued.",
// "D1_ERROR: storage operation exceeded timeout which caused object to be reset.",
// "Internal error in D1 DB storage caused object to be reset.",
// "Cannot resolve D1 DB due to transient issue on remote node."
const TRANSIENT_D1_PATTERN =
  /network connection lost|connection (?:was )?(?:lost|reset|closed)|\breset\b|timed? ?out\b|timeout|overloaded|too many requests|transient|temporarily unavailable|service unavailable/i;

/**
 * Error dengan `.code`. Sama dengan `appError_` di Code.js.
 * @param {string} code
 * @param {string} message
 */
export function appError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** True jika `.code` termasuk PUBLIC_ERROR_CODES (pesan aman ditampilkan). */
export function isPublicError(error) {
  return Boolean(error && typeof error.code === 'string' && PUBLIC_CODE_SET.has(error.code));
}

/** Pesan untuk klien: pesan asli bila publik, selain itu pesan generik. */
export function publicMessage(error) {
  if (isPublicError(error)) return String(error.message);
  return GENERIC_ERROR_MESSAGE;
}

/**
 * Memetakan error D1 menjadi error publik dengan pesan tetap.
 * - Error publik yang sudah dibuat `appError` diteruskan apa adanya.
 * - `RAISE(ABORT, 'LAST_ADMIN_PROTECTED')` dari trigger → LAST_ADMIN_PROTECTED.
 * - Error sementara (jaringan/timeout/overload/reset) → DATA_SERVICE_UNAVAILABLE.
 * - Selain itu → DATA_WRITE_FAILED.
 * Teks error D1 tidak pernah disalin ke error hasil (tidak juga sebagai `cause`).
 * @param {unknown} error
 * @param {{ LAST_ADMIN_PROTECTED?: string, DATA_SERVICE_UNAVAILABLE?: string, DATA_WRITE_FAILED?: string }} [messages]
 *   pesan pengganti per kode, mis. pesan khusus operasi "hapus admin terakhir".
 */
export function fromD1Error(error, messages = {}) {
  if (isPublicError(error)) return error;
  let code;
  if (isTriggerError(error, 'LAST_ADMIN_PROTECTED')) {
    code = 'LAST_ADMIN_PROTECTED';
  } else if (errorTexts(error).some((text) => TRANSIENT_D1_PATTERN.test(text))) {
    code = 'DATA_SERVICE_UNAVAILABLE';
  } else {
    code = 'DATA_WRITE_FAILED';
  }
  const override = messages && typeof messages[code] === 'string' ? messages[code] : null;
  return appError(code, override || D1_ERROR_MESSAGES[code]);
}

function errorTexts(error) {
  const texts = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === 'string') {
      texts.push(current);
      break;
    }
    if (typeof current.message === 'string') texts.push(current.message);
    current = current.cause;
  }
  return texts;
}
