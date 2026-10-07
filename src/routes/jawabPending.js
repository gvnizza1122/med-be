/**
 * Alur Menjawab Pending BPJS — endpoint.
 * Mounted di /api/v1/pending-jawaban (lihat index.js).
 *
 *   SEP      GET  /sep/statistik            statistik cocok (cocok / klaim tidak ada / format), per periode
 *            POST /sep/tautkan-ulang        tautkan ulang baris rekap yang belum ter-link (hanya cocok aman)
 *   ALASAN   POST /alasan/petakan           petakan alasan -> kategori (aturan dulu, AI untuk sisa)
 *            GET  /alasan/ringkasan         hitungan per kategori x rawat jalan/inap + alasan teratas
 *            PATCH /alasan/:pendingId       koreksi kategori manual
 *   TRIASE   POST /triase/hitung            hitung kotak A/B/C/D + kriteria
 *            GET  /triase/ringkasan         jumlah per kotak (per jenis & kategori)
 *            PATCH /triase/:pendingId       putusan kotak manual koder
 *   DRAF     GET  /daftar                   daftar pending + kategori + kotak + status draf
 *            GET  /item/:pendingId          data tampilan berdampingan
 *            POST /item/:pendingId/draft    buat draf (dari kutipan berkas)
 *            GET  /item/:pendingId/draft    riwayat versi draf
 *            POST /draft/:draftId/setujui   persetujuan koder (wajib untuk status "siap")
 *            POST /draft/:draftId/tolak     tolak draf
 *
 * Tidak ada endpoint yang menulis ke jawaban_rs_manual / draft_klarifikasi.
 */
const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { pastikanSekali } = require('../services/alurJawabPendingSchema');
const sepCocok = require('../services/sepCocokService');
const peta = require('../services/petaAlasanPendingService');
const triase = require('../services/triasePendingService');
const draft = require('../services/draftJawabanPendingService');

const router = express.Router();

const PESAN_500 = 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.';
const STATUS_KODE = {
  tidak_ada: 404,
  kategori_tidak_valid: 400,
  kotak_tidak_valid: 400,
  belum_dipetakan: 422,
  kotak_belum_ada: 422,
  status_tidak_sah: 409,
  bukti_gugur: 409,
  perlu_pengakuan: 409,
  perlu_keputusan_koder: 409,
  tanpa_pengguna: 401,
};

function tangani(nama, fn) {
  return async (req, res) => {
    try {
      const db = getDb();
      await pastikanSekali(db);
      await fn(req, res, db);
    } catch (err) {
      const status = err && err.kode && STATUS_KODE[err.kode];
      if (status) return res.status(status).json({ error: err.message, kode: err.kode });
      console.error(`[jawabPending] ${nama} error:`, err);
      res.status(500).json({ error: PESAN_500 });
    }
  };
}

const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

/* ------------------------------- SEP -------------------------------- */

router.get('/sep/statistik', authenticate, tangani('sep-statistik', async (req, res, db) => {
  const { pending_file_id: pendingFileId, periode, rincian } = req.query;
  const s = await sepCocok.statistikDariDb(db, { pendingFileId, periode, rincian: bool(rincian) });
  res.json(s);
}));

router.post('/sep/tautkan-ulang', authenticate, tangani('sep-tautkan', async (req, res, db) => {
  const r = await sepCocok.tautkanUlang(db, { pendingFileId: (req.body || {}).pending_file_id });
  res.json(r);
}));

/* ------------------------------ ALASAN ------------------------------- */

router.post('/alasan/petakan', authenticate, tangani('alasan-petakan', async (req, res, db) => {
  const b = req.body || {};
  const r = await peta.petakanBaris(db, {
    pendingFileId: b.pending_file_id,
    ulang: bool(b.ulang),
    pakaiAi: b.pakai_ai === undefined ? true : bool(b.pakai_ai),
  });
  res.json(r);
}));

router.get('/alasan/ringkasan', authenticate, tangani('alasan-ringkasan', async (req, res, db) => {
  res.json(await peta.ringkasan(db, { pendingFileId: req.query.pending_file_id, periode: req.query.periode }));
}));

router.patch('/alasan/:pendingId', authenticate, tangani('alasan-koreksi', async (req, res, db) => {
  const { kategori } = req.body || {};
  if (!kategori) return res.status(400).json({ error: 'Kategori wajib diisi.' });
  res.json(await peta.koreksiKategori(db, req.params.pendingId, kategori, req.user && req.user.id));
}));

/* ------------------------------ TRIASE ------------------------------- */

router.post('/triase/hitung', authenticate, tangani('triase-hitung', async (req, res, db) => {
  const b = req.body || {};
  res.json(await triase.hitungTriase(db, { pendingFileId: b.pending_file_id, pendingId: b.pending_id, ulang: bool(b.ulang) }));
}));

router.get('/triase/ringkasan', authenticate, tangani('triase-ringkasan', async (req, res, db) => {
  res.json(await triase.ringkasanTriase(db, { pendingFileId: req.query.pending_file_id }));
}));

router.patch('/triase/:pendingId', authenticate, tangani('triase-koreksi', async (req, res, db) => {
  const b = req.body || {};
  if (b.kotak === undefined) return res.status(400).json({ error: 'Kotak wajib diisi (A, B, C, D, atau null untuk menghapus putusan manual).' });
  res.json(await triase.koreksiKotak(db, req.params.pendingId, b.kotak, b.catatan, req.user && req.user.id));
}));

/* ------------------------------- DRAF -------------------------------- */

router.get('/daftar', authenticate, tangani('daftar', async (req, res, db) => {
  const { pending_file_id: fileId, kotak, kategori, jenis_rawat: jenis, status_draft: statusDraft, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  let where = 'WHERE 1=1';
  const params = [];
  if (fileId) { where += ' AND bpr.pending_file_id = ?'; params.push(fileId); }
  if (kategori) { where += ' AND m.kategori = ?'; params.push(kategori); }
  if (jenis) { where += ' AND m.jenis_rawat = ?'; params.push(jenis); }
  if (kotak === 'belum') where += ' AND COALESCE(t.kotak_manual, t.kotak) IS NULL';
  else if (kotak) { where += ' AND COALESCE(t.kotak_manual, t.kotak) = ?'; params.push(kotak); }
  if (statusDraft === 'belum_ada') where += ' AND d.status IS NULL';
  else if (statusDraft) { where += ' AND d.status = ?'; params.push(statusDraft); }
  if (search) {
    where += ' AND (bpr.sep LIKE ? OR bpr.nama_peserta LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  const dari = `
    FROM bpjs_pending_responses bpr
    LEFT JOIN pending_alasan_peta m ON m.pending_id = bpr.id
    LEFT JOIN pending_triase t ON t.pending_id = bpr.id
    LEFT JOIN LATERAL (
      SELECT id, status, versi FROM draft_jawaban_pending
      WHERE pending_id = bpr.id ORDER BY versi DESC LIMIT 1
    ) d ON TRUE
    ${where}`;
  const total = await db.prepare(`SELECT COUNT(*) as count ${dari}`).get(...params);
  const rows = await db.prepare(`
    SELECT bpr.id, bpr.sep, bpr.nama_peserta, bpr.kdinacbg, bpr.tgl_pulang, bpr.claim_record_id, bpr.alasan_raw,
           m.kategori, m.sumber AS sumber_kategori, m.jenis_rawat, m.jenis_konflik,
           t.kotak AS kotak_hitung, t.kotak_manual, COALESCE(t.kotak_manual, t.kotak) AS kotak,
           d.id AS draft_id, d.status AS status_draft, d.versi AS versi_draft
    ${dari}
    ORDER BY bpr.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);
  res.json({ total: Number((total && total.count) || 0), page, limit, items: rows });
}));

router.get('/item/:pendingId', authenticate, tangani('item', async (req, res, db) => {
  res.json(await draft.tampilanSampingan(db, req.params.pendingId));
}));

router.post('/item/:pendingId/draft', authenticate, tangani('draft-buat', async (req, res, db) => {
  const b = req.body || {};
  const d = await draft.buatDraft(db, req.params.pendingId, { userId: req.user && req.user.id, pakaiAi: bool(b.pakai_ai) });
  res.status(201).json(d);
}));

router.get('/item/:pendingId/draft', authenticate, tangani('draft-daftar', async (req, res, db) => {
  res.json({ items: await draft.daftarDraft(db, req.params.pendingId) });
}));

router.post('/draft/:draftId/setujui', authenticate, tangani('draft-setujui', async (req, res, db) => {
  const b = req.body || {};
  res.json(await draft.setujuiDraft(db, req.params.draftId, {
    userId: req.user && req.user.id, catatan: b.catatan, akuiTanpaBukti: bool(b.akui_poin_tanpa_bukti),
  }));
}));

router.post('/draft/:draftId/tolak', authenticate, tangani('draft-tolak', async (req, res, db) => {
  const b = req.body || {};
  res.json(await draft.tolakDraft(db, req.params.draftId, { userId: req.user && req.user.id, alasan: b.alasan }));
}));

module.exports = router;
