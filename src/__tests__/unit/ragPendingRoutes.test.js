const mockDb = { prepare: jest.fn(), transaction: jest.fn() };
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.user = { id: 'staff-1', role: 'supervisor' }; next(); },
  authorize: () => (req, res, next) => next(),
}));
jest.mock('../../services/gatewayModelService', () => ({ panggilModel: jest.fn(async () => ({ ok: true, hasil: { jawaban: 'draft baru', kategori_pending: 'kode_tindakan' } })) }));
const router = require('../../routes/bpjsPending');
async function patch(path, body) {
  const knowledge = path.includes('/rag/knowledge/');
  const route = router.stack.find(layer => layer.route?.path === (knowledge ? '/rag/knowledge/:id/verification' : '/pending/:id/status')).route;
  const req = { body, params: { id: knowledge ? 'k1' : 'p1' }, user: { id: 'staff-1', role: 'supervisor' } };
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle(req, res);
  return { status: res.statusCode, body: res.body };
}
let row, writes;
beforeEach(() => {
  row = { id: 'p1', status: 'draft', outcome: null, draft_klarifikasi: 'jawaban asli', alasan_raw: 'indikasi tindakan', jenis_klaim: 'RJ', sep: 'SEP1', alasan_parsed: '{"kategori":"kode_tindakan"}' };
  writes = [];
  mockDb.transaction.mockImplementation(cb => cb(mockDb));
  mockDb.prepare.mockImplementation(sql => ({
    get: async () => ({ ...row }),
    all: async () => [],
    run: async (...args) => {
      writes.push({ sql, args });
      if (sql.includes('UPDATE bpjs_pending_responses')) {
        [row.status, row.outcome, row.draft_klarifikasi, row.outcome_verified_by] = args;
      }
      return { changes: 1 };
    },
  }));
});

test('hasil petugas dan snapshot jawaban tersimpan dalam transaksi yang sama', async () => {
  const res = await patch('/records/pending/p1/status', { status: 'diterima' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: 'diterima', outcome: 'approved', outcome_verified_by: 'staff-1' });
  expect(mockDb.transaction).toHaveBeenCalled();
  expect(mockDb.prepare.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
  const snapshot = writes.find(w => w.sql.includes('INSERT INTO ai_training_examples'));
  expect(snapshot.args).toContain('p1');
  expect(snapshot.args).toContain('jawaban asli');
  expect(writes.some(w => w.sql.includes('UPDATE ai_training_examples'))).toBe(true);
});
test('edit jawaban membatalkan hasil dan verifikasi sebelumnya', async () => {
  row.outcome = 'approved'; row.status = 'diterima'; row.outcome_verified_by = 'old-staff';
  const res = await patch('/records/pending/p1/status', { draft_klarifikasi: 'jawaban baru' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ outcome: null, status: 'draft', outcome_verified_by: null });
});
test('hasil legacy tidak disahkan hanya dengan permintaan kosong', async () => {
  row.outcome = 'approved'; row.status = 'diterima';
  const res = await patch('/records/pending/p1/status', {});
  expect(res.status).toBe(200);
  expect(res.body.outcome_verified_by).toBeNull();
});
test('status dan outcome bertentangan tidak menulis data', async () => {
  const res = await patch('/records/pending/p1/status', { status: 'ditolak', outcome: 'approved' });
  expect(res.status).toBe(400);
  expect(writes).toHaveLength(0);
});
test('verifikasi pola error membutuhkan catatan petugas', async () => {
  expect((await patch('/records/rag/knowledge/k1/verification', { verified: true })).status).toBe(400);
  const res = await patch('/records/rag/knowledge/k1/verification', { verified: true, note: 'Diperiksa terhadap aturan dan dokumen sumber.' });
  expect(res.status).toBe(200);
  expect(writes.at(-1).args).toEqual(['verified', 'staff-1', 'Diperiksa terhadap aturan dan dokumen sumber.', 'k1']);
});

test('generate ulang selalu membatalkan hasil lama dan menyimpan draft sebagai sumber baru', async () => {
  row.outcome = 'approved'; row.status = 'diterima'; row.outcome_verified_by = 'staff-old';
  expect(await router.generateDraftForRow(mockDb, { ...row })).toEqual({ success: true });
  const update = writes.find(w => w.sql.includes('UPDATE bpjs_pending_responses'));
  expect(update.sql).toContain('outcome = NULL');
  expect(update.sql).toContain('outcome_verified_by = NULL');
  expect(update.sql).toContain("status = 'draft'");
  const snapshot = writes.find(w => w.sql.includes('INSERT INTO ai_training_examples'));
  expect(snapshot.args).toContain('ai_draft');
  expect(snapshot.sql).toContain("'unverified'");
});
