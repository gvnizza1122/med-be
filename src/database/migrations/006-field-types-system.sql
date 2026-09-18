-- Field Types System Migration (6 field types: Salin, Turunan, Konfigurasi, Koding, Fakta_nol, Wajar_kosong)
-- Adds 7 new columns to claim_records table for tracking field sources, suggestions, and approvals
-- Backward compatible: all columns are nullable initially

-- Add new columns to claim_records table
ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS jenis_field VARCHAR(50)
  CHECK (jenis_field IN ('Salin', 'Turunan', 'Konfigurasi', 'Koding', 'Fakta_nol', 'Wajar_kosong'));

ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS dokumen_sumber VARCHAR(100)
  CHECK (dokumen_sumber IN ('resume_medis', 'sep', 'grouper', 'triage', 'resep'));

ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS halaman_sumber INT;

ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS kutipan TEXT;

ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS status_usulan VARCHAR(50)
  CHECK (status_usulan IN ('usulan', 'disetujui', 'ditolak'));

ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS disetujui_oleh TEXT
  REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE claim_records ADD COLUMN IF NOT EXISTS disetujui_pada TIMESTAMP;

-- Constraint: If jenis_field='Koding', kutipan must NOT be NULL
-- PostgreSQL CHECK constraint for this validation
ALTER TABLE claim_records ADD CONSTRAINT IF NOT EXISTS ck_koding_requires_kutipan
  CHECK (NOT (jenis_field = 'Koding' AND kutipan IS NULL));

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_claim_records_jenis_field ON claim_records(jenis_field);
CREATE INDEX IF NOT EXISTS idx_claim_records_dokumen_sumber ON claim_records(dokumen_sumber);
CREATE INDEX IF NOT EXISTS idx_claim_records_status_usulan ON claim_records(status_usulan);
CREATE INDEX IF NOT EXISTS idx_claim_records_disetujui_oleh ON claim_records(disetujui_oleh);
CREATE INDEX IF NOT EXISTS idx_claim_records_jenis_field_status ON claim_records(jenis_field, status_usulan);
