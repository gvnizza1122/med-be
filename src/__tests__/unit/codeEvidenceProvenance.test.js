/**
 * Test regresi generateAiReview end-to-end untuk fix item 7 (provenance dari
 * metadata halaman), item 8 (procedure_rules -- lab rutin perlu review), dan
 * item 9 (diagnosis_consistency -- O21.x). Memakai fixture REDAKSI yang sama
 * dengan kegawatdaruratanRegression.test.js. fetch di-mock dengan respons
 * BERBEDA tergantung system prompt (3 panggilan AI terpisah dijalankan oleh
 * generateAiReview: audit utama, pending-risk, kegawatdaruratan).
 */
const { generateAiReview } = require('../../services/aiReviewService');
const { evidencePool } = require('../../testFixtures/hyperemesisRedacted');

const mainAuditBody = {
  field_notes: {},
  code_evidence: [
    // 88.78 -- evidence-nya SEBENARNYA dari Rincian Biaya (hal. 6), BUKAN
    // Resume Medis -- kasus regresi persis item 7 (provenance sebelumnya
    // selalu di-hardcode "Dari Resume Medis" di frontend).
    { code: '88.78', type: 'procedure', found: true, page_number: 6, quotation: 'USG Obgyn' },
    // 90.59 -- evidence valid (ada di Lab), tapi codability-nya lab rutin --
    // fix item 8: WAJIB perlu_review, BUKAN otomatis valid.
    { code: '90.59', type: 'procedure', found: true, page_number: 5, quotation: 'DARAH RUTIN' },
    // O21.0 -- fix item 9: diagnosis consistency (indikator severity dari
    // SPRI/Resume Medis/Lab) WAJIB menandai perlu_review + alternatif O21.1.
    { code: 'O21.0', type: 'diagnosis', found: true, page_number: 1, quotation: 'Diagnosa: O21.0' },
    // Z99.9 -- kode fiktif dengan KUTIPAN PALSU (tidak pernah ada di dokumen
    // manapun) -- acceptance test unit "kutipan palsu -> Evidence tidak
    // terverifikasi" (item 7).
    { code: 'Z99.9', type: 'diagnosis', found: true, page_number: 1, quotation: 'kutipan palsu yang tidak pernah ada di dokumen manapun' },
  ],
  suggested_codes: [],
  knowledge_updates: [],
  suggested_inacbg: '',
};
const minimalKegawatdaruratanBody = { parameter_findings: [], vital_findings: {}, k1: { status: 'tidak' }, tindakan_keperawatan: [], esi: { skor: null } };
const minimalPendingRiskBody = { pending_risk_notes: [] };

function textResponse(body) {
  return {
    ok: true,
    text: () => Promise.resolve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { total_tokens: 10 },
    })),
  };
}

describe('generateAiReview — provenance & review_status (fix item 7, 8, 9)', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_API_KEY = 'test-key';
    global.fetch = jest.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const sys = body.messages[0].content;
      if (sys.includes('Permenkes RI No. 47 Tahun 2018')) return textResponse(minimalKegawatdaruratanBody);
      if (sys.includes('suggested_inacbg')) return textResponse(mainAuditBody);
      return textResponse(minimalPendingRiskBody);
    });
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER_API_KEY;
    jest.restoreAllMocks();
  });

  test('fix item 7: 88.78 diberi document_type rincian_biaya (BUKAN hardcode resume_medis)', async () => {
    const record = { DIAGLIST: 'O21.0', PROCLIST: '88.78;90.59', JENIS_KLAIM: 'RAWAT_INAP', UMUR_TAHUN: 28 };
    const result = await generateAiReview(record, [], evidencePool);
    const ev = result.code_evidence.find(e => e.code === '88.78');
    expect(ev.document_type).toBe('rincian_biaya');
    expect(ev.review_status).toBe('VALID');
  });

  test('fix item 8: 90.59 (lab rutin) review_status perlu_review, 88.78 tetap valid', async () => {
    const record = { DIAGLIST: 'O21.0', PROCLIST: '88.78;90.59', JENIS_KLAIM: 'RAWAT_INAP', UMUR_TAHUN: 28 };
    const result = await generateAiReview(record, [], evidencePool);
    const proc90 = result.code_evidence.find(e => e.code === '90.59');
    expect(proc90.document_type).toBe('lab_results');
    expect(proc90.review_status).toBe('PENDING');
    expect(proc90.review_flags[0].reason).toMatch(/laboratorium|lab rutin/i);

    const proc88 = result.code_evidence.find(e => e.code === '88.78');
    expect(proc88.review_status).toBe('VALID');
  });

  test('fix item 9: O21.0 review_status perlu_review, diagnosis_consistency_flags berisi alternatif O21.1 + aksi klarifikasi DPJP', async () => {
    const record = { DIAGLIST: 'O21.0', PROCLIST: '88.78;90.59', JENIS_KLAIM: 'RAWAT_INAP', UMUR_TAHUN: 28 };
    const result = await generateAiReview(record, [], evidencePool);
    const diag = result.code_evidence.find(e => e.code === 'O21.0' && e.type === 'diagnosis');
    expect(diag.review_status).toBe('PENDING');

    expect(result.diagnosis_consistency_flags).toHaveLength(1);
    const flag = result.diagnosis_consistency_flags[0];
    expect(flag.code).toBe('O21.0');
    expect(flag.alternative_code).toBe('O21.1');
    expect(flag.action).toBe('Klarifikasi DPJP');
    expect(flag.indicators_found.length).toBeGreaterThanOrEqual(2);

    // Kode TIDAK diubah otomatis -- record.DIAGLIST tetap seperti semula.
    expect(record.DIAGLIST).toBe('O21.0');
  });

  test('fix item 7 (unit test kutipan palsu): kode dengan kutipan yang TIDAK ada di halaman terkait -> evidence_tidak_terverifikasi', async () => {
    // Z99.9 SENGAJA ditambah ke DIAGLIST (kode fiktif, TIDAK muncul literal di
    // teks manapun di fixture) supaya "Pengaman" (fallback coverage utk semua
    // kode yang diklaim record) ikut menjaminnya MASUK ke code_evidence walau
    // baik kutipan AI (palsu) MAUPUN fallback regex deterministik sama-sama
    // gagal menemukannya -- itulah yang membuktikan hasilnya found:false,
    // bukan sekadar hilang dari array.
    const record = { DIAGLIST: 'O21.0;Z99.9', PROCLIST: '88.78;90.59', JENIS_KLAIM: 'RAWAT_INAP', UMUR_TAHUN: 28 };
    const result = await generateAiReview(record, [], evidencePool);
    const fake = result.code_evidence.find(e => e.code === 'Z99.9');
    expect(fake).toBeDefined();
    expect(fake.found).toBe(false);
    expect(fake.review_status).toBe('PENDING');
  });
});
