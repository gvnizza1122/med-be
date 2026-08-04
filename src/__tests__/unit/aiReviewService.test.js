const { generateAiReview, validateQuotation, normalizeText } = require('../../services/aiReviewService');

describe('normalizeText', () => {
  test('collapses whitespace/newlines and lowercases', () => {
    expect(normalizeText('Hasil   USG\n  uterus  7,2x4,23  cm')).toBe('hasil usg uterus 7,2x4,23 cm');
  });
});

describe('validateQuotation — bug fix: kutipan yang melintasi baris OCR', () => {
  const evidencePool = [
    { page_number: 2, ocr_text: 'Hasil USG\nuterus 7,2x4,23,4,8 cm EL 0,5 cm massa hiperechoic' },
  ];

  test('kutipan persis dalam satu baris tetap valid', () => {
    expect(validateQuotation('uterus 7,2x4,23,4,8 cm EL 0,5 cm massa hiperechoic', 2, evidencePool)).toBe(true);
  });

  test('kutipan yang melintasi baris baru (whitespace beda) SEKARANG tetap valid', () => {
    // AI mengutip sebagai satu baris, padahal di dokumen aslinya ada line-break
    // di antara "Hasil USG" dan "uterus" — sebelum fix ini gagal match.
    expect(validateQuotation('Hasil USG uterus 7,2x4,23,4,8 cm', 2, evidencePool)).toBe(true);
  });

  test('kutipan yang benar-benar tidak ada tetap ditolak', () => {
    expect(validateQuotation('diagnosa kanker paru stadium akhir', 2, evidencePool)).toBe(false);
  });

  test('halaman tidak ditemukan tetap ditolak', () => {
    expect(validateQuotation('uterus', 99, evidencePool)).toBe(false);
  });

  test('kutipan kosong/invalid tetap ditolak', () => {
    expect(validateQuotation('', 2, evidencePool)).toBe(false);
    expect(validateQuotation(null, 2, evidencePool)).toBe(false);
  });
});

describe('generateAiReview — short-circuit tanpa panggil AI', () => {
  test('return null kalau tidak ada error dan tidak ada evidence', async () => {
    const result = await generateAiReview({ sep: 'ABC' }, [], []);
    expect(result).toBeNull();
  });

  test('return null kalau AI_PROVIDER_API_KEY tidak diset', async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    const result = await generateAiReview(
      { sep: 'abc' },
      [{ field_name: 'sep', error_message: 'harus uppercase', actual_value: 'abc', expected_value: 'ABC' }],
      []
    );
    expect(result).toBeNull();
  });
});

describe('generateAiReview — dengan AI dikonfigurasi (fetch dimock)', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_API_KEY = 'test-key';
    process.env.AI_PROVIDER_BASE_URL = 'https://api.openai.com/v1';
    process.env.AI_MODEL = 'gpt-4o-mini';
  });

  afterEach(() => {
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_MODEL;
    jest.restoreAllMocks();
  });

  function mockFetchOk(body) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) } }],
        usage: { total_tokens: 123 },
      })),
    });
  }

  test('field_notes hanya diambil untuk field yang benar-benar error', async () => {
    mockFetchOk({
      field_notes: { sep: 'SEP harus uppercase semua.', kolom_lain_yg_tidak_diminta: 'harus diabaikan' },
      code_evidence: [],
      suggested_codes: [],
    });

    const result = await generateAiReview(
      { sep: 'abc' },
      [{ field_name: 'sep', error_message: 'harus uppercase', actual_value: 'abc', expected_value: 'ABC' }],
      []
    );

    expect(result).not.toBeNull();
    expect(result.field_notes).toEqual({ sep: 'SEP harus uppercase semua.' });
  });

  test('code_evidence dengan kutipan yang lolos normalisasi whitespace tetap found:true', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [
        { code: 'E11.9', type: 'diagnosis', found: true, page_number: 1, quotation: 'Diagnosa   diabetes' },
      ],
      suggested_codes: [],
    });

    const evidencePool = [{ page_number: 1, ocr_text: 'Diagnosa\ndiabetes mellitus tipe 2' }];

    const result = await generateAiReview(
      { DIAGLIST: 'E11.9' },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    const entry = result.code_evidence.find(e => e.code === 'E11.9');
    expect(entry.found).toBe(true);
  });
});
