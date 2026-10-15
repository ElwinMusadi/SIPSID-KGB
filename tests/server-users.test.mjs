// Test domain manajemen pengguna D1 (src/server/users.js) terhadap node:sqlite
// (tests/helpers/d1-sqlite.mjs). Data sintetis saja.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/d1-sqlite.mjs';
import { createSession, hashPassword, requireSession, verifyPassword } from '../src/server/auth.js';
import { D1_ERROR_MESSAGES } from '../src/server/errors.js';
import {
  createUser,
  deleteUser,
  listUsers,
  normalizeHakAkses,
  resetPassword,
  updateUser,
  validateUsername,
  validateUsernameTarget,
} from '../src/server/users.js';

const ENV = Object.freeze({ PASSWORD_PEPPER: 'pepper-uji-sintetis' });
const SEED_PASSWORD = 'rahasia-awal-1';
const SEED_HASH = await hashPassword(SEED_PASSWORD, ENV);
const LEGACY = 'Nama Dengan Spasi';

const MSG = {
  forbiddenAdmin: 'Hanya administrator yang dapat mengelola pengguna.',
  invalidUsername:
    'Username tidak valid. Gunakan huruf, angka, titik, underscore, atau strip (mulai dengan huruf/angka, maks 64 karakter).',
  invalidTarget: 'Username target tidak valid.',
  namaRequired: 'Nama lengkap wajib diisi.',
  invalidRole: 'Hak akses tidak valid. Nilai yang diterima: admin, pengelola.',
  tooShort: 'Password minimal 8 karakter.',
  tooLong: 'Password terlalu panjang (maks 200 karakter).',
  lastAdminDemote: 'Tidak dapat menurunkan hak akses admin terakhir.',
  lastAdminDelete: 'Tidak dapat menghapus admin terakhir.',
  selfDemote: 'Tidak dapat menurunkan hak akses diri sendiri.',
  selfDelete: 'Tidak dapat menghapus akun yang sedang digunakan.',
  accountNotFound: 'Akun tidak ditemukan. Silakan login kembali.',
  sessionStale: 'Sesi tidak lagi valid. Silakan login kembali.',
  sessionInvalid: 'Sesi tidak valid. Silakan login kembali.',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function insertUser(db, id, username, role, nama = `Nama ${username}`) {
  db.sqlite
    .prepare('INSERT INTO users (id, username, password_hash, nama_lengkap, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, SEED_HASH, nama, role);
}

/** admin1 (id 1, admin), peng1 (id 2), legacy "Nama Dengan Spasi" (id 3). */
async function setup({ secondAdmin = false } = {}) {
  const db = createTestDb();
  insertUser(db, 1, 'admin1', 'admin', 'Admin Satu');
  insertUser(db, 2, 'peng1', 'pengelola', 'Pengelola Satu');
  insertUser(db, 3, LEGACY, 'pengelola', 'Pengguna Lama');
  if (secondAdmin) insertUser(db, 4, 'admin2', 'admin', 'Admin Dua');
  const { session: admin, token: adminToken } = await loginAs(db, 1, { admin: true });
  return { db, admin, adminToken };
}

async function loginAs(db, userId, options = {}) {
  const user = db.sqlite.prepare('SELECT id, session_version FROM users WHERE id = ?').get(userId);
  const { token } = await createSession(db, user);
  const session = await requireSession(db, token, options);
  return { token, session };
}

function row(db, id) {
  return db.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function snapshot(db) {
  return JSON.stringify({
    users: db.sqlite.prepare('SELECT * FROM users ORDER BY id').all(),
    sessions: db.sqlite.prepare('SELECT * FROM sessions ORDER BY token_hash').all(),
  });
}

function sessionCount(db, userId) {
  return db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n;
}

/** Proxy penghitung query D1 (prepare + batch). */
function counting(db) {
  const counter = { count: 0 };
  const proxy = {
    prepare(sql) {
      counter.count += 1;
      return db.prepare(sql);
    },
    batch(stmts) {
      counter.count += stmts.length;
      return db.batch(stmts);
    },
  };
  return { proxy, counter };
}

/** Proxy yang melempar error D1 untuk SQL yang cocok `match`. */
function failing(db, message, match = /./) {
  return {
    prepare(sql) {
      if (!match.test(sql)) return db.prepare(sql);
      const fail = async () => {
        throw new Error(message, { cause: new Error(message.replace(/^D1_ERROR: /, '')) });
      };
      const stmt = { bind: () => stmt, all: fail, first: fail, run: fail, raw: fail };
      return stmt;
    },
  };
}

const err = (code, message) => (error) => {
  assert.equal(error.code, code);
  if (message !== undefined) assert.equal(error.message, message);
  return true;
};

/** Deep scan: hasil tidak pernah memuat hash/kolom password. */
function assertNoSecrets(value) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /password|sha256\$|pbkdf2|session_version/i);
}

// ─── Validator (port Code.js) ───────────────────────────────────────────────

test('normalizeHakAkses: administrator → admin, case/spasi diabaikan, lainnya null', () => {
  assert.equal(normalizeHakAkses('administrator'), 'admin');
  assert.equal(normalizeHakAkses(' ADMIN '), 'admin');
  assert.equal(normalizeHakAkses('Pengelola'), 'pengelola');
  for (const value of ['', null, undefined, 'operator', 'admins', 'root']) {
    assert.equal(normalizeHakAkses(value), null, String(value));
  }
});

test('validateUsername (create) ketat; validateUsernameTarget permisif untuk username lama', () => {
  assert.equal(validateUsername('  user.Satu_2-x  '), 'user.Satu_2-x');
  assert.equal(validateUsername('a'.repeat(64)), 'a'.repeat(64));
  for (const value of ['', '   ', '.awal', '_awal', '-awal', 'pakai spasi', 'tanda@at', 'a'.repeat(65), 'ä']) {
    assert.equal(validateUsername(value), null, value);
  }
  assert.equal(validateUsernameTarget(`  ${LEGACY} `), LEGACY);
  assert.equal(validateUsernameTarget('a'.repeat(100)), 'a'.repeat(100));
  for (const value of ['', '  ', 'a'.repeat(101), 'tab\tdi', 'baris\nbaru', 'nul\u0000']) {
    assert.equal(validateUsernameTarget(value), null, JSON.stringify(value));
  }
});

// ─── users.list ─────────────────────────────────────────────────────────────

test('listUsers: urutan id, bentuk {username,namaLengkap,hakAkses}, tanpa hash, 1 query', async () => {
  const { db, admin } = await setup();
  const { proxy, counter } = counting(db);
  const result = await listUsers(proxy, ENV, admin);
  assert.equal(counter.count, 1);
  assert.deepEqual(result, {
    status: 'success',
    data: [
      { username: 'admin1', namaLengkap: 'Admin Satu', hakAkses: 'admin' },
      { username: 'peng1', namaLengkap: 'Pengelola Satu', hakAkses: 'pengelola' },
      { username: LEGACY, namaLengkap: 'Pengguna Lama', hakAkses: 'pengelola' },
    ],
  });
  assertNoSecrets(result);
});

test('semua action: sesi non-admin → FORBIDDEN, sesi rusak → AUTH_REQUIRED, tanpa query', async () => {
  const { db } = await setup();
  const { session: peng } = await loginAs(db, 2);
  const { proxy, counter } = counting(db);
  const calls = (session) => [
    () => listUsers(proxy, ENV, session),
    () => createUser(proxy, ENV, session, { username: 'baru', namaLengkap: 'Baru', hakAkses: 'pengelola', password: 'password-baru' }),
    () => updateUser(proxy, ENV, session, 'peng1', { namaLengkap: 'X', hakAkses: 'pengelola' }),
    () => resetPassword(proxy, ENV, session, 'peng1', { newPassword: 'password-baru' }),
    () => deleteUser(proxy, ENV, session, 'peng1'),
  ];
  const before = snapshot(db);
  for (const call of calls(peng)) await assert.rejects(call, err('FORBIDDEN', MSG.forbiddenAdmin));
  for (const bad of [null, {}, { userId: 1, username: 'admin1', hakAkses: 'admin' }]) {
    for (const call of calls(bad)) await assert.rejects(call, err('AUTH_REQUIRED', MSG.sessionInvalid));
  }
  assert.equal(counter.count, 0);
  assert.equal(snapshot(db), before);
});

// ─── users.create ───────────────────────────────────────────────────────────

test('createUser: sukses, normalisasi role, hash sha256$ terverifikasi, 1 query', async () => {
  const { db, admin } = await setup();
  const { proxy, counter } = counting(db);
  const result = await createUser(proxy, ENV, admin, {
    username: '  Operator.Baru  ',
    namaLengkap: '  Operator Baru  ',
    hakAkses: 'Administrator',
    password: 'password-baru-1',
  });
  assert.equal(counter.count, 1);
  assert.deepEqual(result, {
    status: 'success',
    data: { username: 'Operator.Baru', namaLengkap: 'Operator Baru', hakAkses: 'admin' },
  });
  assertNoSecrets(result);
  const stored = db.sqlite.prepare("SELECT * FROM users WHERE username = 'operator.baru'").get();
  assert.equal(stored.role, 'admin');
  assert.equal(stored.session_version, 1);
  assert.match(stored.password_hash, /^sha256\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword('password-baru-1', stored.password_hash, ENV), true);
  assert.equal(await verifyPassword('salah-password', stored.password_hash, ENV), false);
  const list = await listUsers(db, ENV, admin);
  assert.equal(list.data.at(-1).username, 'Operator.Baru');
});

test('createUser: pesan validasi dan urutan cek identik Code.js', async () => {
  const { db, admin } = await setup();
  const base = { username: 'baru', namaLengkap: 'Baru', hakAkses: 'pengelola', password: 'password-baru' };
  const cases = [
    [{ ...base, username: 'pakai spasi', namaLengkap: '' }, MSG.invalidUsername],
    [{ ...base, username: '.awal' }, MSG.invalidUsername],
    [{ ...base, username: 'a'.repeat(65) }, MSG.invalidUsername],
    [{ ...base, username: undefined }, MSG.invalidUsername],
    [{ ...base, namaLengkap: '   ', hakAkses: 'x' }, MSG.namaRequired],
    [{ ...base, hakAkses: 'operator', password: '' }, MSG.invalidRole],
    [{ ...base, hakAkses: '' }, MSG.invalidRole],
    [{ ...base, password: '1234567' }, MSG.tooShort],
    [{ ...base, password: undefined }, MSG.tooShort],
    [{ ...base, password: 'x'.repeat(201) }, MSG.tooLong],
  ];
  const before = snapshot(db);
  for (const [payload, message] of cases) {
    await assert.rejects(createUser(db, ENV, admin, payload), err('VALIDATION_ERROR', message), message);
  }
  await assert.rejects(createUser(db, ENV, admin, null), err('VALIDATION_ERROR', MSG.invalidUsername));
  await assert.rejects(createUser(db, {}, admin, base), err('CONFIG_ERROR', 'PASSWORD_PEPPER belum dikonfigurasi.'));
  assert.equal(snapshot(db), before);
  // Batas tepat diterima: password 8 dan 200 karakter, username 64 karakter.
  await createUser(db, ENV, admin, { ...base, username: 'a'.repeat(64), password: '12345678' });
  await createUser(db, ENV, admin, { ...base, username: 'p200', password: 'x'.repeat(200) });
});

test('createUser: DUPLICATE_USER case-insensitive (NOCASE), pesan memakai username input', async () => {
  const { db, admin } = await setup();
  const { proxy, counter } = counting(db);
  const before = snapshot(db);
  await assert.rejects(
    createUser(proxy, ENV, admin, { username: 'ADMIN1', namaLengkap: 'X', hakAkses: 'admin', password: 'password-baru' }),
    err('DUPLICATE_USER', "Username 'ADMIN1' sudah terdaftar."),
  );
  await assert.rejects(
    createUser(proxy, ENV, admin, { username: 'Peng1', namaLengkap: 'X', hakAkses: 'pengelola', password: 'password-baru' }),
    err('DUPLICATE_USER', "Username 'Peng1' sudah terdaftar."),
  );
  assert.equal(counter.count, 2);
  assert.equal(snapshot(db), before);
});

// ─── users.update ───────────────────────────────────────────────────────────

test('updateUser: ubah nama saja tidak mencabut sesi; version naik; 1 query', async () => {
  const { db, admin } = await setup();
  const { token: pengToken } = await loginAs(db, 2);
  const { proxy, counter } = counting(db);
  const result = await updateUser(proxy, ENV, admin, 'PENG1', { namaLengkap: '  Nama Baru  ', hakAkses: 'pengelola' });
  assert.equal(counter.count, 1);
  assert.deepEqual(result, { status: 'success', data: { username: 'peng1', namaLengkap: 'Nama Baru', hakAkses: 'pengelola' } });
  assertNoSecrets(result);
  const stored = row(db, 2);
  assert.equal(stored.session_version, 1);
  assert.equal(stored.version, 2);
  assert.equal((await requireSession(db, pengToken)).namaLengkap, 'Nama Baru');
});

test('updateUser: perubahan role menaikkan session_version sehingga sesi user target gagal', async () => {
  const { db, admin } = await setup();
  const { token: pengToken } = await loginAs(db, 2);
  const result = await updateUser(db, ENV, admin, 'peng1', { namaLengkap: 'Pengelola Satu', hakAkses: 'administrator' });
  assert.equal(result.data.hakAkses, 'admin');
  assert.equal(row(db, 2).role, 'admin');
  assert.equal(row(db, 2).session_version, 2);
  await assert.rejects(requireSession(db, pengToken), err('AUTH_REQUIRED', MSG.sessionStale));
  // Demote admin lain (masih ada 2 admin) juga mencabut sesinya.
  const { token: newAdminToken } = await loginAs(db, 2, { admin: true });
  await updateUser(db, ENV, admin, 'peng1', { namaLengkap: 'Pengelola Satu', hakAkses: 'pengelola' });
  assert.equal(row(db, 2).session_version, 3);
  await assert.rejects(requireSession(db, newAdminToken), err('AUTH_REQUIRED', MSG.sessionStale));
});

test('updateUser: promosi pengelola → admin menaikkan session_version dan membatalkan SEMUA sesi target', async () => {
  const { db, admin, adminToken } = await setup();
  const { token: tokenA } = await loginAs(db, 2);
  const { token: tokenB } = await loginAs(db, 2);
  const { token: otherToken } = await loginAs(db, 3);
  assert.equal(row(db, 2).session_version, 1);

  const { proxy, counter } = counting(db);
  const result = await updateUser(proxy, ENV, admin, 'peng1', { namaLengkap: 'Pengelola Satu', hakAkses: 'admin' });
  assert.equal(counter.count, 1);
  assert.deepEqual(result, { status: 'success', data: { username: 'peng1', namaLengkap: 'Pengelola Satu', hakAkses: 'admin' } });
  assert.equal(row(db, 2).role, 'admin');
  assert.equal(row(db, 2).session_version, 2);

  // Sesi lama target tidak boleh naik menjadi admin: basi untuk akses biasa maupun admin.
  for (const token of [tokenA, tokenB]) {
    await assert.rejects(requireSession(db, token), err('AUTH_REQUIRED', MSG.sessionStale));
    await assert.rejects(requireSession(db, token, { admin: true }), err('AUTH_REQUIRED', MSG.sessionStale));
  }
  // Sesi user lain dan sesi actor tidak terpengaruh.
  assert.equal((await requireSession(db, otherToken)).username, LEGACY);
  assert.equal((await requireSession(db, adminToken, { admin: true })).username, 'admin1');
  // Login ulang menghasilkan sesi admin yang valid.
  const { session } = await loginAs(db, 2, { admin: true });
  assert.equal(session.hakAkses, 'admin');
  assert.equal(session.sessionVersion, 2);
});

test('updateUser: target username lama dengan spasi diterima; validasi dan NOT_FOUND identik Code.js', async () => {
  const { db, admin } = await setup();
  const ok = await updateUser(db, ENV, admin, ` ${LEGACY.toLowerCase()} `, { namaLengkap: 'Lama', hakAkses: 'pengelola' });
  assert.equal(ok.data.username, LEGACY);

  const before = snapshot(db);
  const cases = [
    ['', { namaLengkap: '', hakAkses: 'x' }, MSG.invalidTarget],
    ['a'.repeat(101), { namaLengkap: 'X', hakAkses: 'admin' }, MSG.invalidTarget],
    ['tab\tdi', { namaLengkap: 'X', hakAkses: 'admin' }, MSG.invalidTarget],
    ['peng1', { namaLengkap: '  ', hakAkses: 'x' }, MSG.namaRequired],
    ['peng1', { namaLengkap: 'X', hakAkses: 'operator' }, MSG.invalidRole],
    ['peng1', null, MSG.namaRequired],
  ];
  for (const [target, payload, message] of cases) {
    await assert.rejects(updateUser(db, ENV, admin, target, payload), err('VALIDATION_ERROR', message), message);
  }
  const { proxy, counter } = counting(db);
  await assert.rejects(
    updateUser(proxy, ENV, admin, 'tidak.ada', { namaLengkap: 'X', hakAkses: 'pengelola' }),
    err('NOT_FOUND', "Pengguna 'tidak.ada' tidak ditemukan."),
  );
  assert.equal(counter.count, 2);
  assert.equal(snapshot(db), before);
});

test('updateUser: admin tunggal menurunkan diri sendiri → LAST_ADMIN_PROTECTED (sebelum self-demote)', async () => {
  const { db, admin } = await setup();
  const before = snapshot(db);
  await assert.rejects(
    updateUser(db, ENV, admin, 'ADMIN1', { namaLengkap: 'Admin Satu', hakAkses: 'pengelola' }),
    err('LAST_ADMIN_PROTECTED', MSG.lastAdminDemote),
  );
  assert.equal(snapshot(db), before);
  // Ubah nama diri sendiri tanpa ubah role tetap boleh.
  const ok = await updateUser(db, ENV, admin, 'admin1', { namaLengkap: 'Admin Baru', hakAkses: 'admin' });
  assert.equal(ok.data.namaLengkap, 'Admin Baru');
  assert.equal(row(db, 1).session_version, 1);
});

test('updateUser: dua admin, menurunkan diri sendiri → FORBIDDEN; menurunkan admin lain → sukses', async () => {
  const { db, admin } = await setup({ secondAdmin: true });
  const before = snapshot(db);
  await assert.rejects(
    updateUser(db, ENV, admin, 'Admin1', { namaLengkap: 'Admin Satu', hakAkses: 'pengelola' }),
    err('FORBIDDEN', MSG.selfDemote),
  );
  assert.equal(snapshot(db), before);
  const ok = await updateUser(db, ENV, admin, 'admin2', { namaLengkap: 'Admin Dua', hakAkses: 'pengelola' });
  assert.equal(ok.data.hakAkses, 'pengelola');
});

// ─── users.resetPassword ────────────────────────────────────────────────────

test('resetPassword: field newPassword, mencabut sesi target, password baru terverifikasi, 1 query', async () => {
  const { db, admin } = await setup();
  const { token: pengToken } = await loginAs(db, 2);
  const { proxy, counter } = counting(db);
  const result = await resetPassword(proxy, ENV, admin, 'PENG1', { newPassword: 'password-reset-1' });
  assert.equal(counter.count, 1);
  assert.deepEqual(result, { status: 'success', username: 'peng1' });
  assertNoSecrets(result);
  const stored = row(db, 2);
  assert.equal(stored.session_version, 2);
  assert.equal(await verifyPassword('password-reset-1', stored.password_hash, ENV), true);
  assert.equal(await verifyPassword(SEED_PASSWORD, stored.password_hash, ENV), false);
  await assert.rejects(requireSession(db, pengToken), err('AUTH_REQUIRED', MSG.sessionStale));
  // Sesi admin pelaku tidak terpengaruh.
  assert.equal((await resetPassword(db, ENV, admin, LEGACY, { newPassword: 'password-reset-2' })).username, LEGACY);
});

test('resetPassword: pesan validasi, NOT_FOUND, dan field `password` tidak dipakai', async () => {
  const { db, admin } = await setup();
  const before = snapshot(db);
  const cases = [
    ['', { newPassword: '' }, 'VALIDATION_ERROR', MSG.invalidTarget],
    ['nul\u0000', { newPassword: 'password-baru' }, 'VALIDATION_ERROR', MSG.invalidTarget],
    ['peng1', { password: 'password-baru' }, 'VALIDATION_ERROR', MSG.tooShort],
    ['peng1', { newPassword: '1234567' }, 'VALIDATION_ERROR', MSG.tooShort],
    ['peng1', { newPassword: 'x'.repeat(201) }, 'VALIDATION_ERROR', MSG.tooLong],
    ['peng1', null, 'VALIDATION_ERROR', MSG.tooShort],
    ['tidak ada', { newPassword: 'password-baru' }, 'NOT_FOUND', "Pengguna 'tidak ada' tidak ditemukan."],
  ];
  for (const [target, payload, code, message] of cases) {
    await assert.rejects(resetPassword(db, ENV, admin, target, payload), err(code, message), message);
  }
  await assert.rejects(
    resetPassword(db, {}, admin, 'peng1', { newPassword: 'password-baru' }),
    err('CONFIG_ERROR', 'PASSWORD_PEPPER belum dikonfigurasi.'),
  );
  assert.equal(snapshot(db), before);
});

// ─── users.delete ───────────────────────────────────────────────────────────

test('deleteUser: sukses, sesi target ikut terhapus (CASCADE), 1 query', async () => {
  const { db, admin } = await setup();
  const { token: pengToken } = await loginAs(db, 2);
  await loginAs(db, 2);
  assert.equal(sessionCount(db, 2), 2);
  const { proxy, counter } = counting(db);
  const result = await deleteUser(proxy, ENV, admin, ' PENG1 ');
  assert.equal(counter.count, 1);
  assert.deepEqual(result, { status: 'success', username: 'peng1' });
  assert.equal(row(db, 2), undefined);
  assert.equal(sessionCount(db, 2), 0);
  await assert.rejects(requireSession(db, pengToken), err('AUTH_REQUIRED', MSG.sessionInvalid));
  assert.equal((await deleteUser(db, ENV, admin, LEGACY)).username, LEGACY);
});

test('deleteUser: hapus diri sendiri → FORBIDDEN tanpa query, juga saat admin terakhir dan beda huruf', async () => {
  const { db, admin } = await setup();
  const { proxy, counter } = counting(db);
  const before = snapshot(db);
  for (const target of ['admin1', 'ADMIN1', ' Admin1 ']) {
    await assert.rejects(deleteUser(proxy, ENV, admin, target), err('FORBIDDEN', MSG.selfDelete));
  }
  // Self-delete didahulukan bahkan atas actor stale (urutan Code.js: cek sebelum lock/revalidasi).
  db.sqlite.exec('UPDATE users SET session_version = session_version + 1 WHERE id = 1');
  await assert.rejects(deleteUser(proxy, ENV, admin, 'admin1'), err('FORBIDDEN', MSG.selfDelete));
  db.sqlite.exec('UPDATE users SET session_version = session_version - 1 WHERE id = 1');
  assert.equal(counter.count, 0);
  assert.equal(snapshot(db), before);
});

test('deleteUser: validasi target dan NOT_FOUND identik Code.js; admin lain boleh dihapus bila tersisa admin', async () => {
  const { db, admin } = await setup({ secondAdmin: true });
  const before = snapshot(db);
  await assert.rejects(deleteUser(db, ENV, admin, ''), err('VALIDATION_ERROR', MSG.invalidTarget));
  await assert.rejects(deleteUser(db, ENV, admin, 'x'.repeat(101)), err('VALIDATION_ERROR', MSG.invalidTarget));
  const { proxy, counter } = counting(db);
  await assert.rejects(deleteUser(proxy, ENV, admin, 'hantu'), err('NOT_FOUND', "Pengguna 'hantu' tidak ditemukan."));
  assert.equal(counter.count, 2);
  assert.equal(snapshot(db), before);
  assert.deepEqual(await deleteUser(db, ENV, admin, 'admin2'), { status: 'success', username: 'admin2' });
});

test('last admin: trigger D1 dipetakan ke LAST_ADMIN_PROTECTED dengan pesan per action, tanpa teks D1', async () => {
  const { db, admin } = await setup({ secondAdmin: true });
  const trigger = 'D1_ERROR: LAST_ADMIN_PROTECTED: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)';
  await assert.rejects(
    deleteUser(failing(db, trigger, /^DELETE FROM users/), ENV, admin, 'admin2'),
    err('LAST_ADMIN_PROTECTED', MSG.lastAdminDelete),
  );
  await assert.rejects(
    updateUser(failing(db, trigger, /^UPDATE users SET nama_lengkap/), ENV, admin, 'admin2', { namaLengkap: 'X', hakAkses: 'pengelola' }),
    err('LAST_ADMIN_PROTECTED', MSG.lastAdminDemote),
  );
  // Trigger asli (jaring pengaman SQL manual) tetap aktif pada admin tunggal.
  db.sqlite.exec('DELETE FROM users WHERE id = 4');
  assert.throws(() => db.sqlite.exec('DELETE FROM users WHERE id = 1'), /LAST_ADMIN_PROTECTED/);
});

// ─── Actor stale (race antara requireSession dan mutasi) ────────────────────

test('actor stale: session_version berubah / akun dihapus → AUTH_REQUIRED; role diturunkan → FORBIDDEN; tanpa perubahan', async () => {
  const scenarios = [
    ['session_version berubah', (db) => db.sqlite.exec('UPDATE users SET session_version = session_version + 1 WHERE id = 1'), 'AUTH_REQUIRED', MSG.sessionStale],
    ['akun dihapus', (db) => db.sqlite.exec('DELETE FROM users WHERE id = 1'), 'AUTH_REQUIRED', MSG.accountNotFound],
    ['role diturunkan (sv tetap)', (db) => db.sqlite.exec("UPDATE users SET role = 'pengelola' WHERE id = 1"), 'FORBIDDEN', MSG.forbiddenAdmin],
  ];
  const actions = [
    // Duplikat + actor stale: tetap kode actor (guard dievaluasi sebelum constraint).
    ['create (duplikat)', (db, s) => createUser(db, ENV, s, { username: 'PENG1', namaLengkap: 'X', hakAkses: 'pengelola', password: 'password-baru' })],
    ['create', (db, s) => createUser(db, ENV, s, { username: 'baru', namaLengkap: 'X', hakAkses: 'pengelola', password: 'password-baru' })],
    ['update', (db, s) => updateUser(db, ENV, s, 'peng1', { namaLengkap: 'X', hakAkses: 'admin' })],
    ['update (target hilang)', (db, s) => updateUser(db, ENV, s, 'hantu', { namaLengkap: 'X', hakAkses: 'admin' })],
    ['reset', (db, s) => resetPassword(db, ENV, s, 'peng1', { newPassword: 'password-baru' })],
    ['delete', (db, s) => deleteUser(db, ENV, s, 'peng1')],
    ['delete (target hilang)', (db, s) => deleteUser(db, ENV, s, 'hantu')],
  ];
  for (const [label, mutate, code, message] of scenarios) {
    for (const [name, action] of actions) {
      const { db, admin } = await setup({ secondAdmin: true });
      mutate(db);
      const before = snapshot(db);
      const { proxy, counter } = counting(db);
      await assert.rejects(action(proxy, admin), err(code, message), `${label} / ${name}`);
      assert.equal(counter.count, 2, `${label} / ${name}: mutasi + 1 diagnostik`);
      assert.equal(snapshot(db), before, `${label} / ${name}`);
    }
  }
});

// ─── Error D1 ───────────────────────────────────────────────────────────────

test('error D1: transien → DATA_SERVICE_UNAVAILABLE, lainnya → DATA_WRITE_FAILED, tanpa teks mentah', async () => {
  const { db, admin } = await setup({ secondAdmin: true });
  const actions = [
    (p) => listUsers(p, ENV, admin),
    (p) => createUser(p, ENV, admin, { username: 'baru', namaLengkap: 'X', hakAkses: 'pengelola', password: 'password-baru' }),
    (p) => updateUser(p, ENV, admin, 'peng1', { namaLengkap: 'X', hakAkses: 'pengelola' }),
    (p) => resetPassword(p, ENV, admin, 'peng1', { newPassword: 'password-baru' }),
    (p) => deleteUser(p, ENV, admin, 'peng1'),
  ];
  const cases = [
    ['D1_ERROR: Network connection lost.', 'DATA_SERVICE_UNAVAILABLE'],
    ['D1 DB is overloaded. Too many requests queued.', 'DATA_SERVICE_UNAVAILABLE'],
    ['D1_ERROR: no such table: users: SQLITE_ERROR', 'DATA_WRITE_FAILED'],
    ['D1_ERROR: CHECK constraint failed: secret_column_xyz: SQLITE_CONSTRAINT', 'DATA_WRITE_FAILED'],
  ];
  const before = snapshot(db);
  for (const [message, code] of cases) {
    for (const action of actions) {
      await assert.rejects(action(failing(db, message)), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, D1_ERROR_MESSAGES[code]);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, /D1_ERROR|SQLITE|users|secret_column/);
        return true;
      });
    }
  }
  // Gagal di read diagnostik (mutasi 0 baris karena target tidak ada).
  await assert.rejects(
    deleteUser(failing(db, 'D1_ERROR: Network connection lost.', /LEFT JOIN users a/), ENV, admin, 'hantu'),
    err('DATA_SERVICE_UNAVAILABLE', D1_ERROR_MESSAGES.DATA_SERVICE_UNAVAILABLE),
  );
  assert.equal(snapshot(db), before);
});

// ─── Bentuk respons ─────────────────────────────────────────────────────────

test('tidak ada hash/password di respons mana pun (deep scan)', async () => {
  const { db, admin } = await setup({ secondAdmin: true });
  const results = [
    await createUser(db, ENV, admin, { username: 'baru', namaLengkap: 'Baru', hakAkses: 'admin', password: 'password-baru' }),
    await updateUser(db, ENV, admin, 'baru', { namaLengkap: 'Baru 2', hakAkses: 'pengelola' }),
    await resetPassword(db, ENV, admin, 'baru', { newPassword: 'password-baru-2' }),
    await listUsers(db, ENV, admin),
    await deleteUser(db, ENV, admin, 'baru'),
  ];
  for (const result of results) {
    assert.equal(result.status, 'success');
    assertNoSecrets(result);
  }
});
