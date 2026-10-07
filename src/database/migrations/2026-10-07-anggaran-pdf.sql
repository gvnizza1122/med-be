-- Jalankan sebagai pemilik tabel lama; tidak memperluas hak akun aplikasi.
BEGIN;
ALTER TABLE claim_files ADD COLUMN IF NOT EXISTS ai_anggaran_id TEXT;
ALTER TABLE catatan_panggilan_model ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
COMMIT;
-- Tabel anggaran/cache dibuat idempotent oleh anggaranAiService memakai akun aplikasi.
