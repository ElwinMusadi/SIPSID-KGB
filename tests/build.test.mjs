import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("build utama hanya menghasilkan Pages fetch-only dan tidak mengubah snapshot rollback GAS", async () => {
  const gasBefore = await readFile(resolve(root, "gas", "Index.html"));
  await mkdir(resolve(root, "dist"), { recursive: true });
  await writeFile(resolve(root, "dist", "stale-removed.txt"), 'removed asset');
  await execFileAsync(process.execPath, ["scripts/build-pages.mjs"], { cwd: root });
  await assert.rejects(readFile(resolve(root, "dist", "stale-removed.txt")), { code: 'ENOENT' });

  const pages = await readFile(resolve(root, "dist", "index.html"), "utf8");
  const source = await readFile(resolve(root, "Index.html"), "utf8");
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  assert.equal(pages.includes("<?"), false);
  assert.equal(pages.includes("script.google.com/macros/s/"), false);
  assert.doesNotMatch(pages, /google\.script\.run|isGasRuntime|INITIAL_SERVER_DATA|parseEmbeddedErrorMarker/);
  assert.doesNotMatch(pages, /lh3\.googleusercontent\.com|placehold\.co|sipsid_session/);
  assert.equal(pages, source);
  assert.equal(pkg.scripts.build, "npm run build:pages");
  assert.deepEqual(await readFile(resolve(root, "gas", "Index.html")), gasBefore);
  for (const asset of ["logo-sipsid-kgb.png", "kop-surat-ntt.png", "logo-fallback.svg"]) {
    assert.deepEqual(await readFile(resolve(root, "dist", "assets", asset)), await readFile(resolve(root, "public", "assets", asset)));
    assert.ok(source.includes(`/assets/${asset}`), `Frontend harus merujuk aset lokal ${asset}`);
  }
  for (const asset of ["logo-sipsid-kgb.png", "kop-surat-ntt.png"]) {
    const png = await readFile(resolve(root, "dist", "assets", asset));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
  }
  const headers = await readFile(resolve(root, "dist", "_headers"), "utf8");
  assert.match(headers, /img-src 'self' data: blob:/);
  assert.doesNotMatch(headers, /lh3\.googleusercontent|placehold\.co/);
  assert.deepEqual(await readFile(resolve(root, "dist", "404.html")), await readFile(resolve(root, "public", "404.html")));
});

test("source frontend tidak menyimpan credential pengguna", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.equal(html.includes("const usersDatabase"), false);
  assert.equal(html.includes('password: "123456789"'), false);
  assert.equal(html.includes("mode: 'no-cors'"), false);
});

test("build Pages menolak source GAS sebelum menghapus output sebelumnya", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'sipsid-build-guard-'));
  try {
    await mkdir(resolve(dir, 'scripts'));
    await mkdir(resolve(dir, 'dist'));
    await cp(resolve(root, 'scripts/build-pages.mjs'), resolve(dir, 'scripts/build-pages.mjs'));
    await writeFile(resolve(dir, 'Index.html'), '<html><script>google.script.run.test()</script></html>');
    await writeFile(resolve(dir, 'dist/sentinel.txt'), 'previous output');
    await assert.rejects(execFileAsync(process.execPath, ['scripts/build-pages.mjs'], { cwd: dir }), /marker terlarang/);
    assert.equal(await readFile(resolve(dir, 'dist/sentinel.txt'), 'utf8'), 'previous output');
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("build GAS ditolak sebelum menimpa snapshot rollback setelah migrasi frontend", async () => {
  const before = await Promise.all(["Code.js", "Index.html", "appsscript.json"].map(name => readFile(resolve(root, "gas", name))));
  await assert.rejects(execFileAsync(process.execPath, ["scripts/build-gas.mjs"], { cwd: root }), /pre-d1-cutover/);
  const after = await Promise.all(["Code.js", "Index.html", "appsscript.json"].map(name => readFile(resolve(root, "gas", name))));
  assert.deepEqual(after, before);
});

test("template surat memuat placeholder barcode SRIKANDI secara literal", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.match(html, /id="srikandi-signature-marker"/);
  assert.match(html, /\\\$\{ttd_pengirim\}/);
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
  for (const action of ["users.list", "users.create", "users.update", "users.resetPassword", "users.delete"]) {
    assert.match(script, new RegExp(`"${action.replace(".", "\\.")}"`),
      `verify:gas harus memeriksa aksi ${action}`);
  }
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
