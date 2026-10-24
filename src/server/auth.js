// Autentikasi: hash password, sesi stateful, throttle login (MIGRATION_PLAN.md 4.1, 5.4, 5.5, Lampiran B).
//
// Hanya WebCrypto (`crypto.subtle`, `crypto.getRandomValues`), TextEncoder, btoa/atob: berjalan di
// Workers dan Node 24 tanpa Buffer/node:crypto. Seluruh SQL lewat src/server/db.js dengan ?1..?N.
// Code.js = backend GAS lama, dihapus pada Fase 6; sumbernya ada di tag `pre-d1-cutover`.
//
// Query D1 per operasi:
//   requireSession / getSession : 1 (SELECT sessions JOIN users)
//   createSession               : 1 (INSERT)
//   revokeSession / logout      : 1 (UPDATE); 0 bila token tidak berbentuk token sesi
//   login gagal                 : 2 (SELECT user, UPSERT throttle)
//   login berhasil              : 2 + 1 batch berisi 4 statement (5 bila rehash aktif)
//   login saat lookup user gagal: 2 (SELECT gagal, UPSERT bucket unknown)
//
// Cookie perangkat (pola "device cookie" OWASP): setelah login berhasil, browser menerima token
// bertanda tangan HMAC untuk akun itu. Percobaan berikutnya dari browser tersebut memakai bucket throttle
// milik token, bukan bucket bersama akun, sehingga orang lain yang sengaja salah password tidak dapat
// mengunci pengguna dari perangkat yang pernah dipakainya. Percobaan tanpa token valid tetap memakai
// bucket akun dengan batas yang sama seperti sebelumnya (5 per 5 menit), sehingga laju tebakan penyerang
// dan jumlah penulisan D1 tidak bertambah. Token tidak memberi akses apa pun selain bucket tersendiri.

import { all, first, nowIso, run, statement } from './db.js';
import { appError, fromD1Error } from './errors.js';
import { cleanText } from './format.js';

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const THROTTLE_MAX_ATTEMPTS = 5;
export const THROTTLE_WINDOW_MS = 5 * 60 * 1000;
export const PBKDF2_MAX_ITERATIONS = 100000; // batas WebCrypto Workers (Bagian 5.5)
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;
export const DEVICE_TOKEN_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

const UNKNOWN_USERNAME_BUCKET = '__unknown_username_bucket__';
// `v1.<userId>.<sessionVersion>.<issuedAtDetik>.<hmac base64url>`; userId/sessionVersion ≥ 1, issuedAt ≤ 10 digit.
const DEVICE_TOKEN_PATTERN = /^v1\.([1-9]\d{0,14})\.([1-9]\d{0,14})\.(\d{1,10})\.([A-Za-z0-9_-]{43})$/;
const DEVICE_TOKEN_CLOCK_SKEW_SECONDS = 300;
const DEVICE_KEY_LABEL = 'sipsid-device-cookie-v1:';
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // base64url 32 byte tanpa padding
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;
const PBKDF2_MAX_HASH_BYTES = 64;

// Pesan publik, identik dengan Code.js.
export const AUTH_MESSAGES = Object.freeze({
  INVALID_CREDENTIALS: 'Username atau password tidak valid.',
  SESSION_INVALID: 'Sesi tidak valid. Silakan login kembali.',
  SESSION_EXPIRED: 'Sesi telah berakhir. Silakan login kembali.',
  ACCOUNT_NOT_FOUND: 'Akun tidak ditemukan. Silakan login kembali.',
  SESSION_STALE: 'Sesi tidak lagi valid. Silakan login kembali.',
  FORBIDDEN_ADMIN: 'Hanya administrator yang dapat mengelola pengguna.',
  PEPPER_MISSING_VERIFY: 'PASSWORD_PEPPER belum dikonfigurasi. Hubungi administrator sistem.',
  PEPPER_MISSING_HASH: 'PASSWORD_PEPPER belum dikonfigurasi.',
  PASSWORD_TOO_SHORT: 'Password minimal 8 karakter.',
  PASSWORD_TOO_LONG: 'Password terlalu panjang (maks 200 karakter).',
});

const encoder = new TextEncoder();

// ─── Primitif crypto ────────────────────────────────────────────────────────

/**
 * SHA-256 heksadesimal lowercase dari string UTF-8 (sama dengan `sha256Hex_` Code.js).
 *
 * Catatan (tanpa perubahan perilaku): string dengan surrogate UTF-16 tak berpasangan (lone surrogate)
 * di-encode TextEncoder menjadi U+FFFD (EF BF BD), sedangkan `Utilities.computeDigest` GAS (encoder
 * Java) memakai byte pengganti lain. Password seperti itu menghasilkan hash berbeda antara GAS dan
 * Workers, sehingga selama jendela rollback akun dengan password tersebut tidak dapat login lintas
 * backend. Password dari form normal (input teks browser) tidak mengandung lone surrogate.
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(text)));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Perbandingan string waktu-konstan terhadap isi (port `constantTimeEquals_`).
 * Panjang berbeda tetap menghasilkan false tanpa keluar lebih awal.
 */
export function constantTimeEqual(left, right) {
  const a = String(left == null ? '' : left);
  const b = String(right == null ? '' : right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

// ─── Password ───────────────────────────────────────────────────────────────

/**
 * Verifikasi password terhadap hash tersimpan.
 * - `sha256$<salt>$<hex>`: hex = sha256Hex(salt + password + env.PASSWORD_PEPPER) (kompatibel Code.js).
 *   Pepper kosong → CONFIG_ERROR (tidak pernah memakai "" sebagai pepper).
 * - `pbkdf2_sha256$<iterasi>$<saltB64>$<hashB64>`: PBKDF2-HMAC-SHA256, iterasi 1..100000.
 * - Format lain (termasuk plaintext lama) → false.
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored, env) {
  const candidate = String(password == null ? '' : password);
  const hash = String(stored == null ? '' : stored);

  if (hash.startsWith('sha256$')) {
    const parts = hash.split('$');
    if (parts.length !== 3) return false;
    const pepper = env?.PASSWORD_PEPPER;
    if (!pepper) throw appError('CONFIG_ERROR', AUTH_MESSAGES.PEPPER_MISSING_VERIFY);
    const computed = await sha256Hex(parts[1] + candidate + pepper);
    return constantTimeEqual(computed, parts[2].toLowerCase());
  }

  if (hash.startsWith('pbkdf2_sha256$')) {
    const parsed = parsePbkdf2(hash);
    if (!parsed) return false;
    const derived = await pbkdf2(candidate, parsed.salt, parsed.iterations, parsed.hash.length);
    return constantTimeEqualBytes(derived, parsed.hash);
  }

  return false;
}

/**
 * Hash password baru dengan algoritme `env.PASSWORD_HASH_ALGO` (default `sha256`, Bagian 5.5).
 * - `sha256`: `sha256$<32 hex salt>$<64 hex>`, wajib PASSWORD_PEPPER (CONFIG_ERROR bila kosong).
 * - `pbkdf2_sha256`: salt 16 byte, iterasi `env.PBKDF2_ITERATIONS` (default & maks 100000).
 * @returns {Promise<string>}
 */
export async function hashPassword(password, env) {
  const candidate = String(password == null ? '' : password);
  const algo = passwordHashAlgo(env);
  if (algo === 'sha256') {
    const pepper = env?.PASSWORD_PEPPER;
    if (!pepper) throw appError('CONFIG_ERROR', AUTH_MESSAGES.PEPPER_MISSING_HASH);
    const salt = bytesToHex(randomBytes(16));
    return `sha256$${salt}$${await sha256Hex(salt + candidate + pepper)}`;
  }
  const iterations = pbkdf2Iterations(env);
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const derived = await pbkdf2(candidate, salt, iterations, PBKDF2_HASH_BYTES);
  return `pbkdf2_sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

/** True bila hash tersimpan tidak memakai algoritme/iterasi yang dikonfigurasi saat ini. */
export function needsRehash(stored, env) {
  const hash = String(stored == null ? '' : stored);
  const algo = passwordHashAlgo(env);
  if (algo === 'sha256') return !hash.startsWith('sha256$');
  const parsed = parsePbkdf2(hash);
  return !parsed || parsed.iterations < pbkdf2Iterations(env);
}

/**
 * Aturan password baru (create user / reset password), identik dengan Code.js.
 * @returns {string} password apa adanya (tidak di-trim).
 * @throws VALIDATION_ERROR
 */
export function validateNewPassword(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH) throw appError('VALIDATION_ERROR', AUTH_MESSAGES.PASSWORD_TOO_SHORT);
  if (value.length > PASSWORD_MAX_LENGTH) throw appError('VALIDATION_ERROR', AUTH_MESSAGES.PASSWORD_TOO_LONG);
  return value;
}

// ─── Sesi (Bagian 5.4) ──────────────────────────────────────────────────────

/**
 * Membuat sesi baru. Hanya sha256(token) yang disimpan.
 * @param {object} db binding D1
 * @param {{ id?: number, userId?: number, session_version?: number, sessionVersion?: number }} user
 * @param {Date|number} [now]
 * @returns {Promise<{ token: string, expiresIn: number }>}
 */
export async function createSession(db, user, now = new Date()) {
  const prepared = await prepareSession(db, user, now);
  try {
    await prepared.stmt.run();
  } catch (error) {
    throw fromD1Error(error);
  }
  return { token: prepared.token, expiresIn: SESSION_TTL_SECONDS };
}

/**
 * Memvalidasi sesi dalam satu query (sessions JOIN users) dan mengembalikan identitas LIVE.
 * Urutan: token tidak dikenal/dicabut → AUTH_REQUIRED; kedaluwarsa → SESSION_EXPIRED;
 * akun hilang / session_version berubah → AUTH_REQUIRED; `admin` dan role live ≠ admin → FORBIDDEN.
 * @param {object} db
 * @param {string} token
 * @param {{ admin?: boolean, forbiddenMessage?: string, now?: Date|number }} [options]
 * @returns {Promise<{ userId: number, username: string, namaLengkap: string, hakAkses: string, sessionVersion: number }>}
 */
export async function requireSession(db, token, { admin = false, forbiddenMessage, now } = {}) {
  if (!isSessionTokenShape(token)) throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_INVALID);
  const tokenHash = await sha256Hex(token);
  let row;
  try {
    row = await first(
      db,
      `SELECT s.expires_at, s.revoked_at, s.session_version AS session_sv,
              u.id AS user_id, u.username, u.nama_lengkap, u.role, u.session_version AS user_sv
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?1`,
      tokenHash,
    );
  } catch (error) {
    throw fromD1Error(error);
  }
  if (!row || row.revoked_at !== null) throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_INVALID);
  if (String(row.expires_at) <= nowIso(now)) throw appError('SESSION_EXPIRED', AUTH_MESSAGES.SESSION_EXPIRED);
  if (row.user_id === null || row.user_id === undefined) {
    throw appError('AUTH_REQUIRED', AUTH_MESSAGES.ACCOUNT_NOT_FOUND);
  }
  if (Number(row.session_sv) !== Number(row.user_sv)) {
    throw appError('AUTH_REQUIRED', AUTH_MESSAGES.SESSION_STALE);
  }
  if (admin && row.role !== 'admin') {
    throw appError('FORBIDDEN', forbiddenMessage || AUTH_MESSAGES.FORBIDDEN_ADMIN);
  }
  return {
    userId: Number(row.user_id),
    username: String(row.username),
    namaLengkap: String(row.nama_lengkap || '').trim() || String(row.username),
    hakAkses: row.role === 'admin' ? 'admin' : 'pengelola',
    sessionVersion: Number(row.user_sv),
  };
}

/**
 * Mencabut sesi (logout). Token yang tidak berbentuk token sesi diabaikan tanpa query.
 * @returns {Promise<boolean>} true bila sebuah sesi aktif dicabut.
 */
export async function revokeSession(db, token, now = new Date()) {
  if (!isSessionTokenShape(token)) return false;
  const tokenHash = await sha256Hex(token);
  try {
    const result = await run(
      db,
      'UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL',
      tokenHash,
      nowIso(now),
    );
    return Number(result?.meta?.changes ?? 0) > 0;
  } catch (error) {
    throw fromD1Error(error);
  }
}

// ─── Action auth.* (bentuk hasil sama dengan GAS, Bagian 6.1) ───────────────

/**
 * Login. Gagal karena username tidak dikenal, password salah, throttle, atau error D1 saat throttle
 * selalu melempar INVALID_CREDENTIALS dengan pesan sama (tanpa enumerasi akun), dan selalu menjalankan
 * satu derivasi password (biaya waktu setara). PASSWORD_PEPPER kosong → CONFIG_ERROR untuk setiap
 * percobaan, sebelum query apa pun.
 * @param {object} db
 * @param {object} env `PASSWORD_PEPPER`, `PASSWORD_HASH_ALGO`, `PBKDF2_ITERATIONS`, `PASSWORD_REHASH_ON_LOGIN`
 * @param {{ username?: unknown, password?: unknown }} credentials
 * @param {Date|number} [now]
 * @param {{ deviceToken?: string }} [options] isi cookie perangkat dari request, bila ada
 * @returns {Promise<{ status: 'success', sessionToken: string, expiresIn: number, deviceToken: string,
 *   user: { username: string, namaLengkap: string, hakAkses: string } }>} `deviceToken` = token perangkat baru.
 */
export async function login(db, env, credentials, now = new Date(), { deviceToken = '' } = {}) {
  const username = cleanText(credentials?.username, 100);
  const password = String(credentials?.password || '');
  if (!username || !password) throw invalidCredentials();
  // Konfigurasi dicek sebelum lookup user dan konsumsi throttle: pepper kosong → CONFIG_ERROR untuk
  // SETIAP percobaan (akun dikenal maupun tidak), sehingga kode status tidak membocorkan keberadaan akun.
  if (!env?.PASSWORD_PEPPER) throw appError('CONFIG_ERROR', AUTH_MESSAGES.PEPPER_MISSING_VERIFY);
  passwordHashAlgo(env); // PASSWORD_HASH_ALGO tidak dikenal → CONFIG_ERROR, juga untuk semua percobaan
  const nowMs = toMillis(now);

  let user;
  try {
    user = await first(
      db,
      `SELECT id, username, password_hash, nama_lengkap, role, session_version
         FROM users WHERE username = ?1 LIMIT 1`,
      username,
    );
  } catch (lookupError) {
    // Seperti Code.js: tetap konsumsi bucket bersama (fail-closed) sebelum melaporkan error.
    if (!(await consumeLoginAttempt(db, await throttleKey(UNKNOWN_USERNAME_BUCKET), nowMs))) {
      await verifyPassword(password, dummyHash(env), env); // biaya setara jalur gagal; hasil diabaikan
      throw invalidCredentials();
    }
    throw fromD1Error(lookupError);
  }

  // Tanda tangan token perangkat diverifikasi apa pun hasil lookup, agar waktu respons tidak membedakan
  // akun dikenal dan tidak dikenal. Token hanya berlaku untuk akun dan session_version yang sama.
  const device = await parseDeviceToken(deviceToken, env, nowMs);
  const trustedDevice = Boolean(user && device
    && device.userId === Number(user.id) && device.sessionVersion === Number(user.session_version));
  // Key dari username kanonik tersimpan, tidak pernah dari input mentah (Bagian 4.1).
  const key = await throttleKey(trustedDevice
    ? `device:${deviceToken}`
    : user ? String(user.username).toLowerCase() : UNKNOWN_USERNAME_BUCKET);
  const allowed = await consumeLoginAttempt(db, key, nowMs);

  // Derivasi password SELALU dijalankan tepat sekali (juga saat throttle menolak) agar waktu respons
  // percobaan ter-throttle, username tidak dikenal, dan password salah tidak dapat dibedakan.
  let valid = false;
  if (user) {
    valid = await verifyPassword(password, user.password_hash, env);
  } else {
    await verifyPassword(password, dummyHash(env), env); // biaya setara; hasil diabaikan
  }
  if (!allowed || !valid) throw invalidCredentials();

  const nowText = nowIso(nowMs);
  const session = await prepareSession(db, user, nowMs);
  const statements = [
    statement(db, 'DELETE FROM login_throttle WHERE key = ?1', key),
    statement(db, 'DELETE FROM sessions WHERE expires_at <= ?1', nowText),
    statement(db, 'DELETE FROM login_throttle WHERE expires_at <= ?1', nowMs),
    session.stmt,
  ];
  const rehashed = await maybeRehash(password, user.password_hash, env);
  if (rehashed) {
    // Compare-and-swap: tidak menimpa reset password yang terjadi di antara SELECT dan batch ini.
    statements.push(statement(
      db,
      'UPDATE users SET password_hash = ?3, updated_at = ?4 WHERE id = ?1 AND password_hash = ?2',
      user.id,
      user.password_hash,
      rehashed,
      nowText,
    ));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    throw fromD1Error(error);
  }

  const storedUsername = String(user.username);
  return {
    status: 'success',
    sessionToken: session.token,
    expiresIn: SESSION_TTL_SECONDS,
    deviceToken: await createDeviceToken(user, env, nowMs),
    user: {
      username: storedUsername,
      namaLengkap: cleanText(user.nama_lengkap, 160) || storedUsername,
      hakAkses: user.role === 'admin' ? 'admin' : 'pengelola',
    },
  };
}

/** `auth.session`: `{ status, user }` dari data user live. */
export async function getSession(db, token, now) {
  const session = await requireSession(db, token, { now });
  return {
    status: 'success',
    user: { username: session.username, namaLengkap: session.namaLengkap, hakAkses: session.hakAkses },
  };
}

/** `auth.logout`: mencabut sesi bila ada; idempotent, tidak error bila token kosong/tidak dikenal. */
export async function logout(db, token, now = new Date()) {
  await revokeSession(db, token, now);
  return { status: 'success' };
}

// ─── Internal ───────────────────────────────────────────────────────────────

async function prepareSession(db, user, now) {
  const userId = Number(user?.id ?? user?.userId);
  const sessionVersion = Number(user?.session_version ?? user?.sessionVersion);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1) {
    throw new TypeError('createSession: user.id and user.session_version are required');
  }
  const nowMs = toMillis(now);
  const token = bytesToBase64Url(randomBytes(SESSION_TOKEN_BYTES));
  const stmt = statement(
    db,
    `INSERT INTO sessions (token_hash, user_id, session_version, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
    await sha256Hex(token),
    userId,
    sessionVersion,
    nowIso(nowMs),
    nowIso(nowMs + SESSION_TTL_SECONDS * 1000),
  );
  return { token, stmt };
}

/**
 * Rehash saat login hanya bila `PASSWORD_REHASH_ON_LOGIN === 'true'` (default nonaktif sampai Fase 6).
 * Bersifat oportunistik: kegagalan (mis. konfigurasi) tidak menggagalkan login.
 */
async function maybeRehash(password, storedHash, env) {
  if (env?.PASSWORD_REHASH_ON_LOGIN !== 'true') return null;
  try {
    if (!needsRehash(storedHash, env)) return null;
    return await hashPassword(password, env);
  } catch {
    return null;
  }
}

// Kunci HMAC diturunkan dari PASSWORD_PEPPER dengan label sendiri (tidak perlu secret baru).
async function deviceKey(env) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(DEVICE_KEY_LABEL + env.PASSWORD_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function createDeviceToken(user, env, nowMs) {
  const body = `v1.${Number(user.id)}.${Number(user.session_version)}.${Math.floor(nowMs / 1000)}`;
  const mac = await crypto.subtle.sign('HMAC', await deviceKey(env), encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(mac))}`;
}

/** `{ userId, sessionVersion }` bila token perangkat bertanda tangan sah dan belum kedaluwarsa; selain itu null. */
async function parseDeviceToken(token, env, nowMs) {
  const match = typeof token === 'string' ? DEVICE_TOKEN_PATTERN.exec(token) : null;
  if (!match) return null;
  const issuedAt = Number(match[3]);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (issuedAt > nowSeconds + DEVICE_TOKEN_CLOCK_SKEW_SECONDS || nowSeconds - issuedAt > DEVICE_TOKEN_MAX_AGE_SECONDS) {
    return null;
  }
  const mac = base64ToBytes(`${match[4].replace(/-/g, '+').replace(/_/g, '/')}=`);
  // Hanya encoding kanonik: 2 bit sisa karakter terakhir harus nol, agar satu token tidak punya beberapa
  // ejaan (masing-masing akan mendapat bucket throttle sendiri).
  if (!mac || bytesToBase64Url(mac) !== match[4]) return null;
  const body = token.slice(0, token.lastIndexOf('.'));
  if (!(await crypto.subtle.verify('HMAC', await deviceKey(env), mac, encoder.encode(body)))) return null;
  return { userId: Number(match[1]), sessionVersion: Number(match[2]) };
}

/** Konsumsi atomik (Lampiran B). true = diizinkan. Error D1 = ditolak (fail-closed). */
async function consumeLoginAttempt(db, key, nowMs) {
  try {
    const rows = await all(
      db,
      `INSERT INTO login_throttle (key, count, expires_at) VALUES (?1, 1, ?2 + ?3)
       ON CONFLICT(key) DO UPDATE SET
         count      = CASE WHEN login_throttle.expires_at <= ?2 THEN 1 ELSE login_throttle.count + 1 END,
         expires_at = ?2 + ?3
       WHERE login_throttle.expires_at <= ?2 OR login_throttle.count < ?4
       RETURNING count`,
      key,
      nowMs,
      THROTTLE_WINDOW_MS,
      THROTTLE_MAX_ATTEMPTS,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function throttleKey(identity) {
  return `lt_${(await sha256Hex(identity)).substring(0, 32)}`;
}

function invalidCredentials() {
  return appError('INVALID_CREDENTIALS', AUTH_MESSAGES.INVALID_CREDENTIALS);
}

function dummyHash(env) {
  if (passwordHashAlgo(env) === 'sha256') return `sha256$${'0'.repeat(32)}$${'0'.repeat(64)}`;
  return `pbkdf2_sha256$${pbkdf2Iterations(env)}$${'A'.repeat(22)}==$${'A'.repeat(43)}=`;
}

function passwordHashAlgo(env) {
  const raw = env?.PASSWORD_HASH_ALGO;
  const algo = raw === undefined || raw === null || String(raw).trim() === '' ? 'sha256' : String(raw).trim().toLowerCase();
  if (algo !== 'sha256' && algo !== 'pbkdf2_sha256') {
    throw appError('CONFIG_ERROR', 'PASSWORD_HASH_ALGO tidak dikenal. Hubungi administrator sistem.');
  }
  return algo;
}

function pbkdf2Iterations(env) {
  const raw = env?.PBKDF2_ITERATIONS;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) return PBKDF2_MAX_ITERATIONS;
  return Math.min(Number(text), PBKDF2_MAX_ITERATIONS);
}

function parsePbkdf2(hash) {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return null;
  if (!/^[1-9]\d{0,8}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (iterations > PBKDF2_MAX_ITERATIONS) return null;
  const salt = base64ToBytes(parts[2]);
  const derived = base64ToBytes(parts[3]);
  if (!salt || !derived || salt.length === 0 || derived.length === 0 || derived.length > PBKDF2_MAX_HASH_BYTES) {
    return null;
  }
  return { iterations, salt, hash: derived };
}

async function pbkdf2(password, salt, iterations, length) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, length * 8);
  return new Uint8Array(bits);
}

function constantTimeEqualBytes(a, b) {
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

function isSessionTokenShape(token) {
  return typeof token === 'string' && SESSION_TOKEN_PATTERN.test(token);
}

function toMillis(value) {
  const time = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(time)) throw new RangeError('invalid time');
  return Math.trunc(time);
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBytes(text) {
  if (typeof text !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    return null;
  }
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
