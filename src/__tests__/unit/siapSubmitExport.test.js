const ExcelJS = require('exceljs');
const { buatSiapSubmit, namaBerkasSiapSubmit, KOLOM } = require('../../services/siapSubmitExportService');

describe('Export Siap Submit', () => {
  test('memuat Ringkasan lalu Data Klaim dengan urutan field vClaim', async () => {
    const buffer = await buatSiapSubmit([{
      sep: '0170R0110826V003045', nokartu: '0003604746071', nama_pasien: 'SUMIDAH', mrn: '104853',
      birth_date: '1980-02-03', gender: 'P', admission_date: '12/09/2026', discharge_date: '12/09/2026',
      kelas_rawat: 3, discharge_status: 1, los: 1, diagnosa_list: 'R10.4;E86', prosedur_list: '90.59',
      inacbg_code: 'K-4-17-I', deskripsi_inacbg: 'Contoh', tarif_inacbg: 1264200, total_tarif: 1264200,
      raw_data: JSON.stringify({ ADL1: '1/320', ADL2: '2', SP: 'SP1', SR: 'SR1', SI: 'SI1', SD: 'SD1', SUBACUTE: '0', CHRONIC: '0', KODE_TARIF: 'CP' }),
    }], { periode: '2026-09', kategori: 'RAWAT_JALAN' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['Ringkasan', 'Data Klaim']);
    const sheet = workbook.getWorksheet('Data Klaim');
    expect(sheet.getRow(1).values.slice(1)).toEqual(KOLOM.map(col => col.header));
    expect(sheet.getCell('A2').value).toBe('0170R0110826V003045');
    expect(sheet.getCell('B2').value).toBe('0003604746071');
    expect(sheet.getCell('N2').value).toBe('1/320');
    expect(sheet.getCell('R2').value).toBe(1264200);
    expect(sheet.getColumn(2).numFmt).toBe('@');
    expect(sheet.getColumn(1).numFmt).toBe('@');
    expect(sheet.views[0].ySplit).toBe(1);
    expect(sheet.autoFilter).toBe('A1:AD2');
  });

  test('nama berkas menunjukkan periode dan kategori', () => {
    expect(namaBerkasSiapSubmit({ periode: '2026-09', kategori: 'RAWAT_JALAN' }))
      .toBe('siap-submit_2026-09_rawat-jalan.xlsx');
  });
});
