#!/usr/bin/env node
/**
 * Manual test script for AI provider configuration
 * Extracts a real PDF to verify configuration is correct
 *
 * Usage: node test-ai-config.js [pdf-path]
 *
 * Environment variables required:
 * - AI_PROVIDER_API_KEY (your OpenAI API key from platform.openai.com)
 * - AI_PROVIDER_BASE_URL (default: https://api.openai.com/v1)
 * - AI_MODEL (default: gpt-4o-mini)
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { extractFromPDF } = require('../../services/pdfExtractionPipeline');

// Color output for terminal
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function print(color, text) {
  console.log(`${colors[color] || ''}${text}${colors.reset}`);
}

async function main() {
  // Find default PDF or use provided path
  let pdfPath = process.argv[2];

  if (!pdfPath) {
    // Look for first PDF in data-claim/data-dari-simrs
    const dataDir = path.join(__dirname, '../../../data-claim/data-dari-simrs');
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir).filter(f => f.toLowerCase().endsWith('.pdf'));
      if (files.length > 0) {
        pdfPath = path.join(dataDir, files[0]);
      }
    }
  }

  if (!pdfPath) {
    print('red', '❌ Error: No PDF file found or provided');
    print('yellow', 'Usage: node test-ai-config.js [path-to-pdf]');
    process.exit(1);
  }

  if (!fs.existsSync(pdfPath)) {
    print('red', `❌ Error: PDF not found at ${pdfPath}`);
    process.exit(1);
  }

  print('cyan', '═══════════════════════════════════════');
  print('cyan', 'AI Provider Configuration Test');
  print('cyan', '═══════════════════════════════════════');
  print('', '');

  // Check configuration
  print('blue', '📋 Configuration Status:');
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  const hasKey = apiKey && apiKey.trim() !== '';
  print(hasKey ? 'green' : 'red', `  ${hasKey ? '✅' : '❌'} API Key: ${hasKey ? 'configured' : 'MISSING'}`);
  print('blue', `  ✓ Base URL: ${baseUrl}`);
  print('blue', `  ✓ Model: ${model}`);
  print('', '');

  if (!hasKey) {
    print('red', '❌ Configuration incomplete!');
    print('yellow', '\n📌 To fix:');
    print('yellow', '  1. Get your API key from https://platform.openai.com/api-keys');
    print('yellow', '  2. Add to be/.env: AI_PROVIDER_API_KEY=sk_test_...');
    print('yellow', '  3. Re-run this test');
    process.exit(1);
  }

  // Run extraction
  print('blue', '🔄 Testing PDF extraction...');
  print('blue', `   File: ${path.basename(pdfPath)}`);
  print('', '');

  try {
    const startTime = Date.now();
    const result = await extractFromPDF(pdfPath);
    const duration = Date.now() - startTime;

    if (result.success) {
      print('green', '✅ SUCCESS: PDF extraction worked!');
      print('', '');
      print('blue', '📊 Extraction Results:');
      print('blue', `  ✓ Processing time: ${duration}ms`);
      print('blue', `  ✓ Pages processed: ${result.metadata.pagesProcessed}`);
      print('blue', `  ✓ Claim data found: ${result.metadata.claimDataPagesFound} page(s)`);
      print('blue', `  ✓ Tokens used: ${result.tokens.total} (prompt: ${result.tokens.prompt}, completion: ${result.tokens.completion})`);
      print('blue', `  ✓ Attempts: ${result.attempts}`);
      print('', '');

      if (result.record) {
        print('blue', '📄 Sample extracted fields:');
        const fields = [
          'nama_pasien', 'sep', 'diagnosa_list', 'prosedur_list',
          'los', 'tarif_rs', 'tarif_inacbg', 'kelas_rawat'
        ];
        fields.forEach(field => {
          const value = result.record[field] || '(kosong)';
          print('blue', `  • ${field}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
        });
        print('', '');
      }

      print('green', '✅ Configuration is correct and working!');
      print('', '');
      print('cyan', '═══════════════════════════════════════');
      print('yellow', '✨ Ready for production use');
      print('cyan', '═══════════════════════════════════════');
    } else {
      print('red', '❌ EXTRACTION FAILED');
      print('red', `   Message: ${result.pesan}`);
      print('', '');
      if (result.errors.length > 0) {
        print('red', '   Technical details (for debugging):');
        result.errors.forEach(err => {
          print('red', `   • ${err}`);
        });
      }
      process.exit(1);
    }
  } catch (error) {
    print('red', '❌ ERROR during extraction:');
    print('red', `   ${error.message}`);
    print('', '');
    if (error.stack) {
      print('yellow', 'Stack trace:');
      console.log(error.stack);
    }
    process.exit(1);
  }
}

main().catch(err => {
  print('red', `❌ Fatal error: ${err.message}`);
  process.exit(1);
});
