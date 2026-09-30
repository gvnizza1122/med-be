const {
  verifikasiKutipan, saringTemuan, rapikanTemuan, kumpulkanKodeValid, ALASAN,
} = require('../../services/pagarTemuanService');

const HALAMAN = [
  { page_number: 1, ocr_text: 'RESUME MEDIS\nDiagnosa Utama : Asma   bronkial\nRh -/-  Wh -/-' },
  { page_number: 2, text: 'Terapi: Ventasal 3dd1' },
];

const dasar = (o = {}) => ({
  jenis: 'diagnosis', teks: 'asma bronkial', halaman: 1,
  kutipan: 'Diagnosa Utama : Asma bronkial', disangkal: false, sumber: 'cetak', yakin: 'tinggi', ...o,
});

describe('verifikasiKutipan', () => {
  test('kutipan ada, toleran spasi/baris baru dan huruf besar-kecil', () => {
    expect(verifikasiKutipan('diagnosa utama : asma bronkial', 1, HALAMAN).valid).toBe(true);
    expect(verifikasiKutipan('RESUME   MEDIS Diagnosa', 1, HALAMAN).valid).toBe(true);
  });

  test('kata berbeda ditolak (tidak toleran terhadap tipo)', () => {
    const r = verifikasiKutipan('Diagnosa Utama : Asma bronchial', 1, HALAMAN);
    expect(r).toEqual({ valid: false, alasan: ALASAN.KUTIPAN_TAK_ADA });
  });

  test('kutipan yang ada di halaman lain tidak dihitung', () => {
    expect(verifikasiKutipan('Ventasal 3dd1', 1, HALAMAN).valid).toBe(false);
    expect(verifikasiKutipan('Ventasal 3dd1', 2, HALAMAN).valid).toBe(true);
  });

  test('kosong, "tidak ditemukan", tanpa halaman, halaman tak ada', () => {
    expect(verifikasiKutipan('', 1, HALAMAN).alasan).toBe(ALASAN.KUTIPAN_KOSONG);
    expect(verifikasiKutipan(null, 1, HALAMAN).alasan).toBe(ALASAN.KUTIPAN_KOSONG);
    expect(verifikasiKutipan('Tidak ditemukan', 1, HALAMAN).alasan).toBe(ALASAN.TIDAK_DITEMUKAN);
    expect(verifikasiKutipan('asma', null, HALAMAN).alasan).toBe(ALASAN.HALAMAN_KOSONG);
    expect(verifikasiKutipan('asma', 9, HALAMAN).alasan).toBe(ALASAN.HALAMAN_TAK_ADA);
  });
});

describe('saringTemuan', () => {
  test('temuan sah diterima dan cetak tidak otomatis perlu cek manusia', () => {
    const { diterima, ditolak } = saringTemuan([dasar()], HALAMAN);
    expect(ditolak).toHaveLength(0);
    expect(diterima[0].perlu_cek_manusia).toBeUndefined();
    expect(diterima[0].disangkal).toBe(false);
  });

  test('temuan dikarang (kutipan tidak ada) ditolak dengan alasan', () => {
    const { diterima, ditolak, ringkasan } = saringTemuan(
      [dasar({ teks: 'asma akut', kutipan: 'Asma akut J45.909' })], HALAMAN);
    expect(diterima).toHaveLength(0);
    expect(ditolak[0].alasan).toBe(ALASAN.KUTIPAN_TAK_ADA);
    expect(ringkasan.alasan_ditolak[ALASAN.KUTIPAN_TAK_ADA]).toBe(1);
  });

  test('skema tidak valid ditolak', () => {
    const { ditolak } = saringTemuan([{ jenis: 'lain', teks: 'x' }, null, dasar({ teks: '' })], HALAMAN);
    expect(ditolak.map(d => d.alasan)).toEqual([ALASAN.SKEMA, ALASAN.SKEMA, ALASAN.SKEMA]);
  });

  test('tulisan tangan selalu perlu cek manusia', () => {
    const { diterima } = saringTemuan([dasar({ sumber: 'tulisan_tangan' })], HALAMAN);
    expect(diterima[0].perlu_cek_manusia).toBe(true);
  });

  test('sumber/yakin tak dikenal diturunkan ke yang paling hati-hati', () => {
    const t = rapikanTemuan(dasar({ sumber: 'entah', yakin: 'pasti' }));
    expect(t.sumber).toBe('tulisan_tangan');
    expect(t.yakin).toBe('rendah');
  });

  test('temuan disangkal dipertahankan, ditandai, tidak dibuang', () => {
    const { diterima } = saringTemuan(
      [dasar({ jenis: 'penunjang', teks: 'ronkhi', kutipan: 'Rh -/-' })], HALAMAN);
    expect(diterima).toHaveLength(1);
    expect(diterima[0].disangkal).toBe(true);
    expect(diterima[0].perlu_cek_manusia).toBe(true);
  });

  test('kode harus ada di tabel referensi bila himpunan diberikan', () => {
    const kodeValid = { diagnosis: new Set(['J45.9']), prosedur: new Set() };
    const r1 = saringTemuan([dasar({ kode: 'j45.9' })], HALAMAN, { kodeValid });
    expect(r1.diterima).toHaveLength(1);
    const r2 = saringTemuan([dasar({ kode: 'J45.909' })], HALAMAN, { kodeValid });
    expect(r2.ditolak[0].alasan).toBe(ALASAN.KODE_TAK_ADA);
  });

  test('tabel tidak dapat diperiksa: kode lolos dengan tanda belum dicek', () => {
    const r = saringTemuan([dasar({ kode: 'J45.9' })], HALAMAN, { kodeValid: { diagnosis: null } });
    expect(r.diterima[0].kode_belum_dicek).toBe(true);
  });
});

describe('kumpulkanKodeValid', () => {
  test('memanggil lookup per tabel referensi yang benar', async () => {
    const lookup = jest.fn(async (tabel, kode) => new Set(kode));
    const r = await kumpulkanKodeValid([
      { jenis: 'diagnosis', kode: 'j45.9' }, { jenis: 'prosedur', kode: '96.04' }, { jenis: 'obat', kode: 'x' },
    ], lookup);
    expect(lookup).toHaveBeenCalledWith('icd10_who_codes', ['J45.9']);
    expect(lookup).toHaveBeenCalledWith('icd9_cm_procedures', ['96.04']);
    expect(r.diagnosis.has('J45.9')).toBe(true);
  });
});
