const {
  putuskanSumberHalaman, punyaLapisanTeksNyata, rencanakanSumberHalaman, ukurMutuTeks, SUMBER, ALASAN,
} = require('../../services/keputusanSumberHalamanService');

const KALIMAT = 'Pasien datang dengan keluhan batuk dan sesak sejak tiga hari yang lalu, tidak ada demam, tekanan darah 120/80 mmHg. ';
const TEKS_NYATA = KALIMAT.repeat(6); // > 500 karakter
const SAMPAH = '#@$%^&*~`|<>{}[]\\ ¤¦§ ¬ ■□▲ '.repeat(30);

describe('putuskanSumberHalaman (mode all, perilaku ocrService)', () => {
  test('halaman ber-teks nyata >= 500 karakter memakai lapisan teks, tanpa OCR', () => {
    const r = putuskanSumberHalaman(TEKS_NYATA);
    expect(r.sumber).toBe(SUMBER.NATIVE);
    expect(r.alasan).toBe(ALASAN.TEKS_CUKUP);
  });

  test('halaman pindai (tanpa teks) di-OCR', () => {
    expect(putuskanSumberHalaman('')).toMatchObject({ sumber: SUMBER.OCR, alasan: ALASAN.TANPA_TEKS });
    expect(putuskanSumberHalaman(null).sumber).toBe(SUMBER.OCR);
    expect(putuskanSumberHalaman('  12  \n').sumber).toBe(SUMBER.OCR);
  });

  test('teks sedikit (50-499) tetap di-OCR karena bisa campuran teks + tabel gambar', () => {
    const r = putuskanSumberHalaman(KALIMAT); // ~120 karakter
    expect(r.sumber).toBe(SUMBER.OCR);
    expect(r.alasan).toBe(ALASAN.TEKS_SEDIKIT);
  });

  test('lapisan teks sampah di-OCR walau panjang', () => {
    const r = putuskanSumberHalaman(SAMPAH);
    expect(r.sumber).toBe(SUMBER.OCR);
    expect(r.alasan).toBe(ALASAN.TEKS_SAMPAH);
  });

  test('teks panjang tanpa vokal (kode terpotong) dianggap rusak bila banyak kata', () => {
    const teks = 'xzq wrt plk mnb vcx zdf ghj klm qwr tyn '.repeat(15);
    expect(putuskanSumberHalaman(teks).alasan).toBe(ALASAN.TEKS_SAMPAH);
  });

  test('halaman tabel lab bernilai angka tetap dianggap teks nyata', () => {
    const tabel = ('Hemoglobin  12,3  g/dL  12.0 - 16.0  L\nLeukosit  9.500  /uL  4.000 - 10.000\n').repeat(8);
    expect(putuskanSumberHalaman(tabel).sumber).toBe(SUMBER.NATIVE);
  });
});

describe('mode auto-scan', () => {
  test('cukup 50 karakter bermutu untuk memakai teks', () => {
    expect(putuskanSumberHalaman(KALIMAT, { mode: 'auto-scan' }).sumber).toBe(SUMBER.NATIVE);
  });
  test('sampah tetap OCR', () => {
    expect(putuskanSumberHalaman(SAMPAH, { mode: 'auto-scan' }).sumber).toBe(SUMBER.OCR);
  });
});

describe('rencanakanSumberHalaman', () => {
  test('memisahkan halaman teks dan halaman OCR per dokumen', () => {
    const r = rencanakanSumberHalaman([
      { page_num: 1, text_full: TEKS_NYATA },
      { page_num: 2, text_full: '' },
      { page_number: 3, text: SAMPAH },
      { page_num: 4, text_full: TEKS_NYATA },
    ]);
    expect(r.native_text).toEqual([1, 4]);
    expect(r.ocr).toEqual([2, 3]);
    expect(r.rincian[2].alasan).toBe(ALASAN.TEKS_SAMPAH);
  });

  test('daftar kosong', () => {
    expect(rencanakanSumberHalaman(null)).toEqual({ native_text: [], ocr: [], rincian: [] });
  });
});

describe('punyaLapisanTeksNyata dan ukurMutuTeks', () => {
  test('boolean pintasan', () => {
    expect(punyaLapisanTeksNyata(TEKS_NYATA)).toBe(true);
    expect(punyaLapisanTeksNyata(SAMPAH)).toBe(false);
  });
  test('ukuran mutu teks nyata tinggi', () => {
    const m = ukurMutuTeks(TEKS_NYATA);
    expect(m.rasio_alfanumerik).toBeGreaterThan(0.9);
    expect(m.rasio_kata_berbunyi).toBeGreaterThan(0.8);
  });
});

describe('lapisan teks dengan encoding font bergeser', () => {
  const { putuskanSumberHalaman: putus, teksTergeser } = require('../../services/keputusanSumberHalamanService');
  const geser = (t, n) => t.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) - n));
  const resume = 'RS LESTARI RAHARJA Jl Soetopo Magelang RESUME MEDIS RAWAT INAP Nama PASIEN CONTOH C Alasan Masuk Rawat Inap Benjolan di lipat paha kanan nyeri mual muntah Ringkasan Penemuan Fisik Penting Pemeriksaan Penunjang Diagnosis Utama Hernia inguinalis lateralis dekstra ireponibilis Tindakan Prosedur Hernia repair dengan mesh graft Terapi pengobatan selama di rumah sakit Dokter Penanggung Jawab Pelayanan '.repeat(2);
  test('teks normal tetap dipakai', () => {
    expect(teksTergeser(resume)).toBe(false);
    expect(putus(resume).sumber).toBe('native_text');
  });
  test('teks bergeser 29 (PASIEN CONTOH C) dialihkan ke OCR', () => {
    const rusak = geser(resume, 29);
    expect(rusak).toContain('5(680('); // RESUME setelah pergeseran font, tanpa bergantung pada nama pasien.
    expect(teksTergeser(rusak)).toBe(true);
    expect(putus(rusak)).toMatchObject({ sumber: 'ocr', alasan: 'lapisan_teks_rusak' });
  });
});

describe('laporan radiologi RS rujukan', () => {
  const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');
  const { bacaTemuanPenunjang } = require('../../services/temuanPenunjangService');
  const ct = 'Kemenkes RS Soerojo NO RM 900004 NO. FOTO 2026010100000001 PEMERIKSAAN : CT-Head tanpa kontras KLINIS : SES/SNH\nDilakukan Pemeriksaan HCTS Multislice Non Kontras\nKESAN Lacunar Infarct Regio Thalamus sinistra\nRadiologist';
  test('"CT-Head" dikenali sebagai halaman radiologi dan dikode 87.03 (PASIEN CONTOH B)', () => {
    expect(classifyPageDocumentType(ct)).toBe('radiology');
    const { temuan } = bacaTemuanPenunjang([{ page_number: 7, ocr_text: ct }]);
    expect(temuan.find(t => t.istilah_id === 'ct_kepala')).toMatchObject({ kode_usulan: '87.03', page_number: 7 });
  });
});

describe('pengenal pemeriksaan umum (format vendor baru)', () => {
  const { kenaliPemeriksaanRadiologi: k } = require('../../services/pengenalPemeriksaanUmum');
  const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');
  test.each([
    ['HCTS Multislice Non Kontras', '87.03'], ['MSCT Brain', '87.03'], ['USG Whole Abdomen', '88.76'],
    ['Foto Thorax PA', '87.44'], ['MRI Lumbal', '88.93'], ['USG Obstetri', '88.78'],
  ])('%s -> %s', (teks, kode) => expect(k(teks).kode).toBe(kode));
  test('"CT" clotting time di lab tidak dikira CT scan', () => {
    expect(k('Masa Pembekuan (CT) 8.00 menit')).toBeNull();
    expect(k('CLOTTING TIME CT')).toBeNull();
  });
  test('laporan radiologi RS lain dikenali dari strukturnya', () => {
    expect(classifyPageDocumentType('RSUD Kota X\nHASIL BACAAN\nJenis Foto : Thorax PA\nKlinis : batuk\nKesan : cor dan pulmo normal\nSp.Rad')).toBe('radiology');
  });
});

describe('belajar penunjang format baru dari lembar casemix berkas lain', () => {
  const { ekstrakPasangan, cariPenunjangDipelajari } = require('../../services/pembelajaranCasemixService');
  const hasil = { page_number: 7, ocr_text: 'RS Vendor Baru\nHASIL PEMERIKSAAN\nPemeriksaan : Kardiografi Ultra Z   Klinis : sesak\nKesimpulan : normal\nSp.Rad' };
  const lembar = { diagnosis: [{ kode: 'I50.0', peran: 'utama' }], prosedur: [{ kode: '90.59' }, { kode: '88.72' }].slice(1) };
  test('judul tak dikenal + satu kode penunjang casemix -> pasangan penunjang', () => {
    expect(ekstrakPasangan([hasil], lembar)).toEqual(expect.arrayContaining([
      expect.objectContaining({ jenis: 'penunjang', kode: '88.72', teks: 'Kardiografi Ultra Z' }),
    ]));
  });
  test('judul yang sudah dikenali kamus tidak dipelajari ulang', () => {
    const ct = { page_number: 7, ocr_text: 'Pemeriksaan : CT-Head tanpa kontras\nKesan : infark' };
    expect(ekstrakPasangan([ct], { prosedur: [{ kode: '87.03' }] }).filter(p => p.jenis === 'penunjang')).toEqual([]);
  });
  test('dipakai bila >= 2 berkas lain konsisten', async () => {
    const db = { query: async () => {}, all: async () => [{ kode: '88.72', jumlah: 2 }] };
    const r = await cariPenunjangDipelajari(db, [hasil], 'rec-baru', { untukPerbandingan: true });
    expect(r).toEqual([expect.objectContaining({ kode_usulan: '88.72', sumber_pengenal: 'dipelajari_casemix', page_number: 7 })]);
  });
  test('baru 1 berkas -> belum dipakai', async () => {
    const db = { query: async () => {}, all: async () => [{ kode: '88.72', jumlah: 1 }] };
    expect(await cariPenunjangDipelajari(db, [hasil], 'rec-baru', { untukPerbandingan: true })).toEqual([]);
  });
  test('riwayat casemix tidak menentukan kode pasien baru', async () => {
    const db = { all: jest.fn(async () => [{ kode: '88.72', jumlah: 100 }]) };
    expect(await cariPenunjangDipelajari(db, [hasil], 'rec-baru')).toEqual([]);
    expect(db.all).not.toHaveBeenCalled();
  });
});
