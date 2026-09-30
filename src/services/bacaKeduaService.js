/**
 * Baca kedua — Kimi sebagai pembaca kedua untuk klaim berisiko, dan logika
 * membandingkan dua bacaan.
 *
 * SIFAT KEAMANAN
 *  1. Pembaca kedua tidak dipanggil untuk semua klaim (hemat & terkendali):
 *     hanya rawat inap, tarif di atas ambang, ada tulisan tangan, keyakinan
 *     Luna rendah, atau diagnosis yang punya syarat penunjang. Ambang bisa
 *     diatur lewat opsi/env (BACA_KEDUA_AMBANG_TARIF, BACA_KEDUA_AMBANG_YAKIN);
 *     nilai bawaan di sini adalah PERKIRAAN awal, bukan angka dari RS.
 *  2. Temuan TANPA kutipan dibuang, dari model mana pun (Luna maupun Kimi).
 *     Pemanggil dapat menyuntikkan validasiKutipan (mis. validateQuotation di
 *     aiReviewService) supaya kutipan yang tidak ada di berkas juga dibuang.
 *  3. Sama -> usulan biasa dengan kedua kutipan. Berbeda -> `perlu_tinjauan`
 *     yang menampilkan kedua versi berdampingan dengan kutipannya masing-masing;
 *     tidak ada pemenang otomatis. Hanya satu pembaca yang punya temuan valid
 *     -> usulan dari pembaca itu, TANPA kenaikan keyakinan.
 *  4. Kesepakatan hanya MENAIKKAN keyakinan (dibatasi maks 1). Kesepakatan tidak
 *     menggantikan kewajiban kutipan dan tidak menggugurkan cek tabel rujukan:
 *     setiap usulan membawa cek_tabel_rujukan_tetap_wajib = true.
 *  5. Tidak ada gerbang "menunggu tinjauan" untuk membaca klaim atau status
 *     pending. `perlu_tinjauan` hanya label hasil bacaan yang berbeda; klaim
 *     tetap terbaca dan diproses.
 *  6. Fungsi murni; pemanggilan model disuntikkan (panggilKimi). Bila Kimi
 *     gagal, hasil Luna tetap dipakai (dengan kimi_gagal=true).
 *
 * STATUS: belum diuji terhadap Kimi K3 sungguhan; hanya diuji dengan
 * pemanggil tiruan.
 */

const REFERENSI = require('../data/syaratPenunjangDiagnosis.json');
const { kodeCocok } = require('./syaratPenunjangService');

const AMBANG_TARIF_BAWAAN = 10000000;
const AMBANG_YAKIN_BAWAAN = 0.7;
const BONUS_KESEPAKATAN = 0.1;

function angkaEnv(nama, bawaan) {
  const v = Number(process.env[nama]);
  return Number.isFinite(v) && process.env[nama] !== '' && process.env[nama] != null ? v : bawaan;
}

function daftarKode(v) {
  return (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map((s) => String(s).trim()).filter(Boolean);
}

function normYakin(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function adaSyaratPenunjang(diagnosis) {
  return daftarKode(diagnosis).some((d) => (REFERENSI.aturan || []).some((a) => kodeCocok(d, a.kode_diagnosis)));
}

function rawatInap(klaim) {
  const j = String(klaim.jenis_klaim || klaim.jenis_rawat || '').toLowerCase().trim();
  return j === 'ri' || j.includes('inap') || j === '1';
}

/**
 * Apakah klaim ini perlu pembaca kedua?
 * klaim: { jenis_klaim, tarif, punya_tulisan_tangan, keyakinan_luna, diagnosis }
 * @returns {{perlu:boolean, alasan:string[]}}
 */
function perluBacaKedua(klaim, opsi = {}) {
  const k = klaim || {};
  const ambangTarif = opsi.ambangTarif ?? angkaEnv('BACA_KEDUA_AMBANG_TARIF', AMBANG_TARIF_BAWAAN);
  const ambangYakin = opsi.ambangYakin ?? angkaEnv('BACA_KEDUA_AMBANG_YAKIN', AMBANG_YAKIN_BAWAAN);
  const alasan = [];
  if (rawatInap(k)) alasan.push('rawat_inap');
  const tarif = Number(k.tarif);
  if (Number.isFinite(tarif) && tarif > ambangTarif) alasan.push('tarif_tinggi');
  if (k.punya_tulisan_tangan === true) alasan.push('tulisan_tangan');
  const y = normYakin(k.keyakinan_luna);
  if (y !== null && y < ambangYakin) alasan.push('keyakinan_luna_rendah');
  if (adaSyaratPenunjang(k.diagnosis)) alasan.push('diagnosis_punya_syarat_penunjang');
  return { perlu: alasan.length > 0, alasan };
}

// ---------- perbandingan ----------

function kutipanAda(t) {
  return !!t && typeof t.kutipan === 'string' && t.kutipan.trim().length > 0;
}

function normNilai(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^-?\d+([.,]\d+)?$/.test(s)) return String(Number(s.replace(',', '.')));
  return s.replace(/[.;,]+$/, '');
}

/**
 * Bersihkan satu bacaan: buang temuan tanpa kutipan (atau yang gagal
 * validasiKutipan). Satu kunci hanya diwakili SATU temuan (yang pertama valid).
 * @returns {{sah: Map<string,object>, dibuang: object[]}}
 */
function bersihkanBacaan(bacaan, validasiKutipan) {
  const sah = new Map();
  const dibuang = [];
  for (const t of bacaan || []) {
    if (!t || !t.kunci) continue;
    let ok = kutipanAda(t);
    if (ok && typeof validasiKutipan === 'function') {
      try { ok = !!validasiKutipan(t); } catch { ok = false; }
    }
    if (!ok) { dibuang.push({ kunci: t.kunci, alasan: 'tanpa_kutipan_valid' }); continue; }
    if (!sah.has(t.kunci)) sah.set(t.kunci, t);
  }
  return { sah, dibuang };
}

function naikkanKeyakinan(k, bonus = BONUS_KESEPAKATAN) {
  const y = normYakin(k);
  if (y === null) return null;
  return Math.min(1, +(y + bonus).toFixed(4));
}

/**
 * Bandingkan bacaan pembaca pertama (Luna) dan kedua (Kimi).
 * Setiap temuan: { kunci, nilai, kutipan, halaman?, keyakinan? }
 * @returns {{usulan:object[], perlu_tinjauan:object[], dibuang:{luna:object[],kimi:object[]}}}
 */
function bandingkanBacaan(bacaanLuna, bacaanKimi, opsi = {}) {
  const L = bersihkanBacaan(bacaanLuna, opsi.validasiKutipan);
  const K = bersihkanBacaan(bacaanKimi, opsi.validasiKutipan);
  const kunci = [...new Set([...L.sah.keys(), ...K.sah.keys()])];
  const usulan = [];
  const tinjauan = [];

  for (const kn of kunci) {
    const l = L.sah.get(kn);
    const k = K.sah.get(kn);
    if (l && k) {
      if (normNilai(l.nilai) === normNilai(k.nilai)) {
        usulan.push({
          kunci: kn, nilai: l.nilai, sumber: 'luna+kimi', sepakat: true,
          kutipan: [
            { pembaca: 'luna', kutipan: l.kutipan, halaman: l.halaman ?? null },
            { pembaca: 'kimi', kutipan: k.kutipan, halaman: k.halaman ?? null },
          ],
          keyakinan: naikkanKeyakinan(l.keyakinan ?? k.keyakinan),
          cek_tabel_rujukan_tetap_wajib: true,
        });
      } else {
        tinjauan.push({
          kunci: kn, status: 'perlu_tinjauan',
          versi_luna: { nilai: l.nilai, kutipan: l.kutipan, halaman: l.halaman ?? null },
          versi_kimi: { nilai: k.nilai, kutipan: k.kutipan, halaman: k.halaman ?? null },
          cek_tabel_rujukan_tetap_wajib: true,
        });
      }
    } else {
      const t = l || k;
      const pembaca = l ? 'luna' : 'kimi';
      usulan.push({
        kunci: kn, nilai: t.nilai, sumber: pembaca, sepakat: false,
        kutipan: [{ pembaca, kutipan: t.kutipan, halaman: t.halaman ?? null }],
        keyakinan: normYakin(t.keyakinan),
        cek_tabel_rujukan_tetap_wajib: true,
      });
    }
  }
  return { usulan, perlu_tinjauan: tinjauan, dibuang: { luna: L.dibuang, kimi: K.dibuang } };
}

/**
 * Orkestrasi: putuskan perlu-tidaknya baca kedua, panggil (lewat fungsi
 * suntikan) bila perlu, lalu bandingkan.
 *
 * @param {{klaim:object, bacaanLuna:object[], panggilKimi:(klaim)=>Promise<object[]>, opsi?:object}} p
 */
async function jalankanBacaKedua({ klaim, bacaanLuna, panggilKimi, opsi = {} }) {
  const putusan = perluBacaKedua(klaim, opsi);
  if (!putusan.perlu || typeof panggilKimi !== 'function') {
    const hasil = bandingkanBacaan(bacaanLuna, [], opsi);
    return { dipanggil: false, alasan: putusan.alasan, kimi_gagal: false, ...hasil };
  }
  let bacaanKimi = [];
  let gagal = false;
  try {
    bacaanKimi = (await panggilKimi(klaim)) || [];
  } catch {
    gagal = true;
  }
  const hasil = bandingkanBacaan(bacaanLuna, bacaanKimi, opsi);
  return { dipanggil: true, alasan: putusan.alasan, kimi_gagal: gagal, ...hasil };
}

module.exports = {
  AMBANG_TARIF_BAWAAN, AMBANG_YAKIN_BAWAAN,
  perluBacaKedua, bersihkanBacaan, bandingkanBacaan, jalankanBacaKedua, naikkanKeyakinan, normNilai,
};
