const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseClaimFile, normalizeColumnName } = require('../../services/fileParser');

describe('normalizeColumnName', () => {
  test('maps SEP to sep', () => {
    expect(normalizeColumnName('SEP')).toBe('sep');
  });

  test('maps NO_SEP to sep', () => {
    expect(normalizeColumnName('NO_SEP')).toBe('sep');
  });

  test('maps DIAGNOSA to diagnosa_list', () => {
    expect(normalizeColumnName('DIAGNOSA')).toBe('diagnosa_list');
  });

  test('maps unknown column to lowercase with underscores', () => {
    expect(normalizeColumnName('Some Random Column')).toBe('some_random_column');
  });

  test('trims whitespace and uppercases', () => {
    expect(normalizeColumnName('  nama_pasien  ')).toBe('nama_pasien');
  });
});

describe('parseClaimFile', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclaim-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTxtFile(content) {
    const filePath = path.join(tmpDir, 'test-claim.txt');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  test('parses standard INACBG TXT with tab delimiter', () => {
    const header = 'SEP\tNOKARTU\tNAMA_PASIEN\tDIAGNOSA\tPROSEDUR\tTGLMASUK\tTGLKELUAR\tTGLLAHIR\tUMUR_TAHUN\tJK\tKELAS_RAWAT\tTARIF_RS\tTARIF_INACBG';
    const row1 = '0101R0010724\t0000012345678\tJOHN DOE\tI10;E119\t88.72;93.01\t01/01/2024\t05/01/2024\t01/01/1990\t34\tL\t3\t5000000\t4200000';
    const row2 = '0101R0010725\t0000098765432\tJANE SMITH\tJ459\t93.38\t02/01/2024\t02/01/2024\t15/06/1995\t29\tP\t2\t3000000\t2800000';
    const filePath = createTxtFile(`${header}\n${row1}\n${row2}`);

    const result = parseClaimFile(filePath);

    expect(result.errors).toHaveLength(0);
    expect(result.records).toHaveLength(2);
    expect(result.metadata.delimiter).toBe('\t');
    expect(result.metadata.parsedRows).toBe(2);

    const rec1 = result.records[0];
    expect(rec1.sep).toBe('0101R0010724');
    expect(rec1.nokartu).toBe('0000012345678');
    expect(rec1.diagnosa_list).toBe('I10;E119');
    expect(rec1.umur_tahun).toBe(34);
    expect(rec1.gender).toBe('L');
    expect(rec1.kelas_rawat).toBe(3);
    expect(rec1.tarif_rs).toBe(5000000);
    expect(rec1.tarif_inacbg).toBe(4200000);
  });

  test('parses date formats correctly', () => {
    const header = 'SEP\tTGLMASUK\tTGLKELUAR\tTGLLAHIR';
    const row = 'SEP001\t01/01/2024\t05-01-2024\t1990-01-01';
    const filePath = createTxtFile(`${header}\n${row}`);

    const result = parseClaimFile(filePath);

    expect(result.records[0].admission_date).toBe('2024-01-01');
    expect(result.records[0].discharge_date).toBe('2024-01-05');
    expect(result.records[0].birth_date).toBe('1990-01-01');
  });

  test('handles BOM characters', () => {
    const content = 'SEP\tNOKARTU\tNAMA\nBOM001\t1234567890123\tTEST';
    const buf = Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from(content, 'utf-8')
    ]);
    const filePath = path.join(tmpDir, 'bom-test.txt');
    fs.writeFileSync(filePath, buf);
    const result = parseClaimFile(filePath);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].sep).toBe('BOM001');
  });

  test('returns error when file has only header', () => {
    const filePath = createTxtFile('SEP\tNOKARTU');

    const result = parseClaimFile(filePath);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('minimal');
  });

  test('returns error for empty file', () => {
    const filePath = createTxtFile('');

    const result = parseClaimFile(filePath);
    expect(result.errors).toHaveLength(1);
  });

  test('detects pipe delimiter when tabs are few', () => {
    const header = 'SEP|NOKARTU|NAMA_PASIEN';
    const row = 'P001|1234567890123|ALICE';
    const filePath = createTxtFile(`${header}\n${row}`);

    const result = parseClaimFile(filePath);
    expect(result.metadata.delimiter).toBe('|');
    expect(result.records[0].sep).toBe('P001');
  });

  test('parses numeric fields correctly', () => {
    const header = 'SEP\tLOS\tICU_INDIKATOR\tICU_LOS\tVENT_HOUR\tBIRTH_WEIGHT\tTARIF_RS\tTARIF_INACBG';
    const row = 'S001\t5\t1\t2\t12\t3200\t10000000\t8500000';
    const filePath = createTxtFile(`${header}\n${row}`);

    const result = parseClaimFile(filePath);
    const rec = result.records[0];
    expect(rec.los).toBe(5);
    expect(rec.icu_indikator).toBe(1);
    expect(rec.icu_los).toBe(2);
    expect(rec.vent_hour).toBe(12);
    expect(rec.birth_weight).toBe(3200);
  });

  test('detects period from first record admission date', () => {
    const header = 'SEP\tTGLMASUK\tNAMA';
    const row = 'S001\t15/03/2024\tTEST';
    const filePath = createTxtFile(`${header}\n${row}`);

    const result = parseClaimFile(filePath);
    expect(result.metadata.period).toBe('2024-03');
  });

  test('generates row numbers', () => {
    const header = 'SEP\tNAMA\tCOL3';
    const rows = ['S001\tA\t1', 'S002\tB\t2', 'S003\tC\t3'];
    const filePath = createTxtFile(`${header}\n${rows.join('\n')}`);

    const result = parseClaimFile(filePath);
    expect(result.records[0]._rowNumber).toBe(1);
    expect(result.records[1]._rowNumber).toBe(2);
    expect(result.records[2]._rowNumber).toBe(3);
  });
  test('PTD menentukan jenis layanan per baris, bukan KELAS_RAWAT atau hasil CBG', () => {
    const file = createTxtFile('SEP\tPTD\tKELAS_RAWAT\tINACBG\nUJI1\t2\t3\tA-4-13-I\nUJI2\t1\t1\tQ-5-44-0');
    const r = parseClaimFile(file);
    expect(r.records.map(x => x.jenis_klaim)).toEqual(['RAWAT_JALAN', 'RAWAT_INAP']);
    expect(r.errors).toEqual([]);
    expect(r.records[0]._rawData.PTD).toBe('2');
  });
  test.each([
    ['SEP\tPTD\tJENIS_KLAIM\nUJI\t2\tRAWAT_INAP', 'berbeda'],
    ['SEP\tPTD\tCOL3\nUJI\t3\tx', 'PTD harus'],
    ['SEP\tPTD\tJENIS_KLAIM\nUJI\t\tngawur', 'tidak dikenali'],
  ])('jenis layanan salah atau bertentangan dilaporkan tanpa default rawat inap', (content, pesan) => {
    const r = parseClaimFile(createTxtFile(content));
    expect(r.errors).toContainEqual(expect.objectContaining({ type: 'jenis_layanan', row: 1, message: expect.stringContaining(pesan) }));
  });
  test('berkas lama tanpa PTD dapat memakai jenis layanan tertulis', () => {
    const r = parseClaimFile(createTxtFile('SEP\tJNSPELAYANAN\tCOL3\nUJI\t2\tx'));
    expect(r.records[0].jenis_klaim).toBe('RAWAT_JALAN');
  });
});
