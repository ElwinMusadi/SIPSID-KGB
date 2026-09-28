import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gasDir = resolve(root, "gas");
const executable = process.platform === "win32" ? "clasp.cmd" : "clasp";

// Baca GAS_BACKEND_VERSION dari Code.js supaya instruksi post-push akurat.
const codeSource = await readFile(resolve(root, "Code.js"), "utf8");
const versionMatch = codeSource.match(/^var GAS_BACKEND_VERSION\s*=\s*["']([^"']+)["']/m);
const gasVersion = versionMatch ? versionMatch[1] : "(tidak ditemukan)";

const child = spawn(executable, ["push"], { cwd: gasDir, stdio: "inherit", shell: false });

child.on("error", error => {
  console.error(`Gagal menjalankan clasp: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", code => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PERINGATAN PENTING — BACA SEBELUM MENGANGGAP DEPLOY SELESAI
  // ─────────────────────────────────────────────────────────────────────────────
  // `clasp push` hanya mengunggah source ke GAS editor sebagai HEAD yang belum
  // punya versi. Endpoint produksi (/exec) yang dikonsumsi Cloudflare MASIH
  // melayani versi lama sampai deployment yang sama diperbarui ke New version.
  //
  // Error "Pembaruan Gagal. Aksi API tidak dikenal" terjadi persis karena
  // deployment aktif melayani versi lama sebelum langkah ini diselesaikan.
  //
  // LANGKAH WAJIB SETELAH clasp push (URL /exec TIDAK berubah):
  //   1. Buka: https://script.google.com/ → project SIPSID-KGB
  //   2. Klik Deploy → Manage deployments
  //   3. Temukan deployment produksi (yang URL-nya sama dengan GAS_WEB_APP_URL
  //      di Cloudflare) → klik ikon Edit (pensil) pada baris deployment itu
  //   4. Di dropdown "Version" pilih "New version" — JANGAN pilih nomor lama
  //   5. Klik Deploy — deployment ID dan URL /exec tetap sama, hanya versi yang diperbarui
  //   6. Jalankan verifikasi: npm run verify:gas
  // ─────────────────────────────────────────────────────────────────────────────

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  clasp push BERHASIL — GAS_BACKEND_VERSION: " + gasVersion);
  console.log("  ⚠  Endpoint produksi (/exec) MASIH melayani versi lama.");
  console.log("");
  console.log("  LANGKAH WAJIB:");
  console.log("  1. Buka https://script.google.com/ → project SIPSID-KGB");
  console.log("  2. Deploy → Manage deployments");
  console.log("  3. Temukan deployment produksi → klik Edit (ikon pensil)");
  console.log("  4. Version: pilih \"New version\" → klik Deploy");
  console.log("     (URL /exec tidak berubah; deployment ID tetap sama)");
  console.log("  5. Jalankan: npm run verify:gas");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("");
});
