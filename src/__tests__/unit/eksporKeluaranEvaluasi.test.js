const { bentukKeluaran, bacaArgumen } = require('../../../scripts/eksporKeluaranEvaluasi');

describe('eksporKeluaranEvaluasi', () => {
  test('membentuk keluaran evaluasi dari record pipeline dan OCR tanpa membuat kunci', () => {
    const hasil = bentukKeluaran({
      id: 'record-1', diagnosa_list: 'R10.4;E86', prosedur_list: '90.59',
      ai_review: JSON.stringify({
        suggested_codes: [{ type: 'diagnosis', code: 'R10.4', page_number: 2, quotation: 'Diagnosa kolik abdomen' }],
        temuan_lab: { baris: [{ parameter: 'hemoglobin', parameter_baku: 'Hemoglobin', nilai: 10.2, satuan: 'g/dL', tanggal: '2026-03-10', halaman: 4, kutipan: 'Hb 10,2 g/dL' }] },
      }),
    }, [{ page_number: 2, ocr_text: 'Diagnosa kolik abdomen' }]);

    expect(hasil.klaim_id).toBe('record-1');
    expect(hasil.diagnosis).toContain('E86');
    expect(hasil.diagnosis.find(x => typeof x === 'object').kutipan).toBe('Diagnosa kolik abdomen');
    expect(hasil.prosedur).toEqual(['90.59']);
    expect(hasil.nilai_lab[0]).toMatchObject({ parameter: 'Hemoglobin', nilai: 10.2, satuan: 'g/dL' });
    expect(hasil.halaman[0].ocr_text).toBe('Diagnosa kolik abdomen');
    expect(hasil).not.toHaveProperty('kunci');
  });

  test('menerima cakupan satu klaim atau satu berkas dan nama keluaran', () => {
    expect(bacaArgumen(['node', 'script', '--record-id', 'r1', '--out', 'hasil.json']))
      .toEqual({ recordId: 'r1', out: 'hasil.json' });
  });
});
