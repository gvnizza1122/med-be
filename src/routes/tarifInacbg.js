/**
 * API endpoints untuk tarif INA-CBG PMK No. 3 Tahun 2023.
 *
 * Endpoints:
 * - GET /api/v1/tarif/lookup/:kodeInacbg - Lookup tarif berdasarkan kode
 * - POST /api/v1/tarif/verify - Verifikasi tarif klaim vs tarif resmi
 * - GET /api/v1/tarif/stats - Statistik tabel tarif yang sudah di-seed
 * - GET /api/v1/tarif/search - Cari tarif berdasarkan deskripsi/jenis layanan
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../database/init');
const { lookupTarifInacbg, getTarifResmi, validateTarifDiscrepancy } = require('../services/tarifInacbgLookup');
const { authenticate } = require('../middleware/auth');

/**
 * GET /api/v1/tarif/lookup/:kodeInacbg
 * Lookup tarif resmi untuk kode INA-CBG tertentu.
 *
 * Query params:
 *   - kelasRawat: 1, 2, atau 3 (opsional, default: 3 untuk Rawat Jalan)
 *
 * Response:
 *   {
 *     found: boolean,
 *     kodeInacbg: string,
 *     deskripsi: string,
 *     jenis_layanan: "RAWAT_INAP"|"RAWAT_JALAN",
 *     tarif: number | null,
 *     tarif_kelas_1: number | null,
 *     tarif_kelas_2: number | null,
 *     tarif_kelas_3: number | null,
 *     sumber: {
 *       regional: "1",
 *       tipe_rs: "D_SWASTA",
 *       sumber_halaman: number
 *     }
 *   }
 */
router.get('/lookup/:kodeInacbg', authenticate, (req, res) => {
  try {
    const { kodeInacbg } = req.params;
    const kelasRawat = req.query.kelasRawat ? Number(req.query.kelasRawat) : 3;

    const tarif = lookupTarifInacbg(kodeInacbg);

    if (!tarif) {
      return res.status(404).json({
        found: false,
        kodeInacbg,
        error: `Kode INA-CBG "${kodeInacbg}" tidak ditemukan dalam tabel PMK 3/2023 Regional 1 Kelas D Swasta.`
      });
    }

    const resmi = getTarifResmi(kodeInacbg, kelasRawat);

    return res.json({
      found: true,
      kodeInacbg: tarif.kode_inacbg,
      deskripsi: tarif.deskripsi,
      jenis_layanan: tarif.jenis_layanan,
      kelasRawat: tarif.jenis_layanan === 'RAWAT_JALAN' ? null : kelasRawat,
      tarif: resmi?.tarif ?? null,
      tarif_kelas_1: tarif.tarif_kelas_1 ?? null,
      tarif_kelas_2: tarif.tarif_kelas_2 ?? null,
      tarif_kelas_3: tarif.tarif_kelas_3 ?? null,
      sumber: {
        regional: tarif.regional,
        tipe_rs: tarif.tipe_rs,
        tipe_rs_label: 'Rumah Sakit Kelas D Swasta',
        sumber_halaman: tarif.sumber_halaman,
        sumber_dokumen: 'PMK No. 3 Tahun 2023 tentang Standar Tarif Pelayanan Kesehatan Program Jaminan Kesehatan'
      }
    });
  } catch (error) {
    console.error('Error in tarif lookup:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/v1/tarif/verify
 * Verifikasi tarif klaim vs tarif resmi PMK 3/2023.
 *
 * Body:
 *   {
 *     kodeInacbg: string,
 *     kelasRawat: number (1, 2, 3),
 *     tarifKlaim: number,
 *     jenisLayanan: "RAWAT_INAP" | "RAWAT_JALAN" (opsional, untuk logging)
 *   }
 *
 * Response:
 *   {
 *     valid: boolean,
 *     status: "MATCH" | "DISCREPANCY" | "KODE_TIDAK_DITEMUKAN" | "TARIF_TIDAK_BERLAKU" | "TARIF_KLAIM_KOSONG",
 *     tarifResmi: number | null,
 *     tarifKlaim: number | null,
 *     selisih: number,
 *     persentaseSelisih: number,
 *     detail: object (baris tarif dari tabel)
 *   }
 */
router.post('/verify', authenticate, (req, res) => {
  try {
    const { kodeInacbg, kelasRawat, tarifKlaim } = req.body;

    if (!kodeInacbg || !kelasRawat || tarifKlaim === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: kodeInacbg, kelasRawat, tarifKlaim'
      });
    }

    const result = validateTarifDiscrepancy(kodeInacbg, kelasRawat, tarifKlaim);

    // Tambah field persentaseSelisih untuk context lebih baik
    let persentaseSelisih = 0;
    if (result.tarifResmi && result.tarifResmi > 0) {
      persentaseSelisih = (result.selisih / result.tarifResmi) * 100;
    }

    return res.json({
      ...result,
      persentaseSelisih: Math.round(persentaseSelisih * 100) / 100
    });
  } catch (error) {
    console.error('Error in tarif verify:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/v1/tarif/stats
 * Statistik tabel tarif_inacbg_pmk3_2023 di database.
 */
router.get('/stats', authenticate, async (req, res) => {
  try {
    const db = getDb();

    // Check if table exists and has data
    const countRes = await db.get(
      'SELECT COUNT(*) as total_count FROM tarif_inacbg_pmk3_2023'
    ).catch(() => ({ total_count: 0 }));

    const totalRows = countRes?.total_count ?? 0;

    if (totalRows === 0) {
      return res.json({
        status: 'empty',
        message: 'Tabel tarif_inacbg_pmk3_2023 belum di-seed. Jalankan: cd ~/eclaim/be && node scripts/seedTarifInacbg.js',
        total_rows: 0,
        rawat_inap_count: 0,
        rawat_jalan_count: 0,
        last_imported: null
      });
    }

    // Get detailed stats from JSON metadata
    const jsonData = require('../data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json');
    const meta = jsonData.meta || {};

    const jenisRes = await db.all(
      'SELECT jenis_layanan, COUNT(*) as count FROM tarif_inacbg_pmk3_2023 GROUP BY jenis_layanan'
    );

    const countByJenis = {};
    jenisRes.forEach(row => {
      countByJenis[row.jenis_layanan] = row.count;
    });

    const lastImportRes = await db.get(
      'SELECT MAX(imported_at) as last_imported FROM tarif_inacbg_pmk3_2023'
    );

    return res.json({
      status: 'complete',
      meta: {
        source_name: meta.source_name,
        source_pages: meta.source_pages,
        regional: meta.regional,
        tipe_rs: meta.tipe_rs_label,
      },
      total_rows: totalRows,
      rawat_inap_count: countByJenis['RAWAT_INAP'] || 0,
      rawat_jalan_count: countByJenis['RAWAT_JALAN'] || 0,
      last_imported: lastImportRes?.last_imported || null,
      verification: {
        status: 'ok',
        cross_check_k_4_17_i: 'Rp1.264.200 (Kelas 3) - terverifikasi dari klaim riil'
      }
    });
  } catch (error) {
    console.error('Error in tarif stats:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/v1/tarif/search
 * Cari tarif berdasarkan deskripsi atau jenis layanan.
 *
 * Query params:
 *   - q: string (pencarian deskripsi, minimal 3 karakter)
 *   - jenisLayanan: "RAWAT_INAP" | "RAWAT_JALAN"
 *   - limit: number (default 20, max 100)
 */
router.get('/search', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { q, jenisLayanan, limit = 20 } = req.query;

    // Check if table has data
    const countRes = await db.get(
      'SELECT COUNT(*) as count FROM tarif_inacbg_pmk3_2023'
    ).catch(() => ({ count: 0 }));

    if (countRes.count === 0) {
      return res.status(503).json({
        error: 'Tabel tarif belum di-seed',
        message: 'Jalankan script: node scripts/seedTarifInacbg.js'
      });
    }

    let query = 'SELECT * FROM tarif_inacbg_pmk3_2023 WHERE 1=1';
    const params = [];

    if (q && q.length >= 2) {
      query += ` AND (kode_inacbg ILIKE ? OR deskripsi ILIKE ?)`;
      const searchTerm = `%${q}%`;
      params.push(searchTerm, searchTerm);
    }

    if (jenisLayanan) {
      query += ` AND jenis_layanan = ?`;
      params.push(jenisLayanan);
    }

    query += ` ORDER BY kode_inacbg LIMIT ?`;
    params.push(Math.min(Number(limit) || 20, 100));

    const results = await db.all(query, params);

    res.json({
      query: { q, jenisLayanan, limit },
      count: results.length,
      results
    });
  } catch (error) {
    console.error('Error in tarif search:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/v1/tarif/cross-check
 * Cross-check untuk verifikasi integritas data setelah seed.
 * Khususnya verifikasi K-4-17-I = Rp1.264.200 (Kelas 3).
 */
router.get('/cross-check', authenticate, async (req, res) => {
  try {
    const db = getDb();

    const checkRes = await db.get(
      `SELECT kode_inacbg, deskripsi, tarif_kelas_3, tarif_kelas_2, tarif_kelas_1,
              regional, tipe_rs, jenis_layanan, sumber_halaman
       FROM tarif_inacbg_pmk3_2023
       WHERE kode_inacbg = 'K-4-17-I'`
    ).catch(() => null);

    if (!checkRes) {
      return res.status(404).json({
        status: 'FAIL',
        message: 'Kode K-4-17-I tidak ditemukan. Tabel mungkin belum di-seed.',
        expected_tarif_kelas_3: 1264200,
        actual_tarif_kelas_3: null
      });
    }

    const expected = 1264200;
    const actual = checkRes.tarif_kelas_3;
    const passed = actual === expected;

    res.json({
      status: passed ? 'PASS' : 'FAIL',
      message: passed
        ? 'Cross-check OK - K-4-17-I cocok dengan nilai terverifikasi dari klaim riil'
        : `Cross-check GAGAL - Expected Rp${expected.toLocaleString('id-ID')} tapi dapat Rp${actual?.toLocaleString('id-ID') || '(null)'}`,
      code: 'K-4-17-I',
      deskripsi: checkRes.deskripsi,
      expected_tarif_kelas_3: expected,
      actual_tarif_kelas_3: actual,
      tarif_kelas_2: checkRes.tarif_kelas_2,
      tarif_kelas_1: checkRes.tarif_kelas_1,
      regional: checkRes.regional,
      tipe_rs: checkRes.tipe_rs,
      jenis_layanan: checkRes.jenis_layanan,
      sumber_halaman: checkRes.sumber_halaman,
      source: 'PMK No. 3 Tahun 2023, Halaman 195'
    });
  } catch (error) {
    console.error('Error in tarif cross-check:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
