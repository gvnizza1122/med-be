-- Preserve legacy references; they require explicit source/result verification.
ALTER TABLE ai_training_examples
  ADD COLUMN IF NOT EXISTS source_pending_id TEXT,
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN IF NOT EXISTS source_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_text TEXT,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verified_by TEXT,
  ADD COLUMN IF NOT EXISTS jenis_klaim TEXT,
  ADD COLUMN IF NOT EXISTS sep TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_source_version
  ON ai_training_examples(source_pending_id, source_kind, source_hash);
CREATE INDEX IF NOT EXISTS idx_rag_verified_kind
  ON ai_training_examples(verification_status, jenis_klaim, created_at DESC);
ALTER TABLE error_knowledge_base
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_by TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE bpjs_pending_responses
  ADD COLUMN IF NOT EXISTS outcome_verified_by TEXT,
  ADD COLUMN IF NOT EXISTS outcome_verified_at TIMESTAMP;
