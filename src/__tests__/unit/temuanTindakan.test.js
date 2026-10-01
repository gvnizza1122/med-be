const { bacaTemuanTindakan, periksaSilangTindakan } = require('../../services/temuanTindakanService');

const hal = (page_number, ocr_text) => ({ page_number, ocr_text });

// Potongan nyata dari berkas 0170R0110926V001943 (MUNAWIR, IGD).
const RESUME = hal(2, 'RESUME MEDIS IGD\nA Diagnosa\nPPOK,\nPneumonia\nPenyebab Cedera: -\nP\nTindakan Nebulisasi Ventasal\nRencana Rawat jalan');
const RESEP = hal(3, 'R/ Masker Nebul DWS 1 pcs\n2 R/ Ventasal (salbutamol) NEBUL 1 -');
const TRIASE_KOSONG = hal(4, 'TRIAGE IGD\nRisiko Jatuh\nTindakan\nEvaluasi');
const TRIASE_ISI = hal(5, 'TRIAGE IGD\nIntervensi Keperawatan Tindakan Keperawatan\nKaji KU dan TTV\nnebul ventasal 1 ; nacl 2cc\nEvaluasi');

describe('bacaTemuanTindakan — nebulisasi yang sebelumnya tidak terbaca', () => {
  // Nebulisasi tertulis tiga kali di berkas ini, tapi daftar prosedurnya
  // kosong. PROCLIST hanya memuat kode final dari koder — ia tidak pernah
  // mencatat apa yang tertulis di berkas.
  test('terbaca dari ketiga halaman sekaligus', () => {
    const t = bacaTemuanTindakan([RESUME, RESEP, TRIASE_KOSONG, TRIASE_ISI]);
    const nebul = t.find(x => x.id === 'nebulisasi');
    expect(nebul).toBeDefined();
    expect(nebul.bukti.map(b => b.sumber).sort()).toEqual(['resep', 'resume_medis', 'triase_igd']);
  });

  test('membawa kutipan dan nomor halaman, bukan sekadar nama tindakan', () => {
    const nebul = bacaTemuanTindakan([RESUME])[0];
    expect(nebul.bukti[0].page_number).toBe(2);
    expect(nebul.bukti[0].kutipan).toMatch(/Nebulisasi Ventasal/);
  });

  // Kode adalah USULAN. Apakah ia masuk daftar prosedur tetap wewenang koder
  // casemix — aplikasi membaca, bukan memutuskan.
  test('kode disertakan sebagai usulan', () => {
    expect(bacaTemuanTindakan([RESUME])[0].kode_usulan).toBe('93.94');
  });

  // Kode yang belum dipastikan koder sengaja dibiarkan kosong. Kode karangan
  // jauh lebih berbahaya daripada kolom kosong.
  test('tindakan yang kodenya belum pasti tidak diberi kode tebakan', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nTindakan pasang infus Asering')]);
    const infus = t.find(x => x.id === 'pemasangan_infus');
    expect(infus.kode_usulan).toBeNull();
    expect(infus.catatan_kode).toMatch(/belum dipastikan/i);
  });
});

describe('bacaTemuanTindakan — jebakan label', () => {
  // Kata "Tindakan" muncul di beberapa tempat dengan arti berbeda. Yang di
  // Risiko Jatuh isinya kosong; mengambilnya berarti menautkan tindakan ke
  // bagian yang salah.
  test('label "Tindakan" yang kosong tidak menghasilkan temuan', () => {
    expect(bacaTemuanTindakan([TRIASE_KOSONG])).toEqual([]);
  });

  test('daftar tindakan keperawatan berhenti di bagian berikutnya', () => {
    const t = bacaTemuanTindakan([
      hal(5, 'TRIAGE IGD\nTindakan Keperawatan\nKaji KU dan TTV\nEvaluasi\nnebul ventasal'),
    ]);
    // "nebul" ada SETELAH "Evaluasi", jadi bukan bagian dari daftar tindakan.
    expect(t).toEqual([]);
  });

  test('halaman tanpa tindakan tidak menghasilkan apa-apa', () => {
    expect(bacaTemuanTindakan([hal(1, 'SURAT ELEGIBILITAS PESERTA\nNo. SEP 0170R011')])).toEqual([]);
    expect(bacaTemuanTindakan([])).toEqual([]);
    expect(bacaTemuanTindakan(null)).toEqual([]);
  });
});

describe('periksaSilangTindakan', () => {
  // Pengecekan ini bekerja bahkan ketika pembacaan kolom resume gagal karena
  // tata letak — itulah yang membuatnya paling cepat menangkap kasus seperti ini.
  test('resep menyebut nebul tapi resume tidak -> peringatan', () => {
    const t = bacaTemuanTindakan([RESEP, TRIASE_ISI]);
    const c = periksaSilangTindakan(t);
    expect(c).toHaveLength(1);
    expect(c[0].jenis).toBe('tindakan_tidak_ada_di_resume');
    expect(c[0].pesan).toMatch(/resep/);
  });

  test('resume sudah memuatnya -> tidak ada peringatan', () => {
    const t = bacaTemuanTindakan([RESUME, RESEP, TRIASE_ISI]);
    expect(periksaSilangTindakan(t)).toEqual([]);
  });

  // Resep hanya memberi petunjuk. Yang tidak tertulis tidak boleh dikodekan,
  // jadi hasilnya peringatan untuk diperiksa manusia — bukan tindakan baru
  // yang ditambahkan sendiri oleh sistem.
  test('yang dihasilkan peringatan, bukan tindakan tambahan', () => {
    const c = periksaSilangTindakan(bacaTemuanTindakan([RESEP]));
    expect(c[0].keparahan).toBe('sedang');
    expect(c[0].pesan).toMatch(/Periksa apakah/i);
  });

  test('tanpa temuan aman', () => {
    expect(periksaSilangTindakan([])).toEqual([]);
    expect(periksaSilangTindakan(null)).toEqual([]);
  });
});

describe('halaman resep dikenali', () => {
  const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');

  // Sebelumnya resep jatuh ke 'lainnya' dan tidak pernah dilihat — padahal di
  // situ bukti tindakan sering tercatat.
  test('penanda R/ mengenali halaman resep', () => {
    expect(classifyPageDocumentType('1 R/ Masker Nebul DWS 1 pcs')).toBe('resep');
    expect(classifyPageDocumentType('RESEP\nObat pulang')).toBe('resep');
  });

  test('huruf R biasa tidak tertukar jadi resep', () => {
    expect(classifyPageDocumentType('Pasien R pada pemeriksaan')).toBe('lainnya');
    expect(classifyPageDocumentType('RESUME MEDIS\nDiagnosa: J18')).toBe('resume_medis');
  });
});

describe('injeksi obat — kasus SUMIDAH', () => {
  const RESUME_INJ = hal(2, 'RESUME MEDIS\nA Diagnosa kolik abdomen\nP\nTindakan\ninj omeprazole 1A\ninj ondansentron 1A\ninj ketorolac 1A\nRencana blpl');

  // Kolom Tindakan memuat tiga injeksi berurutan. Membaca satu baris saja
  // membuat dua di antaranya hilang.
  test('injeksi di daftar bawah label terbaca', () => {
    const t = bacaTemuanTindakan([RESUME_INJ]);
    expect(t.map(x => x.kode_usulan)).toEqual(['99.29']);
  });

  // ICD-9-CM membedakan antibiotik dari zat terapeutik lain, jadi keduanya
  // tidak boleh disatukan demi kemudahan.
  test('antibiotik dikode 99.21, bukan 99.29', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nTindakan\ninj ceftriaxone 1gr\nRencana')]);
    expect(t.map(x => x.kode_usulan)).toEqual(['99.21']);
  });

  // Satu suntikan antibiotik cocok dengan pola antibiotik DAN pola injeksi
  // umum. Kalau keduanya lolos, satu tindakan menghasilkan dua kode — koding
  // ganda, dan justru jenis kesalahan yang dicari verifikator.
  test('antibiotik tidak menghasilkan kode ganda', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nTindakan\ninj ceftriaxone 1gr\nRencana')]);
    expect(t.map(x => x.kode_usulan)).not.toContain('99.29');
  });

  test('antibiotik dan obat lain pada klaim yang sama menghasilkan keduanya', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nTindakan\ninj ceftriaxone 1gr\ninj omeprazole 1A\nRencana')]);
    expect(t.map(x => x.kode_usulan).sort()).toEqual(['99.21', '99.29']);
  });

  // Obat yang diresepkan belum tentu disuntikkan. Resep adalah rencana;
  // kolom Tindakan adalah catatan bahwa itu benar dikerjakan.
  test('injeksi di resep TIDAK diambil sebagai tindakan', () => {
    expect(bacaTemuanTindakan([hal(3, 'R/ Omeprazole inj 1 amp\nR/ Paracetamol tab')])).toEqual([]);
  });

  // Nilai bisa berada di baris labelnya sendiri, bukan hanya di bawahnya.
  test('bentuk sebaris tetap terbaca', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nTindakan Nebulisasi Ventasal\nRencana Rawat jalan')]);
    expect(t.map(x => x.kode_usulan)).toEqual(['93.94']);
  });

  test('pemindaian berhenti di bagian berikutnya', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nTindakan\nRencana\ninj omeprazole 1A')]);
    expect(t).toEqual([]);
  });
});

// Berkas 0170R0110826V000019 (poli THT, H61.2): kolom Tindakan resume berisi
// "ekstraksi serumen" dan dulu tidak terbaca sama sekali.
describe('ekstraksi serumen', () => {
  test('dari posisi kolom Tindakan resume -> 96.52', () => {
    const halaman = [{
      page_number: 2,
      ocr_text: 'RESUME MEDIS RAWAT JALAN\nA Diagnosa H61.2 - Impacted cerumen\nTindakan\nP Rencana -',
      nilai_label: { Tindakan: 'ekstraksi serumen' },
    }];
    const t = bacaTemuanTindakan(halaman);
    expect(t.map(x => [x.id, x.kode_usulan])).toEqual([['ekstraksi_serumen', '96.52']]);
    expect(t[0].bukti[0]).toMatchObject({ page_number: 2, sumber: 'resume_medis' });
  });

  test('diagnosis "impacted serumen" bukan tindakan', () => {
    expect(bacaTemuanTindakan([hal(2, 'RESUME MEDIS\nDiagnosa impacted serumen\nTindakan\n-')])).toEqual([]);
  });
});

// Salinan scan berkas 0170R0110826V000083: teks OCR resume menaruh isi kolom
// Tindakan SATU BARIS DI ATAS labelnya, dan dokter menulis "Nebulizer".
describe('isi kolom Tindakan di atas label (teks OCR resume)', () => {
  const resume = (isiAtas) => hal(2, `RESUME MEDIS IGD\nDiagnosa\nR06.0 - Dyspnoea\nJ45.3 - Asthma with Exacerbation (IM)\n${isiAtas}Tindakan\nP Rencana Boleh pulang\nAnjuran kontrol FKTP`);

  test('"Nebulizer Ventasal" di atas label -> nebulisasi 93.94', () => {
    const t = bacaTemuanTindakan([resume('Nebulizer Ventasal : Budesma = 1 : 1\n')]);
    expect(t.map(x => [x.id, x.kode_usulan])).toEqual([['nebulisasi', '93.94']]);
    expect(t[0].bukti[0]).toMatchObject({ page_number: 2, sumber: 'resume_medis' });
  });

  test('kolom Tindakan kosong: baris diagnosis di atasnya tidak terbaca sebagai tindakan', () => {
    expect(bacaTemuanTindakan([hal(2, 'RESUME MEDIS IGD\nDiagnosa\nJ45.3 - Asthma, rencana nebulizer\nTindakan\nP Rencana -')])).toEqual([]);
  });
});
