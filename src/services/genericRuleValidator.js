/**
 * Generic Rule Validator
 * Evaluates DB-stored rule configurations against claim records.
 * Supports multiple operator types for configurable validation logic.
 * 
 * Rule Logic JSON format:
 * {
 *   "type": "and|or",
 *   "checks": [
 *     { "field": "sep", "operator": "uppercase", "severity": "critical" },
 *     { "field": "nokartu", "operator": "regex", "value": "^\\\\d{13}$", "severity": "critical" },
 *     { "field": "nama_pasien", "operator": "required", "severity": "critical" },
 *     { "field": "kelas_rawat", "operator": "in_list", "value": [1, 2, 3], "severity": "major" }
 *   ]
 * }
 */

const ICD10_PATTERN = /^[A-Z]\d{2}(\.\d{1,4})?$/i;
const ICD9CM_PATTERN = /^\d{2,3}(\.\d{1,4})?$/;

/**
 * Evaluate a single check against a record value
 */
function evaluateCheck(record, check) {
  const { field, operator, value, severity, message, expected } = check;
  const fieldValue = record[field];
  const errors = [];

  switch (operator) {
    case 'uppercase': {
      const val = String(fieldValue || '');
      if (val && val !== val.toUpperCase()) {
        errors.push({
          field,
          severity: severity || 'critical',
          message: message || `${field.toUpperCase()} harus uppercase semua.`,
          expected: val.toUpperCase(),
          actual: val
        });
      }
      break;
    }

    case 'required': {
      const val = fieldValue !== undefined && fieldValue !== null ? String(fieldValue).trim() : '';
      if (!val || val === '' || val === '-') {
        errors.push({
          field,
          severity: severity || 'critical',
          message: message || `${field.toUpperCase()} wajib diisi.`,
          expected: expected || `Nilai ${field} valid`,
          actual: '(kosong)'
        });
      }
      break;
    }

    case 'regex': {
      const val = String(fieldValue || '');
      if (val) {
        try {
          const regex = new RegExp(value);
          if (!regex.test(val)) {
            errors.push({
              field,
              severity: severity || 'critical',
              message: message || `${field.toUpperCase()} tidak sesuai format yang diharapkan.`,
              expected: expected || `Format: ${value}`,
              actual: val
            });
          }
        } catch (e) {
          // Invalid regex in config, skip
        }
      }
      break;
    }

    case 'in_list': {
      const val = fieldValue !== undefined && fieldValue !== null ? fieldValue : null;
      if (val !== null && val !== 0 && !value.includes(val)) {
        errors.push({
          field,
          severity: severity || 'major',
          message: message || `${field.toUpperCase()} harus bernilai ${value.join(', ')}.`,
          expected: expected || String(value),
          actual: String(val)
        });
      }
      break;
    }

    case 'not_empty': {
      const val = String(fieldValue || '').trim();
      if (!val || val === '-' || val === '') {
        errors.push({
          field,
          severity: severity || 'major',
          message: message || `${field.toUpperCase()} tidak boleh kosong.`,
          expected: expected || `Data ${field} valid`,
          actual: '(kosong)'
        });
      }
      break;
    }

    case 'min_length': {
      const val = String(fieldValue || '');
      if (val && val.length < value) {
        errors.push({
          field,
          severity: severity || 'critical',
          message: message || `${field.toUpperCase()} minimal ${value} karakter.`,
          expected: expected || `Min ${value} karakter`,
          actual: `${val} (${val.length} karakter)`
        });
      }
      break;
    }

    case 'max_length': {
      const val = String(fieldValue || '');
      if (val && val.length > value) {
        errors.push({
          field,
          severity: severity || 'major',
          message: message || `${field.toUpperCase()} maksimal ${value} karakter.`,
          expected: expected || `Max ${value} karakter`,
          actual: `${val} (${val.length} karakter)`
        });
      }
      break;
    }

    case 'numeric_gte': {
      const num = Number(fieldValue);
      if (!isNaN(num) && num < value) {
        errors.push({
          field,
          severity: severity || 'major',
          message: message || `${field.toUpperCase()} harus >= ${value}.`,
          expected: expected || `>= ${value}`,
          actual: String(num)
        });
      }
      break;
    }

    case 'numeric_lte': {
      const num = Number(fieldValue);
      if (!isNaN(num) && num > value) {
        errors.push({
          field,
          severity: severity || 'major',
          message: message || `${field.toUpperCase()} harus <= ${value}.`,
          expected: expected || `<= ${value}`,
          actual: String(num)
        });
      }
      break;
    }

    case 'icd10': {
      const str = String(fieldValue || '');
      if (str && str !== '-') {
        const codes = str.split(';').map(d => d.trim()).filter(d => d && d !== '-');
        codes.forEach(code => {
          if (!ICD10_PATTERN.test(code)) {
            errors.push({
              field,
              severity: severity || 'major',
              message: message || `Kode ICD-10 tidak valid: ${code}`,
              expected: expected || 'Format ICD-10 (contoh: E11.9, I10)',
              actual: code
            });
          }
        });
      }
      break;
    }

    case 'icd9': {
      const str = String(fieldValue || '');
      if (str && str !== '-') {
        const codes = str.split(';').map(p => p.trim()).filter(p => p && p !== '-');
        codes.forEach(code => {
          if (!ICD9CM_PATTERN.test(code)) {
            errors.push({
              field,
              severity: severity || 'major',
              message: message || `Kode ICD-9-CM tidak valid: ${code}`,
              expected: expected || 'Format ICD-9-CM (contoh: 88.72)',
              actual: code
            });
          }
        });
      }
      break;
    }

    case 'date_order': {
      const field1 = value?.field1 || 'admission_date';
      const field2 = value?.field2 || 'discharge_date';
      const val1 = record[field1];
      const val2 = record[field2];
      if (val1 && val2) {
        const d1 = new Date(val1);
        const d2 = new Date(val2);
        if (!isNaN(d1) && !isNaN(d2) && d1 > d2) {
          errors.push({
            field: field1,
            severity: severity || 'critical',
            message: message || `${field1} harus sebelum atau sama dengan ${field2}.`,
            expected: expected || `<= ${val2}`,
            actual: val1
          });
        }
      }
      if (!val1) {
        errors.push({
          field: field1,
          severity: severity || 'critical',
          message: `${field1} wajib diisi.`,
          expected: 'Format tanggal valid',
          actual: '(kosong)'
        });
      }
      if (!val2) {
        errors.push({
          field: field2,
          severity: severity || 'critical',
          message: `${field2} wajib diisi.`,
          expected: 'Format tanggal valid',
          actual: '(kosong)'
        });
      }
      break;
    }

    case 'age_crosscheck': {
      const birthDate = record.birth_date;
      const admDate = record.admission_date;
      const umur = record.umur_tahun;
      if (birthDate && admDate && umur !== undefined && umur !== null) {
        const birth = new Date(birthDate);
        const admission = new Date(admDate);
        if (!isNaN(birth) && !isNaN(admission)) {
          let calcAge = admission.getFullYear() - birth.getFullYear();
          const monthDiff = admission.getMonth() - birth.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && admission.getDate() < birth.getDate())) {
            calcAge--;
          }
          if (Math.abs(umur - calcAge) > (value?.tolerance || 1)) {
            errors.push({
              field: 'umur_tahun',
              severity: severity || 'major',
              message: message || `Umur tidak sesuai dengan tanggal lahir.`,
              expected: expected || `${calcAge} tahun (dari TGL_LAHIR: ${birthDate})`,
              actual: `${umur} tahun`
            });
          }
        }
      }
      break;
    }

    case 'tarif_discrepancy': {
      const tarifRs = Number(record.tarif_rs || 0);
      const totalTarif = Number(record.total_tarif || 0);
      if (totalTarif > 0 && tarifRs > 0) {
        const selisih = Math.abs(tarifRs - totalTarif);
        const pct = (selisih / totalTarif) * 100;
        if (pct > (value?.max_pct || 50)) {
          errors.push({
            field: 'tarif_rs',
            severity: severity || 'minor',
            message: message || `Selisih tarif RS vs INACBG: ${pct.toFixed(1)}%.`,
            expected: expected || `Tarif INACBG: Rp ${totalTarif.toLocaleString('id-ID')}`,
            actual: `Tarif RS: Rp ${tarifRs.toLocaleString('id-ID')} (selisih ${pct.toFixed(1)}%)`
          });
        }
      }
      break;
    }

    default:
      break;
  }

  return errors;
}

/**
 * Validate a record against a single rule's logic config
 * @param {Object} record - The claim record
 * @param {Object} rule - The rule from DB with rule_logic
 * @returns {Array} Errors found
 */
function validateWithRuleLogic(record, rule) {
  const errors = [];
  if (!rule.rule_logic) return errors;

  let logic;
  try {
    logic = typeof rule.rule_logic === 'string' ? JSON.parse(rule.rule_logic) : rule.rule_logic;
  } catch (e) {
    console.error(`Invalid rule_logic for ${rule.id}:`, e.message);
    return errors;
  }

  if (!logic || !logic.checks || !Array.isArray(logic.checks)) return errors;

  const checks = logic.checks;
  const logicType = logic.type || 'and';

  for (const check of checks) {
    const checkErrors = evaluateCheck(record, check);
    
    if (logicType === 'or') {
      // OR logic: if any check passes, no errors
      if (checkErrors.length === 0) return [];
      // If this is the last check, return all accumulated
      if (check === checks[checks.length - 1]) {
        errors.push(...checkErrors);
      }
    } else {
      // AND logic: all checks must pass
      errors.push(...checkErrors);
    }
  }

  return errors.map(err => ({
    rule_id: rule.id,
    field_name: err.field,
    severity: err.severity,
    error_message: err.message || rule.error_message,
    expected_value: err.expected || '',
    actual_value: err.actual || ''
  }));
}

module.exports = { validateWithRuleLogic, evaluateCheck };
