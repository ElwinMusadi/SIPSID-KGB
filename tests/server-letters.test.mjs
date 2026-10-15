// Test domain surat D1 (src/server/letters.js) terhadap node:sqlite (tests/helpers/d1-sqlite.mjs).
// Data sintetis saja.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/d1-sqlite.mjs';
import {
  createLetter,
  deleteLetter,
  listLetters,
  rowToLetter,
  updateLetter,
  validateLetter,
  validateLetterId,
  validateRequestId,
} from '../src/server/letters.js';

const HASH = `sha256$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const NOW = new Date('2026-10-15T05:00:00.000Z');
const UUID_RE = /^KGB-2026-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function payload(overrides = {}) {
  return {
    statusPegawai: 'PNS',
    nama: 'Pegawai Uji',
    nip: '199001012020011001',
    pangkat: 'Penata Muda (III/a)',
    jabatan: 'Guru Ahli Pertama',
    unit: 'SMA Uji 1',
    kabkot: 'Kota Uji',
    skPejabat: 'Pejabat Uji',
    skTanggal: '2024-01-02',
    skNomor: 'SK/001/2024',
    skTmt: '2024-01-01',
    mkLamaThn: '10',
    mkLamaBln: '0',
    gajiLama: 'Rp. 3.000.000,-',
    mkBaruThn: '12',
    mkBaruBln: '0',
    gajiBaruTmt: '2024-01-01',
    gajiBaru: 'Rp. 4.123.400,-',
    suratNomor: 'KGB/002/2024',
    suratTanggal: '2024-01-10',
    signJabatan: 'Kepala Uji',
    signNama: 'Penandatangan Uji',
    signPangkat: 'Pembina (IV/a)',
    signNip: '197001011995011001',
    ukuranKertas: 'legal',
    ...overrides,
  };
}

async function setup() {
  const db = createTestDb();
  await db.exec(
    `INSERT INTO users (id, username, password_hash, nama_lengkap, role) VALUES (1, 'admin1', '${HASH}', 'Admin Satu', 'admin')\n` +
      `INSERT INTO users (id, username, password_hash, nama_lengkap, role) VALUES (2, 'peng1', '${HASH}', 'Pengelola Satu', 'pengelola')`,
  );
  const admin = { userId: 1, username: 'admin1', namaLengkap: 'Admin Satu', hakAkses: 'admin', sessionVersion: 1 };
  const peng = { userId: 2, username: 'peng1', namaLengkap: 'Pengelola Satu', hakAkses: 'pengelola', sessionVersion: 1 };
  return { db, admin, peng };
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

function count(db, sql = 'SELECT COUNT(*) AS n FROM letters') {
  return db.sqlite.prepare(sql).get().n;
}

const isValidation = (pattern) => (err) => err.code === 'VALIDATION_ERROR' && pattern.test(err.message);

// ─── Validasi ───────────────────────────────────────────────────────────────

test('validateLetter: field wajib, status pegawai, dan pesan identik Code.js', () => {
  assert.throws(() => validateLetter(payload({ nama: '   ' })), isValidation(/^Field nama wajib diisi\.$/));
  assert.throws(() => validateLetter(payload({ gajiBaru: '' })), isValidation(/^Field gajiBaru wajib diisi\.$/));
  assert.throws(() => validateLetter({}), isValidation(/^Field statusPegawai wajib diisi\.$/));
  assert.throws(() => validateLetter(payload({ statusPegawai: 'pns' })), isValidation(/^Status pegawai tidak valid\.$/));
  assert.equal(validateLetter(payload({ statusPegawai: 'PPPK' })).statusPegawai, 'PPPK');
});

test('validateLetter: tanggal kalender (2024-02-30, 2023-02-29, 2024-04-31, format lokal) ditolak', () => {
  for (const [field, value] of [
    ['skTanggal', '2024-02-30'],
    ['skTanggal', '2023-02-29'],
    ['suratTanggal', '2024-04-31'],
    ['skTmt', '2024-13-01'],
    ['gajiBaruTmt', '01/01/2024'],
  ]) {
    assert.throws(
      () => validateLetter(payload({ [field]: value })),
      isValidation(new RegExp(`^Format tanggal ${field} tidak valid\\.$`)),
      `${field}=${value}`,
    );
  }
  assert.equal(validateLetter(payload({ skTanggal: '2024-02-29' })).skTanggal, '2024-02-29');
});

test('validateLetter: batas masa kerja termasuk mkBaruThn >= 1', () => {
  const cases = [
    ['mkLamaThn', '41', /harus antara 0 dan 40\.$/],
    ['mkLamaBln', '12', /harus antara 0 dan 11\.$/],
    ['mkBaruThn', '0', /^Nilai masa kerja mkBaruThn harus antara 1 dan 40\.$/],
    ['mkBaruThn', '41', /harus antara 1 dan 40\.$/],
    ['mkBaruBln', '12', /harus antara 0 dan 11\.$/],
    ['mkLamaThn', '', /^Nilai masa kerja mkLamaThn tidak valid\.$/],
    ['mkLamaBln', '-1', /^Nilai masa kerja mkLamaBln tidak valid\.$/],
    ['mkBaruBln', '1.5', /^Nilai masa kerja mkBaruBln tidak valid\.$/],
  ];
  for (const [field, value, pattern] of cases) {
    assert.throws(() => validateLetter(payload({ [field]: value })), isValidation(pattern), `${field}=${value}`);
  }
  const edges = validateLetter(payload({ mkLamaThn: '0', mkLamaBln: '11', mkBaruThn: '1', mkBaruBln: '0' }));
  assert.deepEqual([edges.mkLamaThn, edges.mkLamaBln, edges.mkBaruThn, edges.mkBaruBln], [0, 11, 1, 0]);
});

test('validateLetter: panjang maksimum dipotong (bukan ditolak), ukuran default legal, kabkot opsional, id diabaikan', () => {
  const v = validateLetter(payload({
    nama: 'N'.repeat(500),
    jabatan: 'J'.repeat(500),
    unit: 'U'.repeat(500),
    ukuranKertas: 'A4',
    kabkot: '  ',
    id: 'KGB-HACK',
  }));
  assert.equal(v.nama.length, 180);
  assert.equal(v.jabatan.length, 300);
  assert.equal(v.unit.length, 300);
  assert.equal(v.ukuranKertas, 'legal'); // hanya "a4" persis (Code.js)
  assert.equal(v.kabkot, '');
  assert.equal('id' in v, false);
  assert.equal(validateLetter(payload({ ukuranKertas: 'a4' })).ukuranKertas, 'a4');
  assert.equal(validateLetter(payload({ ukuranKertas: undefined })).ukuranKertas, 'legal');
});

test('validateLetter: gaji diparse ke INTEGER; format tidak valid ditolak', () => {
  const v = validateLetter(payload({ gajiLama: '3000000', gajiBaru: 'Rp. 4.123.400,-' }));
  assert.equal(v.gajiLama, 3000000);
  assert.equal(v.gajiBaru, 4123400);
  assert.throws(() => validateLetter(payload({ gajiBaru: '4,123,400' })), isValidation(/gajiBaru/));
  assert.throws(() => validateLetter(payload({ gajiLama: 'abc' })), isValidation(/gajiLama/));
});

test('validateLetterId / validateRequestId: port Code.js', () => {
  assert.equal(validateLetterId('  KGB-2024-abc  '), 'KGB-2024-abc');
  assert.equal(validateLetterId(''), null);
  assert.equal(validateLetterId('x'.repeat(201)), null);
  assert.equal(validateLetterId('a<b'), null);
  assert.equal(validateRequestId(' ABC-def_1 '), 'abc-def_1');
  assert.equal(validateRequestId('a.b'), null);
  assert.equal(validateRequestId('x'.repeat(101)), null);
});

// ─── list / create ──────────────────────────────────────────────────────────

test('create tanpa requestId: id KGB-<tahun WITA>-<uuid>, gaji & kabkot roundtrip, kolom internal tidak bocor', async () => {
  const { db, peng } = await setup();
  const { proxy, counter } = counting(db);
  const result = await createLetter(proxy, peng, payload({ kabkot: '', id: 'KGB-HACK' }), NOW);
  assert.equal(counter.count, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.idempotent, undefined);
  assert.match(result.data.id, UUID_RE);
  assert.equal(result.data.gajiBaru, 'Rp. 4.123.400,-');
  assert.equal(result.data.gajiLama, 'Rp. 3.000.000,-');
  assert.equal(result.data.kabkot, '');
  assert.equal(result.data.mkBaruThn, '12');
  assert.deepEqual(Object.keys(result.data), [
    'id', 'statusPegawai', 'nama', 'nip', 'pangkat', 'jabatan', 'unit', 'kabkot',
    'skPejabat', 'skTanggal', 'skNomor', 'skTmt', 'mkLamaThn', 'mkLamaBln', 'gajiLama',
    'mkBaruThn', 'mkBaruBln', 'gajiBaruTmt', 'gajiBaru', 'suratNomor', 'suratTanggal',
    'signJabatan', 'signNama', 'signPangkat', 'signNip', 'ukuranKertas',
  ]);
  for (const value of Object.values(result.data)) assert.equal(typeof value, 'string');

  const row = db.sqlite.prepare('SELECT * FROM letters').get();
  assert.equal(row.gaji_baru, 4123400);
  assert.equal(row.kabkot, null);
  assert.equal(row.request_id, null);
  assert.equal(row.seq, 1);
  assert.equal(row.created_by, 'peng1');
  assert.equal(row.updated_by, 'peng1');
  assert.equal(row.created_at, '2026-10-15T05:00:00.000Z');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM letters WHERE id = 'KGB-HACK'"), 0);
});

test('list: urutan seq DESC, 1 query, nilai identik dengan respons create', async () => {
  const { db, peng } = await setup();
  const a = await createLetter(db, peng, payload({ nama: 'A' }), NOW);
  const b = await createLetter(db, peng, payload({ nama: 'B' }), NOW);
  const c = await createLetter(db, peng, payload({ nama: 'C' }), NOW);
  const { proxy, counter } = counting(db);
  const list = await listLetters(proxy, peng);
  assert.equal(counter.count, 1);
  assert.equal(list.status, 'success');
  assert.deepEqual(list.data.map((l) => l.nama), ['C', 'B', 'A']);
  assert.deepEqual(list.data, [c.data, b.data, a.data]);
});

test('create dengan requestId: id deterministik, replay idempotent tanpa baris kedua', async () => {
  const { db, peng } = await setup();
  const first = await createLetter(db, peng, payload({ requestId: 'Req-ABC_1' }), NOW);
  assert.equal(first.data.id, 'KGB-2026-req-abc_1');
  assert.equal(first.idempotent, undefined);

  const { proxy, counter } = counting(db);
  const replay = await createLetter(proxy, peng, payload({ requestId: 'req-abc_1', nama: 'Berbeda' }), NOW);
  assert.equal(counter.count, 2);
  assert.equal(replay.status, 'success');
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.data, first.data);
  assert.equal(count(db), 1);
  assert.equal(db.sqlite.prepare('SELECT request_id FROM letters').get().request_id, 'req-abc_1');

  // Replay lintas tahun tetap idempotent (request_id unik global, Bagian 6.2).
  const nextYear = await createLetter(db, peng, payload({ requestId: 'req-abc_1' }), new Date('2027-06-01T00:00:00Z'));
  assert.equal(nextYear.idempotent, true);
  assert.equal(nextYear.data.id, 'KGB-2026-req-abc_1');
  assert.equal(count(db), 1);
});

test('create dengan requestId: bentrok seq saja (balapan MAX(seq)) → DATA_WRITE_FAILED, tidak idempotent, tanpa baris baru', async () => {
  const { db, peng, admin } = await setup();
  const existing = await createLetter(db, admin, payload({ nama: 'Milik Orang Lain', requestId: 'req-lain' }), NOW);
  const before = db.sqlite.prepare('SELECT * FROM letters ORDER BY seq').all();

  // Paksa INSERT memakai seq yang sudah terpakai (meniru dua create bersamaan membaca MAX(seq) yang sama).
  const MAX_SEQ = '(SELECT COALESCE(MAX(seq), 0) + 1 FROM letters)';
  let rewritten = 0;
  const racing = {
    prepare(sql) {
      if (sql.includes(MAX_SEQ)) {
        rewritten += 1;
        return db.prepare(sql.replace(MAX_SEQ, '(SELECT MAX(seq) FROM letters)'));
      }
      return db.prepare(sql);
    },
  };

  for (const requestId of ['req-baru-1', 'req-baru-1', 'req-baru-2']) {
    await assert.rejects(createLetter(racing, peng, payload({ requestId }), NOW), (err) => {
      assert.equal(err.code, 'DATA_WRITE_FAILED');
      assert.equal(err.idempotent, undefined);
      assert.doesNotMatch(err.message, /UNIQUE|seq|D1_ERROR/);
      return true;
    });
  }
  assert.equal(rewritten, 3);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM letters ORDER BY seq').all(), before);
  assert.equal(count(db), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM letters WHERE request_id LIKE 'req-baru-%'"), 0);

  // Tanpa bentrok, requestId yang sama berhasil sebagai surat BARU (bukan replay surat lain).
  const retry = await createLetter(db, peng, payload({ requestId: 'req-baru-1' }), NOW);
  assert.equal(retry.idempotent, undefined);
  assert.equal(retry.data.id, 'KGB-2026-req-baru-1');
  assert.notEqual(retry.data.id, existing.data.id);
  assert.equal(count(db), 2);
});

test('create replay: data lama dengan request_id NULL dan id sama → idempotent (N6)', async () => {
  const { db, peng, admin } = await setup();
  const legacy = await createLetter(db, admin, payload({ nama: 'Lama' }), NOW);
  db.sqlite.prepare("UPDATE letters SET id = 'KGB-2026-legacy-1' WHERE id = ?").run(legacy.data.id);
  const replay = await createLetter(db, peng, payload({ requestId: 'legacy-1' }), NOW);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.data.id, 'KGB-2026-legacy-1');
  assert.equal(replay.data.nama, 'Lama');
  assert.equal(count(db), 1);
});

test('create: tahun ID memakai WITA (31 Des 16:30 UTC = 2027 WITA)', async () => {
  const { db, peng } = await setup();
  const at = new Date('2026-12-31T16:30:00Z');
  const withRid = await createLetter(db, peng, payload({ requestId: 'wita' }), at);
  assert.equal(withRid.data.id, 'KGB-2027-wita');
  const random = await createLetter(db, peng, payload(), at);
  assert.match(random.data.id, /^KGB-2027-/);
});

test('create: requestId tidak valid ditolak sebelum validasi payload dan tanpa query', async () => {
  const { db, peng } = await setup();
  const { proxy, counter } = counting(db);
  await assert.rejects(
    createLetter(proxy, peng, { requestId: 'a/b' }, NOW),
    isValidation(/^requestId tidak valid\. Gunakan UUID/),
  );
  assert.equal(counter.count, 0);
});

test('create: session_version stale / akun hilang → AUTH_REQUIRED tanpa baris', async () => {
  const { db, peng } = await setup();
  db.sqlite.prepare('UPDATE users SET session_version = 2 WHERE id = 2').run();
  for (const body of [payload(), payload({ requestId: 'stale-1' })]) {
    await assert.rejects(createLetter(db, peng, body, NOW), (err) =>
      err.code === 'AUTH_REQUIRED' && err.message === 'Sesi tidak lagi valid. Silakan login kembali.');
  }
  assert.equal(count(db), 0);

  db.sqlite.prepare('DELETE FROM users WHERE id = 2').run();
  await assert.rejects(createLetter(db, peng, payload(), NOW), (err) =>
    err.code === 'AUTH_REQUIRED' && err.message === 'Akun tidak ditemukan. Silakan login kembali.');
  assert.equal(count(db), 0);
});

test('create: actor stale diprioritaskan di atas replay (sesi stale tidak membaca surat yang ada)', async () => {
  const { db, peng } = await setup();
  await createLetter(db, peng, payload({ requestId: 'dup' }), NOW);
  db.sqlite.prepare('UPDATE users SET session_version = 5 WHERE id = 2').run();
  await assert.rejects(createLetter(db, peng, payload({ requestId: 'dup' }), NOW), { code: 'AUTH_REQUIRED' });
});

// ─── update ─────────────────────────────────────────────────────────────────

test('update: sukses menaikkan version, id/request_id/seq/created_* tetap, body id diabaikan, 1 query', async () => {
  const { db, peng, admin } = await setup();
  await createLetter(db, admin, payload({ nama: 'Pertama' }), NOW);
  const created = await createLetter(db, admin, payload({ requestId: 'upd-1' }), NOW);
  const before = db.sqlite.prepare('SELECT * FROM letters WHERE id = ?').get(created.data.id);

  const later = new Date('2026-10-16T01:02:03.004Z');
  const { proxy, counter } = counting(db);
  const result = await updateLetter(
    proxy, peng, ` ${created.data.id} `,
    payload({ id: 'KGB-LAIN', nama: 'Diubah', kabkot: '', gajiBaru: '4500000', ukuranKertas: 'a4' }),
    later,
  );
  assert.equal(counter.count, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.data.id, created.data.id);
  assert.equal(result.data.nama, 'Diubah');
  assert.equal(result.data.kabkot, '');
  assert.equal(result.data.gajiBaru, 'Rp. 4.500.000,-');
  assert.equal(result.data.ukuranKertas, 'a4');

  const after = db.sqlite.prepare('SELECT * FROM letters WHERE id = ?').get(created.data.id);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.seq, before.seq);
  assert.equal(after.request_id, 'upd-1');
  assert.equal(after.created_at, before.created_at);
  assert.equal(after.created_by, 'admin1');
  assert.equal(after.updated_by, 'peng1');
  assert.equal(after.updated_at, '2026-10-16T01:02:03.004Z');
  assert.equal(after.kabkot, null);
  assert.equal(count(db), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM letters WHERE id = 'KGB-LAIN'"), 0);
});

test('update: id tidak dikenal → not_found (pesan sesuai tabel kosong / tidak kosong)', async () => {
  const { db, peng } = await setup();
  assert.deepEqual(await updateLetter(db, peng, 'KGB-2026-x', payload(), NOW), {
    status: 'not_found', errorCode: 'NOT_FOUND', errorMsg: 'Data surat tidak ditemukan.',
  });
  await createLetter(db, peng, payload(), NOW);
  const { proxy, counter } = counting(db);
  assert.deepEqual(await updateLetter(proxy, peng, 'KGB-2026-x', payload(), NOW), {
    status: 'not_found', errorCode: 'NOT_FOUND', errorMsg: 'Data surat tidak ditemukan atau sudah dihapus.',
  });
  assert.equal(counter.count, 2);
});

test('update: validasi id dan payload; actor stale → AUTH_REQUIRED (prioritas di atas not_found)', async () => {
  const { db, peng } = await setup();
  const created = await createLetter(db, peng, payload(), NOW);
  await assert.rejects(updateLetter(db, peng, 'a<b', payload(), NOW), isValidation(/^ID surat tidak valid\.$/));
  await assert.rejects(updateLetter(db, peng, created.data.id, payload({ mkBaruThn: '0' }), NOW), isValidation(/mkBaruThn/));

  db.sqlite.prepare('UPDATE users SET session_version = 3 WHERE id = 2').run();
  await assert.rejects(updateLetter(db, peng, created.data.id, payload({ nama: 'X' }), NOW), { code: 'AUTH_REQUIRED' });
  await assert.rejects(updateLetter(db, peng, 'tidak-ada', payload(), NOW), { code: 'AUTH_REQUIRED' });
  assert.equal(db.sqlite.prepare('SELECT nama, version FROM letters').get().version, 1);
});

// ─── delete ─────────────────────────────────────────────────────────────────

test('delete: admin sukses (1 query), pengelola FORBIDDEN, tidak dikenal not_found', async () => {
  const { db, peng, admin } = await setup();
  const created = await createLetter(db, peng, payload(), NOW);

  await assert.rejects(deleteLetter(db, peng, created.data.id), (err) =>
    err.code === 'FORBIDDEN' && err.message === 'Hanya administrator yang dapat menghapus arsip.');
  assert.equal(count(db), 1);

  const { proxy, counter } = counting(db);
  assert.deepEqual(await deleteLetter(proxy, admin, created.data.id), { status: 'success', id: created.data.id });
  assert.equal(counter.count, 1);
  assert.equal(count(db), 0);

  assert.deepEqual(await deleteLetter(db, admin, created.data.id), {
    status: 'not_found', errorCode: 'NOT_FOUND', errorMsg: 'Data surat tidak ditemukan.',
  });
  await assert.rejects(deleteLetter(db, admin, ''), isValidation(/^ID surat tidak valid\.$/));
});

test('delete: role LIVE dipakai (sesi bilang admin, users bilang pengelola → FORBIDDEN)', async () => {
  const { db, admin } = await setup();
  await db.exec(`INSERT INTO users (id, username, password_hash, nama_lengkap, role) VALUES (3, 'admin2', '${HASH}', 'Admin Dua', 'admin')`);
  const created = await createLetter(db, admin, payload(), NOW);
  db.sqlite.prepare("UPDATE users SET role = 'pengelola' WHERE id = 1").run();
  await assert.rejects(deleteLetter(db, admin, created.data.id), { code: 'FORBIDDEN' });
  assert.equal(count(db), 1);
});

test('delete: urutan Bagian 5.3 — actor stale > bukan admin > tidak ditemukan', async () => {
  const { db, peng, admin } = await setup();
  // Pengelola + id tidak dikenal → FORBIDDEN (bukan NOT_FOUND).
  await assert.rejects(deleteLetter(db, peng, 'tidak-ada'), { code: 'FORBIDDEN' });
  // Pengelola stale + id tidak dikenal → AUTH_REQUIRED.
  db.sqlite.prepare('UPDATE users SET session_version = 2 WHERE id = 2').run();
  await assert.rejects(deleteLetter(db, peng, 'tidak-ada'), { code: 'AUTH_REQUIRED' });
  // Admin stale + surat ada → AUTH_REQUIRED, surat tetap ada.
  const created = await createLetter(db, admin, payload(), NOW);
  db.sqlite.prepare('UPDATE users SET session_version = 9 WHERE id = 1').run();
  await assert.rejects(deleteLetter(db, admin, created.data.id), (err) =>
    err.code === 'AUTH_REQUIRED' && err.message === 'Sesi tidak lagi valid. Silakan login kembali.');
  assert.equal(count(db), 1);
});

// ─── Error D1 ───────────────────────────────────────────────────────────────

test('error D1 sementara → DATA_SERVICE_UNAVAILABLE tanpa teks D1 mentah', async () => {
  const { db, peng, admin } = await setup();
  const created = await createLetter(db, admin, payload(), NOW);
  const failing = {
    prepare() {
      throw new Error('D1_ERROR: Network connection lost.', { cause: new Error('Network connection lost.') });
    },
  };
  const checks = [
    () => listLetters(failing, peng),
    () => createLetter(failing, peng, payload(), NOW),
    () => updateLetter(failing, peng, created.data.id, payload(), NOW),
    () => deleteLetter(failing, admin, created.data.id),
  ];
  for (const run of checks) {
    await assert.rejects(run(), (err) => {
      assert.equal(err.code, 'DATA_SERVICE_UNAVAILABLE');
      assert.doesNotMatch(err.message, /D1_ERROR|Network connection lost/);
      assert.equal(err.cause, undefined);
      return true;
    });
  }
});

test('error constraint D1 → DATA_WRITE_FAILED tanpa teks D1 mentah', async () => {
  const { db, peng } = await setup();
  // Proxy mengubah nama tabel sehingga SQLite melempar "no such table" (error non-sementara).
  const broken = {
    prepare(sql) {
      return db.prepare(sql.replace('INSERT INTO letters', 'INSERT INTO letters_tidak_ada'));
    },
  };
  await assert.rejects(createLetter(broken, peng, payload(), NOW), (err) => {
    assert.equal(err.code, 'DATA_WRITE_FAILED');
    assert.doesNotMatch(err.message, /letters_tidak_ada|D1_ERROR/);
    return true;
  });
});

test('rowToLetter: NULL/legacy tolerant (kabkot NULL → "", ukuran uppercase → lowercase)', () => {
  const letter = rowToLetter({
    id: 'KGB-1', status_pegawai: 'PNS', nama: 'X', nip: '1', pangkat: 'P', jabatan: 'J', unit: 'U',
    kabkot: null, sk_pejabat: 'S', sk_tanggal: '2024-01-02', sk_nomor: 'N', sk_tmt: '2024-01-01',
    mk_lama_thn: 0, mk_lama_bln: 0, gaji_lama: 0, mk_baru_thn: 1, mk_baru_bln: 0,
    gaji_baru_tmt: '2024-01-01', gaji_baru: 4123400, surat_nomor: 'S', surat_tanggal: '2024-01-10',
    sign_jabatan: 'a', sign_nama: 'b', sign_pangkat: 'c', sign_nip: 'd', ukuran_kertas: 'LEGAL',
    request_id: 'r', seq: 1, version: 1, created_by: 'x', created_at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(letter.kabkot, '');
  assert.equal(letter.mkLamaThn, '0');
  assert.equal(letter.gajiLama, 'Rp. 0,-');
  assert.equal(letter.gajiBaru, 'Rp. 4.123.400,-');
  assert.equal(letter.ukuranKertas, 'legal');
  assert.equal(Object.keys(letter).length, 26);
  for (const hidden of ['requestId', 'request_id', 'seq', 'version', 'createdBy', 'createdAt', 'created_at']) {
    assert.equal(hidden in letter, false, hidden);
  }
});
