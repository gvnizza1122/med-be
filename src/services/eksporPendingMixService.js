/**
 * Ekspor klaim PENDING satu bulan ke Excel dengan struktur yang SAMA dengan
 * berkas ekspor "MIX" E-Klaim (mis. 3371084_20261006_MIX.TXT): 93 kolom,
 * nama dan urutan kolom persis, isi apa adanya.
 *
 * Lembar "MIX" hanya berisi kolom E-Klaim, supaya bisa dibandingkan baris per
 * baris dengan TXT aslinya. Alasan pending dan saran tindakan dari medaudit
 * ada di lembar terpisah ("Alasan Pending") dan tidak mencemari struktur MIX.
 *
 * Sumber nilai: raw_data (pembaca TXT menyimpan SEMUA kolom asli berkas),
 * dengan kolom basis data sebagai cadangan untuk klaim dari PDF yang tidak
 * punya kolom itu di raw_data. DIAGLIST/PROCLIST memakai nilai TERKINI
 * (sesudah diedit koder), bukan nilai unggahan awal.
 */

const ExcelJS = require('exceljs');
const { labelPeriode } = require('./periodeKlaimService');

const KOLOM_MIX = [
  'KODE_RS', 'KELAS_RS', 'KELAS_RAWAT', 'KODE_TARIF', 'PTD', 'ADMISSION_DATE', 'DISCHARGE_DATE', 'BIRTH_DATE',
  'BIRTH_WEIGHT', 'SEX', 'DISCHARGE_STATUS', 'DIAGLIST', 'PROCLIST', 'ADL1', 'ADL2', 'IN_SP', 'IN_SR', 'IN_SI',
  'IN_SD', 'INACBG', 'SUBACUTE', 'CHRONIC', 'SP', 'SR', 'SI', 'SD', 'DESKRIPSI_INACBG', 'TARIF_INACBG',
  'TARIF_SUBACUTE', 'TARIF_CHRONIC', 'DESKRIPSI_SP', 'TARIF_SP', 'DESKRIPSI_SR', 'TARIF_SR', 'DESKRIPSI_SI',
  'TARIF_SI', 'DESKRIPSI_SD', 'TARIF_SD', 'TOTAL_TARIF', 'TARIF_RS', 'TARIF_POLI_EKS', 'LOS', 'ICU_INDIKATOR',
  'ICU_LOS', 'VENT_HOUR', 'NAMA_PASIEN', 'MRN', 'UMUR_TAHUN', 'UMUR_HARI', 'DPJP', 'SEP', 'NOKARTU', 'PAYOR_ID',
  'CODER_ID', 'VERSI_INACBG', 'VERSI_GROUPER', 'C1', 'C2', 'C3', 'C4', 'PROSEDUR_NON_BEDAH', 'PROSEDUR_BEDAH',
  'KONSULTASI', 'TENAGA_AHLI', 'KEPERAWATAN', 'PENUNJANG', 'RADIOLOGI', 'LABORATORIUM', 'PELAYANAN_DARAH',
  'REHABILITASI', 'KAMAR_AKOMODASI', 'RAWAT_INTENSIF', 'OBAT', 'ALKES', 'BMHP', 'SEWA_ALAT', 'OBAT_KRONIS',
  'OBAT_KEMO', 'IDRG_DIAG_LISTS', 'IDRG_PROC_LISTS', 'IDRG_MDC_NUMBER', 'IDRG_MDC_DESCRIPTION', 'IDRG_DRG_CODE',
  'IDRG_DRG_DESCRIPTION', 'IDRG_COST_WEIGHT', 'IDRG_SA_COST_WEIGHT', 'IDRG_CH_COST_WEIGHT', 'IDRG_TOP_UP',
  'IDRG_TOTAL_COST_WEIGHT', 'IDRG_NBR', 'IDRG_TOTAL_TARIF', 'IDRG_GROUPER_VERSION', 'IDRG_LOGIC_VERSION',
];

// Kolom berisi besaran (tarif, biaya, lama rawat, bobot) ditulis sebagai angka
// supaya bisa dijumlah di Excel. Kolom lain -- termasuk NOKARTU, MRN, SEP,
// kode -- ditulis sebagai TEKS: nomor kartu berawalan nol akan rusak bila
// Excel menebaknya sebagai angka.
const KOLOM_ANGKA = new Set([
  'BIRTH_WEIGHT', 'TARIF_INACBG', 'TARIF_SUBACUTE', 'TARIF_CHRONIC', 'TARIF_SP', 'TARIF_SR', 'TARIF_SI', 'TARIF_SD',
  'TOTAL_TARIF', 'TARIF_RS', 'TARIF_POLI_EKS', 'LOS', 'ICU_LOS', 'VENT_HOUR', 'UMUR_TAHUN', 'UMUR_HARI',
  'PROSEDUR_NON_BEDAH', 'PROSEDUR_BEDAH', 'KONSULTASI', 'TENAGA_AHLI', 'KEPERAWATAN', 'PENUNJANG', 'RADIOLOGI',
  'LABORATORIUM', 'PELAYANAN_DARAH', 'REHABILITASI', 'KAMAR_AKOMODASI', 'RAWAT_INTENSIF', 'OBAT', 'ALKES', 'BMHP',
  'SEWA_ALAT', 'OBAT_KRONIS', 'OBAT_KEMO', 'IDRG_COST_WEIGHT', 'IDRG_SA_COST_WEIGHT', 'IDRG_CH_COST_WEIGHT',
  'IDRG_TOP_UP', 'IDRG_TOTAL_COST_WEIGHT', 'IDRG_NBR', 'IDRG_TOTAL_TARIF',
]);

// Cadangan dari kolom basis data bila raw_data tidak memuat kolom itu.
const CADANGAN_DB = {
  KODE_RS: 'kode_rs', KELAS_RAWAT: 'kelas_rawat', SEX: 'gender', DISCHARGE_STATUS: 'discharge_status',
  NAMA_PASIEN: 'nama_pasien', MRN: 'mrn', DPJP: 'dpjp_name', SEP: 'sep', NOKARTU: 'nokartu',
  TARIF_RS: 'tarif_rs', INACBG: 'inacbg_code', ADMISSION_DATE: 'admission_date',
  DISCHARGE_DATE: 'discharge_date', BIRTH_DATE: 'birth_date',
};
const KOLOM_TANGGAL = new Set(['ADMISSION_DATE', 'DISCHARGE_DATE', 'BIRTH_DATE']);
// Nilai terkini sesudah koreksi koder didahulukan atas unggahan awal.
const NILAI_TERKINI = { DIAGLIST: 'diagnosa_list', PROCLIST: 'prosedur_list' };

function parseJson(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}') || {}; } catch (_) { return {}; }
}

/** Tanggal basis data (ISO / Date) -> dd/mm/yyyy seperti di TXT E-Klaim. */
function tanggalTxt(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(String(v).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return String(v);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function angka(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  const t = String(v).trim();
  if (t === '' || t === '-') return t;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : t;
}

/** Satu baris MIX untuk satu klaim: objek {KOLOM: nilai} dalam urutan KOLOM_MIX. */
function barisMix(record) {
  const raw = parseJson(record.raw_data);
  const baris = {};
  for (const k of KOLOM_MIX) {
    let v;
    if (NILAI_TERKINI[k] && record[NILAI_TERKINI[k]] != null && String(record[NILAI_TERKINI[k]]).trim() !== '') {
      v = record[NILAI_TERKINI[k]];
    } else if (Object.prototype.hasOwnProperty.call(raw, k)) {
      v = raw[k];
    } else if (CADANGAN_DB[k] && record[CADANGAN_DB[k]] != null) {
      v = KOLOM_TANGGAL.has(k) ? tanggalTxt(record[CADANGAN_DB[k]]) : record[CADANGAN_DB[k]];
    } else {
      v = '';
    }
    baris[k] = KOLOM_ANGKA.has(k) ? angka(v) : (v == null ? '' : String(v));
  }
  return baris;
}

/** Alasan pending + saran tindakan untuk lembar kedua. */
function alasanDanSaran(record) {
  const ai = parseJson(record.ai_review);
  const putusan = ai.putusan_pending || null;
  const alasan = [];
  const saran = [];
  for (const a of (putusan && Array.isArray(putusan.alasan) ? putusan.alasan : [])) {
    if (!a) continue;
    alasan.push([a.ringkas, a.bukti ? `(${a.bukti})` : null].filter(Boolean).join(' '));
    if (a.tindakan) saran.push(a.tindakan);
  }
  const catatan = ai.field_notes || {};
  const masalahData = (record.errors || []).map(e => {
    const teks = catatan[e.field_name] || e.error_message;
    return [e.field_name ? `${e.field_name}:` : null, teks].filter(Boolean).join(' ');
  });
  const bernomor = (daftar) => daftar.filter(Boolean).map((t, i) => `${i + 1}. ${t}`).join('\n');
  return {
    ringkasan: (putusan && putusan.ringkasan) || '',
    alasan: bernomor(alasan),
    saran: bernomor(saran),
    masalah_data: bernomor(masalahData),
  };
}

/** Satu klaim per SEP: berkas yang sama sering diunggah ulang -- ambil yang terbaru. */
function satuPerSep(records) {
  const peta = new Map();
  for (const r of records || []) {
    const kunci = String(r.sep || '').trim().toUpperCase() || `tanpa-sep:${r.id}`;
    const lama = peta.get(kunci);
    if (!lama || new Date(r.created_at || 0) > new Date(lama.created_at || 0)) peta.set(kunci, r);
  }
  return [...peta.values()].sort((a, b) => String(a.sep || '').localeCompare(String(b.sep || '')));
}

async function buatEksporPendingMix(records, cakupan = {}) {
  const daftar = satuPerSep(records);
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const ws = wb.addWorksheet('MIX');
  ws.columns = KOLOM_MIX.map(k => ({
    header: k, key: k, width: Math.min(Math.max(k.length + 2, 10), 28),
    style: KOLOM_ANGKA.has(k) ? {} : { numFmt: '@' },
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of daftar) ws.addRow(barisMix(r));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (daftar.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: daftar.length + 1, column: KOLOM_MIX.length } };

  const wa = wb.addWorksheet('Alasan Pending');
  wa.columns = [
    { header: 'SEP', key: 'sep', width: 22, style: { numFmt: '@' } },
    { header: 'Nama Pasien', key: 'nama', width: 26 },
    { header: 'Status medaudit', key: 'status', width: 14 },
    { header: 'Ringkasan', key: 'ringkasan', width: 48 },
    { header: 'Alasan pending', key: 'alasan', width: 60 },
    { header: 'Saran / tindakan', key: 'saran', width: 60 },
    { header: 'Masalah data klaim', key: 'masalah_data', width: 60 },
  ];
  wa.getRow(1).font = { bold: true };
  for (const r of daftar) {
    const a = alasanDanSaran(r);
    const row = wa.addRow({ sep: r.sep || '', nama: r.nama_pasien || '', status: r.validation_status || '', ...a });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  wa.views = [{ state: 'frozen', ySplit: 1 }];

  const info = wb.addWorksheet('Keterangan');
  info.columns = [{ width: 26 }, { width: 70 }];
  [
    ['Periode', cakupan.periode ? labelPeriode(cakupan.periode) : '-'],
    ['Isi', 'Klaim berstatus pending/perlu perbaikan menurut medaudit (bukan keputusan BPJS)'],
    ['Jumlah klaim', daftar.length],
    ['Struktur lembar MIX', `${KOLOM_MIX.length} kolom, sama dengan ekspor MIX E-Klaim`],
    ['Tanggal ekspor', new Date()],
    ['Diekspor oleh', cakupan.diexportOleh || '-'],
  ].forEach(b => info.addRow(b));
  info.getColumn(1).font = { bold: true };
  info.getCell('B5').numFmt = 'dd/mm/yyyy hh:mm';

  return wb.xlsx.writeBuffer();
}

/** Nama berkas meniru pola E-Klaim: <KODE_RS>_<YYYYMM>_PENDING.xlsx */
function namaBerkasPendingMix(records, periode) {
  const kodeRs = (records || []).map(r => r.kode_rs || parseJson(r.raw_data).KODE_RS).find(Boolean) || 'RS';
  return `${kodeRs}_${String(periode || '').replace('-', '')}_PENDING.xlsx`;
}

module.exports = {
  KOLOM_MIX, KOLOM_ANGKA, barisMix, alasanDanSaran, satuPerSep,
  buatEksporPendingMix, namaBerkasPendingMix,
};
