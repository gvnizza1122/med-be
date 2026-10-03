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

describe('skema Luna/Sol: Sol hanya untuk kasus membingungkan', () => {
  const jelas = { ...ai, tinjauan_diagnosis: tinjauan() };
  const tarif = (amount, extra = {}) => ({ amount, ...extra });
  test('tanpa pemicu, tidak ada sampel acak bawaan', () => {
    delete process.env.AI_SOL_SAMPLE_PERCENT;
    expect(ambilPemicu(record, jelas)).toEqual([]);
  });
  test('INA-CBG berbeda dengan casemix -> Sol', () => {
    expect(ambilPemicu(record, { ...jelas, inacbg_result: { code: 'O-6-10-II' }, tariff_result: tarif(4926400),
      lembar_grouper: { inacbg: { kode: 'O-6-10-I' } } }, opsi)).toEqual(['inacbg_atau_tarif_belum_pasti']);
  });
  test('tarif kosong atau kelas diasumsikan -> Sol; sama dengan casemix -> tidak', () => {
    expect(ambilPemicu(record, { ...jelas, inacbg_result: { code: 'I-4-24-I' }, tariff_result: tarif(null) }, opsi)).toContain('inacbg_atau_tarif_belum_pasti');
    expect(ambilPemicu(record, { ...jelas, inacbg_result: { code: 'I-4-24-I' }, tariff_result: tarif(2116600, { kelas_asumsi: true }) }, opsi)).toContain('inacbg_atau_tarif_belum_pasti');
    expect(ambilPemicu(record, { ...jelas, inacbg_result: { code: 'I-4-24-I' }, tariff_result: tarif(2116600),
      lembar_grouper: { inacbg: { kode: 'I-4-24-I' } } }, opsi)).toEqual([]);
  });
});

describe('hemat biaya Sol tanpa mengurangi bukti', () => {
  // DB tiruan cukup untuk get/run tabel cache.
  function dbTiruan() {
    const isi = new Map();
    return {
      isi,
      get: jest.fn(async (_sql, [kunci]) => isi.get(kunci) || null),
      run: jest.fn(async (_sql, [kunci, hasil, model]) => { isi.set(kunci, { hasil, model, dibuat: new Date().toISOString() }); }),
    };
  }
  test('masukan sama persis -> hasil Sol dipakai ulang, tanpa panggilan kedua', async () => {
    const db = dbTiruan();
    const awal = { ...ai, tinjauan_diagnosis: tinjauan([]) };
    const g1 = gateway();
    const pertama = await tinjauLanjutan(record, awal, pages, [2], null, { ...opsi, gateway: g1, db });
    expect(g1.panggilModel).toHaveBeenCalledTimes(1);
    expect(db.isi.size).toBe(1);
    const g2 = gateway();
    const kedua = await tinjauLanjutan(record, awal, pages, [2], null, { ...opsi, gateway: g2, db });
    expect(g2.panggilModel).not.toHaveBeenCalled();
    expect(kedua.metadata).toMatchObject({ status: 'selesai', dari_cache: true, tokens_used: 0 });
    expect(kedua.tinjauan.kode_rekomendasi).toEqual(pertama.tinjauan.kode_rekomendasi);
  });
  test('masukan berubah -> Sol dipanggil lagi; jawaban gagal tidak disimpan', async () => {
    const db = dbTiruan();
    const awal = { ...ai, tinjauan_diagnosis: tinjauan([]) };
    const gagal = { panggilModel: jest.fn(async () => ({ ok: true, model: 'gpt-6.1-sol', penggunaan: { total_tokens: 9 }, hasil: { diagnosis: { salah: true } } })) };
    await tinjauLanjutan(record, awal, pages, [2], null, { ...opsi, gateway: gagal, db });
    expect(db.isi.size).toBe(0);
    const g = gateway();
    await tinjauLanjutan(record, awal, [...pages, { page_number: 5, ocr_text: 'CPPT: sesak membaik' }], [2], null, { ...opsi, gateway: g, db });
    expect(g.panggilModel).toHaveBeenCalledTimes(1);
  });
  test('SEP & rincian biaya tidak dikirim kecuali dirujuk; lab dikirim sebagai tabel ringkas', () => {
    const hal = [
      { page_number: 1, ocr_text: 'SURAT ELEGIBILITAS PESERTA\nNo.SEP : 0170R0111225V003427\nDiagnosa Awal : Z35' },
      { page_number: 2, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nKPD 3 hari' },
      { page_number: 5, ocr_text: 'HASIL PEMERIKSAAN LABORATORIUM\nTgl.Keluar Hasil : 31-12-2025\nHEMATOLOG!\nHemoglobin 13.3 12-15 g/dL\nLokosit 9.77 4.5-11 10^3/uL\nNeutrofila 7.64 H 1.5-7 sel/mm^3' },
      { page_number: 19, ocr_text: 'RINCIAN BIAYA PERAWATAN\nTindakan operasi 4.000.000' },
    ];
    const pilih = pilihHalaman(hal, [2], {});
    expect(pilih.map(p => p.page_number)).toEqual([2, 5]);
    const lab = pilih.find(p => p.page_number === 5).ocr_text;
    expect(lab).toContain('Leukosit: 9.77 10^3/uL (rujukan 4.5-11)');
    expect(lab).toContain('Neutrofil absolut: 7.64');
    expect(lab).toMatch(/TINGGI/);
    // Dirujuk alasan pending -> tetap dikirim.
    expect(pilihHalaman(hal, [2], { putusan_pending: { alasan: [{ bukti: 'Diagnosa awal SEP (hal. 1)' }] } }).map(p => p.page_number)).toContain(1);
  });
});
