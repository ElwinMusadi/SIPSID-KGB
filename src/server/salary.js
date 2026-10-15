// Master gaji (pengganti `readMasterGaji_` / `getBootstrapData_` di Code.js).
// Code.js = backend GAS lama, dihapus pada Fase 6; sumbernya ada di tag `pre-d1-cutover`.
//
// Urutan hasil harus sama dengan GAS: baris sheet dari atas ke bawah, lalu kolom MKG dari kiri ke
// kanan, dipisah per status. Asumsi: `salary_grades.sort_order` = nomor baris sheet
// Master_Gaji_Pangkat (diisi oleh tooling migrasi Fase 2) dan kolom header `MKG n Tahun` tersusun
// naik menurut n, sehingga urutan kolom sama dengan `ORDER BY mkg`. Satu baris sheet = satu
// `sort_order` untuk seluruh MKG-nya.
//
// Query D1: 1.

import { all } from './db.js';
import { fromD1Error } from './errors.js';

/**
 * `bootstrap.get`.
 * @param {object} db binding D1
 * @returns {Promise<{ status: 'success', gajiPNS: {mkg:number,pangkat:string,nominal:string}[],
 *   gajiPPPK: {mkg:number,pangkat:string,nominal:string}[], errorMsg: '' }>}
 */
export async function getBootstrap(db) {
  let rows;
  try {
    rows = await all(
      db,
      `SELECT status_pegawai, pangkat, mkg, nominal
         FROM salary_grades
        WHERE nominal > 0
        ORDER BY status_pegawai, sort_order, mkg, id`,
    );
  } catch (error) {
    throw fromD1Error(error);
  }
  const result = { status: 'success', gajiPNS: [], gajiPPPK: [], errorMsg: '' };
  for (const row of rows) {
    const item = { mkg: Number(row.mkg), pangkat: String(row.pangkat), nominal: String(row.nominal) };
    if (row.status_pegawai === 'PNS') result.gajiPNS.push(item);
    else if (row.status_pegawai === 'PPPK') result.gajiPPPK.push(item);
  }
  return result;
}
