/**
 * Pencocokan nomor SEP antara rekap pending BPJS (hasil impor Excel) dan
 * klaim di claim_records.
 *
 * MASALAH YANG DIJAWAB
 * "Cocok Klaim = 0" bisa berarti tiga hal yang sangat berbeda, dan sebelumnya
 * angkanya tidak membedakan:
 *   1. cocok                  -> SEP rekap ketemu di klaim
 *   2. klaim_tidak_ada        -> bentuk SEP wajar, tetapi tidak ada klaim
 *                                dengan nomor itu (periode tidak beririsan,
 *                                klaim sudah dihapus, belum diupload)
 *   3. format                 -> SEP di rekap/klaim bentuknya rusak (spasi,
 *                                karakter tersembunyi, huruf O vs angka 0,
 *                                sisa label "SEP:", dst) sehingga tidak bisa
 *                                dipastikan cocok atau tidak
 * Modul ini memisahkan ketiganya dan menghitungnya per periode (bulan
 * pelayanan yang dibaca dari nomor SEP, sama dengan periodeKlaimService).
 *
 * DUA TINGKAT KUNCI
 *  - kunci      : hasil pembersihan (Unicode NFKC, karakter tersembunyi dibuang,
 *                 huruf mirip dari Sirilik/Yunani dipulihkan, semua selain
 *                 huruf/angka dibuang, huruf besar, sisa label dipangkas).
 *                 Kecocokan di tingkat ini AMAN dan dipakai untuk menautkan.
 *  - kunciLipat : kunci dengan O->0, I/L->1, S->5, B->8, Z->2. Kecocokan di
 *                 tingkat ini hanya DUGAAN (kandidat) dan TIDAK dipakai untuk
 *                 menautkan otomatis; dilaporkan sebagai masalah format.
 *
 * Fungsi inti murni (tanpa DB). Fungsi berawalan "muat"/"tautkan" memakai db
 * dengan antarmuka prepare().all/run() yang sama seperti bagian lain.
 */

const { periodeDariSep } = require('./periodeKlaimService');

const PERSIS = 'persis';
const NORMALISASI = 'normalisasi';
const STATUS = Object.freeze({
  COCOK: 'cocok',
  KLAIM_TIDAK_ADA: 'klaim_tidak_ada',
  FORMAT: 'format',
});

// Huruf Sirilik/Yunani yang tampak identik dengan huruf Latin.
const HURUF_MIRIP = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'І': 'I', 'Ѕ': 'S', 'Ј': 'J',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};

const LIPAT = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

// 8 karakter kode PPK + MMYY + huruf (V) + 6 digit urut = 19 karakter.
const POLA_SEP = /^[0-9A-Z]{8}\d{4}[A-Z]\d{6}$/;
const POLA_SEP_DALAM = /[0-9A-Z]{8}\d{4}[A-Z]\d{6}/;
// Karakter tersembunyi: lebar-nol, arah teks, soft hyphen, BOM, kontrol.
// eslint-disable-next-line no-control-regex
const RE_TERSEMBUNYI = /[​-‏‪-‮⁠-⁤﻿­\u0000-\u001F\u007F-\u009F]/g;

function ubahHurufMirip(teks) {
  let out = '';
  for (const ch of teks) out += HURUF_MIRIP[ch] || ch;
  return out;
}

/**
 * Bersihkan satu nomor SEP.
 * @returns {{asli:string, kunci:string, kunciLipat:string, dibersihkan:boolean,
 *            dipangkas:boolean, bentukLazim:boolean, kosong:boolean}}
 */
function normalisasiSep(mentah) {
  const asli = mentah == null ? '' : String(mentah);
  let t = asli.normalize('NFKC').replace(RE_TERSEMBUNYI, '');
  t = ubahHurufMirip(t).toUpperCase();
  let kunci = t.replace(/[^0-9A-Z]/g, '');
  let dipangkas = false;
  if (kunci.length > 19) {
    const m = kunci.match(POLA_SEP_DALAM);
    // Sisa yang dibuang hanya boleh huruf (label "NO SEP", "(RI)"); bila sisanya
    // mengandung angka, bisa jadi digit salah ketik -> jangan dipangkas diam-diam.
    if (m) {
      const sisa = kunci.replace(m[0], '');
      if (!/\d/.test(sisa)) { kunci = m[0]; dipangkas = true; }
    }
  }
  const kunciLipat = kunci.replace(/[OILSBZ]/g, (c) => LIPAT[c]);
  return {
    asli,
    kunci,
    kunciLipat,
    dibersihkan: kunci !== asli.trim(),
    dipangkas,
    bentukLazim: POLA_SEP.test(kunci),
    kosong: kunci.length === 0,
  };
}

/** Kunci untuk kecocokan lipat pada bentuk 19 karakter: huruf pada posisi digit dipulihkan. */
function kunciLipatBentuk(kunci) {
  if (kunci.length !== 19) return kunci.replace(/[OILSBZ]/g, (c) => LIPAT[c]);
  // posisi 8-11 dan 13-18 wajib digit; posisi 12 wajib huruf
  return [...kunci].map((c, i) => {
    const digitDiharap = (i >= 8 && i <= 11) || i >= 13;
    return digitDiharap && LIPAT[c] ? LIPAT[c] : c;
  }).join('');
}

/**
 * Bangun indeks dari baris klaim.
 * @param {Array<{id:string, sep?:string, raw_data?:string|object}>} klaim
 *   SEP diambil dari kolom sep; bila kosong, dari raw_data.SEP.
 */
function bangunIndeksKlaim(klaim) {
  const persis = new Map();        // kunci -> [id]
  const lipat = new Map();         // kunciLipat -> [{id, kunci}]
  const hapusSatu = new Map();     // kunci dengan satu posisi dihapus -> [{id, kunci}]
  const perPeriode = {};           // periode -> jumlah klaim
  let tanpaSep = 0;

  for (const k of klaim || []) {
    let sep = k.sep;
    if (!sep || !String(sep).trim()) {
      try {
        const raw = typeof k.raw_data === 'string' ? JSON.parse(k.raw_data || '{}') : (k.raw_data || {});
        const kunciSep = Object.keys(raw).find((x) => String(x).replace(/[^A-Za-z]/g, '').toUpperCase() === 'SEP');
        sep = kunciSep ? raw[kunciSep] : null;
      } catch { sep = null; }
    }
    const n = normalisasiSep(sep);
    if (n.kosong) { tanpaSep++; continue; }
    (persis.get(n.kunci) || persis.set(n.kunci, []).get(n.kunci)).push(k.id);
    const kl = kunciLipatBentuk(n.kunci);
    (lipat.get(kl) || lipat.set(kl, []).get(kl)).push({ id: k.id, kunci: n.kunci });
    for (let i = 0; i < n.kunci.length; i++) {
      const v = n.kunci.slice(0, i) + n.kunci.slice(i + 1);
      (hapusSatu.get(v) || hapusSatu.set(v, []).get(v)).push({ id: k.id, kunci: n.kunci });
    }
    const p = periodeDariSep(n.kunci);
    const kp = p || 'tanpa';
    perPeriode[kp] = (perPeriode[kp] || 0) + 1;
  }
  return { persis, lipat, hapusSatu, perPeriode, jumlahKlaim: (klaim || []).length, tanpaSep };
}

/**
 * Klasifikasikan satu SEP rekap terhadap indeks klaim.
 * @returns {{status, tipe?, klaimId?, kandidat?:string[], alasan:string, periode:string|null, norm}}
 */
function cocokkanSatu(sepRekap, indeks) {
  const norm = normalisasiSep(sepRekap);
  const periode = periodeDariSep(norm.kunci);
  const hasil = (o) => ({ periode, norm, ...o });

  if (norm.kosong) {
    return hasil({ status: STATUS.FORMAT, alasan: 'SEP kosong atau hanya berisi karakter tak terbaca' });
  }

  const langsung = indeks.persis.get(norm.kunci);
  if (langsung && langsung.length) {
    const tipe = norm.asli.trim().toUpperCase() === norm.kunci ? PERSIS : NORMALISASI;
    return hasil({
      status: STATUS.COCOK, tipe, klaimId: langsung[0],
      alasan: tipe === PERSIS ? 'SEP sama persis' : 'Cocok setelah dibersihkan (spasi/karakter tersembunyi/label)',
      banyak: langsung.length > 1 ? langsung.length : undefined,
    });
  }

  // Tidak cocok pada tingkat aman: cari kandidat "mirip".
  const kandidat = new Set();
  const lipat = indeks.lipat.get(kunciLipatBentuk(norm.kunci));
  const alasanKandidat = [];
  if (lipat) {
    for (const c of lipat) kandidat.add(c.id);
    alasanKandidat.push('huruf/angka mirip tertukar (mis. O dan 0)');
  }
  if (norm.kunci.length >= 10) {
    const catat = (ids, label) => {
      if (!ids || !ids.length) return;
      ids.forEach((x) => kandidat.add(typeof x === 'string' ? x : x.id));
      if (!alasanKandidat.includes(label)) alasanKandidat.push(label);
    };
    // rekap kelebihan satu karakter
    for (let i = 0; i < norm.kunci.length; i++) {
      catat(indeks.persis.get(norm.kunci.slice(0, i) + norm.kunci.slice(i + 1)), 'kelebihan satu karakter');
    }
    // rekap kurang satu karakter
    catat(indeks.hapusSatu.get(norm.kunci), 'kurang satu karakter');
    // beda satu karakter (panjang sama)
    for (let i = 0; i < norm.kunci.length; i++) {
      const sama = (indeks.hapusSatu.get(norm.kunci.slice(0, i) + norm.kunci.slice(i + 1)) || [])
        .filter((c) => c.kunci.length === norm.kunci.length);
      catat(sama, 'beda satu karakter');
    }
  }
  if (kandidat.size > 0) {
    return hasil({
      status: STATUS.FORMAT, kandidat: [...kandidat].slice(0, 5),
      alasan: `Ada klaim yang sangat mirip (${[...new Set(alasanKandidat)].join('; ')}); perlu dicek manusia, tidak ditautkan otomatis`,
    });
  }

  if (!norm.bentukLazim) {
    return hasil({
      status: STATUS.FORMAT,
      alasan: `Bentuk SEP tidak lazim (${norm.kunci.length} karakter, seharusnya 19: 8 kode PPK + MMYY + huruf + 6 digit)`,
    });
  }

  return hasil({
    status: STATUS.KLAIM_TIDAK_ADA,
    alasan: periode && !indeks.perPeriode[periode]
      ? `Tidak ada klaim sama sekali untuk periode ${periode} di sistem`
      : 'Bentuk SEP wajar, tetapi tidak ada klaim dengan nomor ini',
  });
}

/**
 * Hitung statistik cocok untuk sekumpulan baris rekap.
 * @param {Array<{id:string, sep:string, claim_record_id?:string}>} barisRekap
 * @param {ReturnType<typeof bangunIndeksKlaim>} indeks
 * @returns {{total, cocok, klaim_tidak_ada, format, cocok_persis, cocok_normalisasi,
 *            per_periode: Array, penjelasan: string, rincian: Array}}
 */
function hitungStatistik(barisRekap, indeks, opsi = {}) {
  const rincian = [];
  const per = {};
  const t = { total: 0, cocok: 0, klaim_tidak_ada: 0, format: 0, cocok_persis: 0, cocok_normalisasi: 0 };

  for (const b of barisRekap || []) {
    const h = cocokkanSatu(b.sep, indeks);
    const periode = h.periode || 'tanpa';
    const p = per[periode] || (per[periode] = {
      periode, total: 0, cocok: 0, klaim_tidak_ada: 0, format: 0,
      klaim_di_periode_ini: indeks.perPeriode[periode] || 0,
    });
    t.total++; p.total++;
    t[h.status]++; p[h.status]++;
    if (h.status === STATUS.COCOK) { if (h.tipe === PERSIS) t.cocok_persis++; else t.cocok_normalisasi++; }
    if (opsi.rincian) {
      rincian.push({
        id: b.id, sep: b.sep, status: h.status, tipe: h.tipe || null, klaim_id: h.klaimId || null,
        kandidat: h.kandidat || null, alasan: h.alasan, periode: h.periode,
      });
    }
  }

  const periodeList = Object.values(per).sort((a, b) => String(a.periode).localeCompare(String(b.periode)));
  return { ...t, per_periode: periodeList, penjelasan: jelaskan(t, periodeList, indeks), rincian };
}

/** Kalimat penjelas supaya angka nol bisa dijelaskan, bukan cuma ditampilkan. */
function jelaskan(t, periodeList, indeks) {
  if (t.total === 0) return 'Tidak ada baris rekap pending untuk dicocokkan.';
  if (indeks.jumlahKlaim === 0) return 'Tidak ada klaim sama sekali di sistem, jadi tidak ada yang bisa cocok.';
  if (t.cocok > 0) {
    return `${t.cocok} dari ${t.total} baris cocok. ${t.klaim_tidak_ada} tidak cocok karena klaimnya tidak ada, ${t.format} tidak cocok karena format SEP.`;
  }
  const tanpaIrisan = periodeList.filter((p) => p.klaim_di_periode_ini === 0);
  const bagian = [`0 dari ${t.total} baris cocok.`];
  if (t.klaim_tidak_ada > 0) {
    bagian.push(`${t.klaim_tidak_ada} baris berformat wajar tetapi klaimnya tidak ada`
      + (tanpaIrisan.length ? ` (periode ${tanpaIrisan.map((p) => p.periode).join(', ')} tidak punya klaim di sistem)` : '') + '.');
  }
  if (t.format > 0) bagian.push(`${t.format} baris bermasalah format SEP.`);
  return bagian.join(' ');
}

/* ------------------------------ akses DB ------------------------------ */

/** Muat klaim (id + SEP) untuk indeks. raw_data hanya dibaca bila kolom sep kosong. */
async function muatIndeksKlaim(db) {
  const rows = await db.prepare(`
    SELECT id, sep, CASE WHEN sep IS NULL OR TRIM(sep) = '' THEN raw_data ELSE NULL END AS raw_data
    FROM claim_records WHERE file_id IN (SELECT id FROM claim_files WHERE is_testing = FALSE)
  `).all();
  return bangunIndeksKlaim(rows);
}

/**
 * Statistik cocok dari DB, opsional per file rekap dan/atau periode.
 * Tidak mengubah data apa pun.
 */
async function statistikDariDb(db, { pendingFileId, periode, rincian } = {}) {
  const indeks = await muatIndeksKlaim(db);
  let sql = 'SELECT id, sep, claim_record_id FROM bpjs_pending_responses WHERE 1=1';
  const params = [];
  if (pendingFileId) { sql += ' AND pending_file_id = ?'; params.push(pendingFileId); }
  let baris = await db.prepare(sql).all(...params);
  if (periode) baris = baris.filter((b) => (periodeDariSep(normalisasiSep(b.sep).kunci) || 'tanpa') === periode);
  return hitungStatistik(baris, indeks, { rincian });
}

/**
 * Tautkan ulang baris rekap yang claim_record_id-nya masih kosong memakai
 * pencocokan ternormalisasi. Hanya kecocokan AMAN (persis/normalisasi) yang
 * ditautkan; kandidat "mirip" tidak pernah ditautkan otomatis. Kolom lain
 * (termasuk jawaban_rs_manual) tidak disentuh.
 */
async function tautkanUlang(db, { pendingFileId } = {}) {
  const indeks = await muatIndeksKlaim(db);
  let sql = 'SELECT id, sep FROM bpjs_pending_responses WHERE claim_record_id IS NULL';
  const params = [];
  if (pendingFileId) { sql += ' AND pending_file_id = ?'; params.push(pendingFileId); }
  const baris = await db.prepare(sql).all(...params);
  let tertaut = 0;
  for (const b of baris) {
    const h = cocokkanSatu(b.sep, indeks);
    if (h.status === STATUS.COCOK && h.klaimId) {
      await db.prepare('UPDATE bpjs_pending_responses SET claim_record_id = ? WHERE id = ? AND claim_record_id IS NULL')
        .run(h.klaimId, b.id);
      tertaut++;
    }
  }
  return { diperiksa: baris.length, tertaut };
}

module.exports = {
  STATUS, PERSIS, NORMALISASI,
  normalisasiSep, bangunIndeksKlaim, cocokkanSatu, hitungStatistik,
  muatIndeksKlaim, statistikDariDb, tautkanUlang,
};
