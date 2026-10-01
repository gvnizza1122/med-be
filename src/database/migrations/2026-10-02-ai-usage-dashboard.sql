-- Jalankan sebagai pemilik tabel / akun migrasi.
BEGIN;
ALTER TABLE catatan_panggilan_model
  ADD COLUMN IF NOT EXISTS total_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS hospital_code TEXT,
  ADD COLUMN IF NOT EXISTS record_id TEXT;
CREATE INDEX IF NOT EXISTS idx_catatan_model_rs_waktu ON catatan_panggilan_model(hospital_code, waktu);
-- Token lama hanya dijumlahkan jika kedua komponen memang tersedia.
UPDATE catatan_panggilan_model SET total_tokens = prompt_tokens + completion_tokens
WHERE total_tokens IS NULL AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL;
-- Audit lama dikaitkan hanya bila data pengguna dan berkas instalasi ini
-- memiliki tepat satu rumah sakit. Instalasi multi-RS tetap meninggalkan NULL.
WITH asal AS (
  SELECT hospital_code FROM users UNION SELECT hospital_code FROM claim_files
), tunggal AS (
  SELECT MIN(hospital_code) AS kode FROM asal
  WHERE hospital_code IS NOT NULL AND hospital_code <> '' HAVING COUNT(*) = 1
)
UPDATE catatan_panggilan_model SET hospital_code = tunggal.kode FROM tunggal
WHERE hospital_code IS NULL;
COMMIT;
