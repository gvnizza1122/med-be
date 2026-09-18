const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');
const fixture = require('../../testFixtures/hyperemesisRedacted');

describe('classifyPageDocumentType — fix item 7 (provenance dari metadata halaman)', () => {
  test('Rincian Biaya diklasifikasi rincian_biaya, BUKAN resume_medis (root cause bug provenance)', () => {
    expect(classifyPageDocumentType(fixture.RINCIAN_BIAYA_TEXT)).toBe('rincian_biaya');
  });

  test('SPRI diklasifikasi spri', () => {
    expect(classifyPageDocumentType(fixture.SPRI_TEXT)).toBe('spri');
  });

  test('Resume Medis Rawat Inap diklasifikasi resume_medis', () => {
    expect(classifyPageDocumentType(fixture.RESUME_MEDIS_TEXT)).toBe('resume_medis');
  });

  test('Triase IGD diklasifikasi triase_igd', () => {
    expect(classifyPageDocumentType(fixture.TRIASE_IGD_TEXT)).toBe('triase_igd');
  });

  test('Hasil Laboratorium diklasifikasi lab', () => {
    expect(classifyPageDocumentType(fixture.LAB_TEXT)).toBe('lab');
  });

  test('Berkas Klaim Individual diklasifikasi berkas_eklaim', () => {
    expect(classifyPageDocumentType(fixture.BERKAS_EKLAIM_TEXT)).toBe('berkas_eklaim');
  });

  test('teks kosong/tidak dikenal fallback lainnya', () => {
    expect(classifyPageDocumentType('')).toBe('lainnya');
    expect(classifyPageDocumentType('halaman kosong tanpa penanda apapun')).toBe('lainnya');
  });

  test('halaman yang menyebut >1 keyword -- Rincian Biaya menang atas penanda umum lain', () => {
    const mixed = 'RINCIAN BIAYA\nDiagnosa: O21.0\nProsedur: 88.78';
    expect(classifyPageDocumentType(mixed)).toBe('rincian_biaya');
  });
});
