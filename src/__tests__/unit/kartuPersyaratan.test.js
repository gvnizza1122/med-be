/**
 * Kartu persyaratan klaim per diagnosis: butir AI hanya yang kutipannya ada
 * persis di PDF PNPK; butir otomatis menunjuk aturan aplikasi yang ada; kartu
 * dipilih sesuai kode/usia; butir ditolak telaah tidak dipakai agen; prompt
 * agen ringkas.
 */
const express = require('express');
const request = require('supertest');
const data = require('../../data/kartuPersyaratan.json');
const pokok = require('../../data/pnpkPokok.json');
const katalogSvc = require('../../services/katalogPedomanService');
const svc = require('../../services/kartuPersyaratanService');
const pnpk = require('../../services/pnpkPengetahuanService');
const { cocokKutipan } = require('../../../scripts/drafKartuPnpk');

const dewasa = { admission_date: '2026-10-01', umur_tahun: 50, birth_date: '1976-01-01' };
const anak = { admission_date: '2026-10-01', umur_tahun: 6, birth_date: '2020-01-01' };

describe('isi kartu', () => {
  test('setiap butir agen berkutipan persis pada halaman PDF PNPK yang disebut', () => {
    let n = 0;
    for (const k of data.kartu) for (const b of k.butir.filter(x => x.cara === 'agen')) {
      const kat = katalogSvc.katalog.dokumen.find(d => d.id === b.sumber.katalog_id);
      const hal = katalogSvc.halaman(kat).find(p => p.page_number === Number(b.sumber.halaman));
      expect(cocokKutipan(b.kutipan, hal.text)).toBe(true);
      n += 1;
    }
    expect(n).toBeGreaterThan(0);
  });
  test('setiap butir otomatis menunjuk aturan aplikasi yang ada', () => {
    const ada = new Set(svc.semuaAturan().map(a => a.id));
    for (const k of data.kartu) for (const b of k.butir.filter(x => x.cara === 'otomatis')) expect(ada.has(b.aturan_id)).toBe(true);
  });
  test('kartu berstatus draf dan PNPK sumbernya ada di katalog', () => {
    const ids = new Set(pokok.dokumen.map(d => d.katalog_id));
    for (const k of data.kartu) {
      expect(k.status).toBe('draf');
      for (const d of k.sumber_pnpk) expect(ids.has(d.katalog_id)).toBe(true);
    }
  });
});

describe('pemilihan kartu untuk klaim', () => {
  test('pneumonia dewasa vs anak', () => {
    expect(svc.kartuUntukKlaim(dewasa, { dx: 'J18.9' }).map(k => k.id)).toEqual(['KP-PNEUMONIA-DEWASA']);
    expect(svc.kartuUntukKlaim(anak, { dx: 'J18.9' }).map(k => k.id)).toEqual(['KP-PNEUMONIA-ANAK']);
  });
  test('butir PNPK yang belum berlaku pada awal episode tidak dipakai', () => {
    const k = svc.kartuUntukKlaim({ ...dewasa, admission_date: '2025-01-01' }, { dx: 'J18.9' })[0];
    // PNPK pneumonia dewasa 1168/2025 berlaku 15 Des 2025.
    expect(k?.butir.some(b => b.sumber?.katalog_id === 'KMK-2025-1168') || false).toBe(false);
  });
  test('butir yang ditolak telaah tidak dipakai agen', async () => {
    const k = data.kartu.find(x => x.id === 'KP-PNEUMONIA-DEWASA');
    const b = k.butir[0];
    const db = { query: async () => {}, run: async () => {}, prepare: () => ({ all: async () => [] }) };
    await svc.simpanTelaah(db, { kartu_id: k.id, butir_id: b.id, status: 'ditolak', catatan: 'uji' });
    expect(svc.kartuUntukKlaim(dewasa, { dx: 'J18.9' })[0].butir.some(x => x.id === b.id)).toBe(false);
    await svc.muatTelaah(db); // telaah dikosongkan lagi
    expect(svc.kartuUntukKlaim(dewasa, { dx: 'J18.9' })[0].butir.some(x => x.id === b.id)).toBe(true);
  });
});

describe('prompt agen', () => {
  test('kartu ringkas: aturan aplikasi hanya yang terpicu, syarat PNPK berhalaman', () => {
    const kartu = svc.kartuUntukKlaim(dewasa, { dx: 'J18.9' });
    const teks = svc.untukPrompt(kartu, { referensi_klaim: { temuan: [{ id: 'RK-03', status: 'bukti_belum_cukup' }] } });
    expect(teks).toMatch(/Aturan aplikasi terpicu: RK-03 \(bukti_belum_cukup\)/);
    expect(teks).not.toMatch(/KMB-55/); // aturan kombinasi yang tidak terpicu tidak ikut
    if (kartu[0].butir.some(b => b.cara === 'agen')) expect(teks).toMatch(/\((?:KMK-\d{4}-\d+|PNPK-[A-Z-]+) hal\. \d+\)/);
  });
  test('diagnosis berkartu memakai kartu; tanpa kartu memakai kutipan PNPK; total lebih pendek dari kutipan mentah', () => {
    const k = pnpk.konteksAgen(dewasa, { dx: ['J18.9', 'H40.1'] });
    expect(k.teks).toMatch(/KARTU PERSYARATAN/);
    expect(k.teks).toMatch(/\[KP-PNEUMONIA-DEWASA\]/);
    expect(k.teks).toMatch(/PEDOMAN PNPK YANG BERLAKU[\s\S]*KMK-2023-1488/); // glaukoma belum punya kartu
    process.env.AGEN_PAKAI_KARTU = 'false';
    const mentah = pnpk.konteksAgen(dewasa, { dx: ['J18.9'] }).teks;
    delete process.env.AGEN_PAKAI_KARTU;
    expect(pnpk.konteksAgen(dewasa, { dx: ['J18.9'] }).teks.length).toBeLessThan(mentah.length);
  });
});

describe('API kartu persyaratan', () => {
  jest.resetModules();
  const app = express();
  beforeAll(() => {
    jest.doMock('../../middleware/auth', () => ({
      authenticate: (req, res, next) => { if (!req.headers.authorization) return res.status(401).json({ error: 'Login diperlukan.' }); req.user = { id: 7, role: req.headers['x-role'] || 'admin' }; next(); },
      authorize: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Akses ditolak.' }),
    }));
    const rows = [];
    jest.doMock('../../database/init', () => ({ getDb: () => ({ query: async () => {}, run: async (_s, p) => { rows.push(p); }, prepare: () => ({ all: async () => [] }) }) }));
    app.use(express.json());
    app.use('/kartu', require('../../routes/kartuPersyaratan'));
  });
  test('daftar, detail, dan telaah', async () => {
    expect((await request(app).get('/kartu')).status).toBe(401);
    const daftar = await request(app).get('/kartu').set('Authorization', 'x');
    expect(daftar.status).toBe(200);
    expect(daftar.body.jumlah).toBe(data.kartu.length);
    const k = data.kartu[0];
    expect((await request(app).get(`/kartu/${k.id}`).set('Authorization', 'x')).body.kartu.id).toBe(k.id);
    const url = `/kartu/${k.id}/butir/${k.butir[0].id}/telaah`;
    expect((await request(app).post(url).set('Authorization', 'x').set('x-role', 'koder').send({ status: 'disetujui' })).status).toBe(403);
    expect((await request(app).post(url).set('Authorization', 'x').send({ status: 'asal' })).status).toBe(400);
    const ok = await request(app).post(url).set('Authorization', 'x').send({ status: 'disetujui', catatan: 'sesuai PNPK' });
    expect(ok.status).toBe(200);
    expect(ok.body.kartu.butir[0].telaah).toBe('disetujui');
  });
});
