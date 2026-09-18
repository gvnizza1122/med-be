-- Kamus ICD-9-CM Volume 3 (kode PROSEDUR/tindakan, format numerik mis.
-- "38.93", "96.04") -- 18 Sep 2026, pasangan icd10_who_codes (lihat
-- 004-icd10-who-codes.sql) tapi untuk suggested_codes bertipe "procedure"
-- (PROCLIST), yang sebelumnya SELALU dapat kamus_valid:null karena belum ada
-- kamus untuk dicek. Sumber: Kemenkes SATUSEHAT Platform, label versi
-- eksplisit "ICD9CM_2010" (cocok PMK 3/2023 "ICD-9-CM Versi Tahun 2010").
-- Diisi oleh scripts/seedIcd9CmProcedures.js dari
-- src/data/icd9cm_procedures.json -- lihat file itu (blok "meta") utk detail
-- sumber & caveat. BUKAN ICD-10-PCS, BUKAN CPT.
--
-- Mirror dari src/database/init.js (auto-init untuk deployment tanpa migration
-- runner) -- lihat komentar di sana.
CREATE TABLE IF NOT EXISTS icd9_cm_procedures (
  code TEXT PRIMARY KEY,              -- format numerik ICD-9-CM Vol.3, mis. "38.93", atau kategori 2-digit mis. "00"
  description_en TEXT,
  block TEXT,                         -- kelompok blok deskriptif (BUKAN bagian resmi kode), mis. "Operations on the Cardiovascular System" -- boleh NULL kalau tidak masuk blok baku manapun
  source TEXT NOT NULL,               -- asal data kode ini (audit trail) -- lihat scripts/seedIcd9CmProcedures.js
  imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_icd9_cm_block ON icd9_cm_procedures(block);
