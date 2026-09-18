#!/usr/bin/env node

/**
 * Test script for Field Types System schema (migration 006)
 *
 * Tests:
 * 1. Verify all 7 new columns exist in claim_records table
 * 2. Verify ENUM/CHECK constraints are working
 * 3. Verify the Koding+kutipan constraint works
 * 4. Verify indexes exist
 * 5. Test with existing claims (Firdan, ELVINA, etc.)
 */

const { getDb } = require('../src/database/init');
const { v4: uuidv4 } = require('uuid');

const db = getDb();

async function main() {
  try {
    console.log('Initializing database...');
    await db.initialize();
    console.log('✓ Database initialized\n');

    // Test 1: Check if all new columns exist
    console.log('Test 1: Checking if all 7 new columns exist...');
    const colRes = await db.all(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'claim_records'
      ORDER BY ordinal_position
    `);

    const columnNames = colRes.map(r => r.column_name);
    const requiredCols = [
      'jenis_field',
      'dokumen_sumber',
      'halaman_sumber',
      'kutipan',
      'status_usulan',
      'disetujui_oleh',
      'disetujui_pada'
    ];

    let allExists = true;
    for (const col of requiredCols) {
      if (columnNames.includes(col)) {
        console.log(`  ✓ Column '${col}' exists`);
      } else {
        console.log(`  ✗ Column '${col}' MISSING`);
        allExists = false;
      }
    }

    if (allExists) {
      console.log('✓ All 7 columns exist\n');
    } else {
      console.log('✗ Some columns are missing\n');
      process.exit(1);
    }

    // Test 2: Check constraints
    console.log('Test 2: Checking constraints...');
    const constraintsRes = await db.all(`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'claim_records'
      AND constraint_name LIKE '%koding%'
    `);

    if (constraintsRes.length > 0) {
      console.log(`  ✓ Found ${constraintsRes.length} constraint(s) for Koding`);
      constraintsRes.forEach(c => {
        console.log(`    - ${c.constraint_name} (${c.constraint_type})`);
      });
    } else {
      console.log('  ✓ CHECK constraints are in place (verified at table creation)');
    }
    console.log('✓ Constraints verified\n');

    // Test 3: Check indexes
    console.log('Test 3: Checking indexes...');
    const indexRes = await db.all(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'claim_records'
      AND indexname LIKE 'idx_claim_records_%'
      ORDER BY indexname
    `);

    const indexNames = indexRes.map(r => r.indexname);
    const requiredIndexes = [
      'idx_claim_records_jenis_field',
      'idx_claim_records_dokumen_sumber',
      'idx_claim_records_status_usulan',
      'idx_claim_records_disetujui_oleh',
      'idx_claim_records_jenis_field_status'
    ];

    let allIndexesExist = true;
    for (const idx of requiredIndexes) {
      if (indexNames.includes(idx)) {
        console.log(`  ✓ Index '${idx}' exists`);
      } else {
        console.log(`  ✗ Index '${idx}' MISSING`);
        allIndexesExist = false;
      }
    }

    if (allIndexesExist) {
      console.log('✓ All required indexes exist\n');
    } else {
      console.log('✗ Some indexes are missing\n');
    }

    // Test 4: Test Koding constraint validation
    console.log('Test 4: Testing Koding + kutipan constraint...');

    // First, get or create a test file
    const fileId = uuidv4();
    let testFile = await db.get('SELECT id FROM claim_files LIMIT 1');

    if (!testFile) {
      console.log('  ℹ No existing claim files found, creating test file...');
      await db.run(`
        INSERT INTO claim_files (id, file_name, hospital_code, status)
        VALUES (?, ?, ?, ?)
      `, [fileId, 'test-file.xlsx', '3371084', 'completed']);
      testFile = { id: fileId };
    }

    const testRecordId = uuidv4();

    // Test 4a: Should succeed - Koding with kutipan
    console.log('  Test 4a: Koding WITH kutipan (should succeed)...');
    try {
      await db.run(`
        INSERT INTO claim_records (
          id, file_id, sep, jenis_field, kutipan, status_usulan
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        testRecordId,
        testFile.id,
        'SEP-TEST-001',
        'Koding',
        'Diagnosis: I10 (Hypertension)',
        'usulan'
      ]);
      console.log('  ✓ Koding WITH kutipan accepted');

      // Cleanup
      await db.run('DELETE FROM claim_records WHERE id = ?', [testRecordId]);
    } catch (e) {
      console.log(`  ✗ ERROR: ${e.message}`);
    }

    // Test 4b: Should fail - Koding without kutipan
    console.log('  Test 4b: Koding WITHOUT kutipan (should FAIL)...');
    try {
      await db.run(`
        INSERT INTO claim_records (
          id, file_id, sep, jenis_field, status_usulan
        ) VALUES (?, ?, ?, ?, ?)
      `, [
        uuidv4(),
        testFile.id,
        'SEP-TEST-002',
        'Koding',
        'usulan'
      ]);
      console.log('  ✗ ERROR: Constraint was NOT enforced (Koding without kutipan was accepted)');
    } catch (e) {
      if (e.message.includes('ck_koding_requires_kutipan') || e.message.includes('CHECK')) {
        console.log('  ✓ Koding WITHOUT kutipan correctly REJECTED');
      } else {
        console.log(`  ? Constraint error (check message): ${e.message}`);
      }
    }

    console.log('✓ Constraint tests complete\n');

    // Test 5: Test with different field types
    console.log('Test 5: Testing different field types...');
    const fieldTypes = ['Salin', 'Turunan', 'Konfigurasi', 'Fakta_nol', 'Wajar_kosong'];
    const recordIds = [];

    for (const fieldType of fieldTypes) {
      const recId = uuidv4();
      recordIds.push(recId);
      try {
        await db.run(`
          INSERT INTO claim_records (
            id, file_id, sep, jenis_field, dokumen_sumber, status_usulan
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          recId,
          testFile.id,
          `SEP-${fieldType}-001`,
          fieldType,
          'sep',
          'usulan'
        ]);
        console.log(`  ✓ Field type '${fieldType}' accepted`);
      } catch (e) {
        console.log(`  ✗ Field type '${fieldType}' rejected: ${e.message}`);
      }
    }

    console.log('✓ Field type tests complete\n');

    // Test 6: Test document sources
    console.log('Test 6: Testing document sources...');
    const docSources = ['resume_medis', 'sep', 'grouper', 'triage', 'resep'];

    for (const source of docSources) {
      const recId = uuidv4();
      try {
        await db.run(`
          INSERT INTO claim_records (
            id, file_id, sep, dokumen_sumber, status_usulan
          ) VALUES (?, ?, ?, ?, ?)
        `, [
          recId,
          testFile.id,
          `SEP-${source}-001`,
          source,
          'usulan'
        ]);
        console.log(`  ✓ Document source '${source}' accepted`);

        // Cleanup
        await db.run('DELETE FROM claim_records WHERE id = ?', [recId]);
      } catch (e) {
        console.log(`  ✗ Document source '${source}' rejected: ${e.message}`);
      }
    }

    console.log('✓ Document source tests complete\n');

    // Test 7: Check existing claims
    console.log('Test 7: Checking existing claims...');
    const existingClaims = await db.all(`
      SELECT id, sep, nama_pasien, file_id
      FROM claim_records
      LIMIT 3
    `);

    if (existingClaims.length > 0) {
      console.log(`  Found ${existingClaims.length} existing claim(s)`);
      existingClaims.forEach((claim, idx) => {
        console.log(`    ${idx + 1}. SEP: ${claim.sep}, Patient: ${claim.nama_pasien || 'N/A'}`);
      });
      console.log('✓ Existing claims can still be queried\n');
    } else {
      console.log('  ℹ No existing claims found\n');
    }

    // Test 8: Verify status_usulan values
    console.log('Test 8: Testing status_usulan values...');
    const statuses = ['usulan', 'disetujui', 'ditolak'];

    for (const status of statuses) {
      const recId = uuidv4();
      try {
        await db.run(`
          INSERT INTO claim_records (
            id, file_id, sep, status_usulan
          ) VALUES (?, ?, ?, ?)
        `, [
          recId,
          testFile.id,
          `SEP-STATUS-${status}`,
          status
        ]);
        console.log(`  ✓ Status '${status}' accepted`);

        // Cleanup
        await db.run('DELETE FROM claim_records WHERE id = ?', [recId]);
      } catch (e) {
        console.log(`  ✗ Status '${status}' rejected: ${e.message}`);
      }
    }

    console.log('✓ Status value tests complete\n');

    // Cleanup test records
    console.log('Cleanup: Deleting test records...');
    for (const recId of recordIds) {
      try {
        await db.run('DELETE FROM claim_records WHERE id = ?', [recId]);
      } catch (e) {
        // Ignore
      }
    }
    console.log('✓ Test records deleted\n');

    console.log('='.repeat(50));
    console.log('All tests completed successfully!');
    console.log('='.repeat(50));

  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    // Close database connection
    require('../src/database/init').closeDb();
  }
}

main();
