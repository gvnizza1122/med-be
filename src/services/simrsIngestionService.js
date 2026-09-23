/**
 * SIMRS Ingestion Service — Phase 2
 * Handles JSON payloads and PDF uploads from SIMRS
 */

const { v4: uuidv4 } = require('uuid');
const { parsePDF } = require('./pdfParser');
const { runRuleBasedAudit, extractErrorFields } = require('./aiValidationService');
const { isiPeriodeUntukFile } = require('./periodeKlaimService');

/**
 * Ingest JSON records from SIMRS
 * @param {Object} db - Database instance
 * @param {Array} records - Medical records from SIMRS
 * @param {string} hospitalCode - Hospital code
 * @returns {{inserted: number, errors: object[]}}
 */
async function ingestJsonRecords(db, records, hospitalCode = '3371084') {
  if (!Array.isArray(records)) {
    throw new Error('Records must be an array.');
  }

  const results = {
    inserted: 0,
    failed: 0,
    errors: [],
  };

  // Create file record first
  const fileId = uuidv4();
  const fileName = `SIMRS-JSON-${new Date().toISOString().split('T')[0]}`;

  try {
    await db.prepare(`
      INSERT INTO claim_files (id, file_name, status, total_records, hospital_code, created_at)
      VALUES (?, ?, 'validating', ?, ?, CURRENT_TIMESTAMP)
    `).run(fileId, fileName, records.length, hospitalCode);
  } catch (err) {
    throw new Error(`Failed to create file record: ${err.message}`);
  }

  // Insert records
  let validCount = 0;
  let errorCount = 0;

  for (let idx = 0; idx < records.length; idx++) {
    try {
      const rec = records[idx];
      if (!rec) {
        results.errors.push({
          index: idx,
          error: 'Record is null or undefined',
        });
        results.failed++;
        continue;
      }

      // Normalize field names (handle various formats)
      const normalized = normalizeSimrsRecord(rec);
      const recordId = uuidv4();

      // Insert record
      await db.prepare(`
        INSERT INTO claim_records (
          id, file_id, row_number, sep, nokartu, nama_pasien, mrn,
          admission_date, discharge_date, los, diagnosa_list, prosedur_list,
          inacbg_code, deskripsi_inacbg, tarif_inacbg, tarif_rs, total_tarif,
          kelas_rawat, icu_indikator, vent_hour, validation_status, hospital_code, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )
      `).run(
        recordId, fileId, idx + 1, normalized.sep, normalized.nokartu,
        normalized.nama_pasien, normalized.mrn,
        normalized.admission_date, normalized.discharge_date, normalized.los || 0,
        normalized.diagnosa_list, normalized.prosedur_list,
        normalized.inacbg_code, normalized.deskripsi_inacbg,
        normalized.tarif_inacbg || 0, normalized.tarif_rs || 0, normalized.total_tarif || 0,
        normalized.kelas_rawat, normalized.icu_indikator || 0, normalized.vent_hour || 0,
        'pending', hospitalCode
      );

      // Run quick validation
      const rulesAudit = runRuleBasedAudit([normalized]);
      if (rulesAudit[0]?.ai_status === 'valid') {
        validCount++;
      } else {
        errorCount++;
        // Log validation errors
        if (rulesAudit[0]?.ai_notes) {
          const errorMsg = rulesAudit[0].ai_notes;
          // Extract field names from error message (heuristic)
          const fields = ['sep', 'nokartu', 'diagnosa_list', 'tarif_rs'];
          for (const field of fields) {
            if (errorMsg.includes(field) || errorMsg.toLowerCase().includes(field)) {
              await db.prepare(`
                INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, severity)
                VALUES (?, ?, ?, ?, ?, 'major')
              `).run(uuidv4(), recordId, 'RV-AUTO', field, errorMsg.substring(0, 255));
            }
          }
        }
      }

      results.inserted++;
    } catch (err) {
      results.failed++;
      results.errors.push({
        index: idx,
        error: err.message,
      });
    }
  }

  // Periode diisi di sini, setelah record tersimpan, supaya pengelompokan
  // dan arsip per bulan ikut terbentuk untuk berkas yang baru masuk.
  try {
    await isiPeriodeUntukFile(db, fileId);
  } catch (e) {
    // periode bukan syarat berkas dianggap berhasil diproses
    console.warn('[periode] gagal mengisi periode:', e.message);
  }

  // Update file stats
  try {
    await db.prepare(`
      UPDATE claim_files SET
        total_records = ?,
        valid_count = ?,
        error_count = ?,
        status = 'validating'
      WHERE id = ?
    `).run(records.length, validCount, errorCount, fileId);
  } catch (updateErr) {
    console.warn(`[SIMRS Ingest] Failed to update file stats: ${updateErr.message}`);
  }

  return {
    file_id: fileId,
    ...results,
    summary: {
      total: records.length,
      inserted: results.inserted,
      valid: validCount,
      errors: errorCount,
      parsing_errors: results.failed,
    },
  };
}

/**
 * Ingest PDF file from SIMRS
 * @param {Buffer} fileBuffer - PDF file buffer
 * @param {string} originalFileName - Original file name
 * @param {Object} db - Database instance
 * @param {string} hospitalCode - Hospital code
 * @returns {{file_id: string, records_extracted: number, inserted: number}}
 */
async function ingestPdfFile(db, fileBuffer, originalFileName, hospitalCode = '3371084') {
  if (!Buffer.isBuffer(fileBuffer)) {
    throw new Error('fileBuffer must be a Buffer.');
  }

  // Parse PDF
  let extractedRecords = [];
  try {
    extractedRecords = await parsePDF(fileBuffer, originalFileName);
  } catch (parseErr) {
    throw new Error(`PDF parsing failed: ${parseErr.message}`);
  }

  if (!Array.isArray(extractedRecords) || extractedRecords.length === 0) {
    throw new Error('No records extracted from PDF.');
  }

  console.log(`[SIMRS Ingest] Extracted ${extractedRecords.length} records from ${originalFileName}`);

  // Ingest as JSON
  return ingestJsonRecords(db, extractedRecords, hospitalCode);
}

/**
 * Normalize SIMRS record to standard format
 * Handles various field name variations from SIMRS
 */
function normalizeSimrsRecord(rec) {
  return {
    sep: rec.sep || rec.SEP || rec.no_sep || '',
    nokartu: rec.nokartu || rec.NOKARTU || rec.no_kartu || rec.cardNumber || '',
    nama_pasien: rec.nama_pasien || rec.NAMA_PASIEN || rec.patient_name || rec.patientName || '',
    mrn: rec.mrn || rec.MRN || rec.medical_record_number || rec.medicalRecordNumber || '',
    admission_date: rec.admission_date || rec.ADMISSION_DATE || rec.tanggal_masuk || rec.tglMasuk || null,
    discharge_date: rec.discharge_date || rec.DISCHARGE_DATE || rec.tanggal_keluar || rec.tglKeluar || null,
    los: Number(rec.los || rec.LOS || rec.length_of_stay || rec.durasi || 0) || 0,
    diagnosa_list: rec.diagnosa_list || rec.DIAGNOSA_LIST || rec.diagnosis || rec.dx || '',
    prosedur_list: rec.prosedur_list || rec.PROSEDUR_LIST || rec.procedure || rec.px || '',
    inacbg_code: rec.inacbg_code || rec.INACBG_CODE || rec.inacbgCode || '',
    deskripsi_inacbg: rec.deskripsi_inacbg || rec.DESKRIPSI_INACBG || rec.inacbgDescription || '',
    tarif_inacbg: Number(rec.tarif_inacbg || rec.TARIF_INACBG || rec.inacbgTariff || 0) || 0,
    tarif_rs: Number(rec.tarif_rs || rec.TARIF_RS || rec.hospital_tariff || rec.hospitalTariff || 0) || 0,
    total_tarif: Number(rec.total_tarif || rec.TOTAL_TARIF || rec.total || 0) || 0,
    kelas_rawat: Number(rec.kelas_rawat || rec.KELAS_RAWAT || rec.ward_class || rec.wardClass || 3) || 3,
    icu_indikator: Number(rec.icu_indikator || rec.ICU_INDIKATOR || rec.icu || 0) || 0,
    vent_hour: Number(rec.vent_hour || rec.VENT_HOUR || rec.ventilator_hours || rec.ventilatorHours || 0) || 0,
  };
}

/**
 * Validate SIMRS JSON payload structure
 */
function validateSimrsPayload(payload) {
  const errors = [];

  if (!payload) {
    return {
      valid: false,
      errors: ['Payload is empty or null.'],
    };
  }

  if (!Array.isArray(payload.records)) errors.push('records must be an array.');
  if (payload.records && payload.records.length === 0) errors.push('records array is empty.');
  if (payload.records && payload.records.length > 1000) errors.push('records exceeds limit of 1000.');

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  ingestJsonRecords,
  ingestPdfFile,
  normalizeSimrsRecord,
  validateSimrsPayload,
};
