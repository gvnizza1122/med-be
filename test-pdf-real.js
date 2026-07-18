const { parsePDF } = require('./src/services/pdfParser');
const path = require('path');
const fs = require('fs');

const PDF_DIR = path.join(__dirname, '..', 'data-claim', 'data-dari-simrs');

async function testAllPDFs() {
  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
  console.log(`Found ${files.length} PDF files\n`);

  for (const file of files) {
    const filePath = path.join(PDF_DIR, file);
    console.log(`=== ${file} ===`);
    console.log(`Size: ${(fs.statSync(filePath).size / 1024).toFixed(1)} KB`);

    try {
      const result = await parsePDF(filePath);
      console.log(`Success: ${result.success}`);
      console.log(`Pages: ${result.metadata.totalPages}`);
      console.log(`Extracted fields: ${result.metadata.extractedFields}/12`);
      console.log('Fields:');
      for (const [k, v] of Object.entries(result.fields)) {
        console.log(`  ${k}: ${v || '(null)'}`);
      }
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors);
      }
      // Show first 500 chars of raw text for debugging
      if (result.rawText.page1) {
        console.log('\n--- RAW TEXT (first 500 chars) ---');
        console.log(result.rawText.page1.substring(0, 500));
        console.log('--- END ---');
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
    console.log('\n');
  }
}

testAllPDFs();
