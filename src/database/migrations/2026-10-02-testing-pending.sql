-- Penilaian testing terpisah; tidak mengubah status/kode klaim.
BEGIN;
CREATE TABLE IF NOT EXISTS testing_pending (
  record_id TEXT PRIMARY KEY REFERENCES claim_records(id) ON DELETE CASCADE,
  hospital_code TEXT NOT NULL,
  prediction TEXT NOT NULL,
  prediction_snapshot JSONB NOT NULL,
  actual_result TEXT NOT NULL CHECK(actual_result IN ('pending','diterima','belum_diketahui')),
  reference_source TEXT NOT NULL CHECK(reference_source IN ('BPJS','VERIFIKATOR')),
  actual_reason TEXT NOT NULL DEFAULT '',
  reason_match TEXT NOT NULL CHECK(reason_match IN ('sesuai','sebagian','tidak_sesuai','belum_dinilai')),
  notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id),
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_testing_pending_rs ON testing_pending(hospital_code);
COMMIT;
