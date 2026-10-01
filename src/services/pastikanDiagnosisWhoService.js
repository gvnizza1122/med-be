const { petakanKeKodeWho } = require('./kodeDiagnosisWhoService');
const { periksaKode, STATUS } = require('./validasiKamusService');

/**
 * Pastikan setiap kode DIAGLIST ada di kamus WHO; kode tanpa padanan tetap ditandai.
 *
 * 2026-10-01 (kasus Eifelin J45.3):
 *  - Kamus yang tidak terbaca / kosong TIDAK lagi dianggap "kode tidak ada".
 *    DIAGLIST dibiarkan apa adanya, tanpa penggantian dan tanpa tuduhan
 *    kode_luar_kamus; statusKamus = 'tidak_tersedia' supaya pemanggil bisa
 *    menampilkan "Validasi kamus belum tersedia".
 *  - Konteks pemetaan per kode: `opsi.konteksPerKode[KODE]` (kutipan dokumen
 *    tempat kode itu tercetak, mis. "J45.3 - Asthma with Exacerbation (IM)")
 *    didahulukan di depan teks diagnosis umum. Sebelumnya hanya teks saran AI
 *    yang dipakai -- kalau AI tidak menyarankan apa pun, pemetaan buta.
 *  - Setiap penggantian otomatis dicatat (kode_asal, kode_baru, sumber, waktu)
 *    supaya bisa diaudit; kebijakan tetap "ganti otomatis" sesuai keputusan
 *    pemilik proyek.
 */
async function pastikanDiagnosisWho(db, diaglist, teksDiagnosis = '', opsi = {}) {
  const kodeAsli = String(diaglist || '').split(/[;,]/).map(k => k.trim().toUpperCase()).filter(Boolean);
  const konteksPerKode = opsi.konteksPerKode || {};
  const sekarang = opsi.waktu || new Date().toISOString();

  const periksa = await periksaKode(db, kodeAsli, 'diagnosis');
  if (periksa.status === 'tidak_tersedia') {
    console.warn(`[PastikanWho] Kamus WHO tidak tersedia (${periksa.alasan}); DIAGLIST tidak diubah.`);
    return {
      diaglist: String(diaglist || ''),
      kodeLuarKamus: [],
      penggantian: [],
      statusKamus: 'tidak_tersedia',
      alasanKamus: periksa.alasan,
      dataset: periksa.dataset,
    };
  }

  const hasil = [];
  const kodeLuarKamus = [];
  const penggantian = [];

  for (const kode of kodeAsli) {
    if (periksa.hasil[kode] === STATUS.VALID) {
      hasil.push(kode);
      continue;
    }

    const konteks = [konteksPerKode[kode], teksDiagnosis].filter(Boolean).join(' ');
    let pemetaan = null;
    try {
      pemetaan = await petakanKeKodeWho(kode, konteks, opsi.dikenal || {});
    } catch (err) {
      console.warn(`[PastikanWho] Pemetaan ${kode} gagal: ${err.message}`);
    }

    const kodeBaru = pemetaan && pemetaan.kode ? String(pemetaan.kode).toUpperCase() : null;
    const cekBaru = kodeBaru ? await periksaKode(db, [kodeBaru], 'diagnosis') : null;
    if (cekBaru && cekBaru.status === 'tidak_tersedia') {
      return { diaglist: String(diaglist || ''), kodeLuarKamus: [], penggantian: [],
        statusKamus: 'tidak_tersedia', alasanKamus: cekBaru.alasan, dataset: cekBaru.dataset };
    }
    if (kodeBaru && cekBaru && cekBaru.hasil[kodeBaru] === STATUS.VALID) {
      hasil.push(kodeBaru);
      penggantian.push({
        kode_asal: kode,
        kode_baru: kodeBaru,
        sumber: konteksPerKode[kode] ? 'kutipan_dokumen' : (teksDiagnosis ? 'teks_diagnosis' : 'pemetaan_kode'),
        konteks: konteks ? konteks.slice(0, 300) : null,
        bukti: (opsi.buktiPerKode || {})[kode] || [],
        dataset: periksa.dataset,
        kamus: periksa.dataset.nama,
        waktu: sekarang,
      });
    } else {
      hasil.push(kode);
      kodeLuarKamus.push({
        kode,
        jenis: 'diagnosis',
        status: 'kode_luar_kamus',
        pesan: `Kode diagnosis "${kode}" tidak ada di ICD-10 WHO dan belum punya padanan pasti. BPJS hanya mengenal ICD-10 WHO, bukan ICD-10-CM.`,
      });
    }
  }

  return {
    diaglist: [...new Set(hasil)].join(';'),
    kodeLuarKamus,
    penggantian,
    statusKamus: 'tersedia',
    alasanKamus: null,
    dataset: periksa.dataset,
  };
}

module.exports = { pastikanDiagnosisWho };
