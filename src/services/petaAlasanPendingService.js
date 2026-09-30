/**
 * Pemetaan alasan pending BPJS (alasan_raw) -> kategori, plus pemisahan
 * rawat jalan / rawat inap.
 *
 * URUTAN KERJA
 *  1. Aturan kata kunci deterministik (cepat, bisa diuji, tanpa token).
 *  2. Hanya alasan yang TIDAK terpetakan oleh aturan dikirim ke model
 *     (tugas 'petakan_alasan_pending' lewat gatewayModelService, sehingga
 *     identitas pasien disamarkan). Satu panggilan per alasan unik.
 *     Jawaban model hanya diterima bila kategorinya ada di daftar KATEGORI.
 *  3. Hasil disimpan di pending_alasan_peta beserta sumbernya
 *     ('aturan' | 'ai' | 'manual'). Koreksi manual TIDAK pernah ditimpa
 *     pemetaan ulang.
 *
 * JENIS KLAIM (rajal/ranap)
 *  - claim_records.jenis_klaim diturunkan dari isi dokumen (pdfPageClassifier
 *    .detectJenisKlaim: penanda IGD -> RAWAT_JALAN, "Jns Rawat" di SEP, dst).
 *  - bpjs_pending_responses.jenis_klaim = nama sheet rekap ('RJ'/'RI').
 *  Sheet rekap dipakai lebih dulu karena itu pengelompokan dari BPJS sendiri;
 *  jenis dari klaim menjadi cadangan. Bila keduanya ada dan berbeda,
 *  `jenis_konflik` bernilai true supaya tidak diam-diam salah.
 */

const KATEGORI = Object.freeze([
  'kegawatdaruratan',
  'kode_diagnosis',
  'kode_tindakan',
  'dokumen_tidak_lengkap',
  'hasil_penunjang',
  'indikasi_rawat_inap',
  'kunjungan_berulang',
  'prb_obat_kronis',
  'tarif_kelas_rawat',
  'administrasi_sep_rujukan',
  'icu_ventilator',
  'tidak_terpetakan',
]);

/**
 * Aturan berurutan: yang lebih spesifik lebih dulu. `pola` diuji pada teks
 * yang sudah dinormalkan (huruf kecil, spasi tunggal, tanpa tanda baca ganda).
 */
const ATURAN = Object.freeze([
  { id: 'gawat_1', kategori: 'kegawatdaruratan', pola: /kegawat|gawat\s*darurat|\bemergency\b|\bigd\b|\bugd\b|\btriase\b|\btriage\b/ },
  { id: 'icu_1', kategori: 'icu_ventilator', pola: /\bicu\b|\biccu\b|\bnicu\b|\bpicu\b|ventilator|intensive/ },
  { id: 'prb_1', kategori: 'prb_obat_kronis', pola: /\bprb\b|rujuk\s*balik|obat\s*kronis|program\s*rujukan\s*balik/ },
  { id: 'ulang_1', kategori: 'kunjungan_berulang', pola: /kunjungan\s*(berulang|ulang)|berulang|readmisi|re-?admisi|kasus\s*(yang\s*)?sama|episode|same\s*day|hari\s*yang\s*sama|pasien\s*yang\s*sama|dobel|ganda|duplikas/ },
  { id: 'tindakan_1', kategori: 'kode_tindakan', pola: /kode\s*tindakan|tindakan|prosedur|procedure|icd\s*-?\s*9|operasi|\bproc\s*list\b|proclist/ },
  { id: 'diagnosis_1', kategori: 'kode_diagnosis', pola: /diagnosis|diagnosa|icd\s*-?\s*10|kode\s*diag|primer|sekunder|koding|kode\s*tidak\s*sesuai|\bdx\b/ },
  { id: 'penunjang_1', kategori: 'hasil_penunjang', pola: /penunjang|\blab\b|laboratorium|radiologi|rontgen|\bx-?ray\b|\bekg\b|\becg\b|\bct\s*scan\b|\bmri\b|\busg\b|patologi|\bpa\b|hasil\s*pemeriksaan/ },
  { id: 'inap_1', kategori: 'indikasi_rawat_inap', pola: /indikasi\s*(rawat\s*inap|ranap)|rawat\s*inap|\branap\b|lama\s*rawat|\blos\b|hari\s*rawat|observasi|spri|perawatan\s*tidak\s*sesuai/ },
  { id: 'tarif_1', kategori: 'tarif_kelas_rawat', pola: /tarif|kelas\s*rawat|naik\s*kelas|top\s*up|selisih\s*biaya|iur\s*biaya|biaya/ },
  { id: 'admin_1', kategori: 'administrasi_sep_rujukan', pola: /\bsep\b|rujukan|surat\s*kontrol|identitas|data\s*peserta|kepesertaan|kartu|tanggal\s*(sep|pelayanan)|salah\s*input/ },
  { id: 'dok_1', kategori: 'dokumen_tidak_lengkap', pola: /lampir|lengkapi|kelengkapan|berkas|dokumen|resume|ringkasan\s*pulang|laporan\s*operasi|inform\s*consent|persetujuan|tanda\s*tangan|tidak\s*ada|belum\s*ada|tidak\s*terlampir|bukti\s*pelayanan|\bresep\b|\bobat\b/ },
]);

/** Huruf kecil, spasi tunggal; tanda baca selain - / . dijadikan spasi. */
function normalisasiAlasan(teks) {
  return String(teks == null ? '' : teks)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\-\/.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Petakan dengan aturan. Mengembalikan kategori utama (aturan pertama yang
 * cocok) dan semua kategori yang ikut cocok.
 * @returns {{kategori:string, aturan_id:string|null, kategori_lain:string[]}}
 */
function petakanDenganAturan(alasanRaw) {
  const t = normalisasiAlasan(alasanRaw);
  if (!t) return { kategori: 'tidak_terpetakan', aturan_id: null, kategori_lain: [] };
  const cocok = ATURAN.filter((a) => a.pola.test(t));
  if (cocok.length === 0) return { kategori: 'tidak_terpetakan', aturan_id: null, kategori_lain: [] };
  const utama = cocok[0];
  return {
    kategori: utama.kategori,
    aturan_id: utama.id,
    kategori_lain: [...new Set(cocok.slice(1).map((a) => a.kategori).filter((k) => k !== utama.kategori))],
  };
}

const JENIS = Object.freeze({ RAJAL: 'rawat_jalan', RANAP: 'rawat_inap', TIDAK: 'tidak_diketahui' });

function jenisDariLabel(label) {
  const s = String(label == null ? '' : label).trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (s === 'RJ' || s.includes('RAWATJALAN') || s === 'RAJAL') return JENIS.RAJAL;
  if (s === 'RI' || s.includes('RAWATINAP') || s === 'RANAP') return JENIS.RANAP;
  return null;
}

/**
 * @param {{jenis_klaim?:string}} pending baris rekap (label sheet RJ/RI)
 * @param {{jenis_klaim?:string}|null} klaim baris claim_records (RAWAT_JALAN/RAWAT_INAP)
 * @returns {{jenis:string, sumber:'rekap'|'klaim'|null, jenis_konflik:boolean}}
 */
function tentukanJenis(pending, klaim) {
  const dariRekap = jenisDariLabel(pending && pending.jenis_klaim);
  const dariKlaim = jenisDariLabel(klaim && klaim.jenis_klaim);
  if (dariRekap) {
    return { jenis: dariRekap, sumber: 'rekap', jenis_konflik: !!dariKlaim && dariKlaim !== dariRekap };
  }
  if (dariKlaim) return { jenis: dariKlaim, sumber: 'klaim', jenis_konflik: false };
  return { jenis: JENIS.TIDAK, sumber: null, jenis_konflik: false };
}

/* --------------------------------- AI --------------------------------- */

const SYSTEM_AI = `Kamu mengelompokkan alasan pending klaim BPJS rumah sakit ke tepat SATU kategori.
Kembalikan JSON: {"kategori":"<salah satu dari daftar>"}.
Daftar kategori: ${KATEGORI.filter((k) => k !== 'tidak_terpetakan').join(', ')}.
Bila alasan tidak jelas masuk yang mana, jawab {"kategori":"tidak_terpetakan"}. Jangan menambah kategori baru dan jangan menulis penjelasan.`;

/**
 * Minta model memetakan satu alasan. Identitas disamarkan oleh gateway lewat
 * `dikenal`. Mengembalikan null bila model gagal atau jawabannya di luar daftar.
 */
async function petakanDenganAi(alasanRaw, dikenal, { db, panggil } = {}) {
  const fn = panggil || require('./gatewayModelService').panggilModel;
  const r = await fn('petakan_alasan_pending', {
    system: SYSTEM_AI,
    prompt: `ALASAN_PENDING:\n${alasanRaw}`,
    dikenal: dikenal || {},
    json: true,
    maxTokens: 200,
    versi: 'petakan-v1',
  }, { db });
  if (!r || !r.ok || !r.hasil) return null;
  const k = String(r.hasil.kategori || '').trim();
  if (!KATEGORI.includes(k) || k === 'tidak_terpetakan') return null;
  return { kategori: k, model: r.model || null };
}

/**
 * Identitas yang DIKENAL dari baris rekap, untuk penyamaran.
 */
function dikenalDariBaris(b) {
  return {
    nama: b.nama_peserta || undefined,
    nomor_kartu: b.nokartu || undefined,
    sep: b.sep || undefined,
    no_rm: b.mrn || undefined,
  };
}

/* -------------------------------- DB ---------------------------------- */

/**
 * Petakan baris rekap pending. Baris yang sudah punya pemetaan `manual`
 * tidak disentuh; yang sudah 'aturan'/'ai' hanya dihitung ulang bila ulang=true.
 *
 * @param {object} db
 * @param {{pendingFileId?:string, ulang?:boolean, pakaiAi?:boolean, maksAi?:number, panggil?:Function}} opsi
 */
async function petakanBaris(db, opsi = {}) {
  const { pendingFileId, ulang = false, pakaiAi = true, maksAi = 50, panggil } = opsi;
  let sql = `
    SELECT bpr.id, bpr.sep, bpr.mrn, bpr.nokartu, bpr.nama_peserta, bpr.alasan_raw, bpr.jenis_klaim,
           cr.jenis_klaim AS klaim_jenis_klaim, m.sumber AS peta_sumber
    FROM bpjs_pending_responses bpr
    LEFT JOIN claim_records cr ON cr.id = bpr.claim_record_id
    LEFT JOIN pending_alasan_peta m ON m.pending_id = bpr.id
    WHERE 1=1`;
  const params = [];
  if (pendingFileId) { sql += ' AND bpr.pending_file_id = ?'; params.push(pendingFileId); }
  const baris = await db.prepare(sql).all(...params);

  const hasil = { diperiksa: baris.length, dilewati_manual: 0, dilewati_sudah: 0, oleh_aturan: 0, oleh_ai: 0, tidak_terpetakan: 0, ai_gagal: 0, konflik_jenis: 0 };
  const tunda = []; // baris yang menunggu AI
  const simpan = async (b, kategori, sumber, aturanId, kategoriLain, modelAi) => {
    const j = tentukanJenis(b, { jenis_klaim: b.klaim_jenis_klaim });
    if (j.jenis_konflik) hasil.konflik_jenis++;
    await db.prepare(`
      INSERT INTO pending_alasan_peta
        (pending_id, kategori, sumber, aturan_id, kategori_lain, model_ai, jenis_rawat, sumber_jenis, jenis_konflik, diperbarui_pada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (pending_id) DO UPDATE SET
        kategori = EXCLUDED.kategori, sumber = EXCLUDED.sumber, aturan_id = EXCLUDED.aturan_id,
        kategori_lain = EXCLUDED.kategori_lain, model_ai = EXCLUDED.model_ai,
        jenis_rawat = EXCLUDED.jenis_rawat, sumber_jenis = EXCLUDED.sumber_jenis,
        jenis_konflik = EXCLUDED.jenis_konflik, diperbarui_pada = CURRENT_TIMESTAMP
      WHERE pending_alasan_peta.sumber <> 'manual'
    `).run(b.id, kategori, sumber, aturanId || null, JSON.stringify(kategoriLain || []), modelAi || null,
      j.jenis, j.sumber, j.jenis_konflik);
  };

  for (const b of baris) {
    if (b.peta_sumber === 'manual') { hasil.dilewati_manual++; continue; }
    if (b.peta_sumber && !ulang) { hasil.dilewati_sudah++; continue; }
    const r = petakanDenganAturan(b.alasan_raw);
    if (r.kategori !== 'tidak_terpetakan') {
      await simpan(b, r.kategori, 'aturan', r.aturan_id, r.kategori_lain);
      hasil.oleh_aturan++;
    } else {
      tunda.push(b);
    }
  }

  // AI hanya untuk yang tersisa; satu panggilan per alasan unik.
  const cacheAi = new Map();
  let dipanggil = 0;
  for (const b of tunda) {
    const kunci = normalisasiAlasan(b.alasan_raw);
    let ai = null;
    if (pakaiAi && kunci) {
      if (cacheAi.has(kunci)) ai = cacheAi.get(kunci);
      else if (dipanggil < maksAi) {
        dipanggil++;
        try { ai = await petakanDenganAi(b.alasan_raw, dikenalDariBaris(b), { db, panggil }); } catch { ai = null; }
        cacheAi.set(kunci, ai);
        if (!ai) hasil.ai_gagal++;
      }
    }
    if (ai) {
      await simpan(b, ai.kategori, 'ai', null, [], ai.model);
      hasil.oleh_ai++;
    } else {
      await simpan(b, 'tidak_terpetakan', 'aturan', null, []);
      hasil.tidak_terpetakan++;
    }
  }
  return hasil;
}

/** Koreksi manual kategori satu baris; tidak akan ditimpa pemetaan ulang. */
async function koreksiKategori(db, pendingId, kategori, userId) {
  if (!KATEGORI.includes(kategori)) {
    const e = new Error('Kategori tidak dikenal.'); e.kode = 'kategori_tidak_valid'; throw e;
  }
  const ada = await db.prepare('SELECT id, jenis_klaim FROM bpjs_pending_responses WHERE id = ?').get(pendingId);
  if (!ada) { const e = new Error('Data pending tidak ditemukan.'); e.kode = 'tidak_ada'; throw e; }
  const j = tentukanJenis(ada, null);
  await db.prepare(`
    INSERT INTO pending_alasan_peta (pending_id, kategori, sumber, jenis_rawat, sumber_jenis, dikoreksi_oleh, dikoreksi_pada, diperbarui_pada)
    VALUES (?, ?, 'manual', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (pending_id) DO UPDATE SET
      kategori = EXCLUDED.kategori, sumber = 'manual', dikoreksi_oleh = EXCLUDED.dikoreksi_oleh,
      dikoreksi_pada = CURRENT_TIMESTAMP, diperbarui_pada = CURRENT_TIMESTAMP
  `).run(pendingId, kategori, j.jenis, j.sumber, userId || null);
  return { pending_id: pendingId, kategori, sumber: 'manual' };
}

/**
 * Ringkasan: hitungan per kategori x jenis, dan alasan mentah yang paling
 * sering muncul (dengan pangsanya, bukan persentase keyakinan apa pun).
 */
async function ringkasan(db, { pendingFileId, periode } = {}) {
  let sql = `
    SELECT bpr.id, bpr.sep, bpr.alasan_raw, bpr.tanggal_pending, m.kategori, m.sumber, m.jenis_rawat, m.jenis_konflik
    FROM bpjs_pending_responses bpr
    LEFT JOIN pending_alasan_peta m ON m.pending_id = bpr.id
    WHERE 1=1`;
  const params = [];
  if (pendingFileId) { sql += ' AND bpr.pending_file_id = ?'; params.push(pendingFileId); }
  let baris = await db.prepare(sql).all(...params);
  if (periode) {
    const { periodeDariSep } = require('./periodeKlaimService');
    const { normalisasiSep } = require('./sepCocokService');
    baris = baris.filter((b) => (periodeDariSep(normalisasiSep(b.sep).kunci) || 'tanpa') === periode);
  }

  const total = baris.length;
  const perKategori = {};
  const perJenis = {};
  const alasanFrekuen = new Map();
  let belumDipetakan = 0;
  let konflik = 0;
  for (const b of baris) {
    const k = b.kategori || 'belum_dipetakan';
    const j = b.jenis_rawat || 'tidak_diketahui';
    if (!b.kategori) belumDipetakan++;
    if (b.jenis_konflik) konflik++;
    const pk = perKategori[k] || (perKategori[k] = { kategori: k, total: 0, rawat_jalan: 0, rawat_inap: 0, tidak_diketahui: 0 });
    pk.total++; pk[j] = (pk[j] || 0) + 1;
    perJenis[j] = (perJenis[j] || 0) + 1;
    const kunci = normalisasiAlasan(b.alasan_raw);
    if (kunci) {
      const a = alasanFrekuen.get(kunci) || { contoh: b.alasan_raw, jumlah: 0, kategori: b.kategori || null };
      a.jumlah++;
      alasanFrekuen.set(kunci, a);
    }
  }
  const kategoriList = Object.values(perKategori).sort((a, b) => b.total - a.total)
    .map((x) => ({ ...x, pangsa: total ? Number((x.total / total).toFixed(4)) : 0 }));
  const alasanTeratas = [...alasanFrekuen.values()].sort((a, b) => b.jumlah - a.jumlah).slice(0, 10)
    .map((x) => ({ ...x, pangsa: total ? Number((x.jumlah / total).toFixed(4)) : 0 }));
  return { total, belum_dipetakan: belumDipetakan, konflik_jenis: konflik, per_jenis: perJenis, per_kategori: kategoriList, alasan_teratas: alasanTeratas };
}

module.exports = {
  KATEGORI, ATURAN, JENIS,
  normalisasiAlasan, petakanDenganAturan, jenisDariLabel, tentukanJenis,
  petakanDenganAi, dikenalDariBaris, petakanBaris, koreksiKategori, ringkasan,
};
