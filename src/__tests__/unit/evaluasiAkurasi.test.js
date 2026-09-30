const path = require('path');
const contoh = require('../fixtures/kunciJawaban/example.json');
const {
  normalKode, kategoriKode, hitungKode, hitungLab, hitungDikarang, didukungBerkas,
  evaluasiKlaim, evaluasiSemua, klasifikasiKesalahan, klasifikasiKlaim, levenshtein,
} = require('../../services/evaluasiAkurasiService');
const { utama, bacaArgumen, bacaDaftar } = require('../../../scripts/evaluasiKunciJawaban');

describe('normalisasi kode', () => {
  test('titik, spasi, huruf kecil tidak memengaruhi', () => {
    expect(normalKode('j45.9')).toBe('J459');
    expect(normalKode(' J45 9 ')).toBe('J459');
    expect(normalKode(null)).toBe('');
  });
  test('kategori: diagnosis 3 karakter, prosedur 2 angka', () => {
    expect(kategoriKode('J45.9', 'diagnosis')).toBe('J45');
    expect(kategoriKode('96.04', 'prosedur')).toBe('96');
  });
});

describe('hitungKode: tertangkap, tepat, kategori terpisah', () => {
  test('semua benar', () => {
    const r = hitungKode(['J45.9', 'I10'], ['j45.9', 'I10'], 'diagnosis');
    expect(r.tertangkap).toBe(1);
    expect(r.tepat_rasio).toBe(1);
    expect(r.kategori_saja).toBe(0);
  });

  test('recall dan precision berbeda: satu terlewat, satu berlebih', () => {
    const r = hitungKode(['J45.9', 'I10'], ['J45.9', 'E11.9', 'K29.7'], 'diagnosis');
    expect(r.tepat).toBe(1);
    expect(r.tertangkap).toBeCloseTo(0.5);
    expect(r.tepat_rasio).toBeCloseTo(1 / 3);
    expect(r.daftar.terlewat).toEqual(['I10']);
    expect(r.daftar.salah).toEqual(['E119', 'K297']);
  });

  test('kategori sama dihitung terpisah, tidak masuk Tepat', () => {
    const r = hitungKode(['K29.7'], ['K29.1'], 'diagnosis');
    expect(r.tepat).toBe(0);
    expect(r.tepat_rasio).toBe(0);
    expect(r.kategori_saja).toBe(1);
    expect(r.tepat_kategori).toBe(1);
    expect(r.daftar.salah).toEqual([]);
  });

  test('satu kode benar tidak dipakai dua kali untuk kategori', () => {
    const r = hitungKode(['K29.7'], ['K29.1', 'K29.0'], 'diagnosis');
    expect(r.kategori_saja).toBe(1);
    expect(r.daftar.salah).toHaveLength(1);
  });

  test('kunci kosong: rasio null, bukan 0 atau NaN', () => {
    const r = hitungKode([], ['I10'], 'diagnosis');
    expect(r.tertangkap).toBeNull();
    expect(r.tepat_rasio).toBe(0);
    expect(hitungKode(['I10'], [], 'diagnosis').tepat_rasio).toBeNull();
  });

  test('entri objek dan duplikat', () => {
    const r = hitungKode(['J45.9'], [{ kode: 'J45.9' }, 'J45.9'], 'diagnosis');
    expect(r.jumlah_sistem).toBe(1);
    expect(r.tepat).toBe(1);
  });
});

describe('hitungLab: parameter + nilai + satuan semua benar', () => {
  const benar = [{ parameter: 'Hemoglobin', nilai: 10.2, satuan: 'g/dL' }];

  test('alias parameter dan koma desimal', () => {
    const r = hitungLab(benar, [{ parameter: 'Hb', nilai: '10,2', satuan: 'g/dl' }]);
    expect(r.nilai_lab_tepat).toBe(1);
  });

  test('nilai benar tetapi satuan salah tidak dihitung tepat', () => {
    const r = hitungLab(benar, [{ parameter: 'Hb', nilai: 10.2, satuan: 'mg/dL' }]);
    expect(r.nilai_tepat).toBe(1);
    expect(r.nilai_lab_tepat).toBe(0);
    expect(r.daftar[0].status).toBe('satuan_salah');
  });

  test('nilai salah, dan parameter tidak ditemukan', () => {
    expect(hitungLab(benar, [{ parameter: 'Hb', nilai: 12, satuan: 'g/dL' }]).daftar[0].status).toBe('nilai_salah');
    expect(hitungLab(benar, []).daftar[0].status).toBe('tidak_ditemukan');
  });

  test('tanggal berbeda menjadi baris berbeda', () => {
    const b = [
      { parameter: 'Trombosit', nilai: 150000, satuan: '/uL', tanggal: '2026-03-10' },
      { parameter: 'Trombosit', nilai: 90000, satuan: '/uL', tanggal: '2026-03-12' },
    ];
    const r = hitungLab(b, [
      { parameter: 'Trombosit', nilai: 90000, satuan: '/uL', tanggal: '2026-03-12' },
      { parameter: 'Trombosit', nilai: 150000, satuan: '/uL', tanggal: '2026-03-10' },
    ]);
    expect(r.nilai_lab_tepat).toBe(1);
  });
});

describe('kode dikarang', () => {
  const halaman = [{ page_number: 1, ocr_text: 'Diagnosa: Asma bronkial (J45.9)\nProsedur 87.44' }];

  test('kode yang tertulis di berkas atau punya kutipan sah didukung', () => {
    expect(didukungBerkas('J45.9', halaman)).toBe(true);
    expect(didukungBerkas('J459', halaman)).toBe(true);
    expect(didukungBerkas({ kode: 'I10', kutipan: 'asma bronkial', halaman: 1 }, halaman)).toBe(true);
  });

  test('kode tanpa kutipan dan tidak tertulis: dikarang', () => {
    const r = hitungDikarang(['J45.9', 'J45.909'], ['87.44'], halaman);
    expect(r.dinilai).toBe(true);
    expect(r.jumlah).toBe(1);
    expect(r.kode).toEqual([{ jenis: 'diagnosis', kode: 'J45.909' }]);
  });

  test('kutipan yang tidak ada di halaman tidak menyelamatkan kode', () => {
    expect(didukungBerkas({ kode: 'Z99.9', kutipan: 'gagal ginjal', halaman: 1 }, halaman)).toBe(false);
  });

  test('tanpa teks berkas: tidak dinilai, bukan nol', () => {
    expect(hitungDikarang(['J45.9'], [], [])).toEqual({ dinilai: false, jumlah: null, kode: [] });
  });
});

describe('evaluasiSemua dengan example.json', () => {
  const hasil = evaluasiSemua(contoh.kunci, contoh.keluaran);
  const a = hasil.agregat;

  test('agregat sesuai hitungan tangan', () => {
    expect(a.jumlah_klaim).toBe(2);
    expect(a.diagnosis).toMatchObject({ jumlah_benar: 3, jumlah_sistem: 3, tepat: 1, kategori_saja: 1 });
    expect(a.diagnosis.tertangkap).toBeCloseTo(1 / 3);
    expect(a.diagnosis.tepat_kategori).toBeCloseTo(2 / 3);
    expect(a.prosedur.tertangkap).toBe(1);
    expect(a.lab).toMatchObject({ jumlah_benar: 3, nilai_lab_tepat_count: 2 });
    expect(a.kode_dikarang).toMatchObject({ jumlah: 1, klaim_dinilai: 1, klaim_tidak_dinilai: 1, tercapai: false });
  });

  test('klaim tanpa keluaran dilaporkan, keluaran tanpa kunci dilaporkan', () => {
    const h = evaluasiSemua([{ klaim_id: 'A', diagnosis_benar: ['I10'] }, { klaim_id: 'B' }], [{ klaim_id: 'A', diagnosis: ['I10'] }, { klaim_id: 'X' }]);
    expect(h.agregat.klaim_tanpa_keluaran).toEqual(['B']);
    expect(h.keluaran_tanpa_kunci).toEqual(['X']);
  });

  test('klaim tanpa keluaran menurunkan tertangkap (tidak diam-diam dibuang)', () => {
    const h = evaluasiSemua([{ klaim_id: 'A', diagnosis_benar: ['I10'] }], []);
    expect(h.agregat.diagnosis.tertangkap).toBe(0);
  });

  test('target nol tercapai bila semua kode didukung', () => {
    const k = evaluasiKlaim({ klaim_id: 'A', diagnosis_benar: ['J45.9'] },
      { diagnosis: ['J45.9'], halaman: [{ page_number: 1, text: 'asma J45.9' }] });
    expect(evaluasiSemua([{ klaim_id: 'A' }], [{ klaim_id: 'A', diagnosis: ['J45.9'], halaman: [{ page_number: 1, text: 'asma J45.9' }] }]).agregat.kode_dikarang.tercapai).toBe(true);
    expect(k.kode_dikarang.jumlah).toBe(0);
  });
});

describe('klasifikasiKesalahan tipe 1-5', () => {
  const halaman = [{ page_number: 1, ocr_text: 'Diagnosa Utama: Asma bronkial\nRh -/-' }];

  test('tipe 4: kode tidak ada di tabel referensi', () => {
    const r = klasifikasiKesalahan({ jenis: 'diagnosis', sistem: 'J45.909' }, { kodeReferensi: { diagnosis: new Set(['J45.9']) } });
    expect(r.tipe).toBe(4);
    expect(r.keyakinan).toBe('tinggi');
  });

  test('tipe 4: kode tidak ada di teks berkas', () => {
    const r = klasifikasiKesalahan({ jenis: 'diagnosis', sistem: 'J45.909' }, { halaman });
    expect(r.tipe).toBe(4);
  });

  test('tipe 4 tidak dituduhkan bila kode ada di tabel dan berkas mendukung', () => {
    const r = klasifikasiKesalahan({ jenis: 'diagnosis', sistem: 'J45.9', benar: 'I10' },
      { halaman: [{ page_number: 1, text: 'J45.9' }], kodeReferensi: { diagnosis: new Set(['J45.9']) } });
    expect(r.tipe).not.toBe(4);
  });

  test('tipe 3: temuan disangkal dibaca ada', () => {
    const r = klasifikasiKesalahan({ jenis: 'penunjang', sistem: 'ronkhi', teks_sistem: 'ronkhi', kutipan: 'Rh -/-' }, { halaman });
    expect(r.tipe).toBe(3);
    expect(klasifikasiKesalahan({ jenis: 'penunjang', sistem: 'x', disangkal: true }).tipe).toBe(3);
  });

  test('tipe 3: singkatan bertabrakan (DC) dipilih tanpa dasar', () => {
    const r = klasifikasiKesalahan({ jenis: 'prosedur', sistem: 'kateter', teks_sistem: 'DC' });
    expect(r.tipe).toBe(3);
  });

  test('tipe 2: nilai lab benar tetapi milik baris/tanggal lain', () => {
    const benarList = [
      { parameter: 'Trombosit', nilai: 150000, satuan: '/uL', tanggal: '2026-03-10' },
      { parameter: 'Trombosit', nilai: 90000, satuan: '/uL', tanggal: '2026-03-12' },
    ];
    const r = klasifikasiKesalahan({ jenis: 'lab', sistem: { parameter: 'Trombosit', nilai: 150000, tanggal: '2026-03-12' }, benar: benarList[1] }, { nilaiLabBenar: benarList });
    expect(r.tipe).toBe(2);
    const lain = klasifikasiKesalahan({ jenis: 'lab', sistem: { parameter: 'Leukosit', nilai: 12.3 }, benar: { parameter: 'Leukosit', nilai: 9500 } },
      { nilaiLabBenar: [{ parameter: 'Hemoglobin', nilai: 12.3 }, { parameter: 'Leukosit', nilai: 9500 }] });
    expect(lain.tipe).toBe(2);
  });

  test('tipe 5: tulisan tangan', () => {
    expect(klasifikasiKesalahan({ jenis: 'prosedur', sistem: 'foo', sumber: 'tulisan_tangan' }).tipe).toBe(5);
  });

  test('tipe 1: huruf O pada angka, geser desimal, satu digit, kode mirip', () => {
    expect(klasifikasiKesalahan({ jenis: 'lab', sistem: { parameter: 'Hb', nilai: 10.2, nilai_teks: '1O,2' }, benar: { parameter: 'Hb', nilai: 12.2 } }).tipe).toBe(1);
    expect(klasifikasiKesalahan({ jenis: 'lab', sistem: { parameter: 'Hb', nilai: 120 }, benar: { parameter: 'Hb', nilai: 12 } }).tipe).toBe(1);
    expect(klasifikasiKesalahan({ jenis: 'lab', sistem: { parameter: 'Hb', nilai: 10.8 }, benar: { parameter: 'Hb', nilai: 10.3 } }).tipe).toBe(1);
    expect(klasifikasiKesalahan({ jenis: 'diagnosis', sistem: 'J4S.9', benar: 'J45.9' }).tipe).toBe(1);
    expect(klasifikasiKesalahan({ jenis: 'penunjang', sistem: 'tborax', teks_sistem: 'tborax', benar: 'thorax' }).tipe).toBe(1);
  });

  test('kode berbeda satu digit BUKAN otomatis tipe 1 (tidak ditentukan)', () => {
    const r = klasifikasiKesalahan({ jenis: 'diagnosis', sistem: 'K29.1', benar: 'K29.7' });
    expect(r.tipe).toBeNull();
    expect(r.nama).toBe('tidak_dapat_ditentukan');
  });
});

describe('klasifikasiKlaim', () => {
  test('example.json: satu tipe 2, satu tipe 4, satu tidak dapat ditentukan', () => {
    const h = evaluasiSemua(contoh.kunci, contoh.keluaran);
    const total = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, tidak_dapat_ditentukan: 0 };
    h.per_klaim.forEach((k, i) => {
      const c = klasifikasiKlaim(k, contoh.kunci[i], contoh.keluaran[i]);
      Object.keys(total).forEach(t => { total[t] += c.per_tipe[t]; });
    });
    expect(total).toMatchObject({ 2: 1, 4: 1, tidak_dapat_ditentukan: 1 });
  });
});

describe('levenshtein', () => {
  test('jarak', () => {
    expect(levenshtein('thorax', 'tborax')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

describe('CLI evaluasiKunciJawaban', () => {
  const berkas = path.join(__dirname, '..', 'fixtures', 'kunciJawaban', 'example.json');
  let log; let err;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); err = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); err.mockRestore(); });

  test('berjalan pada example.json dan mencetak ukuran utama', () => {
    expect(utama(['--berkas', berkas])).toBe(0);
    const keluar = log.mock.calls.map(c => c[0]).join('\n');
    expect(keluar).toMatch(/Tertangkap/);
    expect(keluar).toMatch(/Kode dikarang: 1 \(target 0\)/);
  });

  test('--json menghasilkan JSON sah', () => {
    utama(['--berkas', berkas, '--json']);
    const j = JSON.parse(log.mock.calls[0][0]);
    expect(j.agregat.jumlah_klaim).toBe(2);
    expect(j.klasifikasi.per_tipe[4]).toBe(1);
  });

  test('--gagal-bila-dikarang memberi kode keluar 1', () => {
    expect(utama(['--berkas', berkas, '--gagal-bila-dikarang'])).toBe(1);
  });

  test('argumen kurang memberi kode 2; berkas tak ada memberi kode 2', () => {
    expect(utama([])).toBe(2);
    expect(utama(['--berkas', path.join(__dirname, 'tidak-ada.json')])).toBe(2);
  });

  test('bacaArgumen dan bacaDaftar', () => {
    expect(bacaArgumen(['--kunci', 'a', '--keluaran', 'b', '--json'])).toMatchObject({ kunci: 'a', keluaran: 'b', json: true });
    expect(bacaDaftar(berkas, 'kunci')).toHaveLength(2);
  });
});
