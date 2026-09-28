/**
 * verify-gas-deployment.mjs
 *
 * Verifikasi bahwa GAS deployment aktif yang ditunjuk oleh GAS_WEB_APP_URL
 * mengenali semua aksi yang diperlukan Cloudflare, termasuk letters.update.
 *
 * Penggunaan:
 *   node scripts/verify-gas-deployment.mjs
 *
 * Memerlukan variabel lingkungan (atau file .dev.vars):
 *   GAS_WEB_APP_URL       — URL deployment GAS produksi/staging
 *   CLOUDFLARE_API_SECRET — secret yang sama di GAS Script Properties
 *
 * Exit code 0 = OK, 1 = mismatch atau error (deployment perlu diperbarui).
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Baca GAS_BACKEND_VERSION yang di-expect dari source ──────────────────────
const codeSource = await readFile(resolve(root, "Code.js"), "utf8");
const versionMatch = codeSource.match(/^var GAS_BACKEND_VERSION\s*=\s*["']([^"']+)["']/m);
if (!versionMatch) {
  console.error("ERROR: GAS_BACKEND_VERSION tidak ditemukan di Code.js");
  process.exitCode = 1;
  process.exit();
}
const expectedVersion = versionMatch[1];

// Daftar aksi yang WAJIB didukung GAS deployment aktif.
// Sumber kebenaran: ROUTES di functions/api/[[path]].js + aksi dynamic.
const REQUIRED_ACTIONS = [
  "auth.login",
  "auth.logout",
  "bootstrap.get",
  "letters.list",
  "letters.create",
  "letters.update",
  "letters.delete",
  "users.list",
  "users.create",
  "users.update",
  "users.resetPassword",
  "users.delete",
  "system.manifest",
];

// ── Baca konfigurasi dari .dev.vars atau environment ─────────────────────────
let gasUrl = process.env.GAS_WEB_APP_URL || "";
let apiSecret = process.env.CLOUDFLARE_API_SECRET || "";

if (!gasUrl || !apiSecret) {
  try {
    const devVars = await readFile(resolve(root, ".dev.vars"), "utf8");
    for (const line of devVars.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (!m) continue;
      if (m[1] === "GAS_WEB_APP_URL" && !gasUrl) gasUrl = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "CLOUDFLARE_API_SECRET" && !apiSecret) apiSecret = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // .dev.vars tidak ada — lanjut dengan env saja
  }
}

if (!gasUrl || !apiSecret) {
  console.error("ERROR: GAS_WEB_APP_URL dan CLOUDFLARE_API_SECRET wajib diset di environment atau .dev.vars");
  console.error("  Contoh .dev.vars:");
  console.error("    GAS_WEB_APP_URL=https://script.google.com/macros/s/<id>/exec");
  console.error("    CLOUDFLARE_API_SECRET=<secret yang sama di GAS Script Properties>");
  process.exitCode = 1;
  process.exit();
}

// ── Panggil system.manifest di GAS ───────────────────────────────────────────
console.log("Menghubungi GAS deployment:", gasUrl);
console.log("Memeriksa versi dan routing aksi...");
console.log("");

let manifest;
try {
  const response = await fetch(gasUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "system.manifest", apiSecret }),
    redirect: "follow",
  });
  const raw = await response.json();
  if (raw.status !== "success") {
    console.error("ERROR: GAS mengembalikan status error:", JSON.stringify(raw, null, 2));
    console.error("");
    if (raw.errorCode === "ACTION_NOT_FOUND") {
      console.error("DIAGNOSIS: Deployment aktif TIDAK mengenali system.manifest.");
      console.error("  Ini memastikan bahwa deployment aktif menjalankan versi lama");
      console.error("  yang belum punya letters.update dan aksi baru lainnya.");
      console.error("");
      console.error("  TINDAKAN: Perbarui GAS deployment secara manual:");
      console.error("    1. https://script.google.com/ → SIPSID-KGB");
      console.error("    2. Deploy → Manage deployments → [deployment produksi] → Edit");
      console.error("    3. Version → New version → Deploy");
      console.error("    4. Jalankan kembali: npm run verify:gas");
    }
    process.exitCode = 1;
    process.exit();
  }
  manifest = raw;
} catch (err) {
  console.error("ERROR: Gagal menghubungi GAS:", err.message);
  process.exitCode = 1;
  process.exit();
}

// ── Periksa versi ─────────────────────────────────────────────────────────────
let hasError = false;

if (manifest.gasBackendVersion !== expectedVersion) {
  console.error(
    `MISMATCH versi: source expect ${expectedVersion}, ` +
    `deployment melaporkan ${manifest.gasBackendVersion}`
  );
  console.error("  Deployment aktif menjalankan versi lama. Perbarui deployment GAS.");
  hasError = true;
} else {
  console.log("✔ gasBackendVersion:", manifest.gasBackendVersion, "(sesuai source)");
}

// ── Periksa supportedActions ──────────────────────────────────────────────────
const supported = Array.isArray(manifest.supportedActions) ? manifest.supportedActions : [];
const missing = REQUIRED_ACTIONS.filter(a => !supported.includes(a));

if (missing.length > 0) {
  console.error("AKSI TIDAK DIKENALI oleh deployment aktif:", missing.join(", "));
  console.error("  Deployment masih menjalankan versi lama yang belum punya aksi tersebut.");
  console.error("  Edit arsip surat (letters.update) akan mengembalikan ACTION_NOT_FOUND");
  console.error("  sampai deployment diperbarui.");
  hasError = true;
} else {
  console.log("✔ Semua", REQUIRED_ACTIONS.length, "aksi dikenali oleh deployment aktif");
  console.log("  Aksi didukung:", supported.join(", "));
}

// ── Hasil akhir ───────────────────────────────────────────────────────────────
console.log("");
if (hasError) {
  console.error("═══════════════════════════════════════════════════════════════════════");
  console.error("  VERIFIKASI GAGAL — Deployment GAS perlu diperbarui sebelum fitur");
  console.error("  edit arsip surat dapat berfungsi di produksi.");
  console.error("═══════════════════════════════════════════════════════════════════════");
  process.exitCode = 1;
} else {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  VERIFIKASI BERHASIL — Deployment GAS aktif sudah up-to-date.");
  console.log("  Fitur edit arsip surat (letters.update) siap digunakan.");
  console.log("═══════════════════════════════════════════════════════════════════════");
}
