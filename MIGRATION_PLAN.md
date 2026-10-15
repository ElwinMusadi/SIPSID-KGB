# Implementation Plan: Migrasi SIPSID-KGB ke Satu Tech Stack (Cloudflare + D1)

Branch kerja: `migration/cloudflare-d1` (dibuat dari `main` @ `e2fcf05`, disinkronkan ke `main` @ `c6bafd4`).
Status dokumen: **rencana teknis telah direview (APPROVED)**; keputusan K1–K11 **disetujui**. Persiapan teknis Fase 0 serta **Fase 1–4 selesai**; status per langkah dan batas validasi ada di Bagian 8. Cutover produksi belum dilakukan; gerbang login pemilik/pepper produksi tetap wajib pada Fase 5.

## 1. Ringkasan

SIPSID-KGB saat ini berjalan di dua tech stack:

1. **Google Apps Script (GAS) + Google Spreadsheet**: backend, logika bisnis, autentikasi, dan penyimpanan data.
2. **Cloudflare Pages + Pages Functions**: hosting frontend dan gateway `/api/*` yang meneruskan setiap request ke GAS.

Target migrasi adalah **satu stack Cloudflare**:

- **Frontend:** static assets di Cloudflare Pages (project `sipsid-kgb` yang sudah ada).
- **Backend:** Pages Functions (`/api/*`) yang menjalankan logika bisnis langsung, tanpa GAS.
- **Database:** Cloudflare D1 (SQLite) menggantikan Google Spreadsheet.

Kontrak API `/api/*` dipertahankan sehingga perubahan frontend minimal. Google Apps Script, clasp, dan Spreadsheet dipensiunkan setelah cutover stabil.

## 2. Kondisi Saat Ini

### 2.1 Stack 1: Google Apps Script + Spreadsheet

| Aspek | Implementasi |
|---|---|
| Entry point | `doGet()` (HtmlService + `INITIAL_SERVER_DATA`) dan `doPost()` (API internal untuk Cloudflare) |
| Dispatcher | `dispatchHttpAction_`: `auth.login/logout/session`, `bootstrap.get`, `letters.list/create/update/delete`, `users.list/create/update/resetPassword/delete`, `system.manifest` |
| Runtime langsung | Wrapper `api*` untuk `google.script.run` |
| Data | Sheet `Master_User` (A–D), `Master_Gaji_Pangkat` (pivot status × pangkat × MKG), `Database_Surat` (A timestamp, B id, C–AA 25 field surat) |
| Autentikasi | Token HMAC-SHA256 (`SESSION_SIGNING_SECRET`), masa berlaku 8 jam, `sv` = 16 hex pertama `sha256(passwordField + "\|" + role)` |
| Password | `sha256$salt$hex(sha256(salt + password + PASSWORD_PEPPER))`, masih ada fallback plaintext |
| Throttle login | `LOGIN_THROTTLE_STATE_V1` di Script Properties, 5 percobaan per 5 menit, maks. 200 entry, bucket bersama untuk username tidak dikenal |
| Konkurensi | Satu `ScriptLock` global untuk login, mutasi surat (10 dtk), dan mutasi user (30 dtk) |
| Idempotency | `requestId` diturunkan menjadi ID `KGB-<tahun>-<requestId>` |
| Konfigurasi | Script Properties: `SPREADSHEET_ID`, `CLOUDFLARE_API_SECRET`, `SESSION_SIGNING_SECRET`, `PASSWORD_PEPPER`, `LOGIN_THROTTLE_STATE_V1` |
| Deployment | `clasp push` lalu pembaruan manual ke **New version**, diverifikasi dengan `npm run verify:gas` |

Masalah utama:

- **Lambat dan tidak stabil:** cold start GAS dan redirect `/exec` memaksa gateway memakai timeout 28 detik dan retry. Error `504 upstream_unavailable` sudah pernah terjadi di produksi.
- **Lock global:** login dapat menunggu di belakang penyimpanan surat. Jika menunggu lebih dari 5 detik, login gagal meskipun password benar.
- **Pembacaan seluruh sheet:** `Master_User` dibaca ulang pada setiap request terautentikasi; `Database_Surat` dipindai penuh untuk list, pencarian ID, update, dan delete.
- **Penulisan tidak pasti:** `SpreadsheetApp.flush()` dan klasifikasi error berlapis diperlukan karena hasil tulis Spreadsheet dapat tidak terkonfirmasi.
- **Drift deployment:** `clasp push` tidak memperbarui `/exec`, sehingga frontend dan backend pernah tidak sinkron (`ACTION_NOT_FOUND`).

### 2.2 Stack 2: Cloudflare Pages + Pages Functions

| Aspek | Implementasi |
|---|---|
| Hosting | Pages project `sipsid-kgb`, build dari GitHub (`main`), output `dist/` |
| Build | `scripts/build-pages.mjs` mengganti `<?!= serverData ?>` dan menyalin `public/_headers` |
| Gateway | `functions/api/[[path]].js`: `mapRoute`, cookie `sipsid_session` (HttpOnly, Secure, SameSite=Strict), validasi origin untuk mutasi, batas payload 64 KiB, sanitasi field sensitif, envelope `{ok, data, error}`, pemetaan status HTTP |
| Ketergantungan | Setiap request diteruskan ke GAS (`GAS_WEB_APP_URL`, `CLOUDFLARE_API_SECRET`) |
| Konfigurasi | `wrangler.toml` hanya berisi `name`, `compatibility_date`, `pages_build_output_dir`; belum ada binding |

### 2.3 Frontend (`Index.html`)

- Satu file HTML berisi markup, CSS, dan JavaScript.
- Memiliki dua jalur runtime: `runGas()` (`google.script.run`) dan `fetchJson()` (`/api/*`), dipilih oleh `isGasRuntime()`.
- Library CDN: Tailwind runtime, `html2canvas`, `jspdf`, Font Awesome, Google Fonts.
- Logo/kop surat dari Google Drive (`lh3.googleusercontent.com`).
- `localStorage`: `sipsid_session` (hanya GAS) dan `sipsid_pending_letter_create` (idempotency create, **wajib dipertahankan**).

## 3. Arsitektur Target

```text
Browser (dist/index.html, hanya fetch)
  └─ /api/*  →  functions/api/[[path]].js
                 (routing, cookie, origin, payload, envelope, status — dipertahankan)
                  └─ src/server/dispatch.js  (nama action sama dengan GAS)
                       ├─ auth.js       sesi, password, throttle (WebCrypto)
                       ├─ letters.js    validasi, mapping, idempotency
                       ├─ users.js      proteksi admin terakhir, self-protection
                       ├─ salary.js     bootstrap master gaji
                       ├─ format.js     tanggal WITA, format Rupiah
                       └─ db.js         query D1 (env.DB)
                                 │
                           Cloudflare D1 (SQLite)
```

### 3.1 Pages Functions vs Workers + Static Assets

| Kriteria | Pages + Pages Functions | Workers + Static Assets |
|---|---|---|
| Kesesuaian repository | `functions/`, `_headers`, `dist/`, integrasi GitHub, dan nama project tetap | `functions/` harus menjadi Worker entry dengan router sendiri; project Workers Builds baru |
| URL/origin | `sipsid-kgb.pages.dev` tetap; cookie dan `ALLOWED_ORIGIN` tidak berubah | URL `*.workers.dev` atau custom domain baru |
| Binding D1 | Didukung | Didukung |
| Fitur tambahan | Tidak ada Cron Triggers, Rate Limiting binding, Workers Logs | Cron, Rate Limiting binding, Workers Logs, gradual deployment |
| Arah platform | Dipertahankan untuk project existing | Direkomendasikan Cloudflare untuk project baru |

**Rekomendasi:** gunakan **Pages + Pages Functions + D1** untuk migrasi ini. Perubahan paling kecil, satu origin, dan deployment GitHub tetap berjalan. Perpindahan ke Workers + Static Assets dapat dilakukan sebagai langkah terpisah setelah migrasi data stabil.

## 4. Keputusan

Seluruh keputusan **disetujui** pemilik project pada 2026-10-15: K1–K7 dan K9–K11 sesuai rekomendasi, **K8 = Free**. Konsekuensi K4 + K8: `PASSWORD_HASH_ALGO = sha256` (lihat Bagian 5.5 dan hasil Fase 0 langkah 8).

| ID | Keputusan | Rekomendasi | Dampak |
|---|---|---|---|
| K1 | Platform | Pages + Pages Functions | Lihat 3.1 |
| K2 | Username case-sensitive atau tidak | **Case-insensitive** (`COLLATE NOCASE`), sesuai manajemen user saat ini | Login saat ini case-sensitive; duplikat beda huruf harus diaudit sebelum import |
| K3 | Model sesi | **Tabel `sessions` stateful** (token acak, simpan hash) | Logout benar-benar mencabut sesi; semua user login ulang saat cutover |
| K4 | Format password | Verifikasi hash `sha256$…` lama; hash baru memakai PBKDF2-SHA256 jika CPU plan memadai; rehash saat login baru diaktifkan di Fase 6 | Bergantung pada batas CPU plan Cloudflare; diukur di Fase 0 |
| K5 | Penyimpanan gaji | **INTEGER rupiah**, diformat kembali ke `Rp. x.xxx.xxx,-` oleh API | Validasi gaji menjadi lebih ketat; PDF/CSV tetap sama |
| K6 | Konkurensi update surat | Last-write-wins (perilaku saat ini); kolom `version` disiapkan | `VERSION_CONFLICT` diaktifkan setelah frontend mengirim versi |
| K7 | Eksekusi migrasi D1 | Manual dengan checklist terlebih dahulu | Build Pages tidak menjalankan migrasi D1 otomatis |
| K8 | Plan Cloudflare | **Free** (disetujui) | CPU 10 ms/request, D1 500 MB, Time Travel 7 hari, 50 query D1 per invocation |
| K9 | Perubahan v2.5.3 yang belum di-commit | Commit ke `main` dan deploy GAS v2.5.3 untuk stabilisasi selama migrasi | Saat ini perubahan tersebut ada di working tree branch migrasi |
| K10 | Data preview | Seed preview dengan **data anonim + user uji**, atau lindungi preview dengan Cloudflare Access | URL preview Pages bersifat publik secara default |
| K11 | `system.manifest` dan `verify:gas` | Dihapus bersama GAS; diganti `GET /api/health` opsional yang mengembalikan `backendVersion` | Tidak dibutuhkan frontend |

### 4.1 Keputusan terkait username dan throttle (K2)

Login saat ini case-sensitive: `Admin` tidak cocok dengan `admin` dan masuk ke bucket throttle bersama untuk username tidak dikenal. Setelah K2, varian huruf menemukan akun yang sama. Agar varian huruf tidak menghasilkan bucket throttle terpisah:

- Key throttle diturunkan dari `users.id` atau username tersimpan (kanonik), **tidak pernah** dari input mentah.
- Username tidak dikenal tetap memakai satu bucket bersama.
- Penolakan throttle tetap mengembalikan `INVALID_CREDENTIALS`, sama dengan kredensial salah, untuk mencegah enumerasi akun.
- Username tidak dikenal tetap menjalankan derivasi password dummy agar waktu respons tidak membedakan akun yang ada.

## 5. Desain Database D1

### 5.1 Tabel

| Tabel | Pengganti | Isi |
|---|---|---|
| `users` | `Master_User` | username (unik, case-insensitive), hash password, nama lengkap, role, `session_version`, `version`, timestamp |
| `salary_grades` | `Master_Gaji_Pangkat` | Satu baris per status × golongan × MKG, nominal INTEGER |
| `letters` | `Database_Surat` | 25 field surat, `request_id` unik, `created_by/updated_by`, `version`, timestamp |
| `sessions` | Token HMAC stateless | Hash token, user, `session_version`, expiry, revocation |
| `login_throttle` | `LOGIN_THROTTLE_STATE_V1` | Key hash username, jumlah percobaan, expiry |

DDL lengkap ada di **Lampiran A**.

### 5.2 Pengganti mekanisme GAS

| Mekanisme GAS | Pengganti di Cloudflare |
|---|---|
| `SpreadsheetApp` | Binding D1 `env.DB` dengan query berparameter |
| `ScriptLock` | Statement atomik dengan guard di klausa `WHERE`, `RETURNING`, constraint `UNIQUE`, dan `db.batch()` |
| `revalidateActorInLock_` | Guard `EXISTS (SELECT 1 FROM users WHERE … session_version = ?)` di setiap statement mutasi |
| Idempotency berbasis scan | `INSERT … ON CONFLICT DO NOTHING RETURNING *`, lalu lookup `request_id`/`id` |
| Urutan baris sheet | Kolom `seq` (`ORDER BY seq DESC`) |
| Proteksi admin terakhir | Kondisi `COUNT(*)` di statement + trigger database |
| Script Properties throttle | Upsert atomik `login_throttle` |
| `CacheService` | Tidak diperlukan |
| Script Properties secret | Pages secrets (`PASSWORD_PEPPER`) |
| `Utilities` crypto | WebCrypto (`crypto.subtle`, `crypto.randomUUID`) |
| `HtmlService` / `google.script.run` | Dihapus; frontend hanya memakai `fetch` |
| `CLOUDFLARE_API_SECRET` / `GAS_WEB_APP_URL` | Dihapus setelah dekomisioning |
| `Session.getScriptTimeZone()` (Asia/Makassar) | Konversi eksplisit UTC+8 untuk tahun ID dan tampilan tanggal |

D1 tidak mendukung interactive transaction maupun `BEGIN`/`COMMIT` eksplisit. Pola SQL pengganti lock ada di **Lampiran B**. Foreign key ditegakkan secara default di D1, sehingga `ON DELETE CASCADE` pada `sessions` berfungsi.

### 5.3 Pemetaan hasil 0 baris ke kode error

Statement mutasi bertingkat (guard di `WHERE`) mengembalikan 0 baris untuk beberapa alasan berbeda, sedangkan frontend dan `upstreamStatus()` membutuhkan kode yang spesifik. Aturannya:

1. **Sesi divalidasi lebih dulu** dengan query sesi (Bagian 5.4) sebelum mutasi. Kegagalan di sini langsung menghasilkan `AUTH_REQUIRED`/`SESSION_EXPIRED` (401) atau `FORBIDDEN` (403).
2. **Guard actor tetap ada di statement mutasi** sebagai perlindungan race condition.
3. Jika mutasi mengembalikan 0 baris, jalankan **read diagnostik** dengan urutan prioritas berikut:

| Urutan | Kondisi | Kode | HTTP |
|---|---|---|---|
| 1 | Actor tidak ada atau `session_version` berubah | `AUTH_REQUIRED` | 401 |
| 2 | Actor bukan admin (operasi admin) | `FORBIDDEN` | 403 |
| 3 | Target tidak ditemukan | `NOT_FOUND` | 404 |
| 4 | Aturan per action (di bawah) | `LAST_ADMIN_PROTECTED` / `FORBIDDEN` | 422 / 403 |
| 5 | Versi berbeda (setelah K6 aktif) | `VERSION_CONFLICT` | 409 |

Urutan langkah 4 mengikuti GAS per action:

- **`users.update`:** cek admin terakhir (`LAST_ADMIN_PROTECTED`, 422) **sebelum** self-demote (`FORBIDDEN`, 403). Admin tunggal yang menurunkan role sendiri menerima 422, sama seperti sekarang.
- **`users.delete`:** self-delete (`FORBIDDEN`) diperiksa sebelum target tidak ditemukan dan admin terakhir, sama seperti `deleteUser_`.

4. Trigger database hanya **jaring pengaman** untuk SQL manual. Jika trigger tetap terpicu, pesan `LAST_ADMIN_PROTECTED` pada error D1 dipetakan secara eksplisit ke kode yang sama (422), bukan `DATA_WRITE_FAILED`. Teks error D1 yang dihasilkan trigger diverifikasi di Fase 1.

Setiap kode di tabel ini wajib memiliki contract test; golden-response test membandingkan urutan prioritas dengan GAS.

### 5.4 Model sesi (K3)

- Cookie `sipsid_session` (HttpOnly, Secure, SameSite=Strict) berisi token acak 32 byte; D1 hanya menyimpan `sha256` token.
- Setiap request terautentikasi memvalidasi sesi dalam satu query: sesi belum dicabut, belum kedaluwarsa, dan `session_version` sesi sama dengan milik user.
- Logout mencabut sesi di server (`revoked_at`). Reset password, perubahan role, dan penghapusan user menaikkan `session_version` sehingga seluruh sesi user tersebut tidak berlaku.
- Baris `sessions` dan `login_throttle` yang kedaluwarsa dihapus secara oportunistik saat login, karena Pages tidak memiliki Cron Triggers.
- Token HMAC dari GAS tidak berlaku setelah cutover; seluruh user login ulang satu kali.

### 5.5 Password (K4)

- Format baru: `pbkdf2_sha256$<iterasi>$<salt base64>$<hash base64>`.
- Workers WebCrypto membatasi PBKDF2 **maksimal 100.000 iterasi**; nilai di atas itu menghasilkan error. Batas ini di bawah rekomendasi OWASP (600.000) dan diterima sebagai kompromi platform.
- Algoritme hash adalah **satu setting** (`PASSWORD_HASH_ALGO`: `sha256` atau `pbkdf2_sha256`) yang dipakai bersama oleh create user, reset password, rehash, dan derivasi dummy untuk username tidak dikenal. Biaya derivasi dummy harus sama dengan format hash yang dominan.
- **Keputusan (Fase 0):** `PASSWORD_HASH_ALGO = sha256`. Pengukuran di `workerd` lokal: PBKDF2 10.000 iterasi ±7 ms, 50.000 ±38 ms, 100.000 ±75 ms; SHA-256 lama ±0,01 ms. Batas plan Free 10 ms CPU per request, sehingga PBKDF2 tidak layak. Implementasi PBKDF2 tetap disiapkan di balik setting dan dapat diaktifkan setelah naik ke Workers Paid. Efek samping positif: selama jendela rollback, hash tetap dapat diverifikasi GAS.
- Verifikasi hash lama `sha256$salt$hash` dengan `PASSWORD_PEPPER` tetap didukung.
- **Rehash saat login ditunda sampai Fase 6.** GAS tidak dapat memverifikasi hash PBKDF2, sehingga rehash selama jendela rollback akan memaksa reset massal saat rollback. Selama jendela tersebut hanya create user dan reset password yang menghasilkan format baru (Bagian 11.2).

### 5.6 Batas D1 yang relevan

- Maksimal 100 bound parameter per query dan 100 KB per statement. Insert surat dari aplikasi memakai parameter; import data memakai SQL literal yang dibatasi 100 KB per statement.
- Maksimal 50 query per invocation (Free) atau 1.000 (Paid).
- Satu database memproses query secara serial. Beban SIPSID-KGB jauh di bawah batas ini.
- Time Travel (point-in-time recovery): 7 hari (Free), 30 hari (Paid).

## 6. Kontrak API

Route, status HTTP, dan bentuk envelope dipertahankan:

| Method | Route | Action |
|---|---|---|
| `POST` | `/api/auth/login` | `auth.login` |
| `POST` | `/api/auth/logout` | `auth.logout` |
| `GET` | `/api/auth/session` | `auth.session` |
| `GET` | `/api/bootstrap` | `bootstrap.get` |
| `GET` / `POST` | `/api/letters` | `letters.list` / `letters.create` |
| `PUT` / `DELETE` | `/api/letters/:id` | `letters.update` / `letters.delete` |
| `GET` / `POST` | `/api/users` | `users.list` / `users.create` |
| `PUT` / `DELETE` | `/api/users/:username` | `users.update` / `users.delete` |
| `PUT` | `/api/users/:username/password` | `users.resetPassword` |

Respons tetap `{ ok, data, error: { code, message } }` dengan kode error lowercase dan `idempotent` di root envelope.

### 6.1 Bentuk `data` per action

`src/server/dispatch.js` mengembalikan objek berbentuk sama dengan hasil GAS saat ini, sehingga logika `normalizeGasResponse` dan frontend tetap. Perubahan pada normalizer hanya dua: diganti nama menjadi `normalizeResponse`, dan field versi dibaca/ditulis sebagai `backendVersion` (bukan `gasBackendVersion`). Test di `tests/cloudflare-api.test.mjs` yang memeriksa `gasBackendVersion` diperbarui pada Fase 1.

| Action | Hasil dispatcher | `data` yang diterima frontend |
|---|---|---|
| `auth.login` | `{ status, sessionToken, expiresIn, user }` | `{ user }`; `sessionToken` dan `expiresIn` dibuang gateway: token hanya untuk cookie, masa berlaku dibawa `Max-Age` cookie |
| `auth.logout` | `{ status }` | `{}` |
| `auth.session` | `{ status, user }` | `{ user }` |
| `bootstrap.get` | `{ status, gajiPNS, gajiPPPK, errorMsg }` | `{ gajiPNS, gajiPPPK }` |
| `letters.list` | `{ status, data: [letter] }` | array surat |
| `letters.create` | `{ status, data: letter, idempotent? }` | surat; `idempotent: true` di root envelope saat replay |
| `letters.update` | `{ status, data: letter }` | surat |
| `letters.delete` | `{ status, id }` | `{ id }` |
| `users.list` | `{ status, data: [user] }` | array user (tanpa hash) |
| `users.create` / `users.update` | `{ status, data: { username, namaLengkap, hakAkses } }` | user |
| `users.resetPassword` / `users.delete` | `{ status, username }` | `{ username }` |

Aturan nilai:

- Field surat dikirim sebagai string seperti sekarang, termasuk masa kerja (`"0"`–`"40"`).
- Gaji surat diformat kembali ke `Rp. x.xxx.xxx,-`; `nominal` master gaji dikirim sebagai string digit.
- Tanggal dikirim sebagai `YYYY-MM-DD`; `kabkot` kosong dikirim sebagai `""`.
- `user.hakAkses` tetap memakai nama field lama, dipetakan dari kolom `role`.
- Setiap action memiliki golden-response test terhadap contoh hasil GAS.

### 6.2 Perubahan perilaku yang disengaja

| Perubahan | Alasan |
|---|---|
| `gasBackendVersion` diganti `backendVersion` | Frontend sudah membaca keduanya |
| Login case-insensitive (K2) | Konsisten dengan manajemen user |
| Logout mencabut sesi di server (K3) | Saat ini token tetap berlaku hingga 8 jam setelah logout |
| Validasi gaji lebih ketat (K5) | Gaji disimpan sebagai INTEGER |
| Replay `requestId` tetap idempotent melewati pergantian tahun | `request_id` unik secara global |
| Seluruh user login ulang saat cutover | Token GAS tidak berlaku |
| `BUSY`, `DATA_WRITE_DENIED`, `DATA_VALIDATION_ERROR` praktis tidak muncul | Error D1 dipetakan ke `DATA_SERVICE_UNAVAILABLE` (503) atau `DATA_WRITE_FAILED` (502) |
| `system.manifest` dihapus (K11) | Hanya dipakai untuk verifikasi deployment GAS |
| Log backend tidak memuat payload, NIP, atau teks exception | Mempertahankan kebijakan redaksi log GAS v2.5.3 |

## 7. Struktur Repository Target

```text
SIPSID-KGB/
├── Index.html                    # frontend (jalur GAS dihapus)
├── functions/api/[[path]].js     # gateway: routing, cookie, envelope
├── src/server/                   # domain logic backend (bukan route)
│   ├── dispatch.js
│   ├── auth.js
│   ├── letters.js
│   ├── users.js
│   ├── salary.js
│   ├── format.js
│   └── db.js
├── migrations/
│   └── 0001_initial.sql
├── scripts/
│   ├── build-pages.mjs
│   ├── migrate-sheets-to-d1.mjs  # CSV → SQL seed + validasi
│   └── export-d1-to-csv.mjs      # rollback / arsip
├── public/
│   ├── _headers
│   └── assets/                   # logo/kop surat lokal
├── tests/
├── wrangler.toml                 # binding D1 production + preview
└── package.json
```

Dihapus pada Fase 6: `Code.js`, `appsscript.json`, `gas/`, `scripts/build-gas.mjs`, `scripts/push-gas.mjs`, `scripts/verify-gas-deployment.mjs`, serta npm script `build:gas`, `push:gas`, `verify:gas`.

Konfigurasi D1 (database dibuat pada Fase 0 langkah 9; binding ditambahkan di `wrangler.toml` pada Fase 1):

```toml
name = "sipsid-kgb"
compatibility_date = "2026-09-16"
pages_build_output_dir = "dist"

[[d1_databases]]
binding = "DB"
database_name = "sipsid-kgb"
database_id = "ccc9fdf8-8668-4ebe-afad-5fa8d4e71913"
migrations_dir = "migrations"

[[env.preview.d1_databases]]
binding = "DB"
database_name = "sipsid-kgb-preview"
database_id = "3185cc3a-81a5-49eb-afd2-6b039ad387f8"
migrations_dir = "migrations"
```

## 8. Tahapan Implementasi

### Fase 0 — Persiapan dan keputusan

1. Setujui keputusan K1–K11.
2. Selesaikan status perubahan v2.5.3 (K9) di `main`.
3. Backup Spreadsheet produksi dengan **File → Make a copy**.
4. Catat nilai `PASSWORD_PEPPER` dan simpan aman di luar repository.
5. Periksa zona waktu Spreadsheet di **File → Settings**; kolom A ditampilkan dalam zona waktu Spreadsheet, bukan zona waktu script.
6. Audit `Master_User`: duplikat username beda huruf, password plaintext, role tidak valid, nama kosong, jumlah admin.
7. **Dry-run `Database_Surat` terhadap seluruh constraint** (Lampiran A) pada salinan data:
   - laporkan setiap baris yang melanggar CHECK, NOT NULL, format tanggal, format gaji, atau NIP;
   - samakan aturan import dengan yang diterima validator saat ini (`validateAndNormalizeLetter_`); hanya korupsi nyata (misalnya NIP notasi ilmiah) yang dikarantina;
   - catat ID duplikat dan potensi bentrok `request_id`.
8. Ukur biaya CPU PBKDF2 di Pages Functions pada plan yang dipakai; tentukan jumlah iterasi (maks. 100.000).
9. Buat database D1:
   ```powershell
   npx wrangler d1 create sipsid-kgb --location apac
   npx wrangler d1 create sipsid-kgb-preview --location apac
   ```
10. Tambahkan pola berikut ke `.gitignore` sebelum ekspor data apa pun:
    ```text
    migration-data/
    *.csv
    *.seed.sql
    ```

11. Siapkan **freeze GAS** yang akan dipakai saat cutover:
    - tambahkan flag `MAINTENANCE_MODE` di Script Properties yang diperiksa di `runLetterApi_` dan seluruh wrapper `apiXxxUser`. Karena `dispatchHttpAction_` memanggil wrapper yang sama, satu pemeriksaan menutup jalur `doPost` dan `google.script.run`;
    - flag menolak dengan kode publik baru `MAINTENANCE`: tambahkan ke `PUBLIC_ERROR_CODES_`, petakan ke HTTP `503` di `upstreamStatus`, dan tambahkan pesan frontend "Aplikasi sedang dalam pemeliharaan". Tanpa ini, `runLetterApi_` mengubahnya menjadi `DATA_WRITE_FAILED` dengan pesan yang menyesatkan;
    - naikkan `GAS_BACKEND_VERSION` (misalnya `2.5.4`), deploy sebagai **New version** dengan flag nonaktif, lalu uji di salinan Spreadsheet bahwa mengaktifkan flag menolak penulisan surat dan user;
    - proteksi sheet **bukan** mekanisme utama: dengan `executeAs: USER_DEPLOYING`, proteksi tidak memblokir pemilik Spreadsheet. Proteksi hanya dipakai sebagai cadangan bila akun deployment bukan pemilik Spreadsheet.
12. Setelah langkah 11 di-merge ke `main`, beri **tag** `pre-d1-cutover` pada commit tersebut. Tag ini adalah target rollback dan sudah memuat kode freeze.

**Selesai jika:** keputusan disetujui, backup dan tag tersedia, audit dan dry-run selesai dengan daftar perbaikan, iterasi PBKDF2 ditetapkan, dan freeze GAS teruji.

#### Status Fase 0 (2026-10-15)

| Langkah | Status | Hasil |
|---|---|---|
| 1. Keputusan | ✅ Selesai | K1–K11 disetujui; K8 = Free |
| 2. K9 v2.5.3 | ✅ Selesai | `808024d` di `main` |
| 3. Backup Spreadsheet | ⏳ Pemilik | **File → Make a copy** |
| 4. `PASSWORD_PEPPER` | ⏳ Pemilik | Salin dari Script Properties ke penyimpanan aman |
| 5. Zona waktu Spreadsheet | ✅ Selesai | **GMT+08:00 Makassar**, lokasi Indonesia — sama dengan zona waktu script; timestamp kolom A dibaca sebagai UTC+8 |
| 6–7. Audit data | ✅ Selesai — **PASS, 0 blocking** | Lihat ringkasan di bawah |
| 8. PBKDF2 | ✅ Selesai | `PASSWORD_HASH_ALGO = sha256` (Bagian 5.5) |
| 9. Database D1 | ✅ Selesai | `sipsid-kgb` dan `sipsid-kgb-preview`, region APAC, masih kosong |
| 10. `.gitignore` | ✅ Selesai | `migration-data/`, `*.csv`, `*.seed.sql` |
| 11. Freeze GAS | ✅ Selesai, teruji di produksi | v2.5.4 di deployment `@50`; dengan `MAINTENANCE_MODE=true`, mutasi surat dan user ditolak `503 maintenance` tanpa menulis data, sementara pembacaan tetap `200` |
| 12. Tag rollback | ✅ Selesai | `pre-d1-cutover` → `c6bafd4` |

Ringkasan audit data produksi (2026-10-15, `--require-all`, exit `0`):

| Sheet | Baris | Akan diimport | Blocking | Warning |
|---|---|---|---|---|
| `Master_User` | 15 | 15 | 0 | 0 (3 admin, tanpa duplikat beda huruf, semua hash `sha256$…` valid) |
| `Database_Surat` | 45 | 45 | 0 | 4 `NIP_NON_STANDARD` (diimport apa adanya, Bagian 9.2) |
| `Master_Gaji_Pangkat` | 34 | 34 | 0 | 100 sel gaji kosong/nol dilewati (sama dengan GAS) |

- Backfill `request_id`: **45 dari 45** surat memenuhi syarat; tidak ada bentrok antar-tahun.
- Jumlah sel gaji hasil transformasi sama dengan produksi: **530 PNS, 526 PPPK** (bootstrap `/api/bootstrap`).
- 4 NIP non-standar (bukan 18 digit) di baris sheet **5, 12, 18, 41** perlu diperiksa pemilik terhadap dokumen sumber; tidak memblokir migrasi.

Catatan langkah 11: freeze bersifat **fail-closed** — jika Script Property tidak dapat dibaca, mutasi ditolak dengan `MAINTENANCE`. Freeze juga memblokir `hashMasterUserPasswords()`, sehingga fungsi tersebut harus dijalankan **sebelum** flag diaktifkan saat cutover (Bagian 9.1 langkah 2 dijalankan sebelum langkah 1).

Cara menjalankan audit setelah ekspor CSV ke `migration-data/` (diabaikan Git):

```powershell
node scripts/audit-sheets.mjs --require-all `
  --users migration-data/Master_User.csv `
  --letters migration-data/Database_Surat.csv `
  --salary migration-data/Master_Gaji_Pangkat.csv `
  --out migration-data/audit-report.json
```

Exit code `0` = lulus, `2` = ada isu blocking, `1` = kesalahan penggunaan. Output tidak memuat password, hash, nama, atau NIP lengkap.

### Fase 1 — Backend D1 di belakang route yang sama

1. Tulis `migrations/0001_initial.sql` (Lampiran A).
2. Implementasikan `src/server/*`:
   - port `validateAndNormalizeLetter_`, `rowToLetter_`, validasi tanggal kalender, masa kerja, dan ID;
   - port verifikasi password `sha256$…`, tambah PBKDF2 di balik setting `PASSWORD_HASH_ALGO`, dan siapkan rehash saat login dalam keadaan **nonaktif** (diaktifkan di Fase 6);
   - sesi stateful, throttle login, proteksi admin terakhir, self-delete/self-downgrade;
   - konversi tahun ID dan tanggal ke UTC+8.
3. Ubah `functions/api/[[path]].js`: dispatch in-process ke `src/server/dispatch.js` dengan `env.DB`; hapus fetch ke GAS, timeout, retry, dan secret GAS.
4. Implementasikan pemetaan 0 baris ke kode error (Bagian 5.3) dan bentuk respons per action (Bagian 6.1), termasuk rename `backendVersion`.
5. Tambahkan `MAINTENANCE_MODE` di gateway baru: bila aktif, seluruh mutasi `/api/*` ditolak dengan kode `MAINTENANCE` dan HTTP `503`, sama dengan freeze GAS. Didefinisikan sebagai **secret Pages**, bukan `[vars]` di `wrangler.toml`, karena variabel biasa tidak dapat diubah dari dashboard bila `wrangler.toml` menjadi sumber konfigurasi. Perubahan secret baru berlaku setelah deployment baru, sehingga runbook menyertakan langkah redeploy. Dipakai untuk rollback (Bagian 11.2) dan maintenance berikutnya.
6. Port test backend ke D1 lokal.

Catatan implementasi:

- D1 tidak mendukung named parameter. Placeholder seperti `?actor` di Lampiran B ditulis sebagai `?1`, `?2`, …; ordinal yang sama dapat dipakai ulang untuk nilai berulang.
- Hitung tahun pada ID `KGB-<tahun>-…` dan tanggal default secara eksplisit di UTC+8 (Asia/Makassar), karena runtime berjalan di UTC.

**Selesai jika:** seluruh test kontrak gateway, golden-response test, test kode error, dan test domain lulus terhadap D1 lokal.

#### Status Fase 1 (2026-10-15) — ✅ Selesai

| Bagian | Hasil |
|---|---|
| Schema | `migrations/0001_initial.sql`; diverifikasi dengan `wrangler d1 migrations apply --local`. Satu perubahan dari Lampiran A: `users.id` memakai `AUTOINCREMENT` agar id user yang dihapus tidak dipakai ulang |
| Backend | `src/server/{db,errors,format,auth,salary,letters,users,dispatch}.js`, `BACKEND_VERSION = 3.0.0` |
| Gateway | `functions/api/[[path]].js` menjalankan `dispatch` langsung dengan `env.DB`; fetch ke GAS, timeout, dan retry dihapus; kontrak route, cookie, origin, payload, dan envelope dipertahankan |
| Konfigurasi | Binding D1 produksi dan preview di `wrangler.toml`; `PASSWORD_PEPPER` dan `MAINTENANCE_MODE` sebagai Pages secret |
| Test | 429 test lulus, termasuk schema D1, domain, dispatcher, kontrak gateway, golden response, dan kasus keamanan |
| Smoke test end-to-end | `wrangler pages dev` + D1 lokal dengan data sintetis: **18/18** (login, sesi, CRUD surat + replay idempoten, user, kode 403/404/422, origin asing, logout mencabut sesi di server) |
| Review independen | **APPROVED**; 5 temuan Low diperbaiki (timing login saat throttle, cek pepper di awal login, `AUTOINCREMENT`, kontrak `expiresIn`, test keamanan tambahan) |

Catatan:

- Throttle login dan penolakan login karena kredensial salah sama-sama mengembalikan `400 invalid_credentials`; `429 too_many_attempts` tidak lagi dipakai.
- `action_not_found` → 404; `version_conflict` → 409 (disiapkan untuk K6).
- Uji konkurensi throttle dan timing login dijalankan di D1 preview pada Fase 4.

### Fase 2 — Tooling migrasi data

1. Buat `scripts/migrate-sheets-to-d1.mjs`: input CSV per sheet, output file SQL per tabel.
2. Buat `scripts/export-d1-to-csv.mjs` untuk rollback dan arsip.
3. Uji dengan salinan Spreadsheet, bukan data produksi.

**Selesai jika:** transformasi deterministik, baris bermasalah masuk karantina, dan validasi (Bagian 9.4) lulus pada salinan data.

#### Perintah tooling Fase 2

Jalankan dengan Node.js 24. File input maupun output mengandung data pribadi; gunakan direktori `migration-data/` yang diabaikan Git. Jangan menjalankan import remote selama latihan.

```powershell
node scripts/migrate-sheets-to-d1.mjs --users migration-data/Master_User.csv --letters migration-data/Database_Surat.csv --salary migration-data/Master_Gaji_Pangkat.csv --migrated-at 2026-10-15T00:00:00.000Z --out migration-data/seed
```

`--migrated-at` adalah waktu tetap untuk metadata user/master gaji, bukan waktu surat. Gunakan nilai yang sama untuk mengulang latihan agar hasil identik; saat cutover gunakan waktu snapshot cutover. SQL memakai `INSERT` biasa dan harus diterapkan ke database kosong.

- Exit `0`: `READY`, tidak ada karantina; exit `2`: abort/karantina, tidak boleh cutover; exit `1`: penggunaan atau IO gagal.
- `--allow-quarantine` hanya menghasilkan SQL untuk pemeriksaan baris yang lolos, **bukan** persetujuan import produksi.
- Manifest memuat jumlah baris, agregat, dan checksum kanonik tiap tabel. Nilai `NULL`, string kosong, dan teks `NULL` dibedakan; urutan kolom tetap. Exporter menggunakan fungsi checksum dan agregat yang sama.

Ekspor balik snapshot SQLite lokal (read-only):

```powershell
node scripts/export-d1-to-csv.mjs --sqlite migration-data/rehearsal.sqlite --manifest migration-data/seed/manifest.json --out migration-data/rollback-check
```

Untuk membaca D1 lokal melalui Wrangler tanpa mencari file SQLite internal:

```powershell
node scripts/export-d1-to-csv.mjs --database sipsid-kgb --local --persist-to migration-data/local-d1 --manifest migration-data/seed/manifest.json --out migration-data/rollback-local
```

Ekspor remote hanya dilakukan saat rollback dengan flag `--remote --ack-frozen`, setelah freeze aplikasi baru benar-benar aktif. `--env preview` memilih binding preview. Script hanya menjalankan `SELECT` tetap; tidak mengubah D1 atau Spreadsheet.

Exporter menghasilkan tiga CSV lengkap dalam urutan kolom Spreadsheet lama dan `export-report.json`. Direktori output harus diabaikan Git, bukan symlink/junction, dan file yang sudah ada tidak ditimpa. Import identifier/NIP ke Sheets sebagai **teks**. Formula berbahaya di sel teks diberi awalan apostrof; jangan menghapus awalan itu tanpa pemeriksaan. PBKDF2 tidak dapat dipakai oleh GAS: ekspor ditolak kecuali `--allow-password-reset` diberikan, lalu sel password user tersebut dikosongkan dan nomor barisnya dilaporkan untuk reset wajib. Jangan memakai opsi ini sebagai migrasi password otomatis.

`--manifest` dipakai hanya pada snapshot latihan segera setelah import (belum ada mutasi aplikasi). Setelah go-live, perubahan data yang sah memang menyebabkan checksum berbeda; gunakan ekspor penuh tanpa manifest lama dan lakukan rekonsiliasi tambah/ubah/hapus sesuai Bagian 11.2.

#### Status Fase 2 (2026-10-15) — Selesai

- Transformasi salinan CSV Fase 0: **15 user, 45 surat, 1.056 nilai gaji**, tanpa abort/karantina.
- Schema dan seed telah dijalankan pada SQLite offline **dan** D1 lokal Wrangler (`--local`, penyimpanan privat di `migration-data/`). Tidak ada import remote atau perubahan pada Spreadsheet.
- Ekspor balik dari kedua runtime menggunakan `--manifest` lulus: jumlah, agregat, dan checksum seluruh tabel cocok. Semua hash user tetap berformat `sha256$…`; tidak ada reset password yang diperlukan pada dataset latihan.
- Pembandingan offline ke `rowToLetter_` GAS: **45/45 surat memiliki urutan dan seluruh field API yang sama** (nilai Rupiah dibandingkan sesudah normalisasi format). Pengulangan transformasi dengan waktu migrasi sama menghasilkan seluruh file byte-identik.
- Pembandingan bootstrap offline ke `readMasterGaji_` GAS: **530 nilai PNS dan 526 nilai PPPK identik, termasuk urutannya**.
- Snapshot, SQL, CSV rollback, dan laporan validasi berada di direktori yang diabaikan Git. Jangan menyalin direktori ini ke preview publik.
- Uji login memakai akun sintetis dengan pepper uji. Password user asli tidak dibaca, dicoba, atau direset. Perbandingan visual PDF/CSV dan uji login user asli tetap bagian uji penerimaan Fase 4, bukan disimpulkan dari checksum.
- Validasi final: **87 test khusus tooling dan 516 test keseluruhan lulus**; build Pages/GAS serta `git diff --check` lulus.
- Review independen: **APPROVED** setelah satu temuan Medium diperbaiki. Pivot rollback gaji kini mempertahankan label pangkat dan urutan sumber meskipun kode golongan sama; constraint duplikat natural-key tetap diperiksa secara global. Test roundtrip split-row menutup kasus ini. Tidak ada temuan Critical/High/Medium tersisa pada scope tooling yang direview.
- Keterbatasan operasional: ekspor Wrangler dibatasi buffer 64 MiB; database lebih besar perlu snapshot/ekspor berhalaman. Ekspor remote tidak memberikan snapshot transaksi lintas tabel, sehingga freeze harus diterapkan operator. Mode file POSIX `0600` bukan pengganti ACL Windows.

### Fase 3 — Frontend satu runtime

1. Hapus `isGasRuntime`, `runGas`, cabang GAS di setiap method `api.*`, penyimpanan `sipsid_session` di storage, dan `INITIAL_SERVER_DATA`.
2. Hapus `parseEmbeddedErrorMarker` dan pesan yang menyebut "Spreadsheet".
3. Pertahankan `fetchJson`, `sipsid_pending_letter_create`, guard double submit, restorasi sesi, dan CSV formula-safe.
4. Pindahkan logo/kop surat ke `public/assets/` dan perketat CSP `img-src`.
5. Sesuaikan build:
   - `scripts/build-pages.mjs` dan `scripts/build-gas.mjs` saat ini gagal jika marker `<?!= serverData ?>` tidak ada;
   - hapus pemeriksaan marker di `build-pages.mjs`;
   - ubah npm script `build` menjadi hanya `build:pages`;
   - hapus pemanggilan `build-gas.mjs` dari `tests/build.test.mjs`.
6. Fase 1–3 tetap di branch `migration/cloudflare-d1` dan **baru masuk ke `main` saat cutover** (Bagian 11.1 langkah 7). Setelah itu `build:gas`/`push:gas` tidak boleh dijalankan dari `main`; rollback GAS memakai tag `pre-d1-cutover`.

**Selesai jika:** artifact `dist/` tidak lagi memuat `google.script.run` atau template GAS, build berhasil, dan test frontend lulus.

#### Status Fase 3 (2026-10-15) — Selesai (kode/build)

- Frontend hanya memakai adapter `fetchJson('/api/*')` dengan cookie HttpOnly (`credentials: same-origin`). Template/injeksi server, `isGasRuntime`, `runGas`, penyimpanan token sesi, parser marker error GAS, dan cabang API GAS dihapus. Pending `requestId` tetap disimpan untuk idempotency create.
- `npm run build` hanya memanggil `build:pages`; public assets disalin ke `dist/` dan output lama dibersihkan sebelum build.
- Logo dan kop surat resmi disimpan lokal di `public/assets/` tanpa perubahan gambar. Placeholder logo memakai SVG lokal; CSP tidak lagi mengizinkan Google Drive/placeholder eksternal pada `img-src`.
- `gas/Index.html` tetap menjadi snapshot rollback legacy. Test backend GAS membaca kontrak marker dari snapshot tersebut, bukan dari frontend aktif.
- Script `build-gas.mjs` melakukan preflight template sebelum menulis file apa pun, sehingga `npm run build:gas` yang tidak sengaja dijalankan pada branch ini tidak merusak snapshot rollback.
- Dependency UI CDN yang sudah ada (Tailwind, jsPDF/html2canvas, Font Awesome, Google Fonts) tidak dimigrasikan atau diganti pada fase ini; hanya aset logo/kop dan jalur runtime GAS yang ditangani.
- `public/404.html` mematikan fallback SPA otomatis untuk URL berkas yang hilang, sehingga image tidak tersedia mengembalikan 404 alih-alih HTML berstatus 200.
- Pengujian final: **512 test keseluruhan lulus**, termasuk **32 test frontend fetch-only** dan **10 test build**. Test GAS legacy tetap berjalan terhadap snapshot rollback; pengurangan jumlah test berasal dari penghapusan skenario direct-GAS frontend yang tidak lagi berlaku.
- HTTP lokal di salinan terisolasi `wrangler pages dev`: `/` 200; logo/kop PNG 200 `image/png`; fallback SVG 200; aset hilang 404; sesi anonim 401 JSON; API tidak dikenal 404 JSON. CSP `img-src` self/data/blob terverifikasi. Server uji dihentikan.
- Review independen **APPROVED** untuk kode/build, tanpa temuan Critical/High/Medium. Snapshot `gas/*` dan `Code.js` tidak berubah. Tidak ada deploy atau perubahan database remote pada fase ini.
- Validasi visual browser, responsivitas nyata, dan penangkapan gambar/font pada PDF tetap gerbang Fase 4; test VM/source dan HTTP tidak dianggap sebagai pengganti uji visual.

### Fase 4 — Preview dan uji penerimaan

1. Siapkan environment preview (K10), pilih salah satu:
   - **Data anonim:** seed D1 preview dengan data anonim dan user uji yang di-hash ulang; set `PASSWORD_PEPPER` khusus preview.
   - **Data asli:** lindungi URL preview dengan Cloudflare Access **sebelum** memuat data; set `PASSWORD_PEPPER` **produksi** karena hash `sha256$…` asli hanya dapat diverifikasi dengan pepper tersebut; hapus secret dan data setelah uji penerimaan.

   Pada kedua opsi, jangan set `ALLOWED_ORIGIN` untuk preview agar fallback ke origin request (nilai origin produksi membuat setiap mutasi preview ditolak `origin_forbidden`).
2. Terapkan migrasi ke D1 preview dan muat data uji:
   ```powershell
   npx wrangler d1 migrations apply sipsid-kgb-preview --remote --env preview
   ```
3. Deploy branch `migration/cloudflare-d1` sebagai preview Pages.
4. Uji: login per role, refresh sesi, logout (sesi dicabut), master gaji, create (termasuk retry dengan `requestId` sama), update, delete, laporan, PDF, CSV, seluruh manajemen user, throttle login termasuk varian huruf username.
5. Bandingkan 20 surat acak antara aplikasi lama dan baru (PDF dan CSV), menggunakan salinan data yang dilindungi Access bila data asli dipakai.
6. Hapus atau kosongkan D1 preview setelah uji penerimaan jika berisi data asli.

**Selesai jika:** seluruh skenario lulus dan tidak ada selisih data.

#### Status Fase 4 (2026-10-15) — Selesai, termasuk build Git

- Pilihan K10: **data sintetis saja**, tanpa mengambil user/hash/pepper atau surat produksi. D1 preview berisi empat akun uji, dua puluh surat anonim, dan enam nilai gaji uji.
- Binding preview diverifikasi menunjuk `3185cc3a-81a5-49eb-afd2-6b039ad387f8`. Secret `PASSWORD_PEPPER` preview dihasilkan acak; `ALLOWED_ORIGIN` preview dihapus. Konfigurasi produksi dibandingkan sebelum/sesudah PATCH dan tetap identik.
- Deploy sementara melalui CLI dari working tree belum di-commit: `7b80e8f8.sipsid-kgb.pages.dev` (uji API/browser awal), lalu `98d83e71.sipsid-kgb.pages.dev` (preview aktif sesudah uji maintenance). Ini **belum** membuktikan jalur build Git; commit serta smoke test deployment Git dari commit yang sama tetap gerbang sebelum cutover.
- API langsung preview: **24/24** lulus (login/cookie, sesi, role guards, surat CRUD/replay, user CRUD/reset/duplikasi, pencabutan sesi, origin, logout). Delapan create simultan dengan requestId sama menghasilkan satu ID/satu baris dan tujuh replay.
- Uji tambahan: sepuluh create requestId berbeda berhasil; replay payload berbeda tidak menimpa isi asli; update/delete simultan tidak menghidupkan kembali surat; delete/recreate username tidak mengaktifkan sesi lama. Dua admin saling demote simultan menghasilkan `[200,401]`, tersisa satu admin, dan cookie actor yang kalah ditolak; role akun uji kemudian dipulihkan.
- Dua belas percobaan login salah paralel lintas huruf besar/kecil hanya menghasilkan counter **5**; password benar sesudah burst ditolak. Username tidak dikenal berbagi satu bucket dan tidak memblokir akun sah.
- Sampel waktu respons jaringan (30 per kategori): median unknown/wrong/throttled **307/324/307 ms** dan p90 **415/410/452 ms**. Respons publik identik. Angka wall-time ini bukan pengukuran CPU atau bukti formal bebas timing side-channel; throttle berbasis username tetap memiliki risiko lockout sementara yang diterima pada desain saat ini.
- Maintenance preview diuji melalui secret+redeploy pada deployment khusus `0fa81c6a.sipsid-kgb.pages.dev`: ketujuh mutasi `503 maintenance`, login/read/logout tetap berfungsi (**10/10**). Flag preview dipulihkan menjadi false dan preview di-deploy ulang; tidak ada perubahan flag GAS/produksi.
- Chromium pada deployment **7b80e8f8**, desktop1280/mobile390: **11/11** lulus (login,refresh,simpan/edit kabkot kosong,CSV,PDF surat/laporan,tanpa overflow). Marker `${ttd_pengirim}` terbaca sebagai teks native PDF; kop lokal memiliki dimensi gambar terisi; pangkat penandatangan IV/d ada pada pratinjau. Sel CSV `-` diamankan menjadi `'-` dengan apostrof sesuai perlindungan formula; ini bukan perubahan data.
- Pada deployment **98d83e71** setelah unfreeze, mutasi akun uji berhasil kembali. Uji saling-demote admin `[200,401]` kemudian memulihkan role akun uji, membuktikan mode maintenance sudah nonaktif.
- Parity browser dua puluh surat anonim antara snapshot `gas/Index.html` dan frontend baru: **20/20** teks DOM, ukuran/kelas kertas, marker DOM, screenshot identik (selisih piksel **0%**), jumlah halaman PDF, serta marker teks native PDF cocok. CSV kedua versi identik **4.506 byte**. Empat puluh PDF benar-benar dibuat; seluruh header/ukuran file diverifikasi (minimal 433.015 byte). Pembandingan mengabaikan timestamp/ID acak metadata PDF, bukan membandingkan binary PDF.
- Dataset parity utama berisi PNS/Legal. Dua kasus tambahan **A4 PNS** dan **Legal PPPK** juga cocok 2/2 (selisih piksel 0%, marker/jumlah halaman PDF cocok, CSV identik 584 byte). Pengujian parity memakai routing lokal terkontrol dan aset resmi yang sama, bukan menulis surat ke aplikasi legacy produksi.
- Digest bukti deploy langsung (SHA-256 atas path+isi file terurut pada `dist/`, `functions/`, `src/server/`): `570dd7ee9352b0d4202f93ecf121b115a721d95137ac3d73ad2dd098ec413470` (15 file). Ini melacak artifact yang diuji, tetapi **bukan** pengganti commit/build Git.
- Artefak browser/JSON/PDF dan kredensial uji berada di direktori temp privat di luar repository. Kredensial/cookie tidak dimasukkan ke log, source, atau dokumen ini. Preview bersifat publik dan **tidak boleh** diisi data asli tanpa Access.

- Build Git terverifikasi setelah commit/push berizin: commit `e932c0d4870dd48d49f70ca7cbd61e669d6e8dcd`, deployment preview `5ab72003-5f83-4732-b899-4fd6011bb4e8`, URL `https://5ab72003.sipsid-kgb.pages.dev`. Status Active dan source commit cocok. HTML serta ketiga aset lokal byte-identik dengan build yang diuji.
- Smoke test deployment Git: **13/13 lulus**, meliputi bootstrap D1 3.0.0, login cookie aman, restorasi sesi, create surat sintetis, replay idempotent, penghapusan record uji, logout/revokasi, dan konfirmasi produksi tetap GAS 2.5.4. Data uji smoke dibersihkan; tidak ada perubahan database produksi. Pembaruan dokumentasi setelah commit ini tidak mengubah tree aplikasi yang diuji.

Gerbang cutover yang tetap wajib pada Fase 5:

1. Verifikasi hash/pepper produksi dengan login admin dan pengelola pemilik: belum diuji oleh pengujian sintetis. Harus dilakukan di lingkungan terlindungi atau pada rehearsal/cutover **sebelum** maintenance dilepas; kegagalan memblokir go-live. Password asli tidak boleh dikirim dalam percakapan atau dicoba oleh otomasi ini.

Gerbang parity dua puluh dokumen anonim dan build Git **sudah lulus**, bukan pekerjaan tertunda; bukti dan batas cakupan tercatat di atas. Review independen hasil uji dan runbook: **APPROVED untuk scope yang telah dikerjakan**, tanpa blocker Critical/High/Medium; tidak menghapus gerbang login pemilik saat cutover.

Produksi masih merespons GAS `2.5.4` dengan 530 nilai PNS/526 PPPK. D1 produksi tidak dimigrasikan atau diimport pada fase ini.

### Fase 5 — Cutover produksi

Lihat runbook di Bagian 11.

**Selesai jika:** produksi berjalan di D1, validasi data lulus, dan tidak ada error kritis selama masa pengawasan.

### Fase 6 — Dekomisioning

Dilakukan setelah 2–4 minggu stabil:

1. Hapus kode dan script GAS (Bagian 7).
2. Aktifkan rehash password saat login (Bagian 5.5), karena jendela rollback ke GAS sudah ditutup.
3. Hapus `GAS_WEB_APP_URL` dan `CLOUDFLARE_API_SECRET` dari Pages.
4. Arsipkan project GAS dan jadikan Spreadsheet read-only.
5. Perbarui `README.md`; arsipkan `IMPLEMENTATION_PLAN.md` (dual deployment).

## 9. Migrasi Data

### 9.1 Ekspor

1. Jalankan `hashMasterUserPasswords()` agar tidak ada password plaintext. Langkah ini **harus sebelum freeze**, karena `MAINTENANCE_MODE` juga memblokir fungsi tersebut.
2. Bekukan penulisan di **kedua jalur** (Bagian 11.1 langkah 3). GAS web app (`access: ANYONE_ANONYMOUS`) menulis langsung melalui `google.script.run`, sehingga membekukan gateway Cloudflare saja tidak cukup.
3. Buat **salinan cutover** baru dengan **File → Make a copy** setelah langkah 1–2. Jangan memakai backup Fase 0, karena backup tersebut tidak memuat data setelah Fase 0.
4. Pada salinan cutover, format kolom tanggal K, M, S, V menjadi `yyyy-mm-dd`, kolom A menjadi `yyyy-mm-dd"T"HH:mm:ss`, dan kolom NIP/gaji menjadi teks agar presisi tidak hilang.
5. Unduh setiap sheet salinan cutover sebagai CSV.

### 9.2 Aturan transformasi

| Data | Aturan |
|---|---|
| ID surat | Dipertahankan apa adanya. ID duplikat membatalkan proses. Baris dengan kolom B kosong dilewati dan dilaporkan, sama dengan `listLetters_` yang tidak menampilkannya |
| `request_id` | Diisi dari sufiks `KGB-YYYY-<x>` **hanya jika** sufiks sudah cocok persis dengan `^[a-z0-9_-]{1,100}$` (tanpa lowercase) dan unik di seluruh dataset; selain itu `NULL`. Sufiks yang sama pada tahun berbeda (dua surat sah) disimpan sebagai `NULL` untuk keduanya |
| Timestamp (kolom A) | Dibaca dalam zona waktu Spreadsheet (diverifikasi di Fase 0), disimpan sebagai ISO UTC format tetap `YYYY-MM-DDTHH:MM:SS.sssZ`. Jika kosong: `surat_tanggal` pukul 00:00 UTC+8, dan baris dilaporkan (tidak dikarantina) |
| Urutan arsip | `seq` diisi dari nomor baris sheet (baris 2 = 1, dst.) sehingga `ORDER BY seq DESC` sama persis dengan urutan GAS |
| Tanggal | ISO, `D/M/YYYY` (hari lebih dulu), nama bulan Indonesia, atau serial Spreadsheet; divalidasi sebagai tanggal kalender |
| Gaji | `Rp. 4.123.400,-` → `4123400`; format tidak dikenali masuk karantina |
| NIP | Hanya NIP yang **terpotong** (notasi ilmiah seperti `1.98E+17`, atau digit hilang) yang dikarantina. NIP non-standar lain (bukan 18 digit, berisi spasi) diimport apa adanya dan dilaporkan, karena validator saat ini menerimanya |
| `kabkot` | Kosong menjadi `NULL` |
| `ukuranKertas` | Lowercase; selain `a4` menjadi `legal` |
| Username | Duplikat beda huruf membatalkan proses |
| Password | Harus `sha256$<32hex>$<64hex>`; selain itu membatalkan proses; plaintext tidak pernah ditulis ke file |
| Nama lengkap | Kosong menjadi username, sesuai perilaku login saat ini |
| Role | `administrator` → `admin`; nilai tidak valid menjadi `pengelola` (dilaporkan); minimal satu admin |
| Master gaji | Pivot diubah menjadi satu baris per status × golongan × MKG; nilai 0/kosong dilewati |

### 9.3 Import

1. Terapkan schema (satu-satunya langkah migrasi schema produksi pada cutover): `npx wrangler d1 migrations apply sipsid-kgb --remote`.
2. Import berurutan: users, salary grades, letters dengan `npx wrangler d1 execute sipsid-kgb --remote --file=<file>`.
   - Statement dipecah agar tidak melebihi 100 KB per statement (±50 baris surat per statement, ±1.000 baris per file). Batas 100 bound parameter tidak berlaku untuk import `--file` berbasis SQL literal.
   - File SQL tidak boleh berisi `BEGIN`/`COMMIT`; D1 menolak transaksi eksplisit.
3. Import surat memakai `INSERT` biasa **tanpa** `ON CONFLICT DO NOTHING`, sehingga bentrok ID atau `request_id` menghentikan import alih-alih melewatkan surat secara diam-diam.
4. Untuk menjalankan ulang, database dikosongkan (atau dibuat ulang) lalu seluruh file diimport kembali.
5. Setelah import, jumlah baris setiap tabel **wajib** sama dengan hasil transformasi; selisih memblokir cutover.

Latihan seluruh proses dengan data asli dilakukan dengan `--local`. Latihan pada database preview dengan data asli hanya boleh dilakukan bila preview dilindungi Cloudflare Access (K10); dengan opsi data anonim, preview hanya memakai data anonim.

### 9.4 Validasi

- Jumlah baris per tabel sama dengan CSV dikurangi baris karantina.
- Agregat sama: `SUM(gaji_baru)`, `COUNT(DISTINCT nip)`, `MIN/MAX(surat_tanggal)`, jumlah per `status_pegawai` dan `kabkot`, jumlah admin.
- Checksum baris kanonik dari hasil transformasi sama dengan hasil ekspor D1.
- 20 surat acak menghasilkan PDF dan CSV yang identik dengan aplikasi lama.
- Login berhasil untuk setiap role.
- **Gerbang cutover:** tidak ada baris karantina yang belum diselesaikan.

### 9.5 Perlindungan data pribadi

- File CSV dan SQL berisi nama, NIP, gaji, dan hash password yang sudah di-pepper; perlakukan sebagai rahasia.
- Simpan di `migration-data/` (diabaikan Git) atau di luar repository, jangan di-commit, dan hapus setelah import tervalidasi.
- Time Travel D1 menyimpan riwayat data selama 7 hari (Free) atau 30 hari (Paid).
- Log Pages Functions mengikuti kebijakan redaksi GAS v2.5.3: tanpa payload, NIP, atau teks exception.

## 10. Strategi Testing

| Suite | Tindakan |
|---|---|
| `tests/cloudflare-api.test.mjs` | Pertahankan test routing, cookie, origin, payload, status, sanitasi; hapus test timeout/retry/GAS |
| `tests/gas-backend.test.mjs` | Port kasus domain (validasi, sesi stale, admin terakhir, duplikat, idempotency, throttle, otorisasi delete) ke D1 lokal; hapus test ScriptLock, Properties, Cache, flush |
| `tests/frontend-update.test.mjs` | Tulis ulang untuk client fetch-only; pertahankan requestId, CSV, dialog, guard admin, restorasi sesi |
| `tests/frontend-submit-errors.test.mjs` | Pertahankan kasus `fetchJson` dan submit; hapus kasus `runGas` dan marker |
| `tests/build.test.mjs` | Hapus pemeriksaan artifact GAS; pertahankan pemeriksaan PDF dan SRIKANDI |
| Baru | Test schema/constraint D1, script transformasi data, format Rupiah dan UTC+8 |

D1 lokal untuk test disediakan oleh `getPlatformProxy()` dari Wrangler sehingga `node:test` tetap dipakai tanpa framework baru. Catatan:

- Migrasi tidak diterapkan otomatis; test harus menerapkan schema sendiri.
- Gunakan `persist: false` atau direktori terpisah agar setiap test memakai schema bersih.
- `D1Database.exec()` memecah statement per baris, sehingga `CREATE TRIGGER` multi-baris harus dijalankan dengan `prepare().run()` atau melalui `wrangler d1 migrations apply --local`.

## 11. Runbook Cutover dan Rollback

### 11.1 Cutover

1. Umumkan jadwal maintenance.
2. Catat bookmark Time Travel D1 produksi sebelum import:
   ```powershell
   npx wrangler d1 time-travel info sipsid-kgb
   ```
3. Bekukan penulisan dengan mengaktifkan `MAINTENANCE_MODE` di Script Properties GAS (disiapkan dan diuji di Fase 0 langkah 11). Karena gateway Cloudflare lama meneruskan seluruh request ke GAS, flag ini menutup **kedua jalur** sekaligus: `/api/*` dan `google.script.run`.
   - Freeze GAS **tetap aktif setelah cutover** agar Spreadsheet tidak menerima data yang menyimpang dari D1.
4. Ekspor CSV, jalankan transformasi, terapkan schema, import, dan validasi (Bagian 9). Migrasi schema D1 produksi hanya dijalankan di langkah ini (Bagian 9.3 langkah 1), karena build Pages tidak menjalankannya.
5. Catat **bookmark kedua** setelah validasi import lulus dan sebelum go-live; bookmark ini adalah titik restore yang berisi data.
6. Set secret `PASSWORD_PEPPER` produksi dan **Pages `MAINTENANCE_MODE=true` sebelum deployment baru**. Flag GAS tidak memblokir backend D1; kedua flag berbeda dan harus dikendalikan terpisah.
7. Merge commit Fase 4 yang lolos uji Git-built preview ke `main` secara fast-forward, atau verifikasi tree hasil merge identik dengan tree yang diuji. Catat SHA sumber dan digest artifact. Pages melakukan deploy otomatis; pastikan `/api/bootstrap` atau `/api/auth/session` melaporkan `backendVersion: 3.0.0` dan satu mutasi diagnostik ditolak `503 maintenance`.
8. **Saat backend D1 masih frozen**, pemilik akun admin dan pengelola login dengan password masing-masing melalui UI. Verifikasi list arsip, laporan, PDF dan hash/pepper produksi tanpa menulis data. Uji sintetis Fase 4 tidak menggantikan langkah ini.
   - Jika salah satu gagal: pertahankan kedua freeze, rollback Pages ke deployment `pre-d1-cutover`, lalu lepas freeze GAS. Pages `MAINTENANCE_MODE` dibiarkan true; gateway legacy mengabaikannya dan percobaan cutover berikutnya dimulai dari status frozen yang diketahui. Bila belum ada penulisan bisnis D1, tidak diperlukan rekonsiliasi data surat/user. Jangan reset seluruh password sebagai jalan pintas.
9. Setelah gerbang login lulus, set Pages `MAINTENANCE_MODE=false` lalu **Retry deployment** melalui dashboard/API untuk commit yang sama; pastikan SHA deployment sama dengan langkah 7 (jangan mengunggah dirty working tree). Kemudian lakukan smoke test create/update memakai record yang jelas bertanda UJI CUTOVER. Hapus record tersebut sebagai admin setelah selesai dan catat pembersihannya. Freeze GAS tetap aktif.
10. Pantau error selama 24–48 jam.

### 11.2 Rollback

Rollback ke GAS hanya mungkin sebelum Fase 6.

1. **Aktifkan `MAINTENANCE_MODE` di aplikasi baru** (Fase 1 langkah 5): set secret Pages, **redeploy** agar secret berlaku, lalu pastikan sebuah mutasi uji ditolak dengan `503 MAINTENANCE` sebelum ekspor dimulai.
2. **Rekonsiliasi data D1 ke Spreadsheet** dengan `export-d1-to-csv.mjs`:
   - surat dengan `created_at` atau `updated_at` setelah cutover: tambah baris baru atau timpa baris yang ada sesuai ID, dalam urutan kolom `Database_Surat`;
   - surat yang dihapus: bandingkan daftar ID D1 dengan snapshot Spreadsheet saat cutover, lalu hapus baris yang tidak ada lagi di D1;
   - user baru, perubahan role, dan penghapusan user disinkronkan ke `Master_User`.
3. **Password:** GAS tidak dapat memverifikasi hash PBKDF2. Karena rehash saat login ditunda sampai Fase 6 (Bagian 5.5), hanya user yang **dibuat atau di-reset** setelah cutover yang perlu di-reset ulang passwordnya di GAS.
4. **Cabut freeze GAS** (nonaktifkan `MAINTENANCE_MODE` di Script Properties).
5. **Instant rollback Pages** ke deployment dari tag `pre-d1-cutover`. Deployment tersebut masih meneruskan ke GAS, sehingga `GAS_WEB_APP_URL` dan `CLOUDFLARE_API_SECRET` tidak boleh dihapus sebelum Fase 6.

**Kerusakan data D1 (tanpa kembali ke GAS):** `npx wrangler d1 time-travel restore sipsid-kgb --bookmark=<bookmark-kedua>`. Restore bersifat **destruktif**: seluruh penulisan setelah bookmark tersebut hilang.

## 12. Risiko dan Mitigasi

| Risiko | Mitigasi |
|---|---|
| Penulisan langsung ke GAS web app selama dan setelah cutover | Freeze GAS di kedua jalur dan tetap aktif setelah cutover (Bagian 11.1) |
| Varian huruf username melipatgandakan percobaan brute-force | Key throttle dari username kanonik/`users.id` (Bagian 4.1) |
| Surat hilang diam-diam saat import | Import tanpa `DO NOTHING`; assertion jumlah baris memblokir cutover |
| Kode error salah setelah guard 0 baris | Read diagnostik berurutan (Bagian 5.3) dan contract test per kode |
| Data pribadi bocor di preview publik | Data anonim atau Cloudflare Access (K10) |
| Pepper atau hash tidak cocok sehingga semua user tidak bisa login | Salin `PASSWORD_PEPPER` persis; pemilik admin/pengelola login saat D1 masih frozen sebelum akses tulis dibuka (Bagian 11.1 langkah 8) |
| NIP yang sudah terpotong di Spreadsheet | Deteksi saat transformasi; karantina dan input ulang dari dokumen sumber |
| Parsing tanggal ambigu (`10/11/2026`) | Format kolom menjadi ISO pada salinan sebelum ekspor |
| Data berubah saat cutover | Freeze penulisan selama maintenance |
| Tahun ID salah di awal tahun karena UTC | Hitung tahun dan tanggal secara eksplisit di UTC+8 |
| Biaya CPU PBKDF2 melebihi batas plan | Ukur di Fase 0; setting `PASSWORD_HASH_ALGO` tetap `sha256` sampai plan Paid |
| Rehash PBKDF2 memaksa reset massal saat rollback | Rehash saat login ditunda sampai Fase 6 |
| Proteksi sheet tidak memblokir pemilik Spreadsheet | Freeze utama memakai flag `MAINTENANCE_MODE` di Script Properties |
| Migrasi D1 tidak dijalankan sebelum deploy | Checklist cutover; migrasi diterapkan sebelum merge |
| Penulisan ulang test yang besar | Prioritaskan autentikasi dan integritas data |
| `letters.list` tanpa pagination | Cukup untuk volume saat ini; pagination direncanakan terpisah |
| Kebocoran data pribadi dari file ekspor | File di luar repository, dihapus setelah validasi |

## Lampiran A — DDL `migrations/0001_initial.sql` (draft)

```sql
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT, -- id user tidak pernah dipakai ulang
  username        TEXT    NOT NULL COLLATE NOCASE
                  CHECK (length(username) BETWEEN 1 AND 100 AND username = trim(username)),
  password_hash   TEXT    NOT NULL
                  CHECK (password_hash GLOB 'sha256$*' OR password_hash GLOB 'pbkdf2_sha256$*'),
  nama_lengkap    TEXT    NOT NULL CHECK (length(nama_lengkap) BETWEEN 1 AND 160),
  role            TEXT    NOT NULL DEFAULT 'pengelola' CHECK (role IN ('admin','pengelola')),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT uq_users_username UNIQUE (username)
) STRICT;
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE letters (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  request_id     TEXT UNIQUE CHECK (request_id IS NULL OR (length(request_id) BETWEEN 1 AND 100
                   AND request_id = lower(request_id) AND request_id NOT GLOB '*[^a-z0-9_-]*')),
  status_pegawai TEXT NOT NULL CHECK (status_pegawai IN ('PNS','PPPK')),
  nama           TEXT NOT NULL CHECK (length(nama) BETWEEN 1 AND 180),
  nip            TEXT NOT NULL CHECK (length(nip) BETWEEN 1 AND 180),
  pangkat        TEXT NOT NULL CHECK (length(pangkat) BETWEEN 1 AND 180),
  jabatan        TEXT NOT NULL CHECK (length(jabatan) BETWEEN 1 AND 300),
  unit           TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 300),
  kabkot         TEXT CHECK (kabkot IS NULL OR length(kabkot) BETWEEN 1 AND 180),
  sk_pejabat     TEXT NOT NULL CHECK (length(sk_pejabat) BETWEEN 1 AND 180),
  sk_tanggal     TEXT NOT NULL CHECK (date(sk_tanggal) IS sk_tanggal),
  sk_nomor       TEXT NOT NULL CHECK (length(sk_nomor) BETWEEN 1 AND 180),
  sk_tmt         TEXT NOT NULL CHECK (date(sk_tmt) IS sk_tmt),
  mk_lama_thn    INTEGER NOT NULL CHECK (mk_lama_thn BETWEEN 0 AND 40),
  mk_lama_bln    INTEGER NOT NULL CHECK (mk_lama_bln BETWEEN 0 AND 11),
  gaji_lama      INTEGER NOT NULL CHECK (gaji_lama >= 0),
  mk_baru_thn    INTEGER NOT NULL CHECK (mk_baru_thn BETWEEN 1 AND 40),
  mk_baru_bln    INTEGER NOT NULL CHECK (mk_baru_bln BETWEEN 0 AND 11),
  gaji_baru_tmt  TEXT NOT NULL CHECK (date(gaji_baru_tmt) IS gaji_baru_tmt),
  gaji_baru      INTEGER NOT NULL CHECK (gaji_baru >= 0),
  surat_nomor    TEXT NOT NULL CHECK (length(surat_nomor) BETWEEN 1 AND 180),
  surat_tanggal  TEXT NOT NULL CHECK (date(surat_tanggal) IS surat_tanggal),
  sign_jabatan   TEXT NOT NULL CHECK (length(sign_jabatan) BETWEEN 1 AND 180),
  sign_nama      TEXT NOT NULL CHECK (length(sign_nama) BETWEEN 1 AND 180),
  sign_pangkat   TEXT NOT NULL CHECK (length(sign_pangkat) BETWEEN 1 AND 180),
  sign_nip       TEXT NOT NULL CHECK (length(sign_nip) BETWEEN 1 AND 180),
  ukuran_kertas  TEXT NOT NULL DEFAULT 'legal' CHECK (ukuran_kertas IN ('a4','legal')),
  created_by     TEXT COLLATE NOCASE,
  updated_by     TEXT COLLATE NOCASE,
  -- Urutan tampil arsip. Data lama: nomor baris sheet. Surat baru: MAX(seq)+1 pada INSERT yang sama.
  -- Tidak memakai rowid implisit karena VACUUM dapat menomori ulang rowid.
  seq            INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK (length(created_at) = 24
                        AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 CHECK (length(updated_at) = 24)
) STRICT;
-- Urutan daftar arsip sama dengan GAS (baris terbawah sheet di atas):
--   SELECT … FROM letters ORDER BY seq DESC;
-- Index unik pada seq sudah dibuat oleh constraint UNIQUE.
CREATE INDEX idx_letters_created       ON letters(created_at);
CREATE INDEX idx_letters_nama          ON letters(nama COLLATE NOCASE);
CREATE INDEX idx_letters_nip           ON letters(nip);
CREATE INDEX idx_letters_kabkot_surat  ON letters(kabkot, surat_tanggal);
CREATE INDEX idx_letters_surat_tanggal ON letters(surat_tanggal);

CREATE TABLE salary_grades (
  id             INTEGER PRIMARY KEY,
  status_pegawai TEXT    NOT NULL CHECK (status_pegawai IN ('PNS','PPPK')),
  pangkat        TEXT    NOT NULL CHECK (length(pangkat) BETWEEN 1 AND 120),
  golongan_code  TEXT    NOT NULL CHECK (length(golongan_code) BETWEEN 1 AND 20),
  mkg            INTEGER NOT NULL CHECK (mkg BETWEEN 0 AND 40),
  nominal        INTEGER NOT NULL CHECK (nominal > 0),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT uq_salary UNIQUE (status_pegawai, golongan_code, mkg)
) STRICT;

CREATE TABLE login_throttle (
  key        TEXT    PRIMARY KEY CHECK (key GLOB 'lt_*' AND length(key) = 35),
  count      INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_login_throttle_expires ON login_throttle(expires_at);

CREATE TABLE sessions (
  token_hash      TEXT    PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at      TEXT    NOT NULL,
  revoked_at      TEXT
) STRICT;
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Trigger = jaring pengaman untuk SQL manual. Jalur aplikasi menolak lebih dulu lewat guard WHERE (Bagian 5.3).
CREATE TRIGGER trg_users_last_admin_delete BEFORE DELETE ON users
WHEN OLD.role = 'admin' AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN_PROTECTED'); END;

CREATE TRIGGER trg_users_last_admin_demote BEFORE UPDATE OF role ON users
WHEN OLD.role = 'admin' AND NEW.role <> 'admin'
     AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN_PROTECTED'); END;
```

## Lampiran B — Pola SQL Pengganti `ScriptLock`

Placeholder bernama (`?actor`, `?sv`, `?now`) hanya untuk keterbacaan. D1 tidak mendukung named parameter; implementasi memakai `?1`, `?2`, … dengan ordinal yang dipakai ulang untuk nilai berulang.

`?actor`/`?sv` adalah username dan `session_version` pengguna yang login. Sesi divalidasi lebih dulu (Bagian 5.4); guard actor di setiap statement mutasi tetap ada untuk menutup race condition dan menggantikan `revalidateActorInLock_`. Hasil 0 baris dipetakan ke kode error sesuai Bagian 5.3.

**Create idempotent (`requestId`):**

```sql
INSERT INTO letters (id, request_id, seq, status_pegawai, /* … */ created_by, updated_by, created_at, updated_at)
SELECT ?id, ?rid, (SELECT COALESCE(MAX(seq), 0) + 1 FROM letters), ?status, /* … */
       ?actor, ?actor, ?now, ?now
WHERE EXISTS (SELECT 1 FROM users WHERE username = ?actor AND session_version = ?sv)
ON CONFLICT DO NOTHING
RETURNING *;
```

`ON CONFLICT DO NOTHING` **tanpa target** menangani bentrok pada `request_id` maupun primary key `id`. Ini perlu karena data lama dengan `request_id` `NULL` (Bagian 9.2) dapat memiliki `id` yang sama dengan ID yang diturunkan dari `requestId` retry di browser.

Karena sesi sudah divalidasi sebelum `INSERT`, hasil 0 baris berarti bentrok: baca `SELECT * FROM letters WHERE request_id = ?rid OR id = ?id` dan kembalikan dengan `idempotent: true`. Jika baris tidak ditemukan (actor berubah atau surat dihapus di antara dua statement), validasi ulang sesi untuk memilih antara `AUTH_REQUIRED` dan `DATA_WRITE_FAILED`.

`MAX(seq) + 1` aman tanpa lock karena D1 menjalankan statement tulis satu per satu; constraint `UNIQUE` pada `seq` menjadi pengaman tambahan.

**Update surat:**

```sql
UPDATE letters SET status_pegawai = ?s, /* … */ updated_by = ?actor, updated_at = ?now, version = version + 1
WHERE id = ?id
  AND EXISTS (SELECT 1 FROM users WHERE username = ?actor AND session_version = ?sv)
RETURNING *;
```

Setelah frontend mengirim versi, tambahkan `AND version = ?expected` untuk optimistic concurrency.

**Delete surat (admin):**

```sql
DELETE FROM letters WHERE id = ?id
  AND EXISTS (SELECT 1 FROM users WHERE username = ?actor AND session_version = ?sv AND role = 'admin')
RETURNING id;
```

**Delete user dengan proteksi admin terakhir dan self-delete:**

```sql
DELETE FROM users
WHERE username = ?target AND username <> ?actor
  AND EXISTS (SELECT 1 FROM users a WHERE a.username = ?actor AND a.session_version = ?sv AND a.role = 'admin')
  AND (role <> 'admin' OR (SELECT COUNT(*) FROM users WHERE role = 'admin') > 1)
RETURNING username;
```

**Update/demote user:**

```sql
UPDATE users SET nama_lengkap = ?nama, role = ?role,
  session_version = session_version + (role <> ?role), version = version + 1, updated_at = ?now
WHERE username = ?target
  AND EXISTS (SELECT 1 FROM users a WHERE a.username = ?actor AND a.session_version = ?sv AND a.role = 'admin')
  AND NOT (role = 'admin' AND ?role <> 'admin'
           AND (username = ?actor OR (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1))
RETURNING username, nama_lengkap, role;
```

**Reset password:** `SET password_hash = ?h, session_version = session_version + 1, …` dengan guard actor yang sama.

**Throttle login (konsumsi atomik; tanpa baris hasil berarti diblokir):**

```sql
INSERT INTO login_throttle (key, count, expires_at) VALUES (?k, 1, ?nowMs + 300000)
ON CONFLICT(key) DO UPDATE SET
  count      = CASE WHEN login_throttle.expires_at <= ?nowMs THEN 1 ELSE login_throttle.count + 1 END,
  expires_at = ?nowMs + 300000
WHERE login_throttle.expires_at <= ?nowMs OR login_throttle.count < 5
RETURNING count;
```

`?k` = `lt_` + 32 hex pertama `sha256` dari username kanonik tersimpan (atau `users.id`), atau dari `__unknown_username_bucket__` untuk username tidak dikenal — tidak pernah dari input mentah. Login berhasil menjalankan `DELETE FROM login_throttle WHERE key = ?k`. Baris hasil kosong atau error D1 menolak login (fail-closed) dengan respons `INVALID_CREDENTIALS`, sama seperti sekarang.

**Rehash password saat login (compare-and-swap):**

```sql
UPDATE users SET password_hash = ?new, updated_at = ?now
WHERE id = ?id AND password_hash = ?old;
```
