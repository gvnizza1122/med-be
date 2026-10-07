/** Pembanding lokal. Kode/tarif ekspor hanya dibaca SETELAH perhitungan aplikasi. */
'use strict';
const fs = require('fs');
const { parseClaimFile } = require('../../src/services/fileParser');
const { hitungInacbgDanTarif } = require('../../src/services/aiReviewService');
const { tarifResmi, META } = require('../../src/services/inacbgGrouperResmi');
const { susunTarifGanda } = require('../../src/services/tarifGandaService');
const daftar = v => String(v || '').split(/[;#]/).map(k => k.trim()).filter(k => k && k !== '-');

function uji(filePath) {
  const parsed = parseClaimFile(filePath);
  const hasil = [];
  for (const r of parsed.records) {
    // PTD adalah masukan jenis layanan, bukan kesimpulan dari kode grouper ekspor.
    const jenis = r.ptd === 1 ? 'RAWAT_INAP' : r.ptd === 2 ? 'RAWAT_JALAN' : r.jenis_klaim;
    const masukan = { dx: daftar(r.diagnosa_list), px: daftar(r.prosedur_list), jenis, kelas: r.kelas_rawat };
    let h;
    try {
      if (!jenis) throw Error('Jenis layanan tidak diketahui');
      h = hitungInacbgDanTarif(masukan.dx, masukan.px, jenis, masukan.kelas, null);
    } catch (e) {
      hasil.push({ baris: r._rowNumber, error: e.message });
      continue;
    }
    const kode = h.inacbgResult?.code ?? null;
    const tarif = h.tarifResult?.amount ?? null;
    const idrg = susunTarifGanda({ ...r, jenis_klaim: jenis, raw_data: r._rawData }, {}).idrg;
    hasil.push({ baris: r._rowNumber, masukan,
      pembanding: { kode: r.inacbg_code, tarif: r.tarif_inacbg },
      aplikasi: { kode, tarif }, kode_cocok: kode === r.inacbg_code, tarif_cocok: tarif === r.tarif_inacbg,
      tarif_tabel_pembanding_cocok: tarifResmi(r.inacbg_code, r.kelas_rawat, jenis).tarif === r.tarif_inacbg,
      perlu_verifikasi: !!h.tarifResult?.perlu_verifikasi_grouper,
      alasan: h.inacbgResult?.reasoning ?? null, kandidat: h.inacbgResult?.kandidat_base ?? [],
      idrg: { hasil_ekspor_terbaca: idrg.sumber === 'data_klaim', rumus_cocok: idrg.verifikasi_rumus ?? null },
    });
  }
  return {
    tujuan: 'Uji regresi masukan kode. Kecocokan tidak membuktikan kesetaraan mesin grouper atau kebenaran diagnosis/prosedur klinis.',
    batasan: 'iDRG hanya dibaca dari ekspor dan rumus tarif diperiksa; kode iDRG tidak dihitung mandiri. Seluruh pengujian lokal tanpa mengirim data pasien atau memanggil AI. Identitas pasien tidak disertakan.',
    profil_tabel: META.profil,
    ringkasan: { total: hasil.length, rawat_jalan: hasil.filter(r => r.masukan?.jenis === 'RAWAT_JALAN').length,
      rawat_inap: hasil.filter(r => r.masukan?.jenis === 'RAWAT_INAP').length,
      error_parser: parsed.errors.length, dilewati: parsed.metadata.skippedRows,
      error_perhitungan: hasil.filter(r => r.error).length,
      tanpa_kelompok: hasil.filter(r => !r.error && !r.aplikasi.kode).length,
      kode_cocok: hasil.filter(r => r.kode_cocok).length, tarif_cocok: hasil.filter(r => r.tarif_cocok).length,
      tarif_tabel_pembanding_cocok: hasil.filter(r => r.tarif_tabel_pembanding_cocok).length,
      perlu_verifikasi: hasil.filter(r => r.perlu_verifikasi).length,
      idrg_ekspor_terbaca: hasil.filter(r => r.idrg?.hasil_ekspor_terbaca).length,
      idrg_rumus_tarif_cocok: hasil.filter(r => r.idrg?.rumus_cocok).length },
    perbedaan: hasil.filter(r => !r.kode_cocok || !r.tarif_cocok), hasil,
  };
}
if (require.main === module) {
  if (!process.argv[2]) throw Error('Berikan lokasi TXT untuk pengujian');
  global.fetch = () => { throw Error('Uji lokal: akses jaringan dinonaktifkan'); };
  const report = uji(process.argv[2]);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report.ringkasan, null, 2) + '\n');
  if (report.ringkasan.error_parser || report.ringkasan.dilewati || report.ringkasan.error_perhitungan) process.exitCode = 1;
}
module.exports = { uji };
