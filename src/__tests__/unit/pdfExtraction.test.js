const { validateRecord, determineStatus } = require('../../services/ruleEngine');

// Test helper: create validation rules
function makeRule(id, isActive = true) {
  return { id, rule_code: id, is_active: isActive, rule_type: 'builtin', rule_logic: null, error_message: null };
}

// Note: vclaimToDbFormat is not exported from claimFiles.js since it's a route helper
// This test verifies that the validation logic works correctly with database format records

describe('Validation for PDF Extraction Results', () => {
  const activeRules = [
    makeRule('RV-01'),
    makeRule('RV-02'),
    makeRule('RV-03'),
    makeRule('RV-04'),
    makeRule('RV-05'),
    makeRule('RV-06'),
    makeRule('RV-07'),
    makeRule('RV-08'),
    makeRule('RV-09'),
  ];

  test('validates extracted record with complete data', () => {
    const record = {
      sep: '0170R0110626V000314',
      nokartu: '0000000000001',
      nama_pasien: 'PASIEN TEST',
      birth_date: '1990-05-15',
      admission_date: '2026-03-10',
      discharge_date: '2026-03-15',
      umur_tahun: 36,
      kelas_rawat: 2,
      discharge_status: 1,
      diagnosa_list: 'O42.1;O68.0;O82.1;Z37.0',
      prosedur_list: '74.1;75.32;90.59;88.78'
    };

    const errors = validateRecord(record, activeRules);
    expect(errors.length).toBe(0);
    expect(determineStatus(errors)).toBe('valid');
  });

  test('catches missing critical fields', () => {
    const record = {
      // Missing sep, nokartu, nama_pasien
      birth_date: '1990-05-15',
      admission_date: '2026-03-10',
      discharge_date: '2026-03-15',
    };

    const errors = validateRecord(record, activeRules);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.rule_id === 'RV-01')).toBe(true); // Missing SEP
    expect(errors.some(e => e.rule_id === 'RV-02')).toBe(true); // Missing NOKARTU
    expect(errors.some(e => e.rule_id === 'RV-09')).toBe(true); // Missing NAMA_PASIEN
    expect(determineStatus(errors)).toBe('error');
  });

  test('validates date format (admission <= discharge)', () => {
    const record = {
      sep: '0170R0110626V000314',
      nokartu: '0000000000001',
      nama_pasien: 'PASIEN TEST',
      admission_date: '2026-03-15',
      discharge_date: '2026-03-10' // Earlier than admission!
    };

    const errors = validateRecord(record, activeRules);
    expect(errors.some(e => e.rule_id === 'RV-03')).toBe(true);
  });

  test('validates diagnosis code format', () => {
    const record = {
      sep: '0170R0110626V000314',
      nokartu: '0000000000001',
      nama_pasien: 'PASIEN TEST',
      diagnosa_list: 'INVALID;O42.1' // INVALID code
    };

    const errors = validateRecord(record, activeRules);
    expect(errors.some(e => e.rule_id === 'RV-05')).toBe(true);
  });

  test('validates kelas_rawat', () => {
    const record = {
      sep: '0170R0110626V000314',
      nokartu: '0000000000001',
      nama_pasien: 'PASIEN TEST',
      kelas_rawat: 5 // Invalid! Only 1, 2, 3 allowed
    };

    const errors = validateRecord(record, activeRules);
    expect(errors.some(e => e.rule_id === 'RV-07')).toBe(true);
  });

  test('determines error status for critical/major errors', () => {
    const record = {
      // Missing critical fields
      nama_pasien: 'PASIEN TEST'
    };

    const errors = validateRecord(record, activeRules);
    const status = determineStatus(errors);
    expect(['error', 'pending']).toContain(status);
  });
});
