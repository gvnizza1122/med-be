const { evaluasiKonsistensi, diagnosisCocok, terisi } = require('../../services/konsistensiAntarDataService');

const hal = (page_number, ocr_text) => ({ page_number, ocr_text });
const cari = (temuan, id) => temuan.find(t => t.id === id);

const RESUME_UMUM = hal(2, 'RESUME MEDIS IGD\nCara Masuk : Sendiri Cara Bayar : UMUM\nthorax: sdv +/+, rh +/+, wh +/+');
const TRIASE_NORMAL = hal(5, 'TRIAGE IGD\nThorak Normal\nAbdomen Normal');
const RESEP_NEBUL = hal(3, 'R/ Masker Nebul DWS 1 pcs\nR/ Ventasal (salbutamol) NEBUL');
const RESEP_LAIN = hal(3, 'R/ Paracetamol 500mg\nR/ Omeprazole 20mg');

describe('KD-01 — tindakan tanpa obat pendukung', () => {
  // Inti aturan yang diminta: kalau Data A diklaim, Data B yang menyertainya
  // harus ada. Tindakan tanpa jejak di resep adalah ketidakcocokan yang mudah
  // ditemukan verifikator.
  test('nebulisasi tercatat tapi resep tidak memuat obatnya -> temuan tinggi', () => {
    const t = evaluasiKonsistensi(
      { jenis_klaim: 'RAWAT_JALAN' },
      [hal(2, 'RESUME MEDIS\nTindakan Nebulisasi Ventasal'), RESEP_LAIN],
      [{ id: 'nebulisasi', nama: 'Nebulisasi', bukti: [{ page_number: 2, sumber: 'resume_medis', kutipan: 'Tindakan Nebulisasi Ventasal' }] }],
    );
    const f = cari(t, 'KD-01');
    expect(f).toBeDefined();
    expect(f.keparahan).toBe('tinggi');
  });

  test('obat pendukung ada di resep -> tidak ada temuan', () => {
    const t = evaluasiKonsistensi(
      { jenis_klaim: 'RAWAT_JALAN' },
      [hal(2, 'RESUME MEDIS\nTindakan Nebulisasi Ventasal'), RESEP_NEBUL],
      [{ id: 'nebulisasi', nama: 'Nebulisasi', bukti: [{ page_number: 2, sumber: 'resume_medis', kutipan: 'x' }] }],
    );
    expect(cari(t, 'KD-01')).toBeUndefined();
  });

  test('tindakan tidak terbaca -> aturan tidak berlaku, bukan temuan', () => {
    const t = evaluasiKonsistensi({ jenis_klaim: 'RAWAT_JALAN' }, [RESEP_LAIN], []);
    expect(cari(t, 'KD-01')).toBeUndefined();
  });
});

describe('KD-02 — cara bayar bertentangan dengan SEP', () => {
  // Ditemukan pada berkas MUNAWIR: resume tertulis UMUM, SEP-nya BPJS PBI.
  test('resume UMUM sementara klaim punya SEP -> temuan tinggi', () => {
    const t = evaluasiKonsistensi({ sep: '0170R0110926V001943' }, [RESUME_UMUM], []);
    const f = cari(t, 'KD-02');
    expect(f).toBeDefined();
    expect(f.keparahan).toBe('tinggi');
    expect(f.yang_ditemukan.kutipan).toMatch(/UMUM/i);
  });

  test('pasien memang umum tanpa SEP -> tidak ada temuan', () => {
    expect(cari(evaluasiKonsistensi({ sep: '' }, [RESUME_UMUM], []), 'KD-02')).toBeUndefined();
  });
});

describe('KD-10 — resume bertentangan dengan triase', () => {
  test('ronki di resume tapi triase normal -> temuan', () => {
    const t = evaluasiKonsistensi({}, [RESUME_UMUM, TRIASE_NORMAL], []);
    expect(cari(t, 'KD-10')).toBeDefined();
  });

  test('triase ikut mencatat ronki -> tidak bertentangan', () => {
    const t = evaluasiKonsistensi({}, [RESUME_UMUM, hal(5, 'TRIAGE IGD\nThorak ronkhi +')], []);
    expect(cari(t, 'KD-10')).toBeUndefined();
  });
});

describe('KD-06 / KD-07 — tindakan diklaim tanpa hasilnya', () => {
  // Yang diperiksa verifikator adalah HASILNYA, bukan ada-tidaknya tindakan.
  test('90.59 diklaim tanpa isi laboratorium -> temuan', () => {
    const t = evaluasiKonsistensi({ prosedur_list: '90.59' }, [hal(1, 'SEP')], []);
    expect(cari(t, 'KD-06')).toBeDefined();
  });

  test('90.59 dengan hasil lab -> tidak ada temuan', () => {
    const t = evaluasiKonsistensi({ prosedur_list: '90.59' }, [hal(4, 'HEMATOLOGI\nLeukosit 11.000')], []);
    expect(cari(t, 'KD-06')).toBeUndefined();
  });

  // Aturan ini sengaja memeriksa ISI halaman, bukan jenis halaman. Diuji ke 41
  // klaim produksi: klasifikasi gagal mengenali halaman lab pada 4 klaim yang
  // jelas memuat hematologi, sehingga versi berbasis klasifikasi menghasilkan
  // alarm palsu.
  test('isi lab dikenali walau halamannya tidak terklasifikasi sebagai lab', () => {
    const t = evaluasiKonsistensi(
      { prosedur_list: '90.59' },
      [hal(4, 'TRIAGE IGD\nLampiran\nHemoglobin 12.1 Trombosit 250')],
      [],
    );
    expect(cari(t, 'KD-06')).toBeUndefined();
  });

  test('87.44 tanpa bacaan radiologi -> temuan', () => {
    expect(cari(evaluasiKonsistensi({ prosedur_list: '87.44' }, [hal(1, 'SEP')], []), 'KD-07')).toBeDefined();
  });

  test('87.44 dengan bacaan radiologi -> tidak ada temuan', () => {
    const t = evaluasiKonsistensi({ prosedur_list: '87.44' }, [hal(6, 'Kesan: tampak infiltrat paru kanan')], []);
    expect(cari(t, 'KD-07')).toBeUndefined();
  });
});

describe('KD-03 / KD-04 — kelengkapan klaim', () => {
  test('rawat inap tanpa tanggal keluar -> temuan', () => {
    const t = evaluasiKonsistensi({ jenis_klaim: 'RAWAT_INAP', discharge_date: '' }, [], []);
    expect(cari(t, 'KD-03')).toBeDefined();
  });

  test('rawat jalan tidak dituntut tanggal keluar', () => {
    const t = evaluasiKonsistensi({ jenis_klaim: 'RAWAT_JALAN', discharge_date: '' }, [], []);
    expect(cari(t, 'KD-03')).toBeUndefined();
  });

  test('penanda ICU tanpa lama rawat ICU -> temuan', () => {
    const t = evaluasiKonsistensi({ icu_indikator: 1, icu_los: 0 }, [], []);
    expect(cari(t, 'KD-04')).toBeDefined();
  });

  // Kolom numerik banyak yang DEFAULT 0 di skema; 0 berarti kosong, bukan nilai.
  test('penanda ICU bernilai 0 berarti tidak ICU, bukan temuan', () => {
    expect(cari(evaluasiKonsistensi({ icu_indikator: 0 }, [], []), 'KD-04')).toBeUndefined();
    expect(terisi(0)).toBe(false);
    expect(terisi('-')).toBe(false);
    expect(terisi('3')).toBe(true);
  });
});

describe('kehati-hatian', () => {
  test('klaim kosong tidak menghasilkan temuan liar', () => {
    expect(evaluasiKonsistensi({}, [], [])).toEqual([]);
    expect(evaluasiKonsistensi(null, [], [])).toEqual([]);
  });

  // Seluruh aturan AKTIF. Sebelumnya masuk sebagai catatan yang menunggu
  // telaah koder, tapi itu berarti koder memeriksa ulang apa yang sudah
  // diperiksa sistem — kerja dua kali. Aturan yang ternyata keliru diperbaiki
  // atau dimatikan di berkas aturannya, bukan dengan menahan seluruhnya.
  test('seluruh aturan aktif', () => {
    const t = evaluasiKonsistensi({ prosedur_list: '90.59;87.44' }, [hal(1, 'SEP')], []);
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(x.diverifikasi).toBe(true);
  });

  test('setiap temuan membawa dasar aturannya', () => {
    const t = evaluasiKonsistensi({ prosedur_list: '90.59' }, [hal(1, 'SEP')], []);
    expect(cari(t, 'KD-06').sumber_aturan).toBeTruthy();
  });

  test('kekhususan kode diagnosis dihormati', () => {
    expect(diagnosisCocok('J18.9', 'J18')).toBe(true);
    expect(diagnosisCocok('J180', 'J18')).toBe(false);
    expect(diagnosisCocok('I67.9', 'I67.8')).toBe(false);
  });
});
