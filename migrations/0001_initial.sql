-- Migration 0001: initial schema SIPSID-KGB (Cloudflare D1 / SQLite).
--
-- Sumber: MIGRATION_PLAN.md Lampiran A. Setiap CHECK diverifikasi di SQLite (node:sqlite 3.53)
-- dan D1 lokal (wrangler d1 migrations apply --local); lihat tests/d1-schema.test.mjs.
--
-- Deviasi dari draft awal Lampiran A: `users.id` memakai `INTEGER PRIMARY KEY AUTOINCREMENT`
-- (Lampiran A sudah diperbarui). Tanpa AUTOINCREMENT, SQLite memakai MAX(rowid)+1 sehingga id user
-- tertinggi yang dihapus dapat dipakai ulang oleh user baru; AUTOINCREMENT mencatat id tertinggi di
-- `sqlite_sequence` sehingga id tidak pernah dipakai ulang (sesi/audit lama tidak dapat menunjuk
-- akun lain). Selain itu DDL identik secara semantik dengan draft. Catatan verifikasi:
--   * `date(x) IS x` menolak tanggal non-kalender (2024-02-30 dinormalisasi menjadi 2024-03-01,
--     sehingga tidak sama) dan format non-ISO (date() mengembalikan NULL).
--   * `[^...]` pada GLOB adalah negasi kelas karakter di SQLite; `-` di akhir kelas adalah literal.
--   * Kolom PRIMARY KEY non-INTEGER pada tabel STRICT otomatis NOT NULL.
--   * `kabkot` kosong ditolak oleh CHECK length >= 1, sehingga nilai kosong wajib disimpan NULL.
--   * UNIQUE (username) memakai collation kolom (NOCASE), sehingga unik case-insensitive.
--
-- File ini tidak boleh berisi BEGIN/COMMIT: D1 menolak transaksi eksplisit.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
--   SELECT ... FROM letters ORDER BY seq DESC;
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
