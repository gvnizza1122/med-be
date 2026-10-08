/**
 * Alasan pending harus jelas sekilas: ringkasan menyebut apa yang tertulis
 * (angka + halaman), syarat yang dipakai, dan apa yang belum ada -- bukan
 * "dokumentasi perlu ditinjau" (kasus KASUS ACUAN STT: alasan STT ternyata soal
 * ukuran/kedalaman tumor, tetapi tidak terbaca dari ringkasannya).
 */
const { evaluasiReferensiKlaim } = require('../../services/referensiKlaimService');
const { susunPutusan } = require('../../services/putusanPendingService');
const { evaluasiKombinasiKode } = require('../../services/ketentuanKlaimService');
const { lookupBand } = require('../../services/kegawatdaruratanReference');
const { segarkanKriteriaVital } = require('../../services/kegawatdaruratanAggregation');

const rec = (o = {}) => ({ jenis_klaim: 'RAWAT_INAP', admission_date: '2026-10-01', discharge_date: '2026-10-05', hospital_code: '9999999', umur_tahun: 40, ...o });
const alasanDari = (r, teks) => susunPutusan({ referensi_klaim: evaluasiReferensiKlaim(r, [{ page_number: 4, ocr_text: `RESUME MEDIS\n${teks}` }]) }).alasan;

test('angka bertentangan: ringkasan mengutip nilai tertulis dan halamannya', () => {
  const a = alasanDari(rec({ diagnosa_list: 'M41.1' }), 'Rontgen: sudut Cobb 8 derajat').find(x => x.kode === 'PNPK-SKOLIOSIS-01');
  expect(a.keparahan).toBe('tinggi');
  expect(a.ringkas).toMatch(/Cobb ≥10°.*tertulis "Rontgen: sudut Cobb 8 derajat" \(hal\. 4\)/);
  expect(a.penjelasan).toMatch(/^Syarat PNPK 2021/);
});

test('nilai dalam satuan asli dikutip, bukan angka hasil konversi', () => {
  const a = alasanDari(rec({ diagnosa_list: 'H25.9', prosedur_list: '13.41', umur_tahun: 60 }), 'Visus VOD 6/9').find(x => x.kode === 'PNPK-KATARAK-DEWASA-2026');
  expect(a.ringkas).toMatch(/"Visus VOD 6\/9"/);
  expect(a.ringkas).not.toMatch(/0\.667/);
});

test('bukti belum ada: ringkasan menyebut pemeriksaan yang tidak ada', () => {
  const a = alasanDari(rec({ diagnosa_list: 'J44.9', umur_tahun: 60 }), 'Sesak').find(x => x.kode === 'BA-19-M65');
  expect(a.ringkas).toMatch(/PPOK: belum ada di berkas -- Hasil spirometri/);
});

test('kombinasi kode: ringkasan menyebut kode yang terkena dan arah perbaikannya', () => {
  const a = susunPutusan({ kombinasi_kode: evaluasiKombinasiKode('J18.9;J44.9') }).alasan.find(x => x.kode === 'KMB-12');
  expect(a.ringkas).toBe('Pneumonia + PPOK: J18.9 + J44.9 -- dikode gabungan J44.0');
});

test('kegawatdaruratan: ringkasan menyebut tanda vital yang tercatat', () => {
  const kgd = { kunjungan_igd: true, has_data: true, esi: { skor: 3 }, age_group: 'dewasa',
    vital_findings: { GCS: { nilai: 15 }, TD_sistolik: { nilai: 120 }, TD_diastolik: { nilai: 80 }, HR: { nilai: 80 }, RR: { nilai: 18 } },
    kriteria: ['K1', 'K2', 'K3', 'K4', 'K5'].map(k => ({ kriteria: k, status: 'tidak' })) };
  const a = susunPutusan({ kegawatdaruratan_assessment: kgd }).alasan.find(x => x.kode === 'KGD-IGD');
  expect(a.ringkas).toBe('Kunjungan IGD tanpa kriteria gawat darurat K1-K5: tercatat ESI 3, GCS 15, TD 120/80, nadi 80, napas 18');
});

describe('hipotensi dewasa <90 mmHg = gawat (BA 2018 hal. 31)', () => {
  test('band TD sistolik dewasa', () => {
    expect(lookupBand('TD_sistolik', 81, 'dewasa')).toBe('gawat');
    expect(lookupBand('TD_sistolik', 89, 'lansia')).toBe('gawat');
    expect(lookupBand('TD_sistolik', 90, 'dewasa')).toBe('normal');
  });
  test('penilaian tersimpan dengan band lama disegarkan tanpa AI ulang', () => {
    const lama = { has_data: true, age_group: 'dewasa', parameter_findings: [],
      vital_findings: { TD_sistolik: { nilai: 81, band: 'borderline', page_number: 13, kutipan: '81/65 mmHg' } },
      kriteria: [{ kriteria: 'K1', status: 'tidak' }, { kriteria: 'K2', status: 'tidak' }, { kriteria: 'K3', status: 'tidak' },
        { kriteria: 'K4', status: 'borderline' }, { kriteria: 'K5', status: 'tidak', evidence: [{ sumber: 'esi' }] }] };
    const segar = segarkanKriteriaVital(lama, [{ page_number: 13, ocr_text: 'TRIAGE IGD' }]);
    expect(segar.kriteria.find(k => k.kriteria === 'K4').status).toBe('ya');
    expect(segar.kriteria.find(k => k.kriteria === 'K5')).toEqual(lama.kriteria[4]);
    expect(segar.kriteria_disegarkan).toBe(true);
  });
});
