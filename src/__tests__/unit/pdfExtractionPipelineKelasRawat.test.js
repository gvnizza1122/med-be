const { applyDeterministicFallback } = require('../../services/pdfExtractionPipeline');
const { getTarifResmi } = require('../../services/tarifInacbgLookup');

// Berkas SEP rawat jalan/IGD yang khas: 'Kelas Rawat' memang "-" (pasien tidak
// dirawat inap), kelas yang berlaku ada di 'Kls Hak'.
const TEKS_SEP = [
  'SURAT ELIGIBILITAS PESERTA',
  'No. SEP : 0170R0110826V003062',
  'Kls Hak : Kelas 3',
  'Kelas Rawat : -',
  'Jns Rawat : Rawat Jalan',
].join('\n');

function jalankan(nilaiDariAi, teks = TEKS_SEP) {
  const record = { KELAS_RAWAT: nilaiDariAi };
  applyDeterministicFallback(record, teks, 'RAWAT_JALAN', 'berkas.pdf');
  return record.KELAS_RAWAT;
}

describe('applyDeterministicFallback — KELAS_RAWAT rawat jalan/IGD', () => {
  // Regresi produksi 21 Sep 2026: klaim IGD anak (G40.9) menampilkan kode
  // G-4-22-I + deskripsinya, tapi tarif "Tidak ditemukan". Sebabnya AI menyalin
  // "-" dari field 'Kelas Rawat' -- dan karena "-" truthy, syarat lama
  // (!record.KELAS_RAWAT) melewatkan fallback 'Kls Hak' justru pada kasus yang
  // paling membutuhkannya.
  test('nilai sampah yang truthy tetap memicu fallback Kls Hak', () => {
    expect(jalankan('-')).toBe('3');
    expect(jalankan('IGD')).toBe('3');
    expect(jalankan('Rawat Jalan')).toBe('3');
  });

  test('kosong tetap memicu fallback (perilaku lama tidak hilang)', () => {
    expect(jalankan('')).toBe('3');
    expect(jalankan(undefined)).toBe('3');
  });

  test('kelas yang sudah valid TIDAK ditimpa Kls Hak', () => {
    expect(jalankan('1')).toBe('1');
    expect(jalankan('2')).toBe('2');
  });

  test('kalau Kls Hak tidak terbaca, nilai sampah dikosongkan', () => {
    expect(jalankan('-', 'SEP tanpa kelas hak')).toBe('');
    expect(jalankan('IGD', 'SEP tanpa kelas hak')).toBe('');
  });

  test('rawat inap: kelas valid dari AI tidak ditimpa', () => {
    const record = { KELAS_RAWAT: '2' };
    applyDeterministicFallback(record, TEKS_SEP, 'RAWAT_INAP', 'berkas.pdf');
    expect(record.KELAS_RAWAT).toBe('2');
  });
});

describe('applyDeterministicFallback — KELAS_RAWAT rawat inap', () => {
  // YETY NOVIATI (0170R0111225V003427): SEP hasil scan, AI tidak mengisi kelas
  // -> tarif INA-CBG rawat inap kosong.
  const SEP_RANAP = 'No.SEP : 0170R0111225V003427\nJns.Rawat : R.Inap\nDokter : GUNAWAN Kls.Hak : Kelas 3\nFaskes Perujuk : RS Lestari Raharja Kls.Rawat : Kelas 2';
  const jalankanRi = (nilai, teks = SEP_RANAP) => {
    const record = { KELAS_RAWAT: nilai };
    applyDeterministicFallback(record, teks, 'RAWAT_INAP', 'berkas.pdf');
    return record.KELAS_RAWAT;
  };
  test('kosong/sampah diisi dari Kls.Rawat, bukan Kls.Hak', () => {
    expect(jalankanRi('')).toBe('2');
    expect(jalankanRi('-')).toBe('2');
  });
  test('Kls.Rawat tidak terbaca -> Kls.Hak', () => {
    expect(jalankanRi('', 'Kls.Hak : Kelas 3')).toBe('3');
  });
  test('tidak ada keduanya -> kosong', () => {
    expect(jalankanRi('-', 'SEP tanpa kelas')).toBe('');
  });
});
