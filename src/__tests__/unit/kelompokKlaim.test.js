/**
 * Pengelompokan Periode & Kategori pada Riwayat Upload.
 *
 * Diuji lewat aplikasi Express sungguhan dengan basis data tiruan, karena yang
 * perlu dijamin adalah PERILAKU rute, terutama urutannya: /kelompok satu
 * segmen dan bentrok dengan /:id kalau didaftarkan sesudahnya.
 */

const express = require('express');
const request = require('supertest');

const mockSql = [];
let mockBarisKelompok = [];

jest.mock('../../database/init', () => ({
  getDb: () => ({
    prepare: (sql) => {
      mockSql.push(sql);
      return {
        all: async () => (/GROUP BY r\.periode/.test(sql) ? mockBarisKelompok : []),
        // Kalau rute /kelompok tertelan /:id, handler /:id memanggil .get dan
        // hasilnya tidak berbentuk { kelompok } — test pertama menangkap itu.
        get: async () => (/COUNT\(\*\) as count/.test(sql) ? { count: 0 } : undefined),
      };
    },
    run: async () => ({ changes: 0 }),
  }),
}));

jest.mock('../../services/auditService', () => ({ logAudit: () => {} }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'a@b.c', role: 'admin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/v1/claim-files', require('../../routes/claimFiles'));
});

beforeEach(() => {
  mockSql.length = 0;
  mockBarisKelompok = [];
});

describe('GET /kelompok', () => {
  // Rute satu segmen. Kalau didaftarkan sesudah GET /:id, kata "kelompok"
  // ditelan sebagai id berkas dan halaman Riwayat Upload gagal memuat.
  test('tidak tertelan rute /:id', async () => {
    mockBarisKelompok = [{ periode: '2026-08', jenis_klaim: 'RAWAT_JALAN', total: '25', perlu: '1', siap: '24' }];
    const res = await request(app).get('/api/v1/claim-files/kelompok');
    expect(res.status).toBe(200);
    expect(res.body.kelompok).toBeDefined();
  });

  test('hitungan dikembalikan sebagai angka, bukan teks', async () => {
    mockBarisKelompok = [{ periode: '2026-08', jenis_klaim: 'RAWAT_JALAN', total: '25', perlu: '1', siap: '24' }];
    const res = await request(app).get('/api/v1/claim-files/kelompok');
    expect(res.body.kelompok[0]).toEqual({
      periode: '2026-08', jenis_klaim: 'RAWAT_JALAN', total: 25, perlu: 1, siap: 24,
    });
  });

  test('periode kosong dikembalikan null, bukan tanggal tebakan', async () => {
    mockBarisKelompok = [{ periode: null, jenis_klaim: null, total: '2', perlu: '0', siap: '2' }];
    const res = await request(app).get('/api/v1/claim-files/kelompok');
    expect(res.body.kelompok[0].periode).toBeNull();
    expect(res.body.kelompok[0].jenis_klaim).toBeNull();
  });

  // Arsip sengaja tidak ikut terhitung di daftar aktif: itulah gunanya arsip.
  test('daftar aktif mengecualikan yang terarsip, tampilan arsip kebalikannya', async () => {
    await request(app).get('/api/v1/claim-files/kelompok');
    expect(mockSql[0]).toMatch(/diarsipkan_pada IS NULL/);
    mockSql.length = 0;
    await request(app).get('/api/v1/claim-files/kelompok?arsip=1');
    expect(mockSql[0]).toMatch(/diarsipkan_pada IS NOT NULL/);
  });

  test('periode diturunkan dari record pertama berkas, sama dengan filter daftar', async () => {
    await request(app).get('/api/v1/claim-files/kelompok');
    expect(mockSql[0]).toMatch(/ORDER BY row_number LIMIT 1/);
  });
});

describe('GET / dengan filter periode dan tampilan', () => {
  const sqlDaftar = () => mockSql.find(s => /SELECT COUNT\(\*\) as count FROM claim_files/.test(s)) || '';

  // Header kelompok dan baris saat dibuka harus memakai definisi periode yang
  // SAMA, kalau tidak angka di header berbeda dari jumlah baris yang tampil.
  test('filter periode memakai definisi yang sama dengan /kelompok', async () => {
    await request(app).get('/api/v1/claim-files?periode=2026-08');
    expect(sqlDaftar()).toMatch(/ORDER BY row_number LIMIT 1\) = \?/);
  });

  test("periode 'tanpa' menyaring berkas yang periodenya belum pasti", async () => {
    await request(app).get('/api/v1/claim-files?periode=tanpa');
    expect(sqlDaftar()).toMatch(/LIMIT 1\) IS NULL/);
  });

  test('tampilan perlu dan siap memakai hitungan yang sudah ada', async () => {
    await request(app).get('/api/v1/claim-files?tampilan=perlu');
    expect(sqlDaftar()).toMatch(/\(cf\.pending_count \+ cf\.error_count\) > 0/);
    mockSql.length = 0;
    await request(app).get('/api/v1/claim-files?tampilan=siap');
    expect(sqlDaftar()).toMatch(/\(cf\.pending_count \+ cf\.error_count\) = 0/);
  });

  test('tampilan semua tidak menambah saringan', async () => {
    await request(app).get('/api/v1/claim-files?tampilan=semua');
    expect(sqlDaftar()).not.toMatch(/pending_count \+ cf\.error_count/);
  });

  // Nilai periode masuk sebagai parameter terikat, bukan disambung ke SQL.
  test('periode tidak disisipkan langsung ke teks SQL', async () => {
    await request(app).get("/api/v1/claim-files?periode=2026-08' OR '1'='1");
    expect(sqlDaftar()).not.toMatch(/OR '1'='1/);
  });
});
