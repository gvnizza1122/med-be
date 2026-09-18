const { resolveFieldFormStatus } = require('../../services/documentFieldTemplate');

describe('resolveFieldFormStatus — tri-state field model (fix item 4)', () => {
  test('hasValue true -> selalu recorded, tanpa perlu cek teks halaman', () => {
    expect(resolveFieldFormStatus('SpO2', 'triase_igd', [], true)).toBe('recorded');
  });

  test('label SpO2 TIDAK ada di teks halaman Triase IGD -> not_in_form (fix bug false positive)', () => {
    const pages = [{ page_number: 1, ocr_text: 'VITAL SIGN\nTD 120/80 mmHg\nHeart Rate 88 x/mnt\nRR 20 x/mnt\nTemp 36,8 C' }];
    expect(resolveFieldFormStatus('SpO2', 'triase_igd', pages, false)).toBe('not_in_form');
  });

  test('label SpO2 ADA di teks halaman tapi nilainya tidak terekstrak -> empty_on_form', () => {
    const pages = [{ page_number: 1, ocr_text: 'VITAL SIGN\nTD 120/80 mmHg\nSpO2: -\nRR 20 x/mnt' }];
    expect(resolveFieldFormStatus('SpO2', 'triase_igd', pages, false)).toBe('empty_on_form');
  });

  test('variasi label "Saturasi O2" juga dikenali sebagai kolom yang ada di form', () => {
    const pages = [{ page_number: 1, ocr_text: 'Saturasi O2: -' }];
    expect(resolveFieldFormStatus('SpO2', 'triase_igd', pages, false)).toBe('empty_on_form');
  });

  test('field tanpa template (belum didaftarkan di document_field_templates.json) fallback empty_on_form', () => {
    const pages = [{ page_number: 1, ocr_text: 'apapun' }];
    expect(resolveFieldFormStatus('FieldBelumDidaftarkan', 'triase_igd', pages, false)).toBe('empty_on_form');
  });

  test('tipe dokumen tidak dikenal fallback empty_on_form (bukan false positive not_in_form)', () => {
    const pages = [{ page_number: 1, ocr_text: 'apapun' }];
    expect(resolveFieldFormStatus('SpO2', 'tipe_dokumen_tidak_ada', pages, false)).toBe('empty_on_form');
  });

  test('tidak ada halaman sama sekali fallback empty_on_form', () => {
    expect(resolveFieldFormStatus('SpO2', 'triase_igd', [], false)).toBe('empty_on_form');
  });
});
