/**
 * Menyusun src/data/pnpkPokok.json: bagian pokok setiap PNPK di Katalog
 * Pedoman (definisi, kriteria diagnosis, penunjang, indikasi rawat inap/
 * intensif, indikasi tindakan, kriteria pulang/rujuk, tata laksana) beserta
 * nomor halaman PDF. Dibaca dari teks PDF resmi (docs/referensi/katalog);
 * tidak ada isi yang ditulis dari ingatan. Jalankan ulang bila katalog berubah:
 *   node scripts/susunPnpkPokok.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const katalogSvc = require('../src/services/katalogPedomanService');
const katalog = require('../src/data/katalogPedoman.json');
const kriteria = require('../src/data/kriteriaPnpk.json');

const TOPIK = [
  ['definisi', /\b(?:[A-H]\.\s*)?Definisi\b|\badalah (?:suatu |salah satu )?(?:penyakit|kondisi|keadaan|kelainan|infeksi|peradangan|neoplasma)\b/i],
  ['kriteria_diagnosis', /\b(?:kriteria diagnosis|kriteria diagnostik|penegakan diagnosis|diagnosis (?:ditegakkan|pasti|kerja)|ditegakkan (?:bila|apabila|jika|berdasarkan|dengan))\b/i],
  ['penunjang', /\bpemeriksaan penunjang\b/i],
  ['rawat_inap', /\b(?:indikasi (?:rawat inap|perawatan(?! intensif)|rawat|masuk rumah sakit|hospitalisasi|dirawat)|kriteria (?:rawat inap|perawatan)|perlu dirawat|dirawat (?:inap )?(?:bila|apabila|jika)|rawat jalan dengan kriteria|kriteria rawat jalan)\b/i],
  ['intensif', /\b(?:indikasi (?:ICU|PICU|NICU|HCU|perawatan intensif|rawat intensif)|(?:dirawat|perawatan) di (?:ICU|PICU|NICU|HCU|ruang intensif))\b/i],
  ['indikasi_tindakan', /\b(?:indikasi (?:operasi|pembedahan|tindakan|bedah|intervensi)|tata ?laksana (?:operatif|bedah|pembedahan))\b/i],
  ['pulang_rujuk', /\b(?:kriteria (?:pulang|rujuk\w*|perbaikan)|boleh pulang|indikasi (?:pulang|rujuk\w*)|dipulangkan (?:bila|apabila|jika))\b/i],
  ['tata_laksana', /\b(?:tata ?laksana|terapi|penatalaksanaan) (?:awal|utama|farmakologi\w*|medikamentosa|nonfarmakologi\w*|definitif)\b/i],
];
// Bila judul bagian tidak ada, halaman dipilih dari kepadatan frasa (minimal 2 kemunculan).
const LEMAH = {
  rawat_inap: /\b(?:rawat inap|dirawat(?: inap)?|rawat jalan|berobat jalan|perawatan di rumah sakit|hospitalisasi|MRS)\b/gi,
  intensif: /\b(?:ICU|PICU|NICU|HCU|ruang intensif|perawatan intensif)\b/gi,
  pulang_rujuk: /\b(?:pulang|dipulangkan|dirujuk|rujukan ke|rujuk ke)\b/gi,
  indikasi_tindakan: /\b(?:indikasi|dioperasi|operasi|pembedahan)\b/gi,
};
const EPIDEMIOLOGI = /\b(?:terbanyak|prevalensi|insidens|angka kematian|survei|riskesdas|per tahun|setiap tahun)\b/i;
const BUKAN_ISI = /\b(?:daftar isi|kata pengantar|daftar tabel|daftar gambar|daftar singkatan|menimbang|mengingat|memutuskan|menetapkan)\b|\.{8,}/i;
const bersih = t => String(t || '').replace(/jdih\.kemkes\.go\.id/gi, ' ').replace(/\s+/g, ' ').trim();

// Kode ICD per dokumen: dari aturan PNPK yang sudah ditelaah, pemetaan, dan pemetaan judul katalog.
const DX_JUDUL = [
  [/cedera otak/, ['S06']], [/katarak pada anak/, ['Q12.0', 'H26.0']], [/skizofrenia/, ['F20']], [/demensia/, ['F00', 'F01', 'F02', 'F03', 'G30']],
  [/kedokteran jiwa/, ['F']], [/sarkopenia/, ['M62.8']], [/infeksi intraabdominal/, ['K35', 'K57', 'K63.1', 'K65']], [/periodontal/, ['K05']],
  [/karies/, ['K02']], [/pulpa/, ['K04']], [/seboroik/, ['L21']], [/bibir sumbing/, ['Q35', 'Q36', 'Q37']], [/rinosinusitis/, ['J32']],
  [/otitis media supuratif/, ['H66.1', 'H66.2', 'H66.3']], [/tonsilitis/, ['J03', 'J35']], [/tuli sensorineural/, ['H90.3', 'H90.4', 'H90.5']],
  [/hirschpr|hirschspr/, ['Q43.1']], [/gagal jantung/, ['I50']], [/paru obstruktif/, ['J44']], [/fraktur kraniomaksilofasial/, ['S02']],
  [/penatalaksanaan fraktur/, ['S02', 'S12', 'S22', 'S32', 'S42', 'S52', 'S62', 'S72', 'S82', 'S92', 'T02']], [/sepsis/, ['A40', 'A41', 'R65.1', 'P36']],
  [/komplikasi kehamilan/, ['O']], [/tuberkulosis/, ['A15', 'A16', 'A17', 'A18', 'A19']], [/hipertensi pada anak/, ['I10', 'I15']],
  [/dengue/, ['A90', 'A91']], [/tifoid/, ['A01.0']], [/pneumonia/, ['J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18']], [/stroke/, ['I60', 'I61', 'I62', 'I63', 'I64']],
  [/diabetes melitus tipe 2/, ['E11']], [/katarak pada dewasa/, ['H25', 'H26', 'H28']], [/ginjal tahap akhir/, ['N18.5', 'Z49', 'Z99.2']],
  [/koroner akut/, ['I20.0', 'I21', 'I22', 'I24']], [/impaksi/, ['K01.1']], [/skoliosis/, ['M41']], [/osteoartritis/, ['M15', 'M16', 'M17', 'M18', 'M19']],
  [/ulkus kornea/, ['H16.0']], [/sirosis/, ['K74', 'K70.3']], [/trauma\b/, ['S', 'T00', 'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07']],
];
// Pedoman tindakan dipilih dari kode prosedur.
const PX_JUDUL = [[/akupunktur/, ['99.91', '99.92']], [/anestesiologi/, ['04.81', '03.91', '99.23', '96.7']]];
const norm = s => String(s || '').normalize('NFKD').toLowerCase();

function dxDokumen(d) {
  const kode = new Set();
  for (const a of kriteria.aturan) if (a.katalog_id === d.id) (a.dx || []).forEach(k => kode.add(k));
  for (const [rx, k] of DX_JUDUL) if (rx.test(norm(d.judul))) k.forEach(x => kode.add(x));
  // Pemetaan judul -> ICD yang dipakai Katalog Pedoman untuk memilih pedoman kasus.
  if (!/diabetes melitus tipe 2|kehamilan/.test(norm(d.judul)))
    for (const [rx, k] of katalogSvc.mapDx) if (rx.test(norm(d.judul).replace(/[^a-z0-9]+/g, ' '))) k.forEach(x => kode.add(x));
  return [...kode];
}

function halaman(d) {
  const f = katalogSvc.berkasDokumen(d.id, 0, true);
  if (!f) return [];
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))).halaman || []; } catch { return []; }
}

function bagian(pages) {
  // Halaman isi: lewati halaman depan (keputusan menteri, daftar isi).
  const isi = pages.filter(p => !BUKAN_ISI.test(String(p.text || '').slice(0, 1500)));
  const out = [];
  for (const [topik, rx] of TOPIK) {
    const perlu = topik === 'tata_laksana' ? 1 : 2;
    const hit = [];
    for (const p of isi) {
      const t = String(p.text || '');
      const m = rx.exec(t);
      if (!m) continue;
      const awal = Math.max(0, t.lastIndexOf('\n', m.index) + 1);
      const kutipan = bersih(t.slice(awal, awal + 1100));
      if (kutipan.length < 120) continue;
      hit.push({ topik, halaman: p.page_number, kutipan });
      if (hit.length >= perlu) break;
    }
    if (hit.length < perlu && LEMAH[topik]) {
      const skor = isi.filter(p => !hit.some(h => h.halaman === p.page_number)).map(p => {
        const t = String(p.text || '');
        const baris = t.split(/\n/).filter(l => LEMAH[topik].test(l) && !EPIDEMIOLOGI.test(l));
        LEMAH[topik].lastIndex = 0;
        return { p, t, n: baris.length, pertama: baris[0] };
      }).filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
      for (const x of skor.slice(0, perlu - hit.length)) {
        const awal = Math.max(0, x.t.indexOf(x.pertama) - 300);
        hit.push({ topik, halaman: x.p.page_number, kutipan: bersih(x.t.slice(awal, awal + 1100)), dipilih: 'kepadatan_frasa' });
      }
    }
    out.push(...hit.sort((a, b) => a.halaman - b.halaman));
  }
  return out;
}

const dokumen = [];
for (const d of katalog.dokumen.filter(x => ['pnpk', 'pnpk_profesi'].includes(x.jenis))) {
  const pages = halaman(d);
  dokumen.push({
    katalog_id: d.id, judul: d.judul, nomor: d.nomor, cakupan_usia: d.cakupan_usia, berlaku_mulai: d.berlaku_mulai || null,
    keluarga: d.keluarga, digantikan_oleh: d.digantikan_oleh || [], dx: dxDokumen(d), px: PX_JUDUL.filter(([rx]) => rx.test(norm(d.judul))).flatMap(([, k]) => k),
    jumlah_halaman: pages.length,
    aturan_terkait: [...kriteria.aturan.filter(a => a.katalog_id === d.id).map(a => a.id),
      ...(kriteria.pemetaan_aturan || []).filter(m => m.katalog_id === d.id).flatMap(m => m.aturan_ids)],
    bagian: pages.length ? bagian(pages) : [],
  });
}
const keluar = {
  versi: `PNPK-POKOK-${new Date().toISOString().slice(0, 10)}`,
  sumber_katalog: katalog.versi,
  keterangan: 'Kutipan bagian pokok PNPK dari teks PDF resmi Katalog Pedoman, berhalaman. Rujukan untuk penalaran agen; bukan aturan penjaminan otomatis. Persyaratan yang dinilai otomatis ada di kriteriaPnpk.json.',
  dokumen,
};
fs.writeFileSync(path.join(__dirname, '../src/data/pnpkPokok.json'), JSON.stringify(keluar, null, 1) + '\n');
const tanpa = dokumen.filter(d => !d.bagian.length).map(d => d.katalog_id);
console.log(`${dokumen.length} dokumen, ${dokumen.reduce((n, d) => n + d.bagian.length, 0)} bagian; tanpa teks: ${tanpa.join(', ') || '-'}; tanpa dx: ${dokumen.filter(d => !d.dx.length).length}`);
