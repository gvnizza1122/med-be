process.env.AI_PROVIDER_API_KEY = 'test-key';
process.env.AI_PROVIDER_BASE_URL = 'https://api.openai.com/v1';
process.env.AI_MODEL = 'gpt-4o-mini';

const { validateRecordWithAI } = require('../../services/aiValidationService');

afterAll(() => {
  delete process.env.AI_PROVIDER_API_KEY;
  delete process.env.AI_PROVIDER_BASE_URL;
  delete process.env.AI_MODEL;
});

function makeRecord(overrides = {}) {
  return {
    id: 'rec-001', gender: '1', umur_tahun: 45,
    sep: '0170R0111225V003433',
    diagnosa_list: 'E11.9;I10', prosedur_list: '88.72',
    jenis_rawat: 'RAWAT_INAP', los: 4,
    tarif_rs: 5000000, tarif_inacbg: 4200000,
    flag_rujuk_balik_prb: 0,
    ...overrides
  };
}

function mockFetchOk(body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      choices: [{ message: { content: JSON.stringify(body) } }]
    })
  });
}

function mockFetchError(status, text) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(text)
  });
}

function mockFetchNetworkError(message) {
  global.fetch = jest.fn().mockRejectedValue(new Error(message));
}

describe('aiValidationService', () => {
  beforeEach(() => {
    global.fetch = undefined;
  });

  describe('prompt construction', () => {
    test('mengirim request ke API dengan model dan API key', async () => {
      mockFetchOk({ status: 'valid', reason: 'OK', suggestion: 'None' });
      await validateRecordWithAI(makeRecord());
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = fetch.mock.calls[0];
      expect(url).toContain('/chat/completions');
      expect(opts.headers['Authorization']).toBe('Bearer test-key');
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.messages).toHaveLength(2);
    });

    test('format prompt mencakup field pasien', async () => {
      mockFetchOk({ status: 'valid', reason: 'OK', suggestion: 'None' });
      await validateRecordWithAI(makeRecord({ gender: '2', umur_tahun: 30, tarif_rs: 10000000 }));
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      const userMsg = body.messages[1].content;
      expect(userMsg).toContain('30');
      expect(userMsg).toContain('10.000.000');
    });
  });

  describe('response parsing', () => {
    test('mem-parse response JSON valid', async () => {
      mockFetchOk({ status: 'valid', reason: 'Semua sesuai regulasi', suggestion: 'Tidak ada' });
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('valid');
      expect(result.reason).toBe('Semua sesuai regulasi');
    });

    test('mem-parse response dengan markdown code block', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '```json\n{"status":"dispute","reason":"Upcoding","suggestion":"Hapus diagnosis"}\n```' } }]
        })
      });
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('dispute');
    });

    test('fallback ke warning jika response kosong', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '' } }] })
      });
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('warning');
      expect(result.reason).toContain('Gagal');
    });
  });

  describe('error handling', () => {
    test('return warning jika API error (429)', async () => {
      mockFetchError(429, 'Rate limit exceeded');
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('warning');
      expect(result.reason).toContain('Gagal audit AI');
    });

    test('return warning jika network error', async () => {
      mockFetchNetworkError('ETIMEDOUT');
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('warning');
      expect(result.reason).toContain('Gagal');
    });

    test('return warning untuk response JSON tidak valid', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'not json at all' } }]
        })
      });
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('warning');
    });
  });

  describe('retry logic', () => {
    test('retry 2x lalu return warning jika terus gagal', async () => {
      mockFetchNetworkError('Service Unavailable');
      const result = await validateRecordWithAI(makeRecord());
      expect(result.status).toBe('warning');
      expect(result.reason).toContain('3 percobaan');
      expect(fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('concurrency limiter', () => {
    test('memproses banyak record tanpa error', async () => {
      mockFetchOk({ status: 'valid', reason: 'OK', suggestion: '' });
      const records = Array.from({ length: 10 }, (_, i) => makeRecord({ id: `rec-${i}` }));
      const results = await Promise.all(records.map(r => validateRecordWithAI(r)));
      expect(results).toHaveLength(10);
      results.forEach(r => expect(r.status).toBe('valid'));
    });
  });
});
