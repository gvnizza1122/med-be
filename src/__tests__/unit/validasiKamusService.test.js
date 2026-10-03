jest.mock('../../services/kodeDiagnosisWhoService', () => ({ petakanKeKodeWho: jest.fn() }));
const { petakanKeKodeWho } = require('../../services/kodeDiagnosisWhoService');
const { periksaKode, tandaiStatusKamusEvidence, galatKamusRecord } = require('../../services/validasiKamusService');
const { pastikanDiagnosisWho } = require('../../services/pastikanDiagnosisWhoService');
const { validasiRecordDenganKamus } = require('../../services/validasiRecordKamusService');
const { simpanAiReview } = require('../../services/simpanAiReviewService');
const { isiKodeDariSaranTervalidasi } = require('../../routes/claimFiles');

function dbKamus(codes = ['R06.0', 'R10.4']) {
  return { all: jest.fn(async (sql, params = []) => /COUNT/.test(sql)
    ? [{ jumlah: codes.length }] : params.filter(c => codes.includes(c)).map(code => ({ code }))) };
}
beforeEach(() => jest.clearAllMocks());

test('bukti tercetak terpisah dari keberadaan kode: R10.84 bukan VALID', async () => {
  const check = await periksaKode(dbKamus(), ['R10.84', 'R10.4']);
  const evidence = [{ code: 'R10.84', found: true, review_status: 'VALID' }, { code: 'R10.4', found: true, review_status: 'VALID' }];
  tandaiStatusKamusEvidence(evidence, { diagnosis: check });
  expect(evidence[0]).toMatchObject({ evidence_found: true, dictionary_status: 'not_found', review_status: 'PENDING', coding_review_status: 'PENDING' });
  expect(evidence[0].review_flags[0].reason).toBe('Tercantum di dokumen; perlu verifikasi kode');
  expect(evidence[1]).toMatchObject({ dictionary_status: 'valid', review_status: 'VALID' });
});

test.each(['kosong', 'error'])('kamus %s: isian asli tidak berubah dan bukan kode luar kamus', async kind => {
  const db = kind === 'kosong' ? dbKamus([]) : { all: async () => { throw Error('offline'); } };
  const result = await pastikanDiagnosisWho(db, 'r10.84, R06.0');
  expect(result).toMatchObject({ diaglist: 'r10.84, R06.0', statusKamus: 'tidak_tersedia', kodeLuarKamus: [], penggantian: [] });
  expect(petakanKeKodeWho).not.toHaveBeenCalled();
  const evidence = [{ code: 'R10.84', found: true, review_status: 'VALID' }];
  tandaiStatusKamusEvidence(evidence, { diagnosis: await periksaKode(db, ['R10.84']) });
  expect(evidence[0]).toMatchObject({ dictionary_status: 'unavailable', review_status: 'PENDING' });
  const errors = await galatKamusRecord(db, { diagnosa_list: 'R10.84' });
  expect(errors[0]).toMatchObject({ dictionary_status: 'unavailable', severity: 'major' });
});

test('Kode ICD-10-CM tanpa saran AI (pola SUMIDAH): kutipan halaman 2, identitas penyamaran, dan audit dibawa ke pemetaan', async () => {
  // Pilihan mapper tiruan; tes ini tidak menetapkan padanan klinis pasien.
  petakanKeKodeWho.mockResolvedValue({ kode: 'R10.4', dari: 'ai_pilih_dari_daftar' });
  const quote = 'R10.84 - Generalized abdominal pain';
  const dikenal = { nama: 'PASIEN UJI', no_rm: '0001' };
  const result = await pastikanDiagnosisWho(dbKamus(), 'R06.0;R10.84', '', {
    konteksPerKode: { 'R10.84': quote }, dikenal,
    buktiPerKode: { 'R10.84': [{ halaman: 2, kutipan: quote }] }, waktu: '2026-10-01T00:00:00Z',
  });
  expect(petakanKeKodeWho).toHaveBeenCalledWith('R10.84', quote, dikenal);
  expect(result.diaglist).toBe('R06.0;R10.4');
  expect(result.penggantian[0]).toMatchObject({ kode_asal: 'R10.84', kode_baru: 'R10.4', sumber: 'kutipan_dokumen', konteks: quote, bukti: [{ halaman: 2, kutipan: quote }] });
});

test('R10.4 sah tetap sama, jawaban mapper di luar kamus ditolak', async () => {
  expect((await pastikanDiagnosisWho(dbKamus(), 'R10.4')).penggantian).toEqual([]);
  expect(petakanKeKodeWho).not.toHaveBeenCalled();
  petakanKeKodeWho.mockResolvedValue({ kode: 'R10.409' });
  expect((await pastikanDiagnosisWho(dbKamus(), 'R10.84', 'abdominal pain')).diaglist).toBe('R10.84');
});

test('kode manual tak dikenal tidak valid walaupun semua rule format dinonaktifkan', async () => {
  const errors = await validasiRecordDenganKamus(dbKamus(), { diagnosa_list: 'R10.84' }, []);
  expect(errors).toContainEqual(expect.objectContaining({ rule_id: 'RV-05', severity: 'major', actual_value: 'R10.84' }));
});

test('riwayat penggantian dan ekstraksi asli tidak hilang saat baca ulang', async () => {
  const change = { kode_asal: 'R10.84', kode_baru: 'R10.4', waktu: 'hari1' };
  const original = { DIAGLIST: 'R06.0;R10.84', PROCLIST: '' };
  let stored = { penggantian_kode: [change], ekstraksi_kode_asli: original };
  const db = { prepare: () => ({ get: async () => ({ ai_review: JSON.stringify(stored) }), run: async json => { stored = JSON.parse(json); } }) };
  await simpanAiReview(db, 'test', { suggested_codes: [] });
  await simpanAiReview(db, 'test', { penggantian_kode: [change], ekstraksi_kode_asli: { DIAGLIST: 'R10.4' } });
  expect(stored.penggantian_kode).toEqual([change]);
  expect(stored.ekstraksi_kode_asli).toEqual(original);
});

test('pipeline tanpa saran diagnosis menyinkronkan DIAGLIST, raw_data, bukti sumber, status dan audit', async () => {
  petakanKeKodeWho.mockResolvedValue({ kode: 'R10.4' });
  const state = { diagnosa_list: 'R06.0;R10.84', prosedur_list: '93.94', raw_data: JSON.stringify({ DIAGLIST: 'R06.0;R10.84' }), validation_status: 'error' };
  const db = dbKamus(['R06.0', 'R10.4', '93.94']);
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
  const review = { suggested_codes: [], code_evidence: [{ code: 'R10.84', type: 'diagnosis', found: true, page_number: 2, quotation: 'R10.84 - Generalized abdominal pain' }] };
  await isiKodeDariSaranTervalidasi(db, 'synthetic-record', { DIAGLIST: state.diagnosa_list, PROCLIST: '93.94' }, review);
  expect(state.diagnosa_list).toBe('R06.0;R10.4');
  expect(JSON.parse(state.raw_data).DIAGLIST).toBe('R06.0;R10.4');
  const saved = JSON.parse(state.ai_review);
  expect(saved.code_evidence[0]).toMatchObject({ code: 'R10.84', diganti_menjadi: 'R10.4', dictionary_status: 'not_found' });
  expect(saved.ekstraksi_kode_asli.DIAGLIST).toBe('R06.0;R10.84');
  expect(saved.penggantian_kode[0].bukti[0].halaman).toBe(2);
  expect(state.validation_status).toBe('valid');
});

test('gagal menyimpan audit membatalkan transaksi penggantian, termasuk raw_data', async () => {
  petakanKeKodeWho.mockResolvedValue({ kode: 'R10.4' });
  let state = { raw_data: JSON.stringify({ DIAGLIST: 'R10.84' }), diagnosa_list: 'R10.84' };
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
  await expect(isiKodeDariSaranTervalidasi(db, 'synthetic', { DIAGLIST: 'R10.84' }, {
    code_evidence: [{ code: 'R10.84', type: 'diagnosis', found: true, quotation: 'Generalized abdominal pain', page_number: 2 }],
  })).rejects.toThrow('audit write failed');
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(state).toEqual(original);
});

describe('kode IM iDRG (kasus Eifelin J45.3) -- sah sejak RS menagih dengan iDRG', () => {
  test('J45.3 berstatus valid_im, bukti tidak dibuat pending', async () => {
    const check = await periksaKode(dbKamus(), ['J45.3', 'R10.84']);
    expect(check.hasil).toEqual({ 'J45.3': 'valid_im', 'R10.84': 'not_found' });
    const evidence = [{ code: 'J45.3', found: true, review_status: 'VALID' }];
    tandaiStatusKamusEvidence(evidence, { diagnosis: check });
    expect(evidence[0]).toMatchObject({ dictionary_status: 'valid_im', review_status: 'VALID', coding_review_status: 'VALID' });
  });

  test('J45.3 tidak diganti otomatis dan tidak masuk kode_luar_kamus', async () => {
    const result = await pastikanDiagnosisWho(dbKamus(), 'R06.0;J45.3', 'J45.3 - Asthma with Exacerbation (IM)');
    expect(result).toMatchObject({ diaglist: 'R06.0;J45.3', kodeLuarKamus: [], penggantian: [] });
    expect(petakanKeKodeWho).not.toHaveBeenCalled();
  });

  test('edit manual J45.3 tidak menghasilkan galat RV-05', async () => {
    expect(await validasiRecordDenganKamus(dbKamus(), { diagnosa_list: 'J45.3' }, [])).toEqual([]);
  });

  test('kode prosedur IM dikenali', async () => {
    const check = await periksaKode(dbKamus(['93.94']), ['36.050', '99.99'], 'prosedur');
    expect(check.hasil).toEqual({ '36.050': 'valid_im', '99.99': 'not_found' });
  });
});
