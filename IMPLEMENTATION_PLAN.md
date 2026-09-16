# Implementation Plan: Dual Deployment SIPSID-KGB

## 1. Tujuan

Mengubah satu repository SIPSID-KGB agar menghasilkan dua target deployment dari source frontend yang sama:

1. **Cloudflare Pages**: frontend statis di Cloudflare Pages, Pages Functions sebagai Backend-for-Frontend (BFF), dan Google Apps Script tetap menjadi data service untuk Google Sheets.
2. **Google Apps Script**: frontend dan backend tetap dapat dijalankan sebagai GAS Web App serta dipublikasikan dengan `clasp push`.

Google Sheets tetap menjadi satu-satunya sumber data. Tidak ada kredensial Google atau secret backend yang dikirim ke browser atau disimpan di GitHub.

## 2. Kondisi Saat Ini

- Repository Git sudah tersedia dan mengarah ke `https://github.com/ElwinMusadi/SIPSID-KGB.git`.
- Project hanya berisi `Index.html`, `Code.js`, `appsscript.json`, dan `.gitattributes`.
- `Index.html` masih terikat langsung ke GAS melalui:
  - Template tag `<?!= serverData ?>` pada `Index.html:546`.
  - `google.script.run` untuk master gaji, arsip, dan penghapusan.
  - URL deployment GAS hardcoded pada `Index.html:545`.
  - `fetch(..., mode: 'no-cors')` pada `Index.html:885-908` sehingga hasil simpan tidak dapat diverifikasi.
- `Code.js` sudah memiliki service pembacaan master gaji, arsip, penghapusan, dan penyimpanan ke `Database_Surat`, tetapi belum mempunyai API contract lintas platform.
- Belum ada `.clasp.json`, build system, automated test, atau konfigurasi Cloudflare.
- Login masih divalidasi di browser menggunakan password plaintext di `Index.html`.

## 3. Keputusan Arsitektur

### 3.1 Arsitektur yang dipilih

```text
                         +-----------------------------+
                         | Google Spreadsheet          |
                         | Master_User                 |
                         | Master_Gaji_Pangkat         |
                         | Database_Surat              |
                         +--------------+--------------+
                                        |
                              SpreadsheetApp
                                        |
                         +--------------v--------------+
                         | Google Apps Script backend  |
                         | service + validation + auth |
                         +--------+------------+-------+
                                  |            |
                     google.script.run         | HTTPS internal API
                                  |            | shared secret
                    +-------------v--+    +----v------------------+
                    | GAS Web App    |    | Cloudflare Pages      |
                    | shared UI      |    | Functions /api/* BFF  |
                    +----------------+    +-----------+-----------+
                                                   |
                                            same-origin fetch
                                                   |
                                        +----------v----------+
                                        | Cloudflare Pages UI |
                                        | shared UI build     |
                                        +---------------------+
```

Cloudflare Pages tidak akan mengakses Google Sheets API secara langsung. Pages Functions meneruskan request terautentikasi ke GAS. Pendekatan ini dipilih karena:

- Logika bisnis dan akses Spreadsheet tetap satu implementasi.
- Tidak memerlukan service-account key Google di Cloudflare.
- Kedua deployment membaca dan menulis Spreadsheet yang sama.
- Browser Cloudflare tidak terkena masalah CORS Apps Script karena hanya memanggil `/api/*` pada origin Cloudflare sendiri.
- Secret penghubung Cloudflare–GAS hanya berada di Cloudflare environment variables dan GAS Script Properties.

### 3.2 Alternatif yang tidak dipilih

Mengakses Google Sheets API langsung dari Pages Functions akan membuat dua backend terpisah: GAS dan Cloudflare. Validasi, mapping kolom, locking, dan autentikasi harus dipelihara dua kali. Risiko inkonsistensi lebih tinggi, sehingga tidak direkomendasikan.

## 4. Struktur Repository Target

```text
SIPSID-KGB/
├── src/
│   ├── index.html                 # markup frontend bersama
│   ├── styles.css                 # CSS aplikasi dan cetak
│   ├── app.js                     # fitur UI bersama
│   └── api-client.js              # transport abstraction GAS/Pages
├── gas/
│   ├── Code.js                    # backend GAS dan Spreadsheet service
│   ├── Index.html                 # hasil build frontend untuk HtmlService
│   └── appsscript.json
├── functions/
│   └── api/
│       └── [[path]].js            # Pages Functions BFF/API gateway
├── scripts/
│   ├── build-pages.mjs
│   └── build-gas.mjs
├── tests/
│   ├── frontend/
│   ├── functions/
│   └── fixtures/
├── public/
│   └── _headers                   # security headers untuk Pages
├── dist/                          # hasil build Pages; tidak di-commit
├── .clasp.json                    # Script ID dan rootDir gas
├── .claspignore
├── .dev.vars.example              # nama variable saja, tanpa secret
├── .gitignore
├── package.json
├── package-lock.json
├── wrangler.toml
└── README.md                      # prosedur build/deploy dua target
```

`src/` menjadi sumber frontend tunggal. `gas/Index.html` akan dibuat secara deterministik oleh build script dan disimpan agar `clasp push` tetap sederhana. `dist/` dibuat saat Cloudflare/GitHub menjalankan build.

## 5. API Contract Bersama

Frontend tidak lagi memanggil `google.script.run` atau URL GAS secara langsung dari fungsi fitur. Semua operasi melewati interface Promise yang sama:

```text
api.login(credentials)
api.logout()
api.getBootstrap()
api.listLetters()
api.createLetter(letter)
api.deleteLetter(id)
```

### Target GAS

`api-client.js` membungkus `google.script.run` menjadi Promise dan memanggil fungsi publik GAS yang tervalidasi.

### Target Cloudflare

`api-client.js` memakai same-origin `fetch('/api/...')`. Pages Functions kemudian mengirim envelope POST ke GAS:

```json
{
  "action": "letters.create",
  "payload": {},
  "sessionToken": "...",
  "apiSecret": "server-only"
}
```

Respons dinormalisasi untuk kedua target:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Endpoint browser Cloudflare:

| Method | Route | Fungsi |
|---|---|---|
| `POST` | `/api/auth/login` | Login dan membuat secure session |
| `POST` | `/api/auth/logout` | Menghapus session |
| `GET` | `/api/bootstrap` | Konfigurasi aman dan master gaji |
| `GET` | `/api/letters` | Membaca arsip surat |
| `POST` | `/api/letters` | Membuat surat |
| `DELETE` | `/api/letters/:id` | Menghapus surat |

Pages Functions menggunakan POST saat berkomunikasi dengan GAS agar shared secret tidak masuk URL, query string, atau browser.

## 6. Tahapan Implementasi

### Tahap 1 — Baseline dan perlindungan data

1. Catat deployment ID GAS aktif dan commit baseline.
2. Buat salinan Spreadsheet untuk integration test.
3. Verifikasi header serta urutan kolom `Database_Surat` A–AA.
4. Dapatkan Script ID project GAS dan buat `.clasp.json` dengan `rootDir: "gas"`.
5. Pastikan `clasp push` diarahkan ke project yang benar sebelum file dipindahkan.

Tidak ada pengujian create/delete terhadap Spreadsheet produksi selama tahap pengembangan.

### Tahap 2 — Build system dual-target

1. Tambahkan Node.js toolchain minimal dan lockfile.
2. Pindahkan markup, CSS, dan JavaScript browser ke `src/`.
3. Buat `build-pages.mjs` untuk menghasilkan `dist/index.html` dan asset Cloudflare tanpa template tag GAS.
4. Buat `build-gas.mjs` untuk membundel CSS/JavaScript ke `gas/Index.html` yang kompatibel dengan `HtmlService`.
5. Pindahkan `Code.js` dan `appsscript.json` ke `gas/`.
6. Tambahkan scripts:

```json
{
  "build": "npm run build:pages && npm run build:gas",
  "build:pages": "node scripts/build-pages.mjs",
  "build:gas": "node scripts/build-gas.mjs",
  "dev:pages": "wrangler pages dev dist",
  "push:gas": "npm run build:gas && clasp push"
}
```

7. Tambahkan pemeriksaan build yang gagal jika artifact Pages masih memuat `<?`, `google.script.run`, atau URL deployment GAS hardcoded.

### Tahap 3 — Abstraksi frontend

1. Implementasikan `api-client.js` dengan adapter `GasApiClient` dan `PagesApiClient`.
2. Target ditentukan saat build, bukan dengan URL hardcoded.
3. Ubah fungsi berikut agar hanya memakai API client:
   - `refreshMasterGaji()`
   - `submitKgbForm()`
   - `loadArsipSurat()`
   - `deleteHistoryItem()`
   - `login()` dan `logout()`
4. Hapus `mode: 'no-cors'` dan pesan sukses palsu. UI hanya menambahkan surat ke state setelah backend mengembalikan sukses.
5. Pertahankan fitur dashboard, kalkulasi gaji, arsip, laporan, cetak, dan PDF pada kedua target.
6. Gunakan satu state-loading dan error-handling path untuk kedua deployment.

### Tahap 4 — Refactor backend GAS menjadi service bersama

1. Pisahkan fungsi internal berikut di `gas/Code.js`:
   - konfigurasi Spreadsheet
   - pembacaan master gaji
   - pembacaan arsip
   - pembuatan surat
   - penghapusan surat
   - autentikasi dan validasi session
2. Gunakan `PropertiesService` untuk:
   - `SPREADSHEET_ID`
   - `CLOUDFLARE_API_SECRET`
   - `SESSION_SIGNING_SECRET`
3. Hapus Spreadsheet ID dari source setelah migrasi konfigurasi selesai.
4. Gunakan satu mapping schema A–AA agar fungsi read/write tidak mendefinisikan urutan kolom secara terpisah.
5. Tambahkan validasi server-side untuk field wajib, tipe status, tanggal, masa kerja, nominal, panjang input, dan ukuran kertas.
6. Gunakan `LockService` untuk create/delete dan periksa duplikasi ID sebelum `appendRow()`.
7. Ganti ID acak empat digit dengan ID collision-resistant, misalnya UUID internal. Nomor surat resmi tetap field terpisah.
8. Pertahankan fungsi `doGet()` untuk merender GAS Web App.
9. Ubah `doPost()` menjadi dispatcher internal khusus request Pages Functions yang:
   - memvalidasi shared secret;
   - memvalidasi session dan role;
   - memanggil service internal yang sama dengan `google.script.run`;
   - selalu mengembalikan JSON terstruktur.
10. Fungsi internal diberi suffix `_` agar tidak dapat dipanggil langsung melalui `google.script.run`.

### Tahap 5 — Autentikasi dan otorisasi

1. Hapus `usersDatabase` dan seluruh password dari frontend.
2. Jangan lagi mengirim daftar user melalui `serverData` atau bootstrap response.
3. Validasi username/password di GAS berdasarkan `Master_User`.
4. Migrasikan password plaintext ke nilai hash dengan salt dan server-side pepper dari Script Properties. Password lama tidak boleh tetap berada di source.
5. GAS menghasilkan session token bertanda tangan dengan masa berlaku terbatas dan informasi role minimum.
6. Pada GAS Web App, token disimpan di `sessionStorage` dan dikirim eksplisit pada setiap operasi API.
7. Pada Cloudflare Pages, Pages Function menyimpan token dalam cookie `HttpOnly`, `Secure`, dan `SameSite=Strict`; token tidak dapat dibaca JavaScript browser.
8. Terapkan otorisasi role, terutama untuk penghapusan arsip.
9. Tambahkan logout dan expiry handling yang konsisten pada kedua target.
10. Validasi `Origin` pada mutasi Cloudflare serta pasang security headers.

Catatan: endpoint GAS tetap harus dapat dijangkau Pages Functions. Karena itu endpoint dapat tetap `ANYONE_ANONYMOUS`, tetapi seluruh action data dari jalur HTTP wajib ditolak tanpa shared secret dan session valid. Shared secret bukan pengganti session pengguna; keduanya divalidasi.

### Tahap 6 — Cloudflare Pages Functions

1. Buat catch-all handler `functions/api/[[path]].js`.
2. Validasi method, route, content type, ukuran payload, dan origin.
3. Ambil `GAS_WEB_APP_URL` dan `CLOUDFLARE_API_SECRET` dari `env`.
4. Teruskan request ke GAS dengan `redirect: 'follow'` karena Apps Script dapat melakukan redirect ke domain `script.googleusercontent.com`.
5. Normalisasi kegagalan GAS, timeout, respons non-JSON, dan error aplikasi menjadi status HTTP yang benar.
6. Jangan meneruskan secret, stack trace, atau detail Spreadsheet ke browser.
7. Tambahkan correlation/request ID untuk troubleshooting tanpa mencatat password, token, NIP, atau isi surat.
8. Terapkan rate limiting melalui konfigurasi Cloudflare bila endpoint sudah dipublikasikan.

Environment Cloudflare:

```text
GAS_WEB_APP_URL
CLOUDFLARE_API_SECRET
SESSION_COOKIE_SECRET
ALLOWED_ORIGIN
```

File lokal `.dev.vars` masuk `.gitignore`; hanya `.dev.vars.example` yang di-commit.

### Tahap 7 — Hardening frontend

1. Escape semua data Spreadsheet sebelum dimasukkan ke HTML, termasuk tabel laporan dan template surat.
2. Hapus inline event handler secara bertahap dan gunakan `addEventListener` agar CSP dapat diperketat.
3. Pindahkan asset yang memungkinkan ke bundle lokal.
4. Pertahankan CDN PDF hanya jika checksum/SRI dan CSP dapat dikontrol; opsi yang lebih aman adalah bundling dependency melalui npm.
5. Tambahkan `_headers` untuk CSP, `X-Content-Type-Options`, `Referrer-Policy`, dan `Permissions-Policy`.
6. Hapus `XFrameOptionsMode.ALLOWALL` kecuali embedding lintas origin memang dibutuhkan.
7. Perbaiki placeholder tanda tangan `${ttd_pengirim}` agar tidak tercetak literal.

### Tahap 8 — Test

#### Unit test

- Mapping row Spreadsheet A–AA ke object dan sebaliknya.
- Normalisasi tanggal dan nominal gaji.
- Pemilihan master gaji berdasarkan status, pangkat, dan MKG.
- Validasi payload create/delete.
- Pembuatan dan verifikasi session token.
- Routing serta error mapping Pages Functions.

#### Build test

- Build Pages dan GAS selesai dari clean checkout.
- `dist/` tidak memuat syntax template GAS.
- `gas/Index.html` memuat bundle frontend yang valid.
- Tidak ada password, Script ID sensitif, shared secret, atau `.dev.vars` dalam artifact/repository.

#### Integration test

Menggunakan Spreadsheet salinan:

1. Login valid dan invalid.
2. Ambil master gaji PNS dan PPPK.
3. Buat satu surat dari GAS Web App.
4. Pastikan surat terlihat dari Cloudflare preview.
5. Buat satu surat dari Cloudflare preview.
6. Pastikan surat terlihat dari GAS Web App.
7. Hapus sesuai role dan pastikan kedua target tersinkron.
8. Simulasikan Spreadsheet unavailable, secret salah, session expired, dan duplikasi request.

#### UI smoke test

- Dashboard.
- Form PNS dan PPPK.
- Kalkulasi gaji.
- Pratinjau A4 dan Legal.
- Download PDF.
- Arsip, pencarian, penghapusan.
- Laporan, filter, cetak, dan CSV.
- Desktop dan mobile pada kedua target.

### Tahap 9 — Deployment

#### Google Apps Script

1. Jalankan `npm ci`.
2. Jalankan `npm test` dan `npm run build:gas`.
3. Set Script Properties melalui akun pemilik.
4. Jalankan `clasp push`.
5. Buat deployment test baru; jangan langsung mengganti deployment produksi.
6. Setelah smoke test berhasil, update deployment produksi.

#### Cloudflare Pages

1. Hubungkan repository GitHub ke Cloudflare Pages.
2. Production branch: `main`.
3. Build command: `npm ci && npm run build:pages`.
4. Build output directory: `dist`.
5. Tambahkan environment variables untuk Preview dan Production secara terpisah.
6. Validasi Preview deployment terhadap GAS test deployment dan Spreadsheet salinan.
7. Setelah lulus, ubah Production variables ke GAS production deployment.

#### GitHub CI

Pull request dan push ke `main` menjalankan:

```text
npm ci
npm test
npm run build
secret scan
```

Cloudflare melakukan production deployment hanya setelah build branch `main` berhasil.

## 7. Urutan Commit yang Direkomendasikan

1. `chore: add dual-target build structure`
2. `refactor: extract shared frontend and api client`
3. `refactor: expose validated gas service layer`
4. `feat: add cloudflare pages api gateway`
5. `security: move authentication to backend sessions`
6. `test: cover builds and shared data flows`
7. `docs: add gas and cloudflare deployment runbook`

Commit dan push hanya dilakukan setelah perubahan ditinjau; plan ini tidak mengotorisasi push otomatis.

## 8. Risiko dan Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Quota dan latency GAS | Cloudflare UI tetap bergantung pada GAS | Cache hanya data master, timeout jelas, retry terbatas, monitoring |
| Redirect respons Apps Script | Proxy gagal membaca JSON | Server fetch memakai `redirect: 'follow'` dan integration test |
| Endpoint GAS publik | Request langsung mencoba melewati Cloudflare | Shared secret, session, validasi action, rate control |
| Secret bocor ke Git | Akses data tidak sah | Cloudflare Secrets, Script Properties, `.gitignore`, secret scan |
| Source dan artifact GAS berbeda | Dua versi UI tidak sinkron | Satu `src/`, deterministic build, CI drift check |
| Perubahan schema Sheet | Read/write salah kolom | Schema mapping terpusat dan header validation |
| Write bersamaan | Duplikasi/korupsi data | `LockService`, UUID, idempotency/duplicate check |
| Auth lama plaintext | Kebocoran akun | Migrasi hash, hapus credential frontend, rotasi password |
| Delete terhadap produksi | Kehilangan data | Role check, confirmation, audit field, backup Spreadsheet |

## 9. Kriteria Penerimaan

Implementasi dinyatakan selesai jika:

1. Satu source frontend menghasilkan artifact Cloudflare dan GAS.
2. `npm run build:pages` menghasilkan aplikasi tanpa template tag atau dependency `google.script.run` langsung pada fitur.
3. `npm run build:gas && clasp push` dapat memperbarui GAS Web App.
4. Kedua deployment membaca master gaji dan arsip dari Spreadsheet yang sama.
5. Create/delete dari satu deployment terlihat pada deployment lain setelah refresh.
6. Tidak ada password atau secret di browser bundle, repository, atau log.
7. Cloudflare browser hanya berkomunikasi dengan same-origin `/api/*`.
8. UI tidak menampilkan sukses bila Spreadsheet gagal menyimpan data.
9. Semua fitur utama lama tetap berjalan pada A4 dan Legal.
10. Unit test, build test, integration test, dan smoke test lulus.

## 10. Strategi Rollback

- Pertahankan deployment GAS produksi lama selama preview dan acceptance test.
- Gunakan deployment GAS baru dan Spreadsheet salinan untuk Cloudflare Preview.
- Jangan menghapus deployment lama sampai kedua target stabil.
- Jika Cloudflare gagal, rollback melalui deployment sebelumnya di dashboard Cloudflare.
- Jika GAS baru gagal, arahkan kembali ke deployment GAS lama tanpa memodifikasi data.
- Backup Spreadsheet dilakukan sebelum migrasi password atau schema.
