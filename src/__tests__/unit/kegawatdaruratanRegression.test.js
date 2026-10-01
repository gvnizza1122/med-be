/**
 * Test regresi end-to-end untuk kasus hyperemesis gravidarum rawat inap (fix
 * item 4, 5, 6 -- 18-19 Sep 2026) memakai fixture REDAKSI di
 * src/__tests__/fixtures/hyperemesisRedacted.js. Memanggil assessKegawatdaruratan
 * langsung (diekspor khusus untuk test) dengan fetch di-mock supaya tidak
 * bergantung pada API AI sungguhan -- respons mock DIRANCANG supaya SEMUA
 * kutipannya PERSIS ada di teks fixture (lolos validateQuotation), meniru
 * ekstraksi yang benar dari model.
 */
const { assessKegawatdaruratan } = require('../../services/aiReviewService');
const {
  evidencePool, triagePageNumbers, resumeMedisPageNumbers, procedureCodes, umurTahun,
} = require('../../testFixtures/hyperemesisRedacted');

// Respons AI yang DISIMULASIKAN -- setiap "kutipan"/"quotation" di bawah WAJIB
// bisa ditemukan verbatim (case/whitespace-insensitive) di teks fixture,
// supaya lolos validateQuotation server-side (anti-halusinasi) sama seperti
// respons model sungguhan.
const mockKegawatdaruratanResponse = {
  parameter_findings: [
    { key: 'akral', ditemukan: true, status: 'normal', nilai: 'hangat', page_number: 3, kutipan: 'Akral hangat, CRT <2 detik' },
    { key: 'kesadaran_kualitatif', ditemukan: true, status: 'normal', nilai: 'Compos Mentis', page_number: 3, kutipan: 'Hasil: Compos Mentis' },
    { key: 'abdomen', ditemukan: true, status: 'normal', nilai: 'Supel, BU (+) normal', page_number: 3, kutipan: 'Abdomen : Supel, BU (+) normal' },
    { key: 'leher', ditemukan: true, status: 'normal', nilai: 'tidak ada pembesaran', page_number: 3, kutipan: 'Leher : Tidak ada pembesaran KGB/tiroid, kaku kuduk (-)' },
    { key: 'thorak', ditemukan: true, status: 'normal', nilai: 'simetris', page_number: 3, kutipan: 'Thorak : Simetris, tidak ada retraksi' },
    { key: 'ekstremitas', ditemukan: true, status: 'normal', nilai: 'tidak ada kelainan', page_number: 3, kutipan: 'Ekstremitas : Tidak ada kelainan bentuk/gerak, akral hangat' },
    // kepala TIDAK dicatat di Triase IGD sama sekali -- diambil dari Resume
    // Medis sbg konteks tambahan (Opsi A), sesuai fix item 6.
    { key: 'kepala', ditemukan: true, status: 'abnormal', nilai: 'mukosa kering', page_number: 4, kutipan: 'mukosa kering+, abd supel bu+' },
  ],
  vital_findings: {
    RR: { nilai: 20, page_number: 3, kutipan: 'RR 20 x/mnt' },
    // SpO2 SENGAJA tidak diisi model (nilai:null) -- form Triase IGD RS ini
    // memang tidak punya kolom SpO2 sama sekali (fix item 4).
    SpO2: { nilai: null, page_number: null, kutipan: null },
    HR: { nilai: 96, page_number: 3, kutipan: 'Heart Rate 96 x/mnt' },
    TD_sistolik: { nilai: 100, page_number: 3, kutipan: 'TD 100/70 mmHg' },
    TD_diastolik: { nilai: 70, page_number: 3, kutipan: 'TD 100/70 mmHg' },
    Suhu: { nilai: 36.8, page_number: 3, kutipan: 'Temp 36,8 C' },
    GCS: { nilai: 15, page_number: 3, kutipan: 'Buka mata (E): 4, Respon Verbal (V): 5, Respon Motorik (M): 6' },
    Nyeri: { nilai: 3, page_number: 3, kutipan: 'Skala Nyeri: NRS 3/10' },
  },
  k1: { status: 'tidak', page_number: null, kutipan: null, catatan: 'Tidak ada indikasi membahayakan diri/orang lain.' },
  tindakan_keperawatan: [
    { quotation: 'IVFD asering loading 250cc lanjut 20tpm', page_number: 3 },
    { quotation: 'Inj omeprazole 40mg IV', page_number: 3 },
  ],
  esi: { skor: 2, page_number: 3, kutipan: 'ESI: 2' },
};

function mockFetchOk(body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { total_tokens: 500 },
    })),
  });
}

describe('assessKegawatdaruratan — kasus regresi hyperemesis gravidarum (fixture redaksi)', () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_API_KEY = 'test-key';
    mockFetchOk(mockKegawatdaruratanResponse);
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER_API_KEY;
    jest.restoreAllMocks();
  });

  // 16 -> 20: konjungtiva anemis, nyeri tekan epigastrium, bising usus, dan
  // perkusi timpani ditambahkan ke PARAMETER_TABLE (kegawatdaruratanReference.js).
  test('parameter_findings sekarang 20 entri (bukan 11)', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    expect(result.parameter_findings).toHaveLength(20);
  });

  test('fix item 6: parameter fisik yang benar-benar tercatat naik dari 1 (hanya kesadaran) jadi 7', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    const documented = result.parameter_findings.filter(p => p.ditemukan === true);
    expect(documented.length).toBe(7);
  });

  test('fix item 6: "mukosa kering" (kepala) tercatat bersumber Resume Medis, BUKAN Triase IGD', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    const kepala = result.parameter_findings.find(p => p.key === 'kepala');
    expect(kepala.ditemukan).toBe(true);
    expect(kepala.status).toBe('abnormal');
    expect(kepala.sumber_dokumen).toBe('resume_medis');
    expect(kepala.kutipan).toContain('mukosa kering');
  });

  test('fix item 4: SpO2 berstatus not_in_form (form Triase IGD tidak punya kolom SpO2) -- BUKAN empty_on_form', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    expect(result.vital_findings.SpO2.nilai).toBeNull();
    expect(result.vital_findings.SpO2.form_status).toBe('not_in_form');
  });

  test('fix item 4: field vital yang ADA nilainya tetap form_status recorded', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    expect(result.vital_findings.RR.form_status).toBe('recorded');
  });

  test('fix item 5: K5 = BORDERLINE dengan evidence IVFD asering loading dari Triase IGD, ESI tampil sebagai sinyal', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    const k5 = result.kriteria.find(k => k.kriteria === 'K5');
    expect(k5.status).toBe('borderline');
    const tindakanEvidence = k5.evidence.find(e => e.sumber === 'tindakan_segera');
    expect(tindakanEvidence).toBeDefined();
    expect(tindakanEvidence.kutipan).toContain('IVFD asering loading 250cc lanjut 20tpm');
    const esiEvidence = k5.evidence.find(e => e.sumber === 'esi');
    expect(esiEvidence).toBeDefined();
    expect(esiEvidence.skor).toBe(2);
    expect(result.esi.skor).toBe(2);
  });

  test('fix item 5: PROCLIST 88.78;90.59 (kode e-Klaim, bukan whitelist K5) tidak sendirian memicu YA', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    const k5 = result.kriteria.find(k => k.kriteria === 'K5');
    expect(k5.evidence.some(e => e.sumber === 'proclist')).toBe(false);
    expect(k5.status).not.toBe('ya');
  });

  test('tindakan_keperawatan (ekstraksi mentah, quote-validated) ikut dikembalikan', async () => {
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    expect(result.tindakan_keperawatan.length).toBeGreaterThanOrEqual(1);
    expect(result.tindakan_keperawatan.some(t => t.quotation.includes('IVFD asering loading 250cc lanjut 20tpm'))).toBe(true);
  });

  test('kutipan palsu (tidak ada di halaman terkait) ditolak -- field jatuh ke ditemukan:false, TIDAK ikut tercatat', async () => {
    const tampered = JSON.parse(JSON.stringify(mockKegawatdaruratanResponse));
    tampered.parameter_findings.push({
      key: 'sianosis', ditemukan: true, status: 'abnormal', nilai: 'ada',
      page_number: 3, kutipan: 'kutipan palsu yang tidak pernah ada di dokumen manapun',
    });
    mockFetchOk(tampered);
    const result = await assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, null, procedureCodes, resumeMedisPageNumbers);
    const sianosis = result.parameter_findings.find(p => p.key === 'sianosis');
    expect(sianosis.ditemukan).toBe(false);
  });
});
