import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from './helpers/d1-sqlite.mjs';
import { getBootstrap } from '../src/server/salary.js';
import { run } from '../src/server/db.js';

test('salary: getBootstrap returns empty arrays and correct shape on empty table', async () => {
  const db = createTestDb();
  const res = await getBootstrap(db);

  assert.deepEqual(res, {
    status: 'success',
    gajiPNS: [],
    gajiPPPK: [],
    errorMsg: '',
  });
});

test('salary: getBootstrap returns expected shape, nominal digit string, mkg number, ordered correctly', async () => {
  const db = createTestDb();

  // Insert synthetic rows for PNS with various sort_order and mkg out of insertion order
  // Table: id, status_pegawai, pangkat, golongan_code, mkg, nominal, sort_order
  await run(
    db,
    `INSERT INTO salary_grades (id, status_pegawai, pangkat, golongan_code, mkg, nominal, sort_order)
     VALUES
       (1, 'PNS', 'Penata Muda (III/a)', 'III/a', 2, 2800000, 10),
       (2, 'PNS', 'Penata Muda (III/a)', 'III/a', 0, 2600000, 10),
       (3, 'PNS', 'Pengatur (II/c)', 'II/c', 0, 2400000, 5),
       (4, 'PNS', 'Penata Muda (III/a)', 'III/a', 4, 3000000, 10),
       (5, 'PPPK', 'Ahli Pertama (IX)', 'IX', 2, 3200000, 2),
       (6, 'PPPK', 'Ahli Pertama (IX)', 'IX', 0, 3000000, 2),
       (7, 'PPPK', 'Pemula (V)', 'V', 0, 2000000, 1)`,
  );

  const res = await getBootstrap(db);

  assert.equal(res.status, 'success');
  assert.equal(res.errorMsg, '');
  assert.equal(Array.isArray(res.gajiPNS), true);
  assert.equal(Array.isArray(res.gajiPPPK), true);

  // Check PNS ordering: sort_order 5 first, then sort_order 10 ordered by mkg 0, 2, 4
  assert.equal(res.gajiPNS.length, 4);
  assert.deepEqual(res.gajiPNS[0], { mkg: 0, pangkat: 'Pengatur (II/c)', nominal: '2400000' });
  assert.deepEqual(res.gajiPNS[1], { mkg: 0, pangkat: 'Penata Muda (III/a)', nominal: '2600000' });
  assert.deepEqual(res.gajiPNS[2], { mkg: 2, pangkat: 'Penata Muda (III/a)', nominal: '2800000' });
  assert.deepEqual(res.gajiPNS[3], { mkg: 4, pangkat: 'Penata Muda (III/a)', nominal: '3000000' });

  // Types verification
  for (const item of res.gajiPNS) {
    assert.equal(typeof item.mkg, 'number');
    assert.equal(typeof item.pangkat, 'string');
    assert.equal(typeof item.nominal, 'string');
    assert.match(item.nominal, /^\d+$/);
  }

  // Check PPPK ordering: sort_order 1 first, then sort_order 2 ordered by mkg 0, 2
  assert.equal(res.gajiPPPK.length, 3);
  assert.deepEqual(res.gajiPPPK[0], { mkg: 0, pangkat: 'Pemula (V)', nominal: '2000000' });
  assert.deepEqual(res.gajiPPPK[1], { mkg: 0, pangkat: 'Ahli Pertama (IX)', nominal: '3000000' });
  assert.deepEqual(res.gajiPPPK[2], { mkg: 2, pangkat: 'Ahli Pertama (IX)', nominal: '3200000' });

  for (const item of res.gajiPPPK) {
    assert.equal(typeof item.mkg, 'number');
    assert.equal(typeof item.pangkat, 'string');
    assert.equal(typeof item.nominal, 'string');
    assert.match(item.nominal, /^\d+$/);
  }
});

test('salary: schema CHECK prevents nominal <= 0 and query filters nominal > 0', async () => {
  const db = createTestDb();

  // Attempting to insert nominal <= 0 is rejected by schema CHECK
  await assert.rejects(
    async () => {
      await run(
        db,
        `INSERT INTO salary_grades (id, status_pegawai, pangkat, golongan_code, mkg, nominal, sort_order)
         VALUES (99, 'PNS', 'Pangkat', 'III/a', 0, 0, 1)`,
      );
    },
    (err) => err.message.includes('SQLITE_CONSTRAINT'),
  );

  await assert.rejects(
    async () => {
      await run(
        db,
        `INSERT INTO salary_grades (id, status_pegawai, pangkat, golongan_code, mkg, nominal, sort_order)
         VALUES (100, 'PNS', 'Pangkat', 'III/a', 0, -500, 1)`,
      );
    },
    (err) => err.message.includes('SQLITE_CONSTRAINT'),
  );
});

test('salary: getBootstrap maps D1 query errors through fromD1Error', async () => {
  const fakeDb = {
    prepare() {
      throw new Error('D1_ERROR: Network connection lost.');
    },
  };

  await assert.rejects(
    async () => {
      await getBootstrap(fakeDb);
    },
    (err) => err.code === 'DATA_SERVICE_UNAVAILABLE',
  );
});
