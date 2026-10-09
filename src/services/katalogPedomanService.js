// Public source data is not executable policy. Only reviewed claim rules decide evidence checks.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const katalog = require('../data/katalogPedoman.json');
const { resolveUsia, tanggal } = require('./usiaPasienService');
const root = path.resolve(__dirname, '../..');
const docs = new Map(katalog.dokumen.map(d => [d.id, d]));
const cache = new Map();
const norm = v => String(v || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Bagian pokok PNPK yang dipakai agen AI (penalaran diagnosis, pemeriksa kritis, putusan pending, agen casemix). */
function pengetahuanAgen(id, isi = false) {
  let d = null; try { d = require('../data/pnpkPokok.json').dokumen.find(x => x.katalog_id === id) || null; } catch (_) { d = null; }
  if (!d) return { tersedia: false };
  return { tersedia: d.bagian.length > 0, kode_pemicu: [...d.dx, ...d.px],
    bagian: d.bagian.map(b => ({ topik: b.topik, halaman: b.halaman, ...(isi ? { kutipan: b.kutipan } : {}) })) };
}
function ringkas(d) {
  const { berkas, ...rest } = d;
  const kriteria=require('../data/kriteriaPnpk.json');
  const aktif=kriteria.aturan.filter(a=>a.katalog_id===d.id);
  const pemetaan=kriteria.pemetaan_aturan?.find(a=>a.katalog_id===d.id) || null;
  return { ...rest, ...(aktif.length ? {status_telaah:'memiliki_aturan_ditelaah'} : {}), berkas: berkas.map(({ arsip, arsip_teks, ...f }) => f), pemeriksaan_otomatis:{
    versi:kriteria.versi,aturan:aktif.map(a=>({id:a.id,nama:a.nama,halaman:a.halaman,mode:a.mode_penilaian || 'kriteria_bukti'})),
    pemetaan,catatan:'Pemeriksaan otomatis mencakup kriteria yang dapat diperiksa dari berkas. Seluruh bagian pokok PNPK (berhalaman) dipakai agen AI.'},
    ...(['pnpk','pnpk_profesi'].includes(d.jenis) ? { pengetahuan_agen: pengetahuanAgen(d.id) } : {}) };
}
function getDokumen(id) { const d = docs.get(id); return d ? { ...ringkas(d), ...(['pnpk','pnpk_profesi'].includes(d.jenis) ? {pengetahuan_agen:pengetahuanAgen(d.id,true)} : {}) } : null; }
function berkasDokumen(id, variant = 0, teks = false) {
  const f = docs.get(id)?.berkas[variant];
  const relative = f?.[teks ? 'arsip_teks' : 'arsip'];
  if (!relative || !/^docs\/referensi\/katalog\/[a-f0-9]{64}\.(?:pdf|json\.gz)$/.test(relative)) return null;
  const target = path.resolve(root, relative);
  return target.startsWith(root + path.sep) && fs.existsSync(target) ? target : null;
}
function halaman(d) {
  const f = d.berkas[0];
  if (!f) return [];
  if (cache.has(f.sha256)) return cache.get(f.sha256);
  const file = berkasDokumen(d.id, 0, true);
  if (!file) return [];
  try {
    const pp = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).halaman;
    if (!Array.isArray(pp)) return [];
    // Bound retained memory; all source PDFs remain available even with incomplete text extraction.
    if (cache.size >= 6) cache.delete(cache.keys().next().value);
    cache.set(f.sha256, pp);
    return pp;
  } catch { return []; }
}
function cuplikan(d, query, limit = 3) {
  const tokens = norm(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const out = [];
  for (const p of halaman(d)) {
    const txt = String(p.text || ''); const normalized = norm(txt);
    if (!tokens.every(t => normalized.includes(t))) continue;
    const at = txt.toLowerCase().indexOf(tokens[0]);
    const pos = Math.max(0, at - 100);
    out.push({ dokumen_id: d.id, halaman: p.page_number, kutipan: txt.slice(pos, pos + 700).replace(/\s+/g, ' ').trim() });
    if (out.length >= limit) break;
  }
  return out;
}
function daftar(options = {}) {
  const q = String(options.q || '').slice(0, 160).trim();
  const tokens = norm(q).split(' ').filter(Boolean);
  const offset = Math.max(0, Math.min(10000, Number(options.offset) || 0));
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const candidates = katalog.dokumen.filter(d =>
    (!options.jenis || d.jenis === options.jenis) && (!options.usia || d.cakupan_usia === options.usia) &&
    (!options.tahun || String(d.tahun) === String(options.tahun)) && (!options.status || d.status_unduh === options.status));
  const found = [];
  for (const d of candidates) {
    const match = tokens.every(t => norm([d.judul, d.nomor, d.id, ...d.alias_judul].join(' ')).includes(t));
    const snippets = options.isi === '1' && q ? cuplikan(d, q) : [];
    if (match || snippets.length) found.push({ ...ringkas(d), cuplikan: snippets });
  }
  return { versi: katalog.versi, diperiksa_pada: katalog.diperiksa_pada, cakupan: katalog.cakupan,
    ringkasan: katalog.ringkasan, total: found.length, offset, limit, dokumen: found.slice(offset, offset + limit) };
}
// ICD prefixes match a diagnosis, never a stray keyword in a claim attachment.
const mapDx = [
  [/pneumonia/, ['J12','J13','J14','J15','J16','J17','J18']], [/sepsis/,['A40','A41','P36']],
  [/hipertensi dalam kehamilan/,['O10','O11','O12','O13','O14','O15','O16']], [/hipertensi/,['I10','I11','I12','I13','I15']], [/infeksi dengue/,['A90','A91']],
  [/demam tifoid/,['A01']], [/diabetes melitus/,['E10','E11','E12','E13','E14']],
  [/gagal jantung/,['I50']], [/hipotiroid/,['E03']], [/epilepsi/,['G40','G41']],
  [/leukemia limfoblastik/,['C91']], [/katarak/,['H25','H26','H28']],
  [/infeksi saluran kemih/,['N10','N11','N12','N30','N39']], [/batu saluran kemih/,['N20','N21','N22','N23']],
  [/penyakit ginjal/,['N18']], [/stroke/,['I60','I61','I62','I63','I64']],
  [/sindrom.? koroner akut/,['I20','I21','I22','I23','I24']], [/angina/,['I20']],
  [/sirosis hati/,['K74']], [/hepatitis b/,['B16','B18.0','B18.1']], [/hepatitis c/,['B17.1','B18.2']],
  [/tuberkulosis/,['A15','A16','A17','A18','A19']], [/malaria/,['B50','B51','B52','B53','B54']],
  [/kusta/,['A30']], [/hiv/,['B20','B21','B22','B23','B24']], [/obesitas/,['E66']],
  [/kanker payudara/,['C50']], [/kanker paru/,['C34']], [/kanker kolorektal/,['C18','C19','C20']],
  [/kanker serviks/,['C53']], [/kanker prostat/,['C61']], [/kanker nasofaring/,['C11']], [/kanker laring/,['C32']],
  [/penyakit periodontal/,['K05']], [/karies gigi/,['K02']], [/impaksi gigi/,['K01']],
  [/glaukoma/,['H40','H42']], [/ulkus kornea/,['H16']], [/retinopati diabetika/,['H36.0']],
  [/stunting/,['E43','E44','E45','E46']], [/asfiksia/,['P21']], [/hiperbilirubinemia/,['P58','P59']],
  [/berat lahir rendah/,['P07']], [/skoliosis/,['M41']], [/osteoporosis/,['M80','M81','M82']],
  [/osteoartritis/,['M15','M16','M17','M18','M19']], [/osteosarkoma/,['C40','C41']],
  [/hemofilia/,['D66','D67']], [/thalasemia|talasemia/,['D56']], [/luka bakar/,['T20','T21','T22','T23','T24','T25','T26','T27','T28','T29','T30','T31','T32']],
];
function usiaSesuai(d, age) {
  if (age.kelompok === 'belum_terkonfirmasi') return null;
  if (d.cakupan_usia === 'dewasa') return age.tahun >= 18;
  if (d.cakupan_usia === 'anak' || d.cakupan_usia === 'anak_remaja') return age.tahun < 18;
  if (d.cakupan_usia === 'remaja') return age.tahun >= 10 && age.tahun < 18 ? null : false; // exact source bounds need review
  if (d.cakupan_usia === 'bayi') return age.tahun === 0 ? null : false;
  return null;
}
function pilihVersi(group, episode) {
  if (!episode) return { pilihan: null, alasan: 'Tanggal awal episode belum terkonfirmasi.' };
  const eligible = group.filter(d => d.berlaku_mulai && d.berlaku_mulai <= episode);
  const active = eligible.filter(d => !d.digantikan_oleh.some(id => {
    const replacement = docs.get(id);
    return replacement?.berlaku_mulai && replacement.berlaku_mulai <= episode;
  }));
  const uncertain = group.some(d => !d.berlaku_mulai && (d.menggantikan.length || d.digantikan_oleh.length));
  if (uncertain || active.length !== 1) return { pilihan: null, alasan: 'Masa berlaku atau hubungan versi belum cukup jelas; telaah sumber sebelum menggunakan.' };
  return { pilihan: active[0], alasan: null };
}
function pedomanKasus(record = {}, options = {}) {
  let raw = record.raw_data || {}; if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  const dx = String(options.dx ?? record.DIAGLIST ?? record.diagnosa_list ?? raw.DIAGLIST ?? '').toUpperCase().split(/[;,\s]+/).filter(Boolean);
  const age = resolveUsia(record);
  // PNPK selection uses age and date at episode start. BA 2024 retains its own end-episode rule in the reviewed service.
  const episode = tanggal(record.admission_date || record.ADMISSION_DATE || raw.ADMISSION_DATE);
  const candidate = katalog.dokumen.filter(d => ['pnpk','pnpk_profesi'].includes(d.jenis) && mapDx.some(([rx,prefix]) => rx.test(norm(d.judul)) && !(String(rx)==='/hipertensi/' && /kehamilan/.test(norm(d.judul))) && dx.some(code => (/diabetes melitus tipe 2/.test(norm(d.judul)) ? ['E11'] : prefix).some(p => code.startsWith(p)))));
  const groups = new Map();
  for (const d of candidate) {
    const fit = usiaSesuai(d, age); if (fit === false) continue;
    const key = d.keluarga;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(d);
  }
  const topics = [];
  for (const group of groups.values()) {
    const scoped = group.filter(d=>usiaSesuai(d,age) === true);
    const selected = scoped.length ? pilihVersi(scoped, episode) : { pilihan:null, alasan:age.kelompok === 'belum_terkonfirmasi' ? 'Konfirmasi usia sebelum memilih pedoman anak atau dewasa.' : 'Cakupan usia dokumen perlu ditelaah dari sumber.' };
    const doc = selected.pilihan;
    topics.push({ topik:group[0].keluarga, cakupan_usia:age.kelompok === 'belum_terkonfirmasi' ? 'perlu_telaah' : group[0].cakupan_usia,
      status:doc ? 'rujukan_sesuai_usia_dan_tanggal' : 'perlu_konfirmasi', alasan:selected.alasan,
      terpilih:doc ? ringkas(doc) : null, kandidat:doc ? [] : group.map(ringkas) });
  }
  return { versi:katalog.versi, kelompok_usia:age.kelompok, tanggal_awal_episode:episode, topik:topics,
    catatan:'Katalog menambah rujukan untuk telaah. Dokumen yang belum menjadi aturan ditelaah tidak menambah alasan pending atau menyatakan klaim valid. Kesesuaian usia/tanggal belum membuktikan seluruh persyaratan klinis.' };
}
/** true/false bila masa berlaku jelas pada tanggal awal episode; null bila tanggal episode atau awal berlaku belum jelas. */
function berlakuPadaEpisode(id, episode) {
  const d = docs.get(id);
  if (!d || !d.berlaku_mulai || !episode) return null;
  if (d.berlaku_mulai > episode) return false;
  return !d.digantikan_oleh.some(r => { const b = docs.get(r); return b?.berlaku_mulai && b.berlaku_mulai <= episode; });
}
module.exports = { katalog, daftar, getDokumen, berkasDokumen, cuplikan, pedomanKasus, usiaSesuai, pilihVersi, berlakuPadaEpisode, mapDx, halaman };
