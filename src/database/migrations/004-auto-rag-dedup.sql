-- Migration: Add fingerprint & SEP columns to ai_training_examples untuk dedup + RAG linking
-- Purpose: Enable auto-dedup dan pairing klaim ↔ pending via SEP untuk rich RAG training

ALTER TABLE ai_training_examples
ADD COLUMN IF NOT EXISTS fingerprint TEXT,
ADD COLUMN IF NOT EXISTS sep TEXT,
ADD COLUMN IF NOT EXISTS jenis_klaim TEXT,
ADD COLUMN IF NOT EXISTS ctime TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create unique index pada fingerprint untuk fast dedup check
-- NULL values di fingerprint diizinkan (legacy records), tapi akan di-skip oleh dedup logic
CREATE INDEX IF NOT EXISTS idx_ai_training_fingerprint ON ai_training_examples(fingerprint)
WHERE fingerprint IS NOT NULL;

-- Index untuk fast lookup by SEP (pairing klaim ↔ pending)
CREATE INDEX IF NOT EXISTS idx_ai_training_sep ON ai_training_examples(sep)
WHERE sep IS NOT NULL;

-- Index untuk tracking by jenis_klaim (filter RAG by category)
CREATE INDEX IF NOT EXISTS idx_ai_training_jenis_klaim ON ai_training_examples(jenis_klaim);
