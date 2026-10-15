// Test dispatcher backend (src/server/dispatch.js) dan golden envelope 13 action lewat gateway
// (functions/api/[[path]].js) terhadap D1 node:sqlite. Data sintetis saja.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKEND_VERSION,
  MAINTENANCE_MESSAGE,
  MUTATION_ACTIONS,
  SUPPORTED_ACTIONS,
  dispatch,
  isMaintenanceMode,
} from '../src/server/dispatch.js';
import { GENERIC_ERROR_MESSAGE } from '../src/server/errors.js';
import { THROTTLE_MAX_ATTEMPTS } from '../src/server/auth.js';
import { clearSessionCookie } from '../functions/api/[[path]].js';
import {
  BACKEND_VERSION as EXPECTED_VERSION,
  PASSWORD,
  callApi,
  findSensitiveKey,
  letterPayload,
  setupApi,
  tokenFor,
  untouchableDb,
} from './helpers/api-fixture.mjs';

const ALL_ACTIONS = [
  'auth.login', 'auth.logout', 'auth.session', 'bootstrap.get',
  'letters.list', 'letters.create', 'letters.update', 'letters.delete',
  'users.list', 'users.create', 'users.update', 'users.resetPassword', 'users.delete',
];
const INVALID_CREDENTIALS = { code: 'invalid_credentials', message: 'Username atau password tidak valid.' };
const REQUEST_ID = '0b9f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const LETTER_ID_RE = new RegExp(`^KGB-\\d{4}-${REQUEST_ID}$`);

/** Menangkap console.error selama `fn`. */
async function captureConsoleError(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

/** Seluruh envelope yang diperiksa golden test dikumpulkan di sini untuk deep scan. */
const seenEnvelopes = [];
async function api(env, path, options) {
  const res = await callApi(env, path, options);
  seenEnvelopes.push({ path, text: res.text, body: res.body });
  assert.equal(res.cacheControl, 'no-store');
  return res;
}

// ─── dispatch: unit ─────────────────────────────────────────────────────────

test('BACKEND_VERSION = 3.0.0 dan daftar action tepat 13 (tanpa system.manifest)', () => {
  assert.equal(BACKEND_VERSION, '3.0.0');
  assert.equal(EXPECTED_VERSION, BACKEND_VERSION);
  assert.deepEqual([...SUPPORTED_ACTIONS], ALL_ACTIONS);
  assert.deepEqual([...MUTATION_ACTIONS].sort(), [
    'letters.create', 'letters.delete', 'letters.update',
    'users.create', 'users.delete', 'users.resetPassword', 'users.update',
  ]);
});

test('dispatch: action tidak dikenal → ACTION_NOT_FOUND tanpa akses DB', async () => {
  for (const action of ['system.manifest', 'letters.purge', '', undefined, 42, '__proto__', 'constructor']) {
    const { db, calls } = untouchableDb();
    const result = await dispatch(action, { db, env: {}, payload: {}, sessionToken: '' });
    assert.equal(result.status, 'error');
    assert.equal(result.errorCode, 'ACTION_NOT_FOUND');
    assert.match(result.errorMsg, /^Aksi API tidak dikenal/);
    assert.match(result.errorMsg, /Backend v3\.0\.0 mendukung: auth\.login, .*users\.delete\.$/);
    assert.equal(result.errorMsg.split('mendukung:')[1].includes('system.manifest'), false);
    assert.deepEqual(calls, []);
  }
  const named = await dispatch('system.manifest', { db: untouchableDb().db });
  assert.match(named.errorMsg, /^Aksi API tidak dikenal: system\.manifest\./);
  const weird = await dispatch('<script>x</script>', { db: untouchableDb().db });
  assert.equal(weird.errorMsg.includes('<script>'), false, 'nama action aneh tidak dipantulkan');
});

test('dispatch: setiap action dirutekan ke domain yang benar', async () => {
  const { db, env, adminToken, pengToken } = await setupApi();
  const run = (action, payload = {}, sessionToken = adminToken) => dispatch(action, { db, env, payload, sessionToken });

  const login = await run('auth.login', { username: 'PENG1', password: PASSWORD }, '');
  assert.equal(login.status, 'success');
  assert.equal(login.user.username, 'peng1', 'login case-insensitive (K2) mengembalikan username tersimpan');
  assert.match(login.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(login.expiresIn, 28800);

  assert.deepEqual(await run('auth.session', {}, pengToken), {
    status: 'success',
    user: { username: 'peng1', namaLengkap: 'Pengelola Satu', hakAkses: 'pengelola' },
  });
  const boot = await run('bootstrap.get', {}, '');
  assert.equal(boot.status, 'success');
  assert.equal(boot.gajiPNS.length, 2);

  const created = await run('letters.create', letterPayload({ requestId: REQUEST_ID }), pengToken);
  assert.equal(created.status, 'success');
  const id = created.data.id;
  assert.equal((await run('letters.list', {}, pengToken)).data.length, 1);
  const updated = await run('letters.update', letterPayload({ id, nama: 'Nama Diubah' }), pengToken);
  assert.equal(updated.data.nama, 'Nama Diubah');
  assert.deepEqual(await run('letters.delete', { id }), { status: 'success', id });

  assert.equal((await run('users.list')).data.length, 2);
  const newUser = await run('users.create', { username: 'baru1', password: 'password-1', namaLengkap: 'Baru', hakAkses: 'pengelola' });
  assert.deepEqual(newUser, { status: 'success', data: { username: 'baru1', namaLengkap: 'Baru', hakAkses: 'pengelola' } });
  assert.equal((await run('users.update', { username: 'baru1', namaLengkap: 'Baru 2', hakAkses: 'admin' })).data.hakAkses, 'admin');
  assert.deepEqual(await run('users.resetPassword', { username: 'baru1', newPassword: 'password-2' }), { status: 'success', username: 'baru1' });
  assert.deepEqual(await run('users.delete', { username: 'baru1' }), { status: 'success', username: 'baru1' });

  assert.deepEqual(await run('auth.logout', {}, pengToken), { status: 'success' });
  assert.equal((await run('auth.session', {}, pengToken)).errorCode, 'AUTH_REQUIRED');
});

test('dispatch: letters.* memakai sesi biasa, users.* memakai sesi admin', async () => {
  const { db, env, pengToken } = await setupApi();
  const letters = await dispatch('letters.list', { db, env, sessionToken: pengToken });
  assert.equal(letters.status, 'success');
  for (const action of ['users.list', 'users.create', 'users.update', 'users.resetPassword', 'users.delete']) {
    const result = await dispatch(action, { db, env, payload: { username: 'admin1' }, sessionToken: pengToken });
    assert.deepEqual(result, {
      status: 'error',
      errorCode: 'FORBIDDEN',
      errorMsg: 'Hanya administrator yang dapat mengelola pengguna.',
    }, action);
  }
  for (const action of ['letters.list', 'letters.create', 'letters.update', 'letters.delete', 'users.list', 'auth.session']) {
    const result = await dispatch(action, { db, env, payload: {}, sessionToken: '' });
    assert.equal(result.errorCode, 'AUTH_REQUIRED', action);
  }
});

test('dispatch: payload non-objek diperlakukan sebagai {}', async () => {
  const { db, env } = await setupApi();
  for (const payload of [null, undefined, 'x', [], 5]) {
    const result = await dispatch('auth.login', { db, env, payload });
    assert.equal(result.errorCode, 'INVALID_CREDENTIALS');
  }
});

// ─── MAINTENANCE_MODE ───────────────────────────────────────────────────────

test('isMaintenanceMode: hanya "true" (trim, case-insensitive)', () => {
  for (const value of ['true', 'TRUE', ' True ', '\ttrue\n', true]) {
    assert.equal(isMaintenanceMode({ MAINTENANCE_MODE: value }), true, String(value));
  }
  for (const value of [undefined, null, '', 'false', '1', 'yes', 'on', 'truee', false]) {
    assert.equal(isMaintenanceMode({ MAINTENANCE_MODE: value }), false, String(value));
  }
  assert.equal(isMaintenanceMode(undefined), false);
});

test('MAINTENANCE: dispatch menolak 7 mutasi tanpa akses DB sama sekali', async () => {
  for (const action of MUTATION_ACTIONS) {
    const { db, calls } = untouchableDb();
    const result = await dispatch(action, {
      db,
      env: { MAINTENANCE_MODE: ' TRUE ' },
      payload: { id: 'KGB-2026-x', username: 'peng1' },
      sessionToken: 'A'.repeat(43),
    });
    assert.deepEqual(result, { status: 'error', errorCode: 'MAINTENANCE', errorMsg: MAINTENANCE_MESSAGE }, action);
    assert.deepEqual(calls, [], `${action}: DB tidak boleh disentuh`);
  }
  assert.equal(MAINTENANCE_MESSAGE, 'Aplikasi sedang dalam pemeliharaan. Perubahan data dinonaktifkan sementara.');
  assert.equal(MAINTENANCE_MESSAGE.includes('(Kode:'), false);
});

test('MAINTENANCE: gateway → 503 maintenance untuk 7 mutasi, cookie tidak dihapus, DB tidak disentuh', async () => {
  const cases = [
    ['POST', '/api/letters', letterPayload()],
    ['PUT', '/api/letters/KGB-2026-abc', letterPayload()],
    ['DELETE', '/api/letters/KGB-2026-abc', undefined],
    ['POST', '/api/users', { username: 'baru', password: 'password123', namaLengkap: 'Baru', hakAkses: 'pengelola' }],
    ['PUT', '/api/users/staff', { namaLengkap: 'Staf', hakAkses: 'pengelola' }],
    ['PUT', '/api/users/staff/password', { newPassword: 'passwordbaru1' }],
    ['DELETE', '/api/users/staff', undefined],
  ];
  for (const [method, path, body] of cases) {
    const { db, calls } = untouchableDb();
    const res = await api({ DB: db, MAINTENANCE_MODE: 'true' }, path, { method, body, cookie: 'A'.repeat(43) });
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal(res.setCookie, null);
    assert.deepEqual(res.body, {
      ok: false,
      data: null,
      error: { code: 'maintenance', message: MAINTENANCE_MESSAGE },
      backendVersion: EXPECTED_VERSION,
    });
    assert.deepEqual(calls, []);
  }
});

test('MAINTENANCE: login, logout, session, dan seluruh pembacaan tetap diizinkan', async () => {
  const { env, adminToken, pengToken } = await setupApi({ MAINTENANCE_MODE: 'true' });
  const login = await api(env, '/api/auth/login', { method: 'POST', body: { username: 'admin1', password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.match(login.setCookie, /^sipsid_session=/);
  assert.equal((await api(env, '/api/auth/session', { cookie: adminToken })).status, 200);
  assert.equal((await api(env, '/api/bootstrap')).status, 200);
  assert.equal((await api(env, '/api/letters', { cookie: pengToken })).status, 200);
  assert.equal((await api(env, '/api/users', { cookie: adminToken })).status, 200);
  const logout = await api(env, '/api/auth/logout', { method: 'POST', body: {}, cookie: pengToken });
  assert.equal(logout.status, 200);
  assert.equal(logout.setCookie, clearSessionCookie());
});

test('MAINTENANCE nonaktif ("false") tidak memblokir mutasi', async () => {
  const { env, pengToken } = await setupApi({ MAINTENANCE_MODE: 'false' });
  const res = await api(env, '/api/letters', { method: 'POST', cookie: pengToken, body: letterPayload() });
  assert.equal(res.status, 200);
});

// ─── Error mentah ───────────────────────────────────────────────────────────

test('error mentah → pesan generik, tanpa teks exception; console.error hanya { action, code }', async () => {
  const secret = 'rahasia-199001012020011001-boom';
  const payload = {
    get username() { throw new Error(`internal ${secret}`); },
    password: 'password-payload-rahasia',
  };
  const { result, logged } = await captureConsoleError(() =>
    dispatch('auth.login', { db: untouchableDb().db, env: {}, payload }));
  assert.deepEqual(result, { status: 'error', errorCode: 'INTERNAL_ERROR', errorMsg: GENERIC_ERROR_MESSAGE });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], ['SIPSID API error', { action: 'auth.login', code: 'INTERNAL_ERROR' }]);
  const logText = JSON.stringify(logged);
  assert.equal(logText.includes(secret), false);
  assert.equal(logText.includes('password-payload-rahasia'), false);
});

test('error mentah berbentuk D1 dipetakan lewat fromD1Error tanpa teks D1', async () => {
  const cases = [
    ['D1_ERROR: Network connection lost.', 'DATA_SERVICE_UNAVAILABLE'],
    ['D1_ERROR: no such column: x: SQLITE_ERROR', 'DATA_WRITE_FAILED'],
  ];
  for (const [message, code] of cases) {
    const payload = { get username() { throw new Error(message); } };
    const { result, logged } = await captureConsoleError(() =>
      dispatch('auth.login', { db: untouchableDb().db, env: {}, payload }));
    assert.equal(result.errorCode, code);
    assert.equal(result.errorMsg.includes('D1'), false);
    assert.equal(result.errorMsg.includes('SQLITE'), false);
    assert.deepEqual(logged, [['SIPSID API error', { action: 'auth.login', code }]]);
  }
});

test('error mentah dari binding lewat gateway → 502 pesan tetap, tanpa teks mentah atau stack', async () => {
  const { env, adminToken } = await setupApi();
  // Binding DB gagal dengan error non-D1 setelah sesi valid (prepare kedua melempar TypeError mentah).
  let prepares = 0;
  const db = {
    prepare(sql) {
      prepares += 1;
      if (prepares > 1) throw new TypeError('kolom rahasia nip=199001012020011001');
      return env.DB.prepare(sql);
    },
    batch: (stmts) => env.DB.batch(stmts),
  };
  const { result: res, logged } = await captureConsoleError(() => callApi({ ...env, DB: db }, '/api/users', { cookie: adminToken }));
  // users.list membungkus error query dengan fromD1Error → DATA_WRITE_FAILED (502) tanpa teks mentah.
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'data_write_failed');
  assert.equal(res.text.includes('rahasia'), false);
  assert.equal(res.text.includes('199001012020011001'), false);
  assert.equal(res.text.includes('stack'), false);
  assert.equal(res.setCookie, null);
  assert.deepEqual(logged, [['SIPSID API error', { action: 'users.list', code: 'DATA_WRITE_FAILED' }]]);
});

test('dispatch tidak pernah melempar walau binding DB tidak ada', async () => {
  const { result, logged } = await captureConsoleError(() => dispatch('letters.list', { sessionToken: 'A'.repeat(43) }));
  assert.equal(result.status, 'error');
  assert.equal(typeof result.errorCode, 'string');
  assert.equal(result.errorMsg.includes('binding'), false);
  assert.equal(logged.length, 1);
});

// ─── Golden envelopes 13 action lewat gateway ───────────────────────────────

test('golden: auth.login, auth.session, auth.logout', async () => {
  const { env } = await setupApi();
  const login = await api(env, '/api/auth/login', { method: 'POST', body: { username: 'admin1', password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body, {
    ok: true,
    data: { user: { username: 'admin1', namaLengkap: 'Admin Satu', hakAkses: 'admin' } },
    error: null,
    backendVersion: '3.0.0',
  });
  const token = /^sipsid_session=([^;]+);/.exec(login.setCookie)[1];
  assert.match(login.setCookie, /; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
  assert.equal(login.text.includes(token), false);
  assert.equal(login.text.includes('expiresIn'), false);

  const session = await api(env, '/api/auth/session', { cookie: token });
  assert.equal(session.status, 200);
  assert.equal(session.setCookie, null);
  assert.deepEqual(session.body, {
    ok: true,
    data: { user: { username: 'admin1', namaLengkap: 'Admin Satu', hakAkses: 'admin' } },
    error: null,
    backendVersion: '3.0.0',
  });

  const logout = await api(env, '/api/auth/logout', { method: 'POST', body: {}, cookie: token });
  assert.equal(logout.status, 200);
  assert.equal(logout.setCookie, clearSessionCookie());
  assert.deepEqual(logout.body, { ok: true, data: {}, error: null, backendVersion: '3.0.0' });

  const restored = await api(env, '/api/auth/session', { cookie: token });
  assert.equal(restored.status, 401);
  assert.equal(restored.setCookie, clearSessionCookie());
  assert.deepEqual(restored.body, {
    ok: false,
    data: null,
    error: { code: 'auth_required', message: 'Sesi tidak valid. Silakan login kembali.' },
    backendVersion: '3.0.0',
  });
});

test('golden: login gagal dan throttle → 400 invalid_credentials dengan pesan identik', async () => {
  const { env } = await setupApi();
  const bodies = [];
  for (let i = 0; i < THROTTLE_MAX_ATTEMPTS; i += 1) {
    const res = await api(env, '/api/auth/login', { method: 'POST', body: { username: 'peng1', password: 'salah-salah' } });
    assert.equal(res.status, 400);
    bodies.push(res.body);
  }
  // Percobaan berikutnya ditolak throttle walau password benar; respons tetap identik.
  const throttled = await api(env, '/api/auth/login', { method: 'POST', body: { username: 'Peng1', password: PASSWORD } });
  assert.equal(throttled.status, 400);
  assert.equal(throttled.setCookie, null);
  bodies.push(throttled.body);
  const unknown = await api(env, '/api/auth/login', { method: 'POST', body: { username: 'tidak-ada', password: 'x' } });
  bodies.push(unknown.body);
  const empty = await api(env, '/api/auth/login', { method: 'POST', body: {} });
  bodies.push(empty.body);
  for (const body of bodies) {
    assert.deepEqual(body, { ok: false, data: null, error: INVALID_CREDENTIALS, backendVersion: '3.0.0' });
  }
});

test('golden: bootstrap.get', async () => {
  const { env } = await setupApi();
  const res = await api(env, '/api/bootstrap');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    data: {
      gajiPNS: [
        { mkg: 0, pangkat: 'Penata Muda (III/a)', nominal: '2785700' },
        { mkg: 2, pangkat: 'Penata Muda (III/a)', nominal: '2873500' },
      ],
      gajiPPPK: [{ mkg: 0, pangkat: 'IX', nominal: '3203600' }],
    },
    error: null,
    backendVersion: '3.0.0',
  });
});

test('golden: letters.list / create / replay / update / delete', async () => {
  const { env, pengToken, adminToken } = await setupApi();
  const empty = await api(env, '/api/letters', { cookie: pengToken });
  assert.deepEqual(empty.body, { ok: true, data: [], error: null, backendVersion: '3.0.0' });

  const input = letterPayload({ requestId: REQUEST_ID, id: 'DIABAIKAN' });
  const created = await api(env, '/api/letters', { method: 'POST', cookie: pengToken, body: input });
  assert.equal(created.status, 200);
  const id = created.body.data.id;
  assert.match(id, LETTER_ID_RE);
  const expectedLetter = { ...letterPayload(), id };
  assert.deepEqual(created.body, { ok: true, data: expectedLetter, error: null, backendVersion: '3.0.0' });

  const replay = await api(env, '/api/letters', { method: 'POST', cookie: pengToken, body: input });
  assert.deepEqual(replay.body, { ok: true, data: expectedLetter, error: null, backendVersion: '3.0.0', idempotent: true });

  const list = await api(env, '/api/letters', { cookie: pengToken });
  assert.deepEqual(list.body, { ok: true, data: [expectedLetter], error: null, backendVersion: '3.0.0' });

  const updated = await api(env, `/api/letters/${encodeURIComponent(id)}`, {
    method: 'PUT',
    cookie: pengToken,
    body: letterPayload({ nama: 'Nama Diubah', kabkot: '', gajiBaru: '4123400' }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, {
    ok: true,
    data: { ...expectedLetter, nama: 'Nama Diubah', kabkot: '', gajiBaru: 'Rp. 4.123.400,-' },
    error: null,
    backendVersion: '3.0.0',
  });

  const forbidden = await api(env, `/api/letters/${encodeURIComponent(id)}`, { method: 'DELETE', cookie: pengToken });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.setCookie, null);
  assert.deepEqual(forbidden.body, {
    ok: false,
    data: null,
    error: { code: 'forbidden', message: 'Hanya administrator yang dapat menghapus arsip.' },
    backendVersion: '3.0.0',
  });

  const deleted = await api(env, `/api/letters/${encodeURIComponent(id)}`, { method: 'DELETE', cookie: adminToken });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { ok: true, data: { id }, error: null, backendVersion: '3.0.0' });

  const missing = await api(env, `/api/letters/${encodeURIComponent(id)}`, { method: 'DELETE', cookie: adminToken });
  assert.equal(missing.status, 404);
  assert.equal(missing.setCookie, null);
  assert.deepEqual(missing.body, {
    ok: false,
    data: null,
    error: { code: 'not_found', message: 'Data surat tidak ditemukan.' },
    backendVersion: '3.0.0',
  });

  const invalidId = await api(env, '/api/letters/bad%3Cid%3E', { method: 'PUT', cookie: pengToken, body: letterPayload() });
  assert.equal(invalidId.status, 400);
  assert.deepEqual(invalidId.body.error, { code: 'validation_error', message: 'ID surat tidak valid.' });
});

test('golden: users.list / create / update / resetPassword / delete', async () => {
  const { env, adminToken } = await setupApi();
  const list = await api(env, '/api/users', { cookie: adminToken });
  assert.deepEqual(list.body, {
    ok: true,
    data: [
      { username: 'admin1', namaLengkap: 'Admin Satu', hakAkses: 'admin' },
      { username: 'peng1', namaLengkap: 'Pengelola Satu', hakAkses: 'pengelola' },
    ],
    error: null,
    backendVersion: '3.0.0',
  });

  const created = await api(env, '/api/users', {
    method: 'POST',
    cookie: adminToken,
    body: { username: 'staf.baru', password: 'password-awal', namaLengkap: 'Staf Baru', hakAkses: 'Administrator' },
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body, {
    ok: true,
    data: { username: 'staf.baru', namaLengkap: 'Staf Baru', hakAkses: 'admin' },
    error: null,
    backendVersion: '3.0.0',
  });

  const duplicate = await api(env, '/api/users', {
    method: 'POST',
    cookie: adminToken,
    body: { username: 'STAF.BARU', password: 'password-awal', namaLengkap: 'X', hakAkses: 'pengelola' },
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.body, {
    ok: false,
    data: null,
    error: { code: 'duplicate_user', message: "Username 'STAF.BARU' sudah terdaftar." },
    backendVersion: '3.0.0',
  });

  const updated = await api(env, '/api/users/staf.baru', {
    method: 'PUT',
    cookie: adminToken,
    body: { namaLengkap: 'Staf Diubah', hakAkses: 'pengelola' },
  });
  assert.deepEqual(updated.body, {
    ok: true,
    data: { username: 'staf.baru', namaLengkap: 'Staf Diubah', hakAkses: 'pengelola' },
    error: null,
    backendVersion: '3.0.0',
  });

  const reset = await api(env, '/api/users/staf.baru/password', {
    method: 'PUT',
    cookie: adminToken,
    body: { newPassword: 'password-baru-2' },
  });
  assert.deepEqual(reset.body, { ok: true, data: { username: 'staf.baru' }, error: null, backendVersion: '3.0.0' });

  const lastAdmin = await api(env, '/api/users/admin1', {
    method: 'PUT',
    cookie: adminToken,
    body: { namaLengkap: 'Admin Satu', hakAkses: 'pengelola' },
  });
  assert.equal(lastAdmin.status, 422);
  assert.equal(lastAdmin.setCookie, null);
  assert.deepEqual(lastAdmin.body, {
    ok: false,
    data: null,
    error: { code: 'last_admin_protected', message: 'Tidak dapat menurunkan hak akses admin terakhir.' },
    backendVersion: '3.0.0',
  });

  const selfDelete = await api(env, '/api/users/ADMIN1', { method: 'DELETE', cookie: adminToken });
  assert.equal(selfDelete.status, 403);
  assert.equal(selfDelete.setCookie, null);
  assert.deepEqual(selfDelete.body.error, { code: 'forbidden', message: 'Tidak dapat menghapus akun yang sedang digunakan.' });

  const deleted = await api(env, '/api/users/staf.baru', { method: 'DELETE', cookie: adminToken });
  assert.deepEqual(deleted.body, { ok: true, data: { username: 'staf.baru' }, error: null, backendVersion: '3.0.0' });

  const ghost = await api(env, '/api/users/staf.baru', { method: 'DELETE', cookie: adminToken });
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.body.error, { code: 'not_found', message: "Pengguna 'staf.baru' tidak ditemukan." });
});

test('golden: sesi basi setelah perubahan role → 401 auth_required dan cookie dihapus', async () => {
  const { env, db, adminToken } = await setupApi();
  const pengToken = await tokenFor(db, 2);
  const promote = await api(env, '/api/users/peng1', {
    method: 'PUT',
    cookie: adminToken,
    body: { namaLengkap: 'Pengelola Satu', hakAkses: 'admin' },
  });
  assert.equal(promote.status, 200);
  const stale = await api(env, '/api/letters', { cookie: pengToken });
  assert.equal(stale.status, 401);
  assert.equal(stale.setCookie, clearSessionCookie());
  assert.deepEqual(stale.body.error, { code: 'auth_required', message: 'Sesi tidak lagi valid. Silakan login kembali.' });
});

test('deep scan: tidak ada password_hash, hash, atau token di envelope mana pun', () => {
  assert.ok(seenEnvelopes.length >= 40, `envelope diperiksa: ${seenEnvelopes.length}`);
  for (const { path, text, body } of seenEnvelopes) {
    assert.equal(findSensitiveKey(body), null, path);
    assert.equal(/sha256\$|pbkdf2_sha256\$/.test(text), false, `${path}: hash password bocor`);
    assert.equal(/"[A-Za-z0-9_-]{43}"/.test(text), false, `${path}: token sesi bocor`);
    assert.equal(text.includes(PASSWORD), false, `${path}: password bocor`);
    assert.equal(body.backendVersion, '3.0.0', path);
    assert.equal(Object.hasOwn(body, 'gasBackendVersion'), false, path);
  }
});
