const ExcelJS = require('exceljs');
const { keTanggal, keAngka } = require('./daftarKerjaExportService');
const { labelPeriode } = require('./periodeKlaimService');

const FORMAT_TEKS = '@';
const FORMAT_ANGKA = '#,##0';
const FORMAT_TANGGAL = 'dd/mm/yyyy';

const KOLOM = [
  ['SEP', 'sep', FORMAT_TEKS], ['No Kartu', 'nokartu', FORMAT_TEKS], ['Nama', 'nama_pasien'],
  ['No RM', 'mrn', FORMAT_TEKS], ['Tgl Lahir', 'birth_date', FORMAT_TANGGAL], ['Jenis Kelamin', 'gender'],
  ['Tgl Masuk', 'admission_date', FORMAT_TANGGAL], ['Tgl Keluar', 'discharge_date', FORMAT_TANGGAL],
  ['Kelas Rawat', 'kelas_rawat'], ['Status Keluar', 'discharge_status'], ['Lama Rawat', 'los'],
  ['Diagnosis (DIAGLIST)', 'diagnosa_list', FORMAT_TEKS], ['Prosedur (PROCLIST)', 'prosedur_list', FORMAT_TEKS],
  ['ADL1', 'ADL1', FORMAT_TEKS], ['ADL2', 'ADL2', FORMAT_TEKS], ['Kode INA-CBG', 'inacbg_code', FORMAT_TEKS],
  ['Deskripsi INA-CBG', 'deskripsi_inacbg'], ['Tarif INA-CBG', 'tarif_inacbg', FORMAT_ANGKA],
  ['SP', 'SP', FORMAT_TEKS], ['SR', 'SR', FORMAT_TEKS], ['SI', 'SI', FORMAT_TEKS], ['SD', 'SD', FORMAT_TEKS],
  ['Subakut', 'SUBACUTE', FORMAT_TEKS], ['Kronis', 'CHRONIC', FORMAT_TEKS], ['Total Tarif', 'total_tarif', FORMAT_ANGKA],
  ['Kode RS', 'kode_rs', FORMAT_TEKS], ['Kelas RS', 'kelas_rs', FORMAT_TEKS], ['Payor ID', 'payor_id', FORMAT_TEKS],
  ['DPJP', 'dpjp_name'], ['Kode Tarif', 'KODE_TARIF', FORMAT_TEKS],
].map(([header, key, format]) => ({ header, key, format }));

function ambilRaw(record, key) {
  let raw = record.raw_data;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  return (raw && (raw[key] ?? raw[key.toLowerCase()])) ?? '';
}

function susunBaris(record) {
  return Object.fromEntries(KOLOM.map(k => {
    let value = Object.prototype.hasOwnProperty.call(record, k.key) ? record[k.key] : ambilRaw(record, k.key);
    if (k.format === FORMAT_TANGGAL) value = keTanggal(value);
    if (k.format === FORMAT_ANGKA) value = keAngka(value);
    return [k.key, value ?? ''];
  }));
}

async function buatSiapSubmit(records, cakupan = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const ringkasan = workbook.addWorksheet('Ringkasan');
  ringkasan.columns = [{ width: 26 }, { width: 58 }];
  [
    ['Rumah Sakit', cakupan.namaRs || 'RS Lestari Raharja'],
    ['Periode', cakupan.periode ? labelPeriode(cakupan.periode) : 'Semua periode'],
    ['Kategori', cakupan.kategori || 'Semua kategori'],
    ['Filter saat export', cakupan.filter || 'Klaim bersih, siap submit'],
    ['Jumlah klaim', (records || []).length],
    ['Tanggal export', new Date()],
    ['Di-export oleh', cakupan.diexportOleh || '-'],
  ].forEach(row => ringkasan.addRow(row));
  ringkasan.getColumn(1).font = { bold: true };
  ringkasan.getCell('B6').numFmt = FORMAT_TANGGAL + ' hh:mm';

  const ws = workbook.addWorksheet('Data Klaim');
  ws.columns = KOLOM.map(k => ({ header: k.header, key: k.key, width: 18, style: k.format ? { numFmt: k.format } : {} }));
  ws.getRow(1).font = { bold: true };
  for (const record of records || []) ws.addRow(susunBaris(record));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if ((records || []).length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: records.length + 1, column: KOLOM.length } };
  return workbook.xlsx.writeBuffer();
}

function namaBerkasSiapSubmit(cakupan = {}) {
  const bagian = ['siap-submit'];
  if (cakupan.periode) bagian.push(cakupan.periode);
  if (cakupan.kategori) bagian.push(String(cakupan.kategori).toLowerCase().replace(/_/g, '-'));
  if (cakupan.from_date || cakupan.to_date) bagian.push(`${cakupan.from_date || 'awal'}-${cakupan.to_date || 'akhir'}`);
  if (cakupan.search) bagian.push('hasil-pencarian');
  if (cakupan.arsip) bagian.push('arsip');
  return bagian.join('_') + '.xlsx';
}

module.exports = { buatSiapSubmit, namaBerkasSiapSubmit, susunBaris, KOLOM };
