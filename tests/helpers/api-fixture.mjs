// Fixture gateway /api/* terhadap D1 node:sqlite (tests/helpers/d1-sqlite.mjs). Data sintetis saja.

import { createTestDb } from './d1-sqlite.mjs';
import { createSession, hashPassword } from '../../src/server/auth.js';
import { handleRequest } from '../../functions/api/[[path]].js';

export const ORIGIN = 'https://app.example';
export const PEPPER = 'pepper-uji-sintetis';
export const PASSWORD = 'rahasia-uji-1';
export const BACKEND_VERSION = '3.0.0';

const HASH = await hashPassword(PASSWORD, { PASSWORD_PEPPER: PEPPER });

/**
 * DB baru: admin1 (id 1, admin tunggal), peng1 (id 2, pengelola), 3 baris gaji.
 * @returns {Promise<{ db, env, adminToken: string, pengToken: string }>}
 */
export async function setupApi(extraEnv = {}) {
  const db = createTestDb();
  const insertUser = db.sqlite.prepare(
    'INSERT INTO users (id, username, password_hash, nama_lengkap, role) VALUES (?, ?, ?, ?, ?)',
  );
  insertUser.run(1, 'admin1', HASH, 'Admin Satu', 'admin');
  insertUser.run(2, 'peng1', HASH, 'Pengelola Satu', 'pengelola');
  const insertGaji = db.sqlite.prepare(
    `INSERT INTO salary_grades (status_pegawai, pangkat, golongan_code, mkg, nominal, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertGaji.run('PNS', 'Penata Muda (III/a)', 'III/a', 0, 2785700, 1);
  insertGaji.run('PNS', 'Penata Muda (III/a)', 'III/a', 2, 2873500, 1);
  insertGaji.run('PPPK', 'IX', 'IX', 0, 3203600, 1);
  const adminToken = await tokenFor(db, 1);
  const pengToken = await tokenFor(db, 2);
  const env = { DB: db, PASSWORD_PEPPER: PEPPER, ...extraEnv };
  return { db, env, adminToken, pengToken };
}

/** Token sesi baru untuk user `id`; `now` opsional (mis. di masa lalu untuk sesi kedaluwarsa). */
export async function tokenFor(db, id, now) {
  const user = db.sqlite.prepare('SELECT id, session_version FROM users WHERE id = ?').get(id);
  const { token } = await createSession(db, user, now);
  return token;
}

/**
 * Membuat Request. Mutasi otomatis memakai Origin aplikasi; `origin: null` = tanpa header Origin.
 * `body` objek → JSON + Content-Type application/json (kecuali `contentType` diberikan).
 */
export function apiRequest(path, { method = 'GET', body, cookie, origin, contentType, headers = {} } = {}) {
  const h = { ...headers };
  const effectiveOrigin = origin === undefined ? (method === 'GET' ? null : ORIGIN) : origin;
  if (effectiveOrigin) h.Origin = effectiveOrigin;
  if (cookie) h.Cookie = cookie.includes('=') ? cookie : `sipsid_session=${cookie}`;
  let text;
  if (body !== undefined) {
    text = typeof body === 'string' ? body : JSON.stringify(body);
    h['Content-Type'] = contentType || 'application/json';
  }
  return new Request(`${ORIGIN}${path}`, { method, headers: h, ...(text !== undefined ? { body: text } : {}) });
}

/** Menjalankan gateway dan mengembalikan status, header, dan body JSON. */
export async function callApi(env, path, options = {}) {
  const response = await handleRequest({ request: apiRequest(path, options), env });
  const text = await response.text();
  return {
    response,
    status: response.status,
    setCookie: response.headers.get('Set-Cookie'),
    cacheControl: response.headers.get('Cache-Control'),
    text,
    body: JSON.parse(text),
  };
}

/** DB pengganti yang mencatat setiap pemanggilan dan selalu melempar (bukti "tanpa akses DB"). */
export function untouchableDb() {
  const calls = [];
  const fail = (name) => (...args) => {
    calls.push(name);
    throw new Error(`DB must not be accessed (${name}) ${String(args[0] ?? '').slice(0, 20)}`);
  };
  return { calls, db: { prepare: fail('prepare'), batch: fail('batch'), exec: fail('exec') } };
}

/** Payload surat sintetis yang valid; gaji sudah dalam format klien sehingga round-trip identik. */
export function letterPayload(overrides = {}) {
  return {
    statusPegawai: 'PNS',
    nama: 'Pegawai Uji',
    nip: '199001012020011001',
    pangkat: 'Penata Muda (III/a)',
    jabatan: 'Guru Ahli Pertama',
    unit: 'SMA Uji 1',
    kabkot: 'Kota Uji',
    skPejabat: 'Pejabat Uji',
    skTanggal: '2024-01-02',
    skNomor: 'SK/001/2024',
    skTmt: '2024-01-01',
    mkLamaThn: '10',
    mkLamaBln: '0',
    gajiLama: 'Rp. 3.000.000,-',
    mkBaruThn: '12',
    mkBaruBln: '0',
    gajiBaruTmt: '2024-01-01',
    gajiBaru: 'Rp. 4.123.400,-',
    suratNomor: 'KGB/002/2024',
    suratTanggal: '2024-01-10',
    signJabatan: 'Kepala Uji',
    signNama: 'Penandatangan Uji',
    signPangkat: 'Pembina (IV/a)',
    signNip: '197001011995011001',
    ukuranKertas: 'legal',
    ...overrides,
  };
}

/** Path pertama ke key sensitif (password/hash/token/secret/stack) di objek mana pun, atau null. */
export function findSensitiveKey(value, path = '$') {
  const SENSITIVE = /^(?:password|password_hash|passwordhash|hash|pw|token|sessiontoken|apisecret|secret|stack)$/i;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findSensitiveKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (SENSITIVE.test(key)) return `${path}.${key}`;
      const found = findSensitiveKey(value[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
