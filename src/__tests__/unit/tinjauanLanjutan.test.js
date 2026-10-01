const { tinjauLanjutan, ambilPemicu, pilihHalaman } = require('../../services/tinjauanLanjutanService');
const { buatKandidat, validasiTinjauan } = require('../../services/tinjauanDiagnosisService');
const { bentukPutusan } = require('../../services/putusanPendingAiService');
const pages = [
  { page_number: 1, ocr_text: 'SEP BPJS penjamin pasien' },
  { page_number: 2, ocr_text: 'Resume Medis\nDiagnosis: PPOK dan Pneumonia\nAnamnesis: sesak dan batuk' },
  { page_number: 3, ocr_text: 'Foto toraks: infiltrat. Pemeriksaan: wheezing. Tidak ada demam.' },
  { page_number: 4, ocr_text: 'Kwitansi administrasi pembayaran' },
];
const record = { id: 'kasus-test', diagnosa_list: 'J44.9;J18.9', jenis_klaim: 'RAWAT_JALAN' };
const ai = { suggested_codes: ['J44.9', 'J18.9'].map(code => ({ code, type: 'diagnosis', kamus_valid: true, page_number: 2, quotation: 'PPOK dan Pneumonia' })) };
const candidates = buatKandidat(record, ai, pages, [2]);
const raw = (codes = ['J44.9', 'J18.9']) => ({ ringkasan: 'Diagnosis didukung; tentukan urutan pelayanan.', kode_rekomendasi: codes,
  kandidat: candidates.map(c => ({ kode: c.kode, status: 'didukung', alasan: 'Diagnosis pada resume.', bukti: [{ halaman: 2, kutipan: 'PPOK dan Pneumonia' }] })), klarifikasi: codes.length ? [] : ['Urutan belum jelas.'] });
const tinjauan = codes => validasiTinjauan(raw(codes), candidates, pages);
const opsi = { persenSampel: 0 };
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
function gateway(diagnosis = raw(), putusan = null) {
  return { panggilModel: jest.fn(async () => ({ ok: true, model: 'gpt-6.1-sol', effort: 'high',
    penggunaan: { total_tokens: 1234 }, hasil: { diagnosis, putusan } })) };
}

test.each(['RAWAT_JALAN', 'RAWAT_INAP'])('%s yang ambigu memanggil Sol sekali dengan bukti asli dan negasi', async jenis_klaim => {
  const g = gateway();
  const awal = { ...ai, tinjauan_diagnosis: tinjauan([]) };
  const sebelum = JSON.stringify(awal);
  const hasil = await tinjauLanjutan({ ...record, jenis_klaim }, awal, pages, [2], null, { ...opsi, gateway: g });
  expect(g.panggilModel).toHaveBeenCalledTimes(1);
  const [tugas, p] = g.panggilModel.mock.calls[0];
  expect(tugas).toBe('tinjau_kasus_lanjutan');
  expect(p.jenisKlaim).toBe(jenis_klaim);
  expect(p.prompt).toContain('Tidak ada demam.');
  expect(p.prompt).toContain('=== Halaman 3 ===');
  expect(p.prompt).not.toContain('Kwitansi administrasi pembayaran');
  expect(hasil.metadata).toMatchObject({ status: 'selesai', effort: 'high', tokens_used: 1234 });
  expect(hasil.tinjauan.kode_rekomendasi).toEqual(['J44.9', 'J18.9']);
  expect(JSON.stringify(awal)).toBe(sebelum);
});
test('dua diagnosis yang jelas tidak otomatis memanggil Sol', async () => {
  const g = gateway();
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan() }, pages, [2], null, { ...opsi, gateway: g });
  expect(hasil.metadata.status).toBe('tidak_diperlukan');
  expect(g.panggilModel).not.toHaveBeenCalled();
});
test('berkas tidak ada/tidak terbaca -> lengkapi dokumen, tanpa panggilan Sol', async () => {
  const g = gateway();
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan([]) }, [], [], null, { gateway: g });
  expect(hasil.metadata.status).toBe('perlu_lengkapi_berkas');
  expect(g.panggilModel).not.toHaveBeenCalled();
});
test('belum dinilai karena bukti diagnosis tidak ada tidak memboroskan Sol', async () => {
  const g = gateway();
  const hasil = await tinjauLanjutan(record, { tinjauan_diagnosis: { status: 'belum_dinilai' } }, pages, [2], null, { gateway: g });
  expect(hasil.metadata.status).toBe('perlu_lengkapi_berkas');
  expect(g.panggilModel).not.toHaveBeenCalled();
});
test('kutipan palsu atau kode baru dari Sol ditolak; hasil awal tetap berlaku', async () => {
  const d = raw(); d.kandidat[0].bukti[0].kutipan = 'SpO2 70%';
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan([]) }, pages, [2], null, { gateway: gateway(d) });
  expect(hasil.metadata.status).toBe('gagal');
  expect(hasil.tinjauan).toBeUndefined();
  expect(hasil.metadata.tokens_used).toBe(1234);
});
test('Sol gagal tidak mengubah saran/kode/risiko awal', async () => {
  const g = { panggilModel: jest.fn(async () => ({ ok: false, penggunaan: { total_tokens: 20 } })) };
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan([]) }, pages, [2], null, { gateway: g });
  expect(hasil.metadata.status).toBe('gagal');
  expect(hasil.tinjauan).toBeUndefined();
  expect(hasil.putusan).toBeUndefined();
});
test('urutan diagnosis yang berbeda ditahan untuk coder, tidak otomatis diganti', async () => {
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan() }, pages, [2], null,
    { ...opsi, paksaSol: true, gateway: gateway(raw(['J18.9', 'J44.9'])) });
  expect(hasil.metadata.status).toBe('perlu_klarifikasi');
  expect(hasil.tinjauan.kode_rekomendasi).toEqual([]);
  expect(hasil.tinjauan.perbandingan_model.awal.kode_rekomendasi).toEqual(['J44.9', 'J18.9']);
});
test('aturan kombinasi pada klaim lama tidak digugurkan Sol yang memilih bersih', async () => {
  const alasan = { sumber_pemeriksaan: 'Ketentuan kombinasi kode', kode: 'KMB-12', ringkas: 'Tinjau pasangan kode', bukti: 'PPOK dan Pneumonia', keparahan: 'tinggi' };
  const kandidat = { alasan: [alasan] };
  const awalPutusan = bentukPutusan(kandidat, { status: 'berisiko_pending', alasan_ids: ['kandidat-1'] }).putusan;
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan([]), putusan_pending: awalPutusan }, pages, [2], kandidat,
    { gateway: gateway(raw(), { status: 'tidak_ditemukan_alasan', alasan_ids: [] }) });
  expect(hasil.putusan.status).toBe('berisiko_pending');
  expect(hasil.putusan.alasan).toEqual([alasan]);
  expect(hasil.putusan.perbandingan_model).toBeDefined();
});
test('risiko wajib IGD tetap berlaku meski Sol mengabaikannya', async () => {
  const alasan = { sumber_pemeriksaan: 'Kriteria kegawatdaruratan', ringkas: 'Kriteria belum terpenuhi', wajib_pending: true, keparahan: 'tinggi' };
  const kandidat = { alasan: [alasan] };
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan([]) }, pages, [2], kandidat,
    { gateway: gateway(raw(), { status: 'tidak_ditemukan_alasan', alasan_ids: [] }) });
  expect(hasil.putusan.status).toBe('berisiko_pending');
  expect(hasil.putusan.alasan).toContain(alasan);
});
test('Sol tidak dapat mengarang alasan pending di luar daftar kandidat', async () => {
  const kandidat = { alasan: [{ ringkas: 'Risiko asli' }] };
  const hasil = await tinjauLanjutan(record, { ...ai, tinjauan_diagnosis: tinjauan([]) }, pages, [2], kandidat,
    { gateway: gateway(raw(), { status: 'berisiko_pending', alasan_ids: ['fiktif'] }) });
  expect(hasil.metadata.status).toBe('gagal');
  expect(hasil.putusan).toBeUndefined();
});
test('sampel kualitas stabil, tanpa kuota memblokir kasus ambigu', () => {
  const jelas = { ...ai, tinjauan_diagnosis: tinjauan() };
  expect(ambilPemicu(record, jelas, { persenSampel: 100 })).toEqual(['sampel_kualitas']);
  expect(ambilPemicu(record, jelas, { persenSampel: 0 })).toEqual([]);
  expect(ambilPemicu(record, { ...jelas, tinjauan_diagnosis: tinjauan([]) }, { persenSampel: 0 })).toContain('diagnosis_atau_urutan_belum_jelas');
});
test('administrasi pasti dan label UMUM dengan SEP bukan pemicu Sol', () => {
  const jelas = { ...ai, tinjauan_diagnosis: tinjauan(), konsistensi_data: [{ id: 'KD-02', nama: 'UMUM', yang_ditemukan: { kutipan: 'UMUM' } }],
    putusan_pending: { status: 'perlu_dicek', alasan: [{ sumber_pemeriksaan: 'Aturan validasi', ringkas: 'Tanggal kosong' }] } };
  expect(ambilPemicu(record, jelas, opsi)).toEqual([]);
});
test('pemicu konflik prosedur harus memiliki kutipan, bukan hanya jumlah kode', () => {
  expect(ambilPemicu(record, { konsistensi_data: [{ id: 'KD-P', nama: 'Prosedur berbeda', yang_ditemukan: { kutipan: 'tindakan dilakukan' } }] }, opsi)).toContain('prosedur_dan_bukti_perlu_ditinjau');
});
test('pemilihan bukti mempertahankan semua halaman yang dirujuk', () => {
  expect(pilihHalaman(pages, [2], { code_evidence: [{ page_number: 4 }] }).map(p => p.page_number)).toEqual([2, 3, 4]);
  expect(pilihHalaman(pages, [2], { putusan_pending: { alasan: [{ bukti: 'Keterangan (hal. 4)' }] } }).map(p => p.page_number)).toEqual([2, 3, 4]);
});
test('fitur dapat dimatikan eksplisit dan jenis klaim di luar RJ/RI tidak dialihkan', () => {
  expect(ambilPemicu({ jenis_klaim: 'OTHER' }, { tinjauan_diagnosis: tinjauan([]) }, opsi)).toEqual([]);
  process.env.AI_HYBRID_SOL_ENABLED = 'false';
  expect(ambilPemicu(record, { tinjauan_diagnosis: tinjauan([]) }, opsi)).toEqual([]);
});
