#!/usr/bin/env node
/**
 * Manual test script for audit suggestions endpoint
 * Tests the Tahap 4 AI semantic matching with anti-upcoding validation
 *
 * Usage: node test-audit-suggestions.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getDb } = require('../../database/init');
const { generateAuditSuggestions } = require('../../services/auditSuggestionsService');

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
  print('cyan', '═══════════════════════════════════════');
  print('cyan', 'Tahap 4 — Audit Suggestions Test');
  print('cyan', '═══════════════════════════════════════');
  print('', '');

  // Check API config
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  print('blue', '📋 Configuration:');
  const hasKey = apiKey && apiKey.trim() !== '';
  print(hasKey ? 'green' : 'yellow', `  ${hasKey ? '✅' : '⚠️'} API Key: ${hasKey ? 'configured' : 'MISSING (will skip)'}`);
  print('blue', `  ✓ Base URL: ${baseUrl}`);
  print('blue', `  ✓ Model: ${model}`);
  print('', '');

  if (!hasKey) {
    print('yellow', '⏭️ Skipping test — API key not configured');
    print('yellow', 'To enable: fill AI_PROVIDER_API_KEY in be/.env');
    process.exit(0);
  }

  // Get database and find a record with OCR
  print('blue', '🔍 Finding test record with OCR results...');
  const db = getDb();

  const record = await db.prepare(`
    SELECT c.id, c.diagnosa_list, c.prosedur_list, COUNT(o.id) as ocr_count
    FROM claim_records c
    LEFT JOIN ocr_results o ON c.id = o.record_id
    GROUP BY c.id
    HAVING ocr_count > 0
    LIMIT 1
  `).get();

  if (!record) {
    print('red', '❌ No record with OCR results found');
    print('yellow', 'Hint: Upload a PDF and run OCR first');
    process.exit(1);
  }

  print('green', `✓ Found record: ${record.id}`);
  print('blue', `  DIAGLIST: ${record.diagnosa_list || '(kosong)'}`);
  print('blue', `  PROCLIST: ${record.prosedur_list || '(kosong)'}`);
  print('blue', `  OCR pages: ${record.ocr_count}`);
  print('', '');

  // Get OCR results
  const ocrResults = await db.prepare(`
    SELECT page_number, ocr_text, confidence
    FROM ocr_results
    WHERE id = ?
    ORDER BY page_number ASC
  `).all(record.id);

  if (ocrResults.length === 0) {
    print('red', '❌ No OCR results found (database inconsistency)');
    process.exit(1);
  }

  print('blue', '📄 OCR Results Summary:');
  for (const ocr of ocrResults) {
    const textLen = (ocr.ocr_text || '').length;
    print('blue', `  Halaman ${ocr.page_number}: ${textLen} chars @ ${ocr.confidence || 0}% confidence`);
  }
  print('', '');

  // Call audit suggestions
  print('blue', '🤖 Calling AI audit suggestions...');
  const startTime = Date.now();

  try {
    const suggestions = await generateAuditSuggestions(record, ocrResults);
    const duration = Date.now() - startTime;

    if (suggestions.errors && suggestions.errors.length > 0) {
      print('yellow', `⚠️ Errors during processing:`);
      suggestions.errors.forEach(err => print('yellow', `  • ${err}`));
      print('', '');
    }

    print('green', `✅ Audit suggestions generated in ${duration}ms`);
    print('', '');

    if (!suggestions.available) {
      print('yellow', `Message: ${suggestions.message}`);
      process.exit(0);
    }

    print('blue', '📊 Results:');
    print('', '');

    if (suggestions.claimed_evidence && suggestions.claimed_evidence.length > 0) {
      print('blue', 'KODE YANG DIKLAIM:');
      suggestions.claimed_evidence.forEach(ev => {
        if (ev.found) {
          print('green', `  ✓ ${ev.code} (Halaman ${ev.page_number})`);
          print('blue', `    Kutipan: "${ev.quotation.substring(0, 80)}${ev.quotation.length > 80 ? '...' : ''}"`);
        } else {
          print('yellow', `  ✗ ${ev.code} (Tidak ada bukti)`);
        }
      });
      print('', '');
    }

    if (suggestions.suggested_codes && suggestions.suggested_codes.length > 0) {
      print('blue', 'SARAN KODE TAMBAHAN:');
      suggestions.suggested_codes.forEach(sg => {
        print('cyan', `  💡 ${sg.code} (Halaman ${sg.page_number})`);
        print('blue', `    Kutipan: "${sg.quotation.substring(0, 80)}${sg.quotation.length > 80 ? '...' : ''}"`);
        print('blue', `    Alasan: ${sg.reasoning.substring(0, 60)}${sg.reasoning.length > 60 ? '...' : ''}`);
      });
      print('', '');
    }

    if ((!suggestions.claimed_evidence || suggestions.claimed_evidence.length === 0) &&
        (!suggestions.suggested_codes || suggestions.suggested_codes.length === 0)) {
      print('yellow', '(Tidak ada hasil atau semua di-filter karena validasi)');
      print('', '');
    }

    print('blue', `📈 Tokens used: ${suggestions.tokens_used}`);
    print('', '');

    print('green', '✅ Test completed successfully');
    print('', '');
    print('cyan', '═══════════════════════════════════════');
    print('green', '✨ Audit suggestions endpoint ready');
    print('cyan', '═══════════════════════════════════════');

  } catch (error) {
    print('red', `❌ Error: ${error.message}`);
    if (error.stack) {
      console.log(error.stack);
    }
    process.exit(1);
  }
}

main().catch(err => {
  print('red', `Fatal error: ${err.message}`);
  process.exit(1);
});
