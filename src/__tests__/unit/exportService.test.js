const XLSX = require('xlsx');
const { generateExcel } = require('../../services/exportService');

describe('generateExcel', () => {
  const fileInfo = {
    file_name: 'test_claim.txt',
    period: '2024-01',
    hospital_code: '3371084',
    total_records: 10,
    valid_count: 7,
    error_count: 2,
    pending_count: 1,
    status: 'completed'
  };

  const records = [
    {
      sep: 'SEP001', nokartu: '1234567890123', nama_pasien: 'BUDI',
      mrn: 'MRN001', birth_date: '1990-01-01', umur_tahun: 34,
      admission_date: '2024-01-01', discharge_date: '2024-01-05',
      los: 4, kelas_rawat: 3, discharge_status: 1,
      diagnosa_list: 'I10', prosedur_list: '88.72',
      inacbg_code: 'I-1-10-I', deskripsi_inacbg: 'Test Desc',
      tarif_inacbg: 5000000, tarif_rs: 5500000, total_tarif: 5200000,
      icu_indikator: 0, vent_hour: 0, dpjp_name: 'Dr. Andi',
      validation_status: 'valid', error_count: 0,
      errors: []
    },
    {
      sep: 'SEP002', nokartu: '9876543210987', nama_pasien: 'SITI',
      mrn: 'MRN002', birth_date: '1985-06-15', umur_tahun: 38,
      admission_date: '2024-01-10', discharge_date: '2024-01-12',
      los: 2, kelas_rawat: 2, discharge_status: 1,
      diagnosa_list: 'E119', prosedur_list: '93.01',
      inacbg_code: 'K-4-10-I', deskripsi_inacbg: 'Test Desc 2',
      tarif_inacbg: 3000000, tarif_rs: 2000000, total_tarif: 2500000,
      icu_indikator: 1, vent_hour: 24, dpjp_name: 'Dr. Budi',
      validation_status: 'error', error_count: 1,
      errors: [
        { rule_id: 'RV-11', field_name: 'prosedur_list', error_message: 'Error rehab', severity: 'major' }
      ]
    }
  ];

  test('generates Excel buffer', () => {
    const buffer = generateExcel(records, fileInfo, 'all');
    expect(buffer).toBeInstanceOf(Buffer);

    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetNames = wb.SheetNames;
    expect(sheetNames).toContain('Ringkasan');
    expect(sheetNames).toContain('Detail Klaim');
  });

  test('summary sheet contains file info', () => {
    const buffer = generateExcel(records, fileInfo, 'all');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets['Ringkasan'];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const flat = data.flat().join(' ');
    expect(flat).toContain('test_claim.txt');
    expect(flat).toContain('2024-01');
    expect(flat).toContain('3371084');
    expect(flat).toContain('10');
    expect(flat).toContain('7');
    expect(flat).toContain('2');
  });

  test('detail sheet contains record data', () => {
    const buffer = generateExcel(records, fileInfo, 'all');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets['Detail Klaim'];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const allText = JSON.stringify(data);
    expect(allText).toContain('SEP001');
    expect(allText).toContain('SEP002');
    expect(allText).toContain('BUDI');
    expect(allText).toContain('SITI');
    expect(allText).toContain('valid');
    expect(allText).toContain('error');
  });

  test('error summary sheet exists when records have errors', () => {
    const buffer = generateExcel(records, fileInfo, 'error');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetNames = wb.SheetNames;
    expect(sheetNames).toContain('Ringkasan Error');
  });

  test('filters records by error status', () => {
    const buffer = generateExcel(records, fileInfo, 'error');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets['Detail Klaim'];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const allText = JSON.stringify(data);
    expect(allText).toContain('SEP002');
    expect(allText).not.toContain('SEP001');
  });

  test('filters records by valid status', () => {
    const buffer = generateExcel(records, fileInfo, 'valid');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets['Detail Klaim'];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const allText = JSON.stringify(data);
    expect(allText).toContain('SEP001');
    expect(allText).not.toContain('SEP002');
  });

  test('generates empty error summary when no errors', () => {
    const buffer = generateExcel([records[0]], fileInfo, 'all');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetNames = wb.SheetNames;
    expect(sheetNames).not.toContain('Ringkasan Error');
  });

  test('SEP corrections sheet appears when RV-01 errors exist', () => {
    const recordsWithSepError = [
      {
        ...records[0],
        validation_status: 'error',
        error_count: 1,
        errors: [{ rule_id: 'RV-01', field_name: 'sep', error_message: 'SEP lowercase' }]
      }
    ];
    const buffer = generateExcel(recordsWithSepError, fileInfo, 'all');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    expect(wb.SheetNames).toContain('SEP Perlu Koreksi');
  });
});
