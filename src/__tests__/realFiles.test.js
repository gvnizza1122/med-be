const path = require('path');
const fs = require('fs');
const { parseClaimFile } = require('../services/fileParser');
const { validateRecord, determineStatus } = require('../services/ruleEngine');

const DATA_DIR = path.join(__dirname, '../../../data-claim');

const FILES = [
  { name: '3371084_20260325_MIX pending uncrypted.TXT',        expectedRecords: 18,  label: 'Pending' },
  { name: '3371084_20260325_MIX uncrypt janu.TXT',             expectedRecords: 244, label: 'Januari' },
  { name: '3371084_20260325_MIX unencryp desember.TXT',        expectedRecords: 251, label: 'Desember' },
];

const describeWithRealFiles = FILES.every(file => fs.existsSync(path.join(DATA_DIR, file.name))) ? describe : describe.skip;

describeWithRealFiles('Real claim files - parseClaimFile', () => {
  FILES.forEach(({ name, expectedRecords, label }) => {
    test(`[${label}] mem-parse ${name} dengan benar`, () => {
      const filePath = path.join(DATA_DIR, name);
      const result = parseClaimFile(filePath);

      expect(result.errors).toHaveLength(0);
      expect(result.records).toHaveLength(expectedRecords);
      expect(result.metadata.parsedRows).toBe(expectedRecords);
      expect(result.metadata.skippedRows).toBe(0);
      expect(result.metadata.delimiter).toBe('\t');
      expect(result.metadata.columnCount).toBe(60);
      expect(result.headers).toHaveLength(60);
      expect(result.metadata.hospitalCode).toBe('3371084');

      expect(result.metadata.period).toBeTruthy();
      expect(result.metadata.period.length).toBe(7);

      result.records.forEach((rec, idx) => {
        expect(rec.kode_rs).toBe('3371084');
        expect(rec.sep).toBeTruthy();
        expect(rec.nokartu).toBeTruthy();
        expect(rec).toHaveProperty('nama_pasien');
        expect(rec.diagnosa_list).toBeTruthy();
        expect(rec.prosedur_list).toBeTruthy();
        expect(typeof rec.los).toBe('number');
        expect(typeof rec.tarif_rs).toBe('number');
        expect(typeof rec.tarif_inacbg).toBe('number');
        expect(typeof rec.umur_tahun).toBe('number');
        expect(rec._rowNumber).toBe(idx + 1);
      });
    });
  });
});

describeWithRealFiles('Real claim files - field values', () => {
  test('pending file: SEP, nama, diagnosa, tarif terisi dengan benar', () => {
    const filePath = path.join(DATA_DIR, FILES[0].name);
    const result = parseClaimFile(filePath);
    const rec = result.records[0];

    expect(rec.nama_pasien).toBe('H. NAKMAN AM, BP');
    expect(rec.diagnosa_list).toBe('J18.0;R63.0;F03;A09.9;I64;I11.9');
    expect(rec.kelas_rawat).toBe(1);
    expect(rec.los).toBe(7);
    expect(rec.icu_indikator).toBe(1);
    expect(rec.icu_los).toBe(3);
    expect(rec.umur_tahun).toBe(86);
    expect(rec.gender).toBe('1');
    expect(rec.admission_date).toBe('2025-11-25');
    expect(rec.discharge_date).toBe('2025-12-01');
  });

  test('pending file: record ke-5 SEP lowercase ditandai tanpa mengubah sumber', () => {
    const filePath = path.join(DATA_DIR, FILES[0].name);
    const result = parseClaimFile(filePath);
    const rec = result.records[4];

    expect(rec.sep).toBe('0170R0111225v000499');
    expect(rec.sep).not.toBe(rec.sep.toUpperCase());

    const errors = validateRecord(rec, [{ id: 'RV-01', is_active: true }]);
    expect(errors.some(error => error.rule_id === 'RV-01')).toBe(true);
    expect(rec.sep).toBe('0170R0111225v000499');
  });
});

describeWithRealFiles('Real claim files - validation rules engine', () => {
  function makeRule(id, isActive = true) {
    return { id, rule_code: id, is_active: isActive, rule_type: 'builtin', rule_logic: null, error_message: null };
  }

  const activeRules = [
    makeRule('RV-11'), makeRule('RV-12'), makeRule('RV-13'),
    makeRule('RV-14'), makeRule('RV-15'), makeRule('RV-16'), makeRule('RV-17'),
  ];

  FILES.forEach(({ name, expectedRecords, label }) => {
    test(`[${label}] validasi record tidak throw error`, () => {
      const filePath = path.join(DATA_DIR, name);
      const { records } = parseClaimFile(filePath);

      records.forEach((rec) => {
        expect(() => validateRecord(rec, activeRules)).not.toThrow();
      });
    });

    test(`[${label}] status ditentukan dengan benar untuk setiap record`, () => {
      const filePath = path.join(DATA_DIR, name);
      const { records } = parseClaimFile(filePath);

      records.forEach((rec) => {
        const errors = validateRecord(rec, activeRules);
        const status = determineStatus(errors);
        expect(['valid', 'error', 'pending']).toContain(status);

        if (errors.length === 0) expect(status).toBe('valid');
        else if (errors.some(e => e.severity === 'critical' || e.severity === 'major')) expect(status).toBe('error');
        else expect(status).toBe('pending');
      });
    });
  });

  test('record dengan prosedur rehab medik (93.xx) terdeteksi RV-11', () => {
    const filePath = path.join(DATA_DIR, FILES[0].name);
    const { records } = parseClaimFile(filePath);

    const rehabRecords = records.filter(r => (r.prosedur_list || '').split(';').some(p => p.trim().startsWith('93')));
    expect(rehabRecords.length).toBeGreaterThan(0);

    rehabRecords.forEach((rec) => {
      const errors = validateRecord(rec, activeRules);
      expect(errors.some(e => e.rule_id === 'RV-11')).toBe(true);
    });
  });

  test('record dengan diagnosa C00-D48 dan prosedur bedah terdeteksi RV-12', () => {
    const filePath = path.join(DATA_DIR, FILES[0].name);
    const { records } = parseClaimFile(filePath);

    const tumorSurgeryRecords = records.filter(r => {
      const diags = (r.diagnosa_list || '').split(';').map(d => d.trim().toUpperCase());
      const hasTumor = diags.some(d => {
        if (d.charAt(0) === 'C') return true;
        if (d.charAt(0) === 'D') { const n = parseInt(d.substring(1, 3)); return !isNaN(n) && n <= 48; }
        return false;
      });
      if (!hasTumor) return false;
      const procs = (r.prosedur_list || '').split(';').map(p => p.trim());
      return procs.some(p => { const n = parseFloat(p); return !isNaN(n) && n < 87.0; });
    });

    if (tumorSurgeryRecords.length > 0) {
      tumorSurgeryRecords.forEach((rec) => {
        const errors = validateRecord(rec, activeRules);
        expect(errors.some(e => e.rule_id === 'RV-12')).toBe(true);
      });
    }
  });
});

describeWithRealFiles('Real claim files - configurable rules', () => {
  const configRules = [
    {
      id: 'RV-INTEG-TEST', rule_code: 'RV-INTEG-TEST', is_active: 1,
      rule_type: 'configurable', error_message: 'Nama pasien wajib diisi',
      rule_logic: JSON.stringify({ checks: [{ field: 'nama_pasien', operator: 'required', severity: 'critical' }] })
    }
  ];

  FILES.forEach(({ name, label }) => {
    test(`[${label}] configurable rule mendeteksi nama_pasien kosong`, () => {
      const filePath = path.join(DATA_DIR, name);
      const { records } = parseClaimFile(filePath);

      const emptyNameRecords = records.filter(r => !r.nama_pasien || r.nama_pasien.trim() === '');
      const totalErrors = records.reduce((sum, rec) => {
        const errors = validateRecord(rec, configRules);
        return sum + errors.filter(e => e.rule_id === 'RV-INTEG-TEST').length;
      }, 0);

      expect(totalErrors).toBe(emptyNameRecords.length);
    });
  });
});


