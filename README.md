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

## Konfigurasi Google Apps Script

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

Script npm menjalankan build lalu menjalankan `clasp push` dengan folder `gas` sebagai working directory. Untuk menjalankan manual:

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
3. Build dan push GAS ke deployment test.
4. Arahkan Cloudflare Preview ke URL deployment GAS test.
5. Uji login, master gaji, create, list, delete, laporan, dan PDF dari kedua target.
6. Backup Spreadsheet produksi.
7. Set production properties dan Cloudflare environment variables.
8. Update deployment GAS produksi.
9. Deploy branch `main` ke Cloudflare Pages.

Jangan menggunakan deployment produksi saat integration test create/delete.

## Perintah

```powershell
npm test             # Node test
npm run build        # Pages + GAS
npm run build:pages  # Artifact Cloudflare
npm run build:gas    # Artifact GAS
npm run dev:pages    # Local Pages preview
npm run push:gas     # Build lalu clasp push
```

## Catatan keamanan

- Jangan commit `.dev.vars`, `.clasp.json`, atau `.clasprc.json`.
- Rotasi password lama karena sebelumnya pernah tertanam di frontend/history Git.
- Rotasi shared secret jika pernah muncul dalam log atau commit.
- Penghapusan surat dibatasi untuk role `admin`.
- Endpoint GAS tetap publik secara jaringan agar dapat dipanggil Cloudflare, tetapi action HTTP ditolak tanpa shared secret dan session valid.
