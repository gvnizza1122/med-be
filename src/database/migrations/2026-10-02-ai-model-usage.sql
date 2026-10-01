-- Jalankan sebagai pemilik tabel / akun migrasi, bukan akun aplikasi DML.
-- Tidak mengubah klaim, isi audit lama, atau hak akses akun aplikasi.
BEGIN;
ALTER TABLE catatan_panggilan_model
  ADD COLUMN IF NOT EXISTS effort VARCHAR(12),
  ADD COLUMN IF NOT EXISTS jenis_klaim VARCHAR(20),
  ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cached_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS estimasi_usd DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS estimasi_idr DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS kurs_usd_idr DOUBLE PRECISION;
COMMIT;
