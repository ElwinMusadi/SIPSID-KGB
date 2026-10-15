import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseCSV,
  parseDate,
  parseRupiah,
  maskNip,
  normalizePangkat,
  analyzeRequestIdBackfill,
  auditUsers,
  auditLetters,
  auditSalary,
  auditAll,
  formatStdoutSummary,
  runCli,
  isMainModule,
  NTT_REGIONS
} from '../scripts/audit-sheets.mjs';

// Synthetic sample password hashes matching ^sha256\$[0-9a-f]{32}\$[0-9a-fA-F]{64}$
const SYNTHETIC_HASH_ADMIN = 'sha256$abcdef0123456789abcdef0123456789$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SYNTHETIC_HASH_STAFF = 'sha256$11112222333344445555666677778888$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ─── 1. RFC-4180 CSV Parser Tests ───────────────────────────────────────────
test('CSV parser: parses simple comma separated values', () => {
  const input = 'a,b,c\n1,2,3';
  const result = parseCSV(input);
  assert.deepEqual(result, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('CSV parser: handles CRLF and LF line endings', () => {
  const input = 'col1,col2\r\nval1,val2\nval3,val4\r\n';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['col1', 'col2'],
    ['val1', 'val2'],
    ['val3', 'val4']
  ]);
});

test('CSV parser: handles quoted fields with commas', () => {
  const input = 'id,name,address\n1,"Doe, Jane","City, State"';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['id', 'name', 'address'],
    ['1', 'Doe, Jane', 'City, State']
  ]);
});

test('CSV parser: handles escaped quotes ("")', () => {
  const input = 'col1,col2\n"Hello ""World""","Quote: ""Test"""';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['col1', 'col2'],
    ['Hello "World"', 'Quote: "Test"']
  ]);
});

test('CSV parser: handles embedded newlines inside quotes', () => {
  const input = 'id,memo\n1,"Line one\nLine two\r\nLine three"\n2,simple';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['id', 'memo'],
    ['1', 'Line one\nLine two\r\nLine three'],
    ['2', 'simple']
  ]);
});

test('CSV parser: handles empty fields and lines', () => {
  const input = 'a,,c\n,,\n';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['a', '', 'c'],
    ['', '', '']
  ]);
});

test('CSV parser: tolerates multiple trailing empty lines', () => {
  const input = 'a,b\n1,2\n\n\r\n\n';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['a', 'b'],
    ['1', '2']
  ]);
});

test('CSV parser: strips leading UTF-8 BOM and parses quoted first header field', () => {
  const input = '\uFEFF"username","password","namaLengkap","hakAkses"\n"admin1","hash","Admin","admin"';
  const result = parseCSV(input);
  assert.deepEqual(result, [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['admin1', 'hash', 'Admin', 'admin']
  ]);
});

test('CSV parser: throws on unclosed quote', () => {
  const input = 'col1,col2\n"unclosed quote,val2';
  assert.throws(() => parseCSV(input), /Unclosed quote in CSV/);
});

// ─── 2. Date Parsing Tests ───────────────────────────────────────────────────
test('Date parser: parses valid ISO dates with and without time suffix', () => {
  const res1 = parseDate('2026-10-15');
  assert.equal(res1.valid, true);
  assert.equal(res1.iso, '2026-10-15');

  const res2 = parseDate('2026-10-15 00:00:00');
  assert.equal(res2.valid, true);
  assert.equal(res2.iso, '2026-10-15');

  const res3 = parseDate('2026-10-15T08:30:00Z');
  assert.equal(res3.valid, true);
  assert.equal(res3.iso, '2026-10-15');
});

test('Date parser: rejects invalid calendar ISO dates (e.g. Feb 30, Apr 31)', () => {
  assert.equal(parseDate('2026-02-30').valid, false);
  assert.equal(parseDate('2026-04-31').valid, false);
  assert.equal(parseDate('2025-02-29').valid, false); // 2025 not leap year
  assert.equal(parseDate('2024-02-29').valid, true);  // 2024 is leap year
});

test('Date parser: parses D/M/YYYY, D.M.YYYY, D-M-YYYY with and without time suffix', () => {
  const d1 = parseDate('15/10/2026');
  assert.equal(d1.valid, true);
  assert.equal(d1.iso, '2026-10-15');

  const d2 = parseDate('15/10/2026 0:00:00');
  assert.equal(d2.valid, true);
  assert.equal(d2.iso, '2026-10-15');

  const d3 = parseDate('5.2.2026 08:30');
  assert.equal(d3.valid, true);
  assert.equal(d3.iso, '2026-02-05');

  const d4 = parseDate('15-10-2026');
  assert.equal(d4.valid, true);
  assert.equal(d4.iso, '2026-10-15');

  assert.equal(parseDate('31/04/2026 0:00:00').valid, false);
});

test('Date parser: parses Indonesian and English month names (including sept and time suffix)', () => {
  const d1 = parseDate('15 Oktober 2026');
  assert.equal(d1.valid, true);
  assert.equal(d1.iso, '2026-10-15');

  const d2 = parseDate('15 Okt 2026 00:00:00');
  assert.equal(d2.valid, true);
  assert.equal(d2.iso, '2026-10-15');

  const d3 = parseDate('15 September 2026');
  assert.equal(d3.valid, true);
  assert.equal(d3.iso, '2026-09-15');

  const d4 = parseDate('15 Sept 2026');
  assert.equal(d4.valid, true);
  assert.equal(d4.iso, '2026-09-15');

  const d5 = parseDate('15 August 2026');
  assert.equal(d5.valid, true);
  assert.equal(d5.iso, '2026-08-15');

  const d6 = parseDate('15 Aug 2026');
  assert.equal(d6.valid, true);
  assert.equal(d6.iso, '2026-08-15');

  const d7 = parseDate('15 October 2026');
  assert.equal(d7.valid, true);
  assert.equal(d7.iso, '2026-10-15');

  const d8 = parseDate('15 Oct 2026');
  assert.equal(d8.valid, true);
  assert.equal(d8.iso, '2026-10-15');

  const d9 = parseDate('15 Dec 2026');
  assert.equal(d9.valid, true);
  assert.equal(d9.iso, '2026-12-15');

  const d10 = parseDate('15 May 2026');
  assert.equal(d10.valid, true);
  assert.equal(d10.iso, '2026-05-15');
});

test('Date parser: accepts serial numbers within 18264–73050 and rejects outside', () => {
  const sValid = parseDate('45000');
  assert.equal(sValid.valid, true);
  assert.equal(sValid.isSerial, true);
  assert.equal(sValid.year, 2023);

  // 18264 is 1950-01-01
  const sMin = parseDate('18264');
  assert.equal(sMin.valid, true);
  assert.equal(sMin.isSerial, true);
  assert.equal(sMin.iso, '1950-01-01');

  // 73050 is 2099-12-31
  const sMax = parseDate('73050');
  assert.equal(sMax.valid, true);
  assert.equal(sMax.isSerial, true);
  assert.equal(sMax.iso, '2099-12-31');

  // Out of range serial dates are rejected
  assert.equal(parseDate('18263').valid, false);
  assert.equal(parseDate('73051').valid, false);
  assert.equal(parseDate('1000').valid, false);
});

// ─── 3. Rupiah Salary Parsing Tests ──────────────────────────────────────────
test('Rupiah parser: parses valid integer rupiah forms including en-locale thousands', () => {
  assert.equal(parseRupiah('Rp. 4.123.400,-').value, 4123400);
  assert.equal(parseRupiah('Rp 4.123.400').value, 4123400);
  assert.equal(parseRupiah('4123400').value, 4123400);
  assert.equal(parseRupiah('Rp. 4.123.400,00').value, 4123400);
  assert.equal(parseRupiah('4123400.00').value, 4123400);

  // en-locale thousands
  assert.equal(parseRupiah('4,123,400').value, 4123400);
  assert.equal(parseRupiah('4,123,400.00').value, 4123400);
  assert.equal(parseRupiah('0').value, 0);
  assert.equal(parseRupiah('Rp 0').value, 0);
});

test('Rupiah parser: flags non-zero decimals as blocking error', () => {
  assert.equal(parseRupiah('4123400.50').valid, false);
  assert.equal(parseRupiah('4123400.50').hasNonZeroDecimals, true);

  assert.equal(parseRupiah('Rp. 4.123.400,50').valid, false);
  assert.equal(parseRupiah('Rp. 4.123.400,50').hasNonZeroDecimals, true);

  assert.equal(parseRupiah('4,123,400.50').valid, false);
  assert.equal(parseRupiah('4,123,400.50').hasNonZeroDecimals, true);
});

test('Rupiah parser: rejects values exceeding Number.MAX_SAFE_INTEGER', () => {
  const overMax = '9007199254740992'; // MAX_SAFE_INTEGER + 1
  const res = parseRupiah(overMax);
  assert.equal(res.valid, false);
  assert.equal(res.isOverMaxSafeInteger, true);
});

// ─── 4. NIP Masking Tests ────────────────────────────────────────────────────
test('NIP masking: masks length and first two digits only', () => {
  const masked1 = maskNip('198501012010011001');
  assert.equal(masked1, '18 digit, 19…');

  const masked2 = maskNip('1985');
  assert.equal(masked2, '4 digit, 19…');

  const maskedTrunc = maskNip('1.98E+17');
  assert.equal(maskedTrunc, '8 digit, 1.…');

  assert.equal(masked1.includes('2010011001'), false);
});

// ─── 5. Pangkat Normalization Tests ──────────────────────────────────────────
test('normalizePangkat: EXACT mirror of Index.html normalizePangkat (lowercase)', () => {
  assert.equal(normalizePangkat('Penata (III/c)'), 'iii/c');
  assert.equal(normalizePangkat('Penata Tingkat I (III/d)'), 'iii/d');
  assert.equal(normalizePangkat('Golongan IX'), 'ix');
  assert.equal(normalizePangkat('Golongan (IX)'), 'ix');
  assert.equal(normalizePangkat('IX'), 'ix');
  assert.equal(normalizePangkat('Golongan VII'), 'vii');
});

// ─── 6. Request ID Backfill Analysis Tests ───────────────────────────────────
test('analyzeRequestIdBackfill: classifies qualified, format failure, and cross-year duplicates', () => {
  const items = [
    { id: 'KGB-2024-req-unique-1' },
    { id: 'KGB-2023-dup-suffix' },
    { id: 'KGB-2024-dup-suffix' },
    { id: 'KGB-2024-REQ-UPPERCASE' },
    { id: 'SURAT-2024-001' },
    { id: 'KGB-2024-' }
  ];

  const analysis = analyzeRequestIdBackfill(items);
  assert.equal(analysis.qualified, 1);
  assert.equal(analysis.nullCrossYearDuplicate, 2);
  assert.equal(analysis.nullCaseFormat, 3);
});

// ─── 7. Master_User Auditing Tests ───────────────────────────────────────────
test('Master_User audit: clean rows pass with 0 blocking issues', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['admin1', SYNTHETIC_HASH_ADMIN, 'Synthetic Admin One', 'admin'],
    ['staff1', SYNTHETIC_HASH_STAFF, 'Synthetic Staff One', 'pengelola']
  ];
  const result = auditUsers(csv);
  assert.equal(result.rowsRead, 2);
  assert.equal(result.wouldImport, 2);
  assert.equal(result.blockingCount, 0);
  assert.equal(result.adminCount, 1);
});

test('Master_User audit: blank row skipped with WARN BLANK_ROW_SKIPPED', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['admin1', SYNTHETIC_HASH_ADMIN, 'Synthetic Admin One', 'admin'],
    ['', '   ', '', ''],
    ['staff1', SYNTHETIC_HASH_STAFF, 'Synthetic Staff One', 'pengelola']
  ];
  const result = auditUsers(csv);
  assert.equal(result.rowsRead, 3);
  assert.equal(result.wouldImport, 2);
  assert.equal(result.skipped, 1);
  assert.ok(result.issues.some(i => i.code === 'BLANK_ROW_SKIPPED' && i.row === 3));
});

test('Master_User audit: duplicate username ignoring case is BLOCKING', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['admin1', SYNTHETIC_HASH_ADMIN, 'Admin One', 'admin'],
    ['ADMIN1', SYNTHETIC_HASH_STAFF, 'Admin Two', 'admin']
  ];
  const result = auditUsers(csv);
  assert.equal(result.blockingCount, 1);
  assert.ok(result.issues.some(i => i.code === 'DUPLICATE_USERNAME'));
});

test('Master_User audit: empty username is BLOCKING', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['', SYNTHETIC_HASH_ADMIN, 'Admin One', 'admin']
  ];
  const result = auditUsers(csv);
  assert.ok(result.issues.some(i => i.code === 'EMPTY_USERNAME'));
  assert.equal(result.blockingCount >= 1, true);
});

test('Master_User audit: plaintext or malformed password hash is BLOCKING and value is never in report', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['admin1', 'plaintextPassword123', 'Admin One', 'admin']
  ];
  const result = auditUsers(csv);
  assert.ok(result.issues.some(i => i.code === 'INVALID_PASSWORD_HASH'));
  assert.equal(result.blockingCount >= 1, true);

  const json = JSON.stringify(result);
  assert.equal(json.includes('plaintextPassword123'), false);
});

test('Master_User audit: zero admins after normalization is BLOCKING', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['staff1', SYNTHETIC_HASH_STAFF, 'Staff One', 'pengelola']
  ];
  const result = auditUsers(csv);
  assert.ok(result.issues.some(i => i.code === 'ZERO_ADMINS'));
  assert.equal(result.blockingCount >= 1, true);
});

test('Master_User audit: role normalization (administrator->admin, invalid->pengelola) without leaking raw input values', () => {
  const csv = [
    ['username', 'password', 'namaLengkap', 'hakAkses'],
    ['admin1', SYNTHETIC_HASH_ADMIN, '', 'administrator'],
    ['staff1', SYNTHETIC_HASH_STAFF, 'Staff', 'secret_internal_role']
  ];
  const result = auditUsers(csv);
  assert.equal(result.blockingCount, 0);
  assert.equal(result.adminCount, 1);
  assert.equal(result.roleNormalizationCount, 2);

  // Message should NOT leak raw role
  const json = JSON.stringify(result);
  assert.equal(json.includes('secret_internal_role'), false);
});

// ─── 8. Database_Surat Auditing Tests ────────────────────────────────────────
function createValidSyntheticLetterRow(overrides = {}) {
  const base = [
    '2026-10-15 08:00:00',
    'KGB-2026-req-synthetic-01',
    'PNS',
    'Synthetic Pegawai Name',
    '198501012010011001',
    'Penata (III/c)',
    'Pranata Komputer Ahli Muda',
    'Dinas Komunikasi dan Informatika',
    'Kota Kupang',
    'Gubernur NTT',
    '2026-10-01 00:00:00',
    '800/123/BKD',
    '2026-11-01 0:00:00',
    '4',
    '0',
    'Rp. 4.123.400,-',
    '6',
    '0',
    '2026-11-01',
    'Rp 4.350.000',
    '800/456/DISRO',
    '2026-10-15 00:00:00',
    'Kepala Dinas',
    'Synthetic Penandatangan Name',
    'Pembina (IV/a)',
    '197501012000011002',
    'legal'
  ];

  for (const [colIndex, val] of Object.entries(overrides)) {
    base[Number(colIndex)] = val;
  }
  return base;
}

test('Database_Surat audit: clean letter row passes with 0 blocking issues', () => {
  const header = ['timestamp', 'id', 'statusPegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'kabkot', 'skPejabat', 'skTanggal', 'skNomor', 'skTmt', 'mkLamaThn', 'mkLamaBln', 'gajiLama', 'mkBaruThn', 'mkBaruBln', 'gajiBaruTmt', 'gajiBaru', 'suratNomor', 'suratTanggal', 'signJabatan', 'signNama', 'signPangkat', 'signNip', 'ukuranKertas'];
  const row1 = createValidSyntheticLetterRow();
  const result = auditLetters([header, row1]);

  assert.equal(result.rowsRead, 1);
  assert.equal(result.wouldImport, 1);
  assert.equal(result.blockingCount, 0);
});

test('Database_Surat audit: blank row skipped with WARN BLANK_ROW_SKIPPED', () => {
  const header = ['timestamp', 'id'];
  const rowBlank = ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  const result = auditLetters([header, rowBlank]);

  assert.equal(result.rowsRead, 1);
  assert.equal(result.wouldImport, 0);
  assert.equal(result.skipped, 1);
  assert.ok(result.issues.some(i => i.code === 'BLANK_ROW_SKIPPED'));
});

test('Database_Surat audit: serial date interpreted emits WARN SERIAL_DATE_INTERPRETED', () => {
  const header = ['timestamp', 'id'];
  const rowSerial = createValidSyntheticLetterRow({ 10: '45000' }); // serial date for skTanggal
  const result = auditLetters([header, rowSerial]);

  assert.equal(result.blockingCount, 0);
  assert.ok(result.issues.some(i => i.code === 'SERIAL_DATE_INTERPRETED' && i.field === 'skTanggal'));
});

test('Database_Surat audit: empty B is skipped with WARN (ignored like listLetters_)', () => {
  const header = ['timestamp', 'id'];
  const rowEmptyB = createValidSyntheticLetterRow({ 1: '' });
  const result = auditLetters([header, rowEmptyB]);

  assert.equal(result.rowsRead, 1);
  assert.equal(result.wouldImport, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.blockingCount, 0);
  assert.ok(result.issues.some(i => i.code === 'EMPTY_LETTER_ID_SKIPPED'));
});

test('Database_Surat audit: duplicate id is BLOCKING', () => {
  const header = ['timestamp', 'id'];
  const row1 = createValidSyntheticLetterRow({ 1: 'KGB-2026-same-id' });
  const row2 = createValidSyntheticLetterRow({ 1: 'KGB-2026-same-id' });
  const result = auditLetters([header, row1, row2]);

  assert.equal(result.blockingCount, 1);
  assert.ok(result.issues.some(i => i.code === 'DUPLICATE_ID'));
});

test('Database_Surat audit: id length > 200 is BLOCKING', () => {
  const header = ['timestamp', 'id'];
  const rowLongId = createValidSyntheticLetterRow({ 1: 'KGB-2026-' + 'a'.repeat(200) });
  const result = auditLetters([header, rowLongId]);

  assert.equal(result.blockingCount, 1);
  assert.ok(result.issues.some(i => i.code === 'ID_OVER_LENGTH'));
});

test('Database_Surat audit: unparseable required dates is BLOCKING', () => {
  const header = ['timestamp', 'id'];
  const rowBadDate = createValidSyntheticLetterRow({ 10: '31/04/2026' }); // invalid Apr 31
  const result = auditLetters([header, rowBadDate]);

  assert.equal(result.blockingCount, 1);
  assert.ok(result.issues.some(i => i.code === 'UNPARSEABLE_DATE' && i.field === 'skTanggal'));
});

test('Database_Surat audit: non-integer / non-zero decimal salary is BLOCKING', () => {
  const header = ['timestamp', 'id'];
  const rowBadSalary = createValidSyntheticLetterRow({ 15: '4123400.50' });
  const result = auditLetters([header, rowBadSalary]);

  assert.equal(result.blockingCount, 1);
  assert.ok(result.issues.some(i => i.code === 'SALARY_NON_ZERO_DECIMALS'));
});

test('Database_Surat audit: truncated NIP in scientific notation is BLOCKING and masked', () => {
  const header = ['timestamp', 'id'];
  const rowTruncNip = createValidSyntheticLetterRow({ 4: '1.98501E+17' });
  const result = auditLetters([header, rowTruncNip]);

  assert.equal(result.blockingCount, 1);
  const issue = result.issues.find(i => i.code === 'NIP_TRUNCATED');
  assert.ok(issue);
  assert.equal(issue.maskedNip.includes('1.98501E+17'), false);
});

test('Database_Surat audit: masa kerja out of range is BLOCKING (e.g. mkBaruThn 0)', () => {
  const header = ['timestamp', 'id'];
  const rowEmptyMkBaru = createValidSyntheticLetterRow({ 16: '' });
  const result = auditLetters([header, rowEmptyMkBaru]);

  assert.equal(result.blockingCount, 1);
  assert.ok(result.issues.some(i => i.code === 'MK_OUT_OF_RANGE' && i.field === 'mkBaruThn'));
});

// ─── 9. Master_Gaji_Pangkat Auditing Tests ───────────────────────────────────
test('Master_Gaji_Pangkat audit: clean PNS and PPPK rows pass with 0 blocking issues', () => {
  const rows = [
    ['Status', 'Pangkat / Golongan', 'MKG 0 Tahun', 'MKG 2 Tahun'],
    ['PNS', 'Penata (III/c)', 'Rp 3.026.400', 'Rp 3.121.700'],
    ['PPPK', 'Golongan IX', 'Rp 3.203.600', 'Rp 3.304.500']
  ];
  const result = auditSalary(rows);

  assert.equal(result.rowsRead, 2);
  assert.equal(result.wouldImport, 2);
  assert.equal(result.blockingCount, 0);
});

test('Master_Gaji_Pangkat audit: blank row skipped with WARN BLANK_ROW_SKIPPED', () => {
  const rows = [
    ['Status', 'Pangkat / Golongan', 'MKG 0 Tahun'],
    ['PNS', 'Penata (III/c)', 'Rp 3.026.400'],
    ['', '', '']
  ];
  const result = auditSalary(rows);

  assert.equal(result.rowsRead, 2);
  assert.equal(result.wouldImport, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.issues.some(i => i.code === 'BLANK_ROW_SKIPPED'));
});

test('Master_Gaji_Pangkat audit: empty pangkat row is skipped with WARN EMPTY_PANGKAT_SKIPPED', () => {
  const rows = [
    ['Status', 'Pangkat / Golongan', 'MKG 0 Tahun', 'MKG 2 Tahun'],
    ['PNS', '', 'Rp 3.026.400', 'Rp 3.121.700'],
    ['PNS', 'Penata (III/c)', 'Rp 3.026.400', 'Rp 3.121.700']
  ];
  const result = auditSalary(rows);

  assert.equal(result.rowsRead, 2);
  assert.equal(result.wouldImport, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.blockingCount, 0); // Not duplicate because empty pangkat was skipped
  assert.ok(result.issues.some(i => i.code === 'EMPTY_PANGKAT_SKIPPED'));
});

test('Master_Gaji_Pangkat audit: duplicate (status, golongan code, mkg) is BLOCKING', () => {
  const rows = [
    ['Status', 'Pangkat / Golongan', 'MKG 0 Tahun', 'MKG 2 Tahun'],
    ['PNS', 'Penata (III/c)', 'Rp 3.026.400', 'Rp 3.121.700'],
    ['PNS', 'Penata Tingkat (III/c)', 'Rp 3.026.400', 'Rp 3.121.700']
  ];
  const result = auditSalary(rows);

  assert.equal(result.blockingCount, 2);
  assert.ok(result.issues.some(i => i.code === 'DUPLICATE_SALARY_ENTRY'));
});

test('Master_Gaji_Pangkat audit: zero detection uses parsed value === 0 and skips with WARN', () => {
  const rows = [
    ['Status', 'Pangkat / Golongan', 'MKG 0 Tahun'],
    ['PNS', 'Penata (III/c)', 'Rp 0']
  ];
  const result = auditSalary(rows);

  assert.equal(result.blockingCount, 0);
  assert.ok(result.issues.some(i => i.code === 'ZERO_OR_EMPTY_CELL_SKIPPED'));
});

// ─── 10. CLI, Flags, Privacy & End-to-End Tests ──────────────────────────────
test('CLI: no inputs given returns usage error and exit code 1', () => {
  const exitCode = runCli([]);
  assert.equal(exitCode, 1);
});

test('CLI: --require-all returns exit code 1 when missing any sheet, 0 when all present and clean', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-reqall-'));
  const usersPath = path.join(tmpDir, 'users.csv');
  const lettersPath = path.join(tmpDir, 'letters.csv');
  const salaryPath = path.join(tmpDir, 'salary.csv');
  const outPath = path.join(tmpDir, 'out.json');

  fs.writeFileSync(usersPath, `username,password,namaLengkap,hakAkses\nadmin1,${SYNTHETIC_HASH_ADMIN},Admin,admin\n`);
  fs.writeFileSync(lettersPath, `timestamp,id,statusPegawai,nama,nip,pangkat,jabatan,unit,kabkot,skPejabat,skTanggal,skNomor,skTmt,mkLamaThn,mkLamaBln,gajiLama,mkBaruThn,mkBaruBln,gajiBaruTmt,gajiBaru,suratNomor,suratTanggal,signJabatan,signNama,signPangkat,signNip,ukuranKertas\n2026-10-15,KGB-2026-valid-01,PNS,Pegawai,198501012010011001,Penata (III/c),Jabatan,Unit,Kota Kupang,Pejabat,2026-10-01,123,2026-11-01,4,0,Rp. 4.000.000,6,0,2026-11-01,Rp. 4.200.000,456,2026-10-15,Kadis,Penandatangan,Pembina (IV/a),197501012000011002,legal\n`);
  fs.writeFileSync(salaryPath, `Status,Pangkat,MKG 0 Tahun\nPNS,Penata (III/c),Rp 3.000.000\n`);

  // Missing salary -> exit 1
  assert.equal(runCli(['--require-all', '--users', usersPath, '--letters', lettersPath, '--out', outPath]), 1);

  // All 3 present -> exit 0
  assert.equal(runCli(['--require-all', '--users', usersPath, '--letters', lettersPath, '--salary', salaryPath, '--out', outPath]), 0);
});

test('End-to-End CLI: neither stdout NOR written JSON contains full synthetic NIP, name, or password', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-e2e-'));
  const usersPath = path.join(tmpDir, 'users.csv');
  const lettersPath = path.join(tmpDir, 'letters.csv');
  const outPath = path.join(tmpDir, 'report.json');

  const secretPlaintextPass = 'SuperSecretPlaintextPassword999';
  const syntheticNip1 = '198501012010011001';
  const syntheticNip2 = '197501012000011002';
  const syntheticPegawaiName = 'SecretEmployeeNameX';
  const syntheticSignName = 'SecretSignerNameY';

  // Master_User with plaintext password
  fs.writeFileSync(usersPath, `username,password,namaLengkap,hakAkses\nadmin1,${secretPlaintextPass},${syntheticPegawaiName},admin\n`);

  // Database_Surat with non-standard NIP and scientific notation signNip
  fs.writeFileSync(lettersPath, `timestamp,id,statusPegawai,nama,nip,pangkat,jabatan,unit,kabkot,skPejabat,skTanggal,skNomor,skTmt,mkLamaThn,mkLamaBln,gajiLama,mkBaruThn,mkBaruBln,gajiBaruTmt,gajiBaru,suratNomor,suratTanggal,signJabatan,signNama,signPangkat,signNip,ukuranKertas\n2026-10-15,KGB-2026-test-01,PNS,${syntheticPegawaiName},${syntheticNip1},Penata (III/c),Jabatan,Unit,Kota Kupang,Pejabat,2026-10-01,123,2026-11-01,4,0,Rp. 4.000.000,6,0,2026-11-01,Rp. 4.200.000,456,2026-10-15,Kadis,${syntheticSignName},Pembina (IV/a),1.97501E+17,legal\n`);

  // Intercept stdout
  let stdoutCaptured = '';
  const originalLog = console.log;
  console.log = (...args) => {
    stdoutCaptured += args.join(' ') + '\n';
  };

  let exitCode;
  try {
    exitCode = runCli(['--users', usersPath, '--letters', lettersPath, '--out', outPath]);
  } finally {
    console.log = originalLog;
  }

  // exit code 2 (blocking issues: plaintext password, truncated signNip)
  assert.equal(exitCode, 2);

  const reportJson = fs.readFileSync(outPath, 'utf8');

  // Verify stdout does not contain sensitive data
  assert.equal(stdoutCaptured.includes(secretPlaintextPass), false);
  assert.equal(stdoutCaptured.includes(syntheticNip1), false);
  assert.equal(stdoutCaptured.includes(syntheticNip2), false);
  assert.equal(stdoutCaptured.includes(syntheticPegawaiName), false);
  assert.equal(stdoutCaptured.includes(syntheticSignName), false);

  // Verify written JSON does not contain sensitive data
  assert.equal(reportJson.includes(secretPlaintextPass), false);
  assert.equal(reportJson.includes(syntheticNip1), false);
  assert.equal(reportJson.includes(syntheticNip2), false);
  assert.equal(reportJson.includes(syntheticPegawaiName), false);
  assert.equal(reportJson.includes(syntheticSignName), false);
});

test('Windows-safe CLI entry point invocation via child_process', () => {
  const scriptPath = path.resolve('scripts/audit-sheets.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-child-'));
  const usersPath = path.join(tmpDir, 'users.csv');
  const outPath = path.join(tmpDir, 'report.json');

  fs.writeFileSync(usersPath, `username,password,namaLengkap,hakAkses\nadmin1,${SYNTHETIC_HASH_ADMIN},Admin,admin\n`);

  const proc = spawnSync(process.execPath, [scriptPath, '--users', usersPath, '--out', outPath], {
    encoding: 'utf8'
  });

  assert.equal(proc.status, 0);
  assert.ok(fs.existsSync(outPath));

  // No inputs invocation
  const procNoInputs = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8'
  });
  assert.equal(procNoInputs.status, 1);
});
