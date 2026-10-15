// Offline-first rollback export. No writes to D1 or Google Sheets are performed.
// A remote read is possible only with explicit --database NAME --remote.
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { formatRupiah } from '../src/server/format.js';
import { canonicalChecksum, tableAggregates } from './migrate-sheets-to-d1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = ['users', 'salary_grades', 'letters'];
const LETTER_COLUMNS = ['id', 'status_pegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'kabkot',
  'sk_pejabat', 'sk_tanggal', 'sk_nomor', 'sk_tmt', 'mk_lama_thn', 'mk_lama_bln', 'gaji_lama',
  'mk_baru_thn', 'mk_baru_bln', 'gaji_baru_tmt', 'gaji_baru', 'surat_nomor', 'surat_tanggal',
  'sign_jabatan', 'sign_nama', 'sign_pangkat', 'sign_nip', 'ukuran_kertas'];
const LETTER_HEADERS = ['Timestamp', 'id', 'statusPegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'kabkot',
  'skPejabat', 'skTanggal', 'skNomor', 'skTmt', 'mkLamaThn', 'mkLamaBln', 'gajiLama',
  'mkBaruThn', 'mkBaruBln', 'gajiBaruTmt', 'gajiBaru', 'suratNomor', 'suratTanggal',
  'signJabatan', 'signNama', 'signPangkat', 'signNip', 'ukuranKertas'];
const USAGE = 'Usage: node scripts/export-d1-to-csv.mjs (--sqlite <snapshot.sqlite> | --snapshot <rows.json> | --database <name> (--local | --remote --ack-frozen)) [--env <name>] [--persist-to <dir>] [--out <ignored-dir>] [--manifest <manifest.json>] [--allow-password-reset]';

/** RFC-4180 escaping plus spreadsheet-formula neutralization on textual cells. */
export function csvCell(value, { formulaSafe = true } = {}) {
  let text = value == null ? '' : String(value);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('EXPORT_CONTROL_CHARACTER');
  if (formulaSafe && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function toCsv(rows) {
  return rows.map(row => row.map(value => csvCell(value)).join(',')).join('\r\n') + '\r\n';
}

export function witaTimestamp(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) throw new Error('EXPORT_INVALID_TIMESTAMP');
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw new Error('EXPORT_INVALID_TIMESTAMP');
  // Preserve milliseconds so offline export -> reimport is lossless.
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, -1);
}

function numeric(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('EXPORT_INVALID_INTEGER');
  return value;
}

/** Convert a complete, consistent DB snapshot to the original three sheet layouts. */
export function exportSnapshot(snapshot, { allowPasswordReset = false } = {}) {
  for (const table of TABLES) if (!Array.isArray(snapshot?.[table])) throw new Error('EXPORT_MISSING_TABLE');
  const users = [...snapshot.users].sort((a, b) => a.id - b.id);
  const letters = [...snapshot.letters].sort((a, b) => a.seq - b.seq);
  const salary = [...snapshot.salary_grades].sort((a, b) => a.sort_order - b.sort_order || a.mkg - b.mkg || a.id - b.id);
  const resetRows = [];
  const userCsvRows = [['username', 'password', 'namaLengkap', 'hakAkses']];
  for (const user of users) {
    let hash = user.password_hash;
    if (!/^sha256\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{64}$/.test(hash || '')) {
      if (!/^pbkdf2_sha256\$/.test(hash || '') || !allowPasswordReset) throw new Error('EXPORT_PASSWORD_RESET_REQUIRED');
      resetRows.push(userCsvRows.length + 1);
      hash = ''; // Deliberately disables login until owner resets on GAS; never export plaintext.
    }
    if (!['admin', 'pengelola'].includes(user.role)) throw new Error('EXPORT_INVALID_ROLE');
    userCsvRows.push([user.username, hash, user.nama_lengkap, user.role]);
  }
  const letterCsvRows = [LETTER_HEADERS];
  for (const letter of letters) {
    const row = LETTER_COLUMNS.map(key => letter[key] ?? '');
    row[14] = formatRupiah(numeric(letter.gaji_lama));
    row[18] = formatRupiah(numeric(letter.gaji_baru));
    letterCsvRows.push([witaTimestamp(letter.created_at), ...row]);
  }
  const groups = new Map();
  const seenSalaryKeys = new Set();
  for (const grade of salary) {
    if (!['PNS', 'PPPK'].includes(grade.status_pegawai) || !Number.isInteger(grade.mkg) || grade.mkg < 0 || grade.mkg > 40) throw new Error('EXPORT_INVALID_SALARY');
    const naturalKey = JSON.stringify([grade.status_pegawai, grade.golongan_code, grade.mkg]);
    if (seenSalaryKeys.has(naturalKey)) throw new Error('EXPORT_DUPLICATE_SALARY');
    seenSalaryKeys.add(naturalKey);
    const key = JSON.stringify([grade.status_pegawai, grade.golongan_code, grade.sort_order, grade.pangkat]);
    if (!groups.has(key)) groups.set(key, [grade.status_pegawai, grade.pangkat, ...Array(41).fill('')]);
    const row = groups.get(key);
    row[grade.mkg + 2] = String(numeric(grade.nominal));
  }
  return {
    files: {
      'Master_User.csv': toCsv(userCsvRows),
      'Database_Surat.csv': toCsv(letterCsvRows),
      'Master_Gaji_Pangkat.csv': toCsv([['Status', 'Pangkat', ...Array.from({ length: 41 }, (_, i) => `MKG ${i} Tahun`)], ...groups.values()]),
    },
    report: {
      counts: { users: users.length, letters: letters.length, salaryGrades: salary.length, salaryRows: groups.size },
      checksums: Object.fromEntries(TABLES.map(table => [table, canonicalChecksum(table, snapshot[table])])),
      aggregates: Object.fromEntries(TABLES.map(table => [table, tableAggregates(table, snapshot[table])])),
      passwordResetRequiredRows: resetRows,
      note: 'Full snapshot only. Reconcile existing rows and deletions by ID before unfreezing GAS. Import NIP and identifiers as text. CSV text cells are formula-neutralized.',
    },
  };
}

export function readSqliteSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN'); // SQLite offline snapshot only; not sent to D1.
    const snapshot = Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    db.exec('ROLLBACK');
    return snapshot;
  } finally { db.close(); }
}

export function parseWranglerResults(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data) || data.length !== TABLES.length || data.some(x => x.success !== true || !Array.isArray(x.results))) throw new Error('EXPORT_INVALID_WRANGLER_RESPONSE');
  return Object.fromEntries(TABLES.map((table, i) => [table, data[i].results]));
}

/** Compare exact migrated table values, not merely counts. No PII in failures. */
export function validateManifest(snapshot, manifest) {
  if (manifest?.status !== 'READY' || manifest.sqlWritten !== true || !manifest.tables) throw new Error('EXPORT_MANIFEST_NOT_READY');
  const tableKeys = { users: 'users', letters: 'letters', salary_grades: 'salary' };
  const validation = {};
  for (const table of TABLES) {
    const expected = manifest.tables[tableKeys[table]];
    const rows = snapshot?.[table];
    if (!expected || !Array.isArray(rows)) throw new Error('EXPORT_MANIFEST_INVALID');
    validation[table] = { countMatches: rows.length === expected.rowsImported, checksumMatches: canonicalChecksum(table, rows) === expected.checksum,
      aggregatesMatch: expected.aggregates ? JSON.stringify(tableAggregates(table, rows)) === JSON.stringify(expected.aggregates) : true };
  }
  if (Object.values(validation).some(x => !x.countMatches || !x.checksumMatches || !x.aggregatesMatch)) throw new Error('EXPORT_MANIFEST_MISMATCH');
  return validation;
}

function readWranglerSnapshot(args) {
  const entry = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(entry)) throw new Error('EXPORT_WRANGLER_UNAVAILABLE');
  // Fixed SELECTs, not user SQL. Multiple statements in one invocation reduce
  // drift, but remote operators MUST freeze application writes before export.
  const argv = [entry, 'd1', 'execute', args.database, args.remote ? '--remote' : '--local', '--json', '--command', TABLES.map(t => `SELECT * FROM ${t};`).join(' ')];
  if (args.env) argv.push('--env', args.env);
  if (args.persistTo) argv.push('--persist-to', args.persistTo);
  const proc = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true });
  if (proc.error || proc.status !== 0) throw new Error('EXPORT_D1_READ_FAILED'); // Do not echo CLI stdout/stderr (PII).
  return parseWranglerResults(proc.stdout);
}

async function verifyOutputDir(path) {
  const dir = resolve(path);
  const root = await realpath(ROOT);
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('EXPORT_OUTPUT_MUST_BE_IGNORED');
  let ancestor = dir;
  while (ancestor !== root) {
    try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('EXPORT_OUTPUT_SYMLINK'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    ancestor = dirname(ancestor);
  }
  // --quiet accepts one path only; verify every output extension separately.
  for (const name of ['Master_User.csv', 'export-report.json']) {
    if (spawnSync('git', ['check-ignore', '--quiet', '--', join(dir, name)], { cwd: ROOT, windowsHide: true }).status !== 0) throw new Error('EXPORT_OUTPUT_MUST_BE_IGNORED');
  }
  for (const name of ['Master_User.csv', 'Database_Surat.csv', 'Master_Gaji_Pangkat.csv', 'export-report.json']) {
    try { await lstat(join(dir, name)); throw new Error('EXPORT_OUTPUT_EXISTS'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return dir;
}

export async function runCli(argv = process.argv.slice(2), io = console) {
  try {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (['--local', '--remote', '--ack-frozen', '--allow-password-reset'].includes(key)) {
        args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      } else if (['--sqlite', '--snapshot', '--database', '--env', '--persist-to', '--out', '--manifest'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (args[name] !== undefined) throw new Error('EXPORT_USAGE');
        args[name] = argv[++i];
      } else throw new Error('EXPORT_USAGE');
    }
    if ([args.sqlite, args.snapshot, args.database].filter(Boolean).length !== 1 || (args.database && Boolean(args.local) === Boolean(args.remote)) || (!args.database && (args.local || args.remote || args.env || args.persistTo)) || (args.remote && args.persistTo)) throw new Error('EXPORT_USAGE');
    if (args.remote && !args.ackFrozen) throw new Error('EXPORT_REMOTE_FREEZE_REQUIRED');
    const dir = await verifyOutputDir(args.out || join(ROOT, 'migration-data', 'rollback'));
    const snapshot = args.sqlite ? readSqliteSnapshot(resolve(args.sqlite)) : args.snapshot ? JSON.parse(await readFile(args.snapshot, 'utf8')) : readWranglerSnapshot(args);
    const result = exportSnapshot(snapshot, { allowPasswordReset: args.allowPasswordReset });
    if (args.manifest) result.report.manifestValidation = validateManifest(snapshot, JSON.parse(await readFile(args.manifest, 'utf8')));
    await mkdir(dir, { recursive: true });
    for (const [name, csv] of Object.entries(result.files)) await writeFile(join(dir, name), csv, { flag: 'wx', mode: 0o600 });
    await writeFile(join(dir, 'export-report.json'), JSON.stringify(result.report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    io.log('PERINGATAN: CSV berisi data pribadi dan hash password. Jangan di-commit atau dipublikasikan.');
    io.log(`Ekspor selesai: users=${result.report.counts.users}, letters=${result.report.counts.letters}, salary=${result.report.counts.salaryGrades}. Reset password wajib: ${result.report.passwordResetRequiredRows.length} baris.`);
    return 0;
  } catch (e) {
    const code = /^EXPORT_[A-Z_]+$/.test(e?.message || '') ? e.message : 'EXPORT_FAILED';
    io.error(`Ekspor gagal: ${code}. Tidak ada perubahan pada database.\n${USAGE}`);
    return 1;
  }
}

const currentPath = process.argv[1] && resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
if (currentPath && (process.platform === 'win32' ? currentPath.toLowerCase() === modulePath.toLowerCase() : currentPath === modulePath)) process.exitCode = await runCli();
