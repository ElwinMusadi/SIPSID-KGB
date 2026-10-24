# SIPSID-KGB

Aplikasi pembuatan dan arsip surat Kenaikan Gaji Berkala (KGB). Satu stack:

- **Cloudflare Pages** menyajikan frontend statis dari `dist/` (dibangun dari `Index.html` + `public/`).
- **Pages Functions** `functions/api/[[path]].js` menangani `/api/*` (routing, cookie sesi, validasi origin, batas payload 64 KiB) dan menjalankan action in-process lewat `src/server/` (`dispatch.js`, `auth.js`, `letters.js`, `users.js`, `salary.js`).
- **Cloudflare D1** (`sipsid-kgb`, binding `DB`) menyimpan `users`, `sessions`, `login_throttle`, `letters`, dan `salary_grades`. Schema ada di `migrations/`.

Frontend hanya memanggil `/api/*` dengan `fetch`. Backend melaporkan `backendVersion` di setiap envelope `{ ok, data, error }`.

## Struktur

```text
Index.html                 Source frontend (disalin apa adanya ke dist/index.html)
public/                    _headers (CSP), 404.html, aset lokal
functions/api/[[path]].js  Gateway Pages Functions
src/server/                Domain backend (D1)
migrations/                Migrasi schema D1
scripts/build-pages.mjs    Build dist/ (menolak marker terlarang sebelum menghapus output lama)
scripts/export-d1-to-csv.mjs        Ekspor D1 ke CSV (backup sekunder; backup utama: wrangler d1 export)
scripts/audit-sheets.mjs, scripts/migrate-sheets-to-d1.mjs   Tooling import historis (lihat MIGRATION_PLAN.md)
tests/                     Node test runner (D1 memakai node:sqlite)
```

## Pengembangan lokal

Persyaratan: **Node.js 24** (test memakai `node:sqlite`) dan npm.

```powershell
npm ci
npm test
npm run build
Copy-Item .dev.vars.example .dev.vars   # isi PASSWORD_PEPPER lokal
npx wrangler d1 migrations apply sipsid-kgb --local
npx wrangler pages dev dist
```

`npm run dev:pages` menjalankan build lalu `wrangler pages dev dist`. Database lokal ada di `.wrangler/` (diabaikan Git). Jangan mengisi `.dev.vars` dengan nilai produksi.

## Perintah

```powershell
npm test             # Seluruh test (node --test tests/*.test.mjs)
npm run build        # Alias build:pages
npm run build:pages  # Bangun dist/
npm run dev:pages    # Build + preview lokal Pages
```

## Secrets dan variabel

Diatur sebagai **Pages secrets** (Workers & Pages → sipsid-kgb → Settings → Variables and Secrets, atau `npx wrangler pages secret put <NAMA> --project-name sipsid-kgb`). Jangan ditaruh di `wrangler.toml`. Perubahan secret baru berlaku setelah **deployment baru**.

| Nama | Keterangan |
|---|---|
| `PASSWORD_PEPPER` | Wajib. Pepper hash password. Nilainya tidak boleh diubah: seluruh hash yang ada akan gagal diverifikasi. Kosong = `CONFIG_ERROR` |
| `MAINTENANCE_MODE` | `true` (trim, case-insensitive) menolak seluruh mutasi dengan kode `MAINTENANCE` (HTTP 503) |
| `ALLOWED_ORIGIN` | Opsional. Origin yang diizinkan untuk mutasi, mis. `https://sipsid-kgb.pages.dev`; kosong = origin request |
| `PASSWORD_HASH_ALGO` | Opsional. Algoritme hash password baru: `sha256` (default, cocok untuk plan Free) atau `pbkdf2_sha256`. Nilai lain = `CONFIG_ERROR` |
| `PASSWORD_REHASH_ON_LOGIN` | Opsional. `true` = saat login berhasil, hash lama ditulis ulang bila formatnya berbeda dari `PASSWORD_HASH_ALGO`. Tidak berefek selama `PASSWORD_HASH_ALGO=sha256` (semua hash sudah `sha256$`) |
| `PBKDF2_ITERATIONS` | Opsional, hanya untuk `pbkdf2_sha256`. 1–100000 (default 100000). Plan Free (10 ms CPU) tidak cukup untuk 100000 iterasi |

Format hash yang diverifikasi: `sha256$<salt>$<hex>` dan `pbkdf2_sha256$<iterasi>$<salt>$<hash>`.

## Migrasi schema D1

Build Pages **tidak** menjalankan migrasi D1. Terapkan migrasi baru ke produksi **sebelum** merge perubahan schema ke `main`, agar kode baru tidak berjalan di atas schema lama:

```powershell
npx wrangler d1 migrations apply sipsid-kgb --remote
```

Uji dulu secara lokal (`--local`) dan di preview (`npx wrangler d1 migrations apply sipsid-kgb-preview --remote --env preview`). Migrasi harus kompatibel mundur dengan kode yang sedang berjalan sampai deployment baru aktif.

## Deployment

Cloudflare Pages terhubung ke repository GitHub; push ke `main` memicu deployment produksi, branch lain menjadi preview.

```text
Build command: npm ci && npm run build
Build output: dist
Production branch: main
```

Urutan aman: migrasi D1 (bila ada) → merge/push ke `main` → verifikasi login, master gaji, buat/ubah/hapus surat, laporan/PDF, dan manajemen user di produksi. Rollback kode memakai **Rollback** deployment di dashboard Pages; rollback ini tidak mengembalikan data atau schema D1.

> **Batas rollback:** hanya ke deployment dari commit `d9eff2a` atau sesudahnya (backend `3.0.0`, misalnya `454985ec…`). **Jangan** rollback ke deployment dari tag `pre-d1-cutover` atau lebih lama: deployment tersebut meneruskan request ke Google Apps Script yang sudah dinonaktifkan, sehingga seluruh `/api/*` akan gagal.

## Mode pemeliharaan (write freeze)

1. Set secret `MAINTENANCE_MODE` = `true`:
   `"true" | npx wrangler pages secret put MAINTENANCE_MODE --project-name sipsid-kgb`
2. Buat deployment baru (redeploy deployment terakhir dari dashboard atau push commit) agar secret berlaku.
3. Verifikasi: mutasi (`letters.create/update/delete`, `users.create/update/resetPassword/delete`) ditolak dengan pesan pemeliharaan; login, logout, sesi, dan seluruh pembacaan tetap berjalan. Frontend mempertahankan isi formulir dan tidak mengakhiri sesi.
4. Nonaktifkan dengan mengisi `false` lalu redeploy lagi.

## Backup dan pemulihan

- **D1 Time Travel** menyimpan riwayat point-in-time selama **7 hari** pada plan Free. Catat bookmark sebelum operasi berisiko:
  `npx wrangler d1 time-travel info sipsid-kgb`
  Pemulihan: `npx wrangler d1 time-travel restore sipsid-kgb --bookmark=<bookmark>`. Restore bersifat **destruktif**: seluruh penulisan setelah bookmark hilang.
- **Backup berkala (utama)** di luar jendela 7 hari, misalnya mingguan: ekspor SQL lengkap (schema, trigger, dan seluruh data) ke file bertanggal di folder yang diabaikan Git:
  ```powershell
  npx wrangler d1 export sipsid-kgb --remote --output=migration-data/backup/sipsid-kgb-YYYYMMDD.sql
  ```
  Pemulihan ke database **kosong** (database baru atau setelah dikosongkan): `npx wrangler d1 execute <nama-db> --remote --file=<file.sql>`. Format ini sudah diuji dapat dipulihkan utuh (jumlah baris dan trigger sama).
- **Ekspor CSV (opsional, mudah dibaca manusia):** aktifkan mode pemeliharaan, lalu
  `node scripts/export-d1-to-csv.mjs --database sipsid-kgb --remote --ack-frozen --out migration-data/backup/csv-YYYYMMDD`.
  Gunakan folder bertanggal baru setiap kali (script menolak menimpa file). CSV tidak memuat seluruh kolom (misalnya `updated_at`), dan hash `pbkdf2_sha256$…` dikosongkan dengan `--allow-password-reset`, sehingga user tersebut perlu reset password bila dipulihkan dari CSV. Untuk pemulihan, utamakan backup SQL.
- File backup berisi nama, NIP, gaji, dan hash password: perlakukan sebagai rahasia, jangan di-commit, dan simpan di penyimpanan aman di luar komputer kerja.

## API

Seluruh endpoint mengembalikan `{ ok, data, error, backendVersion }`. Mutasi wajib `Content-Type: application/json` dan header `Origin` yang cocok.

| Method | Path | Action |
|---|---|---|
| `POST` | `/api/auth/login` | `auth.login` (set cookie sesi `HttpOnly; Secure; SameSite=Strict` dan cookie perangkat) |
| `POST` | `/api/auth/logout` | `auth.logout` |
| `GET` | `/api/auth/session` | `auth.session` |
| `GET` | `/api/bootstrap` | `bootstrap.get` (master gaji; wajib sesi, anonim = HTTP 401) |
| `GET` / `POST` | `/api/letters` | `letters.list` / `letters.create` |
| `PUT` / `DELETE` | `/api/letters/:id` | `letters.update` / `letters.delete` |
| `GET` / `POST` | `/api/users` | `users.list` / `users.create` (admin) |
| `PUT` / `DELETE` | `/api/users/:username` | `users.update` / `users.delete` (admin) |
| `PUT` | `/api/users/:username/password` | `users.resetPassword` (admin) |

- `POST /api/letters` menerima `requestId` opsional (1–100 karakter `[A-Za-z0-9_-]`) untuk idempotency: ID surat menjadi `KGB-<tahun WITA>-<requestId>` dan replay mengembalikan surat yang sama dengan `idempotent: true` di root envelope. Mutasi tidak pernah di-retry otomatis.
- ID pada URL dan username pada URL selalu menang atas nilai dalam body.
- Sesi disimpan di tabel `sessions` (TTL 8 jam) dan dicabut saat reset password, perubahan role, atau penghapusan user. Sesi tidak valid mengembalikan HTTP 401 dan cookie dihapus.

## Catatan keamanan

- Jangan commit `.dev.vars`, CSV, file `*.seed.sql`, atau isi `migration-data/`.
- Penghapusan surat dan manajemen user hanya untuk role `admin`; input `administrator` dinormalisasi ke `admin`.
- Admin terakhir dilindungi dari downgrade dan penghapusan (trigger D1, HTTP 422). Self-delete dan self-downgrade ditolak.
- Username baru: 1–64 karakter `[A-Za-z0-9._-]`, diawali huruf/digit, unik tanpa membedakan huruf besar/kecil. Password baru minimal 8 karakter.
- Login throttle server-side: 5 percobaan per 5 menit; username tidak terdaftar berbagi satu bucket, dan penolakan throttle memakai respons yang sama dengan kredensial salah.
- Cookie perangkat `sipsid_device` (`HttpOnly; Secure; SameSite=Strict; Path=/api/auth/login`, 180 hari) diterbitkan ulang setiap login berhasil. Isinya token bertanda tangan HMAC (kunci diturunkan dari `PASSWORD_PEPPER`) untuk satu akun dan `session_version`-nya. Percobaan login dari browser dengan token sah memakai bucket throttle sendiri (juga 5 per 5 menit), sehingga orang lain yang sengaja salah password tidak dapat mengunci pengguna dari browser yang pernah dipakainya. Browser baru atau yang cookie-nya dihapus tetap memakai bucket akun. Token tidak memberi akses apa pun; reset password, perubahan role, dan penghapusan user membatalkannya.
- `GET /api/bootstrap` wajib sesi agar request anonim berulang tidak menghabiskan kuota baca D1 (±1.056 baris per panggilan). Untuk perlindungan volume di tepi jaringan, pertimbangkan custom domain dengan aturan rate limiting Cloudflare pada `/api/*`.
- Error D1 mentah tidak pernah dikirim ke klien; log tidak memuat payload, NIP, atau teks exception.

## Riwayat

Backend Google Apps Script + Spreadsheet telah dipensiunkan; lihat [MIGRATION_PLAN.md](MIGRATION_PLAN.md) dan tag `pre-d1-cutover` untuk kode lama. Rencana dual-deployment lama diarsipkan di [docs/archive/IMPLEMENTATION_PLAN.md](docs/archive/IMPLEMENTATION_PLAN.md).
