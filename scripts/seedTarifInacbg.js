#!/usr/bin/env node
/**
 * Seed tabel tarif_inacbg_pmk3_2023 dari
 * src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json.
 *
 * Latar belakang: TARIF_INACBG/TOTAL_TARIF diklasifikasikan 'turunan' di
 * fieldTypeRegistry.js -- artinya field itu SEHARUSNYA dihitung/di-lookup
 * dari kode INACBG, bukan dipercaya apa adanya dari OCR/AI. Tabel ini adalah
 * kamus tarif resmi (PMK No. 3 Tahun 2023) yang dipakai untuk itu, dan oleh
 * rule RV-21 (lihat src/services/ruleEngine.js) untuk memvalidasi
 * TARIF_INACBG klaim terhadap tarif resmi.
 *
 * CAKUPAN: HANYA irisan Regional 1 x Kelas D Swasta (satu-satunya kombinasi
 * yang relevan untuk RS Lestari Raharja, Kode Provider 0170) -- regional/
 * kelas RS lain SENGAJA tidak diekstrak/di-seed di sini.
 *
 * SUMBER DATA & METODE EKSTRAKSI: lihat field "meta" di
 * src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json (metode ekstraksi,
 * cross-check kode K-4-17-I, verifikasi visual, dan catatan cakupan).
 *
 * PENTING: script ini hanya DISIAPKAN, belum pernah dijalankan ke database
 * manapun. Jalankan manual setelah data ini direview:
 *   cd ~/eclaim/be && node scripts/seedTarifInacbg.js
 *
 * Idempoten -- aman dijalankan ulang (ON CONFLICT DO UPDATE), termasuk untuk
 * re-seed setelah file data diperbarui.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../src/database/init');

const DATA_PATH = path.join(__dirname, '..', 'src', 'data', 'tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json');
const BATCH_SIZE = 500; // baris per statement INSERT multi-value

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`File data tidak ditemukan: ${DATA_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const meta = raw.meta || {};
  const rows = Array.isArray(raw.tarif) ? raw.tarif : [];

  if (rows.length === 0) {
    console.error('src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json tidak berisi baris tarif apapun. Berhenti.');
    process.exit(1);
  }

  console.log(`Memuat ${rows.length} baris tarif dari ${DATA_PATH}`);
  console.log(`Sumber: ${meta.source_name || '(tidak tercatat di meta)'}`);
  console.log(`Cakupan: Regional ${meta.regional || '?'} x ${meta.tipe_rs_label || meta.tipe_rs || '?'}, halaman ${meta.source_pages || '?'}`);
  if (meta.flagged_for_manual_review_count) {
    console.log(`PERINGATAN -- ${meta.flagged_for_manual_review_count} baris ditandai perlu verifikasi manual (perlu_verifikasi_manual=true). Cek dulu sebelum dipakai untuk validasi produksi.`);
  }

  const db = getDb();
  await db.initialize(); // pastikan CREATE TABLE IF NOT EXISTS tarif_inacbg_pmk3_2023 sudah jalan

  let processed = 0;
  let skipped = 0;

  await db.transaction(async (client) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows
        .slice(i, i + BATCH_SIZE)
        .filter(entry => String(entry.kode_inacbg || '').trim());
      skipped += Math.min(BATCH_SIZE, rows.length - i) - batch.length;
      if (batch.length === 0) continue;

      // convertSql() di database/init.js mengganti tiap "?" jadi $1,$2,...
      // berurutan sesuai urutan kemunculan di string SQL -- cukup sediakan
      // placeholder "?" polos per kolom, tidak perlu dihitung manual.
      const values = [];
      const rowPlaceholders = batch.map(entry => {
        values.push(
          String(entry.kode_inacbg).trim().toUpperCase(),
          entry.deskripsi || null,
          entry.tarif_kelas_3 ?? null,
          entry.tarif_kelas_2 ?? null,
          entry.tarif_kelas_1 ?? null,
          entry.regional || '1',
          entry.tipe_rs || 'D_SWASTA',
          entry.jenis_layanan || null,
          entry.sumber_halaman ?? null,
          !!entry.perlu_verifikasi_manual,
          entry.catatan_verifikasi || null,
        );
        return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)';
      }).join(',\n        ');

      await client.query(`
        INSERT INTO tarif_inacbg_pmk3_2023 (
          kode_inacbg, deskripsi, tarif_kelas_3, tarif_kelas_2, tarif_kelas_1,
          regional, tipe_rs, jenis_layanan, sumber_halaman,
          perlu_verifikasi_manual, catatan_verifikasi, imported_at
        )
        VALUES
        ${rowPlaceholders}
        ON CONFLICT (kode_inacbg) DO UPDATE SET
          deskripsi = EXCLUDED.deskripsi,
          tarif_kelas_3 = EXCLUDED.tarif_kelas_3,
          tarif_kelas_2 = EXCLUDED.tarif_kelas_2,
          tarif_kelas_1 = EXCLUDED.tarif_kelas_1,
          regional = EXCLUDED.regional,
          tipe_rs = EXCLUDED.tipe_rs,
          jenis_layanan = EXCLUDED.jenis_layanan,
          sumber_halaman = EXCLUDED.sumber_halaman,
          perlu_verifikasi_manual = EXCLUDED.perlu_verifikasi_manual,
          catatan_verifikasi = EXCLUDED.catatan_verifikasi,
          imported_at = CURRENT_TIMESTAMP
      `, values);

      processed += batch.length;
      if ((i / BATCH_SIZE) % 5 === 0) {
        console.log(`  ... ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
      }
    }
  });

  console.log(`\nSelesai. Baris diproses: ${processed}, dilewati (kode kosong): ${skipped}.`);

  const countRes = await db.get('SELECT COUNT(*) as count FROM tarif_inacbg_pmk3_2023');
  console.log(`Total baris di tabel tarif_inacbg_pmk3_2023 sekarang: ${countRes.count}`);

  // Cross-check pasca-seed: K-4-17-I harus Rp1.264.200 (Kelas 3) -- sesuai
  // nilai yang sudah diverifikasi manual dari klaim riil (lihat meta di
  // file data). Kalau ini gagal, JANGAN percaya tabel ini untuk validasi.
  const check = await db.get(`SELECT tarif_kelas_3 FROM tarif_inacbg_pmk3_2023 WHERE kode_inacbg = 'K-4-17-I'`);
  if (check && Number(check.tarif_kelas_3) === 1264200) {
    console.log('Cross-check K-4-17-I: OK (Rp1.264.200 Kelas 3, cocok dengan nilai terverifikasi).');
  } else {
    console.error(`Cross-check K-4-17-I: GAGAL -- nilai di DB = ${check ? check.tarif_kelas_3 : '(tidak ditemukan)'}, seharusnya 1264200. Data JANGAN dipakai sampai ditelusuri ulang.`);
  }

  closeDb();
}

main().catch(err => {
  console.error('Seed gagal total:', err);
  process.exit(1);
});
