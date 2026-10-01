const gatewayModelService = require('./gatewayModelService');

const STATUS_VALID = new Set([
  'berisiko_pending',
  'perlu_dicek',
  'tidak_ditemukan_alasan',
]);

const SYSTEM = [
  'Anda menilai apakah klaim berisiko dipending BPJS berdasarkan kandidat alasan yang diberikan.',
  'Anda hanya boleh memilih alasan dari daftar kandidat. Jangan membuat alasan, bukti, kutipan, kode, atau aturan baru.',
  'Jangan mengubah teks alasan. Alasan yang dipilih akan ditampilkan persis dari data aplikasi.',
  'Pilih status berisiko_pending jika ada kandidat yang secara langsung berisiko menyebabkan pending.',
  'Pilih perlu_dicek jika ada kandidat relevan tetapi belum cukup untuk menyimpulkan risiko pending.',
  'Pilih tidak_ditemukan_alasan hanya jika tidak ada kandidat yang relevan.',
  'Kembalikan JSON saja: {"status":"berisiko_pending|perlu_dicek|tidak_ditemukan_alasan","alasan_ids":["kandidat-1"]}.',
].join(' ');

function buatPrompt(alasan) {
  const kandidat = alasan.map((a, i) => ({
    id: `kandidat-${i + 1}`,
    sumber_pemeriksaan: a.sumber_pemeriksaan,
    kode: a.kode,
    ringkas: a.ringkas,
    penjelasan: a.penjelasan || null,
    keparahan_sinyal_awal: a.keparahan,
    bukti: a.bukti,
    tindakan: a.tindakan,
    dari_rekap_pending: a.dari_rekap_pending === true,
  }));
  return `Nilai kandidat alasan berikut. Keluaran harus memakai id kandidat yang persis ada.\n${JSON.stringify(kandidat)}`;
}

function bentukPutusan(putusanKandidat, keputusan, metadata = {}) {
  if (!putusanKandidat || !keputusan || !STATUS_VALID.has(keputusan.status) || !Array.isArray(keputusan.alasan_ids)) {
    return { ok: false, error: 'Format keputusan AI tidak sah' };
  }

  const indeks = new Map(putusanKandidat.alasan.map((alasan, i) => [`kandidat-${i + 1}`, alasan]));
  const ids = [...new Set(keputusan.alasan_ids)];
  if (ids.some(id => !indeks.has(id))) return { ok: false, error: 'Keputusan AI merujuk kandidat yang tidak tersedia' };
  if (keputusan.status === 'berisiko_pending' && ids.length === 0) {
    return { ok: false, error: 'Keputusan berisiko harus memiliki alasan dari kandidat' };
  }
  if (keputusan.status === 'perlu_dicek' && ids.length === 0) {
    return { ok: false, error: 'Keputusan perlu_dicek harus memiliki alasan dari kandidat' };
  }
  if (keputusan.status === 'tidak_ditemukan_alasan' && ids.length > 0) {
    return { ok: false, error: 'Putusan bersih tidak boleh memuat alasan terpilih' };
  }
  if (putusanKandidat.alasan.length === 0 && keputusan.status !== 'tidak_ditemukan_alasan') {
    return { ok: false, error: 'Tidak ada kandidat pendukung untuk status yang dipilih' };
  }

  // Alasan wajib (mis. kunjungan IGD tanpa kriteria kegawatdaruratan) tidak
  // boleh digugurkan AI: selalu ikut, dan statusnya selalu berisiko_pending.
  const wajib = putusanKandidat.alasan.filter(a => a && a.wajib_pending === true);
  const alasan = [...new Set([...wajib, ...ids.map(id => indeks.get(id))])];
  const status = wajib.length > 0 ? 'berisiko_pending' : keputusan.status;
  const ringkasan = status === 'berisiko_pending'
    ? `AI menilai ada ${alasan.length} alasan yang berisiko membuat klaim ini dipending.`
    : status === 'perlu_dicek'
      ? `AI memilih ${alasan.length} hal yang perlu diperiksa lebih lanjut.`
      : 'AI tidak menemukan alasan pending dari pemeriksaan yang tersedia.';

  return {
    ok: true,
    putusan: {
      ...putusanKandidat,
      status,
      ringkasan,
      alasan,
      jumlah: {
        total: alasan.length,
        berat: alasan.filter(a => ['tinggi', 'critical'].includes(String(a.keparahan).toLowerCase())).length,
        dari_rekap_pending: alasan.filter(a => a.dari_rekap_pending).length,
      },
      sumber_keputusan: 'ai',
      model: metadata.model || null,
      penyedia: metadata.penyedia || null,
      peringatan_model: metadata.peringatan || null,
      catatan_keandalan: 'Catatan: keputusan status dan pemilihan alasan berasal dari AI berdasarkan temuan dan bukti yang tersedia. Ini bukan keputusan BPJS; ketepatannya belum pernah terukur.',
    },
  };
}

async function putuskanDenganAi(putusanKandidat, { dikenal = {}, db = null, gateway = gatewayModelService } = {}) {
  if (!putusanKandidat || !Array.isArray(putusanKandidat.alasan)) {
    return { ok: false, error: 'Kandidat alasan tidak sah' };
  }

  const hasil = await gateway.panggilModel('putuskan_pending', {
    system: SYSTEM,
    prompt: buatPrompt(putusanKandidat.alasan),
    json: true,
    maxTokens: 900,
    dikenal,
  }, { db });

  if (!hasil || !hasil.ok) return { ok: false, error: hasil && hasil.error ? hasil.error : 'Gateway keputusan AI gagal' };
  const terbentuk = bentukPutusan(putusanKandidat, hasil.hasil, hasil);
  return terbentuk.ok ? { ...terbentuk, penggunaan: hasil.penggunaan || {} } : terbentuk;
}

module.exports = { putuskanDenganAi, bentukPutusan, buatPrompt };
