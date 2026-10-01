/** Penilaian untuk tampilan: tidak menulis kode, status, tarif, atau data pasien. */
const { evaluasiKombinasiKode } = require('./ketentuanKlaimService');
const { susunPutusan, segarkanAlasanValidasi } = require('./putusanPendingService');

function objek(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function perbaruiRisikoTampilan(record = {}, errors = []) {
  const ai = objek(record.ai_review);
  const raw = objek(record.raw_data);
  const sep = String(record.sep || record.SEP || raw.SEP || '').trim();
  const penjaminan = sep && !/^(0|-|null|undefined|n\/a)$/i.test(sep)
    ? { jenis: 'BPJS', dasar: 'SEP', catatan: 'Penjamin BPJS mengikuti SEP. Label UMUM pada resume tidak menjadi alasan pending.' }
    : null;
  const kombinasi = evaluasiKombinasiKode(record.diagnosa_list ?? record.DIAGLIST ?? raw.DIAGLIST ?? '');
  const konsistensi = (ai.konsistensi_data || []).filter(k => k && k.id !== 'KD-02');
  let putusan = ai.putusan_pending;
  if (!putusan || !Array.isArray(putusan.alasan)) {
    putusan = Object.keys(ai).length || kombinasi.length || errors.length
      ? susunPutusan({ ...ai, konsistensi_data: konsistensi, kombinasi_kode: kombinasi }, errors) : null;
  } else {
    putusan = segarkanAlasanValidasi(putusan, errors) || putusan;
    // Evaluasi kombinasi dari kode tersimpan saat ini, bukan dari saran AI.
    // Alasan klinis lain yang dipilih sebelumnya tetap dibawa.
    const sisa = putusan.alasan.filter(a => a && a.kode !== 'KD-02' && a.sumber_pemeriksaan !== 'Ketentuan kombinasi kode');
    const alasan = [...sisa, ...susunPutusan({ kombinasi_kode: kombinasi }).alasan];
    const berubah = JSON.stringify(alasan) !== JSON.stringify(putusan.alasan);
    if (berubah) {
      const berat = alasan.filter(a => a.wajib_pending || ['tinggi', 'critical'].includes(a.keparahan));
      const status = berat.length ? 'berisiko_pending' : alasan.length ? 'perlu_dicek' : 'tidak_ditemukan_alasan';
      putusan = {
        ...putusan, status, alasan,
        ringkasan: berat.length ? `Ada ${berat.length} hal yang berisiko membuat klaim ini dipending.`
          : alasan.length ? `Ada ${alasan.length} hal yang perlu diperiksa sebelum upload.` : 'Belum ada temuan risiko tambahan.',
        jumlah: { ...putusan.jumlah, total: alasan.length, berat: berat.length, dari_rekap_pending: alasan.filter(a => a.dari_rekap_pending).length },
        sumber_pembaruan: 'aturan_saat_ini',
      };
    }
  }
  return {
    ...ai,
    konsistensi_data: konsistensi,
    kombinasi_kode: kombinasi,
    putusan_pending: putusan,
    penjaminan,
    kesiapan_koding: {
      status: kombinasi.length ? 'berisiko_pending' : 'tidak_ada_temuan_kombinasi',
      judul: kombinasi.length ? 'Berisiko pending · belum siap upload' : 'Tidak ada temuan kombinasi kode',
      alasan: kombinasi.map(k => ({ kode: k.kode, nama: k.nama, pesan: k.pesan, kode_asal: [...k.kode_utama, ...k.kode_terdampak], kode_saran: k.kode_gabungan })),
    },
  };
}
module.exports = { perbaruiRisikoTampilan };
