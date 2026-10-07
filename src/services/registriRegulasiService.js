/**
 * Registri regulasi: sumber, nomor, versi, dan masa berlaku setiap aturan
 * yang dipakai Agen Casemix (src/data/registriRegulasi.json), ditambah
 * butir-butir aturan dari berkas data (syarat penunjang, kombinasi kode).
 * Tanpa AI; pencarian kata kunci sederhana.
 */
const registri = require('../data/registriRegulasi.json');
const katalogKlaim = require('../data/referensiKesesuaianKlaim.json');
// Referensi berversi tersedia untuk pencarian agen dan halaman regulasi.
for (const s of katalogKlaim.sumber) {
  if (!registri.sumber.some(x => x.id === s.id)) registri.sumber.push({ ...s, ringkasan:s.catatan,
    berlaku_sampai:null, kata_kunci:katalogKlaim.aturan.filter(a=>a.sumber_id===s.id).flatMap(a=>[a.nama,...(a.dx || []),...(a.px || [])]) });
}
const syaratPenunjang = require('../data/syaratPenunjangDiagnosis.json');
const kombinasi = require('../data/ketentuanKlaimKombinasi.json');

function berlaku(s, tanggal = new Date().toISOString().slice(0, 10)) {
  if (s.status_verifikasi && s.status_verifikasi !== 'terverifikasi') return null;
  return (!s.berlaku_mulai || s.berlaku_mulai <= tanggal) && (!s.berlaku_sampai || s.berlaku_sampai >= tanggal);
}

function sumberById(id) { return registri.sumber.find(s => s.id === id) || null; }

/** Label singkat untuk ditampilkan di samping persyaratan: "Permenkes 47/2018 (v2018)". */
function labelSumber(id) {
  const s = sumberById(id);
  if (!s) return null;
  return { id: s.id, judul: s.judul, nomor: s.nomor, versi: s.versi, berlaku: berlaku(s),
    jenis:s.jenis, url:s.url || null, halaman:s.halaman || null, status_verifikasi:s.status_verifikasi || null };
}

/** Semua butir sebagai daftar datar {sumber_id, kode, judul, teks}. */
function semuaButir() {
  const butir = [];
  for (const a of katalogKlaim.aturan) butir.push({ sumber_id:a.sumber_id, kode:a.id, judul:a.nama,
    teks:a.catatan, diverifikasi:katalogKlaim.sumber.find(s=>s.id===a.sumber_id)?.status_verifikasi==='terverifikasi' });
  for (const s of registri.sumber) for (const b of s.butir || []) butir.push({ sumber_id: s.id, kode: b.id, judul: s.judul, teks: b.teks });
  for (const a of syaratPenunjang.aturan || []) {
    butir.push({ sumber_id: 'REKAP-PENDING-RS', kode: a.id, judul: `${a.kode_diagnosis} ${a.nama_diagnosis}`, diverifikasi: a.diverifikasi,
      teks: `Syarat: ${(a.syarat || []).map(x => `${x.nama}${x.tingkat_risiko ? ` (${x.tingkat_risiko})` : ''}`).join('; ')}. Sumber: ${String(a.sumber_aturan || '').slice(0, 200)}` });
  }
  for (const a of kombinasi.aturan || []) {
    butir.push({ sumber_id: a.sumber === 'casemix_rs' ? 'KONVENSI-KODING-RS' : 'BA-KESEPAKATAN-2018', kode: a.kode, judul: a.nama, diverifikasi: a.diverifikasi,
      teks: `${a.pesan || ''} [${(a.kode_diagnosis || []).join('/')} + ${(a.kode_pasangan || []).join('/')}]${a.diverifikasi === false ? ' (belum diverifikasi koder)' : ''}` });
  }
  return butir;
}

function norm(x) { return String(x || '').toLowerCase(); }

/** Cari sumber & butir yang relevan dengan teks (kata kunci, kode ICD, atau nama). */
function cariRegulasi(teks, batas = 8) {
  const kata = norm(teks).split(/[^a-z0-9.]+/).filter(k => k.length >= 2);
  if (!kata.length) return [];
  const skor = (hay) => kata.reduce((n, k) => n + (norm(hay).includes(k) ? 1 : 0), 0);
  const hasil = [];
  for (const s of registri.sumber) {
    const n = skor(`${s.judul} ${s.ringkasan} ${(s.kata_kunci || []).join(' ')}`);
    if (n) hasil.push({ n: n + 0.5, jenis: 'sumber', sumber: labelSumber(s.id), ringkasan: s.ringkasan });
  }
  for (const b of semuaButir()) {
    const n = skor(`${b.kode} ${b.judul} ${b.teks}`);
    if (n) hasil.push({ n, jenis: 'butir', sumber: labelSumber(b.sumber_id), kode: b.kode, judul: b.judul, teks: b.teks });
  }
  return hasil.sort((a, b) => b.n - a.n).slice(0, batas).map(({ n, ...r }) => r);
}

module.exports = { cariRegulasi, labelSumber, sumberById, semuaButir, berlaku, registri };
