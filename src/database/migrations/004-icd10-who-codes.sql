-- Kamus ICD-10 WHO (BUKAN ICD-10-CM Amerika) -- dibangun 17 Sep 2026, DIREVISI
-- 18 Sep 2026 (sumber diganti ke Kemenkes SATUSEHAT Platform, label versi
-- eksplisit "ICD10_2010" -- cocok PMK 3/2023 lampiran "ICD-10 Versi Tahun 2010",
-- menggantikan sumber pihak ketiga generik revisi pertama) -- supaya
-- suggested_codes di aiReviewService.js (saran kode diagnosis AI) bisa dicek
-- terhadap daftar kode resmi sebelum tombol "Terapkan" di frontend diaktifkan
-- lagi (saat ini SENGAJA dimatikan total -- bug produksi lama: AI sempat
-- menyarankan kode ICD-10-CM, bukan ICD-10 WHO yang dipakai BPJS Indonesia).
-- Diisi oleh scripts/seedIcd10WhoDictionary.js dari
-- src/data/icd10_who_dictionary.json -- lihat file itu (blok "meta") utk
-- sumber data & catatan cakupan/keterbatasan/caveat versi 2010 secara jujur.
--
-- Mirror dari src/database/init.js (auto-init untuk deployment tanpa migration
-- runner) -- lihat komentar di sana.
CREATE TABLE IF NOT EXISTS icd10_who_codes (
  code TEXT PRIMARY KEY,              -- format WHO, mis. "A00.0", atau kategori 3-char tanpa subdivisi mis. "I10"
  description_en TEXT,
  description_id TEXT,
  chapter TEXT,                       -- nama bab (Inggris), mis. "Certain infectious and parasitic diseases"
  chapter_number TEXT,                -- angka Romawi bab, mis. "I".."XXII"
  source TEXT NOT NULL,               -- asal data kode ini (audit trail) -- lihat scripts/seedIcd10WhoDictionary.js
  imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_icd10_who_chapter ON icd10_who_codes(chapter_number);
