jest.mock('../../services/kodeDiagnosisWhoService', () => ({ petakanKeKodeWho: jest.fn() }));
const { petakanKeKodeWho } = require('../../services/kodeDiagnosisWhoService');
const { periksaKode, tandaiStatusKamusEvidence, galatKamusRecord } = require('../../services/validasiKamusService');
const { pastikanDiagnosisWho } = require('../../services/pastikanDiagnosisWhoService');
const { validasiRecordDenganKamus } = require('../../services/validasiRecordKamusService');
const { simpanAiReview } = require('../../services/simpanAiReviewService');
const { isiKodeDariSaranTervalidasi } = require('../../routes/claimFiles');

function dbKamus(codes = ['R06.0', 'J45.9']) {
  return { all: jest.fn(async (sql, params = []) => /COUNT/.test(sql)
    ? [{ jumlah: codes.length }] : params.filter(c => codes.includes(c)).map(code => ({ code }))) };
}
beforeEach(() => jest.clearAllMocks());

test('bukti tercetak terpisah dari keberadaan kode: J45.3 bukan VALID', async () => {
  const check = await periksaKode(dbKamus(), ['J45.3', 'J45.9']);
  const evidence = [{ code: 'J45.3', found: true, review_status: 'VALID' }, { code: 'J45.9', found: true, review_status: 'VALID' }];
  tandaiStatusKamusEvidence(evidence, { diagnosis: check });
  expect(evidence[0]).toMatchObject({ evidence_found: true, dictionary_status: 'not_found', review_status: 'PENDING', coding_review_status: 'PENDING' });
  expect(evidence[0].review_flags[0].reason).toBe('Tercantum di dokumen; perlu verifikasi kode');
  expect(evidence[1]).toMatchObject({ dictionary_status: 'valid', review_status: 'VALID' });
});

test.each(['kosong', 'error'])('kamus %s: isian asli tidak berubah dan bukan kode luar kamus', async kind => {
  const db = kind === 'kosong' ? dbKamus([]) : { all: async () => { throw Error('offline'); } };
  const result = await pastikanDiagnosisWho(db, 'j45.3, R06.0');
  expect(result).toMatchObject({ diaglist: 'j45.3, R06.0', statusKamus: 'tidak_tersedia', kodeLuarKamus: [], penggantian: [] });
  expect(petakanKeKodeWho).not.toHaveBeenCalled();
  const evidence = [{ code: 'J45.3', found: true, review_status: 'VALID' }];
  tandaiStatusKamusEvidence(evidence, { diagnosis: await periksaKode(db, ['J45.3']) });
  expect(evidence[0]).toMatchObject({ dictionary_status: 'unavailable', review_status: 'PENDING' });
  const errors = await galatKamusRecord(db, { diagnosa_list: 'J45.3' });
  expect(errors[0]).toMatchObject({ dictionary_status: 'unavailable', severity: 'major' });
});

test('Eifelin tanpa saran AI: kutipan halaman 2, identitas penyamaran, dan audit dibawa ke pemetaan', async () => {
  // Pilihan mapper tiruan; tes ini tidak menetapkan padanan klinis pasien.
  petakanKeKodeWho.mockResolvedValue({ kode: 'J45.9', dari: 'ai_pilih_dari_daftar' });
  const quote = 'J45.3 - Asthma with Exacerbation (IM)';
  const dikenal = { nama: 'PASIEN UJI', no_rm: '0001' };
  const result = await pastikanDiagnosisWho(dbKamus(), 'R06.0;J45.3', '', {
    konteksPerKode: { 'J45.3': quote }, dikenal,
    buktiPerKode: { 'J45.3': [{ halaman: 2, kutipan: quote }] }, waktu: '2026-10-01T00:00:00Z',
  });
  expect(petakanKeKodeWho).toHaveBeenCalledWith('J45.3', quote, dikenal);
  expect(result.diaglist).toBe('R06.0;J45.9');
  expect(result.penggantian[0]).toMatchObject({ kode_asal: 'J45.3', kode_baru: 'J45.9', sumber: 'kutipan_dokumen', konteks: quote, bukti: [{ halaman: 2, kutipan: quote }] });
});

test('J45.9 sah tetap sama, jawaban mapper di luar kamus ditolak', async () => {
  expect((await pastikanDiagnosisWho(dbKamus(), 'J45.9')).penggantian).toEqual([]);
  expect(petakanKeKodeWho).not.toHaveBeenCalled();
  petakanKeKodeWho.mockResolvedValue({ kode: 'J45.909' });
  expect((await pastikanDiagnosisWho(dbKamus(), 'J45.3', 'Asthma')).diaglist).toBe('J45.3');
});

test('kode manual tak dikenal tidak valid walaupun semua rule format dinonaktifkan', async () => {
  const errors = await validasiRecordDenganKamus(dbKamus(), { diagnosa_list: 'J45.3' }, []);
  expect(errors).toContainEqual(expect.objectContaining({ rule_id: 'RV-05', severity: 'major', actual_value: 'J45.3' }));
});

test('riwayat penggantian dan ekstraksi asli tidak hilang saat baca ulang', async () => {
  const change = { kode_asal: 'J45.3', kode_baru: 'J45.9', waktu: 'hari1' };
  const original = { DIAGLIST: 'R06.0;J45.3', PROCLIST: '' };
  let stored = { penggantian_kode: [change], ekstraksi_kode_asli: original };
  const db = { prepare: () => ({ get: async () => ({ ai_review: JSON.stringify(stored) }), run: async json => { stored = JSON.parse(json); } }) };
  await simpanAiReview(db, 'test', { suggested_codes: [] });
  await simpanAiReview(db, 'test', { penggantian_kode: [change], ekstraksi_kode_asli: { DIAGLIST: 'J45.9' } });
  expect(stored.penggantian_kode).toEqual([change]);
  expect(stored.ekstraksi_kode_asli).toEqual(original);
});

test('pipeline tanpa saran diagnosis menyinkronkan DIAGLIST, raw_data, bukti sumber, status dan audit', async () => {
  petakanKeKodeWho.mockResolvedValue({ kode: 'J45.9' });
  const state = { diagnosa_list: 'R06.0;J45.3', prosedur_list: '93.94', raw_data: JSON.stringify({ DIAGLIST: 'R06.0;J45.3' }), validation_status: 'error' };
  const db = dbKamus(['R06.0', 'J45.9', '93.94']);
  db.prepare = sql => ({
    get: async () => state,
    all: async () => [],
    run: async value => {
      if (/SET raw_data/.test(sql)) state.raw_data = value;
      if (/SET ai_review/.test(sql)) state.ai_review = value;
      if (/SET diagnosa_list/.test(sql)) state.diagnosa_list = value;
      if (/SET validation_status/.test(sql)) state.validation_status = value;
    },
  });
  const review = { suggested_codes: [], code_evidence: [{ code: 'J45.3', type: 'diagnosis', found: true, page_number: 2, quotation: 'J45.3 - Asthma with Exacerbation (IM)' }] };
  await isiKodeDariSaranTervalidasi(db, 'synthetic-record', { DIAGLIST: state.diagnosa_list, PROCLIST: '93.94' }, review);
  expect(state.diagnosa_list).toBe('R06.0;J45.9');
  expect(JSON.parse(state.raw_data).DIAGLIST).toBe('R06.0;J45.9');
  const saved = JSON.parse(state.ai_review);
  expect(saved.code_evidence[0]).toMatchObject({ code: 'J45.3', diganti_menjadi: 'J45.9', dictionary_status: 'not_found' });
  expect(saved.ekstraksi_kode_asli.DIAGLIST).toBe('R06.0;J45.3');
  expect(saved.penggantian_kode[0].bukti[0].halaman).toBe(2);
  expect(state.validation_status).toBe('valid');
});

test('gagal menyimpan audit membatalkan transaksi penggantian, termasuk raw_data', async () => {
  petakanKeKodeWho.mockResolvedValue({ kode: 'J45.9' });
  let state = { raw_data: JSON.stringify({ DIAGLIST: 'J45.3' }), diagnosa_list: 'J45.3' };
  const original = { ...state };
  const db = dbKamus();
  db.prepare = sql => ({
    get: async () => state, all: async () => [],
    run: async value => {
      if (/SET raw_data/.test(sql)) state.raw_data = value;
      if (/SET ai_review/.test(sql)) throw Error('audit write failed');
    },
  });
  db.transaction = jest.fn(async callback => {
    const snapshot = { ...state };
    try { return await callback(db); } catch (error) { state = snapshot; throw error; }
  });
  await expect(isiKodeDariSaranTervalidasi(db, 'synthetic', { DIAGLIST: 'J45.3' }, {
    code_evidence: [{ code: 'J45.3', type: 'diagnosis', found: true, quotation: 'Asthma with Exacerbation', page_number: 2 }],
  })).rejects.toThrow('audit write failed');
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(state).toEqual(original);
});
