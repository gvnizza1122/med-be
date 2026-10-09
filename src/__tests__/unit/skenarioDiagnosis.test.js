/**
 * Skenario diagnosis alternatif (kasus RAFAELLO: kejang demam + GEA + ISPA, foto toraks "Kesan bronkopneumonia",
 * batuk (-), sesak (-), RR 22): skenario pneumonia ditampilkan dengan syarat dan selisih tarif, tetapi
 * ditandai berisiko upcoding karena kriteria klinis PNPK IDAI tidak tertulis. Fixture fiktif.
 */
const { skenarioAlternatif, nilaiSkenario } = require('../../services/skenarioDiagnosisService');
const { alternatifKoding } = require('../../services/agenCasemixService');
const { cari, konteks, periksa } = require('../../services/baKesepakatan2018Service');

const anak = { jenis_klaim: 'RAWAT_INAP', admission_date: '2026-09-21', discharge_date: '2026-09-25', umur_tahun: 3, birth_date: '2022-11-05', hospital_code: '9999999' };
const foto = { page_number: 7, ocr_text: 'HASIL PEMERIKSAAN RADIOLOGI\nPemeriksaan : Thorax\nDiagnosis Klinis suspek pneumonia\nTampak infiltrat di paracardial dextra\nKesan Dokter Bronkhopneumonia' };
const triaseTanpaGejala = { page_number: 10, ocr_text: 'TRIAGE IGD\nDemam tinggi sejak pagi ini, kejang 5 menit. Pasien sempat mengeluh pusing. Batuk\n(-) pilek (+) sesek (-) BAB dbn.\nRR : 22 x/mnt, SaO2 : 98% Suhu : 38 °C' };
const skrining = { page_number: 12, ocr_text: 'SKRINING TB\n1 Batuk berdahak lebih dari 2 minggu\n2 Batuk disertai darah' };
const tarif = { 'R56.0': 3030300, J18: 3999000 };
const hitung = dx => ({ inacbgResult: { code: dx[0].startsWith('J18') ? 'J-4-16-I' : 'G-4-22-I', description: '-' }, tarifResult: { amount: dx[0].startsWith('J18') ? tarif.J18 : tarif['R56.0'] } });

test('kesan bronkopneumonia -> skenario J18.0 utama; R56.0 dihapus sesuai KMB-07; berisiko upcoding', () => {
  const a = alternatifKoding({ record: anak, dx: ['R56.0', 'A09', 'J06.9'], px: ['93.94', '87.44'], hitung, pages: [foto, triaseTanpaGejala, skrining] });
  const s = a.alternatif.find(x => x.jenis === 'diagnosis_alternatif');
  expect(s.diagnosis).toEqual(['J18.0', 'A09', 'J06.9']);
  expect(s.kode_dihapus).toEqual([expect.objectContaining({ kode: 'R56.0', aturan: 'KMB-07' })]);
  expect(s.dasar_temuan[0]).toMatchObject({ kutipan: 'Kesan Dokter Bronkhopneumonia', halaman: 7 });
  expect(s.selisih_tarif).toBe(968700);
  expect(s.penilaian).toBe('berisiko_upcoding');
  const belum = s.syarat_belum.map(x => x.syarat).join(' | ');
  expect(belum).toMatch(/batuk atau kesulitan bernapas/); // "Batuk (-)" dan butir skrining TB bukan keluhan
  expect(belum).toMatch(/napas cepat >=40/);
  expect(s.syarat).toMatch(/tidak menegakkan diagnosis/);
});

test('kriteria klinis tertulis tetapi DPJP tidak menulis pneumonia dan tarif naik -> tetap berisiko upcoding', () => {
  const triase = { page_number: 10, ocr_text: 'TRIAGE IGD\nBatuk 3 hari, sesak napas, retraksi subkostal\nRR : 48 x/mnt SpO2 : 91% Suhu 38,5' };
  const [s] = skenarioAlternatif({ record: anak, dx: ['R56.0'], px: [], pages: [foto, triase] });
  const n = nilaiSkenario({ ...s, selisih_tarif: 968700 });
  expect(n.syarat_belum).toEqual([]);
  expect(n.penilaian).toBe('berisiko_upcoding');
  expect(n.alasan.join(' ')).toMatch(/DPJP tidak menuliskan pneumonia[\s\S]*klarifikasi ke DPJP/);
});

test('DPJP menulis bronkopneumonia tetapi belum dikode -> kode terlewat (sah)', () => {
  const resume = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nBronkopneumonia\nDiagnosis Sekunder : KDS' };
  const triase = { page_number: 10, ocr_text: 'TRIAGE IGD\nBatuk 3 hari, sesak napas, retraksi subkostal\nRR : 48 x/mnt SpO2 : 91% Suhu 38,5' };
  const [s] = skenarioAlternatif({ record: anak, dx: ['R56.0'], px: [], pages: [foto, triase, resume] });
  const n = nilaiSkenario({ ...s, selisih_tarif: 968700 });
  expect(n.ditulis_dpjp).toBe('ya');
  expect(n.penilaian).toBe('ditulis_dpjp_belum_dikode');
  expect(n.ringkas).toMatch(/^Kode terlewat/);
});

describe('pemicu lain', () => {
  const dewasa = { ...anak, umur_tahun: 40, birth_date: '1986-01-01' };
  const lab = t => ({ page_number: 2, ocr_text: `HASIL LABORATORIUM\nTanggal 21-09-2026\n${t}` });
  const resume = t => ({ page_number: 3, ocr_text: `RESUME MEDIS RAWAT INAP\n${t}` });
  test('NS1 positif dengan diagnosis utama demam -> dengue utama, R50.9 terserap; NS1 negatif tidak memicu', () => {
    const [s] = skenarioAlternatif({ record: dewasa, dx: ['R50.9'], px: [], pages: [lab('NS1 Antigen : Positif'), resume('Diagnosis Utama : Febris')] });
    expect(s).toMatchObject({ pemicu: 'dengue', posisi: 'utama', diagnosis: ['A90'] });
    expect(s.kode_dihapus[0]).toMatchObject({ kode: 'R50.9' });
    expect(skenarioAlternatif({ record: dewasa, dx: ['R50.9'], px: [], pages: [lab('NS1 Antigen : Negatif'), resume('Diagnosis Utama : Febris')] })).toEqual([]);
  });
  test('USG batu ginjal pada kolik abdomen -> N20.0 utama', () => {
    const usg = { page_number: 6, ocr_text: 'HASIL PEMERIKSAAN RADIOLOGI\nUSG Abdomen\nKesan: batu ginjal kiri ukuran 8 mm' };
    const [s] = skenarioAlternatif({ record: dewasa, dx: ['R10.4'], px: [], pages: [usg, resume('Diagnosis : kolik abdomen')] });
    expect(s).toMatchObject({ pemicu: 'batu_kemih', diagnosis: ['N20.0'], posisi: 'utama', ditulis_dpjp: 'tidak' });
  });
  test('temuan insidental pada diagnosis utama definitif lain -> skenario sekunder', () => {
    const usg = { page_number: 6, ocr_text: 'HASIL PEMERIKSAAN RADIOLOGI\nUSG Abdomen\nKesan: kolelitiasis' };
    const [s] = skenarioAlternatif({ record: dewasa, dx: ['S72.0'], px: [], pages: [usg, resume('Diagnosis : fraktur collum femur')] });
    expect(s).toMatchObject({ pemicu: 'kolelitiasis', posisi: 'sekunder', diagnosis: ['S72.0', 'K80.2'] });
  });
});

test('tidak ada skenario bila pneumonia sudah diagnosis utama atau foto toraks normal', () => {
  expect(skenarioAlternatif({ record: anak, dx: ['J18.0', 'R56.0'], px: [], pages: [foto] })).toEqual([]);
  const normal = { page_number: 7, ocr_text: 'HASIL PEMERIKSAAN RADIOLOGI\nThorax: cor dan pulmo dalam batas normal' };
  expect(skenarioAlternatif({ record: anak, dx: ['R56.0'], px: [], pages: [normal] })).toEqual([]);
});

test('negasi pada awal baris berikutnya ("Batuk" / "(-) pilek") dibaca sebagai disangkal', () => {
  const ctx = konteks(anak, [triaseTanpaGejala]);
  expect(cari({ pola: /\bbatuk\b/i }, ctx.klinis)).toEqual([]);
  // Butir daftar "- ..." di baris berikutnya bukan negasi.
  const daftar = konteks(anak, [{ page_number: 1, ocr_text: 'RESUME MEDIS\nKeluhan: batuk\n- demam 3 hari' }]);
  expect(cari({ pola: /\bbatuk\b/i }, daftar.klinis)).toHaveLength(1);
});

test('leukosit memakai rujukan lab pada baris yang sama (anak 14.160 dengan rujukan 5-17 bukan leukositosis)', () => {
  const lab = { page_number: 5, ocr_text: 'HASIL LABORATORIUM\nTanggal 21-09-2026\nLekosit 14.16 5-17 10^3/uL Flowcytometry' };
  const r = periksa('dua_gejala_pneumonia', konteks(anak, [lab, { page_number: 3, ocr_text: 'RESUME MEDIS\nDemam' }]));
  expect(r.catatan).not.toMatch(/leukosit/);
});
