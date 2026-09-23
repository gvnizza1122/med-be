/**
 * Arsip menggantikan hapus.
 *
 * Diuji lewat aplikasi Express sungguhan dengan basis data tiruan, karena yang
 * perlu dijamin bukan cuma SQL-nya melainkan PERILAKUNYA: hapus permanen tidak
 * boleh jalan tanpa konfirmasi, dan arsip harus bisa dibatalkan.
 */

const express = require('express');
const request = require('supertest');

// --- basis data tiruan ---
const mockJejak = { run: [], prepare: [] };
let mockHasilRun = { changes: 0 };
let mockHasilGet = { berkas: 0, baris_klaim: 0, periode: '-' };

jest.mock('../../database/init', () => ({
  getDb: () => ({
    run: async (sql, params) => { mockJejak.run.push({ sql, params }); return mockHasilRun; },
    prepare: (sql) => ({
      get: async (...p) => { mockJejak.prepare.push({ sql, params: p }); return mockHasilGet; },
      all: async () => [],
    }),
  }),
}));

const mockCatatanAudit = [];
jest.mock('../../services/auditService', () => ({
  logAudit: (entry) => { mockCatatanAudit.push(entry); },
}));

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'admin@rslestari.id', role: 'admin' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/v1/claim-files', require('../../routes/claimFiles'));
});

beforeEach(() => {
  mockJejak.run.length = 0;
  mockJejak.prepare.length = 0;
  mockCatatanAudit.length = 0;
  mockHasilRun = { changes: 0 };
  mockHasilGet = { berkas: 0, baris_klaim: 0, periode: '-' };
});

describe('POST /bulk-archive', () => {
  test('mengarsipkan dan mencatat siapa yang melakukannya', async () => {
    mockHasilRun = { changes: 3 };
    const res = await request(app).post('/api/v1/claim-files/bulk-archive').send({ ids: ['a', 'b', 'c'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived: 3 });
    expect(mockJejak.run[0].sql).toMatch(/UPDATE claim_files SET diarsipkan_pada/);
    expect(mockJejak.run[0].params[0]).toBe('u1');
  });

  // Tanpa ini, mengarsipkan dua kali akan menimpa catatan siapa yang pertama
  // mengarsipkan — dan jejak itulah yang membuat arsip bisa ditelusuri.
  test('yang sudah terarsip dilewati, bukan ditimpa', async () => {
    await request(app).post('/api/v1/claim-files/bulk-archive').send({ ids: ['a'] });
    expect(mockJejak.run[0].sql).toMatch(/diarsipkan_pada IS NULL/);
  });

  test('tercatat di Audit Log', async () => {
    mockHasilRun = { changes: 2 };
    await request(app).post('/api/v1/claim-files/bulk-archive').send({ ids: ['a', 'b'] });
    expect(mockCatatanAudit).toHaveLength(1);
    expect(mockCatatanAudit[0].action).toBe('bulk_archive');
    expect(mockCatatanAudit[0].details.jumlah_diarsipkan).toBe(2);
  });

  test('ids kosong ditolak', async () => {
    const res = await request(app).post('/api/v1/claim-files/bulk-archive').send({ ids: [] });
    expect(res.status).toBe(400);
  });

  test('lebih dari 500 ditolak', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const res = await request(app).post('/api/v1/claim-files/bulk-archive').send({ ids });
    expect(res.status).toBe(400);
  });
});

describe('POST /bulk-restore', () => {
  // Pengarsipan yang tidak bisa dibatalkan cuma penghapusan dengan nama yang
  // lebih ramah.
  test('mengembalikan dari arsip', async () => {
    mockHasilRun = { changes: 2 };
    const res = await request(app).post('/api/v1/claim-files/bulk-restore').send({ ids: ['a', 'b'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restored: 2 });
    expect(mockJejak.run[0].sql).toMatch(/diarsipkan_pada = NULL/);
    expect(mockJejak.run[0].sql).toMatch(/diarsipkan_pada IS NOT NULL/);
  });

  test('tercatat di Audit Log', async () => {
    mockHasilRun = { changes: 1 };
    await request(app).post('/api/v1/claim-files/bulk-restore').send({ ids: ['a'] });
    expect(mockCatatanAudit[0].action).toBe('bulk_restore');
  });
});

describe('POST /bulk-delete — penghapusan permanen', () => {
  // Inti perubahannya. Sebelumnya permintaan hapus langsung dieksekusi tanpa
  // pernah menyatakan cakupannya, dan di Audit Log tersisa aksi hapus massal
  // berisi ratusan UUID tanpa keterangan isi sama sekali.
  test('tanpa konfirmasi TIDAK menghapus apa pun', async () => {
    mockHasilGet = { berkas: 12, baris_klaim: 340, periode: '2026-01, 2026-02' };
    const res = await request(app).post('/api/v1/claim-files/bulk-delete').send({ ids: ['a', 'b'] });

    expect(res.status).toBe(409);
    expect(res.body.perlu_konfirmasi).toBe(true);
    expect(mockJejak.run.filter(r => /DELETE/.test(r.sql))).toHaveLength(0);
  });

  test('pratinjau menyebutkan apa yang akan hilang', async () => {
    mockHasilGet = { berkas: 12, baris_klaim: 340, periode: '2026-01, 2026-02' };
    const res = await request(app).post('/api/v1/claim-files/bulk-delete').send({ ids: ['a'] });

    expect(res.body.akan_hilang).toEqual({ berkas: 12, baris_klaim: 340, periode: '2026-01, 2026-02' });
    expect(res.body.saran).toMatch(/arsip massal/i);
  });

  test('dengan konfirmasi barulah menghapus', async () => {
    mockHasilRun = { changes: 2 };
    const res = await request(app).post('/api/v1/claim-files/bulk-delete')
      .send({ ids: ['a', 'b'], konfirmasi: true, alasan: 'salah upload' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    expect(mockJejak.run.some(r => /DELETE FROM claim_files/.test(r.sql))).toBe(true);
  });

  // Audit Log yang cuma berisi ratusan UUID tanpa keterangan tidak bisa
  // menjawab "apa yang hilang" ketika pertanyaan itu muncul berbulan kemudian.
  test('Audit Log mencatat cakupan dan alasannya', async () => {
    mockHasilRun = { changes: 2 };
    mockHasilGet = { berkas: 2, baris_klaim: 57, periode: '2026-03' };
    await request(app).post('/api/v1/claim-files/bulk-delete')
      .send({ ids: ['a', 'b'], konfirmasi: true, alasan: 'salah upload' });

    const catatan = mockCatatanAudit.find(c => c.action === 'bulk_delete');
    expect(catatan.details).toEqual({
      jumlah_berkas: 2, jumlah_baris_klaim: 57, periode: '2026-03', alasan: 'salah upload',
    });
  });
});
