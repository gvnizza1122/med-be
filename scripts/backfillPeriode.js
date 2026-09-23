#!/usr/bin/env node
/**
 * Isi kolom periode & sumber_periode untuk klaim yang sudah terlanjur tersimpan.
 *
 * Sekali jalan. Tidak butuh OCR dan tidak memanggil AI: periode dibaca dari
 * digit ke-9..12 nomor SEP yang sudah ada di basis data, dengan cadangan
 * tanggal masuk lalu tanggal unggah.
 *
 * Pakai:
 *   node scripts/backfillPeriode.js            # dry-run, cuma menampilkan rencana
 *   node scripts/backfillPeriode.js --tulis    # benar-benar menulis
 *
 * Hanya menyentuh baris yang periode-nya MASIH KOSONG, jadi aman diulang dan
 * tidak akan menimpa periode yang sudah diperbaiki manual.
 */

const { getDb, closeDb } = require('../src/database/init');
const { tentukanPeriode, labelPeriode, simpanPeriode } = require('../src/services/periodeKlaimService');

const tulis = process.argv.includes('--tulis');

async function main() {
  const db = getDb();

  const rows = await db.prepare(
    'SELECT id, sep, admission_date, created_at FROM claim_records WHERE periode IS NULL'
  ).all();

  console.log(`Baris tanpa periode: ${rows.length}`);
  if (rows.length === 0) {
    console.log('Tidak ada yang perlu diisi.');
    return;
  }

  // Hitung dulu tanpa menulis, supaya hasilnya bisa diperiksa sebelum dieksekusi.
  const perPeriode = new Map();
  const perSumber = { sep: 0, tgl_masuk: 0, tgl_upload: 0, gagal: 0 };
  const contohGagal = [];

  for (const row of rows) {
    const { periode, sumber } = tentukanPeriode({
      sep: row.sep, admissionDate: row.admission_date, createdAt: row.created_at,
    });
    if (!periode) {
      perSumber.gagal++;
      if (contohGagal.length < 5) contohGagal.push(row);
      continue;
    }
    perSumber[sumber]++;
    const k = `${periode}|${sumber}`;
    perPeriode.set(k, (perPeriode.get(k) || 0) + 1);
  }

  console.log('');
  console.log('Sebaran per periode:');
  for (const k of [...perPeriode.keys()].sort()) {
    const [periode, sumber] = k.split('|');
    console.log(`  ${labelPeriode(periode).padEnd(18)} ${String(perPeriode.get(k)).padStart(5)} klaim   (sumber: ${sumber})`);
  }

  console.log('');
  console.log('Sebaran per sumber:');
  console.log(`  dari nomor SEP   : ${perSumber.sep}`);
  console.log(`  dari tgl masuk   : ${perSumber.tgl_masuk}`);
  console.log(`  dari tgl unggah  : ${perSumber.tgl_upload}   <- tebakan, perlu ditandai di layar`);
  console.log(`  tidak bisa       : ${perSumber.gagal}`);

  if (contohGagal.length) {
    console.log('');
    console.log('Contoh baris yang tidak bisa ditentukan:');
    for (const r of contohGagal) {
      console.log(`  id=${r.id} sep=${JSON.stringify(r.sep)} masuk=${JSON.stringify(r.admission_date)} unggah=${JSON.stringify(r.created_at)}`);
    }
  }

  if (!tulis) {
    console.log('');
    console.log('DRY-RUN — belum ada yang ditulis. Jalankan ulang dengan --tulis untuk mengeksekusi.');
    return;
  }

  console.log('');
  console.log('Menulis...');
  const hasil = await simpanPeriode(db, rows);
  console.log(`Selesai. Terisi: ${hasil.sep + hasil.tgl_masuk + hasil.tgl_upload}, dilewati: ${hasil.gagal}`);
}

main()
  .catch(err => { console.error('GAGAL:', err.message); process.exitCode = 1; })
  .finally(() => { try { closeDb(); } catch (e) { /* koneksi mungkin sudah tertutup */ } });
