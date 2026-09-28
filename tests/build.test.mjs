import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("build menghasilkan artifact Pages dan GAS yang terpisah", async () => {
  await execFileAsync(process.execPath, ["scripts/build-pages.mjs"], { cwd: root });
  await execFileAsync(process.execPath, ["scripts/build-gas.mjs"], { cwd: root });

  const pages = await readFile(resolve(root, "dist", "index.html"), "utf8");
  const gas = await readFile(resolve(root, "gas", "Index.html"), "utf8");
  const gasCode = await readFile(resolve(root, "gas", "Code.js"), "utf8");

  assert.equal(pages.includes("<?"), false);
  assert.equal(pages.includes("script.google.com/macros/s/"), false);
  assert.match(pages, /const INITIAL_SERVER_DATA = \{"status":"success"/);
  assert.match(gas, /<\?!= serverData \?>/);
  assert.match(gasCode, /function doPost\(e\)/);
});

test("source frontend tidak menyimpan credential pengguna", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.equal(html.includes("const usersDatabase"), false);
  assert.equal(html.includes('password: "123456789"'), false);
  assert.equal(html.includes("mode: 'no-cors'"), false);
});

test("template surat memuat placeholder barcode SRIKANDI secara literal", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.match(html, /id="srikandi-signature-marker"/);
  assert.match(html, /\\\$\{ttd_pengirim\}/);

  await execFileAsync(process.execPath, ["scripts/build-pages.mjs"], { cwd: root });
  await execFileAsync(process.execPath, ["scripts/build-gas.mjs"], { cwd: root });
  const pages = await readFile(resolve(root, "dist", "index.html"), "utf8");
  const gas = await readFile(resolve(root, "gas", "Index.html"), "utf8");
  assert.match(pages, /id="srikandi-signature-marker"/);
  assert.match(pages, /\\\$\{ttd_pengirim\}/);
  assert.match(gas, /id="srikandi-signature-marker"/);
  assert.match(gas, /\\\$\{ttd_pengirim\}/);
});

test("download PDF menyembunyikan marker raster dan menambah text layer native", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.match(html, /const SRIKANDI_SIGNATURE_MARKER = '\$\{ttd_pengirim\}'/);
  assert.match(html, /onclone:\s*clonedDocument\s*=>/);
  assert.match(html, /visibility', 'hidden', 'important'/);
  assert.match(html, /pdf\.text\(SRIKANDI_SIGNATURE_MARKER, absoluteX, localY, \{ align: 'center' \}\)/);
  assert.match(html, /crossesPageBoundary/);
  assert.match(html, /getSrikandiMarkerMetrics\(sheet\)/);
  assert.match(html, /createPdfFromCanvas\(canvas, ukuranKertas\)/);
});

test("laporan rekapitulasi diunduh sebagai PDF menggunakan generator bersama", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.doesNotMatch(html, /onclick="window\.print\(\)"/);
  assert.match(html, /id="btn-download-report-pdf"/);
  assert.match(html, /onclick="downloadReportPdf\(\)"/);
  assert.match(html, /async function downloadReportPdf\(\)/);
  assert.match(html, /renderElementToCanvas\(sheet\)/);
  assert.match(html, /createPdfFromCanvas\(canvas, 'legal'\)/);
  assert.match(html, /buildReportPdfFileName\(activeReportContext\)/);

  await execFileAsync(process.execPath, ["scripts/build-pages.mjs"], { cwd: root });
  await execFileAsync(process.execPath, ["scripts/build-gas.mjs"], { cwd: root });
  const pages = await readFile(resolve(root, "dist", "index.html"), "utf8");
  const gas = await readFile(resolve(root, "gas", "Index.html"), "utf8");
  for (const artifact of [pages, gas]) {
    assert.doesNotMatch(artifact, /onclick="window\.print\(\)"/);
    assert.match(artifact, /async function downloadReportPdf\(\)/);
    assert.match(artifact, /id="btn-download-report-pdf"/);
  }
});

test("push-gas.mjs menyertakan instruksi 'New version' dan bukan '@HEAD atau nomor tertinggi'", async () => {
  const script = await readFile(resolve(root, "scripts", "push-gas.mjs"), "utf8");

  // Instruksi yang benar: New version
  assert.match(script, /New version/,
    "push-gas.mjs harus menginstruksikan 'New version' pada dropdown Version");

  // Instruksi yang benar: verify:gas
  assert.match(script, /verify:gas/,
    "push-gas.mjs harus menginstruksikan 'npm run verify:gas' setelah deployment");

  // Instruksi yang salah tidak boleh ada
  assert.doesNotMatch(script, /@HEAD/,
    "push-gas.mjs tidak boleh menginstruksikan pilih '@HEAD'");
  assert.doesNotMatch(script, /nomor tertinggi/,
    "push-gas.mjs tidak boleh menginstruksikan pilih nomor tertinggi");

  // Penjelasan bahwa URL /exec dan deployment ID tetap sama setelah New version
  assert.match(script, /deployment ID.*tetap|tetap sama/,
    "push-gas.mjs harus menjelaskan bahwa deployment ID dan URL /exec tidak berubah");
});

test("verify-gas-deployment.mjs mengarahkan remediation ke 'New version'", async () => {
  const script = await readFile(resolve(root, "scripts", "verify-gas-deployment.mjs"), "utf8");

  assert.match(script, /New version/,
    "verify:gas harus menginstruksikan 'New version' saat deployment belum mengenali manifest");
  assert.match(script, /Jalankan kembali: npm run verify:gas/,
    "verify:gas harus meminta verifikasi ulang setelah deployment diperbarui");
  assert.doesNotMatch(script, /Pilih version terbaru|pilih versi terbaru/i,
    "verify:gas tidak boleh memakai instruksi versi terbaru yang ambigu");
});

test("README menyebut 'New version', verify:gas, dan bahwa clasp push tidak memperbarui /exec", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");

  // Kunci runbook: New version
  assert.match(readme, /New version/,
    "README harus menginstruksikan 'New version' untuk memperbarui deployment GAS");

  // Perintah verifikasi
  assert.match(readme, /verify:gas/,
    "README harus menyebut 'npm run verify:gas'");

  // Koreksi miskonsepsi kunci
  assert.match(readme, /clasp push.*tidak memperbarui|tidak.*memperbarui.*\/exec/,
    "README harus menjelaskan bahwa clasp push saja tidak memperbarui endpoint /exec");

  // Fitur update arsip harus masuk ke testing flow
  assert.match(readme, /update/i,
    "README harus menyebut 'update' dalam daftar langkah uji (testing flow)");

  // Perintah verify:gas harus ada di daftar perintah
  assert.match(readme, /npm run verify:gas/,
    "README harus mendaftarkan 'npm run verify:gas' di bagian Perintah");
});
