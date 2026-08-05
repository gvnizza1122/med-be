-- Basis pengetahuan error & solusi per rule — dipakai sebagai REFERENSI RINGKAS
-- (bukan riwayat percakapan) saat AI mereview record baru yang kena rule error
-- yang sama. Berbeda dari pendekatan "kirim seluruh histori" — di sini cuma
-- pola & solusi yang sudah tergeneralisasi (tanpa data pasien) yang disimpan,
-- dan cuma entri untuk rule_id yang relevan yang diikutkan ke prompt (bukan
-- seluruh basis data), supaya konteks tetap ringkas & tidak membengkak.
CREATE TABLE IF NOT EXISTS error_knowledge_base (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES validation_rules(id) ON DELETE CASCADE,
  field_name TEXT,
  pattern_summary TEXT NOT NULL,   -- pola penyebab, sudah digeneralisasi AI (tanpa data pasien)
  solution TEXT NOT NULL,          -- langkah perbaikan umum
  hit_count INTEGER DEFAULT 1,     -- berapa kali pola ini dipakai lagi sebagai referensi
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_error_kb_rule ON error_knowledge_base(rule_id);
CREATE INDEX IF NOT EXISTS idx_error_kb_rule_hits ON error_knowledge_base(rule_id, hit_count DESC, created_at DESC);
