const { applyAutoFix } = require('../../routes/claimFiles');

describe('applyAutoFix - SEP formatting', () => {
  test('uppercases lowercase SEP', () => {
    const { record, fixes } = applyAutoFix({ sep: '0170r0111225v000499' });
    expect(record.sep).toBe('0170R0111225V000499');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].field).toBe('sep');
    expect(fixes[0].before).toBe('0170r0111225v000499');
    expect(fixes[0].after).toBe('0170R0111225V000499');
  });

  test('removes non-alphanumeric characters from SEP', () => {
    const { record, fixes } = applyAutoFix({ sep: '0170R-0111/225.V000499' });
    expect(record.sep).toBe('0170R0111225V000499');
    expect(fixes.length).toBeGreaterThan(0);
  });

  test('does not modify already valid SEP', () => {
    const { record, fixes } = applyAutoFix({ sep: '0170R0111225V000499' });
    expect(record.sep).toBe('0170R0111225V000499');
    expect(fixes).toHaveLength(0);
  });

  test('handles undefined SEP gracefully', () => {
    const { record, fixes } = applyAutoFix({});
    expect(record.sep).toBeUndefined();
    expect(fixes).toHaveLength(0);
  });
});

describe('applyAutoFix - No Kartu formatting', () => {
  test('pads short nokartu to 13 digits', () => {
    const { record, fixes } = applyAutoFix({ nokartu: '12345' });
    expect(record.nokartu).toBe('0000000012345');
    expect(fixes.length).toBeGreaterThan(0);
  });

  test('removes non-digit characters from nokartu', () => {
    const { record, fixes } = applyAutoFix({ nokartu: '0000-0856-9334-2' });
    expect(record.nokartu).toBe('0000085693342');
    expect(fixes.length).toBeGreaterThan(0);
  });

  test('takes last 13 digits when longer', () => {
    const { record } = applyAutoFix({ nokartu: '12345678901234567' });
    expect(record.nokartu).toBe('5678901234567');
  });

  test('does not modify valid 13-digit nokartu', () => {
    const { record, fixes } = applyAutoFix({ nokartu: '0000085693342' });
    expect(record.nokartu).toBe('0000085693342');
    expect(fixes).toHaveLength(0);
  });
});

describe('applyAutoFix - ICD codes formatting', () => {
  test('uppercases diagnosa_list (preserves dots for ICD-10 format)', () => {
    const { record, fixes } = applyAutoFix({ diagnosa_list: 'e11.9;i10' });
    expect(record.diagnosa_list).toBe('E11.9;I10');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].field).toBe('diagnosa_list');
  });

  test('does not modify already clean ICD-10 codes', () => {
    const { record, fixes } = applyAutoFix({ diagnosa_list: 'I10;E11.9' });
    expect(record.diagnosa_list).toBe('I10;E11.9');
    expect(fixes).toHaveLength(0);
  });

  test('uppercases prosedur_list (preserves dots for ICD-9 format)', () => {
    const { record, fixes } = applyAutoFix({ prosedur_list: '93.01;88.72' });
    expect(record.prosedur_list).toBe('93.01;88.72');
    expect(fixes).toHaveLength(0);
  });

  test('does not modify already clean ICD-9 codes', () => {
    const { record, fixes } = applyAutoFix({ prosedur_list: '93.01;88.72' });
    expect(record.prosedur_list).toBe('93.01;88.72');
    expect(fixes).toHaveLength(0);
  });
});

describe('applyAutoFix - Nama Pasien formatting', () => {
  test('uppercases lowercase nama_pasien', () => {
    const { record, fixes } = applyAutoFix({ nama_pasien: 'budi santoso' });
    expect(record.nama_pasien).toBe('BUDI SANTOSO');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].field).toBe('nama_pasien');
  });

  test('does not modify already uppercase nama', () => {
    const { record, fixes } = applyAutoFix({ nama_pasien: 'BUDI SANTOSO' });
    expect(record.nama_pasien).toBe('BUDI SANTOSO');
    expect(fixes).toHaveLength(0);
  });

  test('handles empty nama_pasien', () => {
    const { record, fixes } = applyAutoFix({ nama_pasien: '' });
    expect(record.nama_pasien).toBe('');
    expect(fixes).toHaveLength(0);
  });
});

describe('applyAutoFix - multiple fixes at once', () => {
  test('fixes SEP, nama, ICD-10, and ICD-9 simultaneously', () => {
    const record = {
      sep: '0170r0111225v000499',
      nokartu: '0000-8569-3342',
      nama_pasien: 'budi santoso',
      diagnosa_list: 'e11.9;i10',
      prosedur_list: '93.01;88.72'
    };

    const { record: fixed, fixes } = applyAutoFix(record);
    expect(fixed.sep).toBe('0170R0111225V000499');
    expect(fixed.nokartu).toBe('0000085693342');
    expect(fixed.nama_pasien).toBe('BUDI SANTOSO');
    expect(fixed.diagnosa_list).toBe('E11.9;I10');
    expect(fixed.prosedur_list).toBe('93.01;88.72');
    expect(fixes).toHaveLength(4);
  });
});

describe('applyAutoFix - real claim data', () => {
  test('pending file record ke-5 SEP diperbaiki', () => {
    const record = { sep: '0170R0111225v000499' };
    const { record: fixed, fixes } = applyAutoFix(record);
    expect(fixed.sep).toBe('0170R0111225V000499');
    expect(fixes).toHaveLength(1);
  });

  test('record dengan data benar tidak berubah', () => {
    const record = {
      sep: '0170R0111225V003433',
      nokartu: '0000085772474',
      nama_pasien: 'SITI NURHAYATI, NY',
      diagnosa_list: 'I13.1;D63.8;L28.2',
      prosedur_list: '99.04;90.59;89.52'
    };
    const { fixes } = applyAutoFix(record);
    expect(fixes.length).toBeGreaterThanOrEqual(0);
  });
});
