import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  cleanText,
  normalizeDateForClient,
  isCalendarDate,
  parseRupiahToInteger,
  formatRupiah,
  witaYear,
  witaDateString,
} from '../src/server/format.js';

import {
  appError,
  isPublicError,
  publicMessage,
  fromD1Error,
  GENERIC_ERROR_MESSAGE,
  D1_ERROR_MESSAGES,
  PUBLIC_ERROR_CODES,
} from '../src/server/errors.js';

// Extract formatRupiahExact from Index.html for exact parity check
const indexHtmlPath = fileURLToPath(new URL('../Index.html', import.meta.url));
const indexHtmlContent = readFileSync(indexHtmlPath, 'utf8');
const fnStart = indexHtmlContent.indexOf('function formatRupiahExact(nominal)');
if (fnStart === -1) {
  throw new Error('formatRupiahExact not found in Index.html');
}
const braceOpen = indexHtmlContent.indexOf('{', fnStart);
const braceClose = indexHtmlContent.indexOf('\n      }', braceOpen);
const body = indexHtmlContent.slice(braceOpen + 1, braceClose);
const formatRupiahExact = new Function('nominal', body);

test('format: cleanText trimming, null handling, and max length cut', () => {
  assert.equal(cleanText('  halo dunia  '), 'halo dunia');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(12345), '12345');
  assert.equal(cleanText('abcde', 3), 'abc');
  assert.equal(cleanText('abcde', 0), 'abcde'); // 0 defaults to 200
  assert.equal(cleanText('  a  b  ', 3), 'a  ');
  const longText = 'x'.repeat(250);
  assert.equal(cleanText(longText).length, 200);
  assert.equal(cleanText(longText, 50).length, 50);
});

test('format: normalizeDateForClient parity with Code.js', () => {
  assert.equal(normalizeDateForClient(''), '');
  assert.equal(normalizeDateForClient(null), '');
  assert.equal(normalizeDateForClient(undefined), '');

  // ISO formats
  assert.equal(normalizeDateForClient('2024-03-01'), '2024-03-01');
  assert.equal(normalizeDateForClient('2024-03-01T12:00:00Z'), '2024-03-01');
  assert.equal(normalizeDateForClient('2024-12-31 23:59:59'), '2024-12-31');

  // Local formats with slash, dot, dash (day first)
  assert.equal(normalizeDateForClient('1/3/2024'), '2024-03-01');
  assert.equal(normalizeDateForClient('01/03/2024'), '2024-03-01');
  assert.equal(normalizeDateForClient('1.3.2024'), '2024-03-01');
  assert.equal(normalizeDateForClient('01.03.2024'), '2024-03-01');
  assert.equal(normalizeDateForClient('1-3-2024'), '2024-03-01');
  assert.equal(normalizeDateForClient('01-03-2024'), '2024-03-01');
  assert.equal(normalizeDateForClient('31/12/2026'), '2026-12-31');

  // Fallback trimmed for non-matching
  assert.equal(normalizeDateForClient('  text biasa  '), 'text biasa');
});

test('format: isCalendarDate parity with Code.js', () => {
  // Valid calendar dates
  assert.equal(isCalendarDate('2024-02-29'), true); // leap year
  assert.equal(isCalendarDate('2000-02-29'), true); // century leap year
  assert.equal(isCalendarDate('2024-01-31'), true);
  assert.equal(isCalendarDate('2024-04-30'), true);
  assert.equal(isCalendarDate('2026-10-15'), true);

  // Invalid calendar dates
  assert.equal(isCalendarDate('2023-02-29'), false); // non-leap year
  assert.equal(isCalendarDate('1900-02-29'), false); // century non-leap year
  assert.equal(isCalendarDate('2024-02-30'), false); // fictitious Feb 30
  assert.equal(isCalendarDate('2024-04-31'), false); // April has 30 days
  assert.equal(isCalendarDate('2024-13-01'), false); // Month 13
  assert.equal(isCalendarDate('2024-00-10'), false); // Month 0
  assert.equal(isCalendarDate('2024-01-00'), false); // Day 0
  assert.equal(isCalendarDate('2024-01-32'), false); // Day 32

  // Invalid format
  assert.equal(isCalendarDate('01/01/2024'), false);
  assert.equal(isCalendarDate('2024-1-1'), false);
  assert.equal(isCalendarDate(''), false);
  assert.equal(isCalendarDate(null), false);
  assert.equal(isCalendarDate(undefined), false);
  assert.equal(isCalendarDate(20240101), false);
});

test('format: parseRupiahToInteger accepts valid rupiah representations and numbers', () => {
  assert.equal(parseRupiahToInteger('Rp. 4.123.400,-'), 4123400);
  assert.equal(parseRupiahToInteger('Rp 4.123.400'), 4123400);
  assert.equal(parseRupiahToInteger('4123400'), 4123400);
  assert.equal(parseRupiahToInteger('4.123.400,00'), 4123400);
  assert.equal(parseRupiahToInteger('Rp. 4.123.400,00,-'), 4123400);
  assert.equal(parseRupiahToInteger('IDR 4.123.400,-'), 4123400);
  assert.equal(parseRupiahToInteger('  Rp. 4.123.400,-  '), 4123400);

  // Zero
  assert.equal(parseRupiahToInteger('0'), 0);
  assert.equal(parseRupiahToInteger('Rp. 0,-'), 0);
  assert.equal(parseRupiahToInteger('0,00'), 0);

  // Number inputs
  assert.equal(parseRupiahToInteger(4123400), 4123400);
  assert.equal(parseRupiahToInteger(0), 0);
  assert.equal(parseRupiahToInteger(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('format: parseRupiahToInteger rejects invalid formats with VALIDATION_ERROR', () => {
  // Fractional rupiah
  assert.throws(
    () => parseRupiahToInteger('4.123.400,50'),
    (err) => err.code === 'VALIDATION_ERROR' && /pecahan/i.test(err.message),
  );
  assert.throws(
    () => parseRupiahToInteger('4.123.400,05'),
    (err) => err.code === 'VALIDATION_ERROR' && /pecahan/i.test(err.message),
  );

  // Invalid text / empty
  assert.throws(() => parseRupiahToInteger('abc'), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger(''), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger(null), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger(undefined), (err) => err.code === 'VALIDATION_ERROR');

  // Negative values
  assert.throws(() => parseRupiahToInteger(-100), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger('-100'), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger('Rp. -4.123.400,-'), (err) => err.code === 'VALIDATION_ERROR');

  // en-US thousand separator ("4,000" ambiguous / 3-digit comma suffix)
  assert.throws(() => parseRupiahToInteger('4,000'), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger('4,123,400'), (err) => err.code === 'VALIDATION_ERROR');

  // Improper thousands grouping
  assert.throws(() => parseRupiahToInteger('4.12.400'), (err) => err.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRupiahToInteger('0.123'), (err) => err.code === 'VALIDATION_ERROR');

  // Larger than MAX_SAFE_INTEGER
  const tooLargeStr = '9007199254740992'; // MAX_SAFE_INTEGER + 1
  assert.throws(
    () => parseRupiahToInteger(tooLargeStr),
    (err) => err.code === 'VALIDATION_ERROR' && /terlalu besar/i.test(err.message),
  );
  assert.throws(
    () => parseRupiahToInteger('99999999999999999999'),
    (err) => err.code === 'VALIDATION_ERROR' && /terlalu besar/i.test(err.message),
  );
  assert.throws(
    () => parseRupiahToInteger(Number.MAX_SAFE_INTEGER + 100),
    (err) => err.code === 'VALIDATION_ERROR',
  );
});

test('format: formatRupiah output, roundtrip, and exact parity with Index.html formatRupiahExact', () => {
  assert.equal(formatRupiah(4123400), 'Rp. 4.123.400,-');
  assert.equal(formatRupiah(0), 'Rp. 0,-');
  assert.equal(formatRupiah(500), 'Rp. 500,-');
  assert.equal(formatRupiah(1000), 'Rp. 1.000,-');
  assert.equal(formatRupiah(10000000), 'Rp. 10.000.000,-');

  // Parity with Index.html formatRupiahExact for integers
  const testValues = [0, 1, 999, 1000, 15000, 4123400, 12345678, 987654321];
  for (const val of testValues) {
    const fromServer = formatRupiah(val);
    const fromIndexHtml = formatRupiahExact(val);
    assert.equal(fromServer, fromIndexHtml, `Value ${val} mismatch`);

    // Roundtrip check
    assert.equal(parseRupiahToInteger(fromServer), val);
  }

  // formatRupiah rejects invalid numbers
  assert.throws(() => formatRupiah(-1), RangeError);
  assert.throws(() => formatRupiah(1.5), RangeError);
  assert.throws(() => formatRupiah(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => formatRupiah('4123400'), RangeError);
});

test('format: witaYear and witaDateString UTC+8 rollover', () => {
  // 2026-12-31T15:59:59Z is 2026-12-31 23:59:59 WITA -> Year 2026
  const beforeMidnight = new Date('2026-12-31T15:59:59Z');
  assert.equal(witaYear(beforeMidnight), 2026);
  assert.equal(witaDateString(beforeMidnight), '2026-12-31');

  // 2026-12-31T16:00:00Z is 2027-01-01 00:00:00 WITA -> Year 2027
  const atMidnight = new Date('2026-12-31T16:00:00Z');
  assert.equal(witaYear(atMidnight), 2027);
  assert.equal(witaDateString(atMidnight), '2027-01-01');

  // Supports timestamp number
  assert.equal(witaYear(beforeMidnight.getTime()), 2026);
  assert.equal(witaDateString(beforeMidnight.getTime()), '2026-12-31');

  // Default value uses current time without throwing
  assert.ok(typeof witaYear() === 'number');
  assert.match(witaDateString(), /^\d{4}-\d{2}-\d{2}$/);

  // Invalid date throws RangeError
  assert.throws(() => witaYear('invalid'), RangeError);
  assert.throws(() => witaDateString('invalid'), RangeError);
});

test('errors: appError and isPublicError', () => {
  const err = appError('VALIDATION_ERROR', 'Input salah');
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.equal(err.message, 'Input salah');
  assert.equal(isPublicError(err), true);

  for (const code of PUBLIC_ERROR_CODES) {
    assert.equal(isPublicError(appError(code, 'Test')), true);
  }

  assert.equal(isPublicError(new Error('Internal database boom')), false);
  assert.equal(isPublicError(null), false);
  assert.equal(isPublicError({ code: 'UNKNOWN_CODE' }), false);
});

test('errors: publicMessage masks non-public errors and preserves public errors', () => {
  const pubErr = appError('VALIDATION_ERROR', 'Pesan validasi');
  assert.equal(publicMessage(pubErr), 'Pesan validasi');

  const privErr = new Error('SQLITE_ERROR: syntax error in SQL');
  assert.equal(publicMessage(privErr), GENERIC_ERROR_MESSAGE);

  assert.equal(publicMessage(null), GENERIC_ERROR_MESSAGE);
});

test('errors: fromD1Error maps trigger, transient, constraint, and generic errors safely', () => {
  // 1. Trigger LAST_ADMIN_PROTECTED
  const triggerErr = new Error('D1_ERROR: LAST_ADMIN_PROTECTED: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)');
  const mappedTrigger = fromD1Error(triggerErr);
  assert.equal(mappedTrigger.code, 'LAST_ADMIN_PROTECTED');
  assert.equal(mappedTrigger.message, D1_ERROR_MESSAGES.LAST_ADMIN_PROTECTED);
  assert.ok(!mappedTrigger.message.includes('SQLITE_CONSTRAINT'));
  assert.ok(!mappedTrigger.message.includes('D1_ERROR'));

  // Trigger with message override
  const customTrigger = fromD1Error(triggerErr, { LAST_ADMIN_PROTECTED: 'Pesan kustom admin' });
  assert.equal(customTrigger.code, 'LAST_ADMIN_PROTECTED');
  assert.equal(customTrigger.message, 'Pesan kustom admin');

  // 2. Transient network/timeout error -> DATA_SERVICE_UNAVAILABLE
  const networkErr = new Error('D1_ERROR: Network connection lost.');
  const mappedNet = fromD1Error(networkErr);
  assert.equal(mappedNet.code, 'DATA_SERVICE_UNAVAILABLE');
  assert.equal(mappedNet.message, D1_ERROR_MESSAGES.DATA_SERVICE_UNAVAILABLE);
  assert.ok(!mappedNet.message.includes('Network connection lost'));

  const overloadErr = new Error('D1 DB is overloaded. Too many requests queued.');
  const mappedOverload = fromD1Error(overloadErr);
  assert.equal(mappedOverload.code, 'DATA_SERVICE_UNAVAILABLE');
  assert.equal(mappedOverload.message, D1_ERROR_MESSAGES.DATA_SERVICE_UNAVAILABLE);

  // 3. Unique violation or other constraint -> DATA_WRITE_FAILED
  const uniqueErr = new Error('D1_ERROR: UNIQUE constraint failed: users.username: SQLITE_CONSTRAINT');
  const mappedUnique = fromD1Error(uniqueErr);
  assert.equal(mappedUnique.code, 'DATA_WRITE_FAILED');
  assert.equal(mappedUnique.message, D1_ERROR_MESSAGES.DATA_WRITE_FAILED);
  assert.ok(!mappedUnique.message.includes('UNIQUE constraint'));

  // 4. Generic error -> DATA_WRITE_FAILED
  const genericErr = new Error('Some unexpected disk failure');
  const mappedGeneric = fromD1Error(genericErr);
  assert.equal(mappedGeneric.code, 'DATA_WRITE_FAILED');
  assert.equal(mappedGeneric.message, D1_ERROR_MESSAGES.DATA_WRITE_FAILED);
  assert.ok(!mappedGeneric.message.includes('disk failure'));

  // 5. Existing public error is passed through as-is
  const existingPublic = appError('SESSION_EXPIRED', 'Sesi telah berakhir.');
  const mappedPass = fromD1Error(existingPublic);
  assert.equal(mappedPass, existingPublic);
});
