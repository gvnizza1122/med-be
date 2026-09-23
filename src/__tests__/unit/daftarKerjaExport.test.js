const ExcelJS = require('exceljs');
const {
  buatDaftarKerja, namaBerkasDaftarKerja, susunDaftarKlaim, susunRincianMasalah, keAngka, keTanggal,
} = require('../../services/daftarKerjaExportService');

const KLAIM = [
  {
    sep: '0170R0110926V000431',
    nama_pasien: 'MAIDAH, NY',
    mrn: '176151',
    // Tiga nol di depan — inilah yang dirusak Excel kalau ditulis sebagai angka.
    nokartu: '0003604746071',
    jenis_klaim: 'RAWAT_JALAN',
    periode: '2026-09',
    admission_date: '12/09/2026',
    discharge_date: '12/09/2026',
    diagnosa_list: 'R10.4;E86',
    prosedur_list: '90.59;91.39',
    inacbg_code: 'K-4-17-I',
    tarif_inacbg: 1264200,
    dpjp_name: 'dr. Syamsul Arief Sp.PD',
    errors: [
      {
        rule_id: 'RV-20', field_name: 'Kegawatan IGD', severity: 'major',
        error_message: 'Diagnosis IGD hanya kode nyeri generik tanpa bukti kegawatan objektif',
        actual_value: '"106/74 mmHg" (hal. 10)',
        expected_value: 'Lengkapi TTV abnormal atau pemeriksaan penunjang sebelum submit',
        sumber_aturan: 'Permenkes 47/2018 Pasal 3',
      },
      {
        rule_id: 'RV-07', field_name: 'Kelas RS', severity: 'minor',
        error_message: 'Kelas RS kosong', actual_value: '', expected_value: 'Isi kelas RS',
      },
    ],
  },
  {
    sep: '0170R0110926V000432', nama_pasien: 'BUDI SANTOSO', mrn: '176152',
    nokartu: '0001234567890', jenis_klaim: 'RAWAT_INAP', periode: '2026-09',
    admission_date: '01/09/2026', discharge_date: '05/09/2026',
    diagnosa_list: 'J18.9', prosedur_list: '', inacbg_code: '', tarif_inacbg: null,
    dpjp_name: '', errors: [{ rule_id: 'RV-03', field_name: 'Prosedur', severity: 'major', error_message: 'Prosedur belum dikoding' }],
  },
];

async function bacaBalik(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe('Daftar Kerja — jebakan Excel', () => {
  let wb;
  beforeAll(async () => {
    wb = await bacaBalik(await buatDaftarKerja(KLAIM, {
      periode: '2026-09', kategori: 'RAWAT_JALAN', diexportOleh: 'koder@rslestari.id',
    }));
  });

  // Jebakan utama: No Kartu BPJS 13 digit berawalan tiga nol. Kalau Excel
  // menebaknya sebagai angka, nolnya hilang dan pencocokan dengan rekap
  // pending BPJS gagal total — tanpa pesan galat apa pun.
  test('No Kartu mempertahankan nol di depan dan berformat teks', () => {
    const ws = wb.getWorksheet('Daftar Klaim');
    const sel = ws.getCell('D2');
    expect(sel.value).toBe('0003604746071');
    expect(typeof sel.value).toBe('string');
    expect(ws.getColumn(4).numFmt).toBe('@');
  });

  test('SEP dan No RM juga berformat teks', () => {
    const ws = wb.getWorksheet('Daftar Klaim');
    expect(ws.getCell('A2').value).toBe('0170R0110926V000431');
    expect(ws.getColumn(1).numFmt).toBe('@');
    expect(ws.getColumn(3).numFmt).toBe('@');
  });

  // Kode diagnosis memuat titik dan titik koma; kalau dibiarkan ditebak,
  // Excel bisa mengubahnya jadi tanggal atau angka.
  test('kolom diagnosis & prosedur berformat teks', () => {
    const ws = wb.getWorksheet('Daftar Klaim');
    expect(ws.getCell('I2').value).toBe('R10.4;E86');
    expect(ws.getColumn(9).numFmt).toBe('@');
    expect(ws.getColumn(10).numFmt).toBe('@');
  });

  test('tarif disimpan sebagai angka murni yang bisa dijumlah', () => {
    const ws = wb.getWorksheet('Daftar Klaim');
    const sel = ws.getCell('L2');
    expect(sel.value).toBe(1264200);
    expect(typeof sel.value).toBe('number');
    expect(ws.getColumn(12).numFmt).toBe('#,##0');
  });

  test('tanggal disimpan sebagai tanggal asli, bukan teks', () => {
    const ws = wb.getWorksheet('Daftar Klaim');
    const sel = ws.getCell('G2');
    expect(sel.value instanceof Date).toBe(true);
    expect(sel.value.getFullYear()).toBe(2026);
    expect(sel.value.getMonth()).toBe(8); // September
    expect(sel.value.getDate()).toBe(12);
    expect(ws.getColumn(7).numFmt).toBe('dd/mm/yyyy');
  });

  // dd/mm vs mm/dd menentukan bulan — diuji eksplisit supaya 12/09 tidak
  // terbaca 9 Desember.
  test('tanggal dibaca hari-bulan, bukan bulan-hari ala Amerika', () => {
    const d = keTanggal('03/09/2026');
    expect(d.getMonth()).toBe(8); // September
    expect(d.getDate()).toBe(3);
  });

  test('judul kolom menetap saat digulir dan filter aktif', () => {
    for (const nama of ['Daftar Klaim', 'Rincian Masalah']) {
      const ws = wb.getWorksheet(nama);
      expect(ws.views[0].state).toBe('frozen');
      expect(ws.views[0].ySplit).toBe(1);
      expect(ws.autoFilter).toBeTruthy();
    }
  });

  test('tidak ada sel gabungan di lembar data', () => {
    for (const nama of ['Daftar Klaim', 'Rincian Masalah']) {
      const ws = wb.getWorksheet(nama);
      expect(Object.keys(ws._merges || {})).toHaveLength(0);
    }
  });
});

describe('Daftar Kerja — susunan lembar', () => {
  test('Ringkasan ada di urutan pertama', async () => {
    const wb = await bacaBalik(await buatDaftarKerja(KLAIM, {}));
    expect(wb.worksheets.map(w => w.name)).toEqual(['Ringkasan', 'Daftar Klaim', 'Rincian Masalah']);
  });

  // Kalau tercampur dengan pending BPJS, angka "30 klaim pending" jadi
  // mustahil ditafsirkan. Peringatannya harus ikut di dalam berkas, karena
  // berkasnya beredar terlepas dari aplikasi.
  test('Ringkasan memperingatkan bahwa ini pending internal, bukan pending BPJS', async () => {
    const wb = await bacaBalik(await buatDaftarKerja(KLAIM, {}));
    const ws = wb.getWorksheet('Ringkasan');
    let teks = '';
    ws.eachRow(r => { r.eachCell(c => { teks += String(c.value || '') + ' '; }); });
    expect(teks).toMatch(/PENDING INTERNAL/);
    expect(teks).toMatch(/BUKAN pending dari BPJS/);
  });

  test('Ringkasan mencatat cakupan export', async () => {
    const wb = await bacaBalik(await buatDaftarKerja(KLAIM, {
      periode: '2026-09', kategori: 'RAWAT_JALAN', diexportOleh: 'koder@rslestari.id',
    }));
    const ws = wb.getWorksheet('Ringkasan');
    let teks = '';
    ws.eachRow(r => { r.eachCell(c => { teks += String(c.value || '') + ' '; }); });
    expect(teks).toMatch(/September 2026/);
    expect(teks).toMatch(/Rawat Jalan/);
    expect(teks).toMatch(/koder@rslestari\.id/);
  });
});

describe('Daftar Kerja — isi', () => {
  // Satu klaim dengan dua masalah harus jadi dua baris, supaya koder bisa
  // menyaring per jenis masalah dan mengerjakannya berkelompok.
  test('Rincian Masalah berisi satu baris per masalah, bukan per klaim', () => {
    const rincian = susunRincianMasalah(KLAIM);
    expect(rincian).toHaveLength(3); // 2 masalah + 1 masalah
    expect(rincian.filter(r => r.sep === '0170R0110926V000431')).toHaveLength(2);
  });

  // Dua kolom inilah yang membuat berkasnya bisa dikerjakan tanpa membuka
  // aplikasi. Tanpa Bukti, koder harus kembali ke aplikasi; tanpa tindakan,
  // berkasnya cuma daftar keluhan.
  test('kolom Bukti dan Yang Harus Dilakukan terisi', () => {
    const r = susunRincianMasalah(KLAIM)[0];
    expect(r.bukti).toBe('"106/74 mmHg" (hal. 10)');
    expect(r.tindakan).toMatch(/Lengkapi TTV abnormal/);
    expect(r.sumber).toBe('Permenkes 47/2018 Pasal 3');
  });

  test('Jml Masalah dipakai untuk mengurutkan yang paling berat', () => {
    const daftar = susunDaftarKlaim(KLAIM);
    expect(daftar[0].jml_masalah).toBe(2);
    expect(daftar[1].jml_masalah).toBe(1);
  });

  test('Ringkasan Masalah dipisah titik koma', () => {
    expect(susunDaftarKlaim(KLAIM)[0].ringkasan)
      .toBe('Diagnosis IGD hanya kode nyeri generik tanpa bukti kegawatan objektif; Kelas RS kosong');
  });

  test('tarif kosong tidak jadi 0 palsu', () => {
    expect(susunDaftarKlaim(KLAIM)[1].tarif).toBeNull();
    expect(keAngka(null)).toBeNull();
    expect(keAngka('')).toBeNull();
    expect(keAngka(0)).toBe(0);
    expect(keAngka('Rp 1.264.200')).toBe(1264200);
  });

  test('klaim tanpa masalah tidak bikin berkas gagal', async () => {
    const wb = await bacaBalik(await buatDaftarKerja([], {}));
    expect(wb.getWorksheet('Daftar Klaim').rowCount).toBe(1); // judul saja
  });
});

describe('nama berkas menyebut cakupannya', () => {
  test('periode dan kategori masuk ke nama berkas', () => {
    expect(namaBerkasDaftarKerja({ periode: '2026-09', kategori: 'RAWAT_JALAN' }))
      .toBe('daftar-kerja_2026-09_rawat-jalan.xlsx');
  });

  test('tanpa cakupan tetap menghasilkan nama yang sah', () => {
    expect(namaBerkasDaftarKerja({})).toBe('daftar-kerja.xlsx');
  });
});
