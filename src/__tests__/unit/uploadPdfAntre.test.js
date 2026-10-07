const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclaim-bulk-test-'));
const oldUploadDir = process.env.UPLOAD_DIR;
process.env.UPLOAD_DIR = uploadDir;
let mockDb;
let mockQueued = [];
let mockStartedBeforeCommit = false;
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'tester', hospital_code: 'BULK_TEST' }; next(); },
  authorize: () => (_req, _res, next) => next(),
}));
jest.mock('../../services/prosesUnggahService', () => ({
  ...jest.requireActual('../../services/prosesUnggahService'),
  buatAntrean: () => ({ tambah: task => { if (!mockTransactionFinished) mockStartedBeforeCommit = true; mockQueued.push(task); return Promise.resolve(); } }),
}));
const router = require('../../routes/claimFiles');
const app = express();
app.use('/api/v1/claim-files', router);
app.use(require('../../middleware/uploadLimitError'));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
let persisted; let failAt; let failRead; let inserts; let mockTransactionFinished;
let errorLog; let warningLog;
beforeEach(() => {
  persisted = []; mockQueued = []; failAt = null; failRead = false; inserts = 0; mockTransactionFinished = false;
  mockStartedBeforeCommit = false;
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  warningLog = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockDb = {
    query: async () => ({}), run: async () => ({}),
    all: async sql => {
      if (failRead) throw Error('Simulasi pembacaan status terputus');
      return /WHERE status = 'selesai'/.test(sql) ? [] : persisted;
    },
    transaction: async callback => {
      const staged = [];
      await callback({ run: async (sql, values) => {
        inserts++;
        if (inserts === failAt) throw Error('Simulasi penyimpanan terputus');
        const [id, batch_id, hospital_code, user_id, file_name, urutan_file, muatan] = values;
        staged.push({ id, batch_id, hospital_code, user_id, file_name, urutan_file, muatan,
          status: 'antre', tahap: 'antre', dibuat: new Date() });
      } });
      persisted.push(...staged); mockTransactionFinished = true;
    },
  };
});
afterEach(async () => {
  errorLog.mockRestore(); warningLog.mockRestore();
  // Hanya membersihkan berkas simulasi di direktori sementara khusus pengujian.
  for (const name of fs.readdirSync(uploadDir)) await fs.promises.rm(path.join(uploadDir, name), { force: true });
});
afterAll(() => {
  fs.rmdirSync(uploadDir);
  if (oldUploadDir === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = oldUploadDir;
});

function upload(count) {
  let req = request(app).post('/api/v1/claim-files/upload-pdf-antre')
    .field('allowed_jenis_klaim', JSON.stringify(['RAWAT_INAP']));
  for (let i = 0; i < count; i++) req = req.attach('files', Buffer.from('%PDF-1.4\nSimulasi antrean\n'), `simulasi-${i}.pdf`);
  return req;
}

test('multipart 300 PDF diterima lengkap dengan muatan tersimpan sebelum pekerjaan dimulai', async () => {
  const response = await upload(300);
  expect(response.status).toBe(202);
  expect(response.body.total_files).toBe(300);
  expect(response.body.proses).toHaveLength(300);
  expect(new Set(response.body.proses.map(p => p.id)).size).toBe(300);
  expect(response.body.proses.map(p => p.urutan_file)).toEqual(Array.from({ length: 300 }, (_, i) => i));
  expect(mockTransactionFinished).toBe(true); expect(mockQueued).toHaveLength(300);
  expect(mockStartedBeforeCommit).toBe(false);
  expect(persisted).toHaveLength(300);
  for (const p of persisted) {
    const payload = JSON.parse(p.muatan);
    expect(payload).toMatchObject({ originalName: p.file_name, allowedJenisKlaim: ['RAWAT_INAP'], hospitalCode: 'BULK_TEST' });
    expect(fs.existsSync(payload.filePath)).toBe(true);
  }
  expect(response.body.proses.every(p => !('muatan' in p) && !('filePath' in p))).toBe(true);
});

test('gagal pada berkas ke-80 membatalkan seluruh batch tanpa memulai sebagian pekerjaan', async () => {
  failAt = 80;
  const response = await upload(300);
  expect(response.status).toBe(503);
  expect(response.body.error).toMatch(/belum diterima/);
  expect(persisted).toEqual([]); expect(mockQueued).toEqual([]);
  expect(mockTransactionFinished).toBe(false);
});

test('gangguan membaca status setelah diterima tetap membalas 202 dengan semua ID dan ETA belum diketahui', async () => {
  failRead = true;
  const response = await upload(300);
  expect(response.status).toBe(202);
  expect(response.body.total_files).toBe(300);
  expect(response.body.proses).toHaveLength(300);
  expect(response.body.perkiraan_selesai_detik).toBeNull();
  expect(response.body.proses.every(p => p.status === 'antre' && p.sisa_detik === null && !('muatan' in p))).toBe(true);
  expect(persisted).toHaveLength(300); expect(mockQueued).toHaveLength(300);
});

test('301 PDF ditolak dengan batas 300 yang benar dan tidak ada pekerjaan dimulai', async () => {
  const response = await upload(301);
  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/maksimal 300 berkas/);
  expect(persisted).toEqual([]); expect(mockQueued).toEqual([]);
});
