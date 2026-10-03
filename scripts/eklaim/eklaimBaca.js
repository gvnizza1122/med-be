#!/usr/bin/env node
/**
 * Penarik data E-Klaim (INA-CBG + iDRG) -- KHUSUS BACA.
 *
 * Dijalankan di komputer yang berada di jaringan RS (E-Klaim tidak bisa
 * dijangkau dari server cloud). Tanpa dependensi: cukup Node.js >= 14.
 *
 *   node eklaimBaca.js cek
 *       Uji koneksi + kunci enkripsi (satu pencarian kamus iDRG).
 *   node eklaimBaca.js klaim <daftar_sep.txt> [keluaran.jsonl]
 *       Ambil koding INA-CBG & iDRG + hasil grouping + tarif per SEP.
 *       Bisa dihentikan dan dijalankan ulang: SEP yang sudah ada di keluaran dilewati.
 *   node eklaimBaca.js kamus <diagnosis|prosedur> [keluaran.jsonl]
 *       Salin kamus iDRG (ICD-10-IM / ICD-9-CM-IM) beserta penanda
 *       validcode / accpdx / im.
 *
 * Konfigurasi di berkas .env di folder yang sama (lihat .env.contoh):
 *   EKLAIM_URL   alamat server E-Klaim, mis. http://192.168.1.10
 *   EKLAIM_KEY   encryption key Web Service E-Klaim (64 karakter hex)
 *   EKLAIM_DEBUG 1 bila E-Klaim memakai mode debug (tanpa enkripsi); default 0
 *
 * KEAMANAN DATA KLAIM RS
 * Hanya method di METHOD_BACA yang bisa dipanggil. Method yang mengubah data
 * (new_claim, set_claim_data, grouper, *_set, claim_final, send_claim_*,
 * delete_*, reedit_*, dst.) DITOLAK oleh kode ini sebelum request dibuat --
 * termasuk `grouper`, karena ia menyimpan ulang hasil grouping di klaim.
 *
 * Identitas pasien (nama, no. kartu, no. RM, tgl lahir, NIK koder, nama
 * dokter) dibuang dari keluaran. SEP tetap ada karena dipakai mencocokkan
 * dengan data eClaim -- simpan berkas keluaran seperti data klaim lainnya.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const METHOD_BACA = Object.freeze(new Set([
  'get_claim_data',
  'idrg_diagnosa_get',
  'idrg_procedure_get',
  'inacbg_diagnosa_get',
  'inacbg_procedure_get',
  'search_diagnosis',
  'search_procedures',
  'search_diagnosis_inagrouper',
  'search_procedures_inagrouper',
]));

const FIELD_IDENTITAS = ['nama_pasien', 'nomor_kartu', 'nomor_rm', 'tgl_lahir', 'coder_nik', 'coder_nm',
  'nama_dokter', 'patient_id', 'admission_id', 'hospital_admission_id', 'nik'];

// ── konfigurasi ──────────────────────────────────────────────────────────────
function bacaEnv(folder) {
  const env = {};
  const jalur = path.join(folder, '.env');
  if (fs.existsSync(jalur)) {
    for (const baris of fs.readFileSync(jalur, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(baris);
      if (m && !baris.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...pick(process.env, ['EKLAIM_URL', 'EKLAIM_KEY', 'EKLAIM_DEBUG']) };
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] != null && o[k] !== '') r[k] = o[k];
  return r;
}

// ── enkripsi (Manual Web Service E-Klaim: AES-256-CBC + HMAC-SHA256 10 byte) ─
function kunciBuffer(hex) {
  const key = Buffer.from(String(hex || '').trim(), 'hex');
  if (key.length !== 32) throw new Error('EKLAIM_KEY harus 64 karakter hex (32 byte). Salin persis dari pengaturan E-Klaim.');
  return key;
}

function enkripsi(teks, hexKey) {
  const key = kunciBuffer(hexKey);
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([c.update(teks, 'utf8'), c.final()]);
  const sig = crypto.createHmac('sha256', key).update(enc).digest().subarray(0, 10);
  return Buffer.concat([sig, iv, enc]).toString('base64');
}

function dekripsi(isi, hexKey) {
  const key = kunciBuffer(hexKey);
  const bersih = String(isi)
    .replace(/----BEGIN ENCRYPTED DATA----/, '')
    .replace(/----END ENCRYPTED DATA----/, '')
    .replace(/\s+/g, '');
  const buf = Buffer.from(bersih, 'base64');
  if (buf.length < 10 + 16 + 16) throw new Error('Respons terenkripsi terlalu pendek');
  const sig = buf.subarray(0, 10);
  const iv = buf.subarray(10, 26);
  const enc = buf.subarray(26);
  const hitung = crypto.createHmac('sha256', key).update(enc).digest().subarray(0, 10);
  if (!crypto.timingSafeEqual(sig, hitung)) throw new Error('Tanda tangan respons tidak cocok -- EKLAIM_KEY kemungkinan salah');
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ── panggilan ────────────────────────────────────────────────────────────────
function kirimHttp(url, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      const potong = [];
      res.on('data', (c) => potong.push(c));
      res.on('end', () => resolve({ status: res.statusCode, teks: Buffer.concat(potong).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Buat pemanggil E-Klaim yang hanya bisa menjalankan METHOD_BACA.
 * `kirim` bisa diganti (untuk test) -- default HTTP sungguhan.
 */
function buatKlien({ url, key, debug = false, kirim = kirimHttp }) {
  if (!url) throw new Error('EKLAIM_URL belum diisi');
  if (!debug) kunciBuffer(key);
  const endpoint = `${String(url).replace(/\/+$/, '')}/E-Klaim/ws.php${debug ? '?mode=debug' : ''}`;

  return async function panggil(method, data = {}) {
    if (!METHOD_BACA.has(method)) {
      throw new Error(`Method "${method}" DITOLAK: alat ini khusus baca dan tidak boleh mengubah data klaim E-Klaim.`);
    }
    const json = JSON.stringify({ metadata: { method }, data });
    const res = await kirim(endpoint, debug ? json : enkripsi(json, key));
    if (res.status !== 200) throw new Error(`HTTP ${res.status} dari E-Klaim`);
    const teks = debug || res.teks.trim().startsWith('{') ? res.teks : dekripsi(res.teks, key);
    let hasil;
    try { hasil = JSON.parse(teks); } catch (e) { throw new Error(`Respons E-Klaim bukan JSON: ${teks.slice(0, 200)}`); }
    return hasil;
  };
}

// ── normalisasi ──────────────────────────────────────────────────────────────
const pecahKode = (s) => String(s || '').split('#').map(x => x.trim()).filter(x => x && x !== '-');

/** "86.28+2" -> {kode:"86.28", jumlah:2} */
function pecahProsedurIdrg(s) {
  return pecahKode(s).map((k) => {
    const m = /^(.+?)\+(\d+)$/.exec(k);
    return m ? { kode: m[1], jumlah: Number(m[2]) } : { kode: k, jumlah: 1 };
  });
}

function buangIdentitas(o) {
  const r = { ...o };
  for (const k of FIELD_IDENTITAS) delete r[k];
  return r;
}

const angka = (v) => (v == null || v === '' ? null : Number(v));

/** Ringkasan seragam dari respons get_claim_data (data mentah tetap disertakan). */
function ringkasKlaim(sep, resp) {
  const d = resp && resp.response && resp.response.data;
  if (!d) {
    return { sep, ok: false, galat: (resp && resp.metadata && resp.metadata.message) || 'data kosong', kode_galat: resp && resp.metadata && resp.metadata.error_no };
  }
  const g = d.grouper || {};
  const cbg = g.response_inacbg || {};
  const drg = g.response_idrg || {};
  return {
    sep,
    ok: true,
    jenis_rawat: d.jenis_rawat,
    kelas_rawat: d.kelas_rawat,
    tgl_masuk: d.tgl_masuk,
    tgl_pulang: d.tgl_pulang,
    los: angka(d.los),
    status_klaim: d.klaim_status_cd || null,
    status_kirim_bpjs: d.bpjs_dc_status_cd || null,
    status_bpjs: d.bpjs_klaim_status_nm || null,
    inacbg: {
      diagnosa: pecahKode(d.diagnosa),
      prosedur: pecahKode(d.procedure),
      cbg: (cbg.cbg && cbg.cbg.code) || null,
      cbg_deskripsi: (cbg.cbg && cbg.cbg.description) || null,
      tarif_dasar: angka(cbg.base_tariff),
      tarif: angka(cbg.tariff),
      special_cmg: cbg.special_cmg || [],
      kelas: cbg.kelas || null,
      versi: cbg.inacbg_version || null,
      status: cbg.status_cd || null,
    },
    idrg: {
      diagnosa: pecahKode(d.diagnosa_inagrouper),
      prosedur: pecahProsedurIdrg(d.procedure_inagrouper),
      mdc: drg.mdc_number || null,
      mdc_deskripsi: drg.mdc_description || null,
      drg: drg.drg_code || null,
      drg_deskripsi: drg.drg_description || null,
      cost_weight: angka(drg.cost_weight),
      total_cost_weight: angka(drg.total_cost_weight),
      tarif: angka(drg.total_tarif),
      topup: drg.topup || [],
      versi: drg.logic_version || null,
      status: drg.status_cd || null,
    },
    tarif_alt: g.tarif_alt || [],
    data_mentah: buangIdentitas(d),
  };
}

// ── perintah ─────────────────────────────────────────────────────────────────
const tidur = (ms) => new Promise(r => setTimeout(r, ms));

function sepSudahAda(jalur) {
  const ada = new Set();
  if (!fs.existsSync(jalur)) return ada;
  for (const baris of fs.readFileSync(jalur, 'utf8').split('\n')) {
    try { const o = JSON.parse(baris); if (o && o.ok && o.sep) ada.add(o.sep); } catch (_) { /* baris rusak dilewati */ }
  }
  return ada;
}

async function perintahKlaim(panggil, berkasSep, keluaran, { jeda = 150, log = console.log } = {}) {
  const daftar = [...new Set(fs.readFileSync(berkasSep, 'utf8').split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(s => /^[0-9A-Z]{10,25}$/.test(s)))];
  const sudah = sepSudahAda(keluaran);
  const sisa = daftar.filter(s => !sudah.has(s));
  log(`SEP di daftar: ${daftar.length} | sudah ditarik: ${daftar.length - sisa.length} | akan ditarik: ${sisa.length}`);
  let ok = 0; let gagal = 0;
  for (const [i, sep] of sisa.entries()) {
    let baris;
    try {
      const resp = await panggil('get_claim_data', { nomor_sep: sep });
      baris = ringkasKlaim(sep, resp);
      if (baris.ok) {
        // Rincian iDRG (deskripsi, validcode, multiplicity) -- best-effort.
        for (const [m, k] of [['idrg_diagnosa_get', 'diagnosa_rinci'], ['idrg_procedure_get', 'prosedur_rinci']]) {
          try {
            const r = await panggil(m, { nomor_sep: sep });
            if (r && r.data && r.data.expanded) baris.idrg[k] = r.data.expanded;
          } catch (_) { /* rincian opsional */ }
        }
      }
    } catch (e) {
      baris = { sep, ok: false, galat: e.message };
    }
    fs.appendFileSync(keluaran, JSON.stringify({ ...baris, ditarik: new Date().toISOString() }) + '\n');
    if (baris.ok) ok++; else gagal++;
    log(`[${i + 1}/${sisa.length}] ${sep} ${baris.ok ? `OK  CBG ${baris.inacbg.cbg || '-'} | DRG ${baris.idrg.drg || '-'}` : `GAGAL: ${baris.galat}`}`);
    await tidur(jeda);
  }
  log(`Selesai. Berhasil ${ok}, gagal ${gagal}. Keluaran: ${keluaran}`);
  return { ok, gagal };
}

/**
 * Salin kamus iDRG lewat pencarian. Kata kunci diperhalus otomatis bila
 * E-Klaim memotong hasil (count > jumlah data yang dikembalikan).
 */
async function perintahKamus(panggil, jenis, keluaran, { jeda = 40, log = console.log } = {}) {
  const method = jenis === 'prosedur' ? 'search_procedures_inagrouper' : 'search_diagnosis_inagrouper';
  const awal = [];
  if (jenis === 'prosedur') for (let i = 0; i < 100; i++) awal.push(String(i).padStart(2, '0'));
  else for (const h of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (let i = 0; i < 100; i++) awal.push(h + String(i).padStart(2, '0'));

  const kode = new Map();
  const antre = [...awal];
  let n = 0;
  while (antre.length) {
    const kata = antre.shift();
    let r;
    try { r = await panggil(method, { keyword: kata }); } catch (e) { log(`  ${kata}: GAGAL ${e.message}`); continue; }
    const isi = r && r.response && Array.isArray(r.response.data) ? r.response.data : [];
    const jumlah = Number(r && r.response && r.response.count) || isi.length;
    const awalanKode = kata.replace(/\./g, '');
    for (const e of isi) {
      if (!e || !e.code) continue;
      // Pencarian juga mencocokkan deskripsi; simpan hanya kode berawalan kata kunci.
      if (!String(e.code).replace(/\./g, '').toUpperCase().startsWith(awalanKode.toUpperCase())) continue;
      kode.set(e.code, e);
    }
    if (isi.length > 0 && jumlah > isi.length && kata.length < 7) {
      for (let d = 0; d <= 9; d++) antre.push(kata + d);
    }
    if (++n % 100 === 0) log(`  ${n} pencarian, ${kode.size} kode`);
    await tidur(jeda);
  }
  const urut = [...kode.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  fs.writeFileSync(keluaran, urut.map(e => JSON.stringify(e)).join('\n') + '\n');
  log(`Selesai. ${urut.length} kode ${jenis} iDRG -> ${keluaran}`);
  return urut.length;
}

async function main(argv) {
  const folder = __dirname;
  const env = bacaEnv(folder);
  const [perintah, a1, a2] = argv;
  if (!perintah || /^(-h|--help|bantuan)$/.test(perintah)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return 0;
  }
  const panggil = buatKlien({ url: env.EKLAIM_URL, key: env.EKLAIM_KEY, debug: env.EKLAIM_DEBUG === '1' });

  if (perintah === 'cek') {
    const r = await panggil('search_diagnosis_inagrouper', { keyword: 'J45' });
    const code = r && r.metadata && r.metadata.code;
    if (Number(code) !== 200) { console.log('E-Klaim menjawab tetapi bukan sukses:', JSON.stringify(r.metadata)); return 1; }
    console.log(`Koneksi OK. Kamus iDRG menjawab ${r.response && r.response.count} kode untuk "J45".`);
    return 0;
  }
  if (perintah === 'klaim') {
    if (!a1) { console.log('Pakai: node eklaimBaca.js klaim <daftar_sep.txt> [keluaran.jsonl]'); return 2; }
    await perintahKlaim(panggil, a1, a2 || path.join(folder, 'hasil_klaim_eklaim.jsonl'));
    return 0;
  }
  if (perintah === 'kamus') {
    if (!['diagnosis', 'prosedur'].includes(a1)) { console.log('Pakai: node eklaimBaca.js kamus <diagnosis|prosedur> [keluaran.jsonl]'); return 2; }
    await perintahKamus(panggil, a1, a2 || path.join(folder, `kamus_idrg_${a1}.jsonl`));
    return 0;
  }
  console.log(`Perintah tidak dikenal: ${perintah}`);
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(k => process.exit(k)).catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
}

module.exports = {
  METHOD_BACA, enkripsi, dekripsi, buatKlien, ringkasKlaim, pecahProsedurIdrg,
  buangIdentitas, perintahKlaim, perintahKamus, bacaEnv,
};
