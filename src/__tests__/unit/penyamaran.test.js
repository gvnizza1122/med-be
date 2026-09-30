const { buatPenyamar } = require('../../services/penyamaranService');

describe('penyamaranService — pola otomatis', () => {
  test('nomor kartu BPJS 13 digit dan NIK 16 digit', () => {
    const p = buatPenyamar();
    const out = p.samarkan('Kartu 0001234567890 NIK 3374010101900001 selesai');
    expect(out).toBe('Kartu [KARTU_1] NIK [NIK_1] selesai');
    expect(p.pulihkan(out)).toBe('Kartu 0001234567890 NIK 3374010101900001 selesai');
  });

  test('angka 12 atau 14 digit tidak disentuh', () => {
    const p = buatPenyamar();
    const t = 'kode 123456789012 dan 12345678901234';
    expect(p.samarkan(t)).toBe(t);
  });

  test('nomor SEP berformat dan berlabel', () => {
    const p = buatPenyamar();
    const out = p.samarkan('SEP 0123R0010725V000123 dan No. SEP: ABC12345678');
    expect(out).not.toMatch(/0123R0010725V000123/);
    expect(out).not.toMatch(/ABC12345678/);
    expect(out).toContain('[SEP_1]');
    expect(out).toContain('[SEP_2]');
  });

  test('telepon/HP Indonesia berbagai bentuk', () => {
    const p = buatPenyamar();
    const out = p.samarkan('HP 081234567890, wa +62 812-3456-7890, telp: 0274-555123');
    expect(out).not.toMatch(/08123/);
    expect(out).not.toMatch(/812-3456/);
    expect(out).not.toMatch(/555123/);
    expect(p.ringkasan().TELP).toBeGreaterThanOrEqual(2);
  });

  test('No RM berlabel dipulihkan persis', () => {
    const p = buatPenyamar();
    const asli = 'No. RM: 00-12-34-56 poli penyakit dalam';
    const out = p.samarkan(asli);
    expect(out).toBe('No. RM: [RM_1] poli penyakit dalam');
    expect(p.pulihkan(out)).toBe(asli);
  });

  test('alamat berlabel sampai akhir baris dan berawalan Jl.', () => {
    const p = buatPenyamar();
    const out = p.samarkan('Alamat: Jl. Kenanga No 5 RT 02/03, Sleman\nDiagnosa: pneumonia');
    expect(out).toBe('Alamat: [ALAMAT_1]\nDiagnosa: pneumonia');
    const out2 = p.samarkan('tinggal di Jl. Melati 10 Yogyakarta');
    expect(out2).toContain('[ALAMAT_');
    expect(out2).not.toMatch(/Melati/);
  });

  test('nama berlabel berhenti di label berikutnya (baris OCR menyatu)', () => {
    const p = buatPenyamar();
    const out = p.samarkan('Nama Pasien: BUDI SANTOSO No RM: 123456 Umur 45');
    expect(out).toContain('Nama Pasien: [NAMA_1]');
    expect(out).not.toMatch(/BUDI/);
    expect(out).toContain('[RM_1]');
    expect(out).toContain('Umur 45');
  });

  test('nama dokter tidak ikut disamarkan', () => {
    const p = buatPenyamar();
    const t = 'Nama Dokter: dr. Ahmad Fauzi, Sp.PD';
    expect(p.samarkan(t)).toBe(t);
  });

  test('gelar keluarga + nama', () => {
    const p = buatPenyamar();
    const out = p.samarkan('Pasien Tn. Agus Prasetyo datang, By. Ny. Siti Aminah lahir');
    expect(out).not.toMatch(/Agus|Prasetyo|Siti|Aminah/);
  });
});

describe('penyamaranService — identitas dikenal & reversibilitas', () => {
  const dikenal = {
    nama: 'Siti Rahayu Ningsih',
    nomor_kartu: '0001234567890',
    nik: '3374010101900001',
    no_rm: '123456',
    sep: '0123R0010725V000123',
    alamat: 'Dusun Karang RT 3 Bantul',
    telepon: '081234567890',
  };

  test('nama tanpa label tertangkap lewat daftar dikenal, termasuk urutan terbalik dan pecahan', () => {
    const p = buatPenyamar(dikenal);
    const out = p.samarkan('Ibu Siti Rahayu Ningsih mengeluh sesak. RAHAYU, Siti. Kata Ningsih: batuk.');
    expect(out).not.toMatch(/Siti|Rahayu|Ningsih/i);
    expect(p.pulihkan(out)).toContain('Siti Rahayu Ningsih');
  });

  test('digit dikenal dicocokkan walau disisipi spasi/strip', () => {
    const p = buatPenyamar(dikenal);
    const out = p.samarkan('kartu 0001-2345-67890 dan rm 123 456?');
    expect(out).not.toMatch(/0001-2345-67890/);
  });

  test('nilai sama -> token sama; jenis berbeda -> token berbeda', () => {
    const p = buatPenyamar(dikenal);
    const out = p.samarkan('0001234567890 lalu 0001234567890 lagi; 3374010101900001');
    expect(out).toBe('[KARTU_1] lalu [KARTU_1] lagi; [NIK_1]');
  });

  test('round trip objek bersarang', () => {
    const p = buatPenyamar(dikenal);
    const payload = {
      prompt: 'Pasien Siti Rahayu Ningsih, kartu 0001234567890',
      daftar: ['SEP 0123R0010725V000123', { alamat: 'Dusun Karang RT 3 Bantul' }],
      angka: 5,
      kosong: null,
    };
    const aman = p.samarkanObjek(payload);
    const teksAman = JSON.stringify(aman);
    for (const rahasia of ['Siti', 'Ningsih', '0001234567890', '0123R0010725V000123', 'Dusun Karang']) {
      expect(teksAman).not.toContain(rahasia);
    }
    expect(aman.angka).toBe(5);
    expect(aman.kosong).toBeNull();
    expect(p.pulihkanObjek(aman)).toEqual(payload);
  });

  test('pulihkan mengabaikan token asing dan toleran huruf kecil', () => {
    const p = buatPenyamar(dikenal);
    p.samarkan('Siti Rahayu Ningsih');
    expect(p.pulihkan('[NAMA_9] dan [nama_1] dan [FOO_1]')).toBe('[NAMA_9] dan Siti Rahayu Ningsih dan [FOO_1]');
  });

  test('tanpa identitas, teks klinis lewat tanpa berubah', () => {
    const p = buatPenyamar();
    const t = 'TD 120/80, Hb 7,5 g/dL, kreatinin 1,8 mg/dL. Diagnosa J18.9 pneumonia. Tarif 4.250.000.';
    expect(p.samarkan(t)).toBe(t);
    expect(p.jumlahToken()).toBe(0);
  });

  test('ringkasan tidak membocorkan nilai asli', () => {
    const p = buatPenyamar(dikenal);
    p.samarkan('0001234567890');
    expect(JSON.stringify(p.ringkasan())).not.toContain('0001234567890');
  });

  test('batas yang diakui: nama bebas yang tidak diketahui TIDAK tertangkap', () => {
    const p = buatPenyamar();
    const t = 'suaminya bernama Slamet datang menjenguk';
    expect(p.samarkan(t)).toBe(t); // dokumentasi keterbatasan, bukan bug
  });
});
