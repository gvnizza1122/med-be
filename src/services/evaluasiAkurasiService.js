/**
 * Harness pengukuran "Akurasi Pembacaan Berkas".
 *
 * Prinsip: ukur dulu, baru ubah. Modul ini hanya alat ukur. Kunci jawaban (30
 * klaim) dibuat manusia; formatnya di src/__tests__/fixtures/kunciJawaban/.
 * Modul murni: tanpa DB, tanpa AI, tanpa jaringan.
 *
 * Yang diukur (per jenis: diagnosis, prosedur; lalu nilai lab):
 *   Tertangkap      = benar yang ditemukan sistem / seluruh benar        (recall)
 *   Tepat           = keluaran sistem yang benar / seluruh keluaran      (precision)
 *   Tepat kategori  = kode salah tetapi kategori sama, DIHITUNG TERPISAH
 *                     (diagnosis: 3 karakter pertama, mis. J45 vs J46.9 -> J45.x;
 *                      prosedur: 2 angka pertama, kategori ICD-9-CM). Tidak
 *                     dicampur ke Tepat; dilaporkan sebagai kategori_saja.
 *   Nilai lab tepat = parameter + nilai + satuan SEMUA benar / seluruh nilai lab benar
 *   Kode dikarang   = kode keluaran sistem yang tidak didukung kutipan apa pun
 *                     di teks berkas. TARGET NOL. Didukung bila (a) entri
 *                     membawa kutipan+halaman yang ada di teks halaman itu, atau
 *                     (b) kode itu sendiri tertulis di teks berkas. Bila teks
 *                     berkas tidak diberikan, hasilnya `dinilai:false` (bukan 0).
 *
 * klasifikasiKesalahan() menandai satu ketidakcocokan sebagai tipe 1-5 bila
 * dapat ditentukan, selain itu tipe null. Tipe: 1 huruf salah, 2 teks benar
 * tempat salah, 3 salah tafsir, 4 dikarang, 5 tulisan tangan. Heuristik;
 * tandanya hipotesis untuk ditinjau manusia, bukan vonis.
 *
 * STATUS: teruji dengan data tiruan. Belum dijalankan pada kunci jawaban asli
 * (belum ada) maupun keluaran sistem live.
 */

const { verifikasiKutipan, normalisasiTeks } = require('./pagarTemuanService');
const { deteksiNegasi } = require('./negasiTemuanService');
const { cocokkan } = require('./kamusPenunjangService');
const { kunciParameter, normalisasiSatuan } = require('./bacaLabService');

const TIPE = {
  1: 'huruf_salah',
  2: 'teks_benar_tempat_salah',
  3: 'salah_tafsir',
  4: 'dikarang',
  5: 'tulisan_tangan',
};

// ── normalisasi ─────────────────────────────────────────────────────────────
/** J45.9 / j45.9 / "J45 9" -> J459. Titik dan spasi dibuang agar penulisan tidak memengaruhi. */
function normalKode(kode) {
  return String(kode == null ? '' : kode).toUpperCase().replace(/[\s.]/g, '');
}

function kodeDari(entri) {
  return typeof entri === 'string' ? entri : (entri && (entri.kode || entri.code || entri.teks)) || '';
}

function kategoriKode(kode, jenis) {
  const n = normalKode(kode);
  return jenis === 'prosedur' ? n.slice(0, 2) : n.slice(0, 3);
}

function bagi(a, b) {
  return b > 0 ? a / b : null;
}

function unik(daftar) {
  return [...new Set(daftar.map(normalKode).filter(Boolean))];
}

// ── kode dikarang ───────────────────────────────────────────────────────────
function teksBerkas(halaman) {
  return (halaman || [])
    .map(h => (h && (h.ocr_text != null ? h.ocr_text : h.text)) || '')
    .join('\n');
}

/** Apakah kode/entri didukung teks berkas. */
function didukungBerkas(entri, halaman) {
  const kode = kodeDari(entri);
  if (entri && typeof entri === 'object' && entri.kutipan) {
    const v = verifikasiKutipan(entri.kutipan, entri.halaman, halaman);
    if (v.valid) return true;
  }
  const isi = normalisasiTeks(teksBerkas(halaman));
  const k = String(kode).trim().toLowerCase();
  if (!k) return false;
  // Kode tertulis apa adanya (J45.9) atau tanpa titik (J459).
  return isi.includes(k) || isi.replace(/[.\s]/g, '').includes(normalKode(kode).toLowerCase());
}

function hitungDikarang(entriDiagnosis, entriProsedur, halaman) {
  if (!halaman || halaman.length === 0) {
    return { dinilai: false, jumlah: null, kode: [] };
  }
  const kode = [];
  for (const [jenis, daftar] of [['diagnosis', entriDiagnosis], ['prosedur', entriProsedur]]) {
    for (const e of daftar || []) {
      if (!kodeDari(e)) continue;
      if (!didukungBerkas(e, halaman)) kode.push({ jenis, kode: kodeDari(e) });
    }
  }
  return { dinilai: true, jumlah: kode.length, kode };
}

// ── kode: diagnosis dan prosedur ────────────────────────────────────────────
function hitungKode(benar, sistem, jenis) {
  const B = unik(benar || []);
  const S = unik((sistem || []).map(kodeDari));
  const tepat = S.filter(k => B.includes(k));
  const sisaS = S.filter(k => !B.includes(k));
  const sisaB = B.filter(k => !S.includes(k));

  // Pasangan satu-lawan-satu: satu kode benar hanya boleh dipakai satu kali.
  const kategoriSaja = [];
  const bTerpakai = new Set();
  for (const s of sisaS) {
    const cocok = sisaB.find(b => !bTerpakai.has(b) && kategoriKode(b, jenis) === kategoriKode(s, jenis));
    if (cocok) { bTerpakai.add(cocok); kategoriSaja.push({ sistem: s, benar: cocok }); }
  }
  const sistemKategori = new Set(kategoriSaja.map(p => p.sistem));
  const salah = sisaS.filter(s => !sistemKategori.has(s));
  const terlewat = sisaB.filter(b => !bTerpakai.has(b));

  return {
    jumlah_benar: B.length,
    jumlah_sistem: S.length,
    tepat: tepat.length,
    kategori_saja: kategoriSaja.length,
    tertangkap: bagi(tepat.length, B.length),
    tepat_rasio: bagi(tepat.length, S.length),
    tertangkap_kategori: bagi(tepat.length + kategoriSaja.length, B.length),
    tepat_kategori: bagi(tepat.length + kategoriSaja.length, S.length),
    daftar: { tepat, kategori_saja: kategoriSaja, salah, terlewat },
  };
}

// ── nilai lab ───────────────────────────────────────────────────────────────
function angka(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v == null ? '' : v).trim().replace(',', '.'));
  return String(v == null ? '' : v).trim() !== '' && Number.isFinite(n) ? n : null;
}

function kunciLab(nama) {
  const k = kunciParameter(nama);
  return k.key || `teks:${normalisasiTeks(nama)}`;
}

function samaNilai(a, b) {
  const x = angka(a); const y = angka(b);
  if (x == null || y == null) return false;
  return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
}

function samaSatuan(a, b) {
  return normalisasiSatuan(a) === normalisasiSatuan(b);
}

function samaTanggal(a, b) {
  return !a || !b || String(a) === String(b);
}

function hitungLab(benar, sistem) {
  const B = benar || [];
  const S = sistem || [];
  const dipakai = new Set();
  const hasil = [];
  let parameterAda = 0; let nilaiTepat = 0; let lengkapTepat = 0;

  for (const b of B) {
    const kb = kunciLab(b.parameter);
    // Kandidat: parameter sama (dan tanggal tidak bertentangan), belum dipakai.
    const kandidat = S.map((s, i) => ({ s, i }))
      .filter(({ s, i }) => !dipakai.has(i) && kunciLab(s.parameter) === kb && samaTanggal(b.tanggal, s.tanggal));
    if (kandidat.length === 0) { hasil.push({ benar: b, status: 'tidak_ditemukan', sistem: null }); continue; }
    parameterAda++;
    const persis = kandidat.find(({ s }) => samaNilai(b.nilai, s.nilai) && samaSatuan(b.satuan, s.satuan));
    const nilaiSaja = kandidat.find(({ s }) => samaNilai(b.nilai, s.nilai));
    if (persis) {
      dipakai.add(persis.i); nilaiTepat++; lengkapTepat++;
      hasil.push({ benar: b, status: 'tepat', sistem: persis.s });
    } else if (nilaiSaja) {
      dipakai.add(nilaiSaja.i); nilaiTepat++;
      hasil.push({ benar: b, status: 'satuan_salah', sistem: nilaiSaja.s });
    } else {
      dipakai.add(kandidat[0].i);
      hasil.push({ benar: b, status: 'nilai_salah', sistem: kandidat[0].s });
    }
  }
  return {
    jumlah_benar: B.length,
    jumlah_sistem: S.length,
    parameter_ditemukan: parameterAda,
    nilai_tepat: nilaiTepat,
    nilai_lab_tepat_count: lengkapTepat,
    nilai_lab_tepat: bagi(lengkapTepat, B.length),
    daftar: hasil,
  };
}

// ── satu klaim ──────────────────────────────────────────────────────────────
/**
 * @param {{klaim_id:string, diagnosis_benar?:string[], prosedur_benar?:string[], nilai_lab_benar?:Array}} kunci
 * @param {{klaim_id?:string, diagnosis?:Array, prosedur?:Array, nilai_lab?:Array, halaman?:Array}} keluaran
 */
function evaluasiKlaim(kunci, keluaran) {
  const k = kunci || {};
  const o = keluaran || {};
  const diagnosis = hitungKode(k.diagnosis_benar, o.diagnosis, 'diagnosis');
  const prosedur = hitungKode(k.prosedur_benar, o.prosedur, 'prosedur');
  const lab = hitungLab(k.nilai_lab_benar, o.nilai_lab);
  const dikarang = hitungDikarang(o.diagnosis, o.prosedur, o.halaman);
  return {
    klaim_id: k.klaim_id || o.klaim_id || null,
    ada_keluaran: keluaran != null,
    diagnosis, prosedur, lab, kode_dikarang: dikarang,
  };
}

// ── agregat ─────────────────────────────────────────────────────────────────
/** Jumlahkan hitungan seluruh klaim lalu hitung ulang rasio (micro-average). */
function agregat(hasilKlaim) {
  const semua = hasilKlaim || [];
  const jumlah = (jenis, f) => semua.reduce((t, h) => t + (h[jenis][f] || 0), 0);
  const gabungKode = (jenis) => {
    const benar = jumlah(jenis, 'jumlah_benar'); const sistem = jumlah(jenis, 'jumlah_sistem');
    const tepat = jumlah(jenis, 'tepat'); const kat = jumlah(jenis, 'kategori_saja');
    return {
      jumlah_benar: benar, jumlah_sistem: sistem, tepat, kategori_saja: kat,
      tertangkap: bagi(tepat, benar), tepat_rasio: bagi(tepat, sistem),
      tertangkap_kategori: bagi(tepat + kat, benar), tepat_kategori: bagi(tepat + kat, sistem),
    };
  };
  const labBenar = jumlah('lab', 'jumlah_benar');
  const labTepat = jumlah('lab', 'nilai_lab_tepat_count');
  const dinilai = semua.filter(h => h.kode_dikarang.dinilai);
  return {
    jumlah_klaim: semua.length,
    klaim_tanpa_keluaran: semua.filter(h => !h.ada_keluaran).map(h => h.klaim_id),
    diagnosis: gabungKode('diagnosis'),
    prosedur: gabungKode('prosedur'),
    lab: {
      jumlah_benar: labBenar, jumlah_sistem: jumlah('lab', 'jumlah_sistem'),
      parameter_ditemukan: jumlah('lab', 'parameter_ditemukan'),
      nilai_tepat: jumlah('lab', 'nilai_tepat'),
      nilai_lab_tepat_count: labTepat, nilai_lab_tepat: bagi(labTepat, labBenar),
    },
    kode_dikarang: {
      klaim_dinilai: dinilai.length,
      klaim_tidak_dinilai: semua.length - dinilai.length,
      jumlah: dinilai.reduce((t, h) => t + h.kode_dikarang.jumlah, 0),
      target: 0,
      tercapai: dinilai.length > 0 && dinilai.every(h => h.kode_dikarang.jumlah === 0),
    },
  };
}

/** Cocokkan kunci dan keluaran menurut klaim_id, evaluasi semuanya. */
function evaluasiSemua(daftarKunci, daftarKeluaran) {
  const peta = new Map((daftarKeluaran || []).map(o => [String(o.klaim_id), o]));
  const hasil = (daftarKunci || []).map(kunci => evaluasiKlaim(kunci, peta.get(String(kunci.klaim_id)) || null));
  const kunciId = new Set((daftarKunci || []).map(k => String(k.klaim_id)));
  return {
    per_klaim: hasil,
    agregat: agregat(hasil),
    keluaran_tanpa_kunci: (daftarKeluaran || []).map(o => o.klaim_id).filter(id => !kunciId.has(String(id))),
  };
}

// ── klasifikasi kesalahan tipe 1-5 ──────────────────────────────────────────
function levenshtein(a, b) {
  const s = String(a); const t = String(b);
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j++) d[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
  }
  return d[s.length][t.length];
}

// Pasangan huruf yang sering tertukar dengan angka pada OCR.
const MIRIP = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
function samaSetelahKoreksiMirip(a, b) {
  const koreksi = (x) => normalKode(x).split('').map(c => MIRIP[c] || c).join('');
  return normalKode(a) !== normalKode(b) && koreksi(a) === koreksi(b);
}

const HASIL = (tipe, alasan, keyakinan) => ({ tipe, nama: tipe ? TIPE[tipe] : 'tidak_dapat_ditentukan', alasan, keyakinan });

/**
 * Tandai satu ketidakcocokan.
 *
 * @param {{jenis:'diagnosis'|'prosedur'|'lab', sistem:any, benar?:any, teks_sistem?:string,
 *          kutipan?:string, halaman?:number, disangkal?:boolean, sumber?:string}} mismatch
 * @param {{halaman?:Array, kodeReferensi?:{diagnosis?:Set<string>,prosedur?:Set<string>}, nilaiLabBenar?:Array}} [ctx]
 * @returns {{tipe:1|2|3|4|5|null, nama:string, alasan:string, keyakinan:'tinggi'|'sedang'|'rendah'}}
 */
function klasifikasiKesalahan(mismatch, ctx = {}) {
  const m = mismatch || {};
  const halaman = ctx.halaman || [];
  const jenis = m.jenis;

  // Tipe 4: kode dikarang.
  if (jenis === 'diagnosis' || jenis === 'prosedur') {
    const kode = kodeDari(m.sistem);
    const ref = ctx.kodeReferensi && ctx.kodeReferensi[jenis];
    if (kode && ref instanceof Set && !ref.has(String(kode).trim().toUpperCase())) {
      return HASIL(4, `kode ${kode} tidak ada di tabel referensi ${jenis === 'diagnosis' ? 'ICD-10 WHO' : 'ICD-9-CM'}`, 'tinggi');
    }
    if (kode && halaman.length > 0 && !didukungBerkas(m.sistem, halaman) && !(m.kutipan && verifikasiKutipan(m.kutipan, m.halaman, halaman).valid)) {
      return HASIL(4, `kode ${kode} tidak didukung kutipan apa pun di teks berkas`, 'sedang');
    }
  }

  // Tipe 3: salah tafsir (disangkal dibaca ada, singkatan bertabrakan).
  const teksSistem = m.teks_sistem || (typeof m.sistem === 'string' ? m.sistem : '');
  if (m.disangkal === true || (m.kutipan && deteksiNegasi(m.kutipan, teksSistem && normalisasiTeks(m.kutipan).includes(normalisasiTeks(teksSistem)) ? teksSistem : null).disangkal && !m.benar)) {
    return HASIL(3, 'berkas menyangkal temuan ini (mis. "rh -/-") tetapi sistem membacanya sebagai ada', 'tinggi');
  }
  if (teksSistem && cocokkan(teksSistem).status === 'perlu_konfirmasi') {
    return HASIL(3, `singkatan "${teksSistem}" bertabrakan (mis. DC: kateter atau lainnya); arti dipilih tanpa dasar`, 'sedang');
  }

  // Tipe 2: nilai lab benar, tempat salah.
  if (jenis === 'lab' && m.sistem && Array.isArray(ctx.nilaiLabBenar)) {
    const lain = ctx.nilaiLabBenar.find(b => b !== m.benar && samaNilai(b.nilai, m.sistem.nilai) &&
      (kunciLab(b.parameter) !== kunciLab(m.sistem.parameter) || (m.benar && b.tanggal !== m.benar.tanggal)));
    if (lain) {
      return HASIL(2, `nilai ${m.sistem.nilai} memang ada di berkas tetapi milik ${lain.parameter}${lain.tanggal ? ' tanggal ' + lain.tanggal : ''}, bukan ${m.sistem.parameter}`, 'sedang');
    }
  }

  // Tipe 5: tulisan tangan.
  if (m.sumber === 'tulisan_tangan') {
    return HASIL(5, 'sumber temuan tulisan tangan', 'sedang');
  }

  // Tipe 1: huruf/angka salah.
  if (jenis === 'lab' && m.sistem && m.benar) {
    const a = angka(m.sistem.nilai); const b = angka(m.benar.nilai);
    const teks = String(m.sistem.nilai_teks || m.sistem.nilai);
    if (/[OoIl]/.test(teks) && /\d/.test(teks)) return HASIL(1, `angka "${teks}" memuat huruf yang mirip angka`, 'tinggi');
    if (a != null && b != null && a !== 0 && b !== 0) {
      const rasio = a / b;
      if ([10, 100, 1000, 0.1, 0.01, 0.001].some(f => Math.abs(rasio - f) < 1e-9 * f + 1e-9)) {
        return HASIL(1, `nilai ${a} vs ${b}: selisih hanya letak koma desimal`, 'sedang');
      }
    }
    const sa = String(m.sistem.nilai); const sb = String(m.benar.nilai);
    if (sa.length === sb.length && levenshtein(sa, sb) === 1) return HASIL(1, `angka ${sa} vs ${sb}: satu karakter berbeda`, 'sedang');
  }
  if ((jenis === 'diagnosis' || jenis === 'prosedur') && m.benar) {
    const s = kodeDari(m.sistem); const b = kodeDari(m.benar);
    if (samaSetelahKoreksiMirip(s, b)) return HASIL(1, `kode ${s} vs ${b}: huruf mirip angka (O/0, I/1, S/5)`, 'tinggi');
  }
  if (jenis !== 'diagnosis' && jenis !== 'prosedur' && m.benar && teksSistem && typeof m.benar === 'string') {
    const a = normalisasiTeks(teksSistem); const b = normalisasiTeks(m.benar);
    if (a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 2 && a !== b) {
      return HASIL(1, `"${teksSistem}" vs "${m.benar}": beda 1-2 huruf`, 'sedang');
    }
  }

  return HASIL(null, 'tidak dapat ditentukan dari data yang ada; perlu ditinjau manusia', 'rendah');
}

/**
 * Susun ketidakcocokan dari hasil evaluasiKlaim, lalu klasifikasikan semuanya.
 * @returns {{daftar: Array, per_tipe: object}}
 */
function klasifikasiKlaim(hasilKlaim, kunci, keluaran, ctx = {}) {
  const halaman = ctx.halaman || (keluaran && keluaran.halaman) || [];
  const dasar = { ...ctx, halaman, nilaiLabBenar: kunci && kunci.nilai_lab_benar };
  const entriPer = (jenis) => new Map(((keluaran && keluaran[jenis]) || []).map(e => [normalKode(kodeDari(e)), e]));
  const daftar = [];

  for (const jenis of ['diagnosis', 'prosedur']) {
    const info = hasilKlaim[jenis].daftar;
    const entri = entriPer(jenis);
    const tambah = (sistemKode, benarKode) => {
      const e = entri.get(normalKode(sistemKode));
      const objek = e && typeof e === 'object' ? e : null;
      const m = { jenis, sistem: sistemKode, benar: benarKode || null, kutipan: objek && objek.kutipan, halaman: objek && objek.halaman, disangkal: objek && objek.disangkal, sumber: objek && objek.sumber, teks_sistem: objek && objek.teks };
      daftar.push({ jenis, mismatch: m, ...klasifikasiKesalahan(m, dasar) });
    };
    info.salah.forEach(s => tambah(s, null));
    info.kategori_saja.forEach(p => tambah(p.sistem, p.benar));
  }
  for (const r of hasilKlaim.lab.daftar) {
    if (r.status === 'tepat' || r.status === 'tidak_ditemukan') continue;
    const m = { jenis: 'lab', sistem: r.sistem, benar: r.benar, sumber: r.sistem && r.sistem.sumber };
    daftar.push({ jenis: 'lab', mismatch: m, ...klasifikasiKesalahan(m, dasar) });
  }
  const perTipe = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, tidak_dapat_ditentukan: 0 };
  daftar.forEach(d => { perTipe[d.tipe || 'tidak_dapat_ditentukan']++; });
  return { daftar, per_tipe: perTipe };
}

module.exports = {
  TIPE, normalKode, kategoriKode,
  hitungKode, hitungLab, hitungDikarang, didukungBerkas,
  evaluasiKlaim, evaluasiSemua, agregat,
  klasifikasiKesalahan, klasifikasiKlaim, levenshtein,
};
