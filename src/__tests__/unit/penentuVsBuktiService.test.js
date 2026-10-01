/**
 * Tes penentuVsBuktiService (bagian 3 spek): penentu kode (determinan teks,
 * best-effort, tidak memaksakan) vs bukti pendukung (vital, TIDAK PERNAH
 * mengubah kode) — fungsi murni, tidak dipanggil pipeline hidup.
 */

const {
  temukanPenentu,
  evaluasiBukti,
  cekKontradiksi,
  nilaiPenentuVsBukti,
} = require('../../services/penentuVsBuktiService');

// Mock ambang_klinis milik agen lain (bentuk persis direkonsiliasi saat merge;
// di sini diasumsikan tiap fungsi mengembalikan {gawat, kategori}).
const ambangKlinisMock = {
  cocokTekananDarah: jest.fn((sistol, diastol) => {
    if (sistol >= 180 || diastol >= 120) return { gawat: true, kategori: 'krisis_hipertensi' };
    if (sistol >= 140) return { gawat: false, kategori: 'urgensi_ringan' };
    return { gawat: false, kategori: 'normal' };
  }),
  cocokSuhu: jest.fn((c) => (c >= 39 ? { gawat: true, kategori: 'hiperpireksia' } : { gawat: false, kategori: 'normal' })),
  cocokVas: jest.fn((n) => (n >= 7 ? { gawat: true, kategori: 'nyeri_berat' } : { gawat: false, kategori: 'normal' })),
  cocokSpo2: jest.fn((pct) => (pct < 92 ? { gawat: true, kategori: 'hipoksia' } : { gawat: false, kategori: 'normal' })),
  cocokNadi: jest.fn((n) => (n > 120 ? { gawat: true, kategori: 'takikardia' } : { gawat: false, kategori: 'normal' })),
};

beforeEach(() => jest.clearAllMocks());

describe('temukanPenentu — best-effort, TIDAK memaksakan', () => {
  test('contoh spek: "epigastrium" dekat diagnosis -> lebih suka R10.1 daripada R10.4', () => {
    const kandidat = [
      { kode: 'R10.4', judul: 'Nyeri abdomen lainnya dan tidak spesifik' },
      { kode: 'R10.1', judul: 'Nyeri epigastrium' },
    ];
    const hasil = temukanPenentu('Pasien mengeluh nyeri di daerah epigastrium sejak 2 hari.', kandidat);
    expect(hasil).not.toBeNull();
    expect(hasil.kodeDisarankan).toBe('R10.1');
    expect(hasil.kataKunciCocok).toContain('epigastrium');
  });

  test('tidak ada kata kunci penentu yang cocok di kedua sisi -> null (tidak menebak)', () => {
    const kandidat = [
      { kode: 'R10.4', judul: 'Nyeri abdomen lainnya dan tidak spesifik' },
      { kode: 'R10.1', judul: 'Nyeri epigastrium' },
    ];
    const hasil = temukanPenentu('Pasien tampak kesakitan, mengerang.', kandidat);
    expect(hasil).toBeNull();
  });

  test('ANTI-UPCODING: determinan prosedur (pendekatan operasi) tidak terdokumentasi -> null, tidak condong ke kandidat tarif lebih tinggi', () => {
    const kandidat = [
      { kode: '47.01', judul: 'Appendektomi laparoskopik' },
      { kode: '47.09', judul: 'Appendektomi lainnya (terbuka)' },
    ];
    const hasil = temukanPenentu('Dilakukan appendektomi atas indikasi apendisitis akut.', kandidat);
    // "akut" cocok di konteks TAPI tidak ada di judul kandidat manapun (soal
    // pendekatan operasi), jadi tidak ada dasar kata kunci yang valid di
    // kedua sisi -> null. Tidak boleh diam-diam memilih yang laparoskopik.
    expect(hasil).toBeNull();
  });

  test('kurang dari 2 kandidat -> null (tidak relevan menentukan di antara pilihan tunggal)', () => {
    expect(temukanPenentu('nyeri epigastrium', [{ kode: 'R10.1', judul: 'Nyeri epigastrium' }])).toBeNull();
  });
});

describe('evaluasiBukti — anotasi risiko, TIDAK PERNAH mengubah kode', () => {
  test('mengevaluasi hanya vital yang disuplai, mengabaikan yang tidak ada', () => {
    const bukti = evaluasiBukti({ suhu: 39.8 }, ambangKlinisMock);
    expect(bukti.dievaluasi).toBe(true);
    expect(bukti.detail).toHaveLength(1);
    expect(bukti.detail[0].jenis).toBe('suhu');
    expect(bukti.kegawatan).toBe('tinggi');
    expect(ambangKlinisMock.cocokSuhu).toHaveBeenCalledWith(39.8);
    expect(ambangKlinisMock.cocokTekananDarah).not.toHaveBeenCalled();
  });

  test('tidak ada data vital sama sekali -> dievaluasi:false, kegawatan:null', () => {
    const bukti = evaluasiBukti({}, ambangKlinisMock);
    expect(bukti.dievaluasi).toBe(false);
    expect(bukti.kegawatan).toBeNull();
  });

  test('fungsi ambang melempar error -> tidak crash, dianggap tidak gawat', () => {
    const ambangError = { cocokSuhu: () => { throw new Error('x'); } };
    const bukti = evaluasiBukti({ suhu: 40 }, ambangError);
    expect(bukti.detail[0].gawat).toBe(false);
  });
});

describe('nilaiPenentuVsBukti — tiga perilaku tabel-3', () => {
  test('perilaku 1: diagnosis tertulis + bukti MENDUKUNG -> jalan normal, tidak ada risiko/pertanyaan', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: true,
      teksDiagnosis: 'kolik abdomen',
      teksKonteks: 'nyeri di daerah epigastrium, VAS 8',
      kandidat: [{ kode: 'R10.4', judul: 'Nyeri abdomen lainnya' }, { kode: 'R10.1', judul: 'Nyeri epigastrium' }],
      vital: { vas: 8 },
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.risikoPending).toBe(false);
    expect(hasil.alasanRisiko).toBeNull();
    expect(hasil.pertanyaanKeDokter).toBeNull();
    expect(hasil.buktiPendukung.kegawatan).toBe('tinggi');
    expect(hasil.penentu.kodeDisarankan).toBe('R10.1');
  });

  test('perilaku 2 (contoh spek — HT urgensi vs emergensi): diagnosis "hipertensi emergensi" tapi TD 150/90 & tanpa bukti kerusakan organ -> risikoPending TRUE, kode TIDAK berubah', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: true,
      teksDiagnosis: 'Hipertensi emergensi',
      teksKonteks: 'TD 150/90, tidak ada tanda kerusakan organ',
      kandidat: [{ kode: 'I10', judul: 'Hipertensi esensial' }],
      vital: { sistol: 150, diastol: 90 },
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.risikoPending).toBe(true);
    expect(hasil.alasanRisiko).toMatch(/emergensi/);
    expect(hasil.pertanyaanKeDokter).toBeNull();
    // Fungsi ini TIDAK mengembalikan kode apa pun -- pemilihan kode murni
    // tanggung jawab pemilihKodeService, tetap terpisah.
    expect(hasil.kode).toBeUndefined();
  });

  test('perilaku 2 TIDAK berlaku kalau ada bukti kerusakan organ terdokumentasi', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: true,
      teksDiagnosis: 'Hipertensi emergensi',
      teksKonteks: 'TD 150/90, dengan edema paru akut',
      kandidat: [{ kode: 'I10', judul: 'Hipertensi esensial' }],
      vital: { sistol: 150, diastol: 90 },
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.risikoPending).toBe(false);
  });

  test('perilaku 2 TIDAK berlaku kalau nilai vital sendiri sudah menunjukkan kegawatan tinggi (TD 190/125, sesuai diagnosis)', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: true,
      teksDiagnosis: 'Hipertensi emergensi',
      teksKonteks: 'TD 190/125',
      kandidat: [{ kode: 'I10', judul: 'Hipertensi esensial' }],
      vital: { sistol: 190, diastol: 125 },
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.risikoPending).toBe(false);
  });

  test('perilaku 2 tidak dituduhkan kalau tidak ada data vital sama sekali (tidak cukup dasar)', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: true,
      teksDiagnosis: 'Hipertensi emergensi',
      teksKonteks: 'tidak ada tanda kerusakan organ',
      kandidat: [{ kode: 'I10', judul: 'Hipertensi esensial' }],
      vital: {},
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.risikoPending).toBe(false);
  });

  test('perilaku 3: bukti ADA tapi diagnosis TIDAK tertulis -> TIDAK menambah diagnosis, hanya pertanyaanKeDokter', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: false,
      teksKonteks: 'suhu 39.8 C',
      kandidat: [],
      vital: { suhu: 39.8 },
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.pertanyaanKeDokter).not.toBeNull();
    expect(hasil.pertanyaanKeDokter).toMatch(/konfirmasi ke dokter/i);
    expect(hasil.penentu).toBeNull();
    expect(hasil.risikoPending).toBe(false);
    // Tidak ada field apa pun yang menyiratkan diagnosis ditambahkan otomatis.
    expect(hasil.kode).toBeUndefined();
    expect(hasil.diagnosisDitambahkan).toBeUndefined();
  });

  test('perilaku 3: bukti TIDAK menunjukkan apa pun gawat & diagnosis tidak tertulis -> tidak ada pertanyaan (tidak perlu mengganggu dokter tanpa alasan)', () => {
    const hasil = nilaiPenentuVsBukti({
      diagnosisTertulis: false,
      teksKonteks: 'suhu 36.8 C',
      kandidat: [],
      vital: { suhu: 36.8 },
      ambangKlinis: ambangKlinisMock,
    });
    expect(hasil.pertanyaanKeDokter).toBeNull();
  });
});
