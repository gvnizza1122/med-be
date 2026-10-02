const rag = require('../../services/ragReferenceService');
const { buildPrompt } = require('../../routes/bpjsPending');
const base = { id: 'ref-1', verification_status: 'verified', outcome: 'diterima', jenis_klaim: 'RAWAT_JALAN',
  alasan_bpjs: 'Indikasi tindakan elektrokardiogram belum jelas', draft_berhasil: 'Indikasi dijelaskan berdasarkan berkas sumber.',
  kategori_pending: 'kode_tindakan', source_kind: 'rs_manual', created_at: '2026-10-01', sep: 'OTHER' };
const context = { jenis_klaim: 'RJ', alasanRaw: 'Mohon indikasi elektrokardiogram', sep: 'CURRENT' };

describe('RAG referensi sesuai konteks dan terverifikasi', () => {
  test('confidence tinggi tidak mengangkat draft, outcome belum diketahui, atau jenis klaim berbeda', () => {
    const rows = [base, { ...base, id: 'draft', verification_status: 'unverified', confidence_score: 100 },
      { ...base, id: 'unknown', outcome: 'tidak_diketahui' }, { ...base, id: 'ri', jenis_klaim: 'RI' }];
    expect(rag.selectReferences(rows, context).map(r => r.id)).toEqual(['ref-1']);
  });
  test('tidak ada konteks atau kemiripan menghasilkan tanpa referensi, bukan contoh acak', () => {
    expect(rag.selectReferences([base], {})).toEqual([]);
    expect(rag.selectReferences([base], { jenis_klaim: 'RJ', alasanRaw: 'Identitas peserta salah' })).toEqual([]);
    expect(rag.selectReferences([base], { jenis_klaim: 'RJ', alasanRaw: 'Mohon data pasien klaim BPJS' })).toEqual([]);
  });
  test('kategori yang cocok dapat mengambil contoh meski istilah berbeda', () => {
    expect(rag.selectReferences([base], { jenis_klaim: 'RJ', kategori_pending: 'kode_tindakan' })).toHaveLength(1);
  });
  test('kasus sendiri dan versi duplikat tidak mengisi konteks', () => {
    expect(rag.selectReferences([{ ...base, sep: 'CURRENT' }], context)).toEqual([]);
    expect(rag.selectReferences([{ ...base, source_pending_id: 'p1' }], { ...context, pendingId: 'p1' })).toEqual([]);
    expect(rag.selectReferences([base, { ...base, id: 'copy' }], context)).toHaveLength(1);
  });
  test('kemiripan mengalahkan tanggal dan confidence', () => {
    const less = { ...base, id: 'less', alasan_bpjs: 'Indikasi pemeriksaan', confidence_score: 100, created_at: '2026-10-02' };
    expect(rag.selectReferences([less, base], context).map(r => r.id)).toEqual(['ref-1', 'less']);
  });
  test('hasil ditolak diberi label ditolak, bukan klarifikasi berhasil', () => {
    const examples = rag.selectReferences([{ ...base, outcome: 'rejected' }], context);
    const prompt = buildPrompt({ alasanRaw: context.alasanRaw, claimRecord: {}, examples });
    expect(prompt).toContain('hasil: ditolak');
    expect(prompt).not.toMatch(/Klarifikasi yang berhasil|CONTOH_BERHASIL|terbukti DITERIMA/);
    expect(rag.formatReferences([{ ...base, verification_status: 'unverified' }])).not.toContain(base.draft_berhasil);
  });
  test('anggaran referensi dibatasi termasuk label dan kutipan', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...base, id: String(i), alasan_bpjs: `indikasi elektrokardiogram ${i} ` + 'x'.repeat(2000), draft_berhasil: 'z'.repeat(3000), poin_kunci: 'y'.repeat(3000) }));
    const selected = rag.selectReferences(rows, context);
    expect(selected.length).toBeLessThanOrEqual(5);
    expect(rag.formatReferences(selected).length).toBeLessThanOrEqual(6000);
  });
  test('schema tidak tersedia tidak membuka fallback contoh lama', async () => {
    const db = { prepare: () => ({ all: async () => { throw new Error('schema lama'); } }) };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await rag.getReferences(db, context)).toEqual([]);
    warn.mockRestore();
  });
  test('query memeriksa hasil manusia dan versi jawaban sebelum retrieval', async () => {
    let query, args;
    const db = { prepare: sql => { query = sql; return { all: async (...a) => { args = a; return [base]; } }; } };
    expect(await rag.getReferences(db, context)).toHaveLength(1);
    expect(query).toContain('p.outcome_verified_by IS NOT NULL');
    expect(query).toContain('e.draft_berhasil =');
    expect(query).toContain('JOIN bpjs_pending_responses');
    expect(args).toEqual(['RAWAT_JALAN']);
  });
});

describe('Hasil melekat pada versi jawaban', () => {
  const existing = { status: 'diterima', outcome: 'approved', draft_klarifikasi: 'jawaban awal' };
  test('edit jawaban membatalkan hasil lama', () => {
    expect(rag.nextPendingState(existing, { draft_klarifikasi: 'jawaban baru' })).toEqual({ status: 'draft', outcome: null, draft: 'jawaban baru' });
  });
  test.each([['diterima', 'approved'], ['ditolak', 'rejected']])('status %s dari petugas menetapkan outcome yang konsisten', (status, outcome) => {
    expect(rag.nextPendingState({ status: 'draft', draft_klarifikasi: 'jawaban' }, { status })).toMatchObject({ status, outcome });
  });
  test('petugas bisa menetapkan hasil baru untuk versi yang diedit', () => {
    expect(rag.nextPendingState(existing, { draft_klarifikasi: 'revisi', outcome: 'rejected' })).toMatchObject({ status: 'ditolak', outcome: 'rejected', draft: 'revisi' });
  });
  test('status bertentangan ditolak dan pencabutan hasil menghapus status diterima', () => {
    expect(rag.nextPendingState(existing, { status: 'ditolak', outcome: 'approved' }).error).toBeTruthy();
    expect(rag.nextPendingState(existing, { outcome: null })).toMatchObject({ status: 'draft', outcome: null });
    expect(rag.nextPendingState(existing, { status: 'dikirim' })).toMatchObject({ status: 'dikirim', outcome: null });
  });
  test('hasil model/confidence tidak pernah mengesahkan sumber baru', async () => {
    let query, args;
    const db = { prepare: sql => { query = sql; return { run: async (...a) => { args = a; } }; } };
    await rag.saveReference(db, { pendingId: 'p1', sourceKind: 'ai_draft', alasan: 'asli', answer: 'jawaban asli', category: 'kode_tindakan', confidence: 100, jenisKlaim: 'RJ' });
    expect(query).toContain("'tidak_diketahui'");
    expect(query).toContain("'unverified'");
    expect(args).toContain('jawaban asli');
    expect(args.at(-1)).toMatch(/^[a-f0-9]{64}$/);
    expect((query.match(/\?/g) || []).length).toBe(args.length);
  });
});

test('pola error otomatis tidak diambil dan pruning tidak menghapus hasil tinjauan manusia', async () => {
  const knowledge = require('../../services/errorKnowledgeService');
  const queries = [];
  const db = { prepare: sql => { queries.push(sql); return { all: async () => [], run: async () => ({ changes: 1 }) }; } };
  await knowledge.getRelevantKnowledge(db, ['rule-1']);
  expect(queries[0]).toContain("verification_status = 'verified'");
  await knowledge.recordKnowledge(db, [{ rule_id: 'rule-1', pattern_summary: 'pola', solution: 'solusi' }]);
  expect(queries.find(sql => sql.includes('DELETE FROM'))).toContain("verification_status != 'verified'");
});

test('basis pola error pada schema lama tidak menggagalkan review', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const db = { prepare: () => ({ all: async () => { throw Error('kolom belum tersedia'); } }) };
  expect(await require('../../services/errorKnowledgeService').getRelevantKnowledge(db, ['rule-1'])).toEqual([]);
  warn.mockRestore();
});
