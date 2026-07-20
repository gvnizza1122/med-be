// Skema vClaim asli — diturunkan dari output vClaim nyata (3371084_*.TXT, 244+251 record).
// Urutan kolom WAJIB persis seperti ini (output TSV vClaim).
// default = nilai placeholder yang dipakai vClaim saat kolom kosong.
// source: 'pdf'    = bisa diekstrak dari halaman Berkas Klaim Individual
//         'const'  = nilai tetap
//         'system' = digenerate sistem E-Klaim/vClaim, TIDAK ADA di PDF

const VCLAIM_SCHEMA = [
  { name: 'KODE_RS',          default: '',      source: 'pdf' },
  { name: 'KELAS_RS',         default: '',      source: 'pdf' },
  { name: 'KELAS_RAWAT',      default: '',      source: 'pdf' },
  { name: 'KODE_TARIF',       default: '',      source: 'pdf' },
  { name: 'PTD',              default: '1',     source: 'const' },
  { name: 'ADMISSION_DATE',   default: '',      source: 'pdf' },
  { name: 'DISCHARGE_DATE',   default: '',      source: 'pdf' },
  { name: 'BIRTH_DATE',       default: '',      source: 'pdf' },
  { name: 'BIRTH_WEIGHT',     default: '0',     source: 'pdf' },
  { name: 'SEX',              default: '',      source: 'pdf' },
  { name: 'DISCHARGE_STATUS', default: '',      source: 'pdf' },
  { name: 'DIAGLIST',         default: '',      source: 'pdf' },
  { name: 'PROCLIST',         default: '',      source: 'pdf' },
  { name: 'ADL1',             default: '-',     source: 'pdf' },
  { name: 'ADL2',             default: '-',     source: 'pdf' },
  { name: 'IN_SP',            default: 'None',  source: 'pdf' },
  { name: 'IN_SR',            default: 'None',  source: 'pdf' },
  { name: 'IN_SI',            default: 'None',  source: 'pdf' },
  { name: 'IN_SD',            default: 'None',  source: 'pdf' },
  { name: 'INACBG',           default: '',      source: 'pdf' },
  { name: 'SUBACUTE',         default: 'None',  source: 'pdf' },
  { name: 'CHRONIC',          default: 'None',  source: 'pdf' },
  { name: 'SP',               default: 'None',  source: 'pdf' },
  { name: 'SR',               default: 'None',  source: 'pdf' },
  { name: 'SI',               default: 'None',  source: 'pdf' },
  { name: 'SD',               default: 'None',  source: 'pdf' },
  { name: 'DESKRIPSI_INACBG', default: '',      source: 'pdf' },
  { name: 'TARIF_INACBG',     default: '',      source: 'pdf' },
  { name: 'TARIF_SUBACUTE',   default: '0',     source: 'pdf' },
  { name: 'TARIF_CHRONIC',    default: '0',     source: 'pdf' },
  { name: 'DESKRIPSI_SP',     default: '-',     source: 'pdf' },
  { name: 'TARIF_SP',         default: '0',     source: 'pdf' },
  { name: 'DESKRIPSI_SR',     default: '-',     source: 'pdf' },
  { name: 'TARIF_SR',         default: '0',     source: 'pdf' },
  { name: 'DESKRIPSI_SI',     default: '-',     source: 'pdf' },
  { name: 'TARIF_SI',         default: '0',     source: 'pdf' },
  { name: 'DESKRIPSI_SD',     default: '-',     source: 'pdf' },
  { name: 'TARIF_SD',         default: '0',     source: 'pdf' },
  { name: 'TOTAL_TARIF',      default: '',      source: 'pdf' },
  // TARIF_RS = tarif rumah sakit sendiri, BUKAN tarif INA-CBG. Tidak ada di halaman
  // Berkas Klaim Individual → JANGAN diisi dari TOTAL_TARIF (itu nilai palsu).
  { name: 'TARIF_RS',         default: '',      source: 'system' },
  { name: 'TARIF_POLI_EKS',   default: '0',     source: 'pdf' },
  { name: 'LOS',              default: '',      source: 'pdf' },
  { name: 'ICU_INDIKATOR',    default: '0',     source: 'pdf' },
  { name: 'ICU_LOS',          default: '0',     source: 'pdf' },
  { name: 'VENT_HOUR',        default: '0',     source: 'pdf' },
  { name: 'NAMA_PASIEN',      default: '',      source: 'pdf' },
  { name: 'MRN',              default: '',      source: 'pdf' },
  { name: 'UMUR_TAHUN',       default: '0',     source: 'pdf' },
  { name: 'UMUR_HARI',        default: '',      source: 'pdf' },
  { name: 'DPJP',             default: '',      source: 'pdf' },
  { name: 'SEP',              default: '',      source: 'pdf' },
  { name: 'NOKARTU',          default: '',      source: 'pdf' },
  { name: 'PAYOR_ID',         default: '3;JKN', source: 'const' },
  { name: 'CODER_ID',         default: '',      source: 'system' },
  { name: 'VERSI_INACBG',     default: '',      source: 'system' },
  { name: 'VERSI_GROUPER',    default: '',      source: 'system' },
  { name: 'C1',               default: '',      source: 'system' },
  { name: 'C2',               default: '',      source: 'system' },
  { name: 'C3',               default: '',      source: 'system' },
  { name: 'C4',               default: '',      source: 'system' },
];

const COLUMNS = VCLAIM_SCHEMA.map(c => c.name);
const PDF_FIELDS = VCLAIM_SCHEMA.filter(c => c.source === 'pdf').map(c => c.name);
const SYSTEM_FIELDS = VCLAIM_SCHEMA.filter(c => c.source === 'system').map(c => c.name);

// Bangun 1 record lengkap 60 kolom: isi dari AI, sisanya pakai default vClaim.
function buildRecord(extracted = {}) {
  const rec = {};
  for (const col of VCLAIM_SCHEMA) {
    const v = extracted[col.name];
    rec[col.name] = (v === undefined || v === null || String(v).trim() === '')
      ? col.default
      : String(v).trim();
  }
  return rec;
}

// Serialize ke baris TSV sesuai urutan kolom vClaim.
function toTSV(records, includeHeader = true) {
  const list = Array.isArray(records) ? records : [records];
  const lines = list.map(r => COLUMNS.map(c => r[c] ?? '').join('\t'));
  return (includeHeader ? [COLUMNS.join('\t'), ...lines] : lines).join('\n');
}

module.exports = { VCLAIM_SCHEMA, COLUMNS, PDF_FIELDS, SYSTEM_FIELDS, buildRecord, toTSV };
