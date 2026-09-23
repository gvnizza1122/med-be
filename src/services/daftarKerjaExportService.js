/**
 * Export "Daftar Kerja" — lembar kerja harian koder casemix.
 *
 * Isinya klaim yang ditandai bermasalah oleh medaudit: apa masalahnya, apa
 * buktinya, dan apa yang harus dilakukan. "Perlu dikerjakan" dan "pending
 * internal" adalah hal yang sama, jadi cukup satu berkas.
 *
 * TIDAK boleh tercampur dengan pending BPJS. Keduanya sama-sama disebut
 * "pending" padahal artinya jauh berbeda: yang ini dugaan medaudit sebelum
 * klaim dikirim dan bisa saja salah, sedangkan pending BPJS adalah keputusan
 * yang datang sekitar tiga bulan setelahnya. Kalau tercampur dalam satu
 * berkas, kalimat "ada 30 klaim pending" jadi mustahil ditafsirkan — tidak
 * jelas apakah itu 30 peringatan yang belum dikerjakan atau 30 klaim yang
 * uangnya benar-benar tertahan di BPJS.
 *
 * Dipakai exceljs, bukan SheetJS yang dipakai export lama: SheetJS 0.18.5
 * terbukti tidak menulis freeze panes sama sekali, padahal judul kolom yang
 * menetap itu syarat wajar untuk lembar kerja berisi ratusan baris.
 */

const ExcelJS = require('exceljs');
const { labelPeriode } = require('./periodeKlaimService');

// --- Jebakan Excel ---
//
// Kolom berikut WAJIB berformat teks. No Kartu BPJS adalah 13 digit angka
// berawalan tiga nol (0003604746071); kalau Excel menebaknya sebagai angka,
// nol di depan dihapus dan nomornya berubah jadi 3604746071. Nomor kartu yang
// salah membuat pencocokan dengan rekap pending BPJS gagal total — dan
// kegagalan itu senyap, tidak memunculkan pesan galat apa pun.
const FORMAT_TEKS = '@';
const FORMAT_ANGKA = '#,##0';
const FORMAT_TANGGAL = 'dd/mm/yyyy';

/** Ubah ke objek Date supaya kolomnya bisa diurutkan menurut waktu di Excel. */
function keTanggal(nilai) {
  if (!nilai) return null;
  if (nilai instanceof Date) return isNaN(nilai) ? null : nilai;
  const teks = String(nilai).trim();
  const dmy = teks.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const d = new Date(teks);
  return isNaN(d) ? null : d;
}

/**
 * Tarif disimpan sebagai angka murni tanpa "Rp" supaya bisa dijumlah di Excel.
 *
 * Penulisan Indonesia dipakai apa adanya: titik memisahkan ribuan dan koma
 * memisahkan desimal — kebalikan dari penulisan Inggris. Tanpa ini,
 * "Rp 1.264.200" berubah jadi kosong, dan kolom tarif yang seharusnya bisa
 * dijumlah malah berlubang.
 */
function keAngka(nilai) {
  if (nilai === null || nilai === undefined || nilai === '') return null;
  if (typeof nilai === 'number') return Number.isFinite(nilai) ? nilai : null;

  let teks = String(nilai).replace(/[^\d.,-]/g, '');
  if (teks === '') return null;

  if (teks.includes(',')) {
    // Ada koma: koma itu desimal, jadi titik pasti pemisah ribuan.
    teks = teks.replace(/\./g, '').replace(',', '.');
  } else {
    // Tanpa koma, titik dianggap pemisah ribuan hanya kalau polanya memang
    // berkelompok tiga ("1.264.200"). Angka seperti "1264.5" dibiarkan utuh.
    if (/^-?\d{1,3}(\.\d{3})+$/.test(teks)) teks = teks.replace(/\./g, '');
  }

  const n = Number(teks);
  return Number.isFinite(n) ? n : null;
}

const LABEL_KATEGORI = { RAWAT_JALAN: 'Rawat Jalan', RAWAT_INAP: 'Rawat Inap' };
const LABEL_TINGKAT = {
  critical: 'Wajib revisi',
  major: 'Wajib revisi',
  minor: 'Sebaiknya diperbaiki',
};

const KOLOM_DAFTAR = [
  { judul: 'SEP', kunci: 'sep', lebar: 22, format: FORMAT_TEKS },
  { judul: 'Nama Pasien', kunci: 'nama', lebar: 26 },
  { judul: 'No RM', kunci: 'mrn', lebar: 12, format: FORMAT_TEKS },
  { judul: 'No Kartu', kunci: 'nokartu', lebar: 18, format: FORMAT_TEKS },
  { judul: 'Kategori', kunci: 'kategori', lebar: 13 },
  { judul: 'Periode', kunci: 'periode', lebar: 10, format: FORMAT_TEKS },
  { judul: 'Tgl Masuk', kunci: 'tgl_masuk', lebar: 12, format: FORMAT_TANGGAL },
  { judul: 'Tgl Keluar', kunci: 'tgl_keluar', lebar: 12, format: FORMAT_TANGGAL },
  { judul: 'Diagnosis', kunci: 'diagnosis', lebar: 24, format: FORMAT_TEKS },
  { judul: 'Prosedur', kunci: 'prosedur', lebar: 20, format: FORMAT_TEKS },
  { judul: 'Kode INA-CBG', kunci: 'inacbg', lebar: 14, format: FORMAT_TEKS },
  { judul: 'Tarif', kunci: 'tarif', lebar: 14, format: FORMAT_ANGKA },
  { judul: 'Jml Masalah', kunci: 'jml_masalah', lebar: 12 },
  { judul: 'Ringkasan Masalah', kunci: 'ringkasan', lebar: 50 },
  { judul: 'DPJP', kunci: 'dpjp', lebar: 24 },
  { judul: 'Status', kunci: 'status', lebar: 16 },
];

const KOLOM_RINCIAN = [
  { judul: 'SEP', kunci: 'sep', lebar: 22, format: FORMAT_TEKS },
  { judul: 'Nama Pasien', kunci: 'nama', lebar: 26 },
  { judul: 'Kode Rule', kunci: 'rule', lebar: 12, format: FORMAT_TEKS },
  { judul: 'Jenis', kunci: 'jenis', lebar: 20 },
  { judul: 'Tingkat', kunci: 'tingkat', lebar: 20 },
  { judul: 'Masalah', kunci: 'masalah', lebar: 56 },
  { judul: 'Bukti', kunci: 'bukti', lebar: 46 },
  { judul: 'Yang Harus Dilakukan', kunci: 'tindakan', lebar: 46 },
  { judul: 'Sumber Aturan', kunci: 'sumber', lebar: 26 },
];

/**
 * Susun satu lembar data: judul kolom, lebar, format per kolom, autofilter,
 * dan judul yang menetap saat digulir.
 *
 * Sel tidak pernah digabung di lembar data — sel gabungan merusak filter dan
 * pengurutan, dan lembar ini dipakai justru untuk menyaring.
 */
function pasangLembar(ws, kolom, baris) {
  ws.columns = kolom.map(k => ({ header: k.judul, key: k.kunci, width: k.lebar || 16 }));
  ws.getRow(1).font = { bold: true };

  for (const b of baris) ws.addRow(b);

  // Format diterapkan per KOLOM, bukan per sel, supaya baris yang nanti
  // ditambahkan petugas di bawahnya ikut memakai format yang sama.
  kolom.forEach((k, i) => {
    if (k.format) ws.getColumn(i + 1).numFmt = k.format;
  });

  // Judul kolom tetap terlihat saat digulir — inilah yang tidak bisa dilakukan
  // SheetJS, dan alasan berkas ini memakai exceljs.
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  if (baris.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: kolom.length } };
  }
}

function susunDaftarKlaim(klaim) {
  return (klaim || []).map(k => {
    const errors = Array.isArray(k.errors) ? k.errors : [];
    return {
      sep: k.sep || '',
      nama: k.nama_pasien || '',
      mrn: k.mrn || '',
      nokartu: k.nokartu || '',
      kategori: LABEL_KATEGORI[k.jenis_klaim] || k.jenis_klaim || '',
      periode: k.periode || '',
      tgl_masuk: keTanggal(k.admission_date),
      tgl_keluar: keTanggal(k.discharge_date),
      diagnosis: k.diagnosa_list || '',
      prosedur: k.prosedur_list || '',
      inacbg: k.inacbg_code || '',
      tarif: keAngka(k.tarif_inacbg !== null && k.tarif_inacbg !== undefined ? k.tarif_inacbg : k.total_tarif),
      jml_masalah: errors.length,
      ringkasan: errors.map(e => e.error_message || e.rule_id || '').filter(Boolean).join('; '),
      dpjp: k.dpjp_name || '',
      status: 'Perlu dikerjakan',
    };
  });
}

/**
 * Satu baris per MASALAH, bukan per klaim. Satu klaim bisa punya beberapa
 * masalah sekaligus, dan koder perlu bisa menyaring per jenis masalah lalu
 * mengerjakannya berkelompok.
 */
function susunRincianMasalah(klaim) {
  const rincian = [];
  for (const k of klaim || []) {
    for (const e of (Array.isArray(k.errors) ? k.errors : [])) {
      rincian.push({
        sep: k.sep || '',
        nama: k.nama_pasien || '',
        rule: e.rule_id || '',
        jenis: e.field_name || '',
        tingkat: LABEL_TINGKAT[e.severity] || e.severity || '',
        masalah: e.error_message || '',
        // Tanpa kolom Bukti, koder harus membuka aplikasi lagi untuk tahu
        // kenapa klaim ditandai — dan kalau begitu, untuk apa di-export.
        bukti: e.actual_value || '',
        // Tanpa kolom ini, berkasnya cuma jadi daftar keluhan.
        tindakan: e.expected_value || '',
        sumber: e.sumber_aturan || '',
      });
    }
  }
  return rincian;
}

/**
 * @param {Array} klaim baris klaim beserta errors[]
 * @param {Object} cakupan {namaRs, periode, kategori, filter, diexportOleh}
 * @returns {Promise<Buffer>}
 */
async function buatDaftarKerja(klaim, cakupan = {}) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const daftar = susunDaftarKlaim(klaim);
  const rincian = susunRincianMasalah(klaim);

  // Lembar Ringkasan sengaja di URUTAN PERTAMA. Berkas ini akan beredar lewat
  // WhatsApp dan berganti nama beberapa kali; satu lembar ini menjawab
  // "isinya apa dan kapan dibuat" tanpa perlu bertanya ke siapa pun.
  const wsRingkas = wb.addWorksheet('Ringkasan');
  wsRingkas.columns = [{ width: 26 }, { width: 58 }];
  const isiRingkas = [
    ['Rumah Sakit', cakupan.namaRs || 'RS Lestari Raharja'],
    ['Periode', cakupan.periode ? labelPeriode(cakupan.periode) : 'Semua periode'],
    ['Kategori', cakupan.kategori ? (LABEL_KATEGORI[cakupan.kategori] || cakupan.kategori) : 'Semua kategori'],
    ['Filter saat export', cakupan.filter || 'Klaim berstatus perlu dikerjakan'],
    ['Jumlah klaim', daftar.length],
    ['Jumlah masalah', rincian.length],
    ['Tanggal export', new Date()],
    ['Di-export oleh', cakupan.diexportOleh || '-'],
    [],
    ['Catatan', 'Berkas ini berisi PENDING INTERNAL — dugaan medaudit sebelum klaim dikirim, dan bisa saja salah. Ini BUKAN pending dari BPJS. Keduanya tidak boleh dijumlahkan bersama.'],
  ];
  isiRingkas.forEach(b => wsRingkas.addRow(b));
  wsRingkas.getColumn(1).font = { bold: true };
  wsRingkas.getCell('B7').numFmt = FORMAT_TANGGAL + ' hh:mm';
  wsRingkas.getCell('B10').alignment = { wrapText: true, vertical: 'top' };
  wsRingkas.getRow(10).height = 48;

  pasangLembar(wb.addWorksheet('Daftar Klaim'), KOLOM_DAFTAR, daftar);
  pasangLembar(wb.addWorksheet('Rincian Masalah'), KOLOM_RINCIAN, rincian);

  return wb.xlsx.writeBuffer();
}

/**
 * Nama berkas menyebut cakupannya. Begitu berkas beredar di WhatsApp, namanya
 * sering jadi satu-satunya keterangan yang tersisa.
 */
function namaBerkasDaftarKerja(cakupan = {}) {
  const bagian = ['daftar-kerja'];
  if (cakupan.periode) bagian.push(cakupan.periode);
  if (cakupan.kategori) bagian.push(String(cakupan.kategori).toLowerCase().replace(/_/g, '-'));
  return bagian.join('_') + '.xlsx';
}

module.exports = {
  buatDaftarKerja,
  namaBerkasDaftarKerja,
  susunDaftarKlaim,
  susunRincianMasalah,
  keTanggal,
  keAngka,
};
