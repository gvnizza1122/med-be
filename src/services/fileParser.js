const fs = require('fs');
const { jenisLayanan } = require('./jenisLayananKlaimService');

/**
 * Full 60-column INACBG/vClaim TXT header mapping
 * Based on actual hospital data files (RS Mitra Keluarga Batang)
 */
const COLUMN_MAPPINGS = {
  // Core identifiers
  'KODE_RS': 'kode_rs', 'KODE RS': 'kode_rs', 'KODRS': 'kode_rs',
  'KELAS_RS': 'kelas_rs', 'KELAS RS': 'kelas_rs',
  'KELAS_RAWAT': 'kelas_rawat', 'KELASRAWAT': 'kelas_rawat', 'KELAS': 'kelas_rawat',
  'KODE_TARIF': 'kode_tarif', 'KODETARIF': 'kode_tarif',
  'PTD': 'ptd',
  
  // Dates
  'ADMISSION_DATE': 'admission_date', 'TGLMASUK': 'admission_date', 'TGL_MASUK': 'admission_date',
  'DISCHARGE_DATE': 'discharge_date', 'TGLKELUAR': 'discharge_date', 'TGL_KELUAR': 'discharge_date',
  'BIRTH_DATE': 'birth_date', 'TGLLAHIR': 'birth_date', 'TGL_LAHIR': 'birth_date',
  
  // Patient data
  'BIRTH_WEIGHT': 'birth_weight',
  'SEX': 'gender', 'JK': 'gender', 'GENDER': 'gender', 'JENIS_KELAMIN': 'gender',
  'DISCHARGE_STATUS': 'discharge_status', 'STATUS_PULANG': 'discharge_status', 'STATUSPULANG': 'discharge_status',
  'NAMA_PASIEN': 'nama_pasien', 'NAMA': 'nama_pasien', 'NMPASIEN': 'nama_pasien',
  'MRN': 'mrn',
  'UMUR_TAHUN': 'umur_tahun', 'UMUR': 'umur_tahun', 'UMURTAHUN': 'umur_tahun',
  'UMUR_HARI': 'umur_hari',
  
  // Diagnosis & Procedures
  'DIAGLIST': 'diagnosa_list', 'DIAGNOSA': 'diagnosa_list', 'DIAG': 'diagnosa_list', 'INACBG_DIAG': 'diagnosa_list',
  'PROCLIST': 'prosedur_list', 'PROSEDUR': 'prosedur_list', 'PROC': 'prosedur_list', 'INACBG_PROC': 'prosedur_list',
  
  // ADL
  'ADL1': 'adl1', 'ADL2': 'adl2',
  
  // Special procedures
  'IN_SP': 'in_sp', 'IN_SR': 'in_sr', 'IN_SI': 'in_si', 'IN_SD': 'in_sd',
  'SP': 'sp', 'SR': 'sr', 'SI': 'si', 'SD': 'sd',
  'SUBACUTE': 'subacute', 'CHRONIC': 'chronic',
  
  // INACBG grouping
  'INACBG': 'inacbg_code', 'INACBG_CODE': 'inacbg_code',
  'DESKRIPSI_INACBG': 'deskripsi_inacbg',
  
  // Tariff fields
  'TARIF_INACBG': 'tarif_inacbg',
  'TARIF_SUBACUTE': 'tarif_subacute',
  'TARIF_CHRONIC': 'tarif_chronic',
  'DESKRIPSI_SP': 'deskripsi_sp', 'TARIF_SP': 'tarif_sp',
  'DESKRIPSI_SR': 'deskripsi_sr', 'TARIF_SR': 'tarif_sr',
  'DESKRIPSI_SI': 'deskripsi_si', 'TARIF_SI': 'tarif_si',
  'DESKRIPSI_SD': 'deskripsi_sd', 'TARIF_SD': 'tarif_sd',
  'TOTAL_TARIF': 'total_tarif', 'TOTALTARIF': 'total_tarif', 'TARIF_TOTAL': 'total_tarif',
  'TARIF_RS': 'tarif_rs', 'TARIFRS': 'tarif_rs',
  'TARIF_POLI_EKS': 'tarif_poli_eks',
  
  // Length of stay & ICU
  'LOS': 'los',
  'ICU_INDIKATOR': 'icu_indikator', 'ICU_IND': 'icu_indikator',
  'ICU_LOS': 'icu_los',
  'VENT_HOUR': 'vent_hour',
  
  // Identifiers
  'DPJP': 'dpjp_name', 'DPJP_NAME': 'dpjp_name', 'NAMADPJP': 'dpjp_name',
  'SEP': 'sep', 'NOSEP': 'sep', 'NO_SEP': 'sep',
  'NOKARTU': 'nokartu', 'NO_KARTU': 'nokartu', 'NOPESERTA': 'nokartu',
  'PAYOR_ID': 'payor_id',
  'CODER_ID': 'coder_id',
  'VERSI_INACBG': 'versi_inacbg',
  'VERSI_GROUPER': 'versi_grouper',
  
  // Additional columns (C1-C4)
  'C1': 'c1', 'C2': 'c2', 'C3': 'c3', 'C4': 'c4',
  
  // Aliases for jenis rawat
  'JNSPELAYANAN': 'jenis_rawat', 'JENIS_RAWAT': 'jenis_rawat', 'JNSRAWAT': 'jenis_rawat'
};

// Date fields that need parsing
const DATE_FIELDS = ['birth_date', 'admission_date', 'discharge_date'];

// Numeric integer fields
const INT_FIELDS = [
  'kelas_rawat', 'discharge_status', 'umur_tahun', 'umur_hari',
  'birth_weight', 'los', 'icu_indikator', 'icu_los', 'vent_hour', 'ptd',
  'urutan_iterasi', 'jumlah_episode_klaim', 'is_same_day',
  'histori_obat_kronis_bulan_berturut', 'flag_rujuk_balik_prb'
];

// Numeric float fields
const FLOAT_FIELDS = [
  'tarif_rs', 'total_tarif', 'tarif_inacbg', 'tarif_subacute', 'tarif_chronic',
  'tarif_sp', 'tarif_sr', 'tarif_si', 'tarif_sd', 'tarif_poli_eks'
];

function normalizeColumnName(name) {
  const cleaned = name.trim().toUpperCase().replace(/[\r\n]/g, '');
  return COLUMN_MAPPINGS[cleaned] || cleaned.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Parse dates in multiple formats:
 * - DD/MM/YYYY (BPJS standard)
 * - DD-MM-YYYY
 * - YYYY-MM-DD (ISO)
 * - YYYYMMDD (compact)
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr.trim() === '' || dateStr.trim() === '-') return null;
  const s = dateStr.trim();
  
  // ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  
  // DD/MM/YYYY or DD-MM-YYYY (BPJS standard format)
  const dmy = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  
  // Compact: YYYYMMDD
  const ymd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  
  return s;
}

function parseNumeric(value) {
  if (!value || value.trim() === '' || value.trim() === '-') return 0;
  const num = parseFloat(value.trim().replace(/,/g, '.'));
  return isNaN(num) ? 0 : num;
}

function parseInt2(value) {
  if (!value || value.trim() === '' || value.trim() === '-') return 0;
  const num = parseInt(value.trim());
  return isNaN(num) ? 0 : num;
}

/**
 * Parse TXT/TSV claim file from SIMRS/INACBG
 * Handles the standard 60-column INACBG format
 * @param {string} filePath - Path to the TXT file
 * @returns {{ records: Array, headers: Array, errors: Array, metadata: Object }}
 */
function parseClaimFile(filePath) {
  const result = {
    records: [],
    headers: [],
    normalizedHeaders: [],
    errors: [],
    metadata: {
      totalRows: 0, parsedRows: 0, skippedRows: 0,
      encoding: 'utf-8', delimiter: '\t',
      hospitalCode: null, period: null,
      columnCount: 0
    }
  };

  let content;
  try {
    const buffer = fs.readFileSync(filePath);
    // Check BOM (UTF-8 with BOM)
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      content = buffer.toString('utf-8').substring(1);
    } else {
      content = buffer.toString('utf-8');
    }
  } catch (err) {
    result.errors.push({ type: 'file_read', message: `Gagal membaca file: ${err.message}` });
    return result;
  }

  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    result.errors.push({ type: 'format', message: 'File harus memiliki minimal header dan 1 baris data.' });
    return result;
  }

  // Detect delimiter
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const pipeCount = (firstLine.match(/\|/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  
  // For INACBG files, tabs are the standard delimiter
  if (tabCount >= 10) {
    result.metadata.delimiter = '\t';
  } else if (pipeCount > tabCount && pipeCount > semicolonCount) {
    result.metadata.delimiter = '|';
  } else if (semicolonCount > tabCount && semicolonCount > pipeCount) {
    result.metadata.delimiter = ';';
  } else {
    result.metadata.delimiter = '\t';
  }

  // Parse header
  result.headers = firstLine.split(result.metadata.delimiter).map(h => h.trim().replace(/"/g, ''));
  result.normalizedHeaders = result.headers.map(normalizeColumnName);
  result.metadata.totalRows = lines.length - 1;
  result.metadata.columnCount = result.headers.length;

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = line.split(result.metadata.delimiter).map(f => f.trim().replace(/^"|"$/g, ''));
    if (fields.length < 3) { result.metadata.skippedRows++; continue; }

    const record = {};
    const rawData = {};
    
    result.normalizedHeaders.forEach((header, idx) => {
      const value = idx < fields.length ? fields[idx] : '';
      rawData[result.headers[idx] || `col_${idx}`] = value;
      
      if (DATE_FIELDS.includes(header)) {
        record[header] = parseDate(value);
      } else if (INT_FIELDS.includes(header)) {
        record[header] = parseInt2(value);
      } else if (FLOAT_FIELDS.includes(header)) {
        record[header] = parseNumeric(value);
      } else {
        record[header] = value;
      }
    });

    record._rowNumber = i;
    record._rawData = rawData;
    const layanan = jenisLayanan(record);
    if (layanan.masalah) result.errors.push({ type: 'jenis_layanan', row: i, message: layanan.masalah });
    if (layanan.jenis) record.jenis_klaim = layanan.jenis;
    
    // Extract hospital code
    if (!result.metadata.hospitalCode && record.kode_rs) {
      result.metadata.hospitalCode = record.kode_rs;
    }
    
    result.records.push(record);
    result.metadata.parsedRows++;
  }

  // Detect period from admission dates
  if (result.records.length > 0) {
    const dates = result.records
      .filter(r => r.admission_date)
      .map(r => r.admission_date);
    if (dates.length > 0 && dates[0] && dates[0].length >= 7) {
      result.metadata.period = dates[0].substring(0, 7);
    }
  }

  return result;
}

module.exports = { parseClaimFile, normalizeColumnName };
