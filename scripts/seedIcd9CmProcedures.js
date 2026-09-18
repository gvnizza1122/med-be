#!/usr/bin/env node
/**
 * Seed tabel icd9_cm_procedures dari src/data/icd9cm_procedures.json.
 *
 * Latar belakang: pasangan dari scripts/seedIcd10WhoDictionary.js (18 Sep
 * 2026), tapi untuk suggested_codes bertipe "procedure" (PROCLIST, format
 * ICD-9-CM Volume 3 numerik mis. "38.93", "96.04") -- yang sebelumnya SELALU
 * dapat kamus_valid:null di aiReviewService.js karena belum ada kamus untuk
 * dicek. BUKAN ICD-10-PCS, BUKAN CPT.
 *
 * SUMBER DATA (lihat src/data/icd9cm_procedures.json -> meta untuk detail
 * lengkap): Kemenkes SATUSEHAT Platform
 * (https://satusehat.kemkes.go.id/platform/docs/id/terminology/icd/icd-9-cm/),
 * yang menyatakan eksplisit "SATUSEHAT Platform (SSP) menggunakan ICD-9 CM
 * versi 2010" -- SESUAI PMK 3/2023 lampiran ("ICD-9-CM Versi Tahun 2010").
 * Diunduh dari spreadsheet resmi yang ditautkan di halaman itu. 4.626 kode.
 * Dicek silang terhadap K5_WHITELIST_CODES di
 * src/services/kegawatdaruratanReference.js (komentar di file itu bilang
 * "diverifikasi terhadap referensi resmi") -- 38.93, 96.04, 99.60, 99.62,
 * 99.63 SEMUA cocok deskripsinya (lihat meta.cross_check_note). PENTING:
 * label versi "ICD9CM_2010" sama seperti kamus ICD-10 pasangannya --
 * BELUM TENTU snapshot beku 2010 persis, kemungkinan basis 2010 yang terus
 * dipatch Kemenkes (lihat meta.same_2010_label_caveat_as_icd10). Tetap
 * rekomendasi: spot-check oleh koder medis bersertifikat sebelum dipakai
 * sebagai dasar mengaktifkan kembali tombol "Terapkan".
 *
 * PENTING: script ini hanya DISIAPKAN, belum pernah dijalankan ke database
 * manapun. Jalankan manual setelah kamus ini direview:
 *   cd ~/eclaim/be && node scripts/seedIcd9CmProcedures.js
 *
 * Idempoten -- aman dijalankan ulang (ON CONFLICT DO UPDATE), termasuk untuk
 * re-seed setelah src/data/icd9cm_procedures.json diperbarui/diperkaya.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../src/database/init');

const DATA_PATH = path.join(__dirname, '..', 'src', 'data', 'icd9cm_procedures.json');
const BATCH_SIZE = 500; // baris per statement INSERT multi-value

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`File data tidak ditemukan: ${DATA_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const meta = raw.meta || {};
  const codes = Array.isArray(raw.codes) ? raw.codes : [];

  if (codes.length === 0) {
    console.error('src/data/icd9cm_procedures.json tidak berisi kode apapun (codes kosong). Berhenti.');
    process.exit(1);
  }

  const sourceLabel = [meta.source_name, meta.source_page_url].filter(Boolean).join(' - ')
    || 'src/data/icd9cm_procedures.json (sumber tidak tercatat di meta)';

  console.log(`Memuat ${codes.length} kode dari ${DATA_PATH}`);
  console.log(`Sumber (kolom "source" per baris): ${sourceLabel}`);
  if (meta.same_2010_label_caveat_as_icd10) {
    console.log(`Catatan versi: ${meta.same_2010_label_caveat_as_icd10}`);
  }

  const db = getDb();
  await db.initialize(); // pastikan CREATE TABLE IF NOT EXISTS icd9_cm_procedures sudah jalan

  let inserted = 0;
  let failed = 0;

  await db.transaction(async (client) => {
    for (let i = 0; i < codes.length; i += BATCH_SIZE) {
      const batch = codes
        .slice(i, i + BATCH_SIZE)
        .filter(entry => String(entry.code || '').trim());
      failed += Math.min(BATCH_SIZE, codes.length - i) - batch.length;
      if (batch.length === 0) continue;

      // convertSql() di database/init.js mengganti tiap "?" jadi $1,$2,...
      // berurutan sesuai urutan kemunculan di string SQL -- jadi cukup
      // sediakan placeholder "?" polos per kolom, tidak perlu dihitung manual.
      const values = [];
      const rowPlaceholders = batch.map(entry => {
        values.push(
          String(entry.code).trim(),
          entry.description_en || null,
          entry.block || null,
          sourceLabel,
        );
        return '(?, ?, ?, ?, CURRENT_TIMESTAMP)';
      }).join(',\n        ');

      await client.query(`
        INSERT INTO icd9_cm_procedures (code, description_en, block, source, imported_at)
        VALUES
        ${rowPlaceholders}
        ON CONFLICT (code) DO UPDATE SET
          description_en = EXCLUDED.description_en,
          block = EXCLUDED.block,
          source = EXCLUDED.source,
          imported_at = CURRENT_TIMESTAMP
      `, values);

      inserted += batch.length;
      if ((i / BATCH_SIZE) % 5 === 0) {
        console.log(`  ... ${Math.min(i + BATCH_SIZE, codes.length)}/${codes.length}`);
      }
    }
  });

  console.log(`\nSelesai. Baris diproses: ${inserted}, dilewati (kode kosong): ${failed}.`);

  const countRes = await db.get('SELECT COUNT(*) as count FROM icd9_cm_procedures');
  console.log(`Total baris di tabel icd9_cm_procedures sekarang: ${countRes.count}`);

  closeDb();
}

main().catch(err => {
  console.error('Seed gagal total:', err);
  process.exit(1);
});
