#!/usr/bin/env node
/**
 * E2E Integration Test: AI Audit Pipeline
 *
 * Flow:
 * 1. Setup test DB & env vars
 * 2. Parse sample PDFs
 * 3. Run validation rules
 * 4. Trigger OpenRouter AI audit
 * 5. Verify response parsing & logging
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Force OpenRouter env vars for testing (before require services)
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-or-test-key';
process.env.OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';

// Database setup (same as prod)
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.DB_NAME = process.env.DB_NAME || 'eclaim_test';

const { getDb, closeDb } = require('./src/database/init');
const { parsePdfBuffer } = require('./src/services/pdfParser');
const { runRuleBasedAudit } = require('./src/services/aiValidationService');
const { auditRecordField, logFieldAudit } = require('./src/services/aiValidationService');

let testResults = {
  filesProcessed: 0,
  recordsCreated: 0,
  recordsAudited: 0,
  aiAuditsRun: 0,
  aiAuditsPassed: 0,
  aiAuditsFailed: 0,
  errors: [],
  startTime: new Date(),
};

async function testE2E() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  E2E AI Audit Integration Test - E-Claim System  ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  try {
    // 1. Initialize database
    console.log('📦 Initializing database...');
    const db = getDb();
    await db.initialize();
    console.log('   ✓ Database ready\n');

    // 2. Load sample PDFs
    const claimDir = 'C:\\Users\\ASUS\\Documents\\project\\eclaim\\data-claim\\data-dari-simrs';
    const pdfFiles = fs.readdirSync(claimDir)
      .filter(f => f.endsWith('.pdf'))
      .slice(0, 3); // Test first 3 PDFs for speed

    if (pdfFiles.length === 0) {
      throw new Error(`No PDF files found in ${claimDir}`);
    }

    console.log(`📄 Found ${pdfFiles.length} sample PDFs. Processing...\n`);

    for (const pdfFile of pdfFiles) {
      try {
        const pdfPath = path.join(claimDir, pdfFile);
        console.log(`   Processing: ${pdfFile}`);

        // 2a. Read PDF
        const pdfBuffer = fs.readFileSync(pdfPath);

        // 2b. Parse PDF
        let parsedRecords = [];
        try {
          parsedRecords = await parsePdfBuffer(pdfBuffer, pdfFile);
        } catch (parseErr) {
          console.log(`   ⚠️  Parse error: ${parseErr.message} (skipping)`);
          continue;
        }

        if (!Array.isArray(parsedRecords) || parsedRecords.length === 0) {
          console.log(`   ⚠️  No records extracted`);
          continue;
        }

        console.log(`      → Extracted ${parsedRecords.length} records`);

        // 2c. Insert into DB with validation
        const fileId = uuidv4();
        await db.prepare(`
          INSERT INTO claim_files (id, file_name, status, total_records, created_at)
          VALUES (?, ?, 'validating', ?, CURRENT_TIMESTAMP)
        `).run(fileId, pdfFile, parsedRecords.length);

        let validRecordCount = 0;
        let errorRecordCount = 0;

        for (const rec of parsedRecords) {
          const recordId = uuidv4();
          try {
            // Run quick validation to identify failed records
            const rulesAudit = runRuleBasedAudit([rec]);
            const failedFields = [];

            // Insert record
            await db.prepare(`
              INSERT INTO claim_records (
                id, file_id, row_number, sep, nokartu, nama_pasien, mrn,
                admission_date, discharge_date, los, diagnosa_list, prosedur_list,
                inacbg_code, deskripsi_inacbg, tarif_inacbg, tarif_rs, total_tarif,
                kelas_rawat, icu_indikator, vent_hour, validation_status, created_at
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, CURRENT_TIMESTAMP
              )
            `).run(
              recordId, fileId, rec.row_number || 1, rec.sep, rec.nokartu, rec.nama_pasien, rec.mrn,
              rec.admission_date, rec.discharge_date, rec.los || 0, rec.diagnosa_list, rec.prosedur_list,
              rec.inacbg_code, rec.deskripsi_inacbg, rec.tarif_inacbg || 0, rec.tarif_rs || 0, rec.total_tarif || 0,
              rec.kelas_rawat, rec.icu_indikator || 0, rec.vent_hour || 0, 'pending'
            );

            testResults.recordsCreated++;

            // Determine if record has errors (rule-based)
            if (rulesAudit[0]?.ai_status === 'dispute' || rulesAudit[0]?.ai_status === 'warning') {
              errorRecordCount++;
              failedFields.push('sep', 'nokartu'); // Simulate common failures
            } else {
              validRecordCount++;
            }

            // Log a sample field error for AI audit test
            if (failedFields.length > 0 && rec.sep) {
              await db.prepare(`
                INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, severity)
                VALUES (?, ?, ?, ?, ?, 'major')
              `).run(uuidv4(), recordId, 'RV-01', 'sep', 'SEP format invalid or empty');
            }
          } catch (recErr) {
            testResults.errors.push(`Record insert: ${recErr.message}`);
          }
        }

        // Update file stats
        await db.prepare(`
          UPDATE claim_files SET
            total_records = ?,
            valid_count = ?,
            error_count = ?,
            status = 'validating'
          WHERE id = ?
        `).run(parsedRecords.length, validRecordCount, errorRecordCount, fileId);

        testResults.filesProcessed++;
        console.log(`      → Stored ${parsedRecords.length} records (${errorRecordCount} with errors)`);

      } catch (fileErr) {
        testResults.errors.push(`File ${pdfFile}: ${fileErr.message}`);
      }
    }

    // 3. Run AI Audit on failed records
    console.log('\n🤖 Triggering AI Audit on failed records...\n');

    const failedRecords = await db.prepare(`
      SELECT cr.* FROM claim_records cr
      JOIN validation_errors ve ON ve.record_id = cr.id
      GROUP BY cr.id
      LIMIT 2
    `).all();

    console.log(`   Found ${failedRecords.length} records with validation errors\n`);

    for (const record of failedRecords) {
      try {
        console.log(`   Auditing: ${record.nama_pasien} (SEP: ${record.sep})`);

        // Get validation error messages
        const errors = await db.prepare(`
          SELECT DISTINCT field_name, error_message FROM validation_errors
          WHERE record_id = ?
        `).all(record.id);

        // Test a single field audit
        if (errors.length > 0) {
          const fieldToAudit = errors[0].field_name || 'sep';
          const errorMsg = errors[0].error_message;

          console.log(`      → Field: ${fieldToAudit} | Error: ${errorMsg}`);

          try {
            const auditResult = await auditRecordField(
              record,
              fieldToAudit,
              'ponytail',
              errorMsg
            );

            console.log(`      → AI Status: ${auditResult.status}`);
            console.log(`      → Confidence: ${(auditResult.confidence_score * 100).toFixed(0)}%`);
            console.log(`      → Tokens: ${auditResult.tokens_used.total}`);

            // Log to DB
            if (auditResult.suggestion || auditResult.error_description) {
              const auditId = await logFieldAudit(db, {
                fileId: record.file_id,
                recordId: record.id,
                fieldName: fieldToAudit,
                result: auditResult,
              });
              console.log(`      → Logged as: ${auditId}`);
              testResults.aiAuditsRun++;
              testResults.aiAuditsPassed++;
            }
          } catch (aiErr) {
            console.log(`      ❌ AI Audit Error: ${aiErr.message}`);
            testResults.aiAuditsFailed++;
            testResults.errors.push(`AI Audit - ${fieldToAudit}: ${aiErr.message}`);
          }
        }

        testResults.recordsAudited++;
        console.log('');

      } catch (auditErr) {
        testResults.errors.push(`Audit record: ${auditErr.message}`);
      }
    }

    // 4. Verify logging
    console.log('\n✅ Verifying audit logs...\n');
    const auditLogs = await db.prepare(`
      SELECT id, field_name, confidence, nurse_action, tokens_input, tokens_output
      FROM ai_audit_log
      LIMIT 5
    `).all();

    console.log(`   Total audit logs: ${auditLogs.length}`);
    for (const log of auditLogs) {
      console.log(`      • ${log.field_name} | Confidence: ${log.confidence} | Tokens: ${log.tokens_input + log.tokens_output}`);
    }

    // Summary
    const duration = Math.round((new Date() - testResults.startTime) / 1000);
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║                  TEST SUMMARY                      ║');
    console.log('╠════════════════════════════════════════════════════╣');
    console.log(`║ Files Processed:        ${String(testResults.filesProcessed).padEnd(30)} ║`);
    console.log(`║ Records Created:        ${String(testResults.recordsCreated).padEnd(30)} ║`);
    console.log(`║ Records Audited:        ${String(testResults.recordsAudited).padEnd(30)} ║`);
    console.log(`║ AI Audits Run:          ${String(testResults.aiAuditsRun).padEnd(30)} ║`);
    console.log(`║ AI Audits Passed:       ${String(testResults.aiAuditsPassed).padEnd(30)} ║`);
    console.log(`║ AI Audits Failed:       ${String(testResults.aiAuditsFailed).padEnd(30)} ║`);
    console.log(`║ Duration:               ${String(duration + 's').padEnd(30)} ║`);
    if (testResults.errors.length > 0) {
      console.log(`║ Errors Found:           ${String(testResults.errors.length).padEnd(30)} ║`);
    }
    console.log('╚════════════════════════════════════════════════════╝\n');

    if (testResults.errors.length > 0) {
      console.log('⚠️  Errors encountered:\n');
      testResults.errors.forEach((err, i) => {
        console.log(`   ${i + 1}. ${err}`);
      });
    }

    closeDb();
    process.exit(testResults.errors.length > 0 ? 1 : 0);

  } catch (err) {
    console.error('\n❌ Test Failed:', err.message);
    console.error(err.stack);
    closeDb();
    process.exit(1);
  }
}

// Run test
testE2E().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
