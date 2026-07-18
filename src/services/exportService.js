const XLSX = require('xlsx');

/**
 * Generate Excel export of validation results
 * @param {Array} records - Claim records with errors
 * @param {Object} fileInfo - File metadata
 * @param {string} filter - 'all' | 'error' | 'valid'
 * @returns {Buffer} Excel file buffer
 */
function generateExcel(records, fileInfo, filter = 'error') {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryData = [
    ['Laporan Validasi Klaim BPJS'],
    ['RS Mitra Keluarga Batang'],
    [''],
    ['File', fileInfo.file_name || ''],
    ['Periode', fileInfo.period || ''],
    ['Kode RS', fileInfo.hospital_code || ''],
    ['Total Record', fileInfo.total_records || 0],
    ['Valid', fileInfo.valid_count || 0],
    ['Error', fileInfo.error_count || 0],
    ['Pending', fileInfo.pending_count || 0],
    ['Status', fileInfo.status || ''],
    ['Tanggal Export', new Date().toLocaleDateString('id-ID')],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Ringkasan');

  // Sheet 2: Record Details
  const filteredRecords = records.filter(r => {
    if (filter === 'all') return true;
    if (filter === 'error') return r.validation_status === 'error' || r.validation_status === 'pending';
    if (filter === 'valid') return r.validation_status === 'valid';
    return true;
  });

  const detailHeaders = [
    'No', 'SEP', 'No Kartu', 'Nama Pasien', 'MRN', 'Tgl Lahir', 'Umur',
    'Tgl Masuk', 'Tgl Keluar', 'LOS', 'Kelas Rawat', 'Status Keluar',
    'Diagnosa', 'Prosedur', 'INACBG', 'Deskripsi INACBG',
    'Tarif INACBG', 'Tarif RS', 'Total Tarif',
    'ICU', 'Ventilator (jam)', 'DPJP',
    'Status Validasi', 'Jumlah Error', 'Detail Error'
  ];

  const detailData = [detailHeaders];
  filteredRecords.forEach((rec, idx) => {
    const errorDetails = rec.errors ? rec.errors.map(e =>
      `[${e.rule_id}] ${e.field_name}: ${e.error_message}`
    ).join('; ') : '';

    detailData.push([
      idx + 1,
      rec.sep || '',
      rec.nokartu || '',
      rec.nama_pasien || '',
      rec.mrn || '',
      rec.birth_date || '',
      rec.umur_tahun || '',
      rec.admission_date || '',
      rec.discharge_date || '',
      rec.los || '',
      rec.kelas_rawat || '',
      rec.discharge_status || '',
      rec.diagnosa_list || '',
      rec.prosedur_list || '',
      rec.inacbg_code || '',
      rec.deskripsi_inacbg || '',
      rec.tarif_inacbg || 0,
      rec.tarif_rs || 0,
      rec.total_tarif || 0,
      rec.icu_indikator ? 'Ya' : 'Tidak',
      rec.vent_hour || 0,
      rec.dpjp_name || '',
      rec.validation_status || '',
      rec.error_count || 0,
      errorDetails
    ]);
  });

  const wsDetail = XLSX.utils.aoa_to_sheet(detailData);

  // Set column widths
  wsDetail['!cols'] = [
    { wch: 5 }, { wch: 22 }, { wch: 16 }, { wch: 25 }, { wch: 10 },
    { wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 5 },
    { wch: 8 }, { wch: 10 }, { wch: 25 }, { wch: 20 },
    { wch: 14 }, { wch: 40 },
    { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 6 }, { wch: 10 }, { wch: 30 },
    { wch: 12 }, { wch: 10 }, { wch: 60 }
  ];

  XLSX.utils.book_append_sheet(wb, wsDetail, 'Detail Klaim');

  // Sheet 3: Error Summary (grouped by rule)
  if (records.some(r => r.errors && r.errors.length > 0)) {
    const errorMap = {};
    records.forEach(rec => {
      if (rec.errors) {
        rec.errors.forEach(err => {
          if (!errorMap[err.rule_id]) {
            errorMap[err.rule_id] = { count: 0, message: err.error_message, field: err.field_name, severity: err.severity };
          }
          errorMap[err.rule_id].count++;
        });
      }
    });

    const errorSummaryData = [
      ['Kode Rule', 'Severity', 'Field', 'Deskripsi Error', 'Jumlah']
    ];
    Object.entries(errorMap)
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([ruleId, info]) => {
        errorSummaryData.push([ruleId, info.severity, info.field, info.message, info.count]);
      });

    const wsErrors = XLSX.utils.aoa_to_sheet(errorSummaryData);
    wsErrors['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 15 }, { wch: 60 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsErrors, 'Ringkasan Error');
  }

  // Sheet 4: Records with SEP lowercase (if any)
  const sepErrors = records.filter(r =>
    r.errors && r.errors.some(e => e.rule_id === 'RV-01' && e.field_name === 'sep')
  );
  if (sepErrors.length > 0) {
    const sepData = [['No', 'SEP (Error)', 'SEP (Koreksi)', 'Nama Pasien', 'No Kartu']];
    sepErrors.forEach((rec, idx) => {
      sepData.push([
        idx + 1,
        rec.sep || '',
        (rec.sep || '').toUpperCase(),
        rec.nama_pasien || '',
        rec.nokartu || ''
      ]);
    });
    const wsSep = XLSX.utils.aoa_to_sheet(sepData);
    wsSep['!cols'] = [{ wch: 5 }, { wch: 22 }, { wch: 22 }, { wch: 25 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, wsSep, 'SEP Perlu Koreksi');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Export validation results to TAB-delimited TXT (60-column vClaim format)
 * E-Claim fills ~25-30 columns, vClaim fills remaining columns with empty strings
 * @param {string} fileId - Claim file ID
 * @param {Array} records - Claim records with validation data (from database)
 * @returns {string} Filename of exported TXT file
 */
function exportToVclaimTxt(fileId, records) {
  const path = require('path');
  const fs = require('fs');

  // ponytail: 60-column vClaim format, map database fields to vClaim schema
  const VCLAIM_COLUMNS = [
    'KODE_RS',
    'KELAS_RS',
    'KELAS_RAWAT',
    'KODE_TARIF',
    'PTD',
    'ADMISSION_DATE',
    'DISCHARGE_DATE',
    'BIRTH_DATE',
    'BIRTH_WEIGHT',
    'SEX',
    'DISCHARGE_STATUS',
    'DIAGLIST',
    'PROCLIST',
    'ADL1',
    'ADL2',
    'IN_SP',
    'IN_SR',
    'IN_SI',
    'IN_SD',
    'INACBG',           // vClaim fills this
    'SUBACUTE',
    'CHRONIC',
    'SP',
    'SR',
    'SI',
    'SD',
    'DESKRIPSI_INACBG', // vClaim fills this
    'TARIF_INACBG',     // vClaim fills this
    'TARIF_SUBACUTE',
    'TARIF_CHRONIC',
    'DESKRIPSI_SP',     // vClaim fills this
    'TARIF_SP',         // vClaim fills this
    'DESKRIPSI_SR',     // vClaim fills this
    'TARIF_SR',         // vClaim fills this
    'DESKRIPSI_SI',     // vClaim fills this
    'TARIF_SI',         // vClaim fills this
    'DESKRIPSI_SD',     // vClaim fills this
    'TARIF_SD',         // vClaim fills this
    'TOTAL_TARIF',
    'TARIF_RS',
    'TARIF_POLI_EKS',
    'LOS',
    'ICU_INDIKATOR',
    'ICU_LOS',
    'VENT_HOUR',
    'NAMA_PASIEN',
    'MRN',
    'UMUR_TAHUN',
    'UMUR_HARI',
    'DPJP',
    'SEP',
    'NOKARTU',
    'PAYOR_ID',
    'CODER_ID',
    'VERSI_INACBG',
    'VERSI_GROUPER',
    'C1',               // vClaim fills this
    'C2',               // vClaim fills this
    'C3',               // vClaim fills this
    'C4'                // vClaim fills this
  ];

  // Map database field names to vClaim columns
  const fieldMapping = {
    'KODE_RS': 'kode_rs',
    'KELAS_RS': 'kelas_rs',
    'KELAS_RAWAT': 'kelas_rawat',
    'KODE_TARIF': 'kode_tarif',
    'PTD': 'ptd',
    'ADMISSION_DATE': 'admission_date',
    'DISCHARGE_DATE': 'discharge_date',
    'BIRTH_DATE': 'birth_date',
    'BIRTH_WEIGHT': 'birth_weight',
    'SEX': 'gender',
    'DISCHARGE_STATUS': 'discharge_status',
    'DIAGLIST': 'diagnosa_list',
    'PROCLIST': 'prosedur_list',
    'ADL1': 'adl1',
    'ADL2': 'adl2',
    'IN_SP': 'in_sp',
    'IN_SR': 'in_sr',
    'IN_SI': 'in_si',
    'IN_SD': 'in_sd',
    'INACBG': null,          // vClaim fills
    'SUBACUTE': 'subacute',
    'CHRONIC': 'chronic',
    'SP': 'sp',
    'SR': 'sr',
    'SI': 'si',
    'SD': 'sd',
    'DESKRIPSI_INACBG': null, // vClaim fills
    'TARIF_INACBG': null,     // vClaim fills
    'TARIF_SUBACUTE': 'tarif_subacute',
    'TARIF_CHRONIC': 'tarif_chronic',
    'DESKRIPSI_SP': null,     // vClaim fills
    'TARIF_SP': null,         // vClaim fills
    'DESKRIPSI_SR': null,     // vClaim fills
    'TARIF_SR': null,         // vClaim fills
    'DESKRIPSI_SI': null,     // vClaim fills
    'TARIF_SI': null,         // vClaim fills
    'DESKRIPSI_SD': null,     // vClaim fills
    'TARIF_SD': null,         // vClaim fills
    'TOTAL_TARIF': 'total_tarif',
    'TARIF_RS': 'tarif_rs',
    'TARIF_POLI_EKS': 'tarif_poli_eks',
    'LOS': 'los',
    'ICU_INDIKATOR': 'icu_indikator',
    'ICU_LOS': 'icu_los',
    'VENT_HOUR': 'vent_hour',
    'NAMA_PASIEN': 'nama_pasien',
    'MRN': 'mrn',
    'UMUR_TAHUN': 'umur_tahun',
    'UMUR_HARI': 'umur_hari',
    'DPJP': 'dpjp_name',
    'SEP': 'sep',
    'NOKARTU': 'nokartu',
    'PAYOR_ID': 'payor_id',
    'CODER_ID': 'coder_id',
    'VERSI_INACBG': 'versi_inacbg',
    'VERSI_GROUPER': 'versi_grouper',
    'C1': null,               // vClaim fills
    'C2': null,               // vClaim fills
    'C3': null,               // vClaim fills
    'C4': null                // vClaim fills
  };

  // Build header
  const headerRow = VCLAIM_COLUMNS.join('\t');

  // Build data rows
  const dataRows = records.map(rec => {
    const row = VCLAIM_COLUMNS.map(colName => {
      const dbField = fieldMapping[colName];
      if (dbField === null) {
        // vClaim fills these columns - E-Claim leaves empty
        return '';
      }
      const value = rec[dbField];
      return value !== null && value !== undefined ? String(value) : '';
    });
    return row.join('\t');
  });

  // Combine header + data
  const txtContent = [headerRow, ...dataRows].join('\n');

  // Write to file
  const uploadsDir = path.join(__dirname, '../../uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const timestamp = Date.now();
  const filename = `${timestamp}-eclaim-export-${fileId.substring(0, 8)}.txt`;
  const filepath = path.join(uploadsDir, filename);

  fs.writeFileSync(filepath, txtContent, 'utf8');
  return filename;
}

module.exports = { generateExcel, exportToVclaimTxt };
