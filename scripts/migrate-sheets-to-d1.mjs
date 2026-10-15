#!/usr/bin/env node
/**
 * Fase 2a: offline CSV → D1 seeds. No DB connection, dependencies, or clock reads.
 * All transforms accept parsed CSV rows INCLUDING the header and return rows plus
 * privacy-safe diagnostics. ABORTs always suppress SQL, even with allow-quarantine.
 *
 * Canonical checksum v1 (also used by the future D1 exporter):
 * - column order is exactly TABLE_COLUMNS below, including explicit IDs/audit columns;
 * - users/salary_grades sorted by numeric id, letters by id (UTF-8 byte order);
 * - NULL is U+0000 (a reserved, rejected input control), integers base 10, text unchanged;
 * - columns joined with U+001F, rows with U+001E, no final separator;
 * - SHA-256 of those UTF-8 bytes, lowercase hex (empty table hashes empty bytes).
 * Reserved controls cannot occur in imported text, so NULL, empty text, literal
 * "NULL", column separators and row separators have distinct encodings.
 *
 * Counters: rowsRead/rowsSkipped/rowsQuarantined count SOURCE data rows (not header).
 * rowsImported counts OUTPUT records (salary is unpivoted). Salary cells with no
 * digits or zero are skipped, per GAS normalizeNominalGaji_; cellsSkipped reports
 * them separately. A salary source row with any blocking cell is quarantined whole.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseCSV, parseDate, parseRupiah, isValidCalendarDate, normalizePangkat,
  maskNip, analyzeRequestIdBackfill, NTT_REGIONS,
} from './audit-sheets.mjs';

export const TABLE_COLUMNS = Object.freeze({
  users: Object.freeze(['id', 'username', 'password_hash', 'nama_lengkap', 'role',
    'session_version', 'version', 'created_at', 'updated_at']),
  salary_grades: Object.freeze(['id', 'status_pegawai', 'pangkat', 'golongan_code',
    'mkg', 'nominal', 'sort_order', 'created_at', 'updated_at']),
  letters: Object.freeze(['id', 'request_id', 'status_pegawai', 'nama', 'nip', 'pangkat',
    'jabatan', 'unit', 'kabkot', 'sk_pejabat', 'sk_tanggal', 'sk_nomor', 'sk_tmt',
    'mk_lama_thn', 'mk_lama_bln', 'gaji_lama', 'mk_baru_thn', 'mk_baru_bln',
    'gaji_baru_tmt', 'gaji_baru', 'surat_nomor', 'surat_tanggal', 'sign_jabatan',
    'sign_nama', 'sign_pangkat', 'sign_nip', 'ukuran_kertas', 'created_by',
    'updated_by', 'seq', 'version', 'created_at', 'updated_at']),
});
const LETTER_LAYOUT = [
  'timestamp', 'id', 'status_pegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit',
  'kabkot', 'sk_pejabat', 'sk_tanggal', 'sk_nomor', 'sk_tmt', 'mk_lama_thn',
  'mk_lama_bln', 'gaji_lama', 'mk_baru_thn', 'mk_baru_bln', 'gaji_baru_tmt',
  'gaji_baru', 'surat_nomor', 'surat_tanggal', 'sign_jabatan', 'sign_nama',
  'sign_pangkat', 'sign_nip', 'ukuran_kertas',
];
const REQUIRED_TEXT = {
  id: 200, nama: 180, nip: 180, pangkat: 180, jabatan: 300, unit: 300,
  sk_pejabat: 180, sk_nomor: 180, surat_nomor: 180, sign_jabatan: 180,
  sign_nama: 180, sign_pangkat: 180, sign_nip: 180,
};
const DATE_FIELDS = ['sk_tanggal', 'sk_tmt', 'gaji_baru_tmt', 'surat_tanggal'];
const MK_RULES = { mk_lama_thn: [0, 40], mk_lama_bln: [0, 11],
  mk_baru_thn: [1, 40], mk_baru_bln: [0, 11] };
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const MAX_STATEMENT_BYTES = 100_000; // Conservative decimal KB; strictly less than 100 KB.
const WITA_MS = 8 * 60 * 60 * 1000;
const rawText = (value) => String(value ?? '');
const text = (value) => rawText(value).trim();
const blank = (row) => row.every((value) => !text(value) && !CONTROLS.test(rawText(value)));
const charLength = (value) => [...value].length; // SQLite length(TEXT): Unicode code points.
const issue = (row, field, code) => ({ row, field, code });
function result(rows) {
  return { rows: [], rowsRead: Math.max(0, rows.length - 1), rowsImported: 0,
    rowsSkipped: 0, rowsQuarantined: 0, quarantine: [], reports: [], aborts: [] };
}
function quarantineRow(out, issues) {
  out.rowsQuarantined++;
  out.quarantine.push(...issues);
}
function checkText(issues, row, field, value, max, required = true) {
  if (required && !value) issues.push(issue(row, field, 'REQUIRED_FIELD_EMPTY'));
  if (charLength(value) > max) issues.push(issue(row, field, 'FIELD_OVER_LENGTH'));
}
function checkControls(issues, rowNum, row, fields) {
  fields.forEach((field, col) => {
    if (CONTROLS.test(rawText(row[col]))) issues.push(issue(rowNum, field, 'CONTROL_CHARACTER'));
  });
}
function migrationTimestamp(options) {
  const value = typeof options === 'string' ? options : options?.migratedAt;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('MIGRATED_AT_INVALID');
  }
  return value;
}

export function transformUsers(rows, options) {
  const at = migrationTimestamp(options);
  const out = result(rows);
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const n = r + 1;
    if (blank(row)) {
      out.rowsSkipped++;
      out.reports.push(issue(n, 'row', 'BLANK_ROW_SKIPPED'));
      continue;
    }
    const username = text(row[0]);
    const password = rawText(row[1]); // Do not trim, lowercase, or repair a credential.
    const passwordValid = password.length === 104 && /^sha256\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{64}$/.test(password);
    if (!passwordValid) out.aborts.push(issue(n, 'password_hash', 'INVALID_PASSWORD_HASH'));
    const key = username.toLowerCase();
    if (username && seen.has(key)) out.aborts.push(issue(n, 'username', 'DUPLICATE_USERNAME'));
    seen.add(key);
    const issues = [];
    checkControls(issues, n, row, ['username', 'password_hash', 'nama_lengkap', 'role']);
    const nama = text(row[2]) || username;
    checkText(issues, n, 'username', username, 100);
    checkText(issues, n, 'nama_lengkap', nama, 160);
    const roleText = text(row[3]).toLowerCase();
    const role = ['admin', 'administrator'].includes(roleText) ? 'admin' : 'pengelola';
    if (!['admin', 'pengelola'].includes(roleText)) out.reports.push(issue(n, 'role', 'ROLE_NORMALIZED'));
    if (!text(row[2])) out.reports.push(issue(n, 'nama_lengkap', 'NAME_DEFAULTED_TO_USERNAME'));
    if (issues.length) { quarantineRow(out, issues); continue; }
    // Never return an invalid/plaintext credential as a transformed row, even on ABORT.
    if (!passwordValid) continue;
    out.rows.push({ id: out.rows.length + 1, username, password_hash: password,
      nama_lengkap: nama, role, session_version: 1, version: 1, created_at: at, updated_at: at });
  }
  out.rowsImported = out.rows.length;
  if (!out.rows.some((row) => row.role === 'admin')) out.aborts.push(issue(1, 'role', 'ZERO_ADMINS'));
  return out;
}

export function transformSalary(rows, options) {
  const at = migrationTimestamp(options);
  const out = result(rows);
  out.cellsSkipped = 0;
  const columns = [];
  (rows[0] ?? []).forEach((header, col) => {
    const match = col >= 2 && rawText(header).match(/MKG\s*(\d+)\s*Tahun/i);
    if (match) columns.push({ col, mkg: Number(match[1]) });
  });
  // The runtime orders by sort_order, then mkg. Descending source headers cannot
  // retain GAS left-to-right parity with the required sort_order = source row.
  if (columns.some((column, index) => index && column.mkg < columns[index - 1].mkg)) {
    out.aborts.push(issue(1, 'header', 'MKG_HEADER_ORDER_UNSUPPORTED'));
  }
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const n = r + 1;
    const status = text(row[0]).toUpperCase();
    const pangkat = text(row[1]);
    const skipCode = blank(row) ? 'BLANK_ROW_SKIPPED' : !pangkat ? 'EMPTY_PANGKAT_SKIPPED'
      : !['PNS', 'PPPK'].includes(status) ? 'STATUS_NOT_PNS_PPPK_SKIPPED' : null;
    if (skipCode) {
      out.rowsSkipped++;
      out.reports.push(issue(n, 'row', skipCode));
      continue;
    }
    const issues = [];
    const code = normalizePangkat(pangkat);
    checkControls(issues, n, row.slice(0, 2), ['status_pegawai', 'pangkat']);
    checkText(issues, n, 'pangkat', pangkat, 120);
    checkText(issues, n, 'golongan_code', code, 20);
    const candidates = [];
    for (const { col, mkg } of columns) {
      const field = `column_${col + 1}`; // Never echo untrusted CSV headers.
      if (CONTROLS.test(rawText(row[col]))) issues.push(issue(n, field, 'CONTROL_CHARACTER'));
      // CSV is display text: exactly the digits-only branch of GAS normalizeNominalGaji_.
      // Intentionally NOT parseRupiah: e.g. "100,00" becomes 10000 in the GAS master.
      const digits = text(row[col]).replace(/[^0-9]/g, '');
      if (!digits || /^0+$/.test(digits)) {
        out.cellsSkipped++;
        out.reports.push(issue(n, field, 'ZERO_OR_EMPTY_CELL_SKIPPED'));
        continue;
      }
      const nominal = Number(digits);
      if (!Number.isSafeInteger(nominal) || nominal <= 0) issues.push(issue(n, field, 'SALARY_OVER_MAX_SAFE_INTEGER'));
      if (!Number.isInteger(mkg) || mkg < 0 || mkg > 40) issues.push(issue(n, field, 'MKG_OUT_OF_RANGE'));
      const key = JSON.stringify([status, code, mkg]);
      if (seen.has(key)) out.aborts.push(issue(n, field, 'DUPLICATE_SALARY_ENTRY'));
      seen.add(key);
      candidates.push({ status_pegawai: status, pangkat, golongan_code: code, mkg,
        nominal, sort_order: r, created_at: at, updated_at: at });
    }
    if (issues.length) { quarantineRow(out, issues); continue; }
    if (!candidates.length) { out.rowsSkipped++; continue; }
    for (const candidate of candidates) out.rows.push({ id: out.rows.length + 1, ...candidate });
  }
  out.rowsImported = out.rows.length;
  return out;
}

// Documented local timestamp formats, plus optional .sss from the offline exporter
// (lossless rollback archive). Never Date.parse(local), never host timezone inference.
function localTimestamp(raw) {
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/);
  let parts;
  if (match) parts = match.slice(1).map((value) => Number(value ?? 0));
  else {
    match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, d, m, y, h, min, s] = match.map(Number);
    parts = [y, m, d, h, min, s, 0];
  }
  const [y, m, d, h, min, s, ms] = parts;
  if (!isValidCalendarDate(y, m, d) || h > 23 || min > 59 || s > 59) return null;
  return new Date(Date.UTC(y, m - 1, d, h, min, s, ms) - WITA_MS).toISOString();
}

export function transformLetters(rows) {
  const out = result(rows);
  const seen = new Set();
  // Analyze ALL nonempty IDs before quarantine: cross-year collisions stay NULL even
  // when one of the source rows needs repair. Never narrow the uniqueness dataset.
  const backfill = analyzeRequestIdBackfill(rows.slice(1).map((row, r) => ({
    id: rawText(row[1]), rowNumber: r + 2,
  })).filter((item) => text(item.id)));
  const requests = new Map(backfill.classified.map((item) => [item.rowNumber,
    item.status === 'QUALIFIED' ? item.suffix : null]));
  out.requestIdBackfill = { qualified: backfill.qualified, nullCaseFormat: backfill.nullCaseFormat,
    nullCrossYearDuplicate: backfill.nullCrossYearDuplicate };
  for (let r = 1; r < rows.length; r++) {
    const source = rows[r];
    const n = r + 1;
    if (!text(source[1])) {
      out.rowsSkipped++;
      out.reports.push(issue(n, 'id', blank(source) ? 'BLANK_ROW_SKIPPED' : 'EMPTY_LETTER_ID_SKIPPED'));
      continue;
    }
    // ID is intentionally not trimmed in storage (9.2: preserve as-is).
    const id = rawText(source[1]);
    if (seen.has(id)) out.aborts.push(issue(n, 'id', 'DUPLICATE_ID'));
    seen.add(id);
    const issues = [];
    checkControls(issues, n, source, LETTER_LAYOUT);
    const row = Object.fromEntries(LETTER_LAYOUT.slice(1).map((field, index) => [field, text(source[index + 1])]));
    row.id = id;
    row.status_pegawai = row.status_pegawai.toUpperCase();
    if (!['PNS', 'PPPK'].includes(row.status_pegawai)) issues.push(issue(n, 'status_pegawai', 'INVALID_STATUS_PEGAWAI'));
    for (const [field, max] of Object.entries(REQUIRED_TEXT)) checkText(issues, n, field, row[field], max);
    checkText(issues, n, 'kabkot', row.kabkot, 180, false);
    for (const field of ['nip', 'sign_nip']) {
      const value = row[field];
      // Match audit E+ rule and full scientific notation (including a negative exponent).
      if (/E\+/i.test(value) || /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(value)) {
        issues.push({ ...issue(n, field, 'NIP_TRUNCATED'), maskedNip: maskNip(value) });
      } else if (value && !/^\d{18}$/.test(value)) {
        out.reports.push({ ...issue(n, field, 'NIP_NON_STANDARD'), maskedNip: maskNip(value) });
      }
    }
    for (const field of DATE_FIELDS) {
      const parsed = parseDate(row[field]);
      if (!parsed.valid) issues.push(issue(n, field, 'UNPARSEABLE_DATE'));
      else {
        row[field] = parsed.iso;
        if (parsed.isSerial) out.reports.push(issue(n, field, 'SERIAL_DATE_INTERPRETED'));
      }
    }
    for (const field of ['gaji_lama', 'gaji_baru']) {
      const parsed = parseRupiah(row[field]);
      if (!parsed.valid) issues.push(issue(n, field, parsed.hasNonZeroDecimals ? 'SALARY_NON_ZERO_DECIMALS'
        : parsed.isOverMaxSafeInteger ? 'SALARY_OVER_MAX_SAFE_INTEGER' : 'SALARY_NOT_INTEGER_RUPIAH'));
      else row[field] = parsed.value;
    }
    for (const [field, [min, max]] of Object.entries(MK_RULES)) {
      const value = row[field] || '0';
      if (!/^\d+$/.test(value)) issues.push(issue(n, field, 'MK_NOT_INTEGER'));
      else if (!Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
        issues.push(issue(n, field, 'MK_OUT_OF_RANGE'));
      }
      row[field] = Number(value);
    }
    const timestamp = text(source[0]);
    let createdAt = localTimestamp(timestamp);
    if (!createdAt) {
      out.reports.push(issue(n, 'timestamp', timestamp ? 'TIMESTAMP_UNPARSEABLE' : 'TIMESTAMP_EMPTY'));
      const date = parseDate(row.surat_tanggal);
      if (date.valid) createdAt = new Date(Date.UTC(date.year, date.month - 1, date.day) - WITA_MS).toISOString();
    }
    if (row.kabkot && !NTT_REGIONS.has(row.kabkot)) out.reports.push(issue(n, 'kabkot', 'KABKOT_UNKNOWN'));
    row.kabkot ||= null;
    row.ukuran_kertas = row.ukuran_kertas.toLowerCase();
    if (!['a4', 'legal'].includes(row.ukuran_kertas)) out.reports.push(issue(n, 'ukuran_kertas', 'UKURAN_KERTAS_FALLBACK'));
    row.ukuran_kertas = row.ukuran_kertas === 'a4' ? 'a4' : 'legal';
    if (issues.length) { quarantineRow(out, issues); continue; }
    delete row.timestamp;
    out.rows.push({ ...row, request_id: requests.get(n) ?? null, seq: r, version: 1,
      created_by: null, updated_by: null, created_at: createdAt, updated_at: createdAt });
  }
  out.rowsImported = out.rows.length;
  return out;
}

/** SQL literal, never SQL identifiers; reject unsupported types and unsafe numbers. */
export function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && !CONTROLS.test(value)) return `'${value.replace(/'/g, "''")}'`;
  throw new TypeError('INVALID_SQL_VALUE');
}

/** Returns complete statements including ;\n. At most 50 rows, strictly <100,000 UTF-8 bytes. */
export function renderInsertStatements(table, rows) {
  const columns = TABLE_COLUMNS[table];
  if (!columns) throw new TypeError('INVALID_TABLE');
  const prefix = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
  const statements = [];
  let tuples = [];
  let bytes = Buffer.byteLength(prefix) + 2; // ;\n
  const flush = () => {
    if (tuples.length) statements.push(`${prefix}${tuples.join(',\n')};\n`);
    tuples = [];
    bytes = Buffer.byteLength(prefix) + 2;
  };
  for (const row of rows) {
    const tuple = `(${columns.map((column) => sqlLiteral(row[column])).join(', ')})`;
    const size = Buffer.byteLength(tuple);
    if (Buffer.byteLength(prefix) + size + 2 >= MAX_STATEMENT_BYTES) throw new RangeError('SQL_ROW_TOO_LARGE');
    if (tuples.length >= 50 || bytes + size + (tuples.length ? 2 : 0) >= MAX_STATEMENT_BYTES) flush();
    bytes += size + (tuples.length ? 2 : 0);
    tuples.push(tuple);
  }
  flush();
  return statements;
}

export function canonicalChecksum(table, rows) {
  const columns = TABLE_COLUMNS[table];
  if (!columns) throw new TypeError('INVALID_TABLE');
  const ordered = [...rows].sort((a, b) => table === 'letters'
    ? Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)) : a.id - b.id);
  const hash = createHash('sha256');
  ordered.forEach((row, index) => {
    if (index) hash.update('\u001e');
    hash.update(columns.map((column) => {
      const value = row[column];
      if (value === null) return '\u0000';
      if (typeof value === 'string' && !CONTROLS.test(value)) return value;
      if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      throw new TypeError('INVALID_CANONICAL_VALUE');
    }).join('\u001f'), 'utf8');
  });
  return hash.digest('hex');
}

function counts(rows, field, nullKey) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field] === null ? nullKey : row[field];
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
}
// Exact totals: normal totals are JSON numbers; totals beyond MAX_SAFE_INTEGER
// are decimal strings rather than silently rounded. The exporter shares this rule.
function sumInteger(rows, field) {
  const sum = rows.reduce((total, row) => total + BigInt(row[field]), 0n);
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) && sum >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(sum) : String(sum);
}
export function tableAggregates(table, rows) {
  if (!TABLE_COLUMNS[table]) throw new TypeError('INVALID_TABLE');
  if (table === 'users') return { count: rows.length, adminCount: rows.filter((r) => r.role === 'admin').length };
  if (table === 'salary_grades') return { count: rows.length, perStatus: counts(rows, 'status_pegawai') };
  const dates = rows.map((r) => r.surat_tanggal).sort();
  return { count: rows.length, sumGajiBaru: sumInteger(rows, 'gaji_baru'),
    sumGajiLama: sumInteger(rows, 'gaji_lama'), distinctNip: new Set(rows.map((r) => r.nip)).size,
    minSuratTanggal: dates[0] ?? null, maxSuratTanggal: dates.at(-1) ?? null,
    perStatusPegawai: counts(rows, 'status_pegawai'), perKabkot: counts(rows, 'kabkot', '(kosong)'),
    requestIdNonNull: rows.filter((r) => r.request_id !== null).length };
}
function tableManifest(table, transformed) {
  const { rows, rowsRead, rowsImported, rowsSkipped, rowsQuarantined, reports, cellsSkipped } = transformed;
  return { rowsRead, rowsImported, rowsSkipped, rowsQuarantined,
    ...(cellsSkipped === undefined ? {} : { cellsSkipped }), aggregates: tableAggregates(table, rows),
    checksum: canonicalChecksum(table, rows), reports };
}

// Resolve existing ancestors so junctions/symlinks cannot bypass the in-repo ignore check.
function realDestination(target) {
  let ancestor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('OUTPUT_PATH_INVALID');
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function checkedOutput(target) {
  const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' });
  if (repo.status !== 0) throw new Error('GIT_REPO_CHECK_FAILED');
  const root = fs.realpathSync(repo.stdout.trim());
  const resolved = path.resolve(target);
  const real = realDestination(resolved);
  for (const candidate of new Set([resolved, real])) {
    if (!isWithin(root, candidate)) continue;
    const relative = path.relative(root, candidate).split(path.sep).join('/');
    const check = spawnSync('git', ['check-ignore', '-q', '--', `${relative}/`], { cwd: root, encoding: 'utf8' });
    if (!relative || check.status !== 0) throw new Error('OUTPUT_NOT_GIT_IGNORED');
  }
  return real;
}
const OUTPUT_SQL = /^(?:01_users|02_salary_grades|03_letters_\d+)\.seed\.sql$/;
function removeStaleSql(outDir) {
  for (const name of fs.readdirSync(outDir)) {
    if (OUTPUT_SQL.test(name)) fs.unlinkSync(path.join(outDir, name));
  }
}
function writePrivate(outDir, name, data) {
  const target = path.join(outDir, name);
  // Do not follow a pre-existing output-file symlink outside the checked directory.
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('OUTPUT_SYMLINK');
  fs.writeFileSync(target, data, { encoding: 'utf8', mode: 0o600 });
}

export function runCli(argv = process.argv.slice(2)) {
  const options = { out: 'migration-data/seed', allowQuarantine: false };
  const allowed = new Set(['--users', '--letters', '--salary', '--out', '--migrated-at']);
  const provided = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--allow-quarantine' && !options.allowQuarantine) { options.allowQuarantine = true; continue; }
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: node scripts/migrate-sheets-to-d1.mjs --users <csv> --letters <csv> --salary <csv> --migrated-at <YYYY-MM-DDTHH:mm:ss.sssZ> [--out <dir>] [--allow-quarantine]');
      return 0;
    }
    if (!allowed.has(flag) || provided.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      console.error('USAGE_ERROR'); return 1;
    }
    provided.add(flag);
    options[flag.slice(2)] = argv[++i];
  }
  if (!options.users || !options.letters || !options.salary || !options['migrated-at']) {
    console.error('USAGE_ERROR: users, letters, salary and migrated-at are required'); return 1;
  }
  try {
    migrationTimestamp(options['migrated-at']);
  } catch {
    console.error('MIGRATED_AT_INVALID'); return 1;
  }
  console.log('WARNING: CSV and generated SQL contain PII and password hashes. Keep private; never commit; delete after validation. Quarantine review is not cutover approval.');
  let outDir;
  let transformed;
  try {
    outDir = checkedOutput(options.out);
    // Read inputs only; no recursive traversal and no discovery of migration-data contents.
    const readCsv = (name) => parseCSV(fs.readFileSync(options[name], 'utf8'));
    transformed = {
      users: transformUsers(readCsv('users'), options['migrated-at']),
      salary: transformSalary(readCsv('salary'), options['migrated-at']),
      letters: transformLetters(readCsv('letters')),
    };
  } catch (error) {
    console.error(error.message === 'OUTPUT_NOT_GIT_IGNORED' ? 'OUTPUT_NOT_GIT_IGNORED' : 'INPUT_OR_OUTPUT_ERROR');
    return 1; // Never echo exception text, input values, or paths.
  }
  const aborts = Object.entries(transformed).flatMap(([table, value]) => value.aborts.map((entry) => ({ table, ...entry })));
  const quarantined = Object.values(transformed).reduce((sum, value) => sum + value.rowsQuarantined, 0);
  const exitCode = aborts.length || quarantined ? 2 : 0;
  const sqlAllowed = !aborts.length && (!quarantined || options.allowQuarantine);
  try {
    // ABORT runs do not checksum potentially malformed/plaintext credential rows.
    const tables = {};
    for (const [name, value] of Object.entries(transformed)) {
      if (aborts.length) {
        tables[name] = { rowsRead: value.rowsRead, rowsImported: 0, rowsSkipped: value.rowsSkipped,
          rowsQuarantined: value.rowsQuarantined, reports: value.reports };
      } else tables[name] = tableManifest(name === 'salary' ? 'salary_grades' : name, value);
    }
    const manifest = { formatVersion: 1, migratedAt: options['migrated-at'],
      status: aborts.length ? 'ABORT' : quarantined ? 'QUARANTINE_REVIEW_REQUIRED' : 'READY',
      exitCode, sqlWritten: sqlAllowed, tables, aborts, files: [] };
    const seeds = [];
    if (sqlAllowed) {
      seeds.push(['01_users.seed.sql', renderInsertStatements('users', transformed.users.rows).join('')]);
      seeds.push(['02_salary_grades.seed.sql', renderInsertStatements('salary_grades', transformed.salary.rows).join('')]);
      for (let i = 0; i < transformed.letters.rows.length; i += 1000) {
        seeds.push([`03_letters_${String(i / 1000 + 1).padStart(3, '0')}.seed.sql`,
          renderInsertStatements('letters', transformed.letters.rows.slice(i, i + 1000)).join('')]);
      }
      manifest.files = seeds.map(([name]) => name);
    }
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    // A failed/quarantined re-run must not leave old, apparently importable seeds.
    removeStaleSql(outDir);
    const quarantine = Object.entries(transformed).flatMap(([table, value]) => value.quarantine.map((entry) => ({ table, ...entry })));
    writePrivate(outDir, 'quarantine.json', `${JSON.stringify(quarantine, null, 2)}\n`);
    for (const [name, sql] of seeds) writePrivate(outDir, name, sql);
    writePrivate(outDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    console.error('OUTPUT_WRITE_ERROR'); return 1;
  }
  for (const [name, value] of Object.entries(transformed)) {
    console.log(`${name}: read=${value.rowsRead} imported=${aborts.length ? 0 : value.rowsImported} skipped=${value.rowsSkipped} quarantined=${value.rowsQuarantined}`);
  }
  console.log(`status=${aborts.length ? 'ABORT' : quarantined ? 'QUARANTINE_REVIEW_REQUIRED' : 'READY'} exit=${exitCode}`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = runCli();
}
