const {
  verifikasiIdentitas, ekstrakNama, ekstrakNoRm, namaCocok, kemungkinanSalahBacaRm,
} = require('../../services/identitasLintasHalamanService');

const KLAIM = { nama_pasien: 'MUHAMMAD AQMAR ELFATIH, AN', mrn: '160642' };
const hal = (page_number, ocr_text) => ({ page_number, ocr_text });

describe('verifikasiIdentitas — menangkap halaman milik pasien lain', () => {
  // Inilah yang harus tetap tertangkap. Halaman nyasar membuat klaim dinilai
  // dari kondisi klinis orang lain, dan pembenaran yang dikirim ke BPJS jadi
  // tidak berasal dari pasien yang diklaim.
  test('nama DAN No RM sama-sama beda -> keparahan tinggi', () => {
    const temuan = verifikasiIdentitas(
      [hal(4, 'Nama : SITI AMINAH WIJAYA\nNo RM : 998877\nHasil Laboratorium')],
      KLAIM,
    );
    expect(temuan).toHaveLength(1);
    expect(temuan[0].jenis).toBe('identitas_berbeda');
    expect(temuan[0].keparahan).toBe('tinggi');
    expect(temuan[0].page_number).toBe(4);
  });

  test('halaman yang benar tidak menghasilkan temuan apa pun', () => {
    const temuan = verifikasiIdentitas(
      [hal(1, 'Nama : MUHAMMAD AQMAR ELFATIH\nNo RM : 160642')],
      KLAIM,
    );
    expect(temuan).toEqual([]);
  });

  test('halaman tanpa identitas dilewati, bukan dicurigai', () => {
    const temuan = verifikasiIdentitas(
      [hal(2, 'Hasil pemeriksaan penunjang\nKesan: dalam batas normal')],
      KLAIM,
    );
    expect(temuan).toEqual([]);
  });
});

describe('verifikasiIdentitas — tidak menuduh tanpa dasar', () => {
  // Semua kasus di blok ini diambil dari 36 klaim sungguhan di server.
  // Sebelum aturannya diperbaiki, semuanya memicu alarm "pasien berbeda".

  test('nama hancur dibaca OCR -> keparahan rendah, bukan tuduhan', () => {
    const temuan = verifikasiIdentitas(
      [hal(9, 'Nama : goukThan MAnGEL HAN')],
      { nama_pasien: 'LEONATHAN MARCEL H, AN', mrn: '170001' },
    );
    expect(temuan).toHaveLength(1);
    expect(temuan[0].jenis).toBe('nama_tidak_cocok');
    expect(temuan[0].keparahan).toBe('rendah');
  });

  test('judul kolom tabel obat bukan nama pasien', () => {
    expect(ekstrakNama('Nama Obat Oral DOSIS')).toBeNull();
    expect(ekstrakNama('Nama Obat Injeksi')).toBeNull();
    expect(ekstrakNama('Nama infus')).toBeNull();
    expect(verifikasiIdentitas([hal(9, 'Nama Obat Oral DOSIS JUMLAH')], KLAIM)).toEqual([]);
  });

  test('sisa label "Nama Peserta" yang salah baca diabaikan', () => {
    expect(ekstrakNama('Nama Peseria')).toBeNull();
  });

  test('potongan OCR terlalu pendek bukan nama', () => {
    expect(ekstrakNama('Nama ora')).toBeNull();
  });

  test('spasi yang hilang tidak membuat pasien dianggap beda', () => {
    expect(namaCocok('IKA MARWATI, NY', 'IKAMARWATI')).toBe(true);
  });

  test('satu huruf meleset tetap orang yang sama', () => {
    expect(namaCocok('MUHAMMAD AQMAR ELFATIH, AN', 'MUHAMMAD AQMAR ELFATIM')).toBe(true);
  });

  // Nama depan yang lazim di Indonesia tidak boleh jadi dasar kesimpulan
  // apa pun, ke arah mana pun.
  test('hanya nama depan umum yang sama -> tidak pasti, bukan cocok', () => {
    expect(namaCocok('MUHAMMAD AQMAR ELFATIH', 'MUHAMMAD RIZKI SAPUTRA')).toBeNull();
  });
});

describe('No RM', () => {
  // "Normal" mengandung "No" + "rm". Tanpa pemisah wajib, kata ini terbaca
  // sebagai No RM -- benar-benar terjadi pada teks OCR di server.
  test('kata "Normal" tidak terbaca sebagai No RM', () => {
    expect(ekstrakNoRm('Normal ECG Hpi Fb Ei i ii ns')).toBeNull();
  });

  test('berbagai bentuk penulisan di berkas nyata terbaca', () => {
    expect(ekstrakNoRm('NO RM : 00305609 NO. REGISTER')).toBe('00305609');
    expect(ekstrakNoRm('No.RM : 160642 No.Permintaan Lab')).toBe('160642');
    expect(ekstrakNoRm('NoRM: 160642')).toBe('160642');
    expect(ekstrakNoRm('No.RM - 178076')).toBe('178076');
    expect(ekstrakNoRm('No RM 114931')).toBe('114931');
  });

  test('selisih satu digit dinilai salah baca OCR', () => {
    expect(kemungkinanSalahBacaRm('172338', '172339')).toBe(true);
    expect(kemungkinanSalahBacaRm('114831', '114931')).toBe(true);
    expect(kemungkinanSalahBacaRm('1178341', '178341')).toBe(true); // digit tersisip
  });

  test('nomor yang benar-benar lain tidak disebut salah baca', () => {
    expect(kemungkinanSalahBacaRm('160642', '00305609')).toBe(false);
    expect(kemungkinanSalahBacaRm('303570', '178385')).toBe(false);
  });

  // Dokumen rujukan dari faskes lain membawa nomor rekam medis faskes
  // tersebut. Pasiennya sama, jadi ini bukan masalah -- cukup dicatat.
  test('No RM beda tapi nama cocok -> info dokumen faskes lain', () => {
    const temuan = verifikasiIdentitas(
      [hal(5, 'RS Soerojo Magelang\nNO RM : 00305609\nNAMA : MUHAMMAD AQMAR ELFATIM')],
      KLAIM,
    );
    expect(temuan).toHaveLength(1);
    expect(temuan[0].jenis).toBe('rm_faskes_lain');
    expect(temuan[0].keparahan).toBe('info');
  });

  test('No RM beda dan nama tak terbaca -> diserahkan ke manusia', () => {
    const temuan = verifikasiIdentitas([hal(6, 'NO RM : 998877\nHasil Radiologi')], KLAIM);
    expect(temuan).toHaveLength(1);
    expect(temuan[0].jenis).toBe('rm_berbeda_nama_tak_terbaca');
    expect(temuan[0].keparahan).toBe('sedang');
  });
});
