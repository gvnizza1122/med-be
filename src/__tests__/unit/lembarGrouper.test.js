const { isLembarGrouper, bacaLembarGrouper, cariLembarGrouper } = require('../../services/lembarGrouperService');
const { susunSaranKoding } = require('../../services/saranKodingService');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');
const { padananWho } = require('../../services/kamusKodeService');
const { simpanAiReview } = require('../../services/simpanAiReviewService');

// Lembar grouper KHOIRIYAH (SEP 0170R0111225V003293) -- bentuk teks pdf-parse.
const PDFPARSE = `KEMENTERIAN KESEHATAN REPUBLIK INDONESIA JKN
Berkas Klaim Individual Pasien 02/01/2026
Kode Rumah Sakit : 3371084 Kelas Rumah Sakit : D
Nomor Peserta : 0002969212623 Nomor SEP : 0170R0111225V003293
Nomor Rekam Medis : 175092 Tanggal Masuk : 29/12/2025
Umur Hari : 23853 Jenis Perawatan : 1 - Rawat Inap
Jenis Kelamin : 2 - Perempuan LOS : 5 hari
Kelas Perawatan : 3 - Kelas 3 Berat Lahir : -
Diagnosa Utama : I51.7 Cardiomegaly
Diagnosa Sekunder : -
Prosedur : 90.59 Microscopic examination of blood, Other microscopic examination
89.52 Electrocardiogram
87.44 Routine chest x-ray, so described
ADL Sub Acute : - ADL Chronic : -
Hasil Grouping
INA-CBG : I-4-24-I GANGGUAN SISTEM PEMBULUH DARAH LAIN-LAIN (RINGAN) Rp 2,116,600.00
Sub Acute : - - Rp 0.00
Chronic : - - Rp 0.00
Special CMG : - - Rp 0.00
Total Tarif : Rp 2,116,600.00
Generated : E-Klaim 5.10.6.202601010630 @ 2026-01-06 15:25:12 Lembar 1 / 1`;

// Bentuk mupdf/OCR: label dan nilai di baris terpisah.
const MUPDF = PDFPARSE.replace(/ : /g, '\n:\n').replace(/ (?=\d{2}\.\d{2} )/g, '\n');

describe('lembar grouper E-Klaim', () => {
  test('dikenali; resume/SEP bukan lembar grouper', () => {
    expect(isLembarGrouper(PDFPARSE)).toBe(true);
    expect(isLembarGrouper('RESUME MEDIS RAWAT INAP\nDiagnosis Utama : cardiomegali edem paru')).toBe(false);
    expect(isLembarGrouper('SURAT ELEGIBILITAS PESERTA\nNo. SEP 0170R0111225V003293')).toBe(false);
  });

  test.each([['pdf-parse', PDFPARSE], ['mupdf/OCR', MUPDF]])('dibaca tanpa AI dari teks %s', (_, teks) => {
    const g = bacaLembarGrouper(teks, 15);
    expect(g).toMatchObject({
      halaman: 15, sep: '0170R0111225V003293', jenis_perawatan: '1 - Rawat Inap', kelas_perawatan: '3 - Kelas 3', los: 5,
      inacbg: { kode: 'I-4-24-I', deskripsi: 'GANGGUAN SISTEM PEMBULUH DARAH LAIN-LAIN (RINGAN)', tarif: 2116600 },
      total_tarif: 2116600, sub_acute: null, chronic: null, special_cmg: null, versi_eklaim: '5.10.6.202601010630',
    });
    expect(g.diagnosis).toEqual([{ kode: 'I51.7', deskripsi: 'Cardiomegaly', peran: 'utama' }]);
    expect(g.prosedur.map(p => p.kode)).toEqual(['90.59', '89.52', '87.44']);
  });

  test('cariLembarGrouper mengambil dari daftar halaman', () => {
    const g = cariLembarGrouper([{ page_num: 3, text: 'RESUME MEDIS RAWAT INAP' }, { page_num: 15, text: PDFPARSE }]);
    expect(g.halaman).toBe(15);
    expect(cariLembarGrouper([{ page_num: 3, text: 'RESUME MEDIS' }])).toBeNull();
  });
});

describe('padanan ICD-10 WHO yang pasti', () => {
  test('J81.0 (CM) -> J81; kategori bersubkode tidak ditebak', () => {
    expect(padananWho('J81.0')).toBe('J81');
    expect(padananWho('J45.3')).toBeNull();
    expect(padananWho('I51.7')).toBeNull(); // sudah kode WHO
  });
});

describe('saran AI dibandingkan dengan hasil casemix', () => {
  const lembar = bacaLembarGrouper(PDFPARSE, 15);
  const record = { diagnosa_list: '', prosedur_list: '', jenis_klaim: 'RAWAT_INAP', kelas_rawat: 3 };
  const saran = (code, type, quotation) => ({ code, type, kamus_valid: true, page_number: 3, quotation });

  test('saran AI disusun tanpa lembar grouper, lalu dibandingkan', () => {
    const ai = {
      lembar_grouper: lembar,
      suggested_codes: [
        saran('I51.7', 'diagnosis', 'cardiomegali'),
        { ...saran('J81.0', 'diagnosis', 'edem paru'), kamus_valid: false },
        saran('87.44', 'procedure', 'ro thorax'),
      ],
    };
    const h = susunSaranKoding(record, ai, hitungInacbgDanTarif);
    expect(h.diagnosis.map(d => d.kode)).toEqual(['I51.7', 'J81']);
    expect(h.diagnosis[1].catatan).toMatch(/J81\.0 bukan kode ICD-10 WHO; padanannya J81/);
    expect(h.casemix).toMatchObject({
      halaman: 15,
      diagnosis_utama: { ai: 'I51.7', casemix: 'I51.7', cocok: true },
      diagnosis: { sama: ['I51.7'], hanya_ai: ['J81'], hanya_casemix: [] },
      prosedur: { sama: ['87.44'], hanya_ai: [], hanya_casemix: ['90.59', '89.52'] },
      inacbg: { casemix: 'I-4-24-I' },
      tarif: { casemix: 2116600 },
      semua_cocok: false,
      inti_cocok: false,
    });
  });

  test('tanpa lembar grouper -> tidak ada perbandingan', () => {
    expect(susunSaranKoding(record, {}, hitungInacbgDanTarif).casemix).toBeNull();
  });
});

describe('simpanAiReview mempertahankan pembanding casemix', () => {
  test('review ulang tanpa PDF tidak menghapus lembar_grouper', async () => {
    let tersimpan = null;
    const db = {
      prepare: (sql) => ({
        get: async () => ({ ai_review: JSON.stringify({ lembar_grouper: { inacbg: { kode: 'I-4-24-I' } } }) }),
        run: async (json) => { if (/UPDATE/.test(sql)) tersimpan = JSON.parse(json); },
      }),
    };
    await simpanAiReview(db, 'r1', { suggested_codes: [] });
    expect(tersimpan.lembar_grouper).toEqual({ inacbg: { kode: 'I-4-24-I' } });
  });
});

describe('prosedur penunjang masuk saran AI', () => {
  test('temuan penunjang berkode menjadi saran prosedur dengan buktinya', () => {
    const h = susunSaranKoding({ diagnosa_list: 'I51.7', jenis_klaim: 'RAWAT_INAP', kelas_rawat: 3 }, {
      temuan_penunjang: [
        { istilah_baku: 'Darah lengkap', kode_usulan: '90.59', page_number: 3, kutipan: 'DARAH RUTIN' },
        { istilah_baku: 'Fungsi ginjal', kode_usulan: '90.59', page_number: 5, kutipan: 'Ureum 37.90' },
        { istilah_baku: 'Rontgen toraks', kode_usulan: '87.44', page_number: 3, kutipan: 'ro thorax' },
        { istilah_baku: 'Leukosit', kode_usulan: null, page_number: 5, kutipan: 'Lekosit 6.68' },
      ],
    }, hitungInacbgDanTarif);
    expect(h.prosedur.map(p => p.kode)).toEqual(['90.59', '87.44']);
    expect(h.prosedur[0]).toMatchObject({ asal: ['penunjang'] });
    expect(h.prosedur[0].bukti.map(b => b.kutipan)).toEqual(['DARAH RUTIN', 'Ureum 37.90']);
  });
});

describe('pengenal jenis halaman: judul dokumen didahulukan', () => {
  const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');
  test('resume yang menyebut ekg/hematologi tetap resume_medis', () => {
    expect(classifyPageDocumentType('RESUME MEDIS RAWAT INAP\nRingkasan Penemuan Fisik Penting :\nekg :LVH\nTindakan/Prosedur :\n1. ro thorax')).toBe('resume_medis');
  });
  test('lembar grouper yang menyebut chest x-ray tetap berkas_eklaim', () => {
    expect(classifyPageDocumentType(PDFPARSE)).toBe('berkas_eklaim');
  });
  test('halaman tanpa judul tetap dikenali dari isinya', () => {
    expect(classifyPageDocumentType('HASIL PEMERIKSAAN LABORATORIUM\nHematologi\nLeukosit 6.68')).toBe('lab_results');
    expect(classifyPageDocumentType('Sinus tachycardia\nEKG 12 lead')).toBe('ekg');
  });
});

describe('pembaca penunjang: EKG & label "Penunjang lain"', () => {
  const { bacaTemuanPenunjang } = require('../../services/temuanPenunjangService');
  const baca = (teks) => bacaTemuanPenunjang([{ page_number: 1, ocr_text: teks }]);

  test('rekaman EKG cetakan mesin -> EKG 89.52', () => {
    const r = baca('Unconfirmed Diagnosis\nSinus tachycardia with sinus arrhythmia Abnormal ECG\nQTc Interval P/QRS/T Axes');
    expect(r.temuan.map(t => [t.istilah_id, t.kode_usulan])).toEqual([['ekg', '89.52']]);
  });

  test('triase "Penunjang lain : lab ekg gda 119" terbaca tanpa menelan sisa halaman', () => {
    const r = baca('TRIAGE IGD\nPenunjang lain : lab ekg gda 119\nRiwayat Penyakit :\nSkala Nyeri 0 1 2\nVITAL SIGN BB TB TD');
    expect(r.temuan.map(t => t.istilah_id)).toEqual(expect.arrayContaining(['ekg']));
    expect(r.tidak_dikenali).toEqual([]);
  });

  test('daftar resume berhenti di "Hasil Konsultasi"/"Diagnosis Utama"', () => {
    const r = baca('RESUME MEDIS RAWAT INAP\nPemeriksaan Penunjang :\n1. DARAH RUTIN\nHasil Konsultasi :\nro cardiomegali\nDiagnosis Utama :\ncardiomegali');
    expect(r.temuan.map(t => t.istilah_id)).toEqual(['darah_lengkap']);
    expect(r.tidak_dikenali).toEqual([]);
  });
});

describe('hasil lab hasil OCR (YETY NOVIATI) terbaca rinci', () => {
  const { bacaBarisLab } = require('../../services/bacaLabService');
  const baca = (baris) => bacaBarisLab(baris)[0];
  test('salah baca nama & satuan dikoreksi', () => {
    expect(baca('Lokosit 9.77 4.5-11 10^3/uL. Flowcytometry')).toMatchObject({ parameter: 'leukosit', kewajaran: { status: 'wajar', nilai_dinormalkan: 9770 } });
    expect(baca('Enitrosit 4.09 4.60-6.00 juia/ui. impedance')).toMatchObject({ parameter: 'eritrosit', satuan: 'juta/uL' });
    expect(baca('Trombosit 252 150-400 ribulut. Impedance')).toMatchObject({ parameter: 'trombosit', kewajaran: { status: 'wajar', nilai_dinormalkan: 252000 } });
    expect(baca('Glukosa Darah Sewaktu 93 82-115 mg/dL.')).toMatchObject({ parameter: 'gula_darah_sewaktu' });
  });
  test('hitung jenis: persen vs absolut, termasuk "#" terbaca "a"', () => {
    expect(baca('Neutrofir% 78.2 % DHSS').parameter).toBe('neutrofil_persen');
    expect(baca('Neutrofila 7.64 H 1.5-7 sel/mm^3')).toMatchObject({ parameter: 'neutrofil_absolut', flag_cetak: 'H' });
    expect(baca('Umfosit# 1.63 1-3.7 sel/mm²3').parameter).toBe('limfosit_absolut');
    expect(baca('NLR 4.68 H <3.13 Caicutation').parameter).toBe('nlr');
  });
  test('PCT ber-% di darah lengkap bukan prokalsitonin', () => {
    expect(baca('PCT 0.257 0.17-0.35 %').istilah_id).toBeNull();
  });
});

describe('INA-CBG kelompok prosedur & tarif rawat inap', () => {
  const { groupCodesToInaCBG } = require('../../services/inacbgGroupingService');
  test('sesar -> O-6-10; Z37/O82 bukan komorbid (casemix YETY O-6-10-I Rp4.656.700)', () => {
    expect(groupCodesToInaCBG(['O42.1', 'Z37.0', 'O82.1'], ['74.1', '75.32', '90.59'], 'RAWAT_INAP').code).toBe('O-6-10-I');
    const { inacbgCodeForLookup, tarifResult } = hitungInacbgDanTarif(['O42.1', 'Z37.0', 'O82.1'], ['74.1', '75.32', '90.59'], 'RAWAT_INAP', '3', null);
    expect(inacbgCodeForLookup).toBe('O-6-10-I');
    expect(tarifResult.amount).toBe(4656700);
  });
  test('usulan AI kelompok medis kalah oleh kelompok prosedur', () => {
    expect(hitungInacbgDanTarif(['O42.1'], ['74.1'], 'RAWAT_INAP', '3', 'W-4-16-II').inacbgCodeForLookup).toBe('O-6-10-I');
  });
  test('persalinan & bedah umum lain', () => {
    expect(groupCodesToInaCBG(['O80.0', 'Z37.0'], ['73.59'], 'RAWAT_INAP').code).toBe('O-6-13-I');
    expect(groupCodesToInaCBG(['K35.8'], ['47.09'], 'RAWAT_INAP').code).toBe('K-1-13-I');
    expect(groupCodesToInaCBG(['O03.4'], ['69.02'], 'RAWAT_INAP').code).toBe('W-1-11-I'); // 69.02 -> W-1-11 (tabel resmi; dulu heuristik W-1-10)
  });
  test('kelas rawat inap kosong -> tarif kelas 3 ditandai asumsi', () => {
    const { tarifResult } = hitungInacbgDanTarif(['O42.1'], ['74.1'], 'RAWAT_INAP', '', null);
    expect(tarifResult).toMatchObject({ amount: 4656700, kelas_rawat: '3', kelas_asumsi: true });
  });
  test('setiap kelompok prosedur ada di PMK 3/2023', () => {
    const fs = require('fs');
    const { lookupTarifInacbg } = require('../../services/tarifInacbgLookup');
    const src = fs.readFileSync(require.resolve('../../services/inacbgGroupingService'), 'utf8');
    const kode = [...src.matchAll(/'([A-Z]-[16]-\d{2})'/g)].map(m => m[1]);
    expect(kode.length).toBeGreaterThan(10);
    expect(kode.filter(k => !['I', 'II', 'III'].every(s => lookupTarifInacbg(`${k}-${s}`)))).toEqual([]);
  });
});

describe('koding obstetri baku', () => {
  const { lengkapiKodeObstetri } = require('../../services/kodingObstetriService');
  const POOL = [
    { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nKPD 3 hari, OLigohidramnion G3P2A0 hamil 38 minggu\nTindakan/Prosedur :\n1. sectio sesarea emergency' },
    { page_number: 10, ocr_text: 'LAPORAN OPERASI\nCITO ELEKTIF' },
    { page_number: 14, ocr_text: '1. Bayi lahir hidup/lahir hidup kemudian meninggal' },
    { page_number: 18, ocr_text: 'Telah Lahir Pada Hari : Rabu\nBerat Badan : 2650 gram\nKelahiran dengan cara : SC' },
  ];
  const s = (code, type) => ({ code, type, kamus_valid: true, page_number: 3, quotation: 'x' });
  test('O42.9 + 74.99 -> O42.1, 74.1, O82.1, Z37.0 berkutipan', () => {
    const r = lengkapiKodeObstetri([s('O42.9', 'diagnosis'), s('O41.0', 'diagnosis'), s('74.99', 'procedure')], POOL);
    expect(r.saran.map(x => x.code)).toEqual(['O42.1', 'O41.0', '74.1', 'O82.1', 'Z37.0']);
    expect(r.saran.find(x => x.code === 'Z37.0').page_number).toBe(18);
    expect(r.saran.find(x => x.code === 'O82.1').quotation).toMatch(/emergency/);
  });
  test('pilihan cetak "CITO ELEKTIF" bukan keterangan -> O82.9', () => {
    const r = lengkapiKodeObstetri([s('O32.1', 'diagnosis')], [{ page_number: 1, ocr_text: 'LAPORAN OPERASI\nCITO ELEKTIF\nsectio caesarea' }]);
    expect(r.saran.map(x => x.code)).toEqual(['O32.1', '74.1', 'O82.9']);
  });
  test('kasus non-obstetri tidak disentuh', () => {
    const awal = [s('I51.7', 'diagnosis')];
    expect(lengkapiKodeObstetri(awal, POOL).perubahan).toEqual([]);
  });
  test('rekaman CTG -> 75.32', () => {
    const { bacaTemuanPenunjang } = require('../../services/temuanPenunjangService');
    const r = bacaTemuanPenunjang([{ page_number: 7, ocr_text: 'RM. 46\nFHR 240 bpm 012 MEDI-GRAPH' }]);
    expect(r.temuan.map(t => [t.istilah_id, t.kode_usulan])).toEqual([['ctg', '75.32']]);
  });
});

describe('INA-CBG bedah ortopedi & bedah umum', () => {
  const { groupCodesToInaCBG } = require('../../services/inacbgGroupingService');
  test.each([
    [['S72.0'], ['79.35', '86.22'], 'M-1-20-I'],
    [['S82.2'], ['79.36'], 'M-1-70-I'],
    [['S52.5'], ['79.32'], 'M-1-80-I'],
    [['Z47.0'], ['78.65'], 'M-1-40-I'],
    [['M17.1'], ['81.54'], 'M-1-01-I'], // 81.54 -> M-1-01,M-1-04 (tabel resmi); hierarki pilih M-1-01 (prioritas lebih tinggi)
    [['E11.5', 'I70.2'], ['84.15'], 'M-1-02-I'], // I70.2 bukan CC di daftar CC resmi (cclist) -> severity tetap I
    [['K35.8'], ['47.09', '54.11'], 'K-1-40-I'], // 2 prosedur: 54.11->K-1-40 (rank40) mengalahkan 47.09->K-1-13 (rank61) per hierarki resmi
    [['K56.6'], ['54.11', '45.62'], 'K-1-20-I'],
    [['K61.0'], ['49.01'], 'K-1-50-I'],
    [['D24'], ['85.21'], 'L-1-50-I'],
    [['D17.1'], ['86.3'], 'L-1-40-I'],
    [['T24.3'], ['86.69'], 'L-1-20-I'],
    [['M51.1'], ['80.51'], 'M-1-60-I'], // 80.51 eksisi diskus -> M-1-60 (grup tunggal tabel resmi alt_procedures)
  ])('%s + %s -> %s', (dx, px, kode) => {
    expect(groupCodesToInaCBG(dx, px, 'RAWAT_INAP').code).toBe(kode);
  });
  test('tindakan kecil tetap kelompok medis', () => {
    expect(groupCodesToInaCBG(['L02.4'], ['86.04'], 'RAWAT_INAP').code).toBe('L-4-12-I');
  });
});

describe('koding bedah dari resume/laporan operasi', () => {
  const { lengkapiKodeBedah } = require('../../services/kodingBedahService');
  const R = 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\n';
  const kode = (teks, saran = []) => lengkapiKodeBedah(saran, [{ page_number: 3, ocr_text: teks }]).saran.map(x => x.code);
  test('ORIF + lokasi tulang tertulis', () => {
    expect(kode(`${R}Tindakan/Prosedur :\n1. ORIF plate and screw femur dextra`)).toEqual(['79.35']);
  });
  test('lokasi dari diagnosis fraktur; 79.30 diganti', () => {
    expect(kode(`${R}Tindakan/Prosedur :\n1. ORIF`, [{ code: 'S82.2', type: 'diagnosis' }, { code: '79.30', type: 'procedure' }])).toEqual(['S82.2', '79.36']);
  });
  test('satu kode per tindakan dalam satu baris', () => {
    expect(kode(`${R}Tindakan/Prosedur :\n1. herniotomi + hernioplasti mesh dextra`)).toEqual(['53.05']);
  });
  test('rencana, riwayat, dan catatan perawat tidak dikode', () => {
    expect(kode(`${R}Alasan masuk : pro ORIF cruris`)).toEqual([]);
    expect(kode(`${R}Riwayat : post ORIF femur 2024`)).toEqual([]);
    expect(kode('CATATAN PERAWAT\nORIF femur')).toEqual([]);
  });
  test('laporan operasi bedah umum', () => {
    expect(kode('LAPORAN OPERASI\nJenis Operasi : Laparotomi eksplorasi + apendektomi')).toEqual(['47.09', '54.11']);
    expect(kode('LAPORAN OPERASI\nJenis Operasi : Aff plate antebrachii sinistra')).toEqual(['78.63']);
  });
});

describe('budget OCR mengikuti jumlah halaman & berkas bersamaan', () => {
  const { anggaranOcrMs } = require('../../services/ocrService');
  test('minimal 180 dtk, bertambah per halaman, dibatasi maksimum', () => {
    expect(anggaranOcrMs(10)).toBe(180000);
    expect(anggaranOcrMs(63)).toBe(252000);
    expect(anggaranOcrMs(63, 3)).toBe(600000);
  });
});

describe('identitas lintas halaman: bayi baru lahir pasien bukan pasien lain', () => {
  const { verifikasiIdentitas } = require('../../services/identitasLintasHalamanService');
  const klaim = { nama_pasien: 'YETY NOVIATI, NY', mrn: '172001' };
  test('skrining bayi (Nama Faskes, RM bayi, Nama Ibu = pasien) tidak dituduh', () => {
    const hal = { page_number: 17, ocr_text: 'Order NBS Detail Pemeriksaan\nNama Faskes RS LESTARI RAHARJA No. RM 175134\nBY. NY. YETY\nNama Ibu YETY NOVIATI Status Bayi' };
    expect(verifikasiIdentitas([hal], klaim)).toEqual([]);
  });
  test('assesmen neonatus bayi pasien tidak dituduh', () => {
    const hal = { page_number: 14, ocr_text: 'ASSESMEN AWAL Nama : No. RM:175134 YETY NOVIATI, BY NY\nNEONATUS Tgl Lahir : 31/12/2025' };
    expect(verifikasiIdentitas([hal], klaim)).toEqual([]);
  });
  test('pasien lain & bayi ibu lain tetap tertangkap', () => {
    expect(verifikasiIdentitas([{ page_number: 9, ocr_text: 'RESUME MEDIS\nNama : SITI AMINAH\nNo. RM : 180555' }], klaim)[0].jenis).toBe('identitas_berbeda');
    expect(verifikasiIdentitas([{ page_number: 9, ocr_text: 'ASSESMEN AWAL NEONATUS\nNama : BY NY SITI AMINAH\nNo. RM : 180555' }], klaim)[0].jenis).toBe('identitas_berbeda');
  });
});

describe('tindakan terbaca dirapikan', () => {
  const { rapikanTemuanTindakan } = require('../../services/aiReviewService');
  test('kode sama digabung; 74.99 diganti kode spesifik aturan obstetri', () => {
    const t = [['74.99', 'Sectio'], ['99.29', 'Inj'], ['99.29', 'Inj'], ['57.94', 'Kateter']]
      .map(([k, n], i) => ({ id: `ai_${k}`, nama: n, kode_usulan: k, bukti: [{ page_number: 3, kutipan: `q${i}` }] }));
    const r = rapikanTemuanTindakan(t, [{ type: 'procedure', code: '74.1', sumber_aturan: 'koding_obstetri', nama_tindakan: 'Seksio sesarea segmen bawah rahim' }]);
    expect(r.map(x => [x.kode_usulan, x.bukti.length])).toEqual([['74.1', 1], ['99.29', 2], ['57.94', 1]]);
    expect(r[0]).toMatchObject({ nama: 'Seksio sesarea segmen bawah rahim', kode_asal: '74.99' });
  });
});

describe('K3 tidak terpenuhi dari GCS kosong', () => {
  const { aggregateKriteria } = require('../../services/kegawatdaruratanAggregation');
  test('GCS null bukan "GCS 0" -> K3 tidak', () => {
    const vital = { GCS: { nilai: null, band: null, page_number: null, kutipan: null } };
    const k3 = aggregateKriteria([], vital, { status: 'tidak' }, [], [], null).find(k => k.kriteria === 'K3');
    expect(k3.status).toBe('tidak');
    expect(k3.catatan).not.toMatch(/null/);
  });
  test('GCS 10 tetap terpenuhi', () => {
    const vital = { GCS: { nilai: 10, band: 'gawat', page_number: 1, kutipan: 'GCS 10' } };
    expect(aggregateKriteria([], vital, { status: 'tidak' }, [], [], null).find(k => k.kriteria === 'K3').status).toBe('ya');
  });
});

describe('tab pemeriksaan penunjang', () => {
  const { susunPemeriksaanPenunjang } = require('../../services/pemeriksaanPenunjangService');
  const halaman = [
    { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nPemeriksaan Penunjang :\n1. DARAH RUTIN\n2. BLEEDING TIME (BT)\nHasil Konsultasi :\n-' },
    { page_number: 5, ocr_text: 'HASIL PEMERIKSAAN LABORATORIUM\nTgl.Keluar Hasil : 31-12-2025\nHEMATOLOG!\nHemoglobin 13.3 12-15 g/dL\nLokosit 9.77 4.5-11 10^3/uL\nNeutrofila 7.64 H 1.5-7 sel/mm^3\nMasa Perdarahan ( BT ) 2.30 2-7 menit\nKIMIA\nSGPT 23.0 <35 L/L IFCC\nIMUNO-SEROLOGI\nHBsAg Kualitatif Negatif Negatif' },
    { page_number: 7, ocr_text: 'RM. 46\nFHR 240 bpm MEDI-GRAPH' },
    { page_number: 19, ocr_text: 'RINCIAN BIAYA\n• CTG 150,000 1.00 150,000' },
  ];
  const r = susunPemeriksaanPenunjang(halaman);
  test('pemeriksaan yang dilakukan beserta peran buktinya', () => {
    const ctg = r.pemeriksaan.find(p => p.id === 'ctg');
    expect(ctg).toMatchObject({ kode_icd9: '75.32', ada_hasil: true });
    expect(ctg.bukti.map(b => `${b.peran}@${b.halaman}`)).toEqual(['hasil@7', 'tagihan@19']);
    const darah = r.pemeriksaan.find(p => p.id === 'lab_darah');
    expect(darah).toMatchObject({ kode_icd9: '90.59', kode_lain: [], ada_hasil: true });
    expect(darah.komponen).toEqual(expect.arrayContaining(['Darah rutin', 'BT/CT']));
    expect(darah.bukti.map(b => `${b.peran}@${b.halaman}`)).toEqual(['hasil@5', 'permintaan@3']);
    expect(r.pemeriksaan.some(p => p.id === 'darah_lengkap' || p.id === 'masa_perdarahan')).toBe(false);
  });
  test('SGOT, SGPT, HBS AG, GDS di resume masuk pemeriksaan darah', () => {
    const { pemeriksaan } = susunPemeriksaanPenunjang([{ page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nPemeriksaan Penunjang :\n1. SGOT\n2. SGPT\n3. HBS AG\n4. GLUKOSA DARAH SEWAKTU\nHasil Konsultasi :\n-' }]);
    expect(pemeriksaan.map(p => p.id)).toEqual(['lab_darah']);
    expect(pemeriksaan[0].komponen).toEqual(['SGOT/SGPT', 'HBsAg', 'Gula darah sewaktu']);
    expect(pemeriksaan[0].ada_hasil).toBe(false);
  });
  test('hasil lab per bagian, tanpa tanggal palsu & flag palsu', () => {
    const kelompok = Object.fromEntries(r.laboratorium[0].kelompok.map(k => [k.nama, k.baris]));
    expect(Object.keys(kelompok)).toEqual(['Hematologi', 'Hemostasis', 'Kimia klinik', 'Imunologi & serologi']);
    expect(kelompok.Hematologi.find(b => b.parameter === 'Leukosit')).toMatchObject({ hasil: '9.77', status: 'normal' });
    expect(kelompok.Hematologi.find(b => b.parameter === 'Neutrofil absolut').status).toBe('tinggi');
    expect(kelompok['Kimia klinik'][0]).toMatchObject({ parameter: 'SGPT (ALT)', satuan: 'U/L', flag: null });
    expect(kelompok['Imunologi & serologi'][0]).toMatchObject({ parameter: 'HBsAg Kualitatif', hasil: 'Negatif', status: 'normal' });
    expect(r.laboratorium[0].tanggal).toBe('31-12-2025');
  });
});

describe('neoplasma dari hasil PA (ANNISA NUR CHASANAH, casemix D21.3 + 86.3, L-1-40-I)', () => {
  const { lengkapiKodeNeoplasma } = require('../../services/kodingNeoplasmaService');
  const resume = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nRingkasan Penemuan Fisik Penting :\nStatus lokalis regio sternum : massa tumor diameter 5 cm, mobile\nPemeriksaan Penunjang :\n1. Laboratorium PA WASKITA\nDiagnosis Utama :\nTumor regio sternum (subfascia)\nDiagnosis Sekunder :\n1. -\nTindakan/Prosedur :\n1. Eksisi dan PA' };
  const pa = (kesimpulan, sifat = 'Sifat : Tidak didapatkan tanda ganas') => ({ page_number: 12, ocr_text: `LABORATORIUM PATOLOGI ANATOMIK\nJAWABAN PEMERIKSAAN HISTOPATOLOGI\nBahan : Massa\nMikroskopik : sel spindel\n${sifat}\nKesimpulan : ${kesimpulan}\nSaran` });
  const d492 = [{ code: 'D49.2', type: 'diagnosis', kamus_valid: false, page_number: 3, quotation: 'Tumor regio sternum (subfascia)' }];
  test('D49.2 (CM) diganti D21.3; eksisi -> 86.3; alternatif ditunjukkan', () => {
    const r = lengkapiKodeNeoplasma(d492, [resume, pa('Massa regio sternum : Gambaran histopatologi sesuai untuk keloid DD: Keloidal dermatofibroma')]);
    expect(r.saran.map(s => s.code)).toEqual(['D21.3', '86.3']);
    expect(r.saran[0].catatan_aturan).toMatch(/L91\.0/);
    const { groupCodesToInaCBG } = require('../../services/inacbgGroupingService');
    expect(groupCodesToInaCBG(['D21.3'], ['86.3', '90.59'], 'RAWAT_INAP').code).toBe('L-1-40-I');
  });
  test('lipoma punggung -> D17.1; FAM -> D24 + 85.21; kista epidermoid -> L72.0', () => {
    const r1 = (dx, kes) => lengkapiKodeNeoplasma([], [{ ...resume, ocr_text: resume.ocr_text.replace('Tumor regio sternum (subfascia)', dx) }, pa(kes)]).saran.map(s => s.code);
    expect(r1('Benjolan regio punggung', 'Lipoma')).toEqual(['D17.1', '86.3']);
    expect(r1('Tumor mammae sinistra', 'Fibroadenoma mammae')).toEqual(['D24', '85.21']);
    expect(r1('Benjolan regio colli', 'Kista epidermoid')).toEqual(['L72.0', '86.3']);
  });
  test('ganas tidak dikode otomatis; tanpa PA hanya catatan', () => {
    const ganas = lengkapiKodeNeoplasma(d492, [resume, pa('Liposarcoma', 'Sifat : ganas')]);
    expect(ganas.perubahan).toEqual([]);
    expect(ganas.catatan).toMatch(/ganas/);
    expect(lengkapiKodeNeoplasma(d492, [resume]).catatan).toMatch(/tanpa hasil PA/);
  });
  test('kasus bukan tumor tidak disentuh', () => {
    const r = lengkapiKodeNeoplasma([{ code: 'J18.9', type: 'diagnosis', kamus_valid: true }], [{ page_number: 1, ocr_text: 'RESUME MEDIS\nDiagnosis Utama :\nPneumonia' }]);
    expect(r.perubahan).toEqual([]);
  });
  test('histopatologi masuk pemeriksaan penunjang dengan kesimpulan & kode pilihan', () => {
    const { susunPemeriksaanPenunjang } = require('../../services/pemeriksaanPenunjangService');
    const { pemeriksaan } = susunPemeriksaanPenunjang([resume, pa('Massa regio sternum : keloid DD dermatofibroma')]);
    const h = pemeriksaan.find(p => p.id === 'histopatologi');
    expect(h).toMatchObject({ ada_hasil: true, sifat: 'jinak', kode_icd9: null });
    expect(h.hasil_ringkas).toMatch(/keloid/);
    expect(h.kode_lain[0].kode).toBe('91.69');
    expect(h.bukti.map(b => `${b.peran}@${b.halaman}`)).toEqual(['hasil@12', 'permintaan@3']);
  });
  test('jembatan kategori CM -> WHO', () => {
    const { JEMBATAN_CM_KE_WHO } = require('../../services/kodeDiagnosisWhoService');
    expect(JEMBATAN_CM_KE_WHO.D49).toBe('D48');
  });
});

test('diagnosis banding PA (keloid) untuk lesi yang sama tidak jadi diagnosis sekunder', () => {
  const { lengkapiKodeNeoplasma } = require('../../services/kodingNeoplasmaService');
  const resume = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nTumor regio sternum (subfascia)\nTindakan/Prosedur :\n1. Eksisi dan PA' };
  const pa = { page_number: 12, ocr_text: 'JAWABAN PEMERIKSAAN HISTOPATOLOGI\nSifat : Tidak didapatkan tanda ganas\nKesimpulan : Massa regio sternum : sesuai untuk keloid DD: Keloidal dermatofibroma\nSaran' };
  const r = lengkapiKodeNeoplasma([
    { code: 'D21.3', type: 'diagnosis', kamus_valid: true, page_number: 3, quotation: 'Tumor regio sternum (subfascia)' },
    { code: 'L91.0', type: 'diagnosis', kamus_valid: true, page_number: 12, quotation: 'keloid' },
  ], [resume, pa]);
  expect(r.saran.filter(s => s.type === 'diagnosis').map(s => s.code)).toEqual(['D21.3']);
  expect(r.perubahan).toContainEqual({ aksi: 'buang', dari: ['L91.0'], kode: 'D21.3' });
});

describe('DIAGLIST & tarif tidak pernah kosong karena kode ICD-10-CM', () => {
  const { padananGrouper, KODE_CM_KE_WHO } = require('../../services/jembatanCmWho');
  const { susunSaranKoding: susun } = require('../../services/saranKodingService');
  test('D49.x dipetakan per kode lengkap (bukan per kategori)', () => {
    expect(KODE_CM_KE_WHO['D49.2']).toBe('D48.1');
    expect(padananGrouper('D49.2')).toBe('D48.1');
    expect(padananGrouper('E08.9')).toBe('E13.9');
    expect(padananGrouper('J18.9')).toBe('J18.9');
  });
  test('grouper memberi kelompok & tarif untuk kode CM dan neoplasma jinak', () => {
    // Nilai = tabel resmi alt_diagnosis (D21.3->M-4-21, D24->L-4-14, D25.9->W-4-12);
    // D49.2 & R10.84 (kode ICD-10-CM, tak ada di tabel) via heuristik padanan WHO.
    for (const [dx, kode] of [['D49.2', 'M-4-13-I'], ['D21.3', 'M-4-21-I'], ['D24', 'L-4-14-I'], ['D25.9', 'W-4-12-I'], ['R10.84', 'K-4-17-I']]) {
      const r = hitungInacbgDanTarif([dx], [], 'RAWAT_INAP', '3', null);
      expect([dx, r.inacbgCodeForLookup]).toEqual([dx, kode]);
      expect(r.tarifResult.amount).toBeGreaterThan(0);
    }
  });
  test('kode belum-WHO tetap tampil di saran dengan catatan, tarif tetap ada', () => {
    const h = susun({ diagnosa_list: '', jenis_klaim: 'RAWAT_INAP', kelas_rawat: 3 }, {
      suggested_codes: [{ code: 'X99.99', type: 'diagnosis', kamus_valid: false, belum_who: true, page_number: 3, quotation: 'diagnosis aneh' }],
    }, hitungInacbgDanTarif);
    expect(h.diagnosis.map(d => d.kode)).toEqual(['X99.99']);
    expect(h.diagnosis[0].catatan).toMatch(/belum ada di ICD-10 WHO/);
    expect(h.tidak_dipakai).toEqual([]);
  });
  test('kode cadangan dari aplikasi bukan alasan berisiko pending', () => {
    const { susunPutusan } = require('../../services/putusanPendingService');
    const p = susunPutusan({ kode_luar_kamus: [{ kode: 'X99.99', jenis: 'diagnosis', asal: 'saran_aplikasi', pesan: 'pilih kode WHO' }] }, []);
    const a = p.alasan.find(x => x.kode === 'X99.99');
    expect(a.keparahan).toBe('sedang');
    expect(p.status).not.toBe('berisiko_pending');
  });
});
