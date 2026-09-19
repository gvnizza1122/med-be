const { classifyPageDocumentType, isSepPage, isCriticalPage } = require('../../services/pdfPageClassifier');
const fixture = require('../../testFixtures/hyperemesisRedacted');

describe('isSepPage — halaman SEP dibuang dari antrean OCR enhancement', () => {
  test('halaman SEP asli terdeteksi', () => {
    expect(isSepPage('SURAT ELIGIBILITAS PESERTA\nNo. SEP 0170R011\nNo. Kartu 0001234567890')).toBe(true);
    expect(isSepPage('Nomor SEP : 0170R011\nBPJS Kesehatan')).toBe(true);
  });

  // Regresi: di classifyPageDocumentType() cek 'sep' jatuh SEBELUM
  // 'resume_medis', jadi resume medis yang mencantumkan "No. SEP" (lazim)
  // sempat terdeteksi sebagai SEP — halaman paling bernilai untuk vital
  // signs justru yang terbuang duluan.
  test('halaman CRITICAL yang mencantumkan No. SEP TIDAK dianggap SEP', () => {
    const resume = 'RESUME MEDIS\nNo. SEP 0170R011\nDiagnosa: E11.4';
    const triase = 'TRIAGE IGD\nNo. SEP 0170R011\nTD 133/79 HR 51 SpO2 97';
    const skrining = 'SKRINING AWAL PASIEN IGD\nNomor SEP 0170R011\nSkala Nyeri 4';
    for (const text of [resume, triase, skrining]) {
      expect(isCriticalPage(text)).toBe(true);
      expect(isSepPage(text)).toBe(false);
    }
  });

  test('halaman non-SEP lain tidak ikut terbuang', () => {
    expect(isSepPage('BERKAS KLAIM INDIVIDUAL\nNomor SEP 0170R011\nINA-CBG\nTotal Tarif')).toBe(false);
    expect(isSepPage('RINCIAN BIAYA\nNomor SEP 0170R011')).toBe(false);
    expect(isSepPage('SURAT PERINTAH RAWAT INAP\nNo. SEP 0170R011')).toBe(false);
    expect(isSepPage('')).toBe(false);
  });
});

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
