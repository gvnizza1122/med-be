jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => (req.headers.authorization
    ? next()
    : res.status(401).json({ error: 'Token tidak ditemukan. Silakan login.' })),
}));

const express = require('express');
const request = require('supertest');
const codeDescriptionRoutes = require('../../routes/codeDescriptions');

const app = express();
app.use(express.json());
app.use('/api/v1/code-descriptions', codeDescriptionRoutes);

const lookup = (body) => request(app)
  .post('/api/v1/code-descriptions/lookup')
  .set('Authorization', 'Bearer x')
  .send(body);

describe('POST /api/v1/code-descriptions/lookup', () => {
  test('sesuai contoh kontrak', async () => {
    const res = await lookup({ diagnosis: ['H61.2', 'N20.9'], procedure: ['99.04'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      diagnosis: { 'H61.2': 'Impacted cerumen', 'N20.9': 'Urinary calculus, unspecified' },
      procedure: { '99.04': 'Transfusion of packed cells' },
    });
  });

  test('kode tidak dikenal tidak dimasukkan, bukan dikarang', async () => {
    const res = await lookup({ diagnosis: ['R10.84', 'ZZZ'], procedure: ['99.999'] });
    expect(res.body).toEqual({ diagnosis: {}, procedure: {} });
  });

  test('huruf kecil dan spasi dinormalkan ke kunci huruf besar', async () => {
    const res = await lookup({ diagnosis: [' h61.2 '], procedure: [] });
    expect(res.body.diagnosis).toEqual({ 'H61.2': 'Impacted cerumen' });
  });

  test('kode tanpa titik tetap dikenali, kunci respons sesuai permintaan', async () => {
    const res = await lookup({ diagnosis: ['N209'], procedure: ['9652'] });
    expect(res.body).toEqual({
      diagnosis: { N209: 'Urinary calculus, unspecified' },
      procedure: { 9652: 'Irrigation of ear' },
    });
  });

  test('salah satu jenis boleh tidak dikirim', async () => {
    const res = await lookup({ procedure: ['96.52'] });
    expect(res.body).toEqual({ diagnosis: {}, procedure: { '96.52': 'Irrigation of ear' } });
  });

  test('input tidak valid -> 400', async () => {
    expect((await lookup({ diagnosis: 'H61.2' })).status).toBe(400);
    expect((await lookup({ diagnosis: Array(51).fill('A09') })).status).toBe(400);
  });

  test('tanpa token -> 401', async () => {
    const res = await request(app).post('/api/v1/code-descriptions/lookup').send({ diagnosis: ['A09'] });
    expect(res.status).toBe(401);
  });
});
