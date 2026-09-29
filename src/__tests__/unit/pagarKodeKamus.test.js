/**
 * Pemeriksaan kode klaim terhadap kamus resmi.
 *
 * Ditemukan pada klaim nyata (SEP 0170R0110826V003045): DIAGLIST berisi
 * "r10.84" — kode ICD-10-CM Amerika untuk nyeri perut menyeluruh. Kode itu
 * TIDAK ADA di ICD-10 WHO yang dipakai BPJS; padanannya R10.4. Di layar ia
 * tampil "Valid" karena tidak ada satu pun pemeriksaan yang membandingkannya
 * dengan kamus.
 *
 * Pagar kamus yang sudah ada hanya menahan SARAN kode — dan pada klaim itu ia
 * bekerja benar, R10.84 ditandai kamus_valid=false sehingga tidak pernah
 * diisikan. Yang bocor adalah kode dari tahap EKSTRAKSI, yang tidak pernah
 * diperiksa sama sekali, padahal justru kolom itu yang dikirim ke BPJS.
 */

const mockKamus = { icd10_who_codes: new Set(), icd9_cm_procedures: new Set() };
let mockGagal = false;

jest.mock('../../database/init', () => ({
  getDb: () => ({
    all: async (sql, params) => {
      if (mockGagal) throw new Error('koneksi putus');
      const tabel = /icd10_who_codes/.test(sql) ? 'icd10_who_codes' : 'icd9_cm_procedures';
      return params.filter(k => mockKamus[tabel].has(k)).map(code => ({ code }));
    },
  }),
}));

const { periksaKodeKlaimTerhadapKamus } = require('../../services/aiReviewService');

beforeEach(() => {
  mockKamus.icd10_who_codes = new Set(['R10.4', 'J18.9', 'A90']);
  mockKamus.icd9_cm_procedures = new Set(['93.94', '87.44']);
  mockGagal = false;
});

describe('kode di luar kamus ditandai', () => {
  test('R10.84 ditandai karena tidak ada di ICD-10 WHO', async () => {
    const t = await periksaKodeKlaimTerhadapKamus({ DIAGLIST: 'R10.84' });
    expect(t).toHaveLength(1);
    expect(t[0].kode).toBe('R10.84');
    expect(t[0].keparahan).toBe('tinggi');
    expect(t[0].pesan).toMatch(/ICD-10-CM/);
  });

  // Kasus aslinya tertulis huruf kecil. Perbandingan harus mengabaikan besar
  // kecilnya huruf, kalau tidak kode yang sah pun ikut tertuduh.
  test('huruf kecil tidak membuat kode sah ikut tertuduh', async () => {
    expect(await periksaKodeKlaimTerhadapKamus({ DIAGLIST: 'r10.4' })).toEqual([]);
  });

  test('kode prosedur di luar ICD-9-CM ikut ditandai', async () => {
    const t = await periksaKodeKlaimTerhadapKamus({ PROCLIST: '99.999' });
    expect(t).toHaveLength(1);
    expect(t[0].jenis).toBe('prosedur');
  });

  test('beberapa kode dipisah titik koma diperiksa satu per satu', async () => {
    const t = await periksaKodeKlaimTerhadapKamus({ DIAGLIST: 'J18.9;R10.84;A90' });
    expect(t.map(x => x.kode)).toEqual(['R10.84']);
  });

  test('membaca kolom basis data maupun nama field vClaim', async () => {
    expect(await periksaKodeKlaimTerhadapKamus({ diagnosa_list: 'R10.84' })).toHaveLength(1);
    expect(await periksaKodeKlaimTerhadapKamus({ prosedur_list: '99.999' })).toHaveLength(1);
  });
});

describe('kehati-hatian', () => {
  test('kode yang sah tidak menghasilkan temuan', async () => {
    expect(await periksaKodeKlaimTerhadapKamus({ DIAGLIST: 'J18.9', PROCLIST: '93.94' })).toEqual([]);
  });

  test('kolom kosong aman', async () => {
    expect(await periksaKodeKlaimTerhadapKamus({})).toEqual([]);
    expect(await periksaKodeKlaimTerhadapKamus({ DIAGLIST: '', PROCLIST: '' })).toEqual([]);
  });

  // Kamus gagal dibaca BUKAN berarti kodenya salah. Menuduh saat sistem
  // sendiri tidak bisa memeriksa akan membuat seluruh klaim tertandai keliru
  // begitu basis data terganggu.
  test('kamus gagal dibaca tidak menghasilkan tuduhan', async () => {
    mockGagal = true;
    expect(await periksaKodeKlaimTerhadapKamus({ DIAGLIST: 'R10.84' })).toEqual([]);
  });
});
