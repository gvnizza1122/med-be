/**
 * Kartu persyaratan klaim per diagnosis: satu ringkasan syarat dari seluruh
 * sumber yang berlaku (PNPK, BA kesepakatan Kemenkes-BPJS, rekomendasi TKMKB,
 * rekap pending RS, ketentuan kombinasi kode, catatan casemix RS).
 *
 * - Butir "otomatis": aturan aplikasi yang sudah ditelaah (statusnya dibaca
 *   dari hasil pemeriksaan klaim).
 * - Butir "agen": syarat PNPK yang belum menjadi aturan; disusun AI sebagai
 *   DRAF dengan kutipan persis dari PDF (scripts/drafKartuPnpk.js), dinilai
 *   agen AI dari berkas.
 *
 * Kartu menggantikan potongan teks PNPK mentah di prompt agen (lebih ringkas
 * dan lebih tajam). Telaah casemix/dokter per butir disimpan di DB; butir yang
 * ditolak tidak dipakai. KARTU_HANYA_DITELAAH=true membatasi agen ke butir
 * yang sudah disetujui.
 */
const kartuData = (() => { try { return require('../data/kartuPersyaratan.json'); } catch (_) { return { versi: null, kartu: [] }; } })();
const katalogSvc = require('./katalogPedomanService');
const { resolveUsia, tanggal } = require('./usiaPasienService');

const kodeList = v => (Array.isArray(v) ? v : String(v || '').split(/[;,\s]+/)).map(k => String(k).trim().toUpperCase()).filter(Boolean);
const cocok = (a, b) => a.startsWith(b) || b.startsWith(a);

// ---------- Sumber aturan yang sudah ada ----------
function sumberMap(daftar) {
  const m = new Map();
  for (const s of Array.isArray(daftar) ? daftar : daftar ? [daftar] : []) m.set(s.id, s);
  return m;
}
function kodeDari(a, kunci) {
  const out = [];
  for (const k of kunci) {
    const v = a[k];
    if (!v) continue;
    (Array.isArray(v) ? v.flat(2) : [v]).forEach(x => typeof x === 'string' && out.push(x.toUpperCase()));
  }
  return [...new Set(out)];
}
const ringkasTeks = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 260);

let cacheAturan = null;
/** Seluruh aturan aplikasi, bentuk seragam. */
function semuaAturan() {
  if (cacheAturan) return cacheAturan;
  const out = [];
  const pokok = (() => { try { return new Map(require('../data/pnpkPokok.json').dokumen.map(d => [d.katalog_id, d])); } catch (_) { return new Map(); } })();
  const kriteria = require('../data/kriteriaPnpk.json');
  for (const a of kriteria.aturan) {
    if (a.syarat === 'informasi') continue;
    const d = pokok.get(a.katalog_id);
    out.push({ id: a.id, nama: a.nama, syarat: ringkasTeks(a.catatan), jenis: 'pnpk', dx: kodeDari(a, ['dx']), px: kodeDari(a, ['px']),
      usia_min: a.usia_min ?? null, usia_max: a.usia_max ?? null,
      sumber: { id: a.katalog_id, label: `PNPK ${d?.nomor || a.katalog_id}`, halaman: [].concat(a.halaman || []).join(', ') } });
  }
  const ba = require('../data/baPnpkAnak.json'); const sBa = sumberMap(ba.sumber);
  for (const a of ba.aturan) {
    if (a.syarat === 'informasi') continue;
    const s = sBa.get(a.sumber_id) || {};
    out.push({ id: a.id, nama: a.nama, syarat: ringkasTeks(a.catatan || a.ringkas_telaah), jenis: s.jenis === 'pedoman_klinis' ? 'pnpk' : 'ba',
      dx: kodeDari(a, ['dx', 'dx_utama', 'dx_utama_atau_terapi']), px: kodeDari(a, ['px']), usia_min: a.usia_min ?? null, usia_max: a.usia_max ?? null,
      sumber: { id: a.sumber_id, label: `${s.jenis === 'pedoman_klinis' ? 'PNPK' : 'BA'} ${s.versi || ''}`.trim(), nomor: s.nomor || null,
        halaman: [].concat(a.halaman || s.halaman || []).join(', '), butir: a.butir || null } });
  }
  const rk = require('../data/referensiKesesuaianKlaim.json'); const sRk = sumberMap(rk.sumber);
  for (const a of rk.aturan) {
    const s = sRk.get(a.sumber_id) || {};
    const kode = kodeDari(a, ['dx']);
    out.push({ id: a.id, nama: a.nama, syarat: ringkasTeks(a.catatan), jenis: s.jenis === 'pedoman_klinis' ? 'pnpk' : 'ba',
      dx: kode.filter(k => /^[A-Z]/.test(k)), px: [...kode.filter(k => /^\d/.test(k)), ...kodeDari(a, ['px'])],
      usia_min: a.usia_min ?? null, usia_max: a.usia_max ?? null,
      sumber: { id: a.sumber_id, label: s.judul || a.sumber_id, nomor: s.nomor || null, halaman: s.halaman || null } });
  }
  const tk = require('../data/baTkmkb2025.json'); const sTk = sumberMap(tk.sumber);
  for (const a of tk.aturan) {
    const s = sTk.get(a.sumber_id) || {};
    out.push({ id: a.id, nama: a.nama, syarat: ringkasTeks(a.catatan), jenis: /^TK/.test(a.id) ? 'tkmkb' : 'ba',
      dx: kodeDari(a, ['dx']), px: kodeDari(a, ['px']), usia_min: a.usia_min ?? null, usia_max: a.usia_max ?? null,
      sumber: { id: a.sumber_id, label: /^TK/.test(a.id) ? 'Rekomendasi TKMKB Pusat 2025' : (s.judul || a.sumber_id), nomor: s.nomor || null,
        halaman: [].concat(a.halaman_pdf || []).join(', ') } });
  }
  for (const a of require('../data/syaratPenunjangDiagnosis.json').aturan) {
    if (!a.diverifikasi) continue;
    out.push({ id: a.id, nama: `${a.nama_diagnosis} (rekap pending RS)`, syarat: (a.syarat || []).map(s => s.nama).join('; '), jenis: 'rekap_rs',
      dx: kodeDari(a, ['kode_diagnosis']), px: [], usia_min: null, usia_max: null,
      sumber: { id: 'REKAP-PENDING-RS', label: 'Rekap pending BPJS RS', halaman: null } });
  }
  const bdd = require('../data/bpjsDoDont.json');
  for (const a of bdd.aturan) {
    out.push({ id: a.id, nama: a.nama, syarat: ringkasTeks(a.teks_asli || a.catatan), jenis: 'catatan_rs',
      dx: kodeDari(a, ['dx', 'dx_semua', 'dx_utama']), px: kodeDari(a, ['px']), usia_min: a.usia_min ?? null, usia_max: a.usia_max ?? null,
      hospital_codes: bdd.hospital_codes || [], sumber: { id: bdd.sumber?.id, label: 'Catatan casemix RS (BPJS Do & Don\'t)', halaman: a.halaman || null } });
  }
  for (const a of require('../data/ketentuanKlaimKombinasi.json').aturan) {
    if (!a.diverifikasi) continue;
    out.push({ id: a.kode, nama: `Kombinasi kode: ${a.nama}`, syarat: ringkasTeks(a.pesan), jenis: 'kombinasi',
      dx: kodeDari(a, ['kode_diagnosis']), px: kodeDari(a, ['px_ada']), usia_min: null, usia_max: null,
      sumber: { id: a.sumber, label: ringkasTeks(a.kutipan_sumber).slice(0, 120) || a.sumber, halaman: null } });
  }
  cacheAturan = out.filter(a => a.dx.length || a.px.length);
  return cacheAturan;
}

/** Aturan yang menyentuh kode diagnosis/prosedur dan rentang usia tertentu. */
function aturanUntukDx(dx = [], px = [], { usiaMin = null, usiaMax = null } = {}) {
  const d = kodeList(dx), p = kodeList(px);
  return semuaAturan().filter(a => (a.dx.some(k => d.some(x => cocok(k, x))) || a.px.some(k => p.some(x => cocok(k, x))))
    && !(usiaMax !== null && a.usia_min !== null && a.usia_min > usiaMax)
    && !(usiaMin !== null && a.usia_max !== null && a.usia_max < usiaMin));
}

// ---------- Telaah casemix/dokter (DB) ----------
let telaah = new Map(); // `${kartu_id}|${butir_id}` -> {status, catatan, oleh, waktu}
async function siapkanTabel(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS kartu_persyaratan_telaah (
    id SERIAL PRIMARY KEY, kartu_id TEXT NOT NULL, butir_id TEXT NOT NULL, versi_kartu TEXT,
    status TEXT NOT NULL CHECK (status IN ('disetujui','ditolak','perlu_revisi')), catatan TEXT,
    ditelaah_oleh INTEGER, ditelaah_pada TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
async function muatTelaah(db) {
  await siapkanTabel(db);
  const rows = await db.prepare(`SELECT DISTINCT ON (kartu_id, butir_id) kartu_id, butir_id, status, catatan, ditelaah_oleh, ditelaah_pada
    FROM kartu_persyaratan_telaah ORDER BY kartu_id, butir_id, ditelaah_pada DESC`).all();
  telaah = new Map(rows.map(r => [`${r.kartu_id}|${r.butir_id}`, { status: r.status, catatan: r.catatan, oleh: r.ditelaah_oleh, waktu: r.ditelaah_pada }]));
  return telaah;
}
async function simpanTelaah(db, { kartu_id, butir_id, status, catatan = null, user_id = null }) {
  const k = kartuData.kartu.find(x => x.id === kartu_id);
  if (!k || !k.butir.some(b => b.id === butir_id)) throw Object.assign(new Error('Butir kartu tidak ditemukan.'), { status: 404 });
  if (!['disetujui', 'ditolak', 'perlu_revisi'].includes(status)) throw Object.assign(new Error('Status telaah tidak sah.'), { status: 400 });
  await siapkanTabel(db);
  await db.run(`INSERT INTO kartu_persyaratan_telaah (kartu_id, butir_id, versi_kartu, status, catatan, ditelaah_oleh) VALUES (?, ?, ?, ?, ?, ?)`,
    [kartu_id, butir_id, kartuData.versi, status, catatan ? String(catatan).slice(0, 1000) : null, user_id]);
  telaah.set(`${kartu_id}|${butir_id}`, { status, catatan, oleh: user_id, waktu: new Date().toISOString() });
}
const statusTelaah = (k, b) => telaah.get(`${k.id}|${b.id}`)?.status || (b.cara === 'otomatis' ? 'aturan_aplikasi' : 'draf');

// ---------- Kartu untuk klaim ----------
function usiaCocok(kartu, usia) {
  if (usia.kelompok === 'belum_terkonfirmasi' || usia.tahun === null || usia.tahun === undefined) return true;
  if (kartu.usia === 'anak') return usia.tahun < 18;
  if (kartu.usia === 'dewasa') return usia.tahun >= 18;
  return true;
}

/** Kartu yang berlaku untuk klaim; butir PNPK yang versinya tidak berlaku pada episode dan butir ditolak dibuang. */
function kartuUntukKlaim(record = {}, { dx, px } = {}) {
  let raw = record.raw_data || {}; if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  const kodeDx = kodeList(dx ?? record.DIAGLIST ?? record.diagnosa_list ?? raw.DIAGLIST);
  const kodePx = kodeList(px ?? record.PROCLIST ?? record.prosedur_list ?? raw.PROCLIST);
  const usia = resolveUsia(record);
  const episode = tanggal(record.admission_date || record.ADMISSION_DATE || raw.ADMISSION_DATE);
  const hanyaDisetujui = process.env.KARTU_HANYA_DITELAAH === 'true';
  const rs = String(record.hospital_code || record.KODE_RS || '');
  const out = [];
  for (const k of kartuData.kartu) {
    const kena = kodeDx.filter(c => k.dx.some(p => c.startsWith(p)));
    const kenaPx = kodePx.filter(c => (k.px || []).some(p => c.startsWith(p)));
    if (!kena.length && !kenaPx.length) continue;
    if (!usiaCocok(k, usia)) continue;
    const butir = k.butir.filter(b => {
      const st = statusTelaah(k, b);
      if (st === 'ditolak') return false;
      if (hanyaDisetujui && b.cara === 'agen' && st !== 'disetujui') return false;
      if (b.hospital_codes?.length && rs && !b.hospital_codes.includes(rs)) return false;
      if (b.sumber?.katalog_id && katalogSvc.berlakuPadaEpisode(b.sumber.katalog_id, episode) === false) return false;
      if (b.usia === 'anak' && usia.tahun >= 18) return false;
      if (b.usia === 'dewasa' && usia.tahun !== null && usia.tahun < 18) return false;
      return true;
    }).map(b => ({ ...b, telaah: statusTelaah(k, b) }));
    if (butir.length) out.push({ ...k, kode_pemicu: [...kena, ...kenaPx], butir });
  }
  return out;
}

/** Status butir otomatis pada klaim ini, dari hasil pemeriksaan aplikasi. */
function statusOtomatis(ai = {}) {
  const st = new Map();
  const temuan = ai.referensi_klaim?.temuan || [];
  for (const t of [...temuan, ...temuan.flatMap(x => x.rujukan_ba_2018 || [])]) if (t?.id && t.status) st.set(t.id, t.status);
  for (const s of ai.syarat_penunjang || []) {
    const kurang = (s.syarat || []).filter(x => x.status !== 'terpenuhi').map(x => x.nama);
    st.set(s.id, kurang.length ? `belum: ${kurang.join(', ')}` : 'terpenuhi');
  }
  for (const k of ai.kombinasi_kode || []) st.set(k.kode, `terpicu: ${[...(k.kode_utama || []), ...(k.kode_terdampak || [])].join(' + ')}`);
  return st;
}

/**
 * Teks kartu untuk prompt agen, ringkas: syarat PNPK yang dinilai agen ditulis
 * lengkap (sumber + halaman); aturan aplikasi hanya yang terpicu pada klaim
 * ini, satu baris berisi statusnya (isi aturannya sudah dinilai aplikasi).
 */
const TOPIK_KE_KATEGORI = { kriteria_diagnosis: 'kriteria_diagnosis', penunjang: 'penunjang', rawat_inap: 'rawat_inap', intensif: 'intensif',
  indikasi_tindakan: 'tindakan', pulang_rujuk: 'pulang_rujuk', definisi: 'kriteria_diagnosis', tata_laksana: 'tindakan' };
function untukPrompt(kartu, ai = {}, { total = 4500, topik = null } = {}) {
  const kategori = topik ? new Set([...topik.map(t => TOPIK_KE_KATEGORI[t]).filter(Boolean), 'koding']) : null;
  const st = statusOtomatis(ai);
  const blok = [];
  let sisa = total;
  for (const k of kartu) {
    let isi = `[${k.id}] ${k.judul} -- dipicu ${k.kode_pemicu.join(', ')}`;
    const otomatis = k.butir.filter(b => b.cara === 'otomatis' && st.has(b.aturan_id));
    if (otomatis.length) isi += `\n  Aturan aplikasi terpicu: ${otomatis.map(b => `${b.aturan_id} (${st.get(b.aturan_id)})`).join('; ')}`;
    for (const b of k.butir.filter(x => x.cara === 'agen' && (!kategori || kategori.has(x.kategori)))) {
      const baris = `\n- [${b.kategori}] ${b.syarat} (${b.sumber.katalog_id} hal. ${b.sumber.halaman}${b.telaah === 'disetujui' ? '; ditelaah' : ''})`;
      if (isi.length + baris.length > sisa) break;
      isi += baris;
    }
    if (!isi.includes('\n')) continue; // kartu tanpa syarat relevan dan tanpa aturan terpicu tidak menambah informasi
    blok.push(isi);
    sisa -= isi.length;
    if (sisa < 200) break;
  }
  return blok.join('\n\n');
}

/** Rujukan PNPK (katalog_id -> halaman) yang ada di kartu, untuk validasi kutipan agen. */
function rujukanKartu(kartu) {
  const m = new Map();
  for (const k of kartu) for (const b of k.butir) if (b.sumber?.katalog_id) {
    if (!m.has(b.sumber.katalog_id)) m.set(b.sumber.katalog_id, new Set());
    String(b.sumber.halaman || '').split(/[,\s]+/).filter(Boolean).forEach(h => m.get(b.sumber.katalog_id).add(Number(h)));
  }
  return m;
}

function daftarKartu() {
  return { versi: kartuData.versi, keterangan: kartuData.keterangan, jumlah: kartuData.kartu.length,
    kartu: kartuData.kartu.map(k => ({ id: k.id, judul: k.judul, dx: k.dx, usia: k.usia, jumlah_butir: k.butir.length,
      butir_agen: k.butir.filter(b => b.cara === 'agen').length,
      ditelaah: k.butir.filter(b => b.cara === 'agen' && ['disetujui', 'ditolak', 'perlu_revisi'].includes(statusTelaah(k, b))).length })) };
}
function getKartu(id) {
  const k = kartuData.kartu.find(x => x.id === id);
  return k ? { ...k, butir: k.butir.map(b => ({ ...b, telaah: statusTelaah(k, b), catatan_telaah: telaah.get(`${k.id}|${b.id}`)?.catatan || null })) } : null;
}

module.exports = { semuaAturan, aturanUntukDx, kartuUntukKlaim, untukPrompt, rujukanKartu, statusOtomatis, daftarKartu, getKartu,
  muatTelaah, simpanTelaah, siapkanTabel, versi: kartuData.versi };
