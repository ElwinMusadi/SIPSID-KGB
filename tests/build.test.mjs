import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("build utama hanya menghasilkan Pages fetch-only", async () => {
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

test("artifact dan script Google Apps Script sudah dihapus (Fase 6)", async () => {
  for (const file of ["Code.js", "appsscript.json", "gas/Code.js", "gas/Index.html", "gas/appsscript.json",
    "scripts/build-gas.mjs", "scripts/push-gas.mjs", "scripts/verify-gas-deployment.mjs",
    ".clasp.json", ".claspignore", "gas/.clasp.json"]) {
    await assert.rejects(access(resolve(root, file)), { code: "ENOENT" }, `${file} harus sudah dihapus`);
  }
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const script of ["build:gas", "push:gas", "verify:gas"]) {
    assert.equal(Object.hasOwn(pkg.scripts, script), false, `package.json tidak boleh memuat script ${script}`);
  }
  assert.equal(Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, "@google/clasp"), false);
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

test("laporan rekapitulasi diunduh sebagai PDF per halaman pratinjau", async () => {
  const html = await readFile(resolve(root, "Index.html"), "utf8");
  assert.doesNotMatch(html, /onclick="window\.print\(\)"/);
  assert.match(html, /id="btn-download-report-pdf"/);
  assert.match(html, /onclick="downloadReportPdf\(\)"/);
  assert.match(html, /async function downloadReportPdf\(\)/);
  assert.match(html, /sheet\.querySelectorAll\('\.report-page'\)/);
  assert.match(html, /renderElementToCanvas\(page, \{/);
  assert.match(html, /pdf\.addPage\('legal', 'portrait'\)/);
  assert.match(html, /buildReportPdfFileName\(activeReportContext\)/);
});
