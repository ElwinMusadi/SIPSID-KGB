import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, splitSqlStatements } from './helpers/d1-sqlite.mjs';
import { all, first, isTriggerError, isUniqueViolation, nowIso, run, statement } from '../src/server/db.js';

const SHA256_HASH = `sha256$${'0'.repeat(32)}$${'a'.repeat(64)}`;
const PBKDF2_HASH = 'pbkdf2_sha256$100000$c2FsdA==$aGFzaA==';
const TS = '2026-10-15T04:30:00.000Z';

const USER_INSERT = `INSERT INTO users (username, password_hash, nama_lengkap, role)
  VALUES (?1, ?2, ?3, ?4) RETURNING *`;

async function addUser(db, username, role = 'pengelola', overrides = {}) {
  return first(
    db,
    USER_INSERT,
    username,
    overrides.password_hash ?? SHA256_HASH,
    overrides.nama_lengkap ?? `Nama ${username}`,
    role,
  );
}

const LETTER_COLUMNS = [
  'id', 'request_id', 'status_pegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'kabkot',
  'sk_pejabat', 'sk_tanggal', 'sk_nomor', 'sk_tmt', 'mk_lama_thn', 'mk_lama_bln', 'gaji_lama',
  'mk_baru_thn', 'mk_baru_bln', 'gaji_baru_tmt', 'gaji_baru', 'surat_nomor', 'surat_tanggal',
  'sign_jabatan', 'sign_nama', 'sign_pangkat', 'sign_nip', 'ukuran_kertas', 'created_by', 'updated_by',
  'seq', 'created_at', 'updated_at',
];

let letterCounter = 0;
function letter(overrides = {}) {
  letterCounter += 1;
  return {
    id: `KGB-2026-l${letterCounter}`,
    request_id: `l${letterCounter}`,
    status_pegawai: 'PNS',
    nama: 'Budi',
    nip: '198001012005011001',
    pangkat: 'Penata (III/c)',
    jabatan: 'Analis',
    unit: 'Dinas',
    kabkot: 'Kota Mataram',
    sk_pejabat: 'Kepala Dinas',
    sk_tanggal: '2024-02-29',
    sk_nomor: '800/1',
    sk_tmt: '2024-03-01',
    mk_lama_thn: 10,
    mk_lama_bln: 0,
    gaji_lama: 3000000,
    mk_baru_thn: 12,
    mk_baru_bln: 0,
    gaji_baru_tmt: '2026-03-01',
    gaji_baru: 3200000,
    surat_nomor: '800/2',
    surat_tanggal: '2026-02-01',
    sign_jabatan: 'Kepala',
    sign_nama: 'Siti',
    sign_pangkat: 'Pembina (IV/a)',
    sign_nip: '197001011995012001',
    ukuran_kertas: 'legal',
    created_by: 'admin',
    updated_by: 'admin',
    seq: letterCounter,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

function insertLetterStatement(db, row) {
  const placeholders = LETTER_COLUMNS.map((_, index) => `?${index + 1}`).join(', ');
  return statement(
    db,
    `INSERT INTO letters (${LETTER_COLUMNS.join(', ')}) VALUES (${placeholders})`,
    ...LETTER_COLUMNS.map((column) => row[column]),
  );
}

async function insertLetter(db, overrides) {
  return insertLetterStatement(db, letter(overrides)).run();
}

const CHECK_FAILED = /D1_ERROR: CHECK constraint failed/;

async function expectCheck(db, overrides, message) {
  await assert.rejects(insertLetter(db, overrides), CHECK_FAILED, message ?? JSON.stringify(overrides));
}

test('migrations apply cleanly with the expected objects', async () => {
  const db = createTestDb();
  assert.deepEqual(db.appliedMigrations.map((m) => m.name), ['0001_initial.sql']);
  // 5 tabel + 9 index + 2 trigger. `wrangler d1 migrations apply --local` melaporkan 17 command
  // karena menambahkan INSERT ke d1_migrations.
  assert.equal(db.appliedMigrations[0].statements, 16);

  const objects = await all(db, "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const byType = (type) => objects.filter((o) => o.type === type).map((o) => o.name);
  assert.deepEqual(byType('table'), ['d1_migrations', 'letters', 'login_throttle', 'salary_grades', 'sessions', 'users']);
  assert.deepEqual(byType('trigger'), ['trg_users_last_admin_delete', 'trg_users_last_admin_demote']);
  assert.deepEqual(byType('index'), [
    'idx_letters_created', 'idx_letters_kabkot_surat', 'idx_letters_nama', 'idx_letters_nip',
    'idx_letters_surat_tanggal', 'idx_login_throttle_expires', 'idx_sessions_expires', 'idx_sessions_user', 'idx_users_role',
  ]);
  for (const table of ['users', 'letters', 'salary_grades', 'login_throttle', 'sessions']) {
    const info = await first(db, 'SELECT strict FROM pragma_table_list WHERE name = ?1', table);
    assert.equal(info.strict, 1, `${table} is STRICT`);
  }
  assert.equal(await first(db, 'PRAGMA foreign_keys').then((r) => r.foreign_keys), 1);
});

test('splitSqlStatements handles triggers, CASE, literals and comments', () => {
  const script = `
    -- comment; with semicolon
    CREATE TABLE t (a TEXT DEFAULT 'x;y', "b;" INTEGER); /* block; comment */
    CREATE TRIGGER tr AFTER INSERT ON t
    WHEN NEW.a <> 'END;'
    BEGIN
      UPDATE t SET a = CASE WHEN a = 'q' THEN 'r' ELSE a END;
      SELECT RAISE(ABORT, 'X;Y');
    END;
    INSERT INTO t VALUES ('it''s;', 1)
  `;
  const statements = splitSqlStatements(script);
  assert.equal(statements.length, 3);
  assert.match(statements[1], /^CREATE TRIGGER tr[\s\S]*END$/);
  assert.match(statements[2], /'it''s;'/);
});

test('migration files contain no explicit transaction control', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    for (const sql of splitSqlStatements(readFileSync(new URL(name, dir), 'utf8'))) {
      assert.doesNotMatch(sql.replace(/^(?:\s*--[^\n]*\n)*/, ''), /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i, name);
    }
  }
});

test('db helpers: nowIso is fixed 24-char UTC and matches SQLite default format', async () => {
  assert.equal(nowIso(Date.UTC(2026, 0, 2, 3, 4, 5, 6)), '2026-01-02T03:04:05.006Z');
  assert.equal(nowIso(new Date(Date.UTC(2026, 0, 1))), '2026-01-01T00:00:00.000Z');
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.throws(() => nowIso(Number.NaN), RangeError);
  assert.throws(() => nowIso(Date.UTC(10000, 0, 1)), RangeError);
  assert.throws(() => nowIso(Date.UTC(-1, 0, 1)), RangeError);

  const db = createTestDb();
  const user = await addUser(db, 'fmt');
  assert.match(user.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(user.created_at.length, 24);
});

test('db helpers: positional parameters only, arity enforced, D1-shaped results', async () => {
  const db = createTestDb();
  assert.deepEqual(await first(db, 'SELECT ?1 AS a, ?2 AS b, ?1 AS c', 1, 'x'), { a: 1, b: 'x', c: 1 });
  assert.equal(await first(db, 'SELECT 1 AS a WHERE 0'), null);
  assert.deepEqual(await all(db, 'SELECT 1 AS a WHERE 0'), []);
  assert.deepEqual(await all(db, "SELECT '?1' AS q, ?1 AS v -- ?2\n", 7), [{ q: '?1', v: 7 }]);

  await assert.rejects(first(db, 'SELECT ?1, ?2', 1), /expects 2 parameter/);
  await assert.rejects(first(db, 'SELECT ?1', 1, 2), /expects 1 parameter/);
  await assert.rejects(first(db, 'SELECT ?', 1), /Only positional parameters/);
  await assert.rejects(first(db, 'SELECT :name', 1), /Only positional parameters/);
  await assert.rejects(first(db, 'SELECT ?101', 1), /out of range/);
  await assert.rejects(first(db, ' '), TypeError);
  await assert.rejects(first(null, 'SELECT 1'), /binding is required/);

  const result = await run(db, USER_INSERT.replace(' RETURNING *', ''), 'meta', SHA256_HASH, 'Meta', 'pengelola');
  assert.equal(result.success, true);
  assert.equal(result.meta.changes, 1);
  assert.equal(typeof result.meta.last_row_id, 'number');
  assert.deepEqual(result.results, []);
  const noop = await run(db, 'UPDATE users SET nama_lengkap = ?1 WHERE username = ?2', 'X', 'missing');
  assert.equal(noop.meta.changes, 0);
});

test('adapter mirrors D1 binding behaviours', async () => {
  const db = createTestDb();
  assert.throws(() => db.prepare('SELECT ?1').bind(undefined), /^Error: D1_TYPE_ERROR/);
  assert.throws(() => db.prepare('SELECT ?1').bind({}), /^Error: D1_TYPE_ERROR/);
  assert.equal(await db.prepare('SELECT ?1 AS v').bind(true).first('v'), 1);
  await assert.rejects(db.prepare('SELECT 1 AS a').first('zz'), /D1_COLUMN_NOTFOUND: Column not found \(zz\)/);
  assert.equal(await db.prepare('SELECT 1 AS a WHERE 0').first('a'), null);
  assert.deepEqual(await db.prepare('SELECT 1 AS a, 2 AS b').raw({ columnNames: true }), [['a', 'b'], [1, 2]]);
  assert.deepEqual(await db.prepare('SELECT 1 AS a WHERE 0').raw(), []);
  await assert.rejects(db.prepare('BEGIN').run(), /D1_ERROR: To execute a transaction/);
  await assert.rejects(db.prepare('SELEC 1').all(), /D1_ERROR: near "SELEC": syntax error/);
  assert.equal((await db.exec('SELECT 1;\nSELECT 2;')).count, 2);
});

test('users: CHECK constraints', async () => {
  const db = createTestDb();
  assert.ok(await addUser(db, 'a'.repeat(100)));
  assert.ok(await addUser(db, 'pb', 'admin', { password_hash: PBKDF2_HASH }));
  assert.ok(await addUser(db, 'sha'));

  const rejects = [
    ['', 'pengelola', {}],
    ['a'.repeat(101), 'pengelola', {}],
    [' lead', 'pengelola', {}],
    ['trail ', 'pengelola', {}],
    ['plain', 'pengelola', { password_hash: 'secret' }],
    ['upper', 'pengelola', { password_hash: `SHA256$${'0'.repeat(32)}$${'a'.repeat(64)}` }],
    ['md5', 'pengelola', { password_hash: 'md5$abc' }],
    ['pbk', 'pengelola', { password_hash: 'pbkdf2$100000$a$b' }],
    ['nonama', 'pengelola', { nama_lengkap: '' }],
    ['longnama', 'pengelola', { nama_lengkap: 'n'.repeat(161) }],
    ['role1', 'administrator', {}],
    ['role2', 'Admin', {}],
    ['role3', '', {}],
  ];
  for (const [username, role, overrides] of rejects) {
    await assert.rejects(addUser(db, username, role, overrides), CHECK_FAILED, `${username}/${role}`);
  }
  await assert.rejects(
    run(db, "INSERT INTO users (username, password_hash, nama_lengkap, session_version) VALUES ('sv', ?1, 'x', 0)", SHA256_HASH),
    CHECK_FAILED,
  );
  await assert.rejects(
    run(db, "INSERT INTO users (username, password_hash, nama_lengkap, version) VALUES ('v', ?1, 'x', 0)", SHA256_HASH),
    CHECK_FAILED,
  );
  await assert.rejects(
    run(db, 'INSERT INTO users (username, password_hash, nama_lengkap) VALUES (NULL, ?1, ?2)', SHA256_HASH, 'x'),
    /NOT NULL constraint failed: users.username/,
  );

  const defaults = await first(db, "INSERT INTO users (username, password_hash, nama_lengkap) VALUES ('d', ?1, 'D') RETURNING *", SHA256_HASH);
  assert.equal(defaults.role, 'pengelola');
  assert.equal(defaults.session_version, 1);
  assert.equal(defaults.version, 1);
});

test('users: username UNIQUE is case-insensitive and lookups use NOCASE', async () => {
  const db = createTestDb();
  await addUser(db, 'Admin', 'admin');
  for (const variant of ['admin', 'ADMIN', 'aDmIn']) {
    const error = await addUser(db, variant).then(() => null, (e) => e);
    assert.ok(error, `${variant} must be rejected`);
    assert.equal(isUniqueViolation(error), true);
    assert.equal(isUniqueViolation(error, 'users.username'), true);
    assert.equal(isUniqueViolation(error, 'letters.id'), false);
    assert.match(error.message, /^D1_ERROR: UNIQUE constraint failed: users\.username: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_UNIQUE\)$/);
  }
  const found = await first(db, 'SELECT username FROM users WHERE username = ?1', 'ADMIN');
  assert.equal(found.username, 'Admin', 'canonical stored username is returned');
});

test('letters: valid row with kabkot NULL and defaults', async () => {
  const db = createTestDb();
  const row = letter({ kabkot: null });
  await insertLetterStatement(db, row).run();
  const stored = await first(db, 'SELECT kabkot, ukuran_kertas, version FROM letters WHERE id = ?1', row.id);
  assert.deepEqual(stored, { kabkot: null, ukuran_kertas: 'legal', version: 1 });

  const minimal = await first(
    db,
    `INSERT INTO letters (id, status_pegawai, nama, nip, pangkat, jabatan, unit, sk_pejabat, sk_tanggal, sk_nomor, sk_tmt,
       mk_lama_thn, mk_lama_bln, gaji_lama, mk_baru_thn, mk_baru_bln, gaji_baru_tmt, gaji_baru, surat_nomor, surat_tanggal,
       sign_jabatan, sign_nama, sign_pangkat, sign_nip, seq)
     VALUES ('M-1', 'PPPK', 'n', 'n', 'p', 'j', 'u', 's', '2026-01-01', 'n', '2026-01-01', 0, 0, 0, 1, 0, '2026-01-01', 0,
       'n', '2026-01-01', 'j', 'n', 'p', 'n', 999) RETURNING request_id, kabkot, ukuran_kertas, created_at, updated_at`,
  );
  assert.equal(minimal.request_id, null);
  assert.equal(minimal.kabkot, null);
  assert.equal(minimal.ukuran_kertas, 'legal');
  assert.equal(minimal.created_at.length, 24);
  assert.equal(minimal.updated_at.length, 24);
});

test('letters: kabkot empty string is rejected (must be stored as NULL)', async () => {
  const db = createTestDb();
  await expectCheck(db, { kabkot: '' });
  await expectCheck(db, { kabkot: 'k'.repeat(181) });
  await insertLetter(db, { kabkot: 'k'.repeat(180) });
});

test('letters: date CHECKs accept calendar dates only', async () => {
  const db = createTestDb();
  const dateColumns = ['sk_tanggal', 'sk_tmt', 'gaji_baru_tmt', 'surat_tanggal'];
  for (const column of dateColumns) {
    await insertLetter(db, { [column]: '2024-02-29' });
    await insertLetter(db, { [column]: '2026-12-31' });
    for (const invalid of [
      '2024-02-30', '2023-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00',
      '2026-1-01', '01/02/2026', '2026-01-01T00:00', '2026-01-01 ', ' 2026-01-01', '20260101', '',
    ]) {
      await expectCheck(db, { [column]: invalid }, `${column}=${JSON.stringify(invalid)}`);
    }
  }
});

test('letters: timestamp CHECKs require fixed 24-char ISO', async () => {
  const db = createTestDb();
  await insertLetter(db, { created_at: '2026-10-15T04:30:00.123Z', updated_at: '2026-10-15T04:30:00.123Z' });
  for (const invalid of ['2026-10-15T04:30:00Z', '2026-10-15T04:30:00.1234Z', '2026-10-15 04:30:00.123Z', '2026-10-15T04:30:00.123+', 'x'.repeat(24)]) {
    await expectCheck(db, { created_at: invalid }, `created_at=${invalid}`);
  }
  for (const invalid of ['2026-10-15T04:30:00Z', '2026-10-15T04:30:00.1234Z']) {
    await expectCheck(db, { updated_at: invalid }, `updated_at=${invalid}`);
  }
});

test('letters: status, ukuran_kertas, masa kerja, gaji, seq, version, lengths', async () => {
  const db = createTestDb();
  await insertLetter(db, { status_pegawai: 'PPPK', ukuran_kertas: 'a4' });
  for (const [column, valid, invalid] of [
    ['status_pegawai', [], ['pns', 'CPNS', '']],
    ['ukuran_kertas', [], ['A4', 'LEGAL', 'f4', '']],
    ['mk_lama_thn', [0, 40], [-1, 41]],
    ['mk_lama_bln', [0, 11], [-1, 12]],
    ['mk_baru_thn', [1, 40], [0, 41]],
    ['mk_baru_bln', [0, 11], [-1, 12]],
    ['gaji_lama', [0], [-1]],
    ['gaji_baru', [0], [-1]],
    ['nama', ['n'.repeat(180)], ['', 'n'.repeat(181)]],
    ['jabatan', ['j'.repeat(300)], ['', 'j'.repeat(301)]],
    ['nip', [], ['']],
    ['id', ['i'.repeat(200)], ['', 'i'.repeat(201)]],
  ]) {
    for (const value of valid) await insertLetter(db, { [column]: value });
    for (const value of invalid) await expectCheck(db, { [column]: value }, `${column}=${JSON.stringify(value)}`);
  }
  await expectCheck(db, { seq: 0 });
  await expectCheck(db, { seq: -1 });
  await assert.rejects(insertLetter(db, { mk_lama_thn: 1.5 }), /cannot store REAL value in INTEGER column letters\.mk_lama_thn/);
  await assert.rejects(insertLetter(db, { gaji_baru: 'Rp. 3.200.000,-' }), /cannot store TEXT value in INTEGER column letters\.gaji_baru/);
  // STRICT tetap mengonversi teks numerik tanpa kehilangan nilai (perilaku SQLite/D1 standar),
  // sehingga domain code wajib mengirim number; schema tidak menolak '3200000'.
  const coerced = letter({ gaji_baru: '3200000' });
  await insertLetterStatement(db, coerced).run();
  assert.deepEqual(
    await first(db, 'SELECT gaji_baru, typeof(gaji_baru) AS t FROM letters WHERE id = ?1', coerced.id),
    { gaji_baru: 3200000, t: 'integer' },
  );
  await assert.rejects(insertLetter(db, { nama: null }), /NOT NULL constraint failed: letters\.nama/);
});

test('letters: request_id format and case', async () => {
  const db = createTestDb();
  for (const valid of [null, 'abc', 'a-b_c-9', '0', 'r'.repeat(100), 'req_1729-xyz']) {
    await insertLetter(db, { request_id: valid });
  }
  for (const invalid of ['', 'ABC', 'aBc', 'a b', 'a.b', 'a/b', 'a]b', 'a^b', 'é', 'r'.repeat(101), 'a\nb']) {
    await expectCheck(db, { request_id: invalid }, `request_id=${JSON.stringify(invalid)}`);
  }
});

test('letters: UNIQUE id, request_id, seq; NULL request_id may repeat', async () => {
  const db = createTestDb();
  await insertLetter(db, { id: 'KGB-2026-x', request_id: 'x', seq: 100 });

  const dupId = await insertLetter(db, { id: 'KGB-2026-x' }).then(() => null, (e) => e);
  assert.equal(isUniqueViolation(dupId, 'letters.id'), true);
  const dupRid = await insertLetter(db, { request_id: 'x' }).then(() => null, (e) => e);
  assert.equal(isUniqueViolation(dupRid, 'letters.request_id'), true);
  const dupSeq = await insertLetter(db, { seq: 100 }).then(() => null, (e) => e);
  assert.equal(isUniqueViolation(dupSeq, 'letters.seq'), true);

  await insertLetter(db, { request_id: null });
  await insertLetter(db, { request_id: null });
  assert.equal(await first(db, 'SELECT COUNT(*) AS n FROM letters WHERE request_id IS NULL').then((r) => r.n), 2);
});

test('letters: idempotent create returns no row on conflict (ON CONFLICT DO NOTHING RETURNING *)', async () => {
  const db = createTestDb();
  await addUser(db, 'Admin', 'admin');
  const columns = LETTER_COLUMNS.filter((c) => c !== 'seq');
  // ?1..?31 = kolom surat (tanpa seq), ?32 = actor, ?33 = session_version.
  const sql = `INSERT INTO letters (${columns.join(', ')}, seq)
    SELECT ${columns.map((_, i) => `?${i + 1}`).join(', ')}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM letters)
    WHERE EXISTS (SELECT 1 FROM users WHERE username = ?32 AND session_version = ?33)
    ON CONFLICT DO NOTHING
    RETURNING *`;
  const create = (row, actor = 'admin', sv = 1) => all(db, sql, ...columns.map((c) => row[c]), actor, sv);

  const row = letter({ id: 'KGB-2026-abc', request_id: 'abc' });
  const created = await create(row);
  assert.equal(created.length, 1);
  assert.equal(created[0].seq, 1);

  assert.deepEqual(await create(row), [], 'same request_id + id');
  assert.deepEqual(await create({ ...row, id: 'KGB-2027-abc' }), [], 'same request_id, new year id');
  assert.deepEqual(await create({ ...row, request_id: 'other' }), [], 'id collision with different request_id');
  assert.deepEqual(await create(letter({ id: 'KGB-2026-stale', request_id: 'stale' }), 'admin', 2), [], 'stale session_version');
  assert.deepEqual(await create(letter({ id: 'KGB-2026-ghost', request_id: 'ghost' }), 'ghost'), [], 'unknown actor');

  const next = await create(letter({ id: 'KGB-2026-def', request_id: 'def' }), 'ADMIN');
  assert.equal(next[0].seq, 2, 'seq = MAX(seq)+1; actor lookup is case-insensitive');
  assert.equal(await first(db, 'SELECT COUNT(*) AS n FROM letters').then((r) => r.n), 2);
});

test('salary_grades: CHECK and UNIQUE', async () => {
  const db = createTestDb();
  const sql = 'INSERT INTO salary_grades (status_pegawai, pangkat, golongan_code, mkg, nominal) VALUES (?1, ?2, ?3, ?4, ?5)';
  await run(db, sql, 'PNS', 'Penata', 'III/c', 0, 1);
  await run(db, sql, 'PPPK', 'IX', 'IX', 40, 4000000);
  for (const params of [
    ['pns', 'P', 'G', 0, 1],
    ['PNS', '', 'G', 0, 1],
    ['PNS', 'P', '', 0, 1],
    ['PNS', 'P', 'g'.repeat(21), 0, 1],
    ['PNS', 'P', 'G', -1, 1],
    ['PNS', 'P', 'G', 41, 1],
    ['PNS', 'P', 'G', 0, 0],
  ]) {
    await assert.rejects(run(db, sql, ...params), CHECK_FAILED, JSON.stringify(params));
  }
  const dup = await run(db, sql, 'PNS', 'Lain', 'III/c', 0, 5).then(() => null, (e) => e);
  assert.equal(isUniqueViolation(dup), true);
});

test('login_throttle: key CHECK', async () => {
  const db = createTestDb();
  const sql = 'INSERT INTO login_throttle (key, count, expires_at) VALUES (?1, ?2, ?3)';
  await run(db, sql, `lt_${'a'.repeat(32)}`, 0, 1);
  for (const [key, count] of [
    [`lt_${'a'.repeat(31)}`, 1],
    [`lt_${'a'.repeat(33)}`, 1],
    [`xx_${'a'.repeat(32)}`, 1],
    [`lt_${'b'.repeat(32)}`, -1],
  ]) {
    await assert.rejects(run(db, sql, key, count, 1), CHECK_FAILED, key);
  }
});

test('login_throttle: atomic upsert allows 5 attempts, blocks the 6th, resets after expiry', async () => {
  const db = createTestDb();
  const key = `lt_${'c'.repeat(32)}`;
  // Lampiran B, dengan ?1 = key, ?2 = nowMs.
  const consume = (nowMs) =>
    first(
      db,
      `INSERT INTO login_throttle (key, count, expires_at) VALUES (?1, 1, ?2 + 300000)
       ON CONFLICT(key) DO UPDATE SET
         count      = CASE WHEN login_throttle.expires_at <= ?2 THEN 1 ELSE login_throttle.count + 1 END,
         expires_at = ?2 + 300000
       WHERE login_throttle.expires_at <= ?2 OR login_throttle.count < 5
       RETURNING count`,
      key,
      nowMs,
    );

  const t0 = 1_760_000_000_000;
  const counts = [];
  for (let i = 0; i < 5; i += 1) counts.push((await consume(t0 + i * 1000)).count);
  assert.deepEqual(counts, [1, 2, 3, 4, 5]);
  assert.equal(await consume(t0 + 6000), null, '6th attempt blocked');
  assert.equal(await consume(t0 + 7000), null, 'still blocked');

  const blocked = await first(db, 'SELECT count, expires_at FROM login_throttle WHERE key = ?1', key);
  assert.deepEqual(blocked, { count: 5, expires_at: t0 + 4000 + 300000 }, 'blocked attempts do not extend expiry');

  const afterExpiry = await consume(blocked.expires_at);
  assert.equal(afterExpiry.count, 1, 'window resets at expiry');
  assert.equal((await consume(blocked.expires_at + 1)).count, 2);

  await run(db, 'DELETE FROM login_throttle WHERE key = ?1', key);
  assert.equal((await consume(t0)).count, 1, 'successful login clears the bucket');
});

test('sessions: CHECK, FK enforced, cascade delete from users', async () => {
  const db = createTestDb();
  await addUser(db, 'admin', 'admin');
  const user = await addUser(db, 'staff');
  const sql = 'INSERT INTO sessions (token_hash, user_id, session_version, expires_at) VALUES (?1, ?2, ?3, ?4)';
  await run(db, sql, 'a'.repeat(64), user.id, 1, TS);
  await run(db, sql, 'b'.repeat(64), user.id, 1, TS);
  await assert.rejects(run(db, sql, 'c'.repeat(63), user.id, 1, TS), CHECK_FAILED);
  await assert.rejects(
    run(db, sql, 'd'.repeat(64), 9999, 1, TS),
    /^Error: D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_FOREIGNKEY\)$/,
  );

  const deleted = await run(db, 'DELETE FROM users WHERE id = ?1', user.id);
  assert.equal(deleted.meta.changes, 3, 'D1 counts cascaded rows in meta.changes (verified on local D1)');
  assert.equal(await first(db, 'SELECT COUNT(*) AS n FROM sessions').then((r) => r.n), 0);
});

test('trigger: last admin cannot be deleted; error text matches real D1', async () => {
  const db = createTestDb();
  const admin = await addUser(db, 'admin', 'admin');
  await addUser(db, 'staff');

  const error = await run(db, 'DELETE FROM users WHERE id = ?1', admin.id).then(() => null, (e) => e);
  assert.ok(error);
  assert.equal(error.message, 'D1_ERROR: LAST_ADMIN_PROTECTED: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)');
  assert.equal(error.cause.message, 'LAST_ADMIN_PROTECTED: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)');
  assert.equal(isTriggerError(error, 'LAST_ADMIN_PROTECTED'), true);
  assert.equal(isUniqueViolation(error), false);
  assert.equal(await first(db, 'SELECT COUNT(*) AS n FROM users').then((r) => r.n), 2);

  // Pengelola tetap dapat dihapus.
  assert.equal((await run(db, "DELETE FROM users WHERE username = 'staff'")).meta.changes, 1);
  // Menghapus semua user juga diblokir saat admin tinggal satu.
  await assert.rejects(run(db, 'DELETE FROM users'), (e) => isTriggerError(e, 'LAST_ADMIN_PROTECTED'));
});

test('trigger: last admin cannot be demoted', async () => {
  const db = createTestDb();
  await addUser(db, 'admin', 'admin');
  const error = await run(db, "UPDATE users SET role = 'pengelola' WHERE username = ?1", 'admin').then(() => null, (e) => e);
  assert.equal(isTriggerError(error, 'LAST_ADMIN_PROTECTED'), true);
  assert.equal(await first(db, "SELECT role FROM users WHERE username = 'admin'").then((r) => r.role), 'admin');

  // Update kolom lain dan role tetap admin tidak memicu trigger.
  await run(db, "UPDATE users SET nama_lengkap = 'Baru' WHERE username = 'admin'");
  await run(db, "UPDATE users SET role = 'admin' WHERE username = 'admin'");
});

test('triggers do not fire when another admin exists', async () => {
  const db = createTestDb();
  await addUser(db, 'admin1', 'admin');
  await addUser(db, 'admin2', 'admin');
  await addUser(db, 'admin3', 'admin');

  await run(db, "UPDATE users SET role = 'pengelola' WHERE username = 'admin1'");
  assert.equal((await run(db, "DELETE FROM users WHERE username = 'admin2'")).meta.changes, 1);
  // admin3 kini satu-satunya admin.
  await assert.rejects(run(db, "DELETE FROM users WHERE username = 'admin3'"), (e) => isTriggerError(e, 'LAST_ADMIN_PROTECTED'));
  await assert.rejects(
    run(db, "UPDATE users SET role = 'pengelola' WHERE username = 'admin3'"),
    (e) => isTriggerError(e, 'LAST_ADMIN_PROTECTED'),
  );
});

test('isTriggerError matches only the named RAISE message', () => {
  const d1 = new Error('D1_ERROR: LAST_ADMIN_PROTECTED: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)');
  assert.equal(isTriggerError(d1, 'LAST_ADMIN_PROTECTED'), true);
  assert.equal(isTriggerError(new Error('LAST_ADMIN_PROTECTED'), 'LAST_ADMIN_PROTECTED'), true);
  assert.equal(isTriggerError(new Error('x', { cause: new Error('LAST_ADMIN_PROTECTED') }), 'LAST_ADMIN_PROTECTED'), true);
  assert.equal(isTriggerError(new Error('NOT_LAST_ADMIN_PROTECTED_X'), 'LAST_ADMIN_PROTECTED'), false);
  assert.equal(isTriggerError(new Error('UNIQUE constraint failed: users.username'), 'LAST_ADMIN_PROTECTED'), false);
  assert.equal(isTriggerError(null, 'LAST_ADMIN_PROTECTED'), false);
  assert.throws(() => isTriggerError(d1, 'bad name'), TypeError);
  assert.equal(isUniqueViolation(new Error('UNIQUE constraint failed: letters.id')), true);
  assert.equal(isUniqueViolation(undefined), false);
});

test('guarded delete-user (Lampiran B) returns 0 rows for self and last admin, without trigger errors', async () => {
  const db = createTestDb();
  // ?1 = target, ?2 = actor, ?3 = actor session_version.
  const sql = `DELETE FROM users
    WHERE username = ?1 AND username <> ?2
      AND EXISTS (SELECT 1 FROM users a WHERE a.username = ?2 AND a.session_version = ?3 AND a.role = 'admin')
      AND (role <> 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)
    RETURNING username`;
  await addUser(db, 'Admin', 'admin');
  await addUser(db, 'staff');

  assert.deepEqual(await all(db, sql, 'admin', 'admin', 1), [], 'self delete');
  assert.deepEqual(await all(db, sql, 'Admin', 'ADMIN', 1), [], 'self delete with different case');
  assert.deepEqual(await all(db, sql, 'staff', 'admin', 2), [], 'stale actor session');
  assert.deepEqual(await all(db, sql, 'staff', 'staff', 1), [], 'non-admin actor');
  assert.deepEqual(await all(db, sql, 'missing', 'admin', 1), [], 'missing target');

  // Admin terakhir sebagai target dari actor non-admin: 0 baris, trigger tidak sempat terpicu.
  assert.deepEqual(await all(db, sql, 'Admin', 'staff', 1), [], 'last admin targeted by non-admin');
  assert.equal(await first(db, 'SELECT COUNT(*) AS n FROM users').then((r) => r.n), 2, 'nothing deleted');

  // Dua admin: admin lain dan pengelola dapat dihapus (target dicocokkan case-insensitive).
  await addUser(db, 'other', 'admin');
  assert.deepEqual(await all(db, sql, 'OTHER', 'admin', 1), [{ username: 'other' }]);
  assert.deepEqual(await all(db, sql, 'staff', 'admin', 1), [{ username: 'staff' }]);
  assert.deepEqual(await all(db, sql, 'Admin', 'Admin', 1), [], 'remaining last admin cannot self-delete');
  assert.equal(await first(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").then((r) => r.n), 1);
});

test('guarded delete-user: COUNT guard alone yields 0 rows for the last admin (no trigger error)', async () => {
  const db = createTestDb();
  await addUser(db, 'solo', 'admin');
  // Guard admin-terakhir dari Lampiran B tanpa guard actor, untuk memastikan klausa ini sendiri
  // mencegah DELETE sebelum trigger BEFORE DELETE dievaluasi.
  const rows = await all(
    db,
    `DELETE FROM users WHERE username = ?1
       AND (role <> 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)
     RETURNING username`,
    'solo',
  );
  assert.deepEqual(rows, []);
  assert.equal(await first(db, 'SELECT COUNT(*) AS n FROM users').then((r) => r.n), 1);
});

test('batch() is atomic: a failing statement rolls back earlier ones', async () => {
  const db = createTestDb();
  await addUser(db, 'admin', 'admin');
  await assert.rejects(
    db.batch([
      statement(db, USER_INSERT, 'b1', SHA256_HASH, 'B1', 'pengelola'),
      statement(db, 'DELETE FROM users WHERE username = ?1', 'admin'),
    ]),
    (e) => isTriggerError(e, 'LAST_ADMIN_PROTECTED'),
  );
  assert.equal(await first(db, "SELECT COUNT(*) AS n FROM users WHERE username = 'b1'").then((r) => r.n), 0);

  const results = await db.batch([
    statement(db, USER_INSERT, 'b2', SHA256_HASH, 'B2', 'pengelola'),
    statement(db, 'SELECT COUNT(*) AS n FROM users'),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].results[0].username, 'b2');
  assert.equal(results[0].meta.changes, 1);
  assert.deepEqual(results[1].results, [{ n: 2 }]);
});
