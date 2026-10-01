const { evaluateDiagnosisConsistency } = require('../../services/diagnosisConsistencyService');
const { evidencePool, diagnosisCodes } = require('../../testFixtures/hyperemesisRedacted');

describe('evaluateDiagnosisConsistency — fix item 9 (O21.x family)', () => {
  test('O21.0 ditandai perlu_review dengan alternatif O21.1 + evidence dari SPRI/Resume Medis/Lab', () => {
    const flags = evaluateDiagnosisConsistency(diagnosisCodes, evidencePool);
    expect(flags).toHaveLength(1);
    const flag = flags[0];
    expect(flag.code).toBe('O21.0');
    expect(flag.status).toBe('PENDING');
    expect(flag.alternative_code).toBe('O21.1');
    expect(flag.action).toBe('Klarifikasi DPJP');

    // Evidence harus datang dari >=2 indikator, sumber dokumen BERBEDA (bukan cuma 1 dokumen).
    expect(flag.indicators_found.length).toBeGreaterThanOrEqual(2);
    const sources = new Set(flag.indicators_found.map(i => i.document_type));
    expect(sources.has('spri')).toBe(true);
    expect(sources.has('resume_medis')).toBe(true);
    expect(sources.has('lab_results')).toBe(true);

    // Indikator yang TIDAK didokumentasikan (keton urin) WAJIB disebut, bukan diam-diam dihilangkan.
    expect(flag.indicators_undocumented.some(u => u.id === 'keton_urin')).toBe(true);

    // Kode TIDAK diubah otomatis -- flag ini hanya properti tambahan, bukan mutasi diagnosisCodes.
    expect(diagnosisCodes).toEqual(['O21.0']);
  });

  test('O21.1 (varian sudah lebih berat) TIDAK dievaluasi lagi -- tidak ada arah "turun" di rules ini', () => {
    const flags = evaluateDiagnosisConsistency(['O21.1'], evidencePool);
    expect(flags).toHaveLength(0);
  });

  test('kode di luar keluarga yang dikonfigurasi (tanpa rules) tidak menghasilkan flag', () => {
    const flags = evaluateDiagnosisConsistency(['J45.9'], evidencePool);
    expect(flags).toHaveLength(0);
  });

  test('O21.0 TANPA indikator pendukung sama sekali (dokumen minim) tidak menghasilkan flag', () => {
    const minimalPool = [{ page_number: 1, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis: Hyperemesis Gravidarum' }];
    const flags = evaluateDiagnosisConsistency(['O21.0'], minimalPool);
    expect(flags).toHaveLength(0);
  });
});
