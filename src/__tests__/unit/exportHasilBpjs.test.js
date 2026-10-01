const XLSX = require('xlsx');
const { applicationDecision, buildWorkbook, klasifikasi } = require('../../../scripts/exportHasilBpjs');

describe('exportHasilBpjs', () => {
  test('membaca status pending AI dan alasan tanpa menimpa data sumber', () => {
    const row = {
      validation_status: 'valid',
      ai_review: JSON.stringify({ putusan_pending: { status: 'berisiko_pending', alasan: [{ kode: 'RV-20', ringkas: 'Bukti kegawatan belum cukup' }] } }),
      validation_errors: [],
    };
    expect(applicationDecision(row)).toEqual({ ditandai: true, alasan: 'RV-20: Bukti kegawatan belum cukup' });
    expect(klasifikasi({ ...row, alasan_raw: 'BPJS pending: kode diagnosis' })).toBe('pending tapi alasan beda');
    expect(row).not.toHaveProperty('jawaban_rs_manual');
  });

  test('membedakan klaim terlewat dan hanya menyebut alarm palsu sebagai tidak terukur', () => {
    const rows = [
      { sep: '0001', alasan_raw: 'Alasan pending BPJS', validation_status: 'valid', ai_review: null, validation_errors: [] },
      { sep: '0002', alasan_raw: 'Bukti kegawatan belum cukup', validation_status: 'pending', ai_review: JSON.stringify({ putusan_pending: { status: 'berisiko_pending', alasan: [{ ringkas: 'Bukti kegawatan belum cukup' }] } }), validation_errors: [] },
    ];
    const { workbook, counts } = buildWorkbook(rows, { fileName: 'rekap.xlsx', pendingFileId: 'file-1' });
    expect(counts.terlewat).toBe(1);
    expect(counts['cocok penuh']).toBe(1);
    const summary = XLSX.utils.sheet_to_json(workbook.Sheets.Ringkasan, { header: 1 });
    expect(summary.find((r) => r[0] === 'Alarm palsu')[1]).toMatch(/Belum dapat dihitung/);
    const detail = XLSX.utils.sheet_to_json(workbook.Sheets['Per Klaim'], { header: 1 });
    expect(detail[1][0]).toBe('0001');
    expect(detail[2][7]).toBe('cocok penuh');
  });

  test('status valid tanpa alasan pending tidak ditandai', () => {
    expect(applicationDecision({ validation_status: 'valid', ai_review: null, validation_errors: [] }))
      .toEqual({ ditandai: false, alasan: '' });
  });
});
