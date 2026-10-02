const { lengkapiKodeLukaBakar, derajat } = require('../../services/kodingLukaBakarService');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');

// Ringkasan resume MUSTAKIMAH (0170R0111225V003200), kunci jawaban: lembar grouper casemix.
const pages = [{ page_number: 3, ocr_text: [
  'RESUME MEDIS RAWAT INAP', 'Alasan Masuk Rawat Inap :',
  'terkena api kompor saat masak mie ayam. luka bakar area wajah kanan, lengan bawah kanan',
  'hingga jari kanan, kaki kanan. nyeri +',
  'status lokalis luka bakar grade 2A di wajah, lengan bawah kanan, tungkai bawah kanan, tungkai',
  'bawah kiri karena api', 'Diagnosis Utama :', 'Combustio grade 2A luas 15% karena api', 'Tindakan/Prosedur :', '1. Debrideman',
].join('\n') }];

test('derajat luka bakar', () => {
  expect(derajat('grade 2A')).toBe(2);
  expect(derajat('derajat III')).toBe(3);
  expect(derajat('luka bakar')).toBeNull();
});

test('lokasi + derajat + penyebab luar sama dengan casemix; T31 tetap utama', () => {
  const r = lengkapiKodeLukaBakar([{ code: 'T31.1', type: 'diagnosis' }, { code: 'I10', type: 'diagnosis' }], pages);
  const kode = r.saran.map(s => s.code);
  expect(kode[0]).toBe('T31.1');
  expect(new Set(kode)).toEqual(new Set(['T31.1', 'I10', 'T20.2', 'T22.2', 'T23.2', 'T24.2', 'X09.5']));
  expect(r.saran.filter(s => s.sumber_aturan === 'koding_luka_bakar').every(s => s.quotation && s.page_number === 3)).toBe(true);
});

test('bukan luka bakar -> tidak mengubah apa pun', () => {
  const r = lengkapiKodeLukaBakar([{ code: 'A90', type: 'diagnosis' }], [{ page_number: 1, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama : Dengue Fever' }]);
  expect(r.perubahan).toEqual([]);
});

test('grouper: debridemen luka bakar tetap S-4-16; lokasi, penyebab luar & I10 tidak menaikkan severity', () => {
  const h = hitungInacbgDanTarif(['T31.1', 'T20.2', 'T22.2', 'T23.2', 'T24.2', 'X09.5', 'I10'], ['86.22', '90.59', '87.44', '89.52'], 'RAWAT_INAP', '3', null);
  expect(h.inacbgResult.code).toBe('S-4-16-I');
  expect(h.tarifResult.amount).toBe(3908200);
  // Debridemen di luar luka bakar tetap kelompok prosedur kulit.
  expect(hitungInacbgDanTarif(['L03.1'], ['86.22'], 'RAWAT_INAP', '3', null).inacbgResult.code).toMatch(/^L-1-40/);
});

test('temuan penunjang mencatat jenis halaman sumber (lembar hasil vs resume)', () => {
  const { bacaTemuanPenunjang } = require('../../services/temuanPenunjangService');
  const halaman = [
    { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nPemeriksaan Penunjang :\n1. DARAH RUTIN\n2. Ro thorax\nDiagnosis Utama :\nCombustio' },
    { page_number: 8, ocr_text: 'HASIL PEMERIKSAAN RADIOLOGI\nNo RM : 1\nPemeriksaan : Thorax\nKesan Dokter Pulmo tak tampak kelainan\nDokter Radiologi' },
  ];
  const t = bacaTemuanPenunjang(halaman).temuan;
  const thorax = t.filter(x => x.kode_usulan === '87.44');
  expect(thorax.some(x => x.page_number === 8 && x.jenis_halaman === 'radiology')).toBe(true);
  expect(t.filter(x => x.page_number === 3).every(x => x.jenis_halaman === 'resume_medis')).toBe(true);
});
