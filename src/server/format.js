// Format dan normalisasi nilai. Port perilaku Code.js / Index.html; tanpa dependensi dan tanpa Intl
// agar berjalan identik di Workers dan Node.
// Code.js = backend GAS lama, dihapus pada Fase 6; sumbernya ada di tag `pre-d1-cutover`.

import { appError } from './errors.js';

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Makassar = UTC+8, tanpa DST.
const MAX_SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER);

/** Port `cleanText_`: string, trim, potong ke `max` karakter (default 200; 0 juga berarti 200). */
export function cleanText(value, max) {
  return String(value == null ? '' : value).trim().substring(0, max || 200);
}

/**
 * Port `normalizeDateForClient_`: `YYYY-MM-DD…` → `YYYY-MM-DD`; `D/M/YYYY`, `D.M.YYYY`, `D-M-YYYY`
 * (hari lebih dulu) → `YYYY-MM-DD`; kosong → `""`; selain itu dikembalikan apa adanya (sudah di-trim).
 */
export function normalizeDateForClient(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (local) return `${local[3]}-${pad2(local[2])}-${pad2(local[1])}`;
  return text;
}

/**
 * Port `isCalendarDate_`: true hanya untuk `YYYY-MM-DD` yang merupakan tanggal kalender valid.
 * Memakai Date.UTC (bukan zona waktu lokal) agar deterministik; hasil hari-terakhir-bulan identik.
 * Catatan: seperti Code.js, tahun 0000–0099 dipetakan Date ke 1900–1999 untuk aturan kabisat.
 */
export function isCalendarDate(value) {
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

/**
 * Mengubah teks rupiah menjadi integer rupiah.
 * Diterima (spasi di sekitar diabaikan, prefix `Rp`/`Rp.`/`IDR` opsional, tidak peka huruf):
 *   `Rp. 4.123.400,-`  `Rp 4.123.400`  `4123400`  `4.123.400,00`  `Rp. 4.123.400,00,-`
 * Pemisah ribuan hanya titik dengan grup tepat 3 digit; desimal hanya koma dan wajib nol semua.
 * Format en-US (`4,123,400`) dan spasi di dalam angka ditolak.
 * Number non-negatif yang merupakan safe integer juga diterima.
 * @param {unknown} text
 * @param {string} [fieldName] nama field untuk pesan error.
 * @returns {number}
 * @throws VALIDATION_ERROR jika kosong, non-numerik, negatif, memiliki desimal bukan nol,
 *   atau melebihi Number.MAX_SAFE_INTEGER.
 */
export function parseRupiahToInteger(text, fieldName = 'gaji') {
  if (typeof text === 'number') {
    if (Number.isSafeInteger(text) && text >= 0) return text;
    throw invalidRupiah(fieldName);
  }
  let str = String(text == null ? '' : text).trim();
  str = str.replace(/^(?:Rp\.?|IDR)\s*/i, '');
  str = str.replace(/\s*,\s*-$/, '');
  // Grup ribuan wajib diawali digit bukan nol ("0.123" ditolak); angka tanpa pemisah bebas.
  // Desimal maksimal 2 digit: "4,000" ambigu (ribuan gaya en-US vs desimal) sehingga ditolak.
  const match = str.match(/^([1-9]\d{0,2}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/);
  if (!match) throw invalidRupiah(fieldName);
  if (match[2] !== undefined && /[1-9]/.test(match[2])) {
    throw appError('VALIDATION_ERROR', `Nilai ${fieldName} tidak boleh memiliki pecahan rupiah.`);
  }
  const digits = match[1].replace(/\./g, '').replace(/^0+(?=\d)/, '');
  if (digits.length > MAX_SAFE_DIGITS.length || (digits.length === MAX_SAFE_DIGITS.length && digits > MAX_SAFE_DIGITS)) {
    throw appError('VALIDATION_ERROR', `Nilai ${fieldName} terlalu besar.`);
  }
  return Number(digits);
}

/**
 * Integer rupiah → string dengan format identik `formatRupiahExact` di Index.html untuk nominal
 * bilangan bulat: `Rp. 4.123.400,-` (`0` → `Rp. 0,-`).
 * @param {number} value safe integer >= 0.
 */
export function formatRupiah(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('formatRupiah: value must be a non-negative safe integer');
  }
  const integerPart = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `Rp. ${integerPart},-`;
}

/** Tahun kalender di WITA (UTC+8). `date` = Date atau epoch ms; default sekarang. */
export function witaYear(date) {
  return witaShifted(date).getUTCFullYear();
}

/** Tanggal kalender `YYYY-MM-DD` di WITA (UTC+8). `date` = Date atau epoch ms; default sekarang. */
export function witaDateString(date) {
  const shifted = witaShifted(date);
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function witaShifted(date) {
  const time = date === undefined ? Date.now() : date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(time)) throw new RangeError('WITA conversion: invalid date');
  return new Date(time + WITA_OFFSET_MS);
}

function invalidRupiah(fieldName) {
  return appError('VALIDATION_ERROR', `Format ${fieldName} tidak valid. Gunakan format Rp. 4.123.400,-.`);
}

function pad2(value) {
  return `0${String(value)}`.slice(-2);
}
