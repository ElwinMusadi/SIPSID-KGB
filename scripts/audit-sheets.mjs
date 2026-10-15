#!/usr/bin/env node

/**
 * Fase 0 steps 6–7: Data-audit tooling for SIPSID-KGB migration from Google Spreadsheet to Cloudflare D1.
 * Read-only audit tool for CSV exports of:
 *   - Master_User
 *   - Database_Surat
 *   - Master_Gaji_Pangkat
 *
 * Privacy rules:
 *   - STDOUT shows counts, row numbers, and issue codes only. NEVER passwords, hashes, NIPs, or names.
 *   - JSON report masks NIP (e.g. "18 digit, 19…") and NEVER includes password or name values.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ─── 22 Known NTT Regions (from Index.html) ──────────────────────────────────
export const NTT_REGIONS = new Set([
  'Kabupaten Alor',
  'Kabupaten Belu',
  'Kabupaten Ende',
  'Kabupaten Flores Timur',
  'Kabupaten Kupang',
  'Kabupaten Lembata',
  'Kabupaten Malaka',
  'Kabupaten Manggarai',
  'Kabupaten Manggarai Barat',
  'Kabupaten Manggarai Timur',
  'Kabupaten Nagekeo',
  'Kabupaten Ngada',
  'Kabupaten Rote Ndao',
  'Kabupaten Sabu Raijua',
  'Kabupaten Sikka',
  'Kabupaten Sumba Barat',
  'Kabupaten Sumba Barat Daya',
  'Kabupaten Sumba Tengah',
  'Kabupaten Sumba Timur',
  'Kabupaten Timor Tengah Selatan',
  'Kabupaten Timor Tengah Utara',
  'Kota Kupang'
]);

// ─── Month Names (Indonesian & English, full & abbreviations) ─────────────────
export const MONTH_NAMES = {
  // Indonesian
  januari: 1, jan: 1,
  februari: 2, pebruari: 2, feb: 2,
  maret: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  agustus: 8, agu: 8, ags: 8, agt: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10,
  november: 11, nopember: 11, nov: 11,
  desember: 12, des: 12,

  // English
  january: 1,
  february: 2,
  march: 3,
  may: 5,
  june: 6,
  july: 7,
  august: 8, aug: 8,
  october: 10, oct: 10,
  december: 12, dec: 12
};

// ─── RFC-4180 CSV Parser ─────────────────────────────────────────────────────
export function parseCSV(content) {
  if (typeof content !== 'string') {
    throw new TypeError('Expected content to be a string');
  }

  // Strip leading UTF-8 BOM if present
  let text = content;
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        currentField += char;
        i++;
      }
    } else {
      if (char === '"' && currentField.length === 0) {
        inQuotes = true;
        i++;
      } else if (char === ',') {
        currentRow.push(currentField);
        currentField = '';
        i++;
      } else if (char === '\r') {
        if (i + 1 < len && text[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
      } else if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
      } else {
        currentField += char;
        i++;
      }
    }
  }

  if (inQuotes) {
    throw new Error('Unclosed quote in CSV');
  }

  if (currentRow.length > 0 || currentField.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  // Tolerate multiple trailing empty lines (rows with a single empty string created by trailing newlines)
  while (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    if (lastRow.length === 1 && lastRow[0] === '') {
      rows.pop();
    } else {
      break;
    }
  }

  return rows;
}

// ─── Privacy Helper: NIP Masking ─────────────────────────────────────────────
export function maskNip(raw) {
  if (raw == null) return '0 digit';
  const str = String(raw).trim();
  const len = str.length;
  if (len === 0) return '0 digit';
  if (len < 2) return `${len} digit`;
  const first2 = str.substring(0, 2);
  return `${len} digit, ${first2}…`;
}

// ─── Date Parsing ────────────────────────────────────────────────────────────
export function isValidCalendarDate(year, month, day) {
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number') return false;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const lastDay = new Date(year, month, 0).getDate();
  return day <= lastDay;
}

export function parseDate(raw) {
  if (raw == null) return { valid: false, reason: 'EMPTY' };
  const str = String(raw).trim();
  if (!str) return { valid: false, reason: 'EMPTY' };

  // 1. ISO format: YYYY-MM-DD followed by optional time suffix
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (isValidCalendarDate(year, month, day)) {
      return { valid: true, year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
    return { valid: false, reason: 'INVALID_CALENDAR_DATE' };
  }

  // 2. D/M/YYYY, D.M.YYYY, D-M-YYYY (day first) followed by optional time suffix
  const dmyMatch = str.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3]);
    if (isValidCalendarDate(year, month, day)) {
      return { valid: true, year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
    return { valid: false, reason: 'INVALID_CALENDAR_DATE' };
  }

  // 3. Month names (Indonesian / English) followed by optional time suffix
  const nameMatch = str.match(/^(\d{1,2})[\s\-/\.]*([A-Za-z]+)[\s\-/\.]+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (nameMatch) {
    const day = Number(nameMatch[1]);
    const monthStr = nameMatch[2].toLowerCase();
    const year = Number(nameMatch[3]);
    const month = MONTH_NAMES[monthStr];
    if (month && isValidCalendarDate(year, month, day)) {
      return { valid: true, year, month, day, iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
    return { valid: false, reason: month ? 'INVALID_CALENDAR_DATE' : 'UNRECOGNIZED_MONTH' };
  }

  // 4. Google Sheets serial numbers: accepted only within 18264–73050 (1950-01-01..2099-12-31)
  if (/^\d{1,6}(?:\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (num >= 18264 && num <= 73050) {
      const serialDays = Math.floor(num);
      const baseMs = Date.UTC(1899, 11, 30);
      const targetDate = new Date(baseMs + serialDays * 86400000);
      const year = targetDate.getUTCFullYear();
      const month = targetDate.getUTCMonth() + 1;
      const day = targetDate.getUTCDate();
      if (isValidCalendarDate(year, month, day)) {
        return {
          valid: true,
          year,
          month,
          day,
          iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          isSerial: true
        };
      }
    }
    return { valid: false, reason: 'SERIAL_OUT_OF_RANGE' };
  }

  return { valid: false, reason: 'UNPARSEABLE_FORMAT' };
}

// ─── Rupiah Salary Parser ────────────────────────────────────────────────────
export function parseRupiah(raw) {
  if (raw == null) return { valid: false, reason: 'EMPTY' };
  let str = String(raw).trim();
  if (!str) return { valid: false, reason: 'EMPTY' };

  str = str.replace(/^(?:Rp\.?|IDR)\s*/i, '').trim();
  if (!str) return { valid: false, reason: 'EMPTY' };

  if (str.endsWith(',-')) {
    str = str.slice(0, -2).trim();
  }

  // Check en-locale thousands: "4,123,400" (comma groups of exactly 3, no dot in int part)
  const enLocaleMatch = str.match(/^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/);
  if (enLocaleMatch) {
    const decPart = enLocaleMatch[2];
    if (decPart && /[1-9]/.test(decPart)) {
      return { valid: false, reason: 'NON_ZERO_DECIMALS', hasNonZeroDecimals: true };
    }
    str = enLocaleMatch[1].replace(/,/g, '');
  } else {
    // Check Indonesian comma decimal: e.g. "4.123.400,50" or "4123400,00"
    const commaDecimalMatch = str.match(/^(.*),(\d+)$/);
    if (commaDecimalMatch) {
      const intPart = commaDecimalMatch[1];
      const decPart = commaDecimalMatch[2];
      if (/[1-9]/.test(decPart)) {
        return { valid: false, reason: 'NON_ZERO_DECIMALS', hasNonZeroDecimals: true };
      }
      str = intPart;
    } else {
      // Check dot decimal: e.g. "4123400.50" or "4123400.00"
      const dotDecimalMatch = str.match(/^(.*)\.(\d+)$/);
      if (dotDecimalMatch) {
        const intPart = dotDecimalMatch[1];
        const decPart = dotDecimalMatch[2];
        const isThousandsSeparator = !intPart.includes('.') && decPart.length === 3;
        if (!isThousandsSeparator && !intPart.includes('.')) {
          if (/[1-9]/.test(decPart)) {
            return { valid: false, reason: 'NON_ZERO_DECIMALS', hasNonZeroDecimals: true };
          }
          str = intPart;
        }
      }
    }
  }

  const cleanDigits = str.replace(/[\.,\s]/g, '');
  if (!cleanDigits || !/^\d+$/.test(cleanDigits)) {
    return { valid: false, reason: 'NON_NUMERIC' };
  }

  // Check MAX_SAFE_INTEGER
  if (cleanDigits.length > 16 || BigInt(cleanDigits) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { valid: false, reason: 'OVER_MAX_SAFE_INTEGER', isOverMaxSafeInteger: true };
  }

  const value = parseInt(cleanDigits, 10);
  return { valid: true, value };
}

// ─── Pangkat Normalization (EXACT mirror of Index.html normalizePangkat) ─────
export function normalizePangkat(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const kodePns = normalized.match(/[iv]+\s*\/\s*[a-e]/);
  if (kodePns) return kodePns[0].replace(/\s+/g, '');

  const kodeDalamKurung = normalized.match(/\(([^)]+)\)/);
  const kodeGolongan = kodeDalamKurung ? kodeDalamKurung[1] : normalized;
  return kodeGolongan.replace(/^golongan\s+/, '').replace(/\s+/g, '');
}

// ─── Request ID Backfill Analysis ────────────────────────────────────────────
export function analyzeRequestIdBackfill(items) {
  const suffixCounts = new Map();
  const classified = [];

  for (const item of items) {
    const id = String(item.id || '').trim();
    const match = id.match(/^KGB-\d{4}-(.+)$/);
    if (!match) {
      classified.push({ ...item, status: 'NULL_CASE_OR_FORMAT' });
      continue;
    }
    const suffix = match[1];
    if (!/^[a-z0-9_-]{1,100}$/.test(suffix)) {
      classified.push({ ...item, status: 'NULL_CASE_OR_FORMAT' });
      continue;
    }
    suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
    classified.push({ ...item, suffix, status: 'PENDING' });
  }

  let qualified = 0;
  let nullCaseFormat = 0;
  let nullCrossYearDuplicate = 0;

  for (const c of classified) {
    if (c.status === 'NULL_CASE_OR_FORMAT') {
      nullCaseFormat++;
    } else {
      const count = suffixCounts.get(c.suffix);
      if (count === 1) {
        c.status = 'QUALIFIED';
        qualified++;
      } else {
        c.status = 'NULL_CROSS_YEAR_DUPLICATE';
        nullCrossYearDuplicate++;
      }
    }
  }

  return {
    qualified,
    nullCaseFormat,
    nullCrossYearDuplicate,
    classified
  };
}

// ─── Sheet Auditing: Master_User ─────────────────────────────────────────────
export function auditUsers(rows) {
  const issues = [];
  let rowsRead = 0;
  let wouldImport = 0;
  let skipped = 0;
  let blockingCount = 0;
  let warningCount = 0;
  let roleNormalizationCount = 0;
  let adminCount = 0;

  const seenUsernames = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNum = r + 1;
    rowsRead++;

    // Blank row check
    const isBlank = row.every(cell => String(cell || '').trim() === '');
    if (isBlank) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_User',
        field: 'row',
        code: 'BLANK_ROW_SKIPPED',
        message: 'Blank row skipped'
      });
      warningCount++;
      skipped++;
      continue;
    }

    let rowHasBlocking = false;

    const rawUsername = row[0] != null ? String(row[0]).trim() : '';
    const rawPassword = row[1] != null ? String(row[1]).trim() : '';
    const rawNama = row[2] != null ? String(row[2]).trim() : '';
    const rawRole = row[3] != null ? String(row[3]).trim() : '';

    // 1. Username
    if (!rawUsername) {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Master_User',
        field: 'username',
        code: 'EMPTY_USERNAME',
        message: 'Username is empty'
      });
      rowHasBlocking = true;
      blockingCount++;
    } else {
      const lowerUser = rawUsername.toLowerCase();
      if (seenUsernames.has(lowerUser)) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Master_User',
          field: 'username',
          code: 'DUPLICATE_USERNAME',
          message: 'Duplicate username ignoring case'
        });
        rowHasBlocking = true;
        blockingCount++;
      } else {
        seenUsernames.set(lowerUser, rowNum);
      }
    }

    // 2. Password hash (NEVER report the value!)
    const passwordRegex = /^sha256\$[0-9a-f]{32}\$[0-9a-fA-F]{64}$/;
    if (!passwordRegex.test(rawPassword)) {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Master_User',
        field: 'password',
        code: 'INVALID_PASSWORD_HASH',
        message: 'Password does not match sha256$32hex$64hex (plaintext or malformed)'
      });
      rowHasBlocking = true;
      blockingCount++;
    }

    // 3. NamaLengkap
    if (!rawNama) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_User',
        field: 'namaLengkap',
        code: 'EMPTY_NAMA_LENGKAP',
        message: 'Empty namaLengkap (will default to username)'
      });
      warningCount++;
    }

    // 4. Role normalization (privacy: fixed category labels only, no raw input values)
    const lowerRole = rawRole.toLowerCase();
    let normalizedRole = 'pengelola';
    if (lowerRole === 'admin') {
      normalizedRole = 'admin';
    } else if (lowerRole === 'administrator') {
      normalizedRole = 'admin';
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_User',
        field: 'hakAkses',
        code: 'ROLE_NORMALIZED',
        message: 'Role normalized: administrator -> admin'
      });
      warningCount++;
      roleNormalizationCount++;
    } else if (lowerRole === 'pengelola') {
      normalizedRole = 'pengelola';
    } else {
      normalizedRole = 'pengelola';
      const roleCategory = !rawRole ? 'empty' : 'other';
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_User',
        field: 'hakAkses',
        code: 'ROLE_NORMALIZED',
        message: `Role normalized: ${roleCategory} -> pengelola`
      });
      warningCount++;
      roleNormalizationCount++;
    }

    if (normalizedRole === 'admin') {
      adminCount++;
    }

    if (!rowHasBlocking) {
      wouldImport++;
    }
  }

  // 5. Zero admins check
  if (adminCount === 0) {
    issues.push({
      row: 1,
      severity: 'BLOCKING',
      sheet: 'Master_User',
      field: 'hakAkses',
      code: 'ZERO_ADMINS',
      message: 'Zero admins found after normalization'
    });
    blockingCount++;
  }

  return {
    rowsRead,
    wouldImport,
    skipped,
    blockingCount,
    warningCount,
    roleNormalizationCount,
    adminCount,
    issues
  };
}

// ─── Sheet Auditing: Database_Surat ──────────────────────────────────────────
export function auditLetters(rows) {
  const issues = [];
  let rowsRead = 0;
  let wouldImport = 0;
  let skipped = 0;
  let blockingCount = 0;
  let warningCount = 0;

  const seenIds = new Map();
  const letterItemsForRequestId = [];

  const requiredTextFields = [
    { col: 3, field: 'nama', maxLen: 180 },
    { col: 4, field: 'nip', maxLen: 180 },
    { col: 5, field: 'pangkat', maxLen: 180 },
    { col: 6, field: 'jabatan', maxLen: 300 },
    { col: 7, field: 'unit', maxLen: 300 },
    { col: 9, field: 'skPejabat', maxLen: 180 },
    { col: 11, field: 'skNomor', maxLen: 180 },
    { col: 20, field: 'suratNomor', maxLen: 180 },
    { col: 22, field: 'signJabatan', maxLen: 180 },
    { col: 23, field: 'signNama', maxLen: 180 },
    { col: 24, field: 'signPangkat', maxLen: 180 },
    { col: 25, field: 'signNip', maxLen: 180 }
  ];

  const requiredDateFields = [
    { col: 10, field: 'skTanggal' },
    { col: 12, field: 'skTmt' },
    { col: 18, field: 'gajiBaruTmt' },
    { col: 21, field: 'suratTanggal' }
  ];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNum = r + 1;
    rowsRead++;

    // Blank row check
    const isBlank = row.every(cell => String(cell || '').trim() === '');
    if (isBlank) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'row',
        code: 'BLANK_ROW_SKIPPED',
        message: 'Blank row skipped'
      });
      warningCount++;
      skipped++;
      continue;
    }

    const rawId = row[1] != null ? String(row[1]).trim() : '';

    // WARN skip: empty B (ignored like listLetters_)
    if (!rawId) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'id',
        code: 'EMPTY_LETTER_ID_SKIPPED',
        message: 'Empty letter ID in column B (skipped)'
      });
      warningCount++;
      skipped++;
      continue;
    }

    let rowHasBlocking = false;

    // Collect ID for request_id analysis
    letterItemsForRequestId.push({ id: rawId, rowNumber: rowNum });

    // Check duplicate ID
    if (seenIds.has(rawId)) {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Database_Surat',
        field: 'id',
        code: 'DUPLICATE_ID',
        message: 'Duplicate letter ID'
      });
      rowHasBlocking = true;
      blockingCount++;
    } else {
      seenIds.set(rawId, rowNum);
    }

    // Check ID length > 200
    if (rawId.length > 200) {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Database_Surat',
        field: 'id',
        code: 'ID_OVER_LENGTH',
        message: 'Letter ID exceeds 200 characters'
      });
      rowHasBlocking = true;
      blockingCount++;
    }

    // Check statusPegawai (PNS / PPPK after uppercase)
    const rawStatus = row[2] != null ? String(row[2]).trim().toUpperCase() : '';
    if (rawStatus !== 'PNS' && rawStatus !== 'PPPK') {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Database_Surat',
        field: 'statusPegawai',
        code: 'INVALID_STATUS_PEGAWAI',
        message: 'Status pegawai must be PNS or PPPK'
      });
      rowHasBlocking = true;
      blockingCount++;
    }

    // Check required text fields
    for (const req of requiredTextFields) {
      const val = row[req.col] != null ? String(row[req.col]).trim() : '';
      if (!val) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Database_Surat',
          field: req.field,
          code: 'REQUIRED_FIELD_EMPTY',
          message: 'Required field is empty'
        });
        rowHasBlocking = true;
        blockingCount++;
      } else if (val.length > req.maxLen) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Database_Surat',
          field: req.field,
          code: 'FIELD_OVER_LENGTH',
          message: 'Field exceeds maximum allowed length'
        });
        rowHasBlocking = true;
        blockingCount++;
      }
    }

    // Check NIP and signNip truncation (scientific notation / E+)
    const rawNip = row[4] != null ? String(row[4]).trim() : '';
    const rawSignNip = row[25] != null ? String(row[25]).trim() : '';

    if (/E\+/i.test(rawNip)) {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Database_Surat',
        field: 'nip',
        code: 'NIP_TRUNCATED',
        message: 'NIP is truncated in scientific notation',
        maskedNip: maskNip(rawNip)
      });
      rowHasBlocking = true;
      blockingCount++;
    } else if (rawNip && !/^\d{18}$/.test(rawNip)) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'nip',
        code: 'NIP_NON_STANDARD',
        message: 'NIP is non-standard (not 18 digits) — will import as-is',
        maskedNip: maskNip(rawNip)
      });
      warningCount++;
    }

    if (/E\+/i.test(rawSignNip)) {
      issues.push({
        row: rowNum,
        severity: 'BLOCKING',
        sheet: 'Database_Surat',
        field: 'signNip',
        code: 'NIP_TRUNCATED',
        message: 'signNip is truncated in scientific notation',
        maskedNip: maskNip(rawSignNip)
      });
      rowHasBlocking = true;
      blockingCount++;
    } else if (rawSignNip && !/^\d{18}$/.test(rawSignNip)) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'signNip',
        code: 'NIP_NON_STANDARD',
        message: 'signNip is non-standard (not 18 digits) — will import as-is',
        maskedNip: maskNip(rawSignNip)
      });
      warningCount++;
    }

    // Check required dates
    for (const reqDate of requiredDateFields) {
      const dateVal = row[reqDate.col] != null ? String(row[reqDate.col]).trim() : '';
      const parsedDate = parseDate(dateVal);
      if (!parsedDate.valid) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Database_Surat',
          field: reqDate.field,
          code: 'UNPARSEABLE_DATE',
          message: 'Required date is invalid or unparseable'
        });
        rowHasBlocking = true;
        blockingCount++;
      } else if (parsedDate.isSerial) {
        issues.push({
          row: rowNum,
          severity: 'WARN',
          sheet: 'Database_Surat',
          field: reqDate.field,
          code: 'SERIAL_DATE_INTERPRETED',
          message: 'Serial date interpreted'
        });
        warningCount++;
      }
    }

    // Check gaji (gajiLama col 15, gajiBaru col 19)
    const gajiFields = [
      { col: 15, field: 'gajiLama' },
      { col: 19, field: 'gajiBaru' }
    ];
    for (const gf of gajiFields) {
      const gajiVal = row[gf.col] != null ? String(row[gf.col]).trim() : '';
      const parsedGaji = parseRupiah(gajiVal);
      if (!parsedGaji.valid) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Database_Surat',
          field: gf.field,
          code: parsedGaji.hasNonZeroDecimals ? 'SALARY_NON_ZERO_DECIMALS' : (parsedGaji.isOverMaxSafeInteger ? 'SALARY_OVER_MAX_SAFE_INTEGER' : 'SALARY_NOT_INTEGER_RUPIAH'),
          message: parsedGaji.hasNonZeroDecimals
            ? 'Salary field contains non-zero decimals'
            : 'Salary field is not parseable as integer rupiah'
        });
        rowHasBlocking = true;
        blockingCount++;
      }
    }

    // Check masa kerja
    const mkRules = [
      { col: 13, field: 'mkLamaThn', min: 0, max: 40, emptyVal: 0 },
      { col: 14, field: 'mkLamaBln', min: 0, max: 11, emptyVal: 0 },
      { col: 16, field: 'mkBaruThn', min: 1, max: 40, emptyVal: 0 },
      { col: 17, field: 'mkBaruBln', min: 0, max: 11, emptyVal: 0 }
    ];

    for (const mkr of mkRules) {
      const valStr = row[mkr.col] != null ? String(row[mkr.col]).trim() : '';
      let num = mkr.emptyVal;
      if (valStr !== '') {
        if (!/^\d+$/.test(valStr)) {
          issues.push({
            row: rowNum,
            severity: 'BLOCKING',
            sheet: 'Database_Surat',
            field: mkr.field,
            code: 'MK_NOT_INTEGER',
            message: 'Masa kerja field is not a valid integer'
          });
          rowHasBlocking = true;
          blockingCount++;
          continue;
        }
        num = Number(valStr);
      }
      if (num < mkr.min || num > mkr.max) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Database_Surat',
          field: mkr.field,
          code: 'MK_OUT_OF_RANGE',
          message: 'Masa kerja field value out of allowed range'
        });
        rowHasBlocking = true;
        blockingCount++;
      }
    }

    // WARN: kabkot not in 22 known NTT regions
    const rawKabkot = row[8] != null ? String(row[8]).trim() : '';
    if (!NTT_REGIONS.has(rawKabkot)) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'kabkot',
        code: 'KABKOT_UNKNOWN',
        message: 'Kabkot not in the 22 known NTT regions list'
      });
      warningCount++;
    }

    // WARN: timestamp column A empty or unparseable
    const rawTimestamp = row[0] != null ? String(row[0]).trim() : '';
    if (!rawTimestamp) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'timestamp',
        code: 'TIMESTAMP_EMPTY',
        message: 'Timestamp column A empty (will fall back)'
      });
      warningCount++;
    } else {
      const parsedTs = parseDate(rawTimestamp);
      if (parsedTs.valid) {
        if (parsedTs.isSerial) {
          issues.push({
            row: rowNum,
            severity: 'WARN',
            sheet: 'Database_Surat',
            field: 'timestamp',
            code: 'SERIAL_DATE_INTERPRETED',
            message: 'Serial date interpreted'
          });
          warningCount++;
        }
      } else if (isNaN(Date.parse(rawTimestamp))) {
        issues.push({
          row: rowNum,
          severity: 'WARN',
          sheet: 'Database_Surat',
          field: 'timestamp',
          code: 'TIMESTAMP_UNPARSEABLE',
          message: 'Timestamp column A unparseable'
        });
        warningCount++;
      }
    }

    // WARN: ukuranKertas not a4/legal (→ legal)
    const rawUkuran = row[26] != null ? String(row[26]).trim().toLowerCase() : '';
    if (rawUkuran !== 'a4' && rawUkuran !== 'legal') {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Database_Surat',
        field: 'ukuranKertas',
        code: 'UKURAN_KERTAS_FALLBACK',
        message: 'Ukuran kertas not a4 or legal (will default to legal)'
      });
      warningCount++;
    }

    if (!rowHasBlocking) {
      wouldImport++;
    }
  }

  // Request ID backfill analysis
  const reqIdAnalysis = analyzeRequestIdBackfill(letterItemsForRequestId);

  return {
    rowsRead,
    wouldImport,
    skipped,
    blockingCount,
    warningCount,
    requestIdBackfill: {
      qualified: reqIdAnalysis.qualified,
      nullCaseFormat: reqIdAnalysis.nullCaseFormat,
      nullCrossYearDuplicate: reqIdAnalysis.nullCrossYearDuplicate
    },
    issues
  };
}

// ─── Sheet Auditing: Master_Gaji_Pangkat ──────────────────────────────────────
export function auditSalary(rows) {
  const issues = [];
  let rowsRead = 0;
  let wouldImport = 0;
  let skipped = 0;
  let blockingCount = 0;
  let warningCount = 0;

  if (rows.length === 0) {
    return {
      rowsRead: 0,
      wouldImport: 0,
      skipped: 0,
      blockingCount: 0,
      warningCount: 0,
      issues
    };
  }

  const header = rows[0] || [];
  const mkgColumns = [];
  for (let j = 2; j < header.length; j++) {
    const match = String(header[j] || '').match(/MKG\s*(\d+)\s*Tahun/i);
    if (match) {
      mkgColumns.push({ col: j, mkg: Number(match[1]), name: String(header[j]).trim() });
    }
  }

  const seenSalaries = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNum = r + 1;
    rowsRead++;

    // Blank row check
    const isBlank = row.every(cell => String(cell || '').trim() === '');
    if (isBlank) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_Gaji_Pangkat',
        field: 'row',
        code: 'BLANK_ROW_SKIPPED',
        message: 'Blank row skipped'
      });
      warningCount++;
      skipped++;
      continue;
    }

    const rawStatus = row[0] != null ? String(row[0]).trim().toUpperCase() : '';
    const rawPangkat = row[1] != null ? String(row[1]).trim() : '';

    // Empty pangkat check (mirrors Code.js readMasterGaji_)
    if (!rawPangkat) {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_Gaji_Pangkat',
        field: 'pangkat',
        code: 'EMPTY_PANGKAT_SKIPPED',
        message: 'Row with empty pangkat skipped'
      });
      warningCount++;
      skipped++;
      continue;
    }

    // WARN: status not PNS/PPPK (skipped)
    if (rawStatus !== 'PNS' && rawStatus !== 'PPPK') {
      issues.push({
        row: rowNum,
        severity: 'WARN',
        sheet: 'Master_Gaji_Pangkat',
        field: 'status',
        code: 'STATUS_NOT_PNS_PPPK_SKIPPED',
        message: 'Row status is not PNS or PPPK (skipped)'
      });
      warningCount++;
      skipped++;
      continue;
    }

    let rowHasBlocking = false;
    const golonganCode = normalizePangkat(rawPangkat);

    for (const mkgCol of mkgColumns) {
      const cellVal = row[mkgCol.col] != null ? String(row[mkgCol.col]).trim() : '';

      // Empty cell check
      if (!cellVal) {
        issues.push({
          row: rowNum,
          severity: 'WARN',
          sheet: 'Master_Gaji_Pangkat',
          field: mkgCol.name,
          code: 'ZERO_OR_EMPTY_CELL_SKIPPED',
          message: 'Zero or empty salary cell skipped'
        });
        warningCount++;
        continue;
      }

      const parsedGaji = parseRupiah(cellVal);
      if (!parsedGaji.valid) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Master_Gaji_Pangkat',
          field: mkgCol.name,
          code: parsedGaji.hasNonZeroDecimals ? 'SALARY_NON_ZERO_DECIMALS' : (parsedGaji.isOverMaxSafeInteger ? 'SALARY_OVER_MAX_SAFE_INTEGER' : 'NON_NUMERIC_SALARY'),
          message: 'Salary cell is invalid or non-numeric'
        });
        rowHasBlocking = true;
        blockingCount++;
        continue;
      }

      // Zero detection using parsed value === 0
      if (parsedGaji.value === 0) {
        issues.push({
          row: rowNum,
          severity: 'WARN',
          sheet: 'Master_Gaji_Pangkat',
          field: mkgCol.name,
          code: 'ZERO_OR_EMPTY_CELL_SKIPPED',
          message: 'Zero or empty salary cell skipped'
        });
        warningCount++;
        continue;
      }

      // Check duplicate (status, golongan code, mkg)
      const key = `${rawStatus}:${golonganCode}:${mkgCol.mkg}`;
      if (seenSalaries.has(key)) {
        issues.push({
          row: rowNum,
          severity: 'BLOCKING',
          sheet: 'Master_Gaji_Pangkat',
          field: mkgCol.name,
          code: 'DUPLICATE_SALARY_ENTRY',
          message: 'Duplicate status, golongan, and MKG entry'
        });
        rowHasBlocking = true;
        blockingCount++;
      } else {
        seenSalaries.set(key, rowNum);
      }
    }

    if (!rowHasBlocking) {
      wouldImport++;
    }
  }

  return {
    rowsRead,
    wouldImport,
    skipped,
    blockingCount,
    warningCount,
    issues
  };
}

// ─── Combined Audit Runner ───────────────────────────────────────────────────
export function auditAll(options = {}) {
  const { usersContent, lettersContent, salaryContent, usersPath, lettersPath, salaryPath } = options;

  const result = {
    timestamp: new Date().toISOString(),
    status: 'PASS',
    exitCode: 0,
    summary: {
      totalRowsRead: 0,
      totalWouldImport: 0,
      totalSkipped: 0,
      totalBlocking: 0,
      totalWarning: 0
    },
    sheets: {}
  };

  if (usersContent != null) {
    const rows = parseCSV(usersContent);
    const audited = auditUsers(rows);
    result.sheets.users = {
      path: usersPath || null,
      ...audited
    };
    result.summary.totalRowsRead += audited.rowsRead;
    result.summary.totalWouldImport += audited.wouldImport;
    result.summary.totalSkipped += audited.skipped;
    result.summary.totalBlocking += audited.blockingCount;
    result.summary.totalWarning += audited.warningCount;
  }

  if (lettersContent != null) {
    const rows = parseCSV(lettersContent);
    const audited = auditLetters(rows);
    result.sheets.letters = {
      path: lettersPath || null,
      ...audited
    };
    result.summary.totalRowsRead += audited.rowsRead;
    result.summary.totalWouldImport += audited.wouldImport;
    result.summary.totalSkipped += audited.skipped;
    result.summary.totalBlocking += audited.blockingCount;
    result.summary.totalWarning += audited.warningCount;
  }

  if (salaryContent != null) {
    const rows = parseCSV(salaryContent);
    const audited = auditSalary(rows);
    result.sheets.salary = {
      path: salaryPath || null,
      ...audited
    };
    result.summary.totalRowsRead += audited.rowsRead;
    result.summary.totalWouldImport += audited.wouldImport;
    result.summary.totalSkipped += audited.skipped;
    result.summary.totalBlocking += audited.blockingCount;
    result.summary.totalWarning += audited.warningCount;
  }

  if (result.summary.totalBlocking > 0) {
    result.status = 'BLOCKING_ISSUES_FOUND';
    result.exitCode = 2;
  } else {
    result.status = 'PASS';
    result.exitCode = 0;
  }

  return result;
}

// ─── Privacy-Safe Output Formatters ──────────────────────────────────────────
export function formatStdoutSummary(auditResult, outPath) {
  const lines = [];
  lines.push('=== SIPSID-KGB DATA AUDIT REPORT ===\n');

  if (auditResult.sheets.users) {
    const u = auditResult.sheets.users;
    lines.push('Sheet: Master_User');
    if (u.path) lines.push(`  File: ${u.path}`);
    lines.push(`  Rows read: ${u.rowsRead}`);
    lines.push(`  Would import: ${u.wouldImport}`);
    lines.push(`  Skipped: ${u.skipped}`);
    lines.push(`  Blocking issues: ${u.blockingCount}`);
    lines.push(`  Warnings: ${u.warningCount}`);
    lines.push(`  Admin count: ${u.adminCount}`);
    lines.push(`  Role normalizations: ${u.roleNormalizationCount}\n`);
  }

  if (auditResult.sheets.letters) {
    const l = auditResult.sheets.letters;
    lines.push('Sheet: Database_Surat');
    if (l.path) lines.push(`  File: ${l.path}`);
    lines.push(`  Rows read: ${l.rowsRead}`);
    lines.push(`  Would import: ${l.wouldImport}`);
    lines.push(`  Skipped: ${l.skipped}`);
    lines.push(`  Blocking issues: ${l.blockingCount}`);
    lines.push(`  Warnings: ${l.warningCount}`);
    if (l.requestIdBackfill) {
      lines.push('  Request ID Backfill:');
      lines.push(`    - Qualified: ${l.requestIdBackfill.qualified}`);
      lines.push(`    - NULL (case/format): ${l.requestIdBackfill.nullCaseFormat}`);
      lines.push(`    - NULL (cross-year duplicate): ${l.requestIdBackfill.nullCrossYearDuplicate}`);
    }
    lines.push('');
  }

  if (auditResult.sheets.salary) {
    const s = auditResult.sheets.salary;
    lines.push('Sheet: Master_Gaji_Pangkat');
    if (s.path) lines.push(`  File: ${s.path}`);
    lines.push(`  Rows read: ${s.rowsRead}`);
    lines.push(`  Would import: ${s.wouldImport}`);
    lines.push(`  Skipped: ${s.skipped}`);
    lines.push(`  Blocking issues: ${s.blockingCount}`);
    lines.push(`  Warnings: ${s.warningCount}\n`);
  }

  lines.push('TOTALS:');
  lines.push(`  Total rows read: ${auditResult.summary.totalRowsRead}`);
  lines.push(`  Total would import: ${auditResult.summary.totalWouldImport}`);
  lines.push(`  Total skipped: ${auditResult.summary.totalSkipped}`);
  lines.push(`  Total blocking issues: ${auditResult.summary.totalBlocking}`);
  lines.push(`  Total warnings: ${auditResult.summary.totalWarning}\n`);

  // Collect all issues for stdout summary: counts and row numbers only, NO PII/CREDENTIALS
  const allIssues = [];
  if (auditResult.sheets.users?.issues) allIssues.push(...auditResult.sheets.users.issues);
  if (auditResult.sheets.letters?.issues) allIssues.push(...auditResult.sheets.letters.issues);
  if (auditResult.sheets.salary?.issues) allIssues.push(...auditResult.sheets.salary.issues);

  if (allIssues.length > 0) {
    lines.push('ISSUES BREAKDOWN (counts, row numbers, and field codes only):');
    for (const issue of allIssues) {
      lines.push(`  [${issue.severity}] ${issue.sheet} Row ${issue.row}: ${issue.field} (${issue.code})`);
    }
    lines.push('');
  }

  if (outPath) {
    lines.push(`Audit report written to: ${outPath}`);
  }
  lines.push(`Status: ${auditResult.status} (exit code ${auditResult.exitCode})`);

  return lines.join('\n');
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────
export function runCli(argv = process.argv.slice(2)) {
  let usersPath = null;
  let lettersPath = null;
  let salaryPath = null;
  let outPath = 'migration-data/audit-report.json';
  let requireAll = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--users') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error('Usage error: Missing path for --users');
        return 1;
      }
      usersPath = argv[++i];
    } else if (arg === '--letters') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error('Usage error: Missing path for --letters');
        return 1;
      }
      lettersPath = argv[++i];
    } else if (arg === '--salary') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error('Usage error: Missing path for --salary');
        return 1;
      }
      salaryPath = argv[++i];
    } else if (arg === '--out') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error('Usage error: Missing path for --out');
        return 1;
      }
      outPath = argv[++i];
    } else if (arg === '--require-all') {
      requireAll = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/audit-sheets.mjs [--users <Master_User.csv>] [--letters <Database_Surat.csv>] [--salary <Master_Gaji_Pangkat.csv>] [--out <output.json>] [--require-all]');
      return 0;
    } else {
      console.error(`Usage error: Unknown flag ${arg}`);
      return 1;
    }
  }

  // 1. No inputs given -> usage error (exit 1)
  if (!usersPath && !lettersPath && !salaryPath) {
    console.error('Usage error: At least one input sheet must be specified (--users, --letters, --salary)');
    return 1;
  }

  // 2. --require-all -> all 3 must be specified (exit 1 if any missing)
  if (requireAll && (!usersPath || !lettersPath || !salaryPath)) {
    console.error('Usage error: --require-all requires --users, --letters, and --salary to be specified');
    return 1;
  }

  let usersContent = null;
  let lettersContent = null;
  let salaryContent = null;

  try {
    if (usersPath) {
      usersContent = fs.readFileSync(usersPath, 'utf8');
    }
    if (lettersPath) {
      lettersContent = fs.readFileSync(lettersPath, 'utf8');
    }
    if (salaryPath) {
      salaryContent = fs.readFileSync(salaryPath, 'utf8');
    }
  } catch (err) {
    console.error(`File read error: ${err.message}`);
    return 1;
  }

  let auditResult;
  try {
    auditResult = auditAll({
      usersContent,
      lettersContent,
      salaryContent,
      usersPath,
      lettersPath,
      salaryPath
    });
  } catch (err) {
    console.error(`Audit parse error: ${err.message}`);
    return 1;
  }

  try {
    const resolvedOutPath = path.resolve(outPath);
    const outDir = path.dirname(resolvedOutPath);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(resolvedOutPath, JSON.stringify(auditResult, null, 2), 'utf8');
  } catch (err) {
    console.error(`Report write error: ${err.message}`);
    return 1;
  }

  const stdoutSummary = formatStdoutSummary(auditResult, outPath);
  console.log(stdoutSummary);

  return auditResult.exitCode;
}

export function isMainModule() {
  if (!process.argv[1]) return false;
  const scriptPath = fileURLToPath(import.meta.url);
  const invokedPath = path.resolve(process.argv[1]);
  if (process.platform === 'win32') {
    return scriptPath.toLowerCase() === invokedPath.toLowerCase();
  }
  return scriptPath === invokedPath;
}

if (isMainModule()) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}
