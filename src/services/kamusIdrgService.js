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
 * Arah konversi:
 *   iDRG -> INA-CBG mudah (kode IM S73.02 -> induk WHO S73.0).
 *   INA-CBG -> iDRG TIDAK bisa dipastikan dari kode saja: S73.0 punya
 *   turunan IM S73.00..S73.0x dan pilihan yang benar bergantung pada isi
 *   resume. Layanan ini hanya menyebut kandidatnya; tidak pernah memilihkan.
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
 * Kode IM yang lebih rinci dari `kode`: S73.0 -> S73.00, S73.01, ...;
 * kategori J45 -> J45.3. Kode IM itu sendiri tidak termasuk.
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

/**
 * Padanan INA-CBG (WHO / ICD-9-CM) untuk kode IM: induk terdekat yang ada di
 * kamus dasar (S73.02 -> S73.0). Null bila induknya hanya kategori yang punya
 * subkode lain (J45.3 -> J45 tidak bisa dipakai di INA-CBG) -- tidak ditebak.
 */
function padananInacbg(kode, jenis = 'diagnosis') {
  let k = normal(kode);
  while (k.length > 2) {
    k = k.slice(0, -1).replace(/\.$/, '');
    // Induk yang masih punya subkode di kamus dasar hanyalah judul kelompok
    // (J45, 36.0), bukan kode akhir yang boleh ditagihkan -- jangan ditebak.
    if (deskripsiDasar(k, jenis)) return punyaSubkodeDasar(k, jenis) ? null : k;
  }
  return null;
}

function punyaSubkodeDasar(k, jenis) {
  const awalan = k.includes('.') ? k : `${k}.`;
  for (let d = 0; d <= 9; d++) if (deskripsiDasar(`${awalan}${d}`, jenis)) return true;
  return false;
}

/**
 * Status satu kode terhadap iDRG:
 *   im            -- kode IM (sah di iDRG); padanan_inacbg = induk WHO bila pasti
 *   perlu_dipilih -- kode dasar yang punya turunan IM lebih rinci; kandidat disertakan
 *   sama          -- kode dasar tanpa turunan IM: kode iDRG = kode yang sama
 *   tidak_dikenal -- tidak ada di kamus dasar maupun daftar IM yang dimiliki
 */
function statusIdrg(kode, jenis = 'diagnosis') {
  const k = normal(kode);
  const im = kodeIm(k, jenis);
  if (im) {
    return { kode: k, status: 'im', kode_idrg: k, deskripsi: im.deskripsi, padanan_inacbg: padananInacbg(k, jenis), kandidat: [] };
  }
  const dasar = deskripsiDasar(k, jenis);
  const kandidat = turunanIm(k, jenis);
  if (dasar && kandidat.length) {
    return { kode: k, status: 'perlu_dipilih', kode_idrg: null, deskripsi: dasar, padanan_inacbg: k, kandidat };
  }
  if (dasar) return { kode: k, status: 'sama', kode_idrg: k, deskripsi: dasar, padanan_inacbg: k, kandidat: [] };
  return { kode: k, status: 'tidak_dikenal', kode_idrg: null, deskripsi: null, padanan_inacbg: null, kandidat };
}

const pisahKode = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,#]/))
  .map(s => normal(String(s).replace(/\+\d+$/, ''))).filter(s => s && s !== '-');

/** Konversi DIAGLIST/PROCLIST ke pandangan iDRG. */
function konversiKeIdrg(diaglist, proclist) {
  const diagnosis = [...new Set(pisahKode(diaglist))].map(k => statusIdrg(k, 'diagnosis'));
  const prosedur = [...new Set(pisahKode(proclist))].map(k => statusIdrg(k, 'prosedur'));
  const perluDipilih = [...diagnosis, ...prosedur].filter(x => x.status === 'perlu_dipilih').length;
  return {
    diagnosis,
    prosedur,
    lengkap: perluDipilih === 0 && ![...diagnosis, ...prosedur].some(x => x.status === 'tidak_dikenal'),
    catatan: [
      perluDipilih ? `${perluDipilih} kode punya versi iDRG yang lebih rinci; pilih sesuai isi resume.` : null,
      prosedur.length ? 'iDRG juga mencatat jumlah tindakan (mis. 86.28+2); periksa jumlahnya di dokumen.' : null,
    ].filter(Boolean),
  };
}

module.exports = {
  kodeIm, turunanIm, padananInacbg, statusIdrg, konversiKeIdrg,
  SUMBER: data._keterangan,
  JUMLAH: { diagnosis: IM.diagnosis.size, prosedur: IM.prosedur.size },
};
