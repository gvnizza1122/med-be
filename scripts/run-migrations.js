#!/usr/bin/env node

/**
 * Migration Runner
 *
 * Manually runs SQL migration files from src/database/migrations/
 * Usage: node scripts/run-migrations.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../src/database/init');

const migrationsDir = path.join(__dirname, '../src/database/migrations');
const dryRun = process.argv.includes('--dry-run');

async function main() {
  try {
    console.log('Initializing database...');
    const db = getDb();
    await db.initialize();
    console.log('✓ Database initialized\n');

    // Read migration files
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    console.log(`Found ${files.length} migration file(s):\n`);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`Running: ${file}`);

      if (dryRun) {
        console.log('  [DRY RUN] Would execute:');
        console.log('  ' + sql.substring(0, 100) + '...\n');
      } else {
        try {
          // Execute migration
          // Split by semicolon to handle multiple statements
          const statements = sql.split(';').filter(s => s.trim());

          for (const statement of statements) {
            if (statement.trim()) {
              await db.query(statement);
            }
          }

          console.log('  ✓ Migration completed\n');
        } catch (err) {
          console.error(`  ✗ Migration failed: ${err.message}\n`);
          // Continue to next migration
        }
      }
    }

    console.log('✓ All migrations processed');
    if (dryRun) {
      console.log('  (This was a dry run - no changes were made)');
    }

  } catch (err) {
    console.error('Migration runner failed:', err.message);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
