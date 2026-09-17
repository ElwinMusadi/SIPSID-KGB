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
  assert.match(html, /\\\$\{ttd_pengirim\}/);

  await execFileAsync(process.execPath, ["scripts/build-pages.mjs"], { cwd: root });
  await execFileAsync(process.execPath, ["scripts/build-gas.mjs"], { cwd: root });
  const pages = await readFile(resolve(root, "dist", "index.html"), "utf8");
  const gas = await readFile(resolve(root, "gas", "Index.html"), "utf8");
  assert.match(pages, /\\\$\{ttd_pengirim\}/);
  assert.match(gas, /\\\$\{ttd_pengirim\}/);
});
