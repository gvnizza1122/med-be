const {
  evaluasiSyaratPenunjang, bacaNilaiLab, cariKataKunci, kodeCocok, STATUS,
} = require('../../services/syaratPenunjangService');

const hal = (page_number, ocr_text) => ({ page_number, ocr_text });

describe('kodeCocok — kekhususan kode dihormati', () => {
  test('kode klaim yang lebih khusus kena aturan umum', () => {
    expect(kodeCocok('J18.9', 'J18')).toBe(true);
    expect(kodeCocok('J18.0', 'J18')).toBe(true);
    expect(kodeCocok('J18', 'J18')).toBe(true);
  });

  // Aturan I67.8 lahir dari kalimat verifikator tentang I67.8 saja. Memicunya
  // untuk I67.9 berarti menerapkan aturan ke diagnosis yang tidak pernah
  // dipersoalkan.
  test('kode aturan yang khusus TIDAK terpicu oleh kode yang lebih umum', () => {
    expect(kodeCocok('I67', 'I67.8')).toBe(false);
    expect(kodeCocok('I67.9', 'I67.8')).toBe(false);
  });

  test('kemiripan awalan tanpa pembatas titik tidak dihitung', () => {
    expect(kodeCocok('J180', 'J18')).toBe(false);
    expect(kodeCocok('J1', 'J18')).toBe(false);
  });
});

describe('bacaNilaiLab', () => {
  test('membaca angka dengan koma desimal ala berkas RS', () => {
    expect(bacaNilaiLab([hal(3, 'Hemoglobin : 7,2 g/dL')], 'hemoglobin').nilai).toBe(7.2);
  });

  test('mengenali singkatan Hb', () => {
    expect(bacaNilaiLab([hal(1, 'Hb 9.4')], 'hemoglobin').nilai).toBe(9.4);
  });

  test('mengenali ejaan creatinin maupun kreatinin', () => {
    expect(bacaNilaiLab([hal(1, 'Creatinin 2,1 mg/dL')], 'kreatinin').nilai).toBe(2.1);
    expect(bacaNilaiLab([hal(1, 'Kreatinin 1.8')], 'kreatinin').nilai).toBe(1.8);
  });

  // Berkas kerap memuat beberapa pemeriksaan dari hari berbeda. Untuk ambang
  // "Hb di bawah 8", yang menentukan adalah nilai terendah yang pernah
  // tercatat — bukan yang kebetulan tercetak paling atas.
  test('mengambil nilai terendah bila ada beberapa', () => {
    const halaman = [hal(3, 'Hb 9.5'), hal(4, 'Hb 7.1'), hal(5, 'Hb 8.8')];
    expect(bacaNilaiLab(halaman, 'hemoglobin').nilai).toBe(7.1);
  });

  test('menyimpan kutipan dan nomor halaman', () => {
    const t = bacaNilaiLab([hal(4, 'HEMATOLOGI Hemoglobin : 7,2 g/dL')], 'hemoglobin');
    expect(t.page_number).toBe(4);
    expect(t.kutipan).toMatch(/7,2/);
  });

  test('tidak ada nilainya menghasilkan null, bukan angka tebakan', () => {
    expect(bacaNilaiLab([hal(1, 'tidak dilakukan pemeriksaan lab')], 'hemoglobin')).toBeNull();
    expect(bacaNilaiLab([], 'hemoglobin')).toBeNull();
  });
});

describe('cariKataKunci', () => {
  test('menemukan temuan radiologi beserta halamannya', () => {
    const t = cariKataKunci([hal(7, 'Kesan: tampak infiltrat di paru kanan')], ['infiltrat', 'konsolidasi']);
    expect(t.kata).toBe('infiltrat');
    expect(t.page_number).toBe(7);
  });

  test('tidak ditemukan menghasilkan null', () => {
    expect(cariKataKunci([hal(1, 'dalam batas normal')], ['infiltrat'])).toBeNull();
  });
});

describe('evaluasiSyaratPenunjang — empat keadaan', () => {
  // Tingkat 1: kode prosedur ada. Tingkat 2: hasilnya tertulis.
  test('tindakan ada DAN hasil terbaca -> terpenuhi', () => {
    const t = evaluasiSyaratPenunjang('J18.9', '87.44', [hal(7, 'tampak infiltrat paru kanan')]);
    const rontgen = t[0].syarat.find(s => s.nama === 'Rontgen toraks');
    expect(rontgen.status).toBe(STATUS.TERPENUHI);
    expect(rontgen.tindakan_ada).toBe(true);
  });

  // Inilah keadaan yang membuat sistem berbahaya kalau berhenti di Tingkat 1:
  // tindakan tercatat, tapi hasilnya tidak pernah terbaca di berkas — dan
  // hasil itulah yang diperiksa verifikator.
  test('tindakan ada tapi hasil tidak terbaca -> status tersendiri, bukan centang hijau', () => {
    const t = evaluasiSyaratPenunjang('J18.9', '87.44', [hal(7, 'halaman tanpa hasil radiologi')]);
    const rontgen = t[0].syarat.find(s => s.nama === 'Rontgen toraks');
    expect(rontgen.status).toBe(STATUS.HASIL_BELUM_TERBACA);
    expect(rontgen.status).not.toBe(STATUS.TERPENUHI);
    expect(rontgen.tindakan_ada).toBe(true);
  });

  test('tidak ada tindakan dan tidak ada hasil -> tidak ada', () => {
    const t = evaluasiSyaratPenunjang('J18.9', '93.94', [hal(1, 'nebulisasi')]);
    const gram = t[0].syarat.find(s => s.nama === 'Pemeriksaan gram sputum');
    expect(gram.status).toBe(STATUS.TIDAK_ADA);
    expect(gram.tindakan_ada).toBe(false);
  });

  // Daftar obat di berkas RS ini berbentuk tabel berkolom yang nyaris tidak
  // terbaca OCR — diperiksa pada 6 klaim J18 di server, yang tersisa hanya
  // potongan seperti "Lwopexarin". Melaporkannya "tidak ada" berarti menuduh
  // pasien pneumonia tidak diberi antibiotik, padahal yang gagal adalah
  // pembacaannya.
  test('syarat yang tidak dapat dinilai mesin -> perlu cek manual, bukan tuduhan', () => {
    const t = evaluasiSyaratPenunjang('J18.9', '87.44', [hal(1, 'apa pun isinya')]);
    const ab = t[0].syarat.find(s => s.nama.includes('Antibiotik'));
    expect(ab.status).toBe(STATUS.PERLU_CEK_MANUAL);
    expect(ab.status).not.toBe(STATUS.TIDAK_ADA);
    expect(ab.catatan_batasan).toMatch(/tidak dapat diperiksa sistem/i);
  });
});

describe('evaluasiSyaratPenunjang — ambang nilai lab (Tipe 1)', () => {
  test('Hb di bawah 8 memenuhi syarat anemia penyakit kronis', () => {
    const t = evaluasiSyaratPenunjang('D63.8', '90.59', [hal(3, 'Hemoglobin : 7,2 g/dL')]);
    const hb = t[0].syarat[0];
    expect(hb.status).toBe(STATUS.TERPENUHI);
    expect(hb.nilai).toBe(7.2);
    expect(hb.memenuhi_ambang).toBe(true);
  });

  // Justru inilah kalimat verifikatornya: "pada pasien nilai HB masih diatas 8,
  // hapus kode anaemia". Nilai yang terbaca tapi tidak memenuhi ambang bukan
  // "belum terbaca" — itu bukti bahwa syaratnya tidak terpenuhi.
  test('Hb di atas 8 TIDAK memenuhi, dan itu dinyatakan tegas', () => {
    const t = evaluasiSyaratPenunjang('D63.8', '90.59', [hal(3, 'Hemoglobin : 9,4 g/dL')]);
    const hb = t[0].syarat[0];
    expect(hb.nilai).toBe(9.4);
    expect(hb.memenuhi_ambang).toBe(false);
    expect(hb.status).toBe(STATUS.TIDAK_ADA);
  });

  test('ambangnya ikut dilaporkan supaya bisa dipertanggungjawabkan', () => {
    const t = evaluasiSyaratPenunjang('D63.8', '90.59', [hal(3, 'Hb 7.0')]);
    expect(t[0].syarat[0].ambang).toBe('< 8 g/dL');
  });

  // Syaratnya KENAIKAN dari baseline, sedangkan berkas klaim tidak memuat
  // baseline pasien. Batasan itu harus dinyatakan, bukan disamarkan jadi
  // kesimpulan.
  test('kreatinin: keterbatasan baseline dinyatakan terbuka', () => {
    const t = evaluasiSyaratPenunjang('N17.9', '90.59', [hal(3, 'Creatinin 2,1')]);
    const kr = t[0].syarat[0];
    expect(kr.nilai).toBe(2.1);
    expect(kr.catatan_batasan).toMatch(/baseline/i);
  });
});

describe('evaluasiSyaratPenunjang — kehati-hatian', () => {
  // Panel di layar hanya muncul kalau ada yang perlu dilihat. Menampilkan
  // "tidak ada syarat" di setiap klaim cuma menambah panjang halaman.
  test('diagnosis tanpa syarat tidak menghasilkan temuan apa pun', () => {
    expect(evaluasiSyaratPenunjang('K30', '90.59', [])).toEqual([]);
    expect(evaluasiSyaratPenunjang('J40;K30', '87.44', [])).toEqual([]);
  });

  test('diagnosis kosong aman', () => {
    expect(evaluasiSyaratPenunjang('', '', [])).toEqual([]);
    expect(evaluasiSyaratPenunjang(null, null, null)).toEqual([]);
  });

  // Tim casemix RS Lestari Raharja mengesahkan kelima aturan pada 23 Sep 2026,
  // sehingga semuanya aktif. Sebelum itu statusnya belum diverifikasi dan
  // temuannya tidak ikut dihitung sebagai peringatan di layar.
  //
  // Status ini tetap diuji karena menentukan apakah sebuah aturan boleh
  // memunculkan peringatan. Ambangnya berasal dari kesepakatan lokal dengan
  // BPJS setempat; kalau sistem dipakai RS lain, seluruh ambang wajib
  // ditelaah ulang dan status ini dikembalikan ke false.
  test('kelima aturan sudah disahkan tim casemix', () => {
    const t = evaluasiSyaratPenunjang('J18.9;D63.8;N17.9;I67.8;O14.1', '', []);
    expect(t).toHaveLength(5);
    for (const aturan of t) expect(aturan.diverifikasi).toBe(true);
  });

  // Kalimat asli verifikator membuat tiap aturan bisa dipertanggungjawabkan:
  // jawabannya bukan "karena aturannya begitu" melainkan kutipan nyata dari
  // klaim yang dulu ditolak.
  test('setiap aturan membawa kutipan sumbernya', () => {
    const t = evaluasiSyaratPenunjang('J18.9', '', []);
    expect(t[0].sumber_aturan).toMatch(/pemeriksaan gram/i);
  });

  test('beberapa diagnosis bersyarat sekaligus terdeteksi semua', () => {
    const t = evaluasiSyaratPenunjang('J18.9;D63.8', '87.44', [hal(3, 'Hb 7.0')]);
    expect(t.map(x => x.id).sort()).toEqual(['SP-01', 'SP-04']);
  });
});
