// Layanan jaringan tiruan tetap memakai fetch yang disiapkan setiap skenario.
jest.mock('../../services/httpTanpaTenggatService', () => ({
  kirim: (...args) => global.fetch(...args),
}));

const { generateAiReview } = require('../../services/aiReviewService');
const router = require('../../services/routerModelService');
const env = { ...process.env };
const fetchAwal = global.fetch;
afterEach(() => { process.env = { ...env }; global.fetch = fetchAwal; router.hapusCache(); });

test.each(['RAWAT_JALAN', 'RAWAT_INAP'])('alur lengkap %s: Luna medium lalu satu Sol high, tanpa mengubah record', async jenis_klaim => {
  process.env.AI_PROVIDER_API_KEY = 'test-key';
  process.env.AI_PROVIDER_BASE_URL = 'https://api.openai.com/v1';
  process.env.AI_MODEL = 'gpt-6-luna';
  process.env.AI_REVIEW_MODEL = 'gpt-6.1-sol';
  process.env.AI_SOL_SAMPLE_PERCENT = '0';
  router.hapusCache();
  const record = { id: 'kasus-hybrid', jenis_klaim, diagnosa_list: 'E11.9', prosedur_list: '' };
  const sebelum = JSON.stringify(record);
  const pages = [{ page_number: 2, ocr_text: 'Resume Medis\nDiagnosis akhir: Diabetes melitus tipe 2.\nAnamnesis: kontrol rutin. Pemeriksaan: keadaan umum baik.' }];
  const diagnosis = codes => ({ ringkasan: codes.length ? 'Diagnosis akhir didukung resume.' : 'Periksa penentuan diagnosis utama.',
    kode_rekomendasi: codes, kandidat: [{ kode: 'E11.9', status: 'didukung', alasan: 'Dokter mencatat diagnosis akhir.',
      bukti: [{ halaman: 2, kutipan: 'Diabetes melitus tipe 2.' }] }], klarifikasi: codes.length ? [] : ['Periksa diagnosis utama.'] });
  global.fetch = jest.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    let hasil;
    if (body.model === 'gpt-6.1-sol') hasil = { diagnosis: diagnosis(['E11.9']), putusan: { status: 'tidak_ditemukan_alasan', alasan_ids: [] } };
    else if (system.includes('Tinjau kesesuaian kandidat diagnosis')) hasil = diagnosis([]);
    else if (system.includes('Anda menilai apakah klaim')) hasil = { status: 'tidak_ditemukan_alasan', alasan_ids: [] };
    else hasil = { field_notes: {}, suggested_codes: [], pending_risk_notes: [], code_evidence: [{ code: 'E11.9', type: 'diagnosis', found: true,
      page_number: 2, quotation: 'Diabetes melitus tipe 2.' }] };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(hasil) } }],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 } }) };
  });
  const result = await generateAiReview(record, [], pages);
  const requests = global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(requests.filter(r => r.model === 'gpt-6.1-sol')).toHaveLength(1);
  expect(requests.filter(r => r.model === 'gpt-6-luna').every(r => r.reasoning_effort === 'medium')).toBe(true);
  expect(requests.find(r => r.model === 'gpt-6.1-sol').reasoning_effort).toBe('high');
  expect(result.pemeriksaan_lanjutan).toMatchObject({ status: 'selesai', model: 'gpt-6.1-sol' });
  expect(result.tinjauan_diagnosis.kode_rekomendasi).toEqual(['E11.9']);
  expect(JSON.stringify(record)).toBe(sebelum);
});
