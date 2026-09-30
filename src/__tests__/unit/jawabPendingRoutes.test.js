/**
 * Rute Alur Menjawab Pending BPJS, lewat aplikasi Express sungguhan dengan
 * basis data dan layanan tiruan (pola sama dengan kelompokKlaim.test.js).
 */
const express = require('express');
const request = require('supertest');

const mockSql = [];
const mockRows = { daftar: [], total: { count: 0 } };

jest.mock('../../database/init', () => ({
  getDb: () => ({
    query: async () => ({ rows: [] }),
    prepare: (sql) => {
      mockSql.push(sql);
      return {
        all: async () => (/LEFT JOIN LATERAL/.test(sql) ? mockRows.daftar : []),
        get: async () => (/COUNT\(\*\) as count/.test(sql) ? mockRows.total : undefined),
        run: async () => ({ changes: 0 }),
      };
    },
  }),
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    if (req.headers['x-tanpa-login']) return res.status(401).json({ error: 'Token tidak valid.' });
    req.user = { id: 'koder1', role: 'verifikator' };
    next();
  },
  authorize: () => (_req, _res, next) => next(),
}));

const mockSvc = {
  sep: { statistikDariDb: jest.fn(), tautkanUlang: jest.fn() },
  peta: { petakanBaris: jest.fn(), ringkasan: jest.fn(), koreksiKategori: jest.fn() },
  triase: { hitungTriase: jest.fn(), ringkasanTriase: jest.fn(), koreksiKotak: jest.fn() },
  draft: { tampilanSampingan: jest.fn(), buatDraft: jest.fn(), daftarDraft: jest.fn(), setujuiDraft: jest.fn(), tolakDraft: jest.fn() },
};
jest.mock('../../services/sepCocokService', () => mockSvc.sep);
jest.mock('../../services/petaAlasanPendingService', () => mockSvc.peta);
jest.mock('../../services/triasePendingService', () => mockSvc.triase);
jest.mock('../../services/draftJawabanPendingService', () => mockSvc.draft);
jest.mock('../../services/alurJawabPendingSchema', () => ({ pastikanSekali: jest.fn().mockResolvedValue(undefined) }));

const BASE = '/api/v1/pending-jawaban';
let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use(BASE, require('../../routes/jawabPending'));
});

beforeEach(() => {
  mockSql.length = 0;
  mockRows.daftar = [];
  mockRows.total = { count: 0 };
  Object.values(mockSvc).forEach((g) => Object.values(g).forEach((f) => f.mockReset()));
});

const galat = (kode, pesan) => Object.assign(new Error(pesan), { kode });

describe('autentikasi', () => {
  test.each([
    ['get', '/sep/statistik'],
    ['post', '/alasan/petakan'],
    ['get', '/triase/ringkasan'],
    ['get', '/daftar'],
    ['post', '/draft/x/setujui'],
  ])('%s %s butuh login', async (metode, path) => {
    const res = await request(app)[metode](BASE + path).set('x-tanpa-login', '1');
    expect(res.status).toBe(401);
  });
});

describe('SEP', () => {
  test('statistik meneruskan filter dan mengembalikan hasil', async () => {
    mockSvc.sep.statistikDariDb.mockResolvedValue({ total: 3, cocok: 0, klaim_tidak_ada: 3, format: 0, per_periode: [] });
    const res = await request(app).get(`${BASE}/sep/statistik?pending_file_id=f1&periode=2026-05&rincian=true`);
    expect(res.status).toBe(200);
    expect(res.body.klaim_tidak_ada).toBe(3);
    expect(mockSvc.sep.statistikDariDb.mock.calls[0][1]).toEqual({ pendingFileId: 'f1', periode: '2026-05', rincian: true });
  });

  test('tautkan ulang', async () => {
    mockSvc.sep.tautkanUlang.mockResolvedValue({ diperiksa: 4, tertaut: 1 });
    const res = await request(app).post(`${BASE}/sep/tautkan-ulang`).send({ pending_file_id: 'f1' });
    expect(res.body).toEqual({ diperiksa: 4, tertaut: 1 });
  });
});

describe('alasan', () => {
  test('petakan: AI aktif secara bawaan, bisa dimatikan', async () => {
    mockSvc.peta.petakanBaris.mockResolvedValue({ diperiksa: 1 });
    await request(app).post(`${BASE}/alasan/petakan`).send({ pending_file_id: 'f1' });
    expect(mockSvc.peta.petakanBaris.mock.calls[0][1]).toMatchObject({ pakaiAi: true, ulang: false, pendingFileId: 'f1' });
    await request(app).post(`${BASE}/alasan/petakan`).send({ pakai_ai: false, ulang: true });
    expect(mockSvc.peta.petakanBaris.mock.calls[1][1]).toMatchObject({ pakaiAi: false, ulang: true });
  });

  test('koreksi kategori', async () => {
    mockSvc.peta.koreksiKategori.mockResolvedValue({ pending_id: 'p1', kategori: 'kode_diagnosis', sumber: 'manual' });
    const res = await request(app).patch(`${BASE}/alasan/p1`).send({ kategori: 'kode_diagnosis' });
    expect(res.status).toBe(200);
    expect(mockSvc.peta.koreksiKategori).toHaveBeenCalledWith(expect.anything(), 'p1', 'kode_diagnosis', 'koder1');
  });

  test('koreksi tanpa kategori -> 400; kategori tidak valid -> 400; tidak ada -> 404', async () => {
    expect((await request(app).patch(`${BASE}/alasan/p1`).send({})).status).toBe(400);
    mockSvc.peta.koreksiKategori.mockRejectedValueOnce(galat('kategori_tidak_valid', 'Kategori tidak dikenal.'));
    const r = await request(app).patch(`${BASE}/alasan/p1`).send({ kategori: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Kategori tidak dikenal.');
    mockSvc.peta.koreksiKategori.mockRejectedValueOnce(galat('tidak_ada', 'Data pending tidak ditemukan.'));
    expect((await request(app).patch(`${BASE}/alasan/zzz`).send({ kategori: 'kode_diagnosis' })).status).toBe(404);
  });

  test('ringkasan', async () => {
    mockSvc.peta.ringkasan.mockResolvedValue({ total: 2, per_kategori: [] });
    const res = await request(app).get(`${BASE}/alasan/ringkasan?pending_file_id=f1`);
    expect(res.body.total).toBe(2);
  });
});

describe('triase', () => {
  test('hitung dan ringkasan', async () => {
    mockSvc.triase.hitungTriase.mockResolvedValue({ dihitung: 5 });
    const res = await request(app).post(`${BASE}/triase/hitung`).send({ pending_file_id: 'f1', ulang: true });
    expect(res.body.dihitung).toBe(5);
    expect(mockSvc.triase.hitungTriase.mock.calls[0][1]).toMatchObject({ pendingFileId: 'f1', ulang: true });
    mockSvc.triase.ringkasanTriase.mockResolvedValue({ total: 5, kotak: [] });
    expect((await request(app).get(`${BASE}/triase/ringkasan`)).body.total).toBe(5);
  });

  test('putusan kotak manual; kotak wajib ada di body; kotak salah -> 400', async () => {
    mockSvc.triase.koreksiKotak.mockResolvedValue({ pending_id: 'p1', kotak_manual: 'D' });
    const ok = await request(app).patch(`${BASE}/triase/p1`).send({ kotak: 'D', catatan: 'tidak defensif' });
    expect(ok.status).toBe(200);
    expect(mockSvc.triase.koreksiKotak).toHaveBeenCalledWith(expect.anything(), 'p1', 'D', 'tidak defensif', 'koder1');
    expect((await request(app).patch(`${BASE}/triase/p1`).send({})).status).toBe(400);
    mockSvc.triase.koreksiKotak.mockRejectedValueOnce(galat('kotak_tidak_valid', 'Kotak harus A, B, C, atau D.'));
    expect((await request(app).patch(`${BASE}/triase/p1`).send({ kotak: 'Z' })).status).toBe(400);
  });
});

describe('daftar', () => {
  test('tidak tertelan rute lain dan mengembalikan bentuk paginasi', async () => {
    mockRows.total = { count: '2' };
    mockRows.daftar = [{ id: 'p1', kotak: 'A' }, { id: 'p2', kotak: 'B' }];
    const res = await request(app).get(`${BASE}/daftar?limit=10&page=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, limit: 10 });
    expect(res.body.items).toHaveLength(2);
  });

  test('filter kotak/kategori/jenis masuk sebagai parameter terikat, bukan disambung ke SQL', async () => {
    await request(app).get(`${BASE}/daftar?kotak=A' OR '1'='1&kategori=kode_diagnosis&jenis_rawat=rawat_inap`);
    const sql = mockSql.join('\n');
    expect(sql).toMatch(/COALESCE\(t\.kotak_manual, t\.kotak\) = \?/);
    expect(sql).toMatch(/m\.kategori = \?/);
    expect(sql).toMatch(/m\.jenis_rawat = \?/);
    expect(sql).not.toMatch(/OR '1'='1/);
  });

  test('filter kotak=belum dan status_draft=belum_ada', async () => {
    await request(app).get(`${BASE}/daftar?kotak=belum&status_draft=belum_ada`);
    const sql = mockSql.join('\n');
    expect(sql).toMatch(/COALESCE\(t\.kotak_manual, t\.kotak\) IS NULL/);
    expect(sql).toMatch(/d\.status IS NULL/);
  });

  test('limit dibatasi 200', async () => {
    const res = await request(app).get(`${BASE}/daftar?limit=99999`);
    expect(res.body.limit).toBe(200);
  });
});

describe('item & draf', () => {
  test('tampilan berdampingan', async () => {
    mockSvc.draft.tampilanSampingan.mockResolvedValue({ kolom: { alasan_pending: 'a', jawaban: 'b', bukti: [] } });
    const res = await request(app).get(`${BASE}/item/p1`);
    expect(res.body.kolom.alasan_pending).toBe('a');
  });

  test('item tidak ada -> 404', async () => {
    mockSvc.draft.tampilanSampingan.mockRejectedValue(galat('tidak_ada', 'Data pending tidak ditemukan.'));
    expect((await request(app).get(`${BASE}/item/zzz`)).status).toBe(404);
  });

  test('buat draf -> 201, pakai_ai diteruskan, userId dari token', async () => {
    mockSvc.draft.buatDraft.mockResolvedValue({ id: 'd1', status: 'draft' });
    const res = await request(app).post(`${BASE}/item/p1/draft`).send({ pakai_ai: true });
    expect(res.status).toBe(201);
    expect(mockSvc.draft.buatDraft).toHaveBeenCalledWith(expect.anything(), 'p1', { userId: 'koder1', pakaiAi: true });
  });

  test.each([
    ['belum_dipetakan', 422],
    ['kotak_belum_ada', 422],
  ])('buat draf gagal %s -> %i', async (kode, status) => {
    mockSvc.draft.buatDraft.mockRejectedValue(galat(kode, 'pesan'));
    const res = await request(app).post(`${BASE}/item/p1/draft`).send({});
    expect(res.status).toBe(status);
    expect(res.body.kode).toBe(kode);
  });

  test('riwayat draf', async () => {
    mockSvc.draft.daftarDraft.mockResolvedValue([{ id: 'd1' }]);
    expect((await request(app).get(`${BASE}/item/p1/draft`)).body.items).toHaveLength(1);
  });

  test('setujui: atas nama pengguna login, pengakuan diteruskan', async () => {
    mockSvc.draft.setujuiDraft.mockResolvedValue({ id: 'd1', status: 'siap' });
    const res = await request(app).post(`${BASE}/draft/d1/setujui`).send({ catatan: 'ok', akui_poin_tanpa_bukti: true });
    expect(res.body.status).toBe('siap');
    expect(mockSvc.draft.setujuiDraft).toHaveBeenCalledWith(expect.anything(), 'd1', { userId: 'koder1', catatan: 'ok', akuiTanpaBukti: true });
  });

  test.each([
    ['perlu_pengakuan', 409],
    ['bukti_gugur', 409],
    ['status_tidak_sah', 409],
    ['tidak_ada', 404],
  ])('setujui gagal %s -> %i', async (kode, status) => {
    mockSvc.draft.setujuiDraft.mockRejectedValue(galat(kode, 'pesan'));
    const res = await request(app).post(`${BASE}/draft/d1/setujui`).send({});
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: 'pesan', kode });
  });

  test('tolak draf', async () => {
    mockSvc.draft.tolakDraft.mockResolvedValue({ id: 'd1', status: 'ditolak' });
    const res = await request(app).post(`${BASE}/draft/d1/tolak`).send({ alasan: 'salah' });
    expect(res.body.status).toBe('ditolak');
    expect(mockSvc.draft.tolakDraft).toHaveBeenCalledWith(expect.anything(), 'd1', { userId: 'koder1', alasan: 'salah' });
  });
});

describe('kesalahan tak terduga', () => {
  test('500 memakai pesan umum tanpa membocorkan detail', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSvc.sep.statistikDariDb.mockRejectedValue(new Error('relation "x" does not exist'));
    const res = await request(app).get(`${BASE}/sep/statistik`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Terjadi gangguan pada sistem/);
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
    spy.mockRestore();
  });
});
