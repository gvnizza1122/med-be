/** PTD: 1 rawat inap, 2 rawat jalan. Tidak mengambil jenis dari hasil CBG. */
function normalJenis(v) {
  const s = String(v ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['1', 'RI', 'RITL', 'RAWAT_INAP'].includes(s)) return 'RAWAT_INAP';
  if (['2', 'RJ', 'RJTL', 'RAWAT_JALAN'].includes(s)) return 'RAWAT_JALAN';
  return null;
}
function jenisLayanan(record = {}) {
  const raw = record._rawData || {};
  const ptd = String(raw.PTD ?? record.PTD ?? record.ptd ?? '').trim();
  const eksplisit = record.jenis_klaim || record.JENIS_KLAIM || record.jenis_rawat || record.JENIS_RAWAT;
  const jenisEksplisit = normalJenis(eksplisit);
  if (ptd && !['1', '2'].includes(ptd)) return { jenis: null, masalah: 'PTD harus 1 (rawat inap) atau 2 (rawat jalan).' };
  if (ptd && jenisEksplisit && normalJenis(ptd) !== jenisEksplisit) return { jenis: null, masalah: 'PTD berbeda dengan jenis layanan tertulis.' };
  if (eksplisit && !jenisEksplisit) return { jenis: null, masalah: 'Jenis layanan tertulis tidak dikenali.' };
  return { jenis: normalJenis(ptd) || jenisEksplisit, sumber: ptd ? 'PTD' : jenisEksplisit ? 'jenis_layanan_tertulis' : null };
}
module.exports = { jenisLayanan, normalJenis };
