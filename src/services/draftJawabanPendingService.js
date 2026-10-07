/**
 * Draf jawaban pending BPJS yang HANYA dibangun dari kutipan nyata di halaman
 * berkas klaim.
 *
 * ATURAN KERAS
 *  1. Setiap poin bukti membawa halaman + kutipan, dan kutipannya diverifikasi
 *     terhadap teks halaman itu (pagarTemuanService.verifikasiKutipan) SAAT
 *     draf dibuat dan diverifikasi ULANG saat koder menyetujui.
 *  2. Poin tanpa kutipan terverifikasi tertulis PERSIS
 *     "bukti tidak ditemukan di berkas". Tidak ada kalimat klinis yang
 *     dikarang; kalimatnya hanya bingkai netral + kutipan.
 *  3. Model (tugas 'rancang_jawaban_pending', lewat gateway + penyamaran)
 *     paling jauh MEMILIH dan MENGURUTKAN kutipan kandidat dengan mengembalikan
 *     nomor kandidat. Ia tidak menulis teks, jadi tidak bisa menyusupkan
 *     klaim baru. Bila model gagal, draf tetap jadi dari aturan saja.
 *  4. Persetujuan koder WAJIB sebelum status 'siap'. Hanya persetujuan yang
 *     bisa membuat status itu (permintaan khusus alur pending; bukan gerbang
 *     review umum). Draf disimpan di draft_jawaban_pending, terpisah dari
 *     jawaban_rs_manual dan draft_klarifikasi yang tidak pernah disentuh.
 *  5. Tidak ada angka keyakinan/persentase di mana pun.
 */

const { verifikasiKutipan } = require('./pagarTemuanService');
const { muatHalaman } = require('./buktiBerkasPendingService');
const { nilaiTriase, kotakBerlaku, KOTAK } = require('./triasePendingService');
const { tentukanJenis, dikenalDariBaris } = require('./petaAlasanPendingService');
const { v4: uuidv4 } = require('uuid');

const TIDAK_ADA_BUKTI = 'bukti tidak ditemukan di berkas';
const STATUS = Object.freeze({ DRAFT: 'draft', SIAP: 'siap', DITOLAK: 'ditolak', DIGANTI: 'diganti' });

function galat(kode, pesan) {
  const e = new Error(pesan);
  e.kode = kode;
  return e;
}

function kalimatBukti(halaman, kutipan) {
  return `Tercatat pada halaman ${halaman}: "${kutipan}"`;
}

/**
 * Susun poin dari hasil triase (murni).
 * @param {object} triase keluaran nilaiTriase
 * @param {string|null} kotak kotak yang berlaku (manual atau hitung)
 * @param {{pilihan?: Object<string, number[]>}} [opsi] pilihan AI: topik -> indeks kutipan terpilih
 * @returns {Array} poin
 */
function susunPoin(triase, kotak, opsi = {}) {
  const poin = [];
  for (const t of triase.topik_bukti || []) {
    let kutipan = t.kutipan || [];
    const pilih = opsi.pilihan && opsi.pilihan[t.topik];
    if (Array.isArray(pilih) && pilih.length > 0) {
      const terpilih = pilih.map((i) => kutipan[i]).filter(Boolean);
      if (terpilih.length > 0) kutipan = terpilih;
    }
    if (kutipan.length === 0) {
      poin.push({
        topik: t.topik, jenis_poin: 'bukti', kalimat: TIDAK_ADA_BUKTI,
        halaman: null, kutipan: null, terverifikasi: false, sumber_kriteria: null,
      });
      continue;
    }
    for (const q of kutipan) {
      poin.push({
        topik: t.topik, jenis_poin: 'bukti', kalimat: kalimatBukti(q.halaman, q.kutipan),
        halaman: q.halaman, kutipan: q.kutipan, terverifikasi: true, sumber_kriteria: null,
      });
    }
  }
  if (kotak === 'D') {
    poin.push({
      topik: 'Sikap RS', jenis_poin: 'sikap', kalimat: 'RS tidak mempertahankan klaim pada poin ini.',
      halaman: null, kutipan: null, terverifikasi: false, sumber_kriteria: triase.alasan_kotak || 'kotak D',
    });
  }
  if (poin.length === 0) {
    poin.push({
      topik: 'Dokumen pendukung', jenis_poin: 'bukti', kalimat: TIDAK_ADA_BUKTI,
      halaman: null, kutipan: null, terverifikasi: false, sumber_kriteria: triase.alasan_kotak || null,
    });
  }
  return poin;
}

/**
 * Pastikan invarian: poin bukti dengan kutipan HARUS lolos verifikasi; yang
 * tidak lolos diturunkan menjadi kalimat "bukti tidak ditemukan di berkas".
 */
function pastikanTerverifikasi(poin, halaman) {
  return poin.map((p) => {
    if (p.jenis_poin !== 'bukti') return p;
    if (p.kutipan == null) return { ...p, kalimat: TIDAK_ADA_BUKTI, halaman: null, kutipan: null, terverifikasi: false };
    const cek = verifikasiKutipan(p.kutipan, p.halaman, halaman);
    if (cek.valid) return { ...p, terverifikasi: true };
    return { ...p, kalimat: TIDAK_ADA_BUKTI, halaman: null, kutipan: null, terverifikasi: false, dibuang_karena: cek.alasan };
  });
}

function rakitTeks(poin) {
  return poin.map((p, i) => `${i + 1}. ${p.topik}: ${p.kalimat}`).join('\n');
}

function hitung(poin) {
  const bukti = poin.filter((p) => p.jenis_poin === 'bukti');
  return {
    terbukti: bukti.filter((p) => p.terverifikasi).length,
    tanpa_bukti: bukti.filter((p) => !p.terverifikasi).length,
  };
}

/* --------------------------------- AI --------------------------------- */

const SYSTEM_PILIH = `Kamu membantu koder klaim BPJS. Diberikan ALASAN_PENDING dan daftar KANDIDAT_KUTIPAN yang sudah
diverifikasi dari berkas. Pilih kandidat yang paling relevan menjawab alasan itu, urut dari paling relevan.
Kembalikan JSON: {"pilihan":{"<topik>":[nomor,...]}}. Gunakan HANYA nomor kandidat yang diberikan.
Jangan menulis kalimat, kutipan, atau penjelasan apa pun.`;

async function pilihDenganAi({ alasanRaw, triase, dikenal, db, panggil }) {
  const fn = panggil || require('./gatewayModelService').panggilModel;
  const kandidat = (triase.topik_bukti || []).filter((t) => (t.kutipan || []).length > 1);
  if (kandidat.length === 0) return { pilihan: {}, model: null };
  const teks = kandidat.map((t) => `TOPIK: ${t.topik}\n${t.kutipan.map((q, i) => `  ${i}. (hal. ${q.halaman}) ${q.kutipan}`).join('\n')}`).join('\n\n');
  const r = await fn('rancang_jawaban_pending', {
    system: SYSTEM_PILIH,
    prompt: `ALASAN_PENDING:\n${alasanRaw}\n\nKANDIDAT_KUTIPAN:\n${teks}`,
    dikenal, json: true, maxTokens: 400, versi: 'pilih-kutipan-v1',
  }, { db });
  if (!r || !r.ok || !r.hasil || typeof r.hasil.pilihan !== 'object' || !r.hasil.pilihan) return { pilihan: {}, model: null };
  const pilihan = {};
  for (const t of kandidat) {
    const arr = r.hasil.pilihan[t.topik];
    if (!Array.isArray(arr)) continue;
    const sah = arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < t.kutipan.length);
    if (sah.length > 0) pilihan[t.topik] = [...new Set(sah)];
  }
  return { pilihan, model: r.model || null };
}

/* -------------------------------- DB ---------------------------------- */

async function muatKonteks(db, pendingId) {
  const p = await db.prepare(`
    SELECT bpr.*, m.kategori, m.jenis_rawat, m.sumber AS sumber_kategori,
           t.kotak AS triase_kotak, t.kotak_manual, t.catatan_manual
    FROM bpjs_pending_responses bpr
    LEFT JOIN pending_alasan_peta m ON m.pending_id = bpr.id
    LEFT JOIN pending_triase t ON t.pending_id = bpr.id
    WHERE bpr.id = ?
  `).get(pendingId);
  if (!p) throw galat('tidak_ada', 'Data pending tidak ditemukan.');
  let klaim = null;
  if (p.claim_record_id) {
    klaim = await db.prepare(`
      SELECT id, sep, jenis_klaim, diagnosa_list, prosedur_list FROM claim_records WHERE id = ?
    `).get(p.claim_record_id);
  }
  const halaman = klaim ? await muatHalaman(db, klaim.id) : [];
  return { pending: p, klaim: klaim || null, halaman };
}

/**
 * Buat draf baru (versi berikutnya) untuk satu pending.
 * @param {{userId?:string, pakaiAi?:boolean, panggil?:Function}} opsi
 */
async function buatDraft(db, pendingId, opsi = {}) {
  const { pending, klaim, halaman } = await muatKonteks(db, pendingId);
  if (!pending.kategori) throw galat('belum_dipetakan', 'Alasan pending belum dipetakan ke kategori; jalankan pemetaan dulu.');

  const triase = nilaiTriase({ alasan_raw: pending.alasan_raw, kategori: pending.kategori, klaim, halaman });
  const kotak = pending.kotak_manual || triase.kotak;
  if (!kotak) throw galat('kotak_belum_ada', 'Pending ini belum punya kotak triase (kategori belum punya kriteria otomatis). Tetapkan kotak secara manual dulu.');

  let pilihan = {};
  let dibuatDengan = 'aturan';
  if (opsi.pakaiAi) {
    try {
      const r = await pilihDenganAi({
        alasanRaw: pending.alasan_raw, triase, dikenal: dikenalDariBaris(pending), db, panggil: opsi.panggil,
      });
      pilihan = r.pilihan;
      if (Object.keys(pilihan).length > 0) dibuatDengan = `aturan+ai:${r.model || 'model'}`;
    } catch { /* AI gagal: lanjut dari aturan saja */ }
  }

  const poin = pastikanTerverifikasi(susunPoin(triase, kotak, { pilihan }), halaman);
  const h = hitung(poin);
  const teks = rakitTeks(poin);

  const terakhir = await db.prepare('SELECT MAX(versi) AS v FROM draft_jawaban_pending WHERE pending_id = ?').get(pendingId);
  const versi = Number(terakhir && terakhir.v ? terakhir.v : 0) + 1;
  const id = uuidv4();
  await db.prepare(`UPDATE draft_jawaban_pending SET status = 'diganti' WHERE pending_id = ? AND status = 'draft'`).run(pendingId);
  await db.prepare(`
    INSERT INTO draft_jawaban_pending
      (id, pending_id, versi, status, kotak, kategori, teks_draft, poin, jumlah_poin_terbukti, jumlah_poin_tanpa_bukti, dibuat_dengan, dibuat_oleh)
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, pendingId, versi, kotak, pending.kategori, teks, JSON.stringify(poin), h.terbukti, h.tanpa_bukti, dibuatDengan, opsi.userId || null);
  return { id, pending_id: pendingId, versi, status: STATUS.DRAFT, kotak, kategori: pending.kategori, teks_draft: teks, poin, ...h, dibuat_dengan: dibuatDengan };
}

function uraiDraft(r) {
  if (!r) return null;
  let poin = [];
  try { poin = JSON.parse(r.poin || '[]'); } catch { poin = []; }
  return { ...r, poin };
}

/**
 * Setujui draf (WAJIB oleh koder untuk jadi 'siap'). Bukti diverifikasi ulang
 * terhadap teks halaman terkini; bila ada yang gugur, persetujuan ditolak.
 * Bila ada poin tanpa bukti, koder harus mengakuinya eksplisit.
 */
async function setujuiDraft(db, draftId, { userId, catatan, akuiTanpaBukti = false } = {}) {
  if (!userId) throw galat('tanpa_pengguna', 'Persetujuan harus atas nama koder yang login.');
  const d = uraiDraft(await db.prepare('SELECT * FROM draft_jawaban_pending WHERE id = ?').get(draftId));
  if (!d) throw galat('tidak_ada', 'Draf tidak ditemukan.');
  if (d.status !== STATUS.DRAFT) throw galat('status_tidak_sah', `Draf berstatus "${d.status}", hanya draf berstatus "draft" yang bisa disetujui.`);

  const { pending, klaim, halaman } = await muatKonteks(db, d.pending_id);
  const periksa = pastikanTerverifikasi(d.poin, halaman);
  const gugur = periksa.filter((p, i) => d.poin[i].terverifikasi && !p.terverifikasi);
  if (gugur.length > 0) {
    throw galat('bukti_gugur', `${gugur.length} kutipan tidak lagi cocok dengan teks halaman (berkas berubah?). Buat draf baru.`);
  }
  // Draf lama mungkin berisi kutipan literal yang kini dikenali sebagai
  // rencana, negasi, atau tagihan. Kehadiran teks saja belum cukup untuk
  // menyetujui bukti: cocokkan lagi dengan penilaian konteks saat ini.
  const triase = nilaiTriase({ alasan_raw: pending.alasan_raw, kategori: pending.kategori || 'tidak_terpetakan', klaim, halaman });
  const kandidat = (triase.topik_bukti || []).flatMap(t => t.kutipan || []);
  const tidakDidukung = d.poin.filter(p => p.jenis_poin === 'bukti' && p.terverifikasi
    && !kandidat.some(k => Number(k.halaman) === Number(p.halaman) && k.kutipan === p.kutipan));
  if (tidakDidukung.length) throw galat('bukti_gugur', `${tidakDidukung.length} kutipan belum memenuhi pemeriksaan konteks bukti saat ini. Buat draf baru dari teks tersimpan.`);
  if (d.kotak === 'D' && pending.kotak_manual !== 'D') {
    throw galat('perlu_keputusan_koder', 'Sikap tidak mempertahankan klaim harus ditetapkan secara manual oleh koder.');
  }
  const h = hitung(d.poin);
  if (h.tanpa_bukti > 0 && !akuiTanpaBukti) {
    throw galat('perlu_pengakuan', `Ada ${h.tanpa_bukti} poin "${TIDAK_ADA_BUKTI}". Setujui dengan akui_poin_tanpa_bukti=true bila memang begitu adanya.`);
  }
  await db.prepare(`
    UPDATE draft_jawaban_pending
    SET status = 'siap', disetujui_oleh = ?, disetujui_pada = CURRENT_TIMESTAMP, catatan_koder = ?
    WHERE id = ? AND status = 'draft'
  `).run(userId, catatan || null, draftId);
  return uraiDraft(await db.prepare('SELECT * FROM draft_jawaban_pending WHERE id = ?').get(draftId));
}

async function tolakDraft(db, draftId, { userId, alasan } = {}) {
  const d = await db.prepare('SELECT id, status FROM draft_jawaban_pending WHERE id = ?').get(draftId);
  if (!d) throw galat('tidak_ada', 'Draf tidak ditemukan.');
  if (d.status !== STATUS.DRAFT) throw galat('status_tidak_sah', `Draf berstatus "${d.status}", hanya "draft" yang bisa ditolak.`);
  await db.prepare(`
    UPDATE draft_jawaban_pending SET status = 'ditolak', ditolak_oleh = ?, ditolak_pada = CURRENT_TIMESTAMP, alasan_tolak = ?
    WHERE id = ? AND status = 'draft'
  `).run(userId || null, alasan || null, draftId);
  return uraiDraft(await db.prepare('SELECT * FROM draft_jawaban_pending WHERE id = ?').get(draftId));
}

async function daftarDraft(db, pendingId) {
  const rows = await db.prepare('SELECT * FROM draft_jawaban_pending WHERE pending_id = ? ORDER BY versi DESC').all(pendingId);
  return (rows || []).map(uraiDraft);
}

/**
 * Data tampilan berdampingan: alasan pending | draf jawaban | kutipan bukti.
 * jawaban_rs_manual hanya DIBACA (tampil apa adanya), tidak pernah diubah.
 */
async function tampilanSampingan(db, pendingId) {
  const { pending, klaim, halaman } = await muatKonteks(db, pendingId);
  const drafts = await daftarDraft(db, pendingId);
  const draft = drafts.find((d) => d.status === STATUS.SIAP) || drafts.find((d) => d.status === STATUS.DRAFT) || drafts[0] || null;
  const triase = nilaiTriase({ alasan_raw: pending.alasan_raw, kategori: pending.kategori || 'tidak_terpetakan', klaim, halaman });
  const kotak = kotakBerlaku({ kotak: triase.kotak, kotak_manual: pending.kotak_manual });
  const jenis = tentukanJenis(pending, klaim);

  return {
    pending: {
      id: pending.id, sep: pending.sep, nama_peserta: pending.nama_peserta, mrn: pending.mrn,
      kdinacbg: pending.kdinacbg, jenis_rawat: pending.jenis_rawat || jenis.jenis, tgl_pulang: pending.tgl_pulang,
      kategori: pending.kategori || null, sumber_kategori: pending.sumber_kategori || null,
      claim_record_id: pending.claim_record_id || null, klaim_ada: !!klaim, jumlah_halaman: halaman.length,
      jawaban_rs_manual: pending.jawaban_rs_manual || null,
    },
    triase: {
      kotak, kotak_hitung: triase.kotak, kotak_manual: pending.kotak_manual || null, catatan_manual: pending.catatan_manual || null,
      label: kotak ? KOTAK[kotak].label : null, alasan_kotak: triase.alasan_kotak,
      kriteria: triase.kriteria, dokumen_dibutuhkan: triase.dokumen_dibutuhkan, kode_dipersoalkan: triase.kode_dipersoalkan,
    },
    draft,
    kolom: {
      alasan_pending: pending.alasan_raw,
      jawaban: draft ? draft.teks_draft : null,
      bukti: draft
        ? draft.poin.filter((p) => p.jenis_poin === 'bukti').map((p) => ({
          topik: p.topik, halaman: p.halaman, kutipan: p.kutipan, terverifikasi: p.terverifikasi,
        }))
        : [],
    },
    riwayat_versi: drafts.map((d) => ({ id: d.id, versi: d.versi, status: d.status, dibuat_pada: d.dibuat_pada })),
  };
}

module.exports = {
  TIDAK_ADA_BUKTI, STATUS,
  susunPoin, pastikanTerverifikasi, rakitTeks, hitung, pilihDenganAi,
  buatDraft, setujuiDraft, tolakDraft, daftarDraft, tampilanSampingan,
};
