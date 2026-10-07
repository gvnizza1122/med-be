const { nilaiKelengkapanAnalisis } = require('./kelengkapanAnalisisService');
const ULANG = new Set(['review_ai', 'tinjauan_diagnosis', 'penalaran_diagnosis', 'pemeriksa_kritis', 'kegawatdaruratan', 'putusan', 'pemeriksaan_lanjutan']);
async function analisisDenganPemulihan(baca) {
  const awal = await baca();
  const statusAwal = nilaiKelengkapanAnalisis(awal);
  if (!statusAwal.alasan.some(a => ULANG.has(a.kode))) return awal;
  let ulang;
  try { ulang = await baca(); } catch (_) { /* Pertahankan hasil awal jika percobaan pemulihan gagal. */ }
  const statusUlang = nilaiKelengkapanAnalisis(ulang);
  const hasil = ulang && statusUlang.alasan.length < statusAwal.alasan.length ? ulang : awal;
  if (!hasil) return hasil;
  return { ...hasil, pemulihan_analisis: { dicoba: true, berhasil: statusUlang.status === 'lengkap',
    alasan_awal: statusAwal.alasan.map(a => a.kode) } };
}
module.exports = { analisisDenganPemulihan };
