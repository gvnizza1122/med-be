/**
 * PDF Parser Usage Example
 * Contoh penggunaan pdfParser untuk extract field dari PDF SIMRS
 */

const { parsePDF, validateFields } = require('./pdfParser');
const path = require('path');

/**
 * Example 1: Parse PDF dan extract field
 */
async function exampleBasicParsing() {
  console.log('=== Example 1: Basic PDF Parsing ===\n');

  try {
    // Path ke PDF file
    const pdfPath = path.join(__dirname, '../../uploads/sample_simrs.pdf');

    // Parse PDF
    const result = await parsePDF(pdfPath);

    if (result.success) {
      console.log('✓ PDF berhasil diparse');
      console.log('\nExtracted Fields:');
      console.log(JSON.stringify(result.fields, null, 2));

      console.log('\nMetadata:');
      console.log(`- Total Pages: ${result.metadata.totalPages}`);
      console.log(`- Processed Pages: ${result.metadata.procesedPages}`);
      console.log(`- Extracted Fields: ${result.metadata.extractedFields}`);
    } else {
      console.log('✗ PDF parsing failed');
      console.log('Errors:', result.errors);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Example 2: Parse dan validate field
 */
async function exampleWithValidation() {
  console.log('\n=== Example 2: PDF Parsing with Validation ===\n');

  try {
    const pdfPath = path.join(__dirname, '../../uploads/sample_simrs.pdf');
    const result = await parsePDF(pdfPath);

    if (result.success) {
      // Validate extracted fields
      const requiredFields = ['noRM', 'noKartu', 'nama', 'tglMasuk', 'tglKeluar'];
      const validation = validateFields(result.fields, requiredFields);

      console.log('Validation Result:');
      console.log(`- Valid: ${validation.valid}`);

      if (!validation.valid) {
        console.log('\nErrors:');
        validation.errors.forEach((err) => {
          console.log(`  ✗ ${err}`);
        });
      }

      if (validation.warnings.length > 0) {
        console.log('\nWarnings:');
        validation.warnings.forEach((warn) => {
          console.log(`  ⚠ ${warn}`);
        });
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

/**
 * Example 3: Integration dengan Express route
 */
async function exampleExpressIntegration() {
  console.log('\n=== Example 3: Express Route Integration ===\n');

  const code = `
// File: be/src/routes/claimFilePDF.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { parsePDF, validateFields } = require('../services/pdfParser');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads'),
  filename: (req, file, cb) => {
    const uniqueName = \`\${Date.now()}-\${uuidv4().substring(0, 8)}-\${file.originalname}\`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('Hanya file PDF yang diperbolehkan.'));
    }
  }
});

/**
 * POST /api/v1/claim-pdf/parse
 * Upload dan parse PDF SIMRS
 */
router.post('/parse', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File tidak ditemukan.' });
    }

    // Parse PDF
    const parseResult = await parsePDF(req.file.path);

    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        errors: parseResult.errors
      });
    }

    // Validate extracted fields
    const validation = validateFields(parseResult.fields, [
      'noRM', 'noKartu', 'nama', 'tglMasuk', 'tglKeluar'
    ]);

    res.json({
      success: true,
      fields: parseResult.fields,
      validation: {
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings
      },
      metadata: parseResult.metadata
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
`;

  console.log(code);
}

/**
 * Example 4: Response format
 */
async function exampleResponseFormat() {
  console.log('\n=== Example 4: Response Format ===\n');

  const sampleResponse = {
    success: true,
    fields: {
      noRM: '123456',
      noKartu: '0000123456789012',
      nama: 'BUDI SANTOSO',
      tglLahir: '1985-06-15',
      tglMasuk: '2024-07-10',
      tglKeluar: '2024-07-14',
      kelasRawat: '2',
      diagnosa: 'I10 - Essential (primary) hypertension',
      dokter: 'DR. GUNAWAN HANDOKO, SP.U',
      alamat: 'JL MERDEKA NO 123, BATANG',
      tglSEP: '2024-07-09',
      noSEP: '0000123456789010',
    },
    validation: {
      valid: true,
      errors: [],
      warnings: []
    },
    metadata: {
      totalPages: 2,
      procesedPages: 2,
      extractedFields: 12,
      encoding: 'utf-8'
    }
  };

  console.log(JSON.stringify(sampleResponse, null, 2));
}

/**
 * Example 5: Error handling
 */
async function exampleErrorHandling() {
  console.log('\n=== Example 5: Error Handling ===\n');

  const code = `
async function safeParsePDF(filePath) {
  try {
    const result = await parsePDF(filePath);

    if (!result.success) {
      // Handle parsing error
      console.error('Parse errors:', result.errors);
      return { success: false, error: result.errors[0]?.message };
    }

    // Check if all required fields are present
    const requiredFields = ['noRM', 'noKartu', 'nama'];
    const missingFields = requiredFields.filter(
      field => !result.fields[field]
    );

    if (missingFields.length > 0) {
      console.warn('Missing fields:', missingFields);
      return {
        success: false,
        error: \`Field tidak ditemukan: \${missingFields.join(', ')}\`,
        fields: result.fields
      };
    }

    // Validate field formats
    const validation = validateFields(result.fields, requiredFields);
    if (!validation.valid) {
      return {
        success: false,
        error: 'Field validation failed',
        errors: validation.errors,
        warnings: validation.warnings,
        fields: result.fields
      };
    }

    return { success: true, fields: result.fields };
  } catch (error) {
    console.error('Unexpected error:', error);
    return { success: false, error: error.message };
  }
}
`;

  console.log(code);
}

// Run examples
async function runAllExamples() {
  await exampleBasicParsing();
  await exampleWithValidation();
  exampleExpressIntegration();
  exampleResponseFormat();
  exampleErrorHandling();
}

// Export for use in other modules
module.exports = {
  exampleBasicParsing,
  exampleWithValidation,
  exampleExpressIntegration,
  exampleResponseFormat,
  exampleErrorHandling
};

// Run if executed directly
if (require.main === module) {
  runAllExamples().catch(console.error);
}
