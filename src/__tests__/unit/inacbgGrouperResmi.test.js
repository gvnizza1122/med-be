/**
 * Grouper INA-CBG berbasis tabel resmi E-Klaim: harus mereproduksi lembar
 * grouper casemix (ground truth) dan mengisi base dari tabel resmi, bukan
 * tebakan heuristik.
 */
const { grouperResmi, tarifResmi, PROFIL } = require('../../services/inacbgGrouperResmi');
const { groupCodesToInaCBG } = require('../../services/inacbgGroupingService');

describe('grouper resmi vs lembar grouper casemix (ground truth)', () => {
  // 5 kasus dengan lembar grouper E-Klaim nyata (DB lokal). Semua rawat inap
  // kelas 3, Regional 1, profil DS. Kode + tarif harus sama persis.
  const GOLD = [
    { nama: 'PASIEN CONTOH A', dx: ['I51.7'], px: ['90.59', '89.52', '87.44'], code: 'I-4-24-I', tarif: 2116600 },
    { nama: 'ANNISA', dx: ['D21.3'], px: ['86.3', '90.59'], code: 'L-1-40-I', tarif: 3811600 },
    { nama: 'MUSTAKIMAH', dx: ['T31.1', 'T20.2', 'T22.2', 'T23.2', 'T24.2', 'X09.5', 'I10'], px: ['86.22', '90.59', '87.44', '89.52'], code: 'S-4-16-I', tarif: 3908200 },
    { nama: 'AMAN', dx: ['K40.3'], px: ['53.05', '90.59', '89.52'], code: 'K-1-14-I', tarif: 4283800 },
    { nama: 'IBU CONTOH', dx: ['O42.1', 'Z37.0', 'O82.1'], px: ['74.1', '75.32', '90.59'], code: 'O-6-10-I', tarif: 4656700 },
  ];

  test.each(GOLD)('$nama -> $code Rp$tarif', ({ dx, px, code, tarif }) => {
    const r = grouperResmi(dx, px, 'RAWAT_INAP', 3);
    expect(r).not.toBeNull();
    expect(r.code).toBe(code);
    expect(r.tarif).toBe(tarif);
    // via jalur yang masuk akal (prosedur bedah atau diagnosis), bukan karangan
    expect(['prosedur', 'diagnosis']).toContain(r.via);
    // groupCodesToInaCBG terintegrasi juga harus menghasilkan kode yang sama
    expect(groupCodesToInaCBG(dx, px, 'RAWAT_INAP').code).toBe(code);
  });
});

describe('aturan pemilihan base dari tabel resmi', () => {
  test('opsi diagnosis: buang grup bedah, ambil non-bedah pertama', () => {
    // T31 -> "L-1-20,S-4-16": L-1-20 bedah (butuh prosedur) -> S-4-16.
    expect(grouperResmi(['T31.1'], [], 'RAWAT_INAP', 3).base).toBe('S-4-16');
    // P07.3 -> "P-8-17,Z-4-12": keduanya non-bedah -> opsi pertama P-8-17.
    expect(grouperResmi(['P07.3'], [], 'RAWAT_INAP', 3).base).toBe('P-8-17');
  });

  test('prosedur bedah menang & dipilih dari hierarki resmi', () => {
    // 2 prosedur: 54.11->K-1-40 (rank lebih tinggi) mengalahkan 47.09->K-1-13.
    expect(grouperResmi(['K35.8'], ['47.09', '54.11'], 'RAWAT_INAP', 3).base).toBe('K-1-40');
  });

  test('penunjang rutin tanpa base IP tidak menggerakkan kelompok RI; nebulisasi OP memiliki base sendiri', () => {
    expect(grouperResmi(['I51.7'], ['87.44', '89.52', '90.59'], 'RAWAT_INAP', 3).base).toBe('I-4-24');
    expect(grouperResmi(['J45.9'], ['93.94'], 'RAWAT_JALAN', 3).base).toBe('J-3-13');
  });

  test('kode tak dikenal -> null (tidak mengarang)', () => {
    expect(grouperResmi(['U09.9'], [], 'RAWAT_INAP', 3)).toBeNull();
  });
});

describe('hierarki rawat jalan dan batas bukti prosedur', () => {
  test.each([
    ['93.57', 'Z-3-27'], ['88.78', 'Z-3-25'], ['88.76', 'Z-3-23'], ['96.52', 'U-3-15'],
  ])('prosedur OP %s tetap diperiksa dari kolom Outpatient', (px, base) => {
    expect(grouperResmi(['Z09.8'], [px], 'RAWAT_JALAN').base).toBe(base);
  });
  test('urutan input tidak mengganti prioritas: resusitasi di atas terapi pernapasan, dialisis di atas transfusi', () => {
    for (const px of [['93.96', '99.60'], ['99.60', '93.96']]) {
      expect(grouperResmi(['R57.0'], px, 'RAWAT_JALAN')).toMatchObject({ base: 'I-3-10', base_perlu_verifikasi: true });
    }
    expect(grouperResmi(['N18.5'], ['99.04', '39.95'], 'RAWAT_JALAN').base).toBe('N-3-15');
  });
  test('hierarki tindakan besar OP didahulukan dari tindakan signifikan OP', () => {
    expect(grouperResmi(['H25.9'], ['99.60', '13.71'], 'RAWAT_JALAN').base).toMatch(/^H-2-/);
  });
  test('nomor prosedur >=87 yang memiliki base IP tidak dibuang', () => {
    expect(grouperResmi(['I25.1'], ['88.56'], 'RAWAT_INAP').via).toBe('prosedur');
    expect(grouperResmi(['J96.0'], ['96.04'], 'RAWAT_INAP').base).toBe('J-1-20');
  });
  test('diagnosis antepartum tanpa prosedur persalinan tidak memberi tarif sesar', () => {
    expect(grouperResmi(['O32.2'], [], 'RAWAT_JALAN').code).toBe('Q-5-23-0');
  });
  test('konseling belum membuktikan MCU atau ECG; prosedur nyata membedakan layanan', () => {
    expect(grouperResmi(['Z71.9'], [], 'RAWAT_JALAN')).toMatchObject({ code: 'Q-5-18-0', base_perlu_verifikasi: true });
    expect(grouperResmi(['Z71.9'], ['89.52'], 'RAWAT_JALAN').code).toBe('Q-5-15-0');
    expect(grouperResmi(['Z71.9'], [], 'RAWAT_JALAN').reasoning).not.toMatch(/Severity I/);
  });
  test('kode pemeriksaan umum tidak menjadi kelompok jiwa untuk diagnosis non-jiwa', () => {
    expect(grouperResmi(['Z09.8'], ['89.03'], 'RAWAT_JALAN').code).toBe('Q-5-44-0');
  });
});

describe('tarif resmi & profil', () => {
  test('profil default Regional 1 / DS', () => {
    expect(PROFIL).toMatchObject({ regional: 'reg1', kode_tarif: 'DS' });
  });
  test('tarif per kelas kamar', () => {
    expect(tarifResmi('A-4-13-II', 3, 'RAWAT_INAP').tarif).toBe(1972200);
    expect(tarifResmi('A-4-13-II', 1, 'RAWAT_INAP').tarif).toBeGreaterThan(tarifResmi('A-4-13-II', 3, 'RAWAT_INAP').tarif);
  });
  test('kode rawat jalan bertarif tunggal (kelas 0)', () => {
    const t = tarifResmi('Q-5-44-0', '', 'RAWAT_JALAN');
    expect(t.tarif).toBeGreaterThan(0);
  });
});

describe('perkiraan severity memakai daftar CC resmi (hanya bisa menurunkan)', () => {
  test('diagnosis sekunder bukan CC resmi tidak menaikkan severity', () => {
    // IBU CONTOH + O41.0 oligohidramnion: O41.0 bukan CC di cclist -> tetap I.
    expect(groupCodesToInaCBG(['O42.1', 'O41.0', 'Z37.0', 'O82.1'], ['74.1', '75.32', '90.59'], 'RAWAT_INAP').code).toBe('O-6-10-I');
  });
  test('CC resmi tetap ditampilkan sebagai kandidat, tanpa otomatis menetapkan tingkat II', () => {
    // PASIEN CONTOH A + J81 edema paru: J81 CC di cclist.
    expect(groupCodesToInaCBG(['I51.7', 'J81'], [], 'RAWAT_INAP')).toMatchObject({ code: 'I-4-24-I', cc_potensial: ['J81'], severity_status: 'belum_terverifikasi' });
  });
});
