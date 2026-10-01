const { parsePDF, validateFields, extractField, normalizeDate } = require('../src/services/pdfParser');
const fs = require('fs');
const path = require('path');

/**
 * Test suite untuk PDF Parser E-Claim
 */

// Sample test data - simulating SIMRS PDF format
const SAMPLE_PDF_TEXT = `
RUMAH SAKIT MITRA KELUARGA BATANG
FORMULIR PERMOHONAN SURAT ELIGIBILITAS PESERTA (SEP)

=== HALAMAN 1 ===

Data Peserta:
No. RM                    : 123456
No. Kartu                 : 0000123456789012
Nama Pasien              : BUDI SANTOSO
Tgl. Lahir               : 15/06/1985
Jenis Kelamin            : LAKI-LAKI
Alamat                   : JL MERDEKA NO 123, BATANG

Data Rawat Inap:
Tgl. Masuk               : 10/07/2024
Tgl. Keluar              : 14/07/2024
Kelas Rawat              : 2
Dokter                   : DR. GUNAWAN HANDOKO, SP.U

Data SEP:
No. SEP                  : 0000123456789010
Tgl. SEP                 : 09/07/2024

=== HALAMAN 2 ===

Diagnosa dan Prosedur:
Diagnosa Utama           : I10 - Essential (primary) hypertension
Diagnosa Sekunder        : E11.9 - Type 2 diabetes mellitus without complications
Prosedur Utama           : Perawatan pasien dengan hipertensi dan diabetes

Validasi:
- Peserta: AKTIF
- Jenis Peserta: PBI
- Ruang Rawat: Tersedia

Catatan:
PDF ini adalah simulasi format digital SIMRS untuk testing.
`;

/**
 * Create a minimal valid PDF for testing
 * Note: This is a simplified approach using text encoding
 */
async function createSamplePDF() {
  // For actual testing, we would use a PDF library
  // This is a placeholder that simulates PDF text extraction
  return Buffer.from(SAMPLE_PDF_TEXT, 'utf-8');
}

/**
 * Test helper: Run and log test results
 */
function logTest(name, passed, expected, actual, error = null) {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${name}`);
  if (!passed) {
    console.log(`  Expected: ${JSON.stringify(expected)}`);
    console.log(`  Actual: ${JSON.stringify(actual)}`);
    if (error) {
      console.log(`  Error: ${error}`);
    }
  }
}

/**
 * Main test execution
 */
async function runTests() {
  console.log('='.repeat(60));
  console.log('E-CLAIM PDF PARSER TEST SUITE');
  console.log('='.repeat(60));
  console.log('');

  let passed = 0;
  let failed = 0;

  // Test 1: Field extraction with basic patterns
  console.log('Test Group 1: Field Extraction');
  console.log('-'.repeat(60));

  try {
    // Test individual field extraction
    const testText = SAMPLE_PDF_TEXT;

    // Test noRM extraction
    let noRM = extractField(testText, [
      /no\s*\.?\s*rm\s*[:=]?\s*([^\n]+)/i,
    ]);
    if (noRM && noRM.includes('123456')) {
      logTest('Extract No. RM', true, '123456', noRM);
      passed++;
    } else {
      logTest('Extract No. RM', false, '123456', noRM);
      failed++;
    }

    // Test noKartu extraction
    let noKartu = extractField(testText, [
      /no\s*\.?\s*kartu\s*[:=]?\s*([^\n]+)/i,
    ]);
    if (noKartu && noKartu.includes('0000123456789012')) {
      logTest('Extract No. Kartu', true, '0000123456789012', noKartu);
      passed++;
    } else {
      logTest('Extract No. Kartu', false, '0000123456789012', noKartu);
      failed++;
    }

    // Test nama extraction
    let nama = extractField(testText, [
      /nama\s*pasien\s*[:=]?\s*([^\n]+)/i,
    ]);
    if (nama && nama.includes('BUDI SANTOSO')) {
      logTest('Extract Nama Pasien', true, 'BUDI SANTOSO', nama);
      passed++;
    } else {
      logTest('Extract Nama Pasien', false, 'BUDI SANTOSO', nama);
      failed++;
    }

    // Test dokter extraction
    let dokter = extractField(testText, [
      /dokter\s*[:=]?\s*([^\n]+)/i,
    ]);
    if (dokter && dokter.includes('DR. GUNAWAN')) {
      logTest('Extract Dokter', true, 'DR. GUNAWAN', dokter);
      passed++;
    } else {
      logTest('Extract Dokter', false, 'DR. GUNAWAN', dokter);
      failed++;
    }

    // Test alamat extraction
    let alamat = extractField(testText, [
      /alamat\s*[:=]?\s*([^\n]+)/i,
    ]);
    if (alamat && alamat.includes('JL MERDEKA')) {
      logTest('Extract Alamat', true, 'JL MERDEKA', alamat);
      passed++;
    } else {
      logTest('Extract Alamat', false, 'JL MERDEKA', alamat);
      failed++;
    }
  } catch (error) {
    logTest('Field extraction group', false, 'success', 'error', error.message);
    failed += 5;
  }

  console.log('');

  // Test 2: Date normalization
  console.log('Test Group 2: Date Normalization');
  console.log('-'.repeat(60));

  const dateTests = [
    { input: '15/06/1985', expected: '1985-06-15' },
    { input: '15-06-1985', expected: '1985-06-15' },
    { input: '1985-06-15', expected: '1985-06-15' },
    { input: '19850615', expected: '1985-06-15' },
  ];

  for (const test of dateTests) {
    const result = normalizeDate(test.input);
    if (result === test.expected) {
      logTest(`Normalize date: ${test.input}`, true, test.expected, result);
      passed++;
    } else {
      logTest(`Normalize date: ${test.input}`, false, test.expected, result);
      failed++;
    }
  }

  console.log('');

  // Test 3: Field validation
  console.log('Test Group 3: Field Validation');
  console.log('-'.repeat(60));

  try {
    const fieldsValid = {
      noRM: '123456',
      noKartu: '0000123456789012',
      nama: 'BUDI SANTOSO',
      tglLahir: '1985-06-15',
      tglMasuk: '2024-07-10',
      tglKeluar: '2024-07-14',
      kelasRawat: '2',
      diagnosa: 'I10 - Essential hypertension',
      dokter: 'DR. GUNAWAN HANDOKO',
      alamat: 'JL MERDEKA NO 123',
      tglSEP: '2024-07-09',
      noSEP: '0000123456789010',
    };

    const validation = validateFields(fieldsValid, [
      'noRM',
      'noKartu',
      'nama',
    ]);
    if (validation.valid) {
      logTest('Validate complete fields', true, 'valid', 'valid');
      passed++;
    } else {
      logTest('Validate complete fields', false, 'valid', validation.errors);
      failed++;
    }

    // Test missing required field
    const fieldsInvalid = {
      noRM: '123456',
      // noKartu is missing
      nama: 'BUDI SANTOSO',
    };

    const validation2 = validateFields(fieldsInvalid, [
      'noRM',
      'noKartu',
      'nama',
    ]);
    if (!validation2.valid && validation2.errors.length > 0) {
      logTest('Validate missing field detection', true, 'errors', validation2.errors);
      passed++;
    } else {
      logTest('Validate missing field detection', false, 'errors', validation2);
      failed++;
    }

    // Test format validation for noKartu
    const fieldsBadFormat = {
      noRM: '123456',
      noKartu: 'INVALID123',
      nama: 'BUDI',
    };

    const validation3 = validateFields(fieldsBadFormat, ['noRM', 'noKartu']);
    if (validation3.warnings.length > 0) {
      logTest('Validate format warnings', true, 'warnings', 'detected');
      passed++;
    } else {
      logTest('Validate format warnings', false, 'warnings', 'none');
      failed++;
    }
  } catch (error) {
    logTest('Field validation group', false, 'success', 'error', error.message);
    failed += 3;
  }

  console.log('');

  // Test 4: PDF parsing (if pdf-parse works)
  console.log('Test Group 4: PDF Parsing');
  console.log('-'.repeat(60));

  try {
    // Test with sample PDF
    console.log('Note: Creating test PDF from sample text...');

    // For testing, we'll just verify the module loads and functions exist
    if (
      typeof parsePDF === 'function' &&
      typeof validateFields === 'function' &&
      typeof extractField === 'function'
    ) {
      logTest('Module exports all functions', true, 'all functions', 'loaded');
      passed++;
    } else {
      logTest('Module exports all functions', false, 'all functions', 'partial');
      failed++;
    }

    // Verify function signatures
    if (parsePDF.length === 1) {
      logTest('parsePDF signature', true, '1 param', '1 param');
      passed++;
    } else {
      logTest('parsePDF signature', false, '1 param', parsePDF.length);
      failed++;
    }

    if (validateFields.length >= 1) {
      logTest('validateFields signature', true, '1+ params', validateFields.length);
      passed++;
    } else {
      logTest('validateFields signature', false, '1+ params', validateFields.length);
      failed++;
    }
  } catch (error) {
    logTest('PDF parsing group', false, 'success', 'error', error.message);
    failed += 3;
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Tests: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
  console.log('='.repeat(60));
  console.log('');

  // Return results
  return {
    total: passed + failed,
    passed,
    failed,
    successRate: (passed / (passed + failed)) * 100,
  };
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests()
    .then((results) => {
      process.exit(results.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('Test execution failed:', error);
      process.exit(1);
    });
}

module.exports = { runTests };
