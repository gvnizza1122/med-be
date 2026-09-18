# Field Types System (6 Field Types) - Database Schema

## Overview

The Field Types System introduces a comprehensive tracking mechanism for claim record fields, categorizing them into 6 distinct types and tracking their sources, approval workflows, and field-level data integrity.

**Implementation Date**: 18 September 2026  
**Migration**: `006-field-types-system.sql`  
**Backward Compatible**: Yes - All new columns are nullable

## New Columns Added to `claim_records` Table

### 1. `jenis_field` (VARCHAR(50), NULLABLE)
**Field Type Category** - Categorizes the nature of the field value

**Allowed Values:**
- `Salin` - Directly copied from source document (e.g., OCR output, manual entry)
- `Turunan` - Derived from other fields (e.g., calculated, transformed)
- `Konfigurasi` - Configuration/system-level value
- `Koding` - Coded value (diagnostic code, procedure code, etc.)
- `Fakta_nol` - Zero/null value that is fact-based (legitimate empty data)
- `Wajar_kosong` - Appropriately empty value (expected to be NULL for this claim type)

**Example Usage:**
```sql
UPDATE claim_records 
SET jenis_field = 'Koding' 
WHERE inacbg_code IS NOT NULL;

UPDATE claim_records 
SET jenis_field = 'Turunan' 
WHERE los = (discharge_date - admission_date);
```

### 2. `dokumen_sumber` (VARCHAR(100), NULLABLE)
**Source Document Type** - Indicates which document type the field value originates from

**Allowed Values:**
- `resume_medis` - Medical summary/clinical notes
- `sep` - SEP (Surat Eligibilitas Peserta) - BPJS eligibility letter
- `grouper` - Grouper/coding system output
- `triage` - Triage assessment document
- `resep` - Prescription document

**Example Usage:**
```sql
UPDATE claim_records 
SET dokumen_sumber = 'sep' 
WHERE sep IS NOT NULL;

-- Track fields by source document
SELECT dokumen_sumber, COUNT(*) as count
FROM claim_records
WHERE dokumen_sumber IS NOT NULL
GROUP BY dokumen_sumber;
```

### 3. `halaman_sumber` (INTEGER, NULLABLE)
**Source Page Number** - Page number in the source document where the field value was found

**Example Usage:**
```sql
-- Find fields from page 2 of SEP documents
SELECT * FROM claim_records
WHERE dokumen_sumber = 'sep' AND halaman_sumber = 2;
```

### 4. `kutipan` (TEXT, NULLABLE)
**Direct Quote/Citation** - Verbatim text excerpt from source document supporting the field value

**Constraints:**
- **REQUIRED** when `jenis_field = 'Koding'` (Coded values MUST have source citation)
- Optional for other field types

**Example Usage:**
```sql
-- Koding fields MUST have kutipan (direct quote)
INSERT INTO claim_records (..., jenis_field, kutipan, ...)
VALUES (..., 'Koding', 'Diagnosis: Hipertension Essensial (I10)', ...);

-- This will FAIL (constraint violation):
INSERT INTO claim_records (..., jenis_field, kutipan, ...)
VALUES (..., 'Koding', NULL, ...);  -- ERROR: ck_koding_requires_kutipan

-- Other field types can have NULL kutipan
INSERT INTO claim_records (..., jenis_field, kutipan, ...)
VALUES (..., 'Turunan', NULL, ...);  -- OK
```

### 5. `status_usulan` (VARCHAR(50), NULLABLE)
**Suggestion/Proposal Status** - Tracks the approval state of field-level suggestions or changes

**Allowed Values:**
- `usulan` - Proposed/pending approval (default)
- `disetujui` - Approved/accepted
- `ditolak` - Rejected/not approved

**Workflow:**
```
usulan (proposal) → [review process] → disetujui (approved) or ditolak (rejected)
```

**Example Usage:**
```sql
-- Track pending field modifications
SELECT sep, COUNT(*) as pending_changes
FROM claim_records
WHERE status_usulan = 'usulan'
GROUP BY sep;

-- Find approved changes
SELECT * FROM claim_records
WHERE status_usulan = 'disetujui'
AND disetujui_pada >= NOW() - INTERVAL '7 days';
```

### 6. `disetujui_oleh` (TEXT REFERENCES users(id), NULLABLE)
**Approved By** - User ID of the person who approved the field suggestion

**Relationship:** References `users(id)` table  
**On Delete:** SET NULL (if user is deleted, approval record remains but user reference is cleared)

**Example Usage:**
```sql
-- Find who approved which changes
SELECT cr.sep, cr.jenis_field, cr.status_usulan, u.full_name, cr.disetujui_pada
FROM claim_records cr
LEFT JOIN users u ON cr.disetujui_oleh = u.id
WHERE cr.status_usulan = 'disetujui'
ORDER BY cr.disetujui_pada DESC;
```

### 7. `disetujui_pada` (TIMESTAMP, NULLABLE)
**Approved At** - Timestamp when the field suggestion was approved

**Example Usage:**
```sql
-- Find recent approvals (last 24 hours)
SELECT * FROM claim_records
WHERE disetujui_pada >= NOW() - INTERVAL '1 day'
AND status_usulan = 'disetujui';

-- Approval SLA monitoring
SELECT 
  DATE(status_usulan_created) as proposal_date,
  COUNT(*) as total_proposals,
  COUNT(CASE WHEN status_usulan = 'disetujui' THEN 1 END) as approved,
  AVG(EXTRACT(EPOCH FROM (disetujui_pada - status_usulan_created)) / 3600) as avg_approval_hours
FROM claim_records
WHERE status_usulan IN ('disetujui', 'ditolak')
GROUP BY DATE(status_usulan_created)
ORDER BY proposal_date DESC;
```

## Database Constraint

### `ck_koding_requires_kutipan` CHECK Constraint

```sql
CONSTRAINT ck_koding_requires_kutipan 
CHECK (NOT (jenis_field = 'Koding' AND kutipan IS NULL))
```

**Purpose:** Ensures data integrity for coded values - all coding decisions must have source documentation (citations).

**Enforcement:**
- Applied at database level (PostgreSQL CHECK constraint)
- Prevents insert/update if `jenis_field='Koding'` AND `kutipan IS NULL`
- Error: `new row for relation "claim_records" violates check constraint "ck_koding_requires_kutipan"`

**Rationale:** Coded values (diagnosis codes, procedure codes, etc.) are critical clinical decisions that must be traceable to their source documents for audit and compliance purposes.

## Indexes

5 new indexes created for performance optimization:

```sql
CREATE INDEX idx_claim_records_jenis_field 
  ON claim_records(jenis_field);

CREATE INDEX idx_claim_records_dokumen_sumber 
  ON claim_records(dokumen_sumber);

CREATE INDEX idx_claim_records_status_usulan 
  ON claim_records(status_usulan);

CREATE INDEX idx_claim_records_disetujui_oleh 
  ON claim_records(disetujui_oleh);

CREATE INDEX idx_claim_records_jenis_field_status 
  ON claim_records(jenis_field, status_usulan);
```

**Performance Impact:**
- Speeds up filtering/searching by field type category
- Enables efficient approval workflow queries
- Composite index supports common query patterns (e.g., "all Koding fields pending approval")

## Migration Process

### Option 1: Automatic (Recommended)
The new columns are automatically created during application startup via `src/database/init.js` when the database initializes:
1. If deploying to a NEW database, columns are created via `CREATE TABLE` statement
2. If deploying to an EXISTING database, columns are added via `ALTER TABLE` in the `migrateSchema()` function

**No manual intervention needed** - works seamlessly with existing deployments.

### Option 2: Manual Migration
For explicit control or testing:

```bash
# Run all pending migrations
node scripts/run-migrations.js

# Dry-run to see what would be executed
node scripts/run-migrations.js --dry-run

# Or execute the SQL file directly
psql -d eclaim -f src/database/migrations/006-field-types-system.sql
```

## Testing

A comprehensive test suite is included to validate the schema changes:

```bash
# Run the field types system test suite
node scripts/test-field-types-schema.js
```

**Tests Included:**
1. Verify all 7 columns exist
2. Verify ENUM/CHECK constraints are enforced
3. Verify the Koding+kutipan constraint works correctly
4. Verify all indexes are created
5. Test with different field types (Salin, Turunan, etc.)
6. Test with different document sources
7. Verify existing claims still work
8. Test status_usulan workflow values

**Expected Output:**
```
Test 1: Checking if all 7 new columns exist...
  ✓ Column 'jenis_field' exists
  ✓ Column 'dokumen_sumber' exists
  ...
✓ All 7 columns exist

Test 2: Checking constraints...
  ✓ CHECK constraints are in place

Test 3: Checking indexes...
  ✓ Index 'idx_claim_records_jenis_field' exists
  ...
✓ All required indexes exist

Test 4: Testing Koding + kutipan constraint...
  Test 4a: Koding WITH kutipan (should succeed)...
  ✓ Koding WITH kutipan accepted
  Test 4b: Koding WITHOUT kutipan (should FAIL)...
  ✓ Koding WITHOUT kutipan correctly REJECTED
✓ Constraint tests complete

...

All tests completed successfully!
```

## Backward Compatibility

All changes are **100% backward compatible**:

- ✓ All new columns are NULLABLE (NULL is default)
- ✓ No existing columns were modified or removed
- ✓ No mandatory data backfill required
- ✓ Existing queries continue to work without modification
- ✓ Existing records can be queried normally
- ✓ Application can rollback without data loss

## SQL Examples

### Typical Usage Patterns

#### Track a diagnosis field source
```sql
UPDATE claim_records 
SET 
  jenis_field = 'Koding',
  dokumen_sumber = 'resume_medis',
  halaman_sumber = 2,
  kutipan = 'Diagnosis: Hypertension Essensial (I10)',
  status_usulan = 'usulan'
WHERE id = 'rec-12345';
```

#### Approve a field modification
```sql
UPDATE claim_records 
SET 
  status_usulan = 'disetujui',
  disetujui_oleh = 'user-id-from-session',
  disetujui_pada = CURRENT_TIMESTAMP
WHERE id = 'rec-12345' AND status_usulan = 'usulan';
```

#### Find all pending approvals per document
```sql
SELECT 
  dokumen_sumber,
  COUNT(*) as pending_count,
  STRING_AGG(jenis_field, ', ' ORDER BY jenis_field) as field_types
FROM claim_records
WHERE status_usulan = 'usulan'
GROUP BY dokumen_sumber
ORDER BY pending_count DESC;
```

#### Audit trail: who approved what and when
```sql
SELECT 
  cr.id,
  cr.sep,
  cr.jenis_field,
  cr.kutipan,
  u.full_name as approved_by,
  cr.disetujui_pada,
  EXTRACT(EPOCH FROM (cr.disetujui_pada - cr.created_at)) / 60 as approval_minutes
FROM claim_records cr
JOIN users u ON cr.disetujui_oleh = u.id
WHERE cr.status_usulan = 'disetujui'
ORDER BY cr.disetujui_pada DESC
LIMIT 50;
```

## Notes

- **Case Sensitivity:** ENUM values are case-sensitive (e.g., `'Koding'` not `'koding'`)
- **Constraint Timing:** The `ck_koding_requires_kutipan` constraint is checked at INSERT/UPDATE time
- **Audit:** All approval actions (via `disetujui_oleh` and `disetujui_pada`) are immutable once set - consider application layer for audit logging
- **Performance:** With proper indexing, queries filtering by jenis_field/status_usulan should complete in <100ms on datasets with 100k+ records

## References

- **Specification**: Link 2 specification + Firdan case (SEP 0170R0110926V001417)
- **Migration File**: `src/database/migrations/006-field-types-system.sql`
- **Schema Init**: `src/database/init.js` (lines 668-710 for schema + indexes)
- **Test Script**: `scripts/test-field-types-schema.js`
- **Migration Runner**: `scripts/run-migrations.js`
