/**
 * Test export vClaim TXT format with sample E-Claim validation data
 */

const { exportToVclaimTxt } = require('./src/services/exportService');
const path = require('path');
const fs = require('fs');

// Sample validated claim records from E-Claim
const sampleRecords = [
  {
    kode_rs: '3371084',
    kelas_rs: 'D',
    kelas_rawat: 1,
    kode_tarif: 'DS',
    ptd: 1,
    admission_date: '29/11/2025',
    discharge_date: '01/12/2025',
    birth_date: '10/12/1965',
    birth_weight: 0,
    gender: '2',
    discharge_status: 1,
    diagnosa_list: 'I20.0;I10',
    prosedur_list: '90.59;87.44;89.52',
    adl1: null,
    adl2: null,
    in_sp: 'None',
    in_sr: 'None',
    in_si: 'None',
    in_sd: 'None',
    subacute: 'None',
    chronic: 'None',
    sp: 'None',
    sr: 'None',
    si: 'None',
    sd: 'None',
    tarif_subacute: 0,
    tarif_chronic: 0,
    total_tarif: 4189100,
    tarif_rs: 4047258,
    tarif_poli_eks: 0,
    los: 3,
    icu_indikator: 0,
    icu_los: 0,
    vent_hour: 0,
    nama_pasien: 'SUCI RAHAYU, NY',
    mrn: '174614',
    umur_tahun: 59,
    umur_hari: 21904,
    dpjp_name: 'dr. Adhita Kartyanto, Sp.PD',
    sep: '0170R0111125V003163',
    nokartu: '0001837754346',
    payor_id: '3;JKN',
    coder_id: 'Istikomah;3323045708000001;Isti',
    versi_inacbg: '5.10.5.202510071053',
    versi_grouper: '4',
    validation_status: 'valid'
  },
  {
    kode_rs: '3371084',
    kelas_rs: 'D',
    kelas_rawat: 3,
    kode_tarif: 'DS',
    ptd: 1,
    admission_date: '27/11/2025',
    discharge_date: '01/12/2025',
    birth_date: '09/07/2024',
    birth_weight: 0,
    gender: '2',
    discharge_status: 1,
    diagnosa_list: 'R56.0',
    prosedur_list: '87.44;90.99',
    adl1: null,
    adl2: null,
    in_sp: 'None',
    in_sr: 'None',
    in_si: 'None',
    in_sd: 'None',
    subacute: 'None',
    chronic: 'None',
    sp: 'None',
    sr: 'None',
    si: 'None',
    sd: 'None',
    tarif_subacute: 0,
    tarif_chronic: 0,
    total_tarif: 2601200,
    tarif_rs: 2545501,
    tarif_poli_eks: 0,
    los: 5,
    icu_indikator: 0,
    icu_los: 0,
    vent_hour: 0,
    nama_pasien: 'BRIGITTA DWIREEMA AYU, AN',
    mrn: '174579',
    umur_tahun: 1,
    umur_hari: 506,
    dpjp_name: 'dr. Woro Triaksiwi, MSc, Sp.A',
    sep: '0170R0111125V003011',
    nokartu: '0003605889521',
    payor_id: '3;JKN',
    coder_id: 'Istikomah;3323045708000001;Isti',
    versi_inacbg: '5.10.5.202510071053',
    versi_grouper: '4',
    validation_status: 'valid'
  },
  {
    kode_rs: '3371084',
    kelas_rs: 'D',
    kelas_rawat: 1,
    kode_tarif: 'DS',
    ptd: 1,
    admission_date: '28/11/2025',
    discharge_date: '01/12/2025',
    birth_date: '21/07/1988',
    birth_weight: 0,
    gender: '2',
    discharge_status: 2,
    diagnosa_list: 'D25.9;R10.4',
    prosedur_list: '90.59;91.39;89.52',
    adl1: null,
    adl2: null,
    in_sp: 'None',
    in_sr: 'None',
    in_si: 'None',
    in_sd: 'None',
    subacute: 'None',
    chronic: 'None',
    sp: 'None',
    sr: 'None',
    si: 'None',
    sd: 'None',
    tarif_subacute: 0,
    tarif_chronic: 0,
    total_tarif: 3659400,
    tarif_rs: 5359635,
    tarif_poli_eks: 0,
    los: 4,
    icu_indikator: 0,
    icu_los: 0,
    vent_hour: 0,
    nama_pasien: 'YULISA TRI HAPSARI, NY',
    mrn: '148787',
    umur_tahun: 37,
    umur_hari: 13644,
    dpjp_name: 'DR. WARTOTO, SP.PD',
    sep: '0170R0111125V003063',
    nokartu: '0001300396252',
    payor_id: '3;JKN',
    coder_id: 'Istikomah;3323045708000001;Isti',
    versi_inacbg: '5.10.5.202510071053',
    versi_grouper: '4',
    validation_status: 'valid'
  }
];

// Test export
console.log('Testing exportToVclaimTxt function...\n');
const fileId = 'test-file-' + Date.now();
const filename = exportToVclaimTxt(fileId, sampleRecords);
console.log(`✓ Export successful: ${filename}\n`);

// Read and display the exported file
const uploadsDir = path.join(__dirname, 'uploads');
const filepath = path.join(uploadsDir, filename);

if (fs.existsSync(filepath)) {
  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');

  console.log('FILE CONTENT (First 5 lines):\n');
  console.log(lines.slice(0, 5).join('\n'));

  console.log('\n\nFILE STATISTICS:');
  console.log(`- Total lines: ${lines.length}`);
  console.log(`- Header columns: ${lines[0].split('\t').length}`);
  console.log(`- Data records: ${lines.length - 1}`);
  console.log(`- File path: ${filepath}`);
  console.log(`- File size: ${fs.statSync(filepath).size} bytes`);

  // Validate column count
  const headerCols = lines[0].split('\t');
  const firstDataCols = lines[1].split('\t');
  console.log(`\nValidation:`);
  console.log(`✓ Expected 60 columns: ${headerCols.length === 60 ? 'PASS' : 'FAIL'} (got ${headerCols.length})`);
  console.log(`✓ Header matches data: ${headerCols.length === firstDataCols.length ? 'PASS' : 'FAIL'}`);

  // Show first data row in detail
  console.log('\n\nFIRST RECORD (tab-separated columns):');
  console.log('Column\t\t\t\tValue');
  console.log('---\t\t\t\t---');
  headerCols.forEach((col, idx) => {
    const value = firstDataCols[idx] || '(empty)';
    console.log(`${col.padEnd(30)}\t${value}`);
  });

  console.log('\n\nFile ready at:', filepath);
} else {
  console.error('ERROR: File not created at', filepath);
}
