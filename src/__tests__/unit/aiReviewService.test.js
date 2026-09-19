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

  test('jenis_klaim (kategori pelayanan pilihan user) disertakan eksplisit di prompt AI', async () => {
    mockFetchOk({ field_notes: {}, code_evidence: [], suggested_codes: [] });

    await generateAiReview(
      { sep: 'ABC', JENIS_KLAIM: 'RAWAT_JALAN' },
      [{ field_name: 'sep', error_message: 'harus uppercase', actual_value: 'abc', expected_value: 'ABC' }],
      []
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const userMessage = sentBody.messages.find(m => m.role === 'user').content;
    expect(userMessage).toContain('JENIS_KLAIM: RAWAT_JALAN');
  });

  test('inacbg_result dan tariff_result diisi dari grouping service + tariff lookup', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
      suggested_inacbg: 'J-4-15-I',
    });

    const evidencePool = [{ page_number: 1, ocr_text: 'Diagnosa: pneumonia', confidence: 100 }];

    const result = await generateAiReview(
      {
        sep: 'ABC',
        DIAGLIST: 'J18.9',
        PROCLIST: '87.44',
        KELAS_RAWAT: '3',
        JENIS_KLAIM: 'RAWAT_INAP'
      },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    expect(result.inacbg_result).not.toBeNull();
    expect(result.inacbg_result.code).toBeTruthy();
    expect(typeof result.inacbg_result.confidence).toBe('number');
    expect(result.inacbg_result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.inacbg_result.confidence).toBeLessThanOrEqual(1);
    expect(result.inacbg_result.reasoning).toBeTruthy();
  });

  test('tariff_result berisi amount, region, class, source', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
      suggested_inacbg: 'J-4-15-I',
    });

    const evidencePool = [{ page_number: 1, ocr_text: 'Diagnosa: pneumonia', confidence: 100 }];

    const result = await generateAiReview(
      {
        sep: 'ABC',
        DIAGLIST: 'J18.9',
        PROCLIST: '87.44',
        KELAS_RAWAT: '3',
        JENIS_KLAIM: 'RAWAT_INAP'
      },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    expect(result.tariff_result).not.toBeNull();
    if (result.tariff_result.amount !== null) {
      expect(typeof result.tariff_result.amount).toBe('number');
      expect(result.tariff_result.amount).toBeGreaterThan(0);
    }
    expect(result.tariff_result.region).toBeTruthy();
    expect(result.tariff_result.class).toBeTruthy();
    expect(result.tariff_result.source).toBe('PMK_3_2023');
  });

  test('inacbg_result dan tariff_result handle missing codes gracefully', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
    });

    const result = await generateAiReview(
      {
        sep: 'ABC',
        DIAGLIST: '',
        PROCLIST: '',
        JENIS_KLAIM: 'RAWAT_JALAN'
      },
      [{ field_name: 'sep', error_message: 'must be set', actual_value: '', expected_value: 'required' }],
      []
    );

    expect(result).not.toBeNull();
    expect(result.inacbg_result).toBeNull();
    expect(result.tariff_result).toBeNull();
  });

  // Fix 19 Sep 2026: AI kadang berhalusinasi kode INA-CBG yang formatnya
  // valid tapi tidak pernah ada di tabel resmi PMK 3/2023. Pipeline harus
  // memvalidasi dulu, dan degradasi anggun ke grouping fallback -- BUKAN
  // menempelkan tarif fiktif ke kode fiktif itu, dan BUKAN crash.
  test('AI suggested_inacbg VALID (ada di tabel PMK 3/2023) tetap dipakai apa adanya', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
      suggested_inacbg: 'J-4-15-I', // diketahui valid, dipakai juga di test lain di atas
    });

    const evidencePool = [{ page_number: 1, ocr_text: 'Diagnosa: pneumonia', confidence: 100 }];

    const result = await generateAiReview(
      { sep: 'ABC', DIAGLIST: 'J18.9', PROCLIST: '87.44', KELAS_RAWAT: '3', JENIS_KLAIM: 'RAWAT_INAP' },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    expect(result.inacbg_result.code).toBe('J-4-15-I');
    expect(result.inacbg_result.source).toBe('PMK_3_2023');
    expect(result.suggested_inacbg).toBe('J-4-15-I');
    expect(result.tariff_result.source).toBe('PMK_3_2023');
  });

  test('AI suggested_inacbg TIDAK VALID (bukan kode Permenkes asli) → fallback ke grouping service, bukan crash/kode fiktif', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
      // Kode ngasal ini secara sengaja BUKAN entri resmi di tabel PMK 3/2023 --
      // meniru halusinasi AI.
      suggested_inacbg: 'ZZ-9-99-XYZ-HALU',
    });

    const evidencePool = [{ page_number: 1, ocr_text: 'Diagnosa: pneumonia', confidence: 100 }];

    const result = await generateAiReview(
      { sep: 'ABC', DIAGLIST: 'J18.9', PROCLIST: '87.44', KELAS_RAWAT: '3', JENIS_KLAIM: 'RAWAT_INAP' },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    // Kode fiktif AI TIDAK boleh muncul di hasil manapun
    expect(result.inacbg_result.code).not.toBe('ZZ-9-99-XYZ-HALU');
    expect(result.suggested_inacbg).not.toBe('ZZ-9-99-XYZ-HALU');
    expect(result.inacbg_result.code).toBeTruthy();
    // Reasoning harus berasal dari grouping heuristik (bukti kode AI yang
    // invalid benar2 diabaikan dan diganti hasil fallback, terlepas dari
    // apakah kode fallback itu kebetulan match tabel resmi atau tidak).
    expect(result.inacbg_result.reasoning).toContain('Pemetaan dari diagnosis utama');
  });

  test('AI suggested_inacbg tidak valid & kode fallback juga tidak ada di manapun → tariff_result null (bukan angka fiktif)', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
      suggested_inacbg: 'ZZ-9-99-XYZ-HALU',
    });

    // Diagnosis prefix 'Z' (faktor yang memengaruhi status kesehatan) --
    // grouping heuristik akan memetakan ke 'Z-4-21-I', kode yang diverifikasi
    // TIDAK ada di tabel resmi PMK 3/2023 maupun kamus fallback 13-entri.
    const evidencePool = [{ page_number: 1, ocr_text: 'Diagnosa: perawatan paliatif', confidence: 100 }];

    const result = await generateAiReview(
      { sep: 'ABC', DIAGLIST: 'Z515', PROCLIST: '', KELAS_RAWAT: '3', JENIS_KLAIM: 'RAWAT_INAP' },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    expect(result.inacbg_result).not.toBeNull();
    expect(result.inacbg_result.code).toBe('Z-4-21-I');
    expect(result.inacbg_result.source).toBe('GENERATED');
    // Tidak boleh ada tarif fiktif yang ditempelkan
    expect(result.tariff_result).toBeNull();
    expect(result.suggested_tarif).toBeNull();
  });

  // Fix 19 Sep 2026: kode day-care/RJTL (mis. B-2-12-0) di tabel PMK 3/2023
  // hanya punya tarif di kolom kelasD (tidak distratifikasi per kelas kamar).
  // Sebelum fix ini, kode-kode itu selalu tampil "tarif tidak berlaku"
  // walau kodenya valid dan tarifnya ada.
  test('AI suggested_inacbg berupa kode day-care/RJTL (tarif hanya di kelasD) tetap tampilkan tarif resmi, bukan tidak ditemukan', async () => {
    mockFetchOk({
      field_notes: {},
      code_evidence: [],
      suggested_codes: [],
      suggested_inacbg: 'B-2-12-0',
    });

    const evidencePool = [{ page_number: 1, ocr_text: 'Prosedur kolesistektomi tanpa laparoskopi', confidence: 100 }];

    const result = await generateAiReview(
      { sep: 'ABC', DIAGLIST: 'K80.2', PROCLIST: '51.22', JENIS_KLAIM: 'RAWAT_JALAN' },
      [],
      evidencePool
    );

    expect(result).not.toBeNull();
    expect(result.inacbg_result.code).toBe('B-2-12-0');
    expect(result.inacbg_result.source).toBe('PMK_3_2023');
    expect(result.inacbg_result.description).toBeTruthy();
    expect(result.tariff_result).not.toBeNull();
    expect(result.tariff_result.amount).toBeGreaterThan(0);
    expect(result.tariff_result.source).toBe('PMK_3_2023');
    expect(result.suggested_tarif).toBe(result.tariff_result.amount);
  });
});
