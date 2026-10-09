/**
 * Pengetahuan PNPK untuk agen AI. Sumbernya src/data/pnpkPokok.json (kutipan
 * bagian pokok tiap PNPK dari teks PDF resmi Katalog Pedoman, berhalaman;
 * disusun oleh scripts/susunPnpkPokok.js) dan teks lengkap PDF untuk pencarian.
 *
 * Yang dikerjakan di sini:
 *  - memilih PNPK yang berlaku untuk klaim (kode diagnosis/prosedur, usia, dan
 *    versi menurut tanggal awal episode -- sama dengan pemilihan aturan PNPK);
 *  - menyusun konteks prompt berhalaman agar agen menalar dengan kriteria PNPK
 *    (diagnosis, penunjang, indikasi rawat inap/intensif/tindakan, pulang);
 *  - mencari isi PNPK (alat agen interaktif);
 *  - meringkas hasil pemeriksaan otomatis BA/PNPK yang sudah berjalan.
 *
 * PNPK adalah rujukan klinis, bukan keputusan penjaminan. Agen tidak boleh
 * mengutip PNPK di luar konteks yang diberikan atau hasil alat.
 */
const pokok = require('../data/pnpkPokok.json');
const katalogSvc = require('./katalogPedomanService');
const { resolveUsia, tanggal } = require('./usiaPasienService');

const URUTAN_TOPIK = ['kriteria_diagnosis', 'rawat_inap', 'intensif', 'indikasi_tindakan', 'penunjang', 'pulang_rujuk', 'definisi', 'tata_laksana'];
const NAMA_TOPIK = {
  definisi: 'Definisi', kriteria_diagnosis: 'Kriteria/penegakan diagnosis', penunjang: 'Pemeriksaan penunjang',
  rawat_inap: 'Indikasi rawat inap/rawat jalan', intensif: 'Indikasi perawatan intensif', indikasi_tindakan: 'Indikasi tindakan/operasi',
  pulang_rujuk: 'Kriteria pulang/rujuk', tata_laksana: 'Tata laksana',
};
const katalogDok = new Map(katalogSvc.katalog.dokumen.map(d => [d.id, d]));
const norm = v => String(v || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const kodeList = v => (Array.isArray(v) ? v : String(v || '').split(/[;,\s]+/)).map(k => String(k).trim().toUpperCase()).filter(Boolean);

/** Prefiks 'F' (seluruh bab) lebih umum daripada 'F20'; yang spesifik didahulukan. */
function cocokKode(kode, prefiks) {
  let terbaik = 0;
  for (const p of prefiks || []) if (kode.startsWith(String(p).toUpperCase())) terbaik = Math.max(terbaik, String(p).length);
  return terbaik;
}

function rawData(record) {
  let raw = record.raw_data || {};
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  return raw;
}

/**
 * PNPK yang berlaku untuk klaim. Satu dokumen per keluarga pedoman (versi
 * yang berlaku pada awal episode); usia di luar cakupan dilewati.
 */
function dokumenUntukKlaim(record = {}, { dx, px, maks = 4 } = {}) {
  const raw = rawData(record);
  const kodeDx = kodeList(dx ?? record.DIAGLIST ?? record.diagnosa_list ?? raw.DIAGLIST);
  const kodePx = kodeList(px ?? record.PROCLIST ?? record.prosedur_list ?? raw.PROCLIST);
  if (!kodeDx.length && !kodePx.length) return [];
  const usia = resolveUsia(record);
  const episode = tanggal(record.admission_date || record.ADMISSION_DATE || raw.ADMISSION_DATE);
  const kandidat = [];
  for (const d of pokok.dokumen) {
    const posisiDx = kodeDx.findIndex(k => cocokKode(k, d.dx) > 0);
    const posisiPx = kodePx.findIndex(k => cocokKode(k, d.px) > 0);
    if (posisiDx < 0 && posisiPx < 0) continue;
    const kat = katalogDok.get(d.katalog_id);
    if (kat && katalogSvc.usiaSesuai(kat, usia) === false) continue;
    const berlaku = katalogSvc.berlakuPadaEpisode(d.katalog_id, episode);
    if (berlaku === false) continue;
    const spesifik = posisiDx >= 0 ? cocokKode(kodeDx[posisiDx], d.dx) : 3;
    kandidat.push({ d, berlaku, posisi: posisiDx >= 0 ? posisiDx : 50 + posisiPx, spesifik, kode: posisiDx >= 0 ? kodeDx[posisiDx] : kodePx[posisiPx] });
  }
  // Satu versi per keluarga: yang pasti berlaku, lalu yang terbaru.
  const perKeluarga = new Map();
  for (const k of kandidat) {
    const kunci = k.d.keluarga || k.d.katalog_id;
    const ada = perKeluarga.get(kunci);
    const lebihBaik = !ada || (k.berlaku === true && ada.berlaku !== true)
      || (k.berlaku === ada.berlaku && String(k.d.berlaku_mulai || '') > String(ada.d.berlaku_mulai || ''));
    if (lebihBaik) perKeluarga.set(kunci, k);
  }
  return [...perKeluarga.values()]
    .sort((a, b) => a.posisi - b.posisi || b.spesifik - a.spesifik)
    .slice(0, maks)
    .map(({ d, berlaku, kode }) => ({
      katalog_id: d.katalog_id, judul: d.judul, nomor: d.nomor, berlaku_mulai: d.berlaku_mulai, cakupan_usia: d.cakupan_usia,
      kode_pemicu: kode, berlaku_pada_episode: berlaku, aturan_terkait: d.aturan_terkait || [], bagian: d.bagian,
    }));
}

/** Konteks prompt berhalaman. `topik` membatasi bagian; panjang dibatasi per dokumen dan total. */
function untukPrompt(dokumen, { topik = URUTAN_TOPIK, perBagian = 520, perDokumen = 2400, total = 7000 } = {}) {
  const blok = [];
  let sisa = total;
  for (const d of dokumen) {
    if (sisa <= 200) break;
    const kepala = `[${d.katalog_id}] ${d.judul} (${d.nomor}; berlaku ${d.berlaku_mulai || 'belum jelas'}${d.berlaku_pada_episode === null ? ', masa berlaku pada episode perlu dikonfirmasi' : ''}) -- dipicu ${d.kode_pemicu}`;
    let isi = '';
    for (const t of topik) {
      for (const b of d.bagian.filter(x => x.topik === t)) {
        const baris = `\n- ${NAMA_TOPIK[t]} (hal. ${b.halaman}): ${b.kutipan.slice(0, perBagian)}`;
        if (isi.length + baris.length > Math.min(perDokumen, sisa)) break;
        isi += baris;
      }
    }
    if (!isi) continue;
    blok.push(kepala + isi);
    sisa -= kepala.length + isi.length;
  }
  return blok.join('\n\n');
}

/** Rujukan PNPK yang boleh dikutip agen: {katalog_id -> Set(halaman)} dari konteks yang diberikan. */
function rujukanSah(dokumen) {
  return new Map(dokumen.map(d => [d.katalog_id, new Set(d.bagian.map(b => Number(b.halaman)))]));
}

/**
 * Cari isi PNPK. Dengan katalog_id/kode: teks lengkap dokumen itu; tanpa itu:
 * bagian pokok seluruh PNPK (dalam memori, cepat).
 */
function cariPnpk(teks, { katalog_id = null, kode = null, maks = 5 } = {}) {
  const token = norm(teks).split(' ').filter(t => t.length > 2);
  if (!token.length) return [];
  const skor = s => token.filter(t => s.includes(t)).length;
  const sasaran = katalog_id ? pokok.dokumen.filter(d => d.katalog_id === katalog_id)
    : kode ? pokok.dokumen.filter(d => kodeList(kode).some(k => cocokKode(k, d.dx) > 0 || cocokKode(k, d.px) > 0)) : [];
  const hasil = [];
  if (sasaran.length) {
    for (const d of sasaran.slice(0, 4)) {
      const kat = katalogDok.get(d.katalog_id);
      for (const p of kat ? katalogSvc.halaman(kat) : []) {
        const t = String(p.text || ''); const n = skor(norm(t));
        if (n < Math.min(2, token.length)) continue;
        const i = Math.max(0, t.toLowerCase().indexOf(token.find(x => t.toLowerCase().includes(x)) || '') - 150);
        hasil.push({ katalog_id: d.katalog_id, judul: d.judul, halaman: p.page_number, skor: n,
          kutipan: t.slice(i, i + 800).replace(/jdih\.kemkes\.go\.id/gi, ' ').replace(/\s+/g, ' ').trim() });
      }
    }
  } else {
    for (const d of pokok.dokumen) for (const b of d.bagian) {
      const n = skor(norm(`${d.judul} ${b.kutipan}`));
      if (n >= Math.min(2, token.length)) hasil.push({ katalog_id: d.katalog_id, judul: d.judul, halaman: b.halaman, topik: b.topik, skor: n, kutipan: b.kutipan.slice(0, 800) });
    }
  }
  return hasil.sort((a, b) => b.skor - a.skor).slice(0, maks).map(({ skor: _s, ...r }) => r);
}

/** Hasil pemeriksaan otomatis BA/PNPK pada klaim ini (termasuk rujukan yang menempel ke kartu lain). */
function ringkasPemeriksaan(referensiKlaim) {
  const temuan = referensiKlaim?.temuan || [];
  const butir = [...temuan.filter(t => /^(?:BA-\d{2}|PNPK)-/.test(String(t.id))), ...temuan.flatMap(t => t.rujukan_ba_2018 || [])];
  return butir.filter(b => b && b.status).slice(0, 12).map(b => {
    const kurang = (b.bukti || []).filter(x => x.status !== 'bukti_ditemukan' && !x.info).map(x => x.nama).slice(0, 2);
    return `- ${b.id} ${b.nama}: ${b.status}${b.kontradiksi_angka ? ' (angka tertulis bertentangan)' : ''}${kurang.length ? `; belum ada: ${kurang.join('; ')}` : ''}`;
  }).join('\n');
}

/**
 * Satu blok konteks siap pakai untuk prompt agen. Diagnosis yang punya kartu
 * persyaratan memakai kartu (ringkas: syarat + sumber + halaman + status
 * aturan); diagnosis tanpa kartu memakai kutipan bagian pokok PNPK.
 */
function konteksAgen(record, { dx, px, referensiKlaim = null, ai = null, topik, total } = {}) {
  const kartuSvc = require('./kartuPersyaratanService');
  const kodeDx = kodeList(dx ?? record.DIAGLIST ?? record.diagnosa_list ?? rawData(record).DIAGLIST);
  const kodePx = kodeList(px ?? record.PROCLIST ?? record.prosedur_list ?? rawData(record).PROCLIST);
  const kartu = process.env.AGEN_PAKAI_KARTU === 'false' ? [] : kartuSvc.kartuUntukKlaim(record, { dx: kodeDx, px: kodePx });
  const tertutup = new Set(kartu.flatMap(k => k.kode_pemicu));
  const sumberKartu = new Set(kartu.flatMap(k => (k.sumber_pnpk || []).map(d => d.katalog_id)));
  const sisaDx = kodeDx.filter(k => !tertutup.has(k)), sisaPx = kodePx.filter(k => !tertutup.has(k));
  const dokumen = (sisaDx.length || sisaPx.length) ? dokumenUntukKlaim(record, { dx: sisaDx, px: sisaPx }).filter(d => !sumberKartu.has(d.katalog_id)) : [];
  const batas = total || 6000;
  const teksKartu = kartu.length ? kartuSvc.untukPrompt(kartu, { ...(ai || {}), referensi_klaim: referensiKlaim || ai?.referensi_klaim },
    { total: Math.round(batas * (dokumen.length ? 0.6 : 1)), topik: topik || null }) : '';
  const teks = untukPrompt(dokumen, { ...(topik ? { topik } : {}), total: batas - teksKartu.length });
  const hasil = kartu.length ? '' : ringkasPemeriksaan(referensiKlaim || ai?.referensi_klaim);
  // Rujukan PNPK yang sah dikutip agen: halaman bagian pokok + halaman butir kartu.
  const dariKartu = [...kartuSvc.rujukanKartu(kartu)].map(([katalog_id, hal]) => ({ katalog_id,
    judul: pokok.dokumen.find(d => d.katalog_id === katalog_id)?.judul || katalog_id,
    nomor: pokok.dokumen.find(d => d.katalog_id === katalog_id)?.nomor || null, kode_pemicu: null,
    bagian: [...hal].map(h => ({ halaman: h })) }));
  const semuaDok = [...dokumen, ...dariKartu];
  if (!teksKartu && !teks && !hasil) return { teks: '', dokumen: semuaDok, kartu };
  const bagian = [
    teksKartu ? `KARTU PERSYARATAN KLAIM PER DIAGNOSIS (PNPK, BA kesepakatan, TKMKB, rekap RS; bukan keputusan BPJS). Butir PNPK menyebut katalog_id dan halaman; draf kecuali bertanda "ditelaah":\n${teksKartu}` : '',
    teks ? `PEDOMAN PNPK YANG BERLAKU (kutipan resmi berhalaman; rujukan klinis, bukan keputusan BPJS):\n${teks}` : '',
    hasil ? `HASIL PEMERIKSAAN OTOMATIS BA/PNPK PADA BERKAS INI:\n${hasil}` : '',
  ].filter(Boolean);
  return { dokumen: semuaDok, kartu, teks: bagian.join('\n\n') };
}

module.exports = { dokumenUntukKlaim, untukPrompt, rujukanSah, cariPnpk, ringkasPemeriksaan, konteksAgen, NAMA_TOPIK, versi: pokok.versi };
