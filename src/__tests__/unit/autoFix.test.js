const { validateRecord } = require('../../services/ruleEngine');

describe('validasi identitas klaim', () => {
  test('SEP lowercase ditandai tanpa mengubah nilai sumber', () => {
    const record = { sep: '0170r0111225v000499' };
    const errors = validateRecord(record, [{ id: 'RV-01', is_active: true }]);

    expect(errors.some(error => error.rule_id === 'RV-01')).toBe(true);
    expect(record.sep).toBe('0170r0111225v000499');
  });

  test('nomor kartu yang panjangnya salah ditandai tanpa menebak digit', () => {
    const record = { nokartu: '12345' };
    const errors = validateRecord(record, [{ id: 'RV-02', is_active: true }]);

    expect(errors.some(error => error.rule_id === 'RV-02')).toBe(true);
    expect(record.nokartu).toBe('12345');
  });
});
