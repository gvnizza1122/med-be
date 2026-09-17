const { validateRecord, determineStatus } = require('../../services/ruleEngine');

function makeRule(id, isActive = true) {
  return { id, rule_code: id, is_active: isActive, rule_type: 'builtin', rule_logic: null, error_message: null };
}

const activeRules = [
  makeRule('RV-11'),
  makeRule('RV-12'),
  makeRule('RV-13'),
  makeRule('RV-14'),
  makeRule('RV-15'),
  makeRule('RV-16'),
  makeRule('RV-17'),
];

describe('validateRecord', () => {
  describe('RV-11: Rehabilitasi Medik', () => {
    test('triggers for prosedur starting with 93', () => {
      const record = {
        prosedur_list: '93.01;88.72',
        los: 5,
        diagnosa_list: 'M545'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-11')).toBe(true);
    });

    test('does not trigger without rehab procedure', () => {
      const record = {
        prosedur_list: '88.72',
        los: 5,
        diagnosa_list: 'I10'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-11')).toBe(false);
    });

    test('does not trigger for 93.94 (nebulizer/respiratory therapy, not Rehab Medik)', () => {
      const record = {
        prosedur_list: '90.59;87.44;93.94',
        los: 2,
        diagnosa_list: 'J18.0'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-11')).toBe(false);
    });

    test('still triggers when a genuine rehab code (93.x, x<9) is mixed with 93.9x', () => {
      const record = {
        prosedur_list: '93.94;93.01',
        los: 5,
        diagnosa_list: 'M545'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-11')).toBe(true);
    });
  });

  describe('RV-12: Tumor Neoplasma', () => {
    test('triggers for C-codes diagnosis with surgery', () => {
      const record = {
        diagnosa_list: 'C509;I10',
        prosedur_list: '85.43;88.72'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-12')).toBe(true);
    });

    test('triggers for D00-D48 diagnosis with surgery', () => {
      const record = {
        diagnosa_list: 'D259;I10',
        prosedur_list: '68.41'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-12')).toBe(true);
    });

    test('does not trigger for C-code without surgery', () => {
      const record = {
        diagnosa_list: 'C509',
        prosedur_list: '93.01'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-12')).toBe(false);
    });
  });

  describe('RV-13: Konsul Internal', () => {
    test('triggers for konsul internal with multiple episodes', () => {
      const record = {
        jenis_konsultasi: 'KONSUL_INTERNAL',
        jumlah_episode_klaim: 2
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-13')).toBe(true);
    });

    test('does not trigger for single episode', () => {
      const record = {
        jenis_konsultasi: 'KONSUL_INTERNAL',
        jumlah_episode_klaim: 1
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-13')).toBe(false);
    });
  });

  describe('RV-14: Rujukan Internal', () => {
    test('triggers for same day internal referral with multiple episodes', () => {
      const record = {
        jenis_konsultasi: 'RUJUKAN_INTERNAL',
        is_same_day: 1,
        jumlah_episode_klaim: 2
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-14')).toBe(true);
    });

    test('does not trigger for single episode', () => {
      const record = {
        jenis_konsultasi: 'RUJUKAN_INTERNAL',
        is_same_day: 1,
        jumlah_episode_klaim: 1
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-14')).toBe(false);
    });
  });

  describe('RV-15: PRB Flagging', () => {
    test('triggers for chronic stable patient >=3 months without PRB flag', () => {
      const record = {
        diagnosa_list: 'E119;I10',
        histori_obat_kronis_bulan_berturut: 3,
        status_pasien: 'STABIL',
        flag_rujuk_balik_prb: 0
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-15')).toBe(true);
    });

    test('does not trigger with PRB flag active', () => {
      const record = {
        diagnosa_list: 'E119',
        histori_obat_kronis_bulan_berturut: 3,
        status_pasien: 'STABIL',
        flag_rujuk_balik_prb: 1
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-15')).toBe(false);
    });

    test('does not trigger for non-PRB diagnosis', () => {
      const record = {
        diagnosa_list: 'S720',
        histori_obat_kronis_bulan_berturut: 3,
        status_pasien: 'STABIL',
        flag_rujuk_balik_prb: 0
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-15')).toBe(false);
    });
  });

  describe('RV-16: Iterasi Obat Kronis', () => {
    test('triggers for iteration > 2', () => {
      const record = { urutan_iterasi: 3 };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-16')).toBe(true);
    });

    test('does not trigger for iteration <= 2', () => {
      const record = { urutan_iterasi: 2 };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-16')).toBe(false);
    });
  });

  describe('RV-17: Odontektomi Rawat Jalan', () => {
    test('triggers for odontektomi in rawat inap', () => {
      const record = {
        prosedur_list: '23.19;88.72',
        jenis_klaim: 'RAWAT_INAP'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-17')).toBe(true);
    });

    test('does not trigger without odontektomi code', () => {
      const record = {
        prosedur_list: '88.72',
        jenis_klaim: 'RAWAT_INAP'
      };
      const errors = validateRecord(record, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-17')).toBe(false);
    });
  });

  describe('configurable rules', () => {
    test('processes configurable rules with rule_logic', () => {
      const configurableRule = {
        id: 'RV-CUSTOM-1',
        rule_code: 'RV-CUSTOM-1',
        is_active: 1,
        rule_type: 'configurable',
        error_message: 'Custom rule failed',
        rule_logic: JSON.stringify({
          checks: [{ field: 'nama_pasien', operator: 'required', severity: 'critical' }]
        })
      };
      const record = { nama_pasien: '' };
      const errors = validateRecord(record, [configurableRule]);
      expect(errors).toHaveLength(1);
      expect(errors[0].rule_id).toBe('RV-CUSTOM-1');
    });

    test('skips inactive configurable rules', () => {
      const rule = {
        id: 'RV-INACTIVE',
        rule_code: 'RV-INACTIVE',
        is_active: 0,
        rule_type: 'configurable',
        rule_logic: JSON.stringify({
          checks: [{ field: 'nama_pasien', operator: 'required' }]
        })
      };
      const errors = validateRecord({ nama_pasien: '' }, [rule]);
      expect(errors).toHaveLength(0);
    });

    test('skips configurable rules without rule_logic', () => {
      const rule = {
        id: 'RV-NO-LOGIC',
        rule_code: 'RV-NO-LOGIC',
        is_active: 1,
        rule_type: 'configurable',
        rule_logic: null
      };
      const errors = validateRecord({}, [rule]);
      expect(errors).toHaveLength(0);
    });
  });

  describe('inactive builtin rules', () => {
    test('skips inactive rules', () => {
      const rules = [makeRule('RV-11', false)];
      const record = { prosedur_list: '93.01', los: 5, diagnosa_list: 'M545' };
      const errors = validateRecord(record, rules);
      expect(errors.some(e => e.rule_id === 'RV-11')).toBe(false);
    });
  });
});

describe('determineStatus', () => {
  test('returns valid when no errors', () => {
    expect(determineStatus([])).toBe('valid');
  });

  test('returns error for critical severity', () => {
    const errors = [{ severity: 'critical' }];
    expect(determineStatus(errors)).toBe('error');
  });

  test('returns error for major severity', () => {
    const errors = [{ severity: 'major' }];
    expect(determineStatus(errors)).toBe('error');
  });

  test('returns pending for minor severity only', () => {
    const errors = [{ severity: 'minor' }];
    expect(determineStatus(errors)).toBe('pending');
  });

  test('returns error if mixed with critical and minor', () => {
    const errors = [{ severity: 'minor' }, { severity: 'critical' }];
    expect(determineStatus(errors)).toBe('error');
  });
});
