/** Usia pada awal episode. Data kosong/bertentangan tidak menjadi usia nol/dewasa. */
const { tanggalSah } = require('./profilKlaimRsService');
const objek = v => { if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch { return {}; } } return v || {}; };
function tanggal(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (!v) return null;
  const s = String(v).slice(0, 10), m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s);
  const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : s;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && tanggalSah(iso) ? iso : null;
}
function angka(...values) {
  const v = values.find(x => x !== null && x !== undefined && String(x).trim() !== '');
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function resolveUsia(record = {}) {
  const raw = objek(record.raw_data);
  const unknown = alasan => ({ tahun: null, bulan: null, hari: null, kelompok: 'belum_terkonfirmasi', alasan });
  const birthRaw = record.birth_date || record.BIRTH_DATE || raw.BIRTH_DATE;
  const episodeRaw = record.admission_date || record.ADMISSION_DATE || raw.ADMISSION_DATE
    || record.discharge_date || record.DISCHARGE_DATE || raw.DISCHARGE_DATE;
  const birth = tanggal(birthRaw), episode = tanggal(episodeRaw);
  const years = angka(record.UMUR_TAHUN, record.umur_tahun, raw.UMUR_TAHUN);
  const days = angka(record.UMUR_HARI, record.umur_hari, raw.UMUR_HARI);
  let tahun = years === null ? null : Math.floor(years), bulan = years === null ? null : years >= 1 ? Math.floor(years) * 12 : null, hari = null;
  const months = angka(record.UMUR_BULAN, record.umur_bulan, raw.UMUR_BULAN);
  if (months !== null && years !== null && months < 12) bulan = Math.floor(years)*12 + Math.floor(months);
  let sumber = 'umur_tercatat';
  if ((birthRaw && !birth) || (episodeRaw && !episode)) return unknown('Tanggal lahir/episode tidak sah; konfirmasi usia.');
  if (birth && episode) {
    if (birth > episode) return unknown('Tanggal lahir sesudah awal episode; konfirmasi usia.');
    const [y1,m1,d1] = birth.split('-').map(Number), [y2,m2,d2] = episode.split('-').map(Number);
    bulan = (y2-y1)*12 + m2-m1 - (d2 < d1 ? 1 : 0);
    tahun = y2-y1 - (episode.slice(5) < birth.slice(5) ? 1 : 0);
    hari = (Date.parse(episode)-Date.parse(birth))/86400000;
    sumber = 'tanggal_lahir_dan_awal_episode';
    if (years !== null && Math.floor(years) !== tahun) return unknown('Umur tercatat bertentangan dengan tanggal lahir pada awal episode.');
  } else if (days !== null && (years === null || years < 1)) {
    hari = days;
    // Hari cukup untuk membuktikan neonatus/bayi; jangan mengarang usia bulan/tahun presisi.
    if (days < 365) {
      tahun = 0;
    }
  }
  if (tahun === null || tahun > 130) return unknown('Usia pasien belum terbaca.');
  return { tahun, bulan, hari, kelompok: tahun >= 18 ? 'dewasa' : hari !== null && hari < 28 ? 'neonatus' : 'anak', sumber, alasan: null };
}
function cakupanUsia(aturan, usia) {
  const terbatas = aturan.usia_min !== undefined || aturan.usia_max !== undefined || aturan.neonatus;
  if (!terbatas) return true;
  if (usia.tahun === null) return null;
  if (aturan.neonatus) return usia.hari === null ? (usia.tahun >= 1 ? false : null) : usia.hari < 28;
  return !(aturan.usia_min !== undefined && usia.tahun < aturan.usia_min)
    && !(aturan.usia_max !== undefined && usia.tahun > aturan.usia_max);
}
module.exports = { resolveUsia, cakupanUsia, tanggal };
