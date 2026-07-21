const { validateWithRuleLogic, evaluateCheck } = require('../../services/genericRuleValidator');

describe('evaluateCheck', () => {
  describe('uppercase operator', () => {
    test('detects lowercase SEP', () => {
      const errors = evaluateCheck({ sep: 'abc123' }, { field: 'sep', operator: 'uppercase', severity: 'critical' });
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('critical');
      expect(errors[0].field).toBe('sep');
    });

    test('passes uppercase SEP', () => {
      const errors = evaluateCheck({ sep: 'ABC123' }, { field: 'sep', operator: 'uppercase' });
      expect(errors).toHaveLength(0);
    });

    test('handles empty value', () => {
      const errors = evaluateCheck({ sep: '' }, { field: 'sep', operator: 'uppercase' });
      expect(errors).toHaveLength(0);
    });
  });

  describe('required operator', () => {
    test('detects missing field', () => {
      const errors = evaluateCheck({}, { field: 'nama_pasien', operator: 'required', severity: 'critical' });
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('critical');
    });

    test('detects empty string field', () => {
      const errors = evaluateCheck({ sep: '' }, { field: 'sep', operator: 'required' });
      expect(errors).toHaveLength(1);
    });

    test('detects dash placeholder', () => {
      const errors = evaluateCheck({ diagnosa_list: '-' }, { field: 'diagnosa_list', operator: 'required' });
      expect(errors).toHaveLength(1);
    });

    test('passes when field has value', () => {
      const errors = evaluateCheck({ nama_pasien: 'BUDI' }, { field: 'nama_pasien', operator: 'required' });
      expect(errors).toHaveLength(0);
    });
  });

  describe('regex operator', () => {
    test('validates SEP format', () => {
      const errors = evaluateCheck(
        { sep: '0101R0010724' },
        { field: 'sep', operator: 'regex', value: '^\\d{4}R\\d{7}$', severity: 'critical' }
      );
      expect(errors).toHaveLength(0);
    });

    test('detects invalid SEP format', () => {
      const errors = evaluateCheck(
        { sep: 'INVALID' },
        { field: 'sep', operator: 'regex', value: '^\\d{4}R\\d{7}$', severity: 'critical' }
      );
      expect(errors).toHaveLength(1);
    });

    test('handles empty value (no error)', () => {
      const errors = evaluateCheck(
        { sep: '' },
        { field: 'sep', operator: 'regex', value: '^\\d{13}$' }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('in_list operator', () => {
    test('validates kelas_rawat is in allowed list', () => {
      const errors = evaluateCheck(
        { kelas_rawat: 3 },
        { field: 'kelas_rawat', operator: 'in_list', value: [1, 2, 3] }
      );
      expect(errors).toHaveLength(0);
    });

    test('detects invalid kelas_rawat', () => {
      const errors = evaluateCheck(
        { kelas_rawat: 5 },
        { field: 'kelas_rawat', operator: 'in_list', value: [1, 2, 3] }
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].actual).toBe('5');
    });
  });

  describe('icd10 operator', () => {
    test('validates correct ICD-10 codes', () => {
      const errors = evaluateCheck(
        { diagnosa_list: 'E11.9;I10' },
        { field: 'diagnosa_list', operator: 'icd10' }
      );
      expect(errors).toHaveLength(0);
    });

    test('detects invalid ICD-10 code', () => {
      const errors = evaluateCheck(
        { diagnosa_list: 'XYZ99;I10' },
        { field: 'diagnosa_list', operator: 'icd10' }
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('ICD-10');
    });

    test('handles dash as empty', () => {
      const errors = evaluateCheck(
        { diagnosa_list: '-' },
        { field: 'diagnosa_list', operator: 'icd10' }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('icd9 operator', () => {
    test('validates correct ICD-9-CM codes', () => {
      const errors = evaluateCheck(
        { prosedur_list: '88.72;93.01' },
        { field: 'prosedur_list', operator: 'icd9' }
      );
      expect(errors).toHaveLength(0);
    });

    test('detects invalid ICD-9-CM code', () => {
      const errors = evaluateCheck(
        { prosedur_list: 'XX.XX' },
        { field: 'prosedur_list', operator: 'icd9' }
      );
      expect(errors).toHaveLength(1);
    });
  });

  describe('date_order operator', () => {
    test('detects admission after discharge', () => {
      const errors = evaluateCheck(
        { admission_date: '2024-01-10', discharge_date: '2024-01-05' },
        { field: 'admission_date', operator: 'date_order', severity: 'critical' }
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('critical');
    });

    test('passes when admission before discharge', () => {
      const errors = evaluateCheck(
        { admission_date: '2024-01-01', discharge_date: '2024-01-05' },
        { field: 'admission_date', operator: 'date_order' }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('age_crosscheck operator', () => {
    test('detects age mismatch', () => {
      const errors = evaluateCheck(
        { birth_date: '1990-01-01', admission_date: '2024-01-01', umur_tahun: 50 },
        { field: 'umur_tahun', operator: 'age_crosscheck', severity: 'major', value: { tolerance: 1 } }
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].actual).toBe('50 tahun');
    });

    test('passes when age matches (within tolerance)', () => {
      const errors = evaluateCheck(
        { birth_date: '1990-01-01', admission_date: '2024-01-01', umur_tahun: 34 },
        { field: 'umur_tahun', operator: 'age_crosscheck', value: { tolerance: 1 } }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('tarif_discrepancy operator', () => {
    test('detects large discrepancy', () => {
      const errors = evaluateCheck(
        { tarif_rs: 10000000, total_tarif: 5000000 },
        { field: 'tarif_rs', operator: 'tarif_discrepancy', value: { max_pct: 50 } }
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].severity).toBe('minor');
    });

    test('passes when discrepancy is small', () => {
      const errors = evaluateCheck(
        { tarif_rs: 5500000, total_tarif: 5000000 },
        { field: 'tarif_rs', operator: 'tarif_discrepancy', value: { max_pct: 50 } }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('numeric_gte operator', () => {
    test('detects value below minimum', () => {
      const errors = evaluateCheck(
        { los: 0 },
        { field: 'los', operator: 'numeric_gte', value: 1 }
      );
      expect(errors).toHaveLength(1);
    });

    test('passes when value meets minimum', () => {
      const errors = evaluateCheck(
        { los: 5 },
        { field: 'los', operator: 'numeric_gte', value: 1 }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('numeric_lte operator', () => {
    test('detects value above maximum', () => {
      const errors = evaluateCheck(
        { umur_tahun: 150 },
        { field: 'umur_tahun', operator: 'numeric_lte', value: 120 }
      );
      expect(errors).toHaveLength(1);
    });

    test('passes when value is within limit', () => {
      const errors = evaluateCheck(
        { umur_tahun: 45 },
        { field: 'umur_tahun', operator: 'numeric_lte', value: 120 }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('not_empty operator', () => {
    test('detects empty field', () => {
      const errors = evaluateCheck(
        { nama_pasien: '' },
        { field: 'nama_pasien', operator: 'not_empty' }
      );
      expect(errors).toHaveLength(1);
    });

    test('detects dash placeholder', () => {
      const errors = evaluateCheck(
        { diagnosa_list: '-' },
        { field: 'diagnosa_list', operator: 'not_empty' }
      );
      expect(errors).toHaveLength(1);
    });

    test('passes with valid value', () => {
      const errors = evaluateCheck(
        { nama_pasien: 'BUDI SANTOSO' },
        { field: 'nama_pasien', operator: 'not_empty' }
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe('min_length / max_length operators', () => {
    test('detects SEP shorter than min', () => {
      const errors = evaluateCheck(
        { sep: 'AB12' },
        { field: 'sep', operator: 'min_length', value: 13 }
      );
      expect(errors).toHaveLength(1);
    });

    test('detects nama_pasien longer than max', () => {
      const errors = evaluateCheck(
        { nama_pasien: 'A'.repeat(101) },
        { field: 'nama_pasien', operator: 'max_length', value: 100 }
      );
      expect(errors).toHaveLength(1);
    });
  });
});

describe('validateWithRuleLogic', () => {
  test('AND logic: all checks must pass', () => {
    const rule = {
      id: 'RV-CUSTOM',
      rule_code: 'RV-CUSTOM',
      rule_logic: JSON.stringify({
        type: 'and',
        checks: [
          { field: 'sep', operator: 'required' },
          { field: 'nama_pasien', operator: 'required' }
        ]
      })
    };

    const errors = validateWithRuleLogic({ sep: '', nama_pasien: '' }, rule);
    expect(errors).toHaveLength(2);
  });

  test('AND logic: no errors when all pass', () => {
    const rule = {
      id: 'RV-CUSTOM',
      rule_code: 'RV-CUSTOM',
      rule_logic: JSON.stringify({
        type: 'and',
        checks: [
          { field: 'sep', operator: 'required' },
          { field: 'nama_pasien', operator: 'required' }
        ]
      })
    };

    const errors = validateWithRuleLogic({ sep: 'SEP001', nama_pasien: 'BUDI' }, rule);
    expect(errors).toHaveLength(0);
  });

  test('OR logic: no errors if any check passes', () => {
    const rule = {
      id: 'RV-OR-TEST',
      rule_code: 'RV-OR-TEST',
      rule_logic: JSON.stringify({
        type: 'or',
        checks: [
          { field: 'field_a', operator: 'required' },
          { field: 'field_b', operator: 'required' }
        ]
      })
    };

    const errors = validateWithRuleLogic({ field_a: '', field_b: 'VALUE' }, rule);
    expect(errors).toHaveLength(0);
  });

  test('returns rule_id and field_name in errors', () => {
    const rule = {
      id: 'RV-FMT-01',
      rule_code: 'RV-FMT-01',
      rule_logic: JSON.stringify({
        checks: [
          { field: 'sep', operator: 'required', severity: 'critical' }
        ]
      })
    };

    const errors = validateWithRuleLogic({ sep: '' }, rule);
    expect(errors[0].rule_id).toBe('RV-FMT-01');
    expect(errors[0].field_name).toBe('sep');
  });

  test('handles invalid rule_logic JSON gracefully', () => {
    const rule = {
      id: 'RV-BAD',
      rule_code: 'RV-BAD',
      rule_logic: '{invalid json}'
    };

    const errors = validateWithRuleLogic({ sep: '' }, rule);
    expect(errors).toHaveLength(0);
  });

  test('handles empty rule_logic', () => {
    const errors = validateWithRuleLogic({}, { id: 'RV-TEST', rule_code: 'RV-TEST', rule_logic: null });
    expect(errors).toHaveLength(0);
  });
});
