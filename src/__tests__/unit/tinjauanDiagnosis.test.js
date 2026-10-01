const { tinjauDiagnosis, validasiTinjauan, buatKandidat } = require('../../services/tinjauanDiagnosisService');
const { susunSaranKoding } = require('../../services/saranKodingService');
const { getAnyResumeMedisPageNumbers } = require('../../services/aiReviewService');
const pages = [
  { page_number: 2, ocr_text: 'Resume Medis\nDiagnosis: PPOK dan Pneumonia\nAnamnesis: sesak dan batuk' },
  { page_number: 3, ocr_text: 'Pemeriksaan: wheezing\nFoto toraks: infiltrat' },
];
const record = { diagnosa_list: 'J44.9;J18.9', prosedur_list: '93.94', jenis_klaim: 'RAWAT_JALAN' };
const ai = { suggested_codes: ['J44.9', 'J18.9'].map((code, i) => ({ code, type: 'diagnosis', kamus_valid: true, page_number: 2, quotation: i ? 'Pneumonia' : 'PPOK' })) };
const candidates = buatKandidat(record, ai, pages, [2]);
test('resume rawat jalan/IGD juga menjadi dasar diagnosis, bukan hanya rawat inap', () => {
  expect(getAnyResumeMedisPageNumbers(pages)).toEqual([2]);
});
function raw(pilihan = ['J44.9', 'J18.9']) {
  return { ringkasan: 'Keduanya didukung diagnosis pada resume; periksa aturan kombinasi.', kode_rekomendasi: pilihan,
    kandidat: candidates.map(c => ({ kode: c.kode, status: pilihan.includes(c.kode) ? 'didukung' : 'perlu_klarifikasi', alasan: 'Periksa diagnosis pada resume bersama pemeriksaan.', bukti: [{ halaman: 2, kutipan: 'PPOK dan Pneumonia' }] })), klarifikasi: [] };
}
test.each([['PPOK saja', ['J44.9'], ['J44.9']], ['pneumonia saja', ['J18.9'], ['J18.9']], ['keduanya', ['J44.9', 'J18.9'], ['J44.0']]])('%s menjadi saran tanpa mengubah kode klaim/risk', (_label, pilihan, hasil) => {
  const sebelum = JSON.stringify(record);
  const tinjauan = validasiTinjauan(raw(pilihan), candidates, pages);
  const saran = susunSaranKoding(record, { ...ai, tinjauan_diagnosis: tinjauan });
  expect(saran.diagnosis.map(d => d.kode)).toEqual(hasil);
  expect(saran.klaim_saat_ini.diagnosis).toEqual(['J44.9', 'J18.9']);
  expect(JSON.stringify(record)).toBe(sebelum);
});
test('belum cukup bukti: tidak memaksakan gabungan atau estimasi tarif', () => {
  const tinjauan = validasiTinjauan(raw([]), candidates, pages);
  const hitung = jest.fn();
  const saran = susunSaranKoding(record, { ...ai, tinjauan_diagnosis: tinjauan }, hitung);
  expect(saran.diagnosis.map(d => d.kode)).toEqual(['J44.9', 'J18.9']);
  expect(saran.diagnosis_belum_final).toBe(true);
  expect(saran.diagnosis.every(d => d.peran === undefined)).toBe(true);
  expect(saran.perubahan).toEqual([]);
  expect(saran.inacbg).toBeNull();
  expect(hitung).not.toHaveBeenCalled();
});
test('berkas lama tanpa tinjauan tidak otomatis dijadikan kode gabungan hanya karena pasangan tercantum', () => {
  const saran = susunSaranKoding(record, ai);
  expect(saran.diagnosis_belum_final).toBe(true);
  expect(saran.perubahan).toEqual([]);
  expect(saran.inacbg).toBeNull();
});
test('kode baru yang diturunkan dari gejala ditolak', () => {
  const r = raw(); r.kode_rekomendasi = ['J44.1'];
  expect(validasiTinjauan(r, candidates, pages)).toBeNull();
});
test('kutipan dan nomor halaman palsu ditolak', () => {
  const r = raw(); r.kandidat[0].bukti = [{ halaman: 3, kutipan: 'SpO2 80%' }];
  expect(validasiTinjauan(r, candidates, pages)).toBeNull();
});
test('kode klaim tanpa diagnosis resume tidak bisa dianggap didukung hanya oleh anamnesis', () => {
  const noResumeDiagnosis = buatKandidat(record, {}, pages, [2]);
  expect(validasiTinjauan(raw(), noResumeDiagnosis, pages)).toBeNull();
});
test('AI harus menilai semua kandidat, tidak boleh diam-diam membuang satu', () => {
  const r = raw(); r.kandidat.pop();
  expect(validasiTinjauan(r, candidates, pages)).toBeNull();
});
test('anamnesis dan penunjang halaman lain terkirim bersama diagnosis resume + Humanizer', async () => {
  const gateway = { panggilModel: jest.fn().mockResolvedValue({ ok: true, hasil: raw(['J18.9']) }) };
  const hasil = await tinjauDiagnosis(record, ai, pages, [2], { gateway });
  expect(hasil.kode_rekomendasi).toEqual(['J18.9']);
  const payload = gateway.panggilModel.mock.calls[0][1];
  expect(payload.prompt).toContain('Anamnesis: sesak dan batuk');
  expect(payload.prompt).toContain('Foto toraks: infiltrat');
  expect(payload.system).toContain('PANDUAN BAHASA HUMANIZER');
  expect(payload.system).toContain('Tidak adanya\nrontgen/lab di berkas tidak otomatis');
});
test('model gagal -> status belum dinilai, bukan diagnosis tunggal rekaan', async () => {
  const hasil = await tinjauDiagnosis(record, ai, pages, [2], { gateway: { panggilModel: async () => ({ ok: false }) } });
  expect(hasil.status).toBe('belum_dinilai');
  expect(hasil.kode_rekomendasi).toEqual([]);
});
