import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCSV } from '../scripts/audit-sheets.mjs';
import { transformUsers, transformSalary, transformLetters, renderInsertStatements,
  canonicalChecksum, sqlLiteral, runCli, TABLE_COLUMNS, tableAggregates } from '../scripts/migrate-sheets-to-d1.mjs';
import { createTestDb, splitSqlStatements } from './helpers/d1-sqlite.mjs';
import { getBootstrap } from '../src/server/salary.js';
import { LETTER_FIELDS, listLetters, rowToLetter } from '../src/server/letters.js';
import { login } from '../src/server/auth.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const AT = '2026-10-15T00:00:00.000Z';
const PEPPER = 'synthetic-pepper-for-migration-tests';
const PASSWORD = 'SyntheticPassword123!';
const SALT = 'abcdef0123456789ABCDEF0123456789';
const HASH = `sha256$${SALT}$${createHash('sha256').update(SALT + PASSWORD + PEPPER).digest('hex')}`;
const NAME = "Synthetic O'Brien 海洋";
const NIP = '198801012010011987';
const SIGN_NIP = '197901012000122345';
const USER_HEADER = ['username', 'password', 'nama', 'role'];
const SALARY_HEADER = ['status', 'pangkat', 'MKG 0 Tahun', 'MKG 2 Tahun', 'ignored'];
const LETTER_HEADER = ['timestamp', ...LETTER_FIELDS];
function csv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
}
function letter(overrides = {}) {
  const values = {
    timestamp: '2026-01-01T00:30:00', id: 'KGB-2026-unique', statusPegawai: 'PNS', nama: NAME,
    nip: NIP, pangkat: 'Penata (III/c)', jabatan: 'Analis', unit: "Unit O'Brien\nKupang 海洋",
    kabkot: 'Kota Kupang', skPejabat: 'Gubernur', skTanggal: '2024-02-29', skNomor: 'SK/1',
    skTmt: '2024-03-01', mkLamaThn: '2', mkLamaBln: '0', gajiLama: 'Rp. 4.123.400,-',
    mkBaruThn: '4', mkBaruBln: '0', gajiBaruTmt: '2026-03-01', gajiBaru: 'Rp. 4.567.800,-',
    suratNomor: '800/1', suratTanggal: '2026-01-01', signJabatan: 'Kepala', signNama: 'Synthetic Signer',
    signPangkat: 'Pembina', signNip: SIGN_NIP, ukuranKertas: 'legal', ...overrides,
  };
  return LETTER_HEADER.map((key) => values[key]);
}
const users = () => [USER_HEADER, [' Admin.Case ', HASH, NAME, 'administrator'],
  ['operator', HASH, '', 'other']];
const salaries = () => [SALARY_HEADER,
  ['pppk', 'Golongan IX', '3.000.000', '3.100.000', 'x'],
  ['PNS', 'Penata (III/c)', 'Rp. 4.123.400,-', '4.200.000', 'x'],
  ['PNS', 'Pengatur (II/a)', '2.200.000', '0', 'x']];
function parsedRows(rows) { return parseCSV(csv(rows)); }
function transformed(changes = {}) {
  return {
    users: transformUsers(parsedRows(changes.users ?? users()), AT),
    salary: transformSalary(parsedRows(changes.salary ?? salaries()), AT),
    letters: transformLetters(parsedRows(changes.letters ?? [LETTER_HEADER, letter()])),
  };
}
function codeFound(out, field, code, kind = 'quarantine') {
  return out[kind].some((entry) => entry.field === field && entry.code === code);
}
function capture(argv) {
  const logs = [];
  const errors = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try { return { code: runCli(argv), stdout: logs.join('\n'), stderr: errors.join('\n') }; }
  finally { console.log = oldLog; console.error = oldError; }
}
function fixture(t, changes = {}) {
  const tempRoot = path.join(os.tmpdir(), 'kilo');
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'migrate-synthetic-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = { users: changes.users ?? users(), salary: changes.salary ?? salaries(),
    letters: changes.letters ?? [LETTER_HEADER, letter()] };
  for (const [key, rows] of Object.entries(input)) fs.writeFileSync(path.join(temp, `${key}.csv`), csv(rows));
  const out = path.join(temp, 'seed');
  const argv = ['--users', path.join(temp, 'users.csv'), '--letters', path.join(temp, 'letters.csv'),
    '--salary', path.join(temp, 'salary.csv'), '--migrated-at', AT, '--out', out];
  return { temp, out, argv, input };
}
function json(out, name = 'manifest.json') { return JSON.parse(fs.readFileSync(path.join(out, name), 'utf8')); }
function assertPrivate(output) {
  for (const sensitive of [NIP, SIGN_NIP, NAME, HASH, 'Synthetic Signer', PASSWORD]) {
    assert.equal(output.includes(sensitive), false, 'Output leaked a synthetic sensitive value');
  }
}
// Only the static GAS source is read, never migration-data. Independent parity reference.
function gasReference() {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8'), context);
  return context;
}

test('all sheet CSV exports transform through the shared RFC-4180 parser', () => {
  const data = transformed();
  for (const out of Object.values(data)) { assert.equal(out.aborts.length, 0); assert.equal(out.rowsQuarantined, 0); }
  assert.equal(data.users.rowsImported, 2);
  assert.deepEqual(data.users.rows.map((r) => [r.id, r.username, r.role, r.nama_lengkap]),
    [[1, 'Admin.Case', 'admin', NAME], [2, 'operator', 'pengelola', 'operator']]);
  assert.equal(data.users.rows[0].password_hash, HASH);
  assert.ok(data.users.rows.every((r) => r.created_at === AT && r.updated_at === AT && r.version === 1 && r.session_version === 1));
  assert.ok(codeFound(data.users, 'role', 'ROLE_NORMALIZED', 'reports'));
  assert.equal(data.salary.rowsImported, 5);
  assert.deepEqual(data.salary.rows.map((r) => r.sort_order), [1, 1, 2, 2, 3]);
  assert.equal(data.salary.rows[2].golongan_code, 'iii/c');
  assert.equal(data.letters.rows[0].unit, "Unit O'Brien\nKupang 海洋");
  assert.equal(data.letters.rows[0].request_id, 'unique');
});

for (const password of ['plaintext-secret', '', 'pbkdf2_sha256$100$abc$def', HASH + ' ', HASH.replace('sha256$', 'SHA256$'), `sha256$${'g'.repeat(32)}$${'a'.repeat(64)}`]) {
  test(`users ABORT invalid credential case ${['plaintext-secret', '', 'pbkdf2_sha256$100$abc$def', HASH + ' ', HASH.replace('sha256$', 'SHA256$'), `sha256$${'g'.repeat(32)}$${'a'.repeat(64)}`].indexOf(password)}`, () => {
    const out = transformUsers([USER_HEADER, ['admin', password, NAME, 'admin']], AT);
    assert.ok(codeFound(out, 'password_hash', 'INVALID_PASSWORD_HASH', 'aborts'));
    assertPrivate(JSON.stringify({ aborts: out.aborts, quarantine: out.quarantine, reports: out.reports }));
  });
}
test('users ABORT duplicate usernames ignoring case and zero admins', () => {
  assert.ok(codeFound(transformUsers([USER_HEADER, ...users().slice(1), ['ADMIN.CASE', HASH, NAME, 'admin']], AT), 'username', 'DUPLICATE_USERNAME', 'aborts'));
  assert.ok(codeFound(transformUsers([USER_HEADER, ['operator', HASH, NAME, 'pengelola']], AT), 'role', 'ZERO_ADMINS', 'aborts'));
  assert.ok(codeFound(transformUsers([USER_HEADER], AT), 'role', 'ZERO_ADMINS', 'aborts'));
});
test('users blank rows skip; schema-incompatible rows quarantine; IDs remain contiguous in sheet order', () => {
  const out = transformUsers([USER_HEADER, ['', '', '', ''], ['zAdmin', HASH, '', 'admin'],
    ['', HASH, NAME, 'pengelola'], ['x'.repeat(101), HASH, NAME, 'pengelola'],
    ['longname', HASH, 'x'.repeat(161), 'pengelola'], ['control', HASH, 'a\u0000b', 'pengelola'],
    ['aUser', HASH, NAME, 'pengelola']], AT);
  assert.equal(out.rowsSkipped, 1);
  assert.equal(out.rowsQuarantined, 4);
  assert.deepEqual(out.rows.map((r) => [r.id, r.username]), [[1, 'zAdmin'], [2, 'aUser']]);
});

test('master salary uses GAS digits-only display parsing, not letter rupiah parsing', () => {
  const gas = gasReference();
  const cells = ['Rp. 4.123.400,-', '100,00', '-500', 'abc', '', '0', '000', '9.000'];
  for (const cell of cells) {
    const out = transformSalary([['status', 'pangkat', 'MKG 0 Tahun'], ['PNS', 'Penata (III/a)', cell]], AT);
    const expected = gas.normalizeNominalGaji_(cell, cell);
    assert.equal(out.rows[0]?.nominal ?? null, expected && Number(expected) > 0 ? Number(expected) : null);
  }
});
test('master salary skip rules and unpivot counters distinguish source rows from output cells', () => {
  const out = transformSalary([SALARY_HEADER, [], ['PNS', '', '1'], ['other', 'Penata', '1'],
    ['PNS', 'Penata (III/a)', '0', ''], ['PPPK', 'Golongan IX', '100', '200']], AT);
  assert.equal(out.rowsRead, 5);
  assert.equal(out.rowsSkipped, 4);
  assert.equal(out.rowsImported, 2);
  assert.equal(out.cellsSkipped, 2);
  assert.deepEqual(out.rows.map((r) => [r.id, r.mkg, r.nominal, r.sort_order]), [[1, 0, 100, 5], [2, 2, 200, 5]]);
});
test('master salary ABORT duplicate natural keys, including repeated MKG headers', () => {
  const out = transformSalary([SALARY_HEADER, ['PNS', 'Penata (III/a)', '100'], ['pns', 'iii/a', '200']], AT);
  assert.ok(out.aborts.some((r) => r.code === 'DUPLICATE_SALARY_ENTRY'));
  const repeated = transformSalary([['status', 'pangkat', 'MKG 0 Tahun', 'MKG 0 Tahun'], ['PNS', 'III/a', '100', '200']], AT);
  assert.equal(repeated.aborts.length, 1);
});
for (const [header, pangkat, nominal, code] of [
  ['MKG 41 Tahun', 'III/a', '100', 'MKG_OUT_OF_RANGE'],
  ['MKG 0 Tahun', 'x'.repeat(121), '100', 'FIELD_OVER_LENGTH'],
  ['MKG 0 Tahun', 'x'.repeat(21), '100', 'FIELD_OVER_LENGTH'],
  ['MKG 0 Tahun', 'III/a', '9007199254740992', 'SALARY_OVER_MAX_SAFE_INTEGER'],
  ['MKG 0 Tahun', 'III/a', '1\u00002', 'CONTROL_CHARACTER'],
]) {
  test(`salary quarantines schema violation ${code} ${header} ${pangkat.length}`, () => {
    const out = transformSalary([['s', 'p', header], ['PNS', pangkat, nominal]], AT);
    assert.equal(out.rowsQuarantined, 1);
    assert.equal(out.rowsImported, 0);
    assert.ok(out.quarantine.some((r) => r.code === code));
  });
}

test('letters preserve IDs and seq gaps; DESC equals GAS bottom-up order skipping empty IDs', () => {
  const input = [LETTER_HEADER, letter({ id: 'KGB-2026-z' }), letter({ id: '' }),
    Array(27).fill(''), letter({ id: ' legacy / id ' }), letter({ id: 'KGB-2026-a' })];
  const out = transformLetters(parsedRows(input));
  assert.equal(out.rowsRead, 5);
  assert.equal(out.rowsSkipped, 2);
  assert.deepEqual(out.rows.map((r) => r.seq), [1, 4, 5]);
  assert.equal(out.rows[1].id, ' legacy / id ');
  assert.deepEqual([...out.rows].sort((a, b) => b.seq - a.seq).map(rowToLetter),
    input.slice(1).reverse().filter((row) => String(row[1]).trim()).map((row) => JSON.parse(JSON.stringify(gasReference().rowToLetter_(row)))));
});
test('letters duplicate IDs ABORT even if duplicate source row is quarantined', () => {
  const out = transformLetters([LETTER_HEADER, letter(), letter({ nama: '' })]);
  assert.ok(codeFound(out, 'id', 'DUPLICATE_ID', 'aborts'));
});
for (const [timestamp, expected] of [
  ['2026-01-01T00:30:00', '2025-12-31T16:30:00.000Z'],
  ['2026-01-01T00:30:00.123', '2025-12-31T16:30:00.123Z'],
  ['2026-01-01 08:00:00', '2026-01-01T00:00:00.000Z'],
  ['1/1/2026 0:30:00', '2025-12-31T16:30:00.000Z'],
  ['29/2/2024 23:59:59', '2024-02-29T15:59:59.000Z'],
  ['', '2025-12-31T16:00:00.000Z'],
  ['nonsense', '2025-12-31T16:00:00.000Z'],
  ['2026-02-30T12:00:00', '2025-12-31T16:00:00.000Z'],
  ['2026-01-01T24:00:00', '2025-12-31T16:00:00.000Z'],
  ['2026-01-01T12:60:00', '2025-12-31T16:00:00.000Z'],
  ['2026-01-01T12:00:60', '2025-12-31T16:00:00.000Z'],
]) {
  test(`WITA timestamp ${timestamp || '(empty)'}`, () => {
    const out = transformLetters([LETTER_HEADER, letter({ timestamp })]);
    assert.equal(out.rowsQuarantined, 0);
    assert.equal(out.rows[0].created_at, expected);
    assert.equal(out.rows[0].updated_at, expected);
    assert.equal(expected.length, 24);
  });
}
test('request ID exact suffix rules, uppercase and cross-year duplicates stay NULL across quarantined rows', () => {
  const ids = ['KGB-2026-lower_1-a', 'KGB-2026-UPPER', 'KGB-2025-shared', 'KGB-2026-shared',
    'old-format', `KGB-2026-${'a'.repeat(101)}`, 'KGB-2026-space x'];
  const out = transformLetters([LETTER_HEADER, ...ids.map((id) => letter({ id })),
    letter({ id: 'KGB-2025-repair', nama: '' }), letter({ id: 'KGB-2026-repair' })]);
  assert.deepEqual(out.rows.map((r) => r.request_id), ['lower_1-a', null, null, null, null, null, null, null]);
});

const required = ['nama', 'nip', 'pangkat', 'jabatan', 'unit', 'skPejabat', 'skNomor',
  'suratNomor', 'signJabatan', 'signNama', 'signPangkat', 'signNip'];
const snake = (value) => value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
for (const field of required) {
  test(`letters quarantine empty and oversized required text ${field}`, () => {
    const max = ['unit', 'jabatan'].includes(field) ? 300 : 180;
    for (const [value, code] of [['', 'REQUIRED_FIELD_EMPTY'], ['x'.repeat(max + 1), 'FIELD_OVER_LENGTH']]) {
      const out = transformLetters([LETTER_HEADER, letter({ [field]: value })]);
      assert.equal(out.rowsQuarantined, 1);
      assert.ok(codeFound(out, snake(field), code));
    }
  });
}
for (const field of ['skTanggal', 'skTmt', 'gajiBaruTmt', 'suratTanggal']) {
  test(`letters shared date parsing and quarantine ${field}`, () => {
    for (const value of ['', '2025-02-29', '31/4/2026', 'bad']) {
      const out = transformLetters([LETTER_HEADER, letter({ [field]: value })]);
      assert.ok(codeFound(out, snake(field), 'UNPARSEABLE_DATE'));
      assert.equal(out.rowsImported, 0);
    }
    for (const value of ['29/2/2024', '29 Februari 2024', '45351']) {
      const out = transformLetters([LETTER_HEADER, letter({ [field]: value })]);
      assert.equal(out.rows[0][snake(field)], '2024-02-29');
    }
  });
}
for (const field of ['gajiLama', 'gajiBaru']) {
  test(`letters shared rupiah parsing and quarantine ${field}`, () => {
    for (const value of ['', 'abc', '-1', '4.123.400,50', '9007199254740992']) {
      assert.equal(transformLetters([LETTER_HEADER, letter({ [field]: value })]).rowsQuarantined, 1);
    }
    assert.equal(transformLetters([LETTER_HEADER, letter({ [field]: '0' })]).rows[0][snake(field)], 0);
  });
}
for (const [field, badValues] of [
  ['mkLamaThn', ['-1', '41', '2.5', 'abc']], ['mkLamaBln', ['-1', '12', '1e1']],
  ['mkBaruThn', ['', '0', '41', 'abc']], ['mkBaruBln', ['12', '2.5', '-1']],
]) {
  test(`letters quarantine invalid masa kerja ${field}`, () => {
    for (const value of badValues) assert.equal(transformLetters([LETTER_HEADER, letter({ [field]: value })]).rowsQuarantined, 1);
  });
}
test('letters default empty masa kerja to zero, respecting mk_baru_thn minimum', () => {
  const out = transformLetters([LETTER_HEADER, letter({ mkLamaThn: '', mkLamaBln: '', mkBaruBln: '' })]);
  assert.deepEqual([out.rows[0].mk_lama_thn, out.rows[0].mk_lama_bln, out.rows[0].mk_baru_bln], [0, 0, 0]);
});
for (const field of ['nip', 'signNip']) {
  test(`letters quarantine scientific ${field}; nonstandard kept and masked`, () => {
    for (const value of ['1.98E+17', '1.98e17', '1e-3']) {
      const out = transformLetters([LETTER_HEADER, letter({ [field]: value })]);
      assert.ok(codeFound(out, snake(field), 'NIP_TRUNCATED'));
      assert.equal(JSON.stringify(out.quarantine).includes(value), false);
    }
    const out = transformLetters([LETTER_HEADER, letter({ [field]: 'legacy 123 456' })]);
    assert.equal(out.rows[0][snake(field)], 'legacy 123 456');
    assert.ok(codeFound(out, snake(field), 'NIP_NON_STANDARD', 'reports'));
    assert.equal(JSON.stringify(out.reports).includes('legacy 123 456'), false);
  });
}
test('letters status, ID, optional kabkot, paper and text controls', () => {
  assert.equal(transformLetters([LETTER_HEADER, letter({ statusPegawai: 'pPpK' })]).rows[0].status_pegawai, 'PPPK');
  for (const overrides of [{ statusPegawai: 'contract' }, { id: 'x'.repeat(201) }, { kabkot: 'x'.repeat(181) }]) {
    assert.equal(transformLetters([LETTER_HEADER, letter(overrides)]).rowsQuarantined, 1);
  }
  const out = transformLetters([LETTER_HEADER, letter({ kabkot: '', ukuranKertas: 'A4' }), letter({ id: 'other', ukuranKertas: 'F4', kabkot: 'Legacy region' })]);
  assert.equal(out.rows[0].kabkot, null);
  assert.deepEqual(out.rows.map((r) => r.ukuran_kertas), ['a4', 'legal']);
  assert.ok(codeFound(out, 'kabkot', 'KABKOT_UNKNOWN', 'reports'));
  assert.equal(out.rows[0].created_by, null);
  assert.equal(out.rows[0].updated_by, null);
  for (const field of LETTER_HEADER) {
    const bad = transformLetters([LETTER_HEADER, letter({ [field]: `a\u0000b` })]);
    assert.equal(bad.rowsQuarantined, 1, field);
    assert.ok(bad.quarantine.some((r) => r.code === 'CONTROL_CHARACTER'), field);
  }
});

test('SQL literals escape apostrophes, unicode, newline and reject controls/unsafe types', () => {
  assert.equal(sqlLiteral("O'Brien 海洋\n\t\r"), "'O''Brien 海洋\n\t\r'");
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(1234), '1234');
  for (const value of ['a\0b', '\u001e', '\u001f', '\u007f', '\u0085', 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, {}]) {
    assert.throws(() => sqlLiteral(value), /INVALID_SQL_VALUE/);
  }
});
test('INSERTs split at 50 rows and measured UTF-8 byte limit, without transaction or conflict directives', () => {
  const base = transformed().letters.rows[0];
  const rows = Array.from({ length: 151 }, (_, i) => ({ ...base, id: `letter-${i}`, seq: i + 1 }));
  let statements = renderInsertStatements('letters', rows);
  assert.deepEqual(statements.map((sql) => (sql.match(/\),\n\(/g) ?? []).length + 1), [50, 50, 50, 1]);
  // Schema-valid long multibyte text forces the byte splitter before row 50.
  const longRows = rows.map((r) => ({ ...r, nama: '海'.repeat(180), pangkat: '海'.repeat(180),
    jabatan: '海'.repeat(300), unit: '海'.repeat(300), sign_nama: '海'.repeat(180), sk_nomor: "'".repeat(180) }));
  statements = renderInsertStatements('letters', longRows);
  assert.ok(statements.length > 4);
  for (const sql of statements) {
    assert.ok(Buffer.byteLength(sql) < 100_000);
    assert.ok((sql.match(/\),\n\(/g) ?? []).length + 1 <= 50);
    assert.match(sql, /^INSERT INTO letters \(id, request_id,/);
    assert.doesNotMatch(sql, /\b(?:ON CONFLICT|BEGIN|COMMIT|PRAGMA)\b/i);
  }
  assert.throws(() => renderInsertStatements('letters', [{ ...base, nama: '海'.repeat(40_000) }]), /SQL_ROW_TOO_LARGE/);
});
test('canonical checksum uses exact fixed columns, NULL token, key order and separator bytes', () => {
  const data = transformed();
  for (const [name, table] of [['users', 'users'], ['salary', 'salary_grades'], ['letters', 'letters']]) {
    const rows = data[name].rows;
    const expected = createHash('sha256').update(rows.map((row) => TABLE_COLUMNS[table].map((c) => row[c] === null ? '\u0000' : String(row[c])).join('\u001f')).join('\u001e')).digest('hex');
    assert.equal(canonicalChecksum(table, [...rows].reverse()), expected);
    assert.equal(canonicalChecksum(table, []), createHash('sha256').update('').digest('hex'));
  }
  const row = data.letters.rows[0];
  assert.notEqual(canonicalChecksum('letters', [row]), canonicalChecksum('letters', [{ ...row, seq: 5 }]));
  const nullHash = canonicalChecksum('letters', [{ ...row, kabkot: null }]);
  assert.notEqual(nullHash, canonicalChecksum('letters', [{ ...row, kabkot: '' }]));
  assert.notEqual(nullHash, canonicalChecksum('letters', [{ ...row, kabkot: 'NULL' }]));
  assert.throws(() => canonicalChecksum('letters', [{ ...row, nama: 'a\u001fb' }]), /INVALID_CANONICAL_VALUE/);
  const ids = [{ ...row, id: 'z', seq: 1 }, { ...row, id: 'a', seq: 2 }];
  assert.equal(canonicalChecksum('letters', ids), canonicalChecksum('letters', [...ids].reverse()));
});
test('aggregate sums never silently round large integer totals', () => {
  const row = transformed().letters.rows[0];
  const rows = [1, 2].map((seq) => ({ ...row, seq, gaji_baru: Number.MAX_SAFE_INTEGER, gaji_lama: 0 }));
  assert.equal(tableAggregates('letters', rows).sumGajiBaru, '18014398509481982');
  assert.equal(tableAggregates('letters', rows).sumGajiLama, 0);
});
test('salary descending MKG headers ABORT rather than silently changing GAS bootstrap order', () => {
  const out = transformSalary([['s', 'p', 'MKG 2 Tahun', 'MKG 0 Tahun'], ['PNS', 'III/a', '100', '200']], AT);
  assert.ok(out.aborts.some((r) => r.code === 'MKG_HEADER_ORDER_UNSUPPORTED'));
});

test('CLI usage and IO failures are exit 1 without leaking argument/exception values', (t) => {
  const fx = fixture(t);
  for (const args of [[], ['--users', 'x'], fx.argv.slice(0, 6), [...fx.argv, '--unknown', NAME],
    [...fx.argv, '--out'], [...fx.argv, '--out', 'duplicate']]) assert.equal(capture(args).code, 1);
  for (const at of ['2026-01-01', '2026-01-01T00:00:00Z', '2026-02-30T00:00:00.000Z', '2026-01-01T24:00:00.000Z']) {
    const args = [...fx.argv]; args[7] = at;
    assert.equal(capture(args).code, 1);
  }
  const missing = [...fx.argv]; missing[1] = path.join(fx.temp, NAME);
  const result = capture(missing);
  assert.equal(result.code, 1); assertPrivate(result.stderr + result.stdout);
  fs.writeFileSync(path.join(fx.temp, 'users.csv'), '"unclosed');
  assert.equal(capture(fx.argv).code, 1);
  assert.equal(capture(['--help']).code, 0);
});
test('CLI rejects in-repo output not git-ignored BEFORE mkdir and before reading any input', () => {
  const out = path.join(ROOT, 'synthetic-not-ignored-seed');
  assert.equal(fs.existsSync(out), false);
  const result = capture(['--users', 'missing', '--letters', 'missing', '--salary', 'missing', '--migrated-at', AT, '--out', out]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /OUTPUT_NOT_GIT_IGNORED/);
  assert.equal(fs.existsSync(out), false);
});
test('CLI accepts git-ignored in-repo output without ever accessing real migration-data', (t) => {
  const fx = fixture(t);
  const ignored = path.join(ROOT, 'dist', `synthetic-migration-${path.basename(fx.temp)}`);
  t.after(() => fs.rmSync(ignored, { recursive: true, force: true }));
  const args = [...fx.argv]; args[9] = ignored;
  assert.equal(capture(args).code, 0);
  assert.equal(json(ignored).tables.letters.rowsImported, 1);
});
test('CLI quarantine gate, allow-quarantine exit 2, and stale seed removal', (t) => {
  const fx = fixture(t);
  assert.equal(capture(fx.argv).code, 0);
  fs.writeFileSync(path.join(fx.temp, 'letters.csv'), csv([LETTER_HEADER, letter(), letter({ id: 'bad', nama: '', nip: '1.98E+17' })]));
  let result = capture(fx.argv);
  assert.equal(result.code, 2);
  assert.deepEqual(fs.readdirSync(fx.out).sort(), ['manifest.json', 'quarantine.json']);
  assert.equal(json(fx.out).sqlWritten, false);
  assertPrivate(JSON.stringify(json(fx.out, 'quarantine.json')));
  result = capture([...fx.argv, '--allow-quarantine']);
  assert.equal(result.code, 2);
  assert.equal(json(fx.out).sqlWritten, true);
  assert.equal(json(fx.out).tables.letters.rowsQuarantined, 1);
  assertPrivate(result.stdout + result.stderr);
});
for (const kind of ['password', 'username', 'admins', 'letter-id', 'salary-key']) {
  test(`CLI ABORT ${kind} always suppresses SQL, including allow-quarantine`, (t) => {
    const changes = {};
    if (kind === 'password') changes.users = [USER_HEADER, ['admin', PASSWORD, NAME, 'admin']];
    if (kind === 'username') changes.users = [...users(), ['ADMIN.CASE', HASH, NAME, 'admin']];
    if (kind === 'admins') changes.users = [USER_HEADER, ['operator', HASH, NAME, 'pengelola']];
    if (kind === 'letter-id') changes.letters = [LETTER_HEADER, letter(), letter()];
    if (kind === 'salary-key') changes.salary = [...salaries(), ['PNS', 'iii/c', '100']];
    const fx = fixture(t, changes);
    const result = capture([...fx.argv, '--allow-quarantine']);
    assert.equal(result.code, 2);
    const report = json(fx.out);
    assert.equal(report.status, 'ABORT');
    assert.equal(report.sqlWritten, false);
    assert.ok(report.aborts.length > 0);
    assert.deepEqual(fs.readdirSync(fx.out).sort(), ['manifest.json', 'quarantine.json']);
    assertPrivate(result.stdout + result.stderr + JSON.stringify(report));
  });
}
test('CLI letter files contain <=1000 rows; deterministic bytes across two runs and no stdout PII', (t) => {
  const fx = fixture(t, { letters: [LETTER_HEADER, ...Array.from({ length: 1003 }, (_, i) => letter({ id: `KGB-2026-${String(i).padStart(4, '0')}` }))] });
  const first = capture(fx.argv);
  assert.equal(first.code, 0); assertPrivate(first.stdout + first.stderr);
  const names = fs.readdirSync(fx.out).sort();
  assert.deepEqual(names.filter((name) => name.startsWith('03_')), ['03_letters_001.seed.sql', '03_letters_002.seed.sql']);
  const snapshot = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(fx.out, name))]));
  const db = createTestDb(); t.after(() => db.close());
  for (const name of ['03_letters_001.seed.sql', '03_letters_002.seed.sql']) {
    const statements = splitSqlStatements(snapshot[name].toString());
    for (const sql of statements) { assert.ok(Buffer.byteLength(sql) < 100_000); db.sqlite.prepare(sql).run(); }
    const count = db.sqlite.prepare('SELECT count(*) AS n FROM letters').get().n;
    assert.equal(count, name.includes('001') ? 1000 : 1003);
  }
  const second = capture(fx.argv);
  assert.equal(second.code, 0);
  for (const name of names) assert.deepEqual(fs.readFileSync(path.join(fx.out, name)), snapshot[name], name);
  assert.equal(second.stdout, first.stdout);
  assertPrivate(second.stdout + second.stderr);
});
test('real CLI process exit code and stdout privacy', (t) => {
  const fx = fixture(t);
  const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-sheets-to-d1.mjs'), ...fx.argv], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.match(child.stdout, /WARNING/);
  assertPrivate(child.stdout + child.stderr);
});

test('END-TO-END generated seeds satisfy STRICT schema, manifest, GAS parity and peppered login', async (t) => {
  const inputLetters = [LETTER_HEADER, letter({ id: 'KGB-2026-z', kabkot: '', statusPegawai: 'PNS' }),
    letter({ id: '' }), letter({ id: 'KGB-2026-UPPER', statusPegawai: 'PPPK', nip: 'legacy NIP', suratTanggal: '2026-02-01' }),
    letter({ id: 'KGB-2025-shared', suratTanggal: '2025-12-31' }),
    letter({ id: 'KGB-2026-shared', timestamp: '' })];
  const fx = fixture(t, { letters: inputLetters });
  const output = capture(fx.argv); assert.equal(output.code, 0); assertPrivate(output.stdout + output.stderr);
  const manifest = json(fx.out);
  const db = createTestDb(); t.after(() => db.close());
  assert.ok(db.appliedMigrations.length > 0);
  for (const name of manifest.files) {
    const source = fs.readFileSync(path.join(fx.out, name), 'utf8');
    assert.doesNotMatch(source, /\b(?:ON CONFLICT|BEGIN|COMMIT|PRAGMA)\b/i);
    for (const sql of splitSqlStatements(source)) await db.prepare(sql).run();
  }
  for (const [key, table] of [['users', 'users'], ['salary', 'salary_grades'], ['letters', 'letters']]) {
    const rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
    assert.equal(rows.length, manifest.tables[key].rowsImported);
    assert.equal(canonicalChecksum(table, rows), manifest.tables[key].checksum);
  }
  const userAgg = await db.prepare("SELECT count(*) AS count, sum(role = 'admin') AS adminCount FROM users").first();
  assert.deepEqual(userAgg, manifest.tables.users.aggregates);
  const perStatus = Object.fromEntries((await db.prepare('SELECT status_pegawai AS k, count(*) AS n FROM salary_grades GROUP BY status_pegawai').all()).results.map((r) => [r.k, r.n]));
  assert.deepEqual({ count: Object.values(perStatus).reduce((s, n) => s + n, 0), perStatus }, manifest.tables.salary.aggregates);
  const letterAgg = await db.prepare(`SELECT count(*) AS count, sum(gaji_baru) AS sumGajiBaru,
    sum(gaji_lama) AS sumGajiLama, count(DISTINCT nip) AS distinctNip,
    min(surat_tanggal) AS minSuratTanggal, max(surat_tanggal) AS maxSuratTanggal,
    count(request_id) AS requestIdNonNull FROM letters`).first();
  const grouped = async (field) => Object.fromEntries((await db.prepare(`SELECT coalesce(${field}, '(kosong)') AS k, count(*) AS n FROM letters GROUP BY ${field}`).all()).results.map((r) => [r.k, r.n]));
  assert.deepEqual({ ...letterAgg, perStatusPegawai: await grouped('status_pegawai'), perKabkot: await grouped('kabkot') }, manifest.tables.letters.aggregates);
  const gas = gasReference();
  // Drive actual GAS readMasterGaji_ over synthetic display rows, including its normalization.
  gas.getSpreadsheet_ = () => ({ getSheetByName: () => ({ getDataRange: () => ({ getValues: () => fx.input.salary, getDisplayValues: () => fx.input.salary }) }) });
  assert.deepEqual(await getBootstrap(db), JSON.parse(JSON.stringify(gas.readMasterGaji_())));
  const session = { userId: 1, username: 'Admin.Case', sessionVersion: 1, hakAkses: 'admin' };
  const listed = await listLetters(db, session);
  const expectedLetters = inputLetters.slice(1).reverse().filter((r) => r[1]).map((row) => JSON.parse(JSON.stringify(gas.rowToLetter_(row))));
  assert.deepEqual(listed.data, expectedLetters);
  assert.equal(listed.data[0].gajiLama, 'Rp. 4.123.400,-');
  assert.equal(listed.data[0].gajiBaru, 'Rp. 4.567.800,-');
  const auth = await login(db, { PASSWORD_PEPPER: PEPPER, PASSWORD_HASH_ALGO: 'sha256' },
    { username: 'ADMIN.CASE', password: PASSWORD }, new Date(AT));
  assert.equal(auth.status, 'success');
  assert.deepEqual(auth.user, { username: 'Admin.Case', namaLengkap: NAME, hakAkses: 'admin' });
  const operator = await login(db, { PASSWORD_PEPPER: PEPPER }, { username: 'operator', password: PASSWORD }, new Date(AT));
  assert.equal(operator.user.hakAkses, 'pengelola');
  assert.equal(operator.user.namaLengkap, 'operator');
  // Explicit migration IDs advance AUTOINCREMENT, rather than changing user listing order.
  const next = await db.prepare("INSERT INTO users (username, password_hash, nama_lengkap, role) VALUES ('next', ?1, 'Next', 'pengelola') RETURNING id").bind(HASH).first();
  assert.equal(next.id, 3);
});
