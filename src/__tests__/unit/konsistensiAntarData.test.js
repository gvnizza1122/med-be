const { evaluasiKonsistensi, diagnosisCocok, terisi, periksaSilangDiagnosisPrimer } = require('../../services/konsistensiAntarDataService');

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

  test.each([
    ['Tindakan Keperawatan\nNebul ventasal : Budesma 1:1', false],
    ['Catatan pemberian obat\nDiberikan nebul budesma 0.5 mg', false],
    ['Intervensi Keperawatan\nRencana nebul ventasal : Budesma 1:1', true],
    ['Tindakan Keperawatan\nBelum diberikan nebul ventasal : Budesma 1:1', true],
    ['Tindakan Keperawatan\nVentasal : Budesma 1:1', true],
    ['Tindakan Keperawatan\nNebul ventasal : Budesma', true],
  ])('bukti pelaksanaan obat di luar halaman resep: %s', (teks, perluBukti) => {
    const t = evaluasiKonsistensi({}, [RESEP_LAIN, hal(9, teks)],
      [{id:'nebulisasi',bukti:[{page_number:3,kutipan:'Tindakan nebulisasi'}]}]);
    expect(Boolean(cari(t, 'KD-01'))).toBe(perluBukti);
  });
});

describe('KD-02 — SEP menjadi dasar penjamin BPJS', () => {
  test.each([{ sep: '0000R0000126V000004' }, { SEP: '0000R0000126V000004' }])('resume UMUM dengan SEP tidak menjadi alasan pending (%j)', record => {
    expect(cari(evaluasiKonsistensi(record, [RESUME_UMUM], []), 'KD-02')).toBeUndefined();
  });
  test('pasien umum tanpa SEP tetap tidak mendapat temuan pertentangan penjamin', () => {
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

describe('KD-14 — DIAGLIST tidak cocok dengan resume medis (verifikasi silang)', () => {
  // Kasus NUR ASIAH sungguhan (SEP 0000R0000126V000005, backtest 2026-10-01):
  // DIAGLIST dari halaman Berkas Klaim Individual = I51.7;I48. Resume medis
  // (hal. 3) menulis "susp syok kardiogenik", "dyspneu susp ec ALO",
  // "hemiparese sinistra ec post snh" -- R57.0/J81.0/I69.3, kategori lain
  // sama sekali. Alasan pending BPJS sungguhan untuk klaim ini justru soal
  // diagnosis utama -- inilah yang seharusnya tertangkap.
  test('kasus NUR ASIAH: tidak ada irisan kategori -> KD-14 muncul', () => {
    const suggested = [
      { type: 'diagnosis', code: 'R57.0', page_number: 3, quotation: 'susp syok kardiogenik', kamus_valid: true },
      { type: 'diagnosis', code: 'J81.0', page_number: 3, quotation: 'dyspneu susp ec ALO', kamus_valid: false }, // tidak dihitung
      { type: 'diagnosis', code: 'I69.3', page_number: 3, quotation: 'hemiparese sinistra ec post snh', kamus_valid: true },
    ];
    const t = periksaSilangDiagnosisPrimer({ DIAGLIST: 'I51.7;I48' }, suggested);
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe('KD-14');
    expect(t[0].keparahan).toBe('sedang');
    expect(t[0].diverifikasi).toBe(false);
    expect(t[0].yang_ditemukan.kutipan).toBe('susp syok kardiogenik');
  });

  // Kasus DWI ARIYANI sungguhan (SEP 0000R0000126V000006): DIAGLIST
  // I11.9;H81.4;K30, AI cuma menemukan I25.9 ("3. IHD") dari resume --
  // kategori I25 vs I11/H81/K30, tidak beririsan juga.
  test('kasus DWI ARIYANI: satu-satunya temuan resume beda kategori -> KD-14 muncul', () => {
    const suggested = [{ type: 'diagnosis', code: 'I25.9', page_number: 3, quotation: '3. IHD', kamus_valid: true }];
    const t = periksaSilangDiagnosisPrimer({ DIAGLIST: 'I11.9;H81.4;K30' }, suggested);
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe('KD-14');
  });

  test('ada irisan kategori -> tidak ada temuan', () => {
    const suggested = [{ type: 'diagnosis', code: 'I48.0', page_number: 2, quotation: 'atrial fibrilasi', kamus_valid: true }];
    expect(periksaSilangDiagnosisPrimer({ DIAGLIST: 'I51.7;I48' }, suggested)).toEqual([]);
  });

  test('DIAGLIST kosong -> diam, ditangani pemeriksaan lain', () => {
    expect(periksaSilangDiagnosisPrimer({ DIAGLIST: '' }, [{ type: 'diagnosis', code: 'R57.0', kamus_valid: true }])).toEqual([]);
  });

  test('tidak ada temuan resume sama sekali -> diam, tidak menuduh tanpa bahan', () => {
    expect(periksaSilangDiagnosisPrimer({ DIAGLIST: 'I51.7;I48' }, [])).toEqual([]);
  });

  test('saran yang disangkal tidak dihitung sebagai bukti', () => {
    const suggested = [{ type: 'diagnosis', code: 'R57.0', kamus_valid: true, disangkal: true }];
    expect(periksaSilangDiagnosisPrimer({ DIAGLIST: 'I51.7' }, suggested)).toEqual([]);
  });

  test('saran yang belum tervalidasi kamus (kamus_valid bukan true) tidak dihitung', () => {
    const suggested = [{ type: 'diagnosis', code: 'R57.0', kamus_valid: false }];
    expect(periksaSilangDiagnosisPrimer({ DIAGLIST: 'I51.7' }, suggested)).toEqual([]);
  });

  test('tidak melempar untuk record null/undefined', () => {
    expect(periksaSilangDiagnosisPrimer(null, [])).toEqual([]);
    expect(periksaSilangDiagnosisPrimer(undefined, [])).toEqual([]);
  });
});

describe('kutipan bukti tidak memotong kata', () => {
  const { kutipanBaris } = require('../../services/konsistensiAntarDataService');

  test('mengambil baris utuh tempat kata ditemukan', () => {
    const teks = 'Pemeriksaan Fisik\nkepala: ca -/-, si -/-,\nthorax: sdv +/+, rh +/+, wh +/+';
    expect(kutipanBaris(teks, teks.indexOf('rh +/+'))).toBe('thorax: sdv +/+, rh +/+, wh +/+');
  });

  test('baris pendek digabung dengan baris berikutnya', () => {
    const teks = 'Diagnosa\nPPOK,\nPneumonia\nPenyebab Cedera: -';
    expect(kutipanBaris(teks, teks.indexOf('PPOK'))).toBe('PPOK, Pneumonia');
  });

  test('baris sangat panjang dipotong di batas kata, bukan di tengah kata', () => {
    const teks = `${'kata '.repeat(60)}rh +/+ ${'lain '.repeat(60)}`;
    const k = kutipanBaris(teks, teks.indexOf('rh +/+'));
    expect(k).toContain('rh +/+');
    expect(k.length).toBeLessThanOrEqual(166);
    expect(k.replace(/…/g, '').trim().split(/\s+/).every(w => ['kata', 'lain', 'rh', '+/+'].includes(w))).toBe(true);
  });
});

describe('KD-03/KD-04/KD-11 pada record alur sungguhan (nama kolom huruf besar)', () => {
  test('rawat inap tanpa DISCHARGE_DATE -> KD-03', () => {
    expect(cari(evaluasiKonsistensi({ JENIS_KLAIM: 'RAWAT_INAP', DISCHARGE_DATE: '' }, [], []), 'KD-03')).toBeDefined();
    expect(cari(evaluasiKonsistensi({ JENIS_KLAIM: 'RAWAT_INAP', DISCHARGE_DATE: '05/08/2026' }, [], []), 'KD-03')).toBeUndefined();
  });

  test('ICU_INDIKATOR terisi tanpa ICU_LOS -> KD-04', () => {
    expect(cari(evaluasiKonsistensi({ ICU_INDIKATOR: '1', ICU_LOS: '0' }, [], []), 'KD-04')).toBeDefined();
  });
});

test('baris utuh yang tidak bersambung tidak ditempeli label berikutnya', () => {
  const { kutipanBaris } = require('../../services/konsistensiAntarDataService');
  const teks = 'Cara Bayar : UMUM\nAlergi Obat\n-';
  expect(kutipanBaris(teks, teks.indexOf('Cara Bayar'))).toBe('Cara Bayar : UMUM');
});

describe('KD-01 bukti nebulisasi dari terapi resume dan rincian biaya', () => {
  const { cekKondisi, kelompokkanHalaman } = require('../../services/konsistensiAntarDataService');
  const aturan = require('../../data/konsistensiAntarData.json').aturan.find(a => a.id === 'KD-01');
  const cek = (halaman) => cekKondisi(aturan.maka, { record: {}, petaHalaman: kelompokkanHalaman(halaman), tindakan: [] });
  test('terapi selama di rumah sakit pada resume memuat obat nebul (Lasalcom)', () => {
    const resume = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama : BRPN\nTerapi/pengobatan selama di rumah sakit :\n(9) Paracetamol syr\n(10) Lasalcom (ipratropium+salbu) NEBU\nReaksi Obat dan Terapi :\nTidak' };
    expect(cek([resume])).toMatchObject({ benar: true, bukti: { kata: 'terapi_resume', page_number: 3 } });
  });
  test('rincian biaya alat/obat nebulisasi', () => {
    const tagihan = { page_number: 14, ocr_text: 'DETAIL RINCIAN BIAYA\nTgl Rawat : 2 Jan 2026 - 4 Jan 2026\nPerincian Harga Jml Biaya\n• Nebulaizer 50,000 7.00 350,000\n• Masker Nebul ANAK 1 34,825\nTotal' };
    expect(cek([tagihan])).toMatchObject({ benar: true, bukti: { kata: 'rincian_biaya' } });
  });
  test('rencana nebul di luar daftar terapi resume tidak dihitung', () => {
    const resume = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nInstruksi/Anjuran : rencana nebul ventolin bila sesak\nTerapi Pulang :\nAmbroxol syr' };
    expect(cek([resume]).benar).toBe(false);
  });
});
