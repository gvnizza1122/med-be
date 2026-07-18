-- AI Audit Log: tracking saran AI per-field + feedback perawat (Phase 1)
-- Catatan: claim_files.id & claim_records.id bertipe TEXT (bukan UUID), FK mengikuti.
CREATE TABLE IF NOT EXISTS ai_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id TEXT REFERENCES claim_files(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES claim_records(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,

  -- Hasil AI
  ai_suggestion TEXT,                       -- NULL jika AI menilai field valid
  confidence DOUBLE PRECISION,              -- 0.0 - 1.0
  reasoning TEXT,
  style TEXT NOT NULL DEFAULT 'ponytail' CHECK (style IN ('ponytail', 'caveman', 'neutral')),

  -- Feedback perawat
  nurse_action TEXT CHECK (nurse_action IN ('accepted', 'rejected', 'unsure')),
  was_correct BOOLEAN,                      -- accepted=true, rejected=false, unsure=NULL

  -- Cost tracking
  tokens_input INT DEFAULT 0,
  tokens_output INT DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_record ON ai_audit_log(record_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_file ON ai_audit_log(file_id);
-- Untuk analitik "style mana yang paling sering di-accept"
CREATE INDEX IF NOT EXISTS idx_ai_audit_style_action ON ai_audit_log(style, nurse_action);
