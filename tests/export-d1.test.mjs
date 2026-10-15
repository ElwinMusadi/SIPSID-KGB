import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { csvCell, toCsv, witaTimestamp, exportSnapshot, readSqliteSnapshot, parseWranglerResults, validateManifest, runCli } from '../scripts/export-d1-to-csv.mjs';
import { canonicalChecksum, transformLetters, transformUsers, transformSalary } from '../scripts/migrate-sheets-to-d1.mjs';
import { parseCSV, auditUsers, auditLetters, auditSalary } from '../scripts/audit-sheets.mjs';
import { setupApi, letterPayload, callApi } from './helpers/api-fixture.mjs';

async function fixture() {
  const { db, env, adminToken } = await setupApi();
  const result = await callApi(env, '/api/letters', { method: 'POST', cookie: adminToken,
    body: letterPayload({ nama: 'Nama Uji "Berkutip"', kabkot: '', requestId: 'export-test' }) });
  assert.equal(result.status, 200);
  return { db, snapshot: Object.fromEntries(['users', 'letters', 'salary_grades'].map(t => [t, db.sqlite.prepare(`SELECT * FROM ${t}`).all()])) };
}

test('CSV RFC4180 preserves commas, double quotes, newlines and UTF-8', () => {
  const rows = [['col1', 'col2'], ['O\'Brien, "uji"\nbaru', 'Nusa Tenggara Timur'], ['=SUM(A1:A2)', ' +123']];
  const parsed = parseCSV(toCsv(rows));
  assert.deepEqual(parsed[1], rows[1]);
  assert.equal(parsed[2][0], "'=SUM(A1:A2)");
  assert.equal(parsed[2][1], "' +123");
  assert.throws(() => csvCell('secret\0value'), /EXPORT_CONTROL_CHARACTER/);
});

test('timestamp UTC converts to WITA with milliseconds preserved', () => {
  assert.equal(witaTimestamp('2026-10-14T16:30:00.123Z'), '2026-10-15T00:30:00.123');
  assert.equal(witaTimestamp('2026-12-31T20:00:00.000Z'), '2027-01-01T04:00:00.000');
  assert.throws(() => witaTimestamp('not a date'), /EXPORT_INVALID_TIMESTAMP/);
  assert.throws(() => witaTimestamp('2026-02-30T00:00:00.000Z'), /EXPORT_INVALID_TIMESTAMP/);
});

test('complete snapshot exports original A-AA letter layout, user A-D and salary pivot', async () => {
  const { db, snapshot } = await fixture();
  try {
    const result = exportSnapshot(snapshot);
    const users = parseCSV(result.files['Master_User.csv']);
    assert.equal(users.length, 3);
    assert.equal(users[0].length, 4);
    assert.equal(auditUsers(users).blockingCount, 0);
    const letters = parseCSV(result.files['Database_Surat.csv']);
    assert.equal(letters[1].length, 27);
    assert.equal(letters[1][1], snapshot.letters[0].id);
    assert.equal(letters[1][4], '199001012020011001');
    assert.equal(letters[1][8], '');
    assert.equal(letters[1][15], 'Rp. 3.000.000,-');
    assert.equal(letters[1][19], 'Rp. 4.123.400,-');
    assert.equal(letters[1][25], '197001011995011001');
    assert.equal(letters[1][26], 'legal');
    assert.equal(auditLetters(letters).blockingCount, 0);
    const salary = parseCSV(result.files['Master_Gaji_Pangkat.csv']);
    assert.equal(salary[0].length, 43);
    assert.equal(salary[1][2], '2785700');
    assert.equal(salary[1][4], '2873500');
    assert.equal(auditSalary(salary).blockingCount, 0);
    assert.deepEqual(result.report.passwordResetRequiredRows, []);
    assert.equal(exportSnapshot(snapshot).files['Database_Surat.csv'], result.files['Database_Surat.csv']);
  } finally { db.close(); }
});

test('PBKDF2 cannot silently become a GAS password; explicit reset acknowledgement required', async () => {
  const { db, snapshot } = await fixture();
  try {
    snapshot.users[0].password_hash = 'pbkdf2_sha256$100000$salt$hash';
    assert.throws(() => exportSnapshot(snapshot), /EXPORT_PASSWORD_RESET_REQUIRED/);
    const result = exportSnapshot(snapshot, { allowPasswordReset: true });
    assert.equal(parseCSV(result.files['Master_User.csv'])[1][1], '');
    assert.deepEqual(result.report.passwordResetRequiredRows, [2]);
    snapshot.users[0].password_hash = 'plaintext';
    assert.throws(() => exportSnapshot(snapshot, { allowPasswordReset: true }), /EXPORT_PASSWORD_RESET_REQUIRED/);
  } finally { db.close(); }
});

test('CSV rollback roundtrip preserves letter data, NIP digits, WITA milliseconds and salary values', async () => {
  const { db, snapshot } = await fixture();
  try {
    const at = '2026-10-15T00:00:00.000Z';
    snapshot.letters[0].created_at = '2026-10-14T16:30:10.123Z';
    const exported = exportSnapshot(snapshot);
    const transformed = transformLetters(parseCSV(exported.files['Database_Surat.csv']));
    assert.equal(transformed.rowsQuarantined, 0);
    const roundtrip = transformed.rows[0];
    for (const field of ['id', 'nama', 'nip', 'gaji_lama', 'gaji_baru', 'sk_tanggal', 'surat_tanggal', 'sign_nip', 'created_at']) {
      assert.equal(roundtrip[field], snapshot.letters[0][field], field);
    }
    const users = transformUsers(parseCSV(exported.files['Master_User.csv']), at);
    assert.equal(users.aborts.length, 0);
    assert.equal(users.rows[0].password_hash, snapshot.users[0].password_hash);
    const salary = transformSalary(parseCSV(exported.files['Master_Gaji_Pangkat.csv']), at);
    assert.equal(salary.aborts.length, 0);
    assert.equal(salary.rows.length, snapshot.salary_grades.length);
    assert.deepEqual(salary.rows.map(r => r.nominal), snapshot.salary_grades.map(r => r.nominal));
  } finally { db.close(); }
});

test('salary split-row rollback roundtrip preserves labels, disjoint MKG values and source order', () => {
  const at = '2026-10-15T00:00:00.000Z';
  const source = transformSalary([
    ['Status', 'Pangkat', 'MKG 0 Tahun', 'MKG 2 Tahun'],
    ['PNS', 'Penata (III/a)', '2785700', ''],
    ['PNS', 'III/a', '', '2873500'],
  ], at);
  assert.deepEqual(source.aborts, []);
  assert.equal(source.rowsQuarantined, 0);
  assert.deepEqual(source.rows.map(r => [r.pangkat, r.mkg, r.nominal, r.sort_order]), [
    ['Penata (III/a)', 0, 2785700, 1],
    ['III/a', 2, 2873500, 2],
  ]);
  const exported = exportSnapshot({ users: [], letters: [], salary_grades: [...source.rows].reverse() });
  const salaryCsv = parseCSV(exported.files['Master_Gaji_Pangkat.csv']);
  assert.equal(exported.report.counts.salaryRows, 2);
  assert.equal(salaryCsv.length, 3);
  assert.deepEqual(salaryCsv.slice(1).map(r => [r[0], r[1], r[2], r[4]]), [
    ['PNS', 'Penata (III/a)', '2785700', ''],
    ['PNS', 'III/a', '', '2873500'],
  ]);
  const roundtrip = transformSalary(salaryCsv, at);
  assert.deepEqual(roundtrip.aborts, []);
  assert.equal(roundtrip.rowsQuarantined, 0);
  const salaryValues = rows => rows.map(r => [r.status_pegawai, r.golongan_code, r.pangkat, r.mkg, r.nominal, r.sort_order]);
  assert.deepEqual(salaryValues(roundtrip.rows), salaryValues(source.rows));
});

test('salary duplicate natural keys are rejected within and across pivot groups', () => {
  const grade = { id: 1, status_pegawai: 'PNS', golongan_code: 'iii/a', pangkat: 'Penata (III/a)', mkg: 0, nominal: 2785700, sort_order: 1 };
  for (const group of [
    {},
    { sort_order: 2 },
    { pangkat: 'III/a' },
    { sort_order: 2, pangkat: 'III/a' },
  ]) {
    const duplicate = { ...grade, ...group, id: 2, nominal: 2873500 };
    assert.throws(() => exportSnapshot({ users: [], letters: [], salary_grades: [grade, duplicate] }), /EXPORT_DUPLICATE_SALARY/);
  }
});

test('snapshot input must contain all tables; invalid values fail without raw content', () => {
  assert.throws(() => exportSnapshot({}), /EXPORT_MISSING_TABLE/);
  assert.throws(() => exportSnapshot({ users: [], letters: [{ created_at: 'sensitive-invalid' }], salary_grades: [] }), /EXPORT_INVALID_INTEGER/);
  assert.throws(() => parseWranglerResults('[{"success":true,"results":[]}]'), /EXPORT_INVALID_WRANGLER_RESPONSE/);
  assert.deepEqual(parseWranglerResults(JSON.stringify(Array.from({ length: 3 }, () => ({ success: true, results: [] })))), { users: [], salary_grades: [], letters: [] });
});

test('read-only SQLite snapshot reads all tables and never modifies source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipsid-export-'));
  try {
    const path = join(dir, 'source.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE users (id INTEGER); CREATE TABLE letters (id TEXT); CREATE TABLE salary_grades (id INTEGER); INSERT INTO users VALUES(1);');
    db.close();
    const before = await readFile(path);
    assert.equal(readSqliteSnapshot(path).users[0].id, 1);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manifest validation checks exact counts and canonical checksums, fails closed on drift', async () => {
  const { db, snapshot } = await fixture();
  try {
    const manifest = { status: 'READY', sqlWritten: true, tables: {} };
    for (const table of ['users', 'letters', 'salary_grades']) {
      manifest.tables[table === 'salary_grades' ? 'salary' : table] = { rowsImported: snapshot[table].length, checksum: canonicalChecksum(table, snapshot[table]) };
    }
    assert.equal(validateManifest(snapshot, manifest).users.checksumMatches, true);
    snapshot.letters[0].nama = 'changed';
    assert.throws(() => validateManifest(snapshot, manifest), /EXPORT_MANIFEST_MISMATCH/);
    assert.throws(() => validateManifest(snapshot, { ...manifest, status: 'QUARANTINE_REVIEW_REQUIRED' }), /EXPORT_MANIFEST_NOT_READY/);
  } finally { db.close(); }
});

test('CLI requires explicit read target, rejects ambiguous flags and unignored output', async () => {
  const messages = [];
  const io = { log: x => messages.push(x), error: x => messages.push(x) };
  assert.equal(await runCli([], io), 1);
  assert.equal(await runCli(['--database', 'test'], io), 1);
  assert.equal(await runCli(['--database', 'test', '--local', '--remote'], io), 1);
  assert.equal(await runCli(['--database', 'test', '--remote'], io), 1);
  assert.match(messages.at(-1), /EXPORT_REMOTE_FREEZE_REQUIRED/);
  assert.equal(await runCli(['--sqlite', 'test', '--remote'], io), 1);
  assert.equal(await runCli(['--snapshot', 'unused', '--out', 'not-ignored-export'], io), 1);
  assert.ok(messages.every(x => !x.includes('sha256$')));
});

test('end-to-end CLI writes ignored CSV without leaking names/NIP/hash to stdout or report; refuses overwrite', async () => {
  const { db, snapshot } = await fixture();
  const inputDir = await mkdtemp(join(tmpdir(), 'sipsid-export-cli-'));
  const output = resolve('migration-data', `test-export-${process.pid}-${Date.now()}`);
  try {
    const input = join(inputDir, 'snapshot.json');
    await writeFile(input, JSON.stringify(snapshot));
    const proc = spawnSync(process.execPath, ['scripts/export-d1-to-csv.mjs', '--snapshot', input, '--out', output], { encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    const report = await readFile(join(output, 'export-report.json'), 'utf8');
    for (const secret of [snapshot.users[0].password_hash, snapshot.letters[0].nama, snapshot.letters[0].nip, snapshot.letters[0].sign_nip]) {
      assert.equal((proc.stdout + proc.stderr + report).includes(secret), false);
    }
    assert.equal(parseCSV(await readFile(join(output, 'Database_Surat.csv'), 'utf8'))[1][1], snapshot.letters[0].id);
    const repeated = spawnSync(process.execPath, ['scripts/export-d1-to-csv.mjs', '--snapshot', input, '--out', output], { encoding: 'utf8' });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /EXPORT_OUTPUT_EXISTS/);
  } finally { db.close(); await rm(inputDir, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('exporter refuses a junction under ignored output pointing outside repository', async () => {
  const target = await mkdtemp(join(tmpdir(), 'sipsid-export-link-'));
  const link = resolve('migration-data', `test-junction-${process.pid}-${Date.now()}`);
  try {
    await mkdir(resolve('migration-data'), { recursive: true });
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const messages = [];
    const result = await runCli(['--snapshot', 'unused', '--out', join(link, 'nested')], { log: x => messages.push(x), error: x => messages.push(x) });
    assert.equal(result, 1);
    assert.match(messages.join('\n'), /EXPORT_OUTPUT_SYMLINK/);
  } finally { await rm(link, { force: true, recursive: true }); await rm(target, { force: true, recursive: true }); }
});
