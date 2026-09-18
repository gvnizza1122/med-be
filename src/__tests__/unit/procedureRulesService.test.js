const { checkProcedureCodability, matchTindakanSegera, freetextPromotesToYa, getEsiSignalThreshold } = require('../../services/procedureRulesService');
const { TRIASE_IGD_TEXT } = require('../../testFixtures/hyperemesisRedacted');

describe('checkProcedureCodability — fix item 8 (lab rutin perlu review)', () => {
  test('90.59 (microscopic examination of blood -- lab rutin) ditandai perlu review', () => {
    const result = checkProcedureCodability('90.59');
    expect(result.review).toBe(true);
    expect(result.reason).toMatch(/laboratorium|lab rutin/i);
  });

  test('88.78 (bukan kode lab rutin) TETAP valid, tidak difilter', () => {
    const result = checkProcedureCodability('88.78');
    expect(result.review).toBe(false);
    expect(result.reason).toBeNull();
  });

  test('kode kosong/invalid tidak melempar error', () => {
    expect(checkProcedureCodability(null)).toEqual({ review: false, reason: null });
    expect(checkProcedureCodability('')).toEqual({ review: false, reason: null });
  });
});

describe('matchTindakanSegera — fix item 5 (tindakan segera dari teks bebas)', () => {
  test('menemukan pola resusitasi cairan IV dari IVFD loading di Triase IGD', () => {
    const pages = [{ page_number: 3, ocr_text: TRIASE_IGD_TEXT }];
    const matches = matchTindakanSegera(pages);
    const cairan = matches.find(m => m.id === 'resusitasi_cairan_iv');
    expect(cairan).toBeDefined();
    expect(cairan.page_number).toBe(3);
    expect(cairan.kutipan).toContain('IVFD asering loading 250cc lanjut 20tpm');
  });

  test('injeksi obat rutin (omeprazole/ondansetron) TIDAK ikut ter-match sebagai tindakan segera -- hanya 1 pola cocok (resusitasi cairan)', () => {
    const pages = [{ page_number: 3, ocr_text: TRIASE_IGD_TEXT }];
    const matches = matchTindakanSegera(pages);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('resusitasi_cairan_iv');
  });

  test('halaman tanpa tindakan segera apapun -> array kosong', () => {
    const pages = [{ page_number: 1, ocr_text: 'Tidak ada tindakan apapun di sini.' }];
    expect(matchTindakanSegera(pages)).toEqual([]);
  });
});

describe('config default rules (procedure_rules.json)', () => {
  test('freetextPromotesToYa default false (K5 dari teks bebas = borderline, bukan langsung ya)', () => {
    expect(freetextPromotesToYa()).toBe(false);
  });

  test('esi_signal_threshold punya default numerik', () => {
    expect(typeof getEsiSignalThreshold()).toBe('number');
  });
});
