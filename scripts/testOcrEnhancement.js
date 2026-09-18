#!/usr/bin/env node

/**
 * Test OCR Enhancement Pipeline
 *
 * Usage:
 *   node scripts/testOcrEnhancement.js /path/to/pdf
 *   node scripts/testOcrEnhancement.js /path/to/pdf --verbose
 *   node scripts/testOcrEnhancement.js /path/to/pdf --high-detail
 */

const path = require('path');
const fs = require('fs');
const { enhancedOcrExtraction, classifyPageContent, validateVitalSigns } = require('../src/services/ocrEnhancement');
const { extractFromPDF } = require('../src/services/pdfExtractionPipeline');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node testOcrEnhancement.js <pdf-path> [--verbose] [--high-detail]');
    process.exit(1);
  }

  const pdfPath = args[0];
  const verbose = args.includes('--verbose');
  const highDetail = args.includes('--high-detail');

  if (!fs.existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`);
    process.exit(1);
  }

  console.log('\n');
  console.log('='.repeat(70));
  console.log('OCR ENHANCEMENT TEST');
  console.log('='.repeat(70));
  console.log(`PDF: ${path.basename(pdfPath)}`);
  console.log(`Size: ${(fs.statSync(pdfPath).size / 1024).toFixed(1)} KB`);
  console.log(`High Detail Mode: ${highDetail ? 'YES (5.0 scale)' : 'NO (4.0 scale)'}`);
  console.log('-'.repeat(70));

  try {
    // Test 1: Enhanced OCR Extraction
    console.log('\n[TEST 1] Enhanced OCR Extraction (Multi-pass)\n');
    const startTime = Date.now();
    const ocrResult = await enhancedOcrExtraction(pdfPath);
    const ocrDuration = Date.now() - startTime;

    console.log(`✓ Processing completed in ${ocrDuration}ms`);
    console.log(`  - Pages processed: ${ocrResult.pass1_general_ocr.pages.length}`);
    console.log(`  - Errors encountered: ${ocrResult.pass1_general_ocr.errors.length}`);

    // Test 2: Vital Signs Extraction
    if (ocrResult.pass2_clinical_extraction) {
      console.log('\n[TEST 2] Vital Signs Extraction\n');
      const vitalSigns = ocrResult.pass2_clinical_extraction.vital_signs;

      if (Object.keys(vitalSigns).length > 0) {
        console.log('✓ Vital signs detected:');
        for (const [field, data] of Object.entries(vitalSigns)) {
          console.log(`  - ${field}: ${data.value} (page ${data.page}, confidence: high)`);
          if (verbose) {
            console.log(`    Raw match: "${data.raw_match}"`);
          }
        }
      } else {
        console.log('✗ No vital signs detected');
      }
    }

    // Test 3: Clinical Findings
    if (ocrResult.pass2_clinical_extraction) {
      console.log('\n[TEST 3] Clinical Findings Extraction\n');
      const findings = ocrResult.pass2_clinical_extraction.clinical_findings;

      if (Object.keys(findings).filter(k => findings[k]).length > 0) {
        console.log('✓ Clinical findings detected:');
        for (const [finding, found] of Object.entries(findings)) {
          if (found) {
            console.log(`  - ${finding}: YES`);
          }
        }
      } else {
        console.log('✗ No clinical findings detected');
      }
    }

    // Test 4: Validation
    if (ocrResult.vital_signs_validated) {
      console.log('\n[TEST 4] Vital Signs Validation\n');
      const validation = ocrResult.vital_signs_validated;

      console.log(`Valid: ${validation.valid ? '✓ YES' : '✗ NO'}`);

      if (validation.warnings.length > 0) {
        console.log('\nWarnings:');
        validation.warnings.forEach(w => console.log(`  ⚠ ${w}`));
      }

      if (validation.errors.length > 0) {
        console.log('\nErrors:');
        validation.errors.forEach(e => console.log(`  ✗ ${e}`));
      }

      if (verbose && Object.keys(validation.validated_values).length > 0) {
        console.log('\nValidated values:');
        for (const [field, value] of Object.entries(validation.validated_values)) {
          console.log(`  - ${field}: ${value}`);
        }
      }
    }

    // Test 5: Page Classifications
    if (ocrResult.page_classifications && ocrResult.page_classifications.length > 0) {
      console.log('\n[TEST 5] Page Classification\n');

      const classifications = {};
      ocrResult.page_classifications.forEach(pc => {
        const type = pc.classification.type || 'general';
        classifications[type] = (classifications[type] || 0) + 1;
      });

      console.log('✓ Pages classified:');
      for (const [type, count] of Object.entries(classifications)) {
        console.log(`  - ${type}: ${count} page(s)`);
      }

      if (verbose) {
        console.log('\nDetailed classifications:');
        ocrResult.page_classifications.forEach(pc => {
          console.log(`  Page ${pc.page_number}: ${pc.classification.type}`);
          if (pc.classification.keywords_found.length > 0) {
            console.log(`    Keywords: ${pc.classification.keywords_found.join(', ')}`);
          }
        });
      }
    }

    // Test 6: Full Pipeline Integration
    console.log('\n[TEST 6] Full Pipeline Integration Test\n');
    const pipelineStartTime = Date.now();
    const pipelineResult = await extractFromPDF(pdfPath);
    const pipelineDuration = Date.now() - pipelineStartTime;

    console.log(`✓ Full extraction completed in ${pipelineDuration}ms`);
    console.log(`  - Success: ${pipelineResult.success ? 'YES' : 'NO'}`);
    console.log(`  - Pages processed: ${pipelineResult.metadata.pagesProcessed}`);
    console.log(`  - OCR Enhancement applied: ${pipelineResult.metadata.ocrEnhancementApplied ? 'YES' : 'NO'}`);

    if (pipelineResult.record) {
      console.log(`  - Record extracted: YES`);
      if (pipelineResult.record._ocr_vital_signs_detected) {
        console.log(`    - Vital signs from OCR: ${Object.keys(pipelineResult.record._ocr_vital_signs_detected).length} detected`);
      }
      if (pipelineResult.record._ocr_clinical_findings) {
        console.log(`    - Clinical findings from OCR: ${pipelineResult.record._ocr_clinical_findings.join(', ') || 'none'}`);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    console.log(`\nOverall Success: ${ocrResult.success && pipelineResult.success ? '✓ YES' : '✗ NO'}`);
    console.log(`Processing Time: ${ocrDuration}ms (OCR) + ${pipelineDuration}ms (Pipeline)`);
    console.log(`Vital Signs Found: ${Object.keys(ocrResult.pass2_clinical_extraction?.vital_signs || {}).length}`);
    console.log(`Clinical Findings Found: ${ocrResult.clinical_findings_validated?.found?.length || 0}`);

    if (!ocrResult.success || ocrResult.errors.length > 0) {
      console.log('\nErrors:');
      ocrResult.errors.forEach(e => console.log(`  - ${e}`));
    }

    console.log('\n');

  } catch (error) {
    console.error('\n✗ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
