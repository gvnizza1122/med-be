const { applyDeterministicFallback } = require('../../services/pdfExtractionPipeline');

describe('OCR administrasi pada halaman NATIVE', () => {
  const { teksFallbackDokumen } = require('../../services/pdfExtractionPipeline');
  test('tanggal masuk/keluar tetap dibaca ketika lapisan native tidak lengkap', () => {
    const c = { pages: [{ page_num: 1, type: 'NATIVE', text_full: 'SURAT PERINTAH RAWAT INAP' }, { page_num: 11, type: 'NATIVE', text_full: 'DETAIL RINCIAN BIAYA' }],
      ocr_enhancement: { pass1_general_ocr: { pages: [{ page_number: 1, text: 'Tanggal MRS : 4 Jan 2026' }, { page_number: 11, text: 'Tgl Rawat : 4 Jan 2026 - 6 Jan 2026' }] } } };
    expect(applyDeterministicFallback({}, teksFallbackDokumen(c), 'RAWAT_INAP', 'acuan.pdf')).toMatchObject({ ADMISSION_DATE: '04/01/2026', DISCHARGE_DATE: '06/01/2026', LOS: '3' });
  });
  test('OCR halaman grouper yang sudah ditandai tidak masuk walau judul OCR rusak', () => {
    const c = { pages: [{ page_num: 1, type: 'NATIVE', text_full: 'Tanggal MRS : 1 Jul 2026' }, { page_num: 2, is_lembar_grouper: true, text_full: 'hasil casemix' }],
      ocr_enhancement: { pass1_general_ocr: { pages: [{ page_number: 2, text: 'Tgl Rawat : 4 Jan 2026 - 6 Jan 2026' }] } } };
    expect(teksFallbackDokumen(c)).not.toContain('4 Jan 2026');
    expect(applyDeterministicFallback({}, teksFallbackDokumen(c), 'RAWAT_INAP', 'acuan.pdf').DISCHARGE_DATE).toBeUndefined();
  });
  test('grouper yang ditemukan lewat OCR ikut dikecualikan menurut nomor halaman', () => {
    expect(teksFallbackDokumen({ pages: [], grouperPages: [{ page_num: 3 }], ocr_enhancement: { pass1_general_ocr: { pages: [{ page_number: 3, text: 'Tanggal MRS : 1 Jul 2026' }] } } })).toBe('');
  });
});
const { getTarifResmi } = require('../../services/tarifInacbgLookup');

// Berkas SEP rawat jalan/IGD yang khas: 'Kelas Rawat' memang "-" (pasien tidak
// dirawat inap), kelas yang berlaku ada di 'Kls Hak'.
const TEKS_SEP = [
  'SURAT ELIGIBILITAS PESERTA',
  'No. SEP : 0170R0110826V003062',
  'Kls Hak : Kelas 3',
  'Kelas Rawat : -',
  'Jns Rawat : Rawat Jalan',
].join('\n');

function jalankan(nilaiDariAi, teks = TEKS_SEP) {
  const record = { KELAS_RAWAT: nilaiDariAi };
  applyDeterministicFallback(record, teks, 'RAWAT_JALAN', 'berkas.pdf');
  return record.KELAS_RAWAT;
}

describe('applyDeterministicFallback — KELAS_RAWAT rawat jalan/IGD', () => {
  // Regresi produksi 21 Sep 2026: klaim IGD anak (G40.9) menampilkan kode
  // G-4-22-I + deskripsinya, tapi tarif "Tidak ditemukan". Sebabnya AI menyalin
  // "-" dari field 'Kelas Rawat' -- dan karena "-" truthy, syarat lama
  // (!record.KELAS_RAWAT) melewatkan fallback 'Kls Hak' justru pada kasus yang
  // paling membutuhkannya.
  test('nilai sampah yang truthy tetap memicu fallback Kls Hak', () => {
    expect(jalankan('-')).toBe('3');
    expect(jalankan('IGD')).toBe('3');
    expect(jalankan('Rawat Jalan')).toBe('3');
  });

  test('kosong tetap memicu fallback (perilaku lama tidak hilang)', () => {
    expect(jalankan('')).toBe('3');
    expect(jalankan(undefined)).toBe('3');
  });

  test('kelas yang sudah valid TIDAK ditimpa Kls Hak', () => {
    expect(jalankan('1')).toBe('1');
    expect(jalankan('2')).toBe('2');
  });

  test('kalau Kls Hak tidak terbaca, nilai sampah dikosongkan', () => {
    expect(jalankan('-', 'SEP tanpa kelas hak')).toBe('');
    expect(jalankan('IGD', 'SEP tanpa kelas hak')).toBe('');
  });

  test('rawat inap: kelas valid dari AI tidak ditimpa', () => {
    const record = { KELAS_RAWAT: '2' };
    applyDeterministicFallback(record, TEKS_SEP, 'RAWAT_INAP', 'berkas.pdf');
    expect(record.KELAS_RAWAT).toBe('2');
  });
});

describe('applyDeterministicFallback — KELAS_RAWAT rawat inap', () => {
  // IBU CONTOH (0000R0000126V000002): SEP hasil scan, AI tidak mengisi kelas
  // -> tarif INA-CBG rawat inap kosong.
  const SEP_RANAP = 'No.SEP : 0000R0000126V000002\nJns.Rawat : R.Inap\nDokter : GUNAWAN Kls.Hak : Kelas 3\nFaskes Perujuk : RS Lestari Raharja Kls.Rawat : Kelas 2';
  const jalankanRi = (nilai, teks = SEP_RANAP) => {
    const record = { KELAS_RAWAT: nilai };
    applyDeterministicFallback(record, teks, 'RAWAT_INAP', 'berkas.pdf');
    return record.KELAS_RAWAT;
  };
  test('kosong/sampah diisi dari Kls.Rawat, bukan Kls.Hak', () => {
    expect(jalankanRi('')).toBe('2');
    expect(jalankanRi('-')).toBe('2');
  });
  test('Kls.Rawat tidak terbaca -> Kls.Hak', () => {
    expect(jalankanRi('', 'Kls.Hak : Kelas 3')).toBe('3');
  });
  test('tidak ada keduanya -> kosong', () => {
    expect(jalankanRi('-', 'SEP tanpa kelas')).toBe('');
  });
});

describe('tanggal masuk/keluar rawat inap tanpa lembar grouper', () => {
  const { applyDeterministicFallback: fb } = require('../../services/pdfExtractionPipeline');
  const isi = (t) => fb({}, t, 'RAWAT_INAP', 'x.pdf');
  test('rentang "Tgl Rawat" rincian biaya mengisi masuk & keluar (PASIEN CONTOH B)', () => {
    expect(isi('Tanggal MRS : 31 Dec 2025\nNama : PASIEN CONTOH B, NY   Tgl Rawat : 31 Dec 2025 - 3 Jan 2026'))
      .toMatchObject({ ADMISSION_DATE: '31/12/2025', DISCHARGE_DATE: '03/01/2026' });
  });
  test('nama bulan Indonesia & "s.d"', () => {
    expect(isi('Tgl Rawat : 30 Desember 2025 s.d 2 Januari 2026')).toMatchObject({ ADMISSION_DATE: '30/12/2025', DISCHARGE_DATE: '02/01/2026' });
  });
  test('tanpa rentang rawat: masuk dari SPRI, keluar tidak ditebak', () => {
    const r = isi('Tanggal MRS : 2 Jan 2026');
    expect(r.ADMISSION_DATE).toBe('02/01/2026');
    expect(r.DISCHARGE_DATE).toBeUndefined();
  });
  test('tanggal dari dokumen mengalahkan isian AI', () => {
    expect(fb({ ADMISSION_DATE: '01/01/2026', DISCHARGE_DATE: '05/01/2026' }, 'Tgl Rawat : 31 Dec 2025 - 3 Jan 2026', 'RAWAT_INAP', 'x.pdf'))
      .toMatchObject({ ADMISSION_DATE: '31/12/2025', DISCHARGE_DATE: '03/01/2026' });
  });
  test('contoh RS: masuk = Tanggal MRS SPRI, keluar = tanda tangan DPJP resume (PASIEN CONTOH B)', () => {
    const teks = 'SURAT PERINTAH RAWAT INAP\nTanggal MRS : 31 Dec 2025\n\nRESUME MEDIS RAWAT INAP\nPrognosis : ad bonam\n'
      + 'Magelang, 3 Januari 2026\nDokter Penanggung Jawab\nPelayanan,\nPasien/Keluarga,';
    expect(isi(teks)).toMatchObject({ ADMISSION_DATE: '31/12/2025', DISCHARGE_DATE: '03/01/2026', LOS: '4' });
  });
  test('rincian biaya lebih dulu dari tanda tangan resume (SLAMET: resume 5 Jan, pulang 4 Jan)', () => {
    const teks = 'Tanggal MRS : 31 Dec 2025\nMagelang, 5 Januari 2026\nDokter Penanggung Jawab\nTgl Rawat : 31 Dec 2025 - 4 Jan 2026';
    expect(isi(teks)).toMatchObject({ ADMISSION_DATE: '31/12/2025', DISCHARGE_DATE: '04/01/2026', LOS: '5' });
  });
  test('tanpa rincian biaya: keluar dari tanda tangan DPJP resume', () => {
    expect(isi('Magelang, 5 Januari 2026\nDokter Penanggung Jawab Pelayanan,\ndr. Woro').DISCHARGE_DATE).toBe('05/01/2026');
  });
  test.each([
    ['DPJP : dr. Varian Primada Jaya Sp.PD\nTanggal MRS : 31 Dec 2025', 'dr. Varian Primada Jaya Sp.PD'],
    ['Dokter Penanggung Jawab Pelayanan,\ndr. Woro Triaksiwi, MSc, Sp.A', 'dr. Woro Triaksiwi, MSc, Sp.A'],
    ['Dokter : VARIAN PRIMADA JAYA        Kls.Hak : Kelas 3', 'VARIAN PRIMADA JAYA'],
  ])('DPJP dari dokumen: %s', (teks, dpjp) => expect(isi(teks).DPJP).toBe(dpjp));
  test('DPJP hasil AI tidak ditimpa', () => {
    expect(fb({ DPJP: 'dr. A' }, 'DPJP : dr. B', 'RAWAT_INAP', 'x.pdf').DPJP).toBe('dr. A');
  });
  test('label diagnosis akhir DPJP tidak menjadi nama dokter, dan label kosong tidak mengambil baris berikutnya',()=>{
    expect(isi('Diagnosis utama akhir DPJP: Pneumonia (J18.9).').DPJP).toBeUndefined();
    expect(isi('DPJP :\nDiagnosis utama: Pneumonia').DPJP).toBeUndefined();
    expect(isi('Diagnosis dokter: Pneumonia').DPJP).toBeUndefined();
  });
});

describe('LOS dihitung inklusif seperti E-Klaim', () => {
  const { applyDeterministicFallback: fb } = require('../../services/pdfExtractionPipeline');
  test.each([
    ['31/12/2025', '03/01/2026', '4'], // PASIEN CONTOH B
    ['02/01/2026', '04/01/2026', '3'], // ISTIYAH
    ['02/01/2026', '03/01/2026', '2'], // TRIMOKO
    ['05/01/2026', '05/01/2026', '1'],
  ])('%s - %s -> %s hari', (masuk, keluar, los) => {
    expect(fb({ ADMISSION_DATE: masuk, DISCHARGE_DATE: keluar }, '', 'RAWAT_INAP', 'x.pdf').LOS).toBe(los);
  });
  test('LOS dari AI yang keliru dihitung ulang (PASIEN CONTOH B: AI 3, seharusnya 4)', () => {
    expect(fb({ ADMISSION_DATE: '31/12/2025', DISCHARGE_DATE: '03/01/2026', LOS: '3' }, '', 'RAWAT_INAP', 'x.pdf').LOS).toBe('4');
  });
  test('tanggal tidak lengkap: LOS dari AI dipertahankan', () => {
    expect(fb({ ADMISSION_DATE: '01/01/2026', LOS: '5' }, '', 'RAWAT_INAP', 'x.pdf').LOS).toBe('5');
  });
});

describe('kasus anemia dewasa (SLAMET FAHRODIN 0170R0111225V003444)', () => {
  const { tandaiAlternatifDiagnosis } = require('../../services/aiReviewService');
  const { lengkapiKodeBedah } = require('../../services/kodingBedahService');
  const k = require('../../services/kalibrasiSeverityService');
  const { groupCodesToInaCBG } = require('../../services/inacbgGroupingService');
  test('D62 & D50.0 kondisional dari kutipan sama: hanya yang pertama terisi otomatis', () => {
    const r = tandaiAlternatifDiagnosis([
      { code: 'D62', type: 'diagnosis', page_number: 3, quotation: 'anemia et causa blood loss', reasoning: 'pertimbangkan D62 bila akut' },
      { code: 'D50.0', type: 'diagnosis', page_number: 3, quotation: 'anemia et causa blood loss', reasoning: 'pertimbangkan D50.0 bila kronis' },
      { code: 'K62.5', type: 'diagnosis', page_number: 3, quotation: 'hematoschezia', reasoning: 'x' },
    ]);
    expect(r[0].boleh_isi_otomatis).toBeUndefined();
    expect(r[1]).toMatchObject({ alternatif_dari: 'D62', boleh_isi_otomatis: false });
    expect(r[2].boleh_isi_otomatis).toBeUndefined();
  });
  test.each([
    ['2. tranfsui porc', '99.04'], ['1. transfusi PRC 2 kolf', '99.04'], ['1. Tranfusi WB 1 kantong', '99.03'],
    ['1. transfusi TC 4 unit', '99.05'], ['1. transfusi FFP', '99.07'],
  ])('transfusi "%s" -> %s', (baris, kode) => {
    const teks = `RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nanemia\nTindakan/Prosedur :\n${baris}`;
    expect(lengkapiKodeBedah([], [{ page_number: 3, ocr_text: teks }]).saran.map(s => s.code)).toEqual([kode]);
  });
  test('rencana transfusi tidak dikode', () => {
    const teks = 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nanemia\nTindakan/Prosedur :\n1. rencana transfusi PRC';
    expect(lengkapiKodeBedah([], [{ page_number: 3, ocr_text: teks }]).saran).toEqual([]);
  });
  test('kalibrasi severity dari lembar grouper: K62.5 tidak menaikkan D-4-13', () => {
    k.catatDariLembar({ inacbg: { kode: 'D-4-13-I' }, diagnosis: [{ kode: 'D64.9', peran: 'utama' }, { kode: 'K62.5', peran: 'sekunder' }] });
    expect(groupCodesToInaCBG(['D64.9', 'K62.5'], ['90.59', '89.52', '99.04'], 'RAWAT_INAP').code).toBe('D-4-13-I');
    expect(k.catatDariLembar({ inacbg: { kode: 'D-4-13-II' }, diagnosis: [{ kode: 'D64.9', peran: 'utama' }, { kode: 'J18.9', peran: 'sekunder' }] })).toBe(0);
  });
});
