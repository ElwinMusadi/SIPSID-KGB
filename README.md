# SIPSID-KGB

Satu repository untuk dua deployment:

- Google Apps Script Web App, dengan `SpreadsheetApp` sebagai data layer.
- Cloudflare Pages, dengan Pages Functions sebagai gateway ke backend GAS yang sama.

Google Sheets tetap menjadi sumber data untuk `Master_User`, `Master_Gaji_Pangkat`, dan `Database_Surat`.

## Persyaratan

- Node.js 20 atau lebih baru
- npm
- `clasp` 3.x
- Akses Editor ke project Google Apps Script
- Akun Cloudflare dengan Pages

## Instalasi dan validasi

```powershell
npm install
npm test
npm run build
```

Artifact:

```text
dist/        Cloudflare Pages
gas/         Google Apps Script
```

## Manajemen User (Admin only)

Semua endpoint berikut memerlukan sesi dengan role `admin`. Input `administrator` dinormalisasi ke `admin`.

| Method | Path | Aksi GAS | Keterangan |
|---|---|---|---|
| `GET` | `/api/users` | `users.list` | Daftar user tanpa password |
| `POST` | `/api/users` | `users.create` | Buat user baru |
| `PUT` | `/api/users/:username` | `users.update` | Ubah nama dan role; username immutable |
| `PUT` | `/api/users/:username/password` | `users.resetPassword` | Reset password user |
| `DELETE` | `/api/users/:username` | `users.delete` | Hapus user |

Payload `POST /api/users`: `{ username, password, namaLengkap, hakAkses }`.
Payload `PUT /api/users/:username`: `{ namaLengkap, hakAkses }`.
Payload `PUT /api/users/:username/password`: `{ newPassword }`.

Proteksi:
- Username URL selalu menang atas username dalam body.
- Duplikat username ditolak case-insensitive (HTTP 409).
- Admin terakhir tidak bisa didowngrade atau dihapus (HTTP 422).
- Self-delete dan self role downgrade ditolak.
- Password minimum 8 karakter; disimpan `sha256$salt$hash` dengan `PASSWORD_PEPPER`.

## Arsip Surat

Tambahkan Script Properties melalui **Project Settings → Script Properties**:

| Property | Nilai |
|---|---|
| `SPREADSHEET_ID` | ID Spreadsheet produksi atau test |
| `CLOUDFLARE_API_SECRET` | Secret acak, sama dengan secret Cloudflare |
| `SESSION_SIGNING_SECRET` | Secret acak untuk menandatangani session |
| `PASSWORD_PEPPER` | Secret acak untuk hash password |

`SPREADSHEET_ID` masih mempunyai fallback ke Spreadsheet lama agar deployment GAS tidak langsung rusak. Set property tersebut sebelum production deployment.

### Konfigurasi clasp

Script ID berbeda dengan Deployment ID. Ambil dari Apps Script **Project Settings → IDs** lalu buat `gas/.clasp.json`:

```json
{
  "scriptId": "REPLACE_WITH_SCRIPT_ID"
}
```

File ini tidak di-commit. Verifikasi file yang akan dikirim:

```powershell
npm run build:gas
Set-Location gas
clasp show-file-status
```

Output harus hanya memuat:

```text
Code.js
Index.html
appsscript.json
```

Push:

```powershell
npm run push:gas
```

Script npm menjalankan build lalu menjalankan `clasp push` dengan folder `gas` sebagai working directory. **`clasp push` saja tidak memperbarui endpoint produksi `/exec`.** Setelah push, ikuti langkah di bawah.

### Memperbarui deployment GAS setelah push

`clasp push` hanya mengunggah source ke editor sebagai HEAD yang belum punya versi. URL `/exec` yang dikonsumsi Cloudflare tetap melayani versi lama sampai deployment yang sama secara eksplisit diperbarui ke versi baru.

**Langkah wajib setelah setiap `npm run push:gas`:**

1. Buka <https://script.google.com/> → project SIPSID-KGB
2. Klik **Deploy → Manage deployments**
3. Temukan deployment produksi (URL-nya sama dengan `GAS_WEB_APP_URL` di Cloudflare) → klik ikon **Edit** (pensil)
4. Di dropdown **Version**, pilih **New version**
5. Klik **Deploy** — deployment ID dan URL `/exec` tetap sama; hanya versi aktif yang diperbarui
6. Verifikasi:

```powershell
npm run verify:gas
```

Output yang diharapkan:

```text
✔ gasBackendVersion: 2.1.0 (sesuai source)
✔ Semua 8 aksi dikenali oleh deployment aktif
  VERIFIKASI BERHASIL — Deployment GAS aktif sudah up-to-date.
```

Jika `verify:gas` melaporkan mismatch versi atau aksi yang tidak dikenali (termasuk `letters.update`), deployment belum aktif — ulangi langkah 3–5.

Untuk menjalankan manual tanpa npm:

```powershell
npm run build:gas
Set-Location gas
clasp push
```

### Migrasi password

1. Backup Spreadsheet.
2. Pastikan `PASSWORD_PEPPER` sudah diatur.
3. Jalankan fungsi `hashMasterUserPasswords` sekali dari Apps Script editor.
4. Periksa kolom password `Master_User` sudah berbentuk `sha256$salt$hash`.

Backend masih menerima plaintext lama sementara untuk transisi. Setelah migrasi berhasil, seluruh row harus berbentuk hash.

## Konfigurasi Cloudflare Pages

Hubungkan repository GitHub ke Cloudflare Pages:

```text
Build command: npm ci && npm run build:pages
Build output: dist
Production branch: main
```

Atur environment variables untuk Preview dan Production. Variables harus tersedia saat **runtime Pages Functions**, bukan hanya saat build:

| Variable | Keterangan |
|---|---|
| `GAS_WEB_APP_URL` | URL `/exec` deployment GAS target |
| `CLOUDFLARE_API_SECRET` | Sama dengan Script Property GAS |
| `ALLOWED_ORIGIN` | Origin Pages, misalnya `https://sipsid-kgb.pages.dev` |

Melalui dashboard: **Workers & Pages → sipsid-kgb → Settings → Variables and Secrets**. Setelah menambah atau mengubah variable, buat deployment baru.

Alternatif CLI untuk production:

```powershell
"https://script.google.com/macros/s/DEPLOYMENT_ID/exec" | npx wrangler pages secret put GAS_WEB_APP_URL --project-name sipsid-kgb
"SHARED_SECRET_YANG_SAMA_DENGAN_GAS" | npx wrangler pages secret put CLOUDFLARE_API_SECRET --project-name sipsid-kgb
"https://sipsid-kgb.pages.dev" | npx wrangler pages secret put ALLOWED_ORIGIN --project-name sipsid-kgb
npm run build:pages
npx wrangler pages deploy dist --project-name sipsid-kgb --branch main
```

Verifikasi runtime binding:

```powershell
npx wrangler pages secret list --project-name sipsid-kgb
```

Untuk local preview:

```powershell
Copy-Item .dev.vars.example .dev.vars
# Isi secret lokal, lalu:
npm run dev:pages
```

Cloudflare browser hanya memanggil `/api/*`. Pages Functions meneruskan request ke GAS dengan shared secret dan secure session cookie.

## Urutan deployment aman

1. Buat salinan Spreadsheet untuk test.
2. Set `SPREADSHEET_ID` GAS ke salinan tersebut.
3. Build dan push GAS ke deployment test: `npm run push:gas`
4. Perbarui deployment test ke **New version** (Deploy → Manage deployments → Edit → New version → Deploy).
5. Arahkan Cloudflare Preview ke URL deployment GAS test.
6. Uji login, master gaji, create, list, **update**, delete, laporan, PDF, dan **manajemen user (list, create, update, reset password, delete)** dari kedua target.
7. Jalankan `npm run verify:gas` untuk memastikan semua aksi dikenali.
8. Backup Spreadsheet produksi.
9. Set production properties dan Cloudflare environment variables.
10. Push GAS produksi: `npm run push:gas`
11. Perbarui deployment produksi ke **New version** (langkah yang sama dengan nomor 4).
12. Jalankan `npm run verify:gas` terhadap URL produksi.
13. Deploy branch `main` ke Cloudflare Pages.

Jangan menggunakan deployment produksi saat integration test create/delete.

## Perintah

```powershell
npm test             # Node test runner
npm run build        # Pages + GAS artifacts
npm run build:pages  # Artifact Cloudflare
npm run build:gas    # Artifact GAS
npm run dev:pages    # Local Pages preview
npm run push:gas     # Build lalu clasp push (ikuti langkah update deployment setelahnya)
npm run verify:gas   # Verifikasi deployment GAS aktif: versi dan action routing
```

## Catatan keamanan

- Jangan commit `.dev.vars`, `.clasp.json`, atau `.clasprc.json`.
- Rotasi password lama karena sebelumnya pernah tertanam di frontend/history Git.
- Rotasi shared secret jika pernah muncul dalam log atau commit.
- Penghapusan surat dibatasi untuk role `admin`.
- Manajemen user (list, create, update, reset password, delete) hanya dapat diakses role `admin`. Input `administrator` dinormalisasi ke `admin`.
- Admin terakhir dilindungi dari downgrade role dan penghapusan. Self-delete dan self role downgrade juga ditolak.
- Password existing disimpan dalam format kompatibel `sha256$salt$hash` dengan `PASSWORD_PEPPER`. `CONFIG_ERROR` dikembalikan bila pepper kosong, termasuk saat verifikasi password hash yang sudah ada. Jalankan `hashMasterUserPasswords()` dan audit agar tidak ada password plaintext sebelum produksi. Upgrade ke KDF adaptif berformat berversi tetap menjadi pekerjaan keamanan lanjutan; jangan menghapus kompatibilitas hash lama sebelum migrasi terukur selesai.
- Token sesi untuk seluruh operasi terautentikasi (`letters.*` dan `users.*`) menyertakan `sv` (session version) — fingerprint deterministik dari `SHA-256(storedPasswordField + "|" + role).substring(0, 16)`. Setiap request memverifikasi `sv` dan role terhadap row live di sheet sehingga token lama tidak berlaku setelah reset password, perubahan role, atau delete. Token tanpa `sv` ditolak.
- Username baru (`users.create`) divalidasi ketat: 1–64 karakter, hanya `[A-Za-z0-9._-]`, mulai huruf/digit, **tanpa truncation**. Username target (`update/resetPassword/delete`) divalidasi lebih permisif: 1–100 karakter, tanpa control chars, untuk mendukung legacy username dengan spasi.
- Login throttle server-side memakai satu state Script Properties yang dibatasi maksimal 200 username-hash dan dilindungi `ScriptLock`; `CacheService` hanya optimasi. Username yang tidak terdaftar berbagi satu bucket sehingga flood nama acak tidak memenuhi state atau mengunci akun sah. Entry aktif tidak pernah dieviction untuk username baru. Penolakan throttle memakai respons publik yang sama dengan kredensial salah agar keberadaan username tidak dapat diidentifikasi dari status atau error code.
- `validateUserSheet_` memeriksa minimal 4 kolom dan header A–D yang dikenali (case-insensitive, termasuk variasi legacy: `Hak Akses`, `role`, `Nama Lengkap`, dll). Sheet tanpa header menghasilkan `SCHEMA_ERROR`.
- Gateway Cloudflare menghapus session cookie (`Max-Age=0`) saat upstream mengembalikan `AUTH_REQUIRED`, `SESSION_EXPIRED`, atau `INVALID_SESSION`.
- Endpoint GAS tetap publik secara jaringan agar dapat dipanggil Cloudflare, tetapi action HTTP ditolak tanpa shared secret dan session valid.
