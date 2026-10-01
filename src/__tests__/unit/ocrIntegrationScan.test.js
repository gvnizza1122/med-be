jest.mock('../../services/ocrEnhancement', () => ({
  enhancedOcrExtraction: jest.fn(),
}));

const { enhancedOcrExtraction } = require('../../services/ocrEnhancement');
const { applyOcrEnhancements } = require('../../services/ocrIntegration');
const { isClaimDataPage } = require('../../services/pdfPageClassifier');

const halamanResume = 'RESUME MEDIS IGD\nNo RM : 081030\nDiagnosa\nR06.0 - Dyspnoea\nTindakan\nNebulizer Ventasal';
const halamanSep = 'SURAT ELEGIBILITAS PESERTA\nNo. SEP : 0170R0110826V000083\nNo. Kartu : 0001234567890';

function hasilOcr(pages) {
  return {
    success: true,
    pass1_general_ocr: { success: true, pages },
    pass2_clinical_extraction: {
      vital_signs: {}, clinical_findings: {}, structured_text: {},
      diagnosis_list: [], prosedur_list: [], clinical_findings_notation: {},
      primary_survey: {}, pengkajian_keperawatan: {}, assessment: {},
    },
    vital_signs_validated: { validated_values: {} },
  };
}

// Salinan scan berkas 0170R0110826V000083: tanpa teks asli, dulu claimDataText
// tetap kosong setelah OCR dan upload ditolak "Berkas Klaim Individual tidak
// ditemukan".
describe('applyOcrEnhancements untuk PDF hasil scan', () => {
  test('teks OCR per halaman menjadi claimDataText dan dikenali sebagai data klaim', async () => {
    enhancedOcrExtraction.mockResolvedValue(hasilOcr([
      { page_number: 1, text: halamanSep },
      { page_number: 2, text: halamanResume },
      { page_number: 3, text: '   ' },
    ]));
    const hasil = await applyOcrEnhancements({ claimDataText: '', claimDataPages: [] }, '/tmp/scan.pdf');
    expect(hasil.claimDataText).toContain('No. SEP : 0170R0110826V000083');
    expect(hasil.claimDataText).toContain('R06.0 - Dyspnoea');
    expect(hasil.claimDataPages.map(p => p.page_num)).toEqual([1, 2]);
    expect(isClaimDataPage(hasil.claimDataText)).toBe(true);
  });

  test('PDF yang sudah punya teks asli tidak ditimpa teks OCR', async () => {
    enhancedOcrExtraction.mockResolvedValue(hasilOcr([{ page_number: 1, text: halamanResume }]));
    const asli = `${halamanSep}\n(teks asli PDF)`;
    const hasil = await applyOcrEnhancements({ claimDataText: asli, claimDataPages: [{ page_num: 1 }] }, '/tmp/asli.pdf');
    expect(hasil.claimDataText.startsWith(asli)).toBe(true);
    expect(hasil.claimDataPages).toEqual([{ page_num: 1 }]);
  });
});
