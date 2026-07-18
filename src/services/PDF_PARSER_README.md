# PDF Parser Module - E-Claim

Modul untuk extract field dari halaman 1-2 PDF digital SIMRS (Sistem Informasi Manajemen Rumah Sakit).

## Overview

PDF Parser menggunakan `pdf-parse` library untuk extract text dari PDF dan regex patterns untuk identify & extract field spesifik yang diperlukan untuk claim processing.

### Requirements
- Library: `pdf-parse` (v2.4.5) - sudah di `package.json`
- Node.js: v14+
- PDF: Format digital terstruktur (halaman 1-2), bukan scanned/OCR

### Lokasi File
```
be/src/services/pdfParser.js          # Main module
be/src/services/pdfParser.test.js     # Test suite
be/src/services/pdfParser.example.js  # Usage examples
```

---

## API Reference

### `parsePDF(filePath)`

Parse PDF file dan extract claim fields dari halaman 1-2.

**Parameters:**
- `filePath` (string|Buffer): Path ke PDF file atau Buffer

**Returns:** Promise<Object>
```javascript
{
  success: boolean,
  fields: {
    noRM: string|null,           // Nomor Rekam Medis
    noKartu: string|null,        // Nomor Kartu BPJS
    nama: string|null,           // Nama Pasien
    tglLahir: string|null,       // Tanggal Lahir (YYYY-MM-DD)
    tglMasuk: string|null,       // Tanggal Masuk (YYYY-MM-DD)
    tglKeluar: string|null,      // Tanggal Keluar (YYYY-MM-DD)
    kelasRawat: string|null,     // Kelas Rawat
    diagnosa: string|null,       // Diagnosa
    dokter: string|null,         // Nama Dokter (DPJP)
    alamat: string|null,         // Alamat Pasien
    tglSEP: string|null,         // Tanggal SEP (YYYY-MM-DD)
    noSEP: string|null,          // Nomor SEP
  },
  rawText: {
    page1: string,               // Raw text halaman 1
    page2: string,               // Raw text halaman 2
  },
  metadata: {
    totalPages: number,          // Total halaman dalam PDF
    procesedPages: number,       // Halaman yang berhasil diproses
    extractedFields: number,     // Jumlah field yang berhasil di-extract
    encoding: string,            // Encoding PDF
  },
  errors: Array<{
    type: string,                // 'parse_error' | 'extraction_error'
    message: string,
    stack?: string               // Hanya di development mode
  }>
}
```

**Example:**
```javascript
const { parsePDF } = require('./pdfParser');

const result = await parsePDF('./uploads/simrs_claim.pdf');

if (result.success) {
  console.log('Extracted Fields:', result.fields);
  console.log('Total extracted:', result.metadata.extractedFields);
} else {
  console.error('Errors:', result.errors);
}
```

---

### `validateFields(fields, requiredFields)`

Validate extracted fields untuk check required fields dan format.

**Parameters:**
- `fields` (Object): Extracted fields object dari `parsePDF()`
- `requiredFields` (Array): Array field names yang required (default: `['noRM', 'noKartu', 'nama']`)

**Returns:** Object
```javascript
{
  valid: boolean,              // true jika semua required fields present
  errors: Array<string>,       // List of missing/invalid required fields
  warnings: Array<string>      // Format warnings (e.g., invalid BPJS format)
}
```

**Example:**
```javascript
const { parsePDF, validateFields } = require('./pdfParser');

const result = await parsePDF('./uploads/simrs_claim.pdf');

const validation = validateFields(result.fields, [
  'noRM', 'noKartu', 'nama', 'tglMasuk', 'tglKeluar'
]);

if (!validation.valid) {
  console.error('Errors:', validation.errors);
}
if (validation.warnings.length > 0) {
  console.warn('Warnings:', validation.warnings);
}
```

---

### `extractField(text, patterns)`

Low-level function untuk extract field value dari text menggunakan regex patterns.

**Parameters:**
- `text` (string): Text untuk di-search
- `patterns` (Array): Array of regex patterns

**Returns:** string|null

**Example:**
```javascript
const { extractField } = require('./pdfParser');

const text = 'No. RM : 123456\nNama : BUDI SANTOSO';
const noRM = extractField(text, [/no\s*\.?\s*rm\s*[:=]?\s*([^\n]+)/i]);
console.log(noRM); // "123456"
```

---

### `normalizeDate(dateStr)`

Normalize date string ke format ISO (YYYY-MM-DD).

**Supported Formats:**
- `15/06/1985` → `1985-06-15`
- `15-06-1985` → `1985-06-15`
- `1985-06-15` → `1985-06-15` (unchanged)
- `19850615` → `1985-06-15`

**Returns:** string|null

---

## Implementation Checklist

### 1. Module Setup ✓
- [x] `pdfParser.js` created with all functions
- [x] Test suite implemented
- [x] All tests passing (15/15)

### 2. Field Extraction ✓
- [x] No. RM (Nomor Rekam Medis)
- [x] No. Kartu (Nomor Kartu BPJS)
- [x] Nama (Nama Pasien)
- [x] Tgl Lahir (Tanggal Lahir)
- [x] Tgl Masuk (Tanggal Masuk)
- [x] Tgl Keluar (Tanggal Keluar)
- [x] Kelas Rawat (Kelas Rawat)
- [x] Diagnosa (Diagnosa Utama)
- [x] Dokter (Nama Dokter/DPJP)
- [x] Alamat (Alamat Pasien)
- [x] Tgl SEP (Tanggal SEP)
- [x] No. SEP (Nomor SEP)

### 3. Date Normalization ✓
- [x] Support DD/MM/YYYY format
- [x] Support DD-MM-YYYY format
- [x] Support YYYY-MM-DD format
- [x] Support YYYYMMDD format

### 4. Field Validation ✓
- [x] Check required fields
- [x] Format validation for No. Kartu (16 digits expected)
- [x] Format validation for No. SEP (16 digits expected)

### 5. Testing ✓
- [x] Field extraction tests
- [x] Date normalization tests
- [x] Field validation tests
- [x] Module signature tests
- [x] 100% test pass rate

---

## Test Results

```
E-CLAIM PDF PARSER TEST SUITE
============================================================

Test Group 1: Field Extraction
✓ Extract No. RM
✓ Extract No. Kartu
✓ Extract Nama Pasien
✓ Extract Dokter
✓ Extract Alamat

Test Group 2: Date Normalization
✓ Normalize date: 15/06/1985
✓ Normalize date: 15-06-1985
✓ Normalize date: 1985-06-15
✓ Normalize date: 19850615

Test Group 3: Field Validation
✓ Validate complete fields
✓ Validate missing field detection
✓ Validate format warnings

Test Group 4: PDF Parsing
✓ Module exports all functions
✓ parsePDF signature
✓ validateFields signature

============================================================
TEST SUMMARY
Total Tests: 15
Passed: 15
Failed: 0
Success Rate: 100%
============================================================
```

---

## Usage Examples

### Basic PDF Parsing

```javascript
const { parsePDF } = require('./services/pdfParser');

async function parseClaim(filePath) {
  const result = await parsePDF(filePath);

  if (result.success) {
    console.log('Extracted:', result.fields);
    return result.fields;
  } else {
    console.error('Parse failed:', result.errors);
    throw result.errors[0];
  }
}

// Usage
const claimData = await parseClaim('./uploads/DR_GUNAWAN_claim.pdf');
console.log(claimData);
// Output:
// {
//   noRM: '123456',
//   noKartu: '0000123456789012',
//   nama: 'BUDI SANTOSO',
//   tglLahir: '1985-06-15',
//   tglMasuk: '2024-07-10',
//   tglKeluar: '2024-07-14',
//   kelasRawat: '2',
//   diagnosa: 'I10 - Essential hypertension',
//   dokter: 'DR. GUNAWAN HANDOKO',
//   alamat: 'JL MERDEKA NO 123',
//   tglSEP: '2024-07-09',
//   noSEP: '0000123456789010'
// }
```

### Express Route Integration

```javascript
// routes/claimFilePDF.js
const express = require('express');
const multer = require('multer');
const { parsePDF, validateFields } = require('../services/pdfParser');

const router = express.Router();
const upload = multer({ storage: diskStorage });

router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    const result = await parsePDF(req.file.path);

    if (!result.success) {
      return res.status(400).json({
        error: 'PDF parsing failed',
        details: result.errors
      });
    }

    const validation = validateFields(result.fields);

    res.json({
      fields: result.fields,
      valid: validation.valid,
      warnings: validation.warnings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### With Validation & Error Handling

```javascript
const { parsePDF, validateFields } = require('./services/pdfParser');

async function processClaimPDF(filePath) {
  // Parse PDF
  const result = await parsePDF(filePath);

  if (!result.success) {
    throw new Error(`PDF parsing error: ${result.errors[0].message}`);
  }

  // Validate required fields
  const requiredFields = [
    'noRM', 'noKartu', 'nama', 'tglMasuk', 'tglKeluar'
  ];

  const validation = validateFields(result.fields, requiredFields);

  if (!validation.valid) {
    throw new Error(`Missing fields: ${validation.errors.join(', ')}`);
  }

  if (validation.warnings.length > 0) {
    console.warn('Format issues:', validation.warnings);
  }

  return result.fields;
}

// Usage
try {
  const claimData = await processClaimPDF('./uploads/claim.pdf');
  console.log('Success:', claimData);
} catch (error) {
  console.error('Failed:', error.message);
}
```

---

## Notes

### PDF Format Requirements
- **Requirement**: Digital structured PDF dari SIMRS (bukan scan/OCR)
- **Pages**: Extract dari halaman 1-2 (halaman 3+ diabaikan)
- **Format**: Form terstruktur dengan field labels jelas
- **Encoding**: UTF-8 (automatically detected)

### Field Extraction Logic
- Menggunakan regex patterns untuk identify field labels & values
- Case-insensitive matching untuk flexibility
- Multiple patterns per field untuk handle variasi format
- Automatic trimming & cleanup nilai yang diextract

### Date Handling
- Automatically normalize ke format ISO (YYYY-MM-DD)
- Support multiple input formats
- Return `null` jika parsing gagal

### Limitations & Next Steps
- Hanya support halaman 1-2 (3+ ignored)
- Memerlukan PDF digital terstruktur (tidak support OCR/scanned)
- Field extraction bergantung pada consistency label dalam PDF
- Jika label PDF berbeda dari pattern, perlu update regex

### Production Considerations
- [ ] Implement caching untuk frequently parsed PDFs
- [ ] Add logging untuk field extraction success rate
- [ ] Monitor pattern matching hit rate per field
- [ ] Create feedback loop untuk update regex patterns
- [ ] Add metrics tracking untuk PDF parsing performance

---

## Version Info
- Module Version: 1.0.0
- pdf-parse Version: 2.4.5
- Node.js: v14+
- Last Updated: 2024-07-15
