/**
 * Kamus iDRG: kode tambahan ICD-10 2010 dan ICD-9-CM 2010 Indonesian
 * Modification (IM) yang dipakai grouper iDRG (INA-Grouper) Kemenkes, plus
 * konversi koding INA-CBG -> iDRG.
 *
 * iDRG = ICD-10 WHO 2010 + kode IM (diagnosis) dan ICD-9-CM 2010 + kode IM
 * (prosedur). Kamus WHO / ICD-9-CM sudah ada (kamusKodeService); di sini hanya
 * tambahan IM-nya, dibaca dari berkas JSON (bukan tabel) supaya tetap jalan
 * tanpa seed basis data.
 *
 * BATASAN DATA (lihat src/data/icdImIdrg.json `_keterangan`): sumbernya
 * salinan publik daftar IM Kemenkes, bukan unduhan resmi kemkes.go.id, dan
 * daftar PROSEDUR IM-nya belum lengkap (282 dari +-902). Karena itu kode
 * yang tidak ada di sini TIDAK pernah dinyatakan salah oleh layanan ini.
 *
 * Kemiripan awalan kode tidak membuktikan padanan klinis. Daftar ini
 * belum memuat crosswalk yang terverifikasi; kode dasar tidak dikonversi
 * otomatis ke entri IM dan kode IM tidak dipotong menjadi kode INA-CBG.
 */

const data = require('../data/icdImIdrg.json');
const { deskripsiDiagnosis, deskripsiProsedur } = require('./kamusKodeService');

const normal = (k) => String(k || '').trim().toUpperCase();

const IM = {
  diagnosis: new Map(data.diagnosis.map(r => [normal(r.kode), r])),
  prosedur: new Map(data.prosedur.map(r => [normal(r.kode), r])),
};

const deskripsiDasar = (kode, jenis) => (jenis === 'prosedur' ? deskripsiProsedur(kode) : deskripsiDiagnosis(kode)) || null;

/** Entri IM untuk kode ini, atau null. */
function kodeIm(kode, jenis = 'diagnosis') {
  return (IM[jenis] || IM.diagnosis).get(normal(kode)) || null;
}

/**
 * Entri IM dengan awalan serupa, untuk mendeteksi kebutuhan verifikasi.
 * Hasil ini tidak boleh diperlakukan sebagai padanan atau pilihan kode.
 */
function turunanIm(kode, jenis = 'diagnosis') {
  const k = normal(kode);
  if (!k) return [];
  const awalan = /\./.test(k) ? k : (jenis === 'diagnosis' ? `${k}.` : k);
  const hasil = [];
  for (const [kd, r] of (IM[jenis] || IM.diagnosis)) {
    if (kd !== k && kd.startsWith(awalan)) hasil.push({ kode: r.kode, deskripsi: r.deskripsi });
  }
  return hasil.sort((a, b) => a.kode.localeCompare(b.kode));
}

/** Entri IM yang awalan angkanya serupa bukan crosswalk terverifikasi. */
function padananInacbg(kode, jenis = 'diagnosis') {
  const k = normal(kode);
  return deskripsiDasar(k, jenis) ? k : null;
}

/** Status kamus, bukan penetapan kelayakan kode di mesin grouper iDRG. */
function statusIdrg(kode, jenis = 'diagnosis') {
  const k = normal(kode);
  const im = kodeIm(k, jenis);
  if (im) {
    return { kode: k, status: 'im', kode_idrg: k, deskripsi: im.deskripsi,
      padanan_inacbg: padananInacbg(k, jenis), kandidat: [],
      catatan: 'Entri ditemukan dalam salinan kamus IM; cocokkan makna dan versi dengan E-Klaim.' };
  }
  const dasar = deskripsiDasar(k, jenis);
  if (dasar && turunanIm(k, jenis).length) {
    return { kode: k, status: 'perlu_verifikasi', kode_idrg: null, deskripsi: dasar,
      padanan_inacbg: k, kandidat: [],
      catatan: 'Ada entri IM dengan awalan serupa, tetapi belum ada crosswalk terverifikasi. Kode asli dipertahankan; periksa definisi dan bukti klinis di E-Klaim.' };
  }
  if (dasar) return { kode: k, status: 'sama', kode_idrg: k, deskripsi: dasar, padanan_inacbg: k, kandidat: [] };
  return { kode: k, status: 'tidak_dikenal', kode_idrg: null, deskripsi: null, padanan_inacbg: null, kandidat: [] };
}

const pisahKode = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,#]/))
  .map(s => normal(String(s).replace(/\+\d+$/, ''))).filter(s => s && s !== '-');

/** Konversi DIAGLIST/PROCLIST ke pandangan iDRG. */
function konversiKeIdrg(diaglist, proclist) {
  const diagnosis = [...new Set(pisahKode(diaglist))].map(k => statusIdrg(k, 'diagnosis'));
  const prosedur = [...new Set(pisahKode(proclist))].map(k => statusIdrg(k, 'prosedur'));
  const perluDipilih = [...diagnosis, ...prosedur].filter(x => x.status === 'perlu_verifikasi').length;
  return {
    diagnosis,
    prosedur,
    lengkap: perluDipilih === 0 && ![...diagnosis, ...prosedur].some(x => x.status === 'tidak_dikenal'),
    catatan: [
      'Pencocokan kamus belum membuktikan kesiapan untuk klaim iDRG. Daftar IM yang tersedia belum lengkap.',
      perluDipilih ? `${perluDipilih} kode memerlukan verifikasi padanan di E-Klaim; kemiripan awalan kode tidak cukup untuk konversi.` : null,
      prosedur.length ? 'iDRG juga mencatat jumlah tindakan (mis. 86.28+2); periksa jumlahnya di dokumen.' : null,
    ].filter(Boolean),
  };
}

module.exports = {
  kodeIm, turunanIm, padananInacbg, statusIdrg, konversiKeIdrg,
  SUMBER: data._keterangan,
  JUMLAH: { diagnosis: IM.diagnosis.size, prosedur: IM.prosedur.size },
};
