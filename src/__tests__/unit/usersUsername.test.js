const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
let mockDb;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'su', email: 'su@example.invalid', role: 'superadmin', hospital_code: '3371084' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/auditService', () => ({ logAudit: jest.fn() }));
const router = require('../../routes/users');
const app = express();
app.use(express.json()); app.use('/users', router);

let inserts; let terdaftar;
beforeEach(() => {
  inserts = []; terdaftar = [];
  mockDb = {
    prepare: sql => ({
      get: async (...p) => /username = \?/.test(sql)
        ? terdaftar.find(u => u.username === p[0] || u.email === p[1]) || null
        : terdaftar.find(u => u.email === p[0]) || null,
      run: async (...values) => { inserts.push({ sql, values }); },
    }),
  };
});

const dasar = { password: 'casemix1@LR', full_name: 'Casemix Satu', role: 'verifikator' };

test('user dibuat dengan username saja; email internal terisi otomatis', async () => {
  const r = await request(app).post('/users').send({ ...dasar, username: ' Casemix1 ' });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ username: 'casemix1', email: 'casemix1@pengguna.medaudit.invalid', role: 'verifikator' });
  const [, email, username, hash] = inserts[0].values;
  expect([email, username]).toEqual(['casemix1@pengguna.medaudit.invalid', 'casemix1']);
  expect(bcrypt.compareSync('casemix1@LR', hash)).toBe(true);
});

test('username yang sudah dipakai (sebagai username atau email) ditolak', async () => {
  terdaftar.push({ username: 'casemix1', email: 'a@example.invalid' });
  expect((await request(app).post('/users').send({ ...dasar, username: 'casemix1' })).status).toBe(400);
  terdaftar.splice(0, 1, { username: null, email: 'casemix2' });
  expect((await request(app).post('/users').send({ ...dasar, username: 'casemix2' })).status).toBe(400);
  expect(inserts).toEqual([]);
});

test('aturan lama tetap: password minimal 8 karakter, username/email wajib, format username', async () => {
  expect((await request(app).post('/users').send({ ...dasar, username: 'casemix1', password: '123456' })).status).toBe(400);
  expect((await request(app).post('/users').send({ ...dasar })).status).toBe(400);
  expect((await request(app).post('/users').send({ ...dasar, username: 'cm 1' })).status).toBe(400);
  expect(inserts).toEqual([]);
});

test('pembuatan dengan email saja tetap berjalan seperti sebelumnya', async () => {
  const r = await request(app).post('/users').send({ ...dasar, email: 'petugas@example.invalid' });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ email: 'petugas@example.invalid', username: null });
});
