const rag = require('../../services/ragReferenceService');
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
    expect(rag.formatReferences(examples)).toContain('hasil: ditolak');
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
  test('query join ke pending terkini; tingkat dihitung dari versi jawaban saat ini', async () => {
    let query, args;
    const db = dbPalsu({ all: (sql, a) => { query = sql; args = a; return [{ ...base, verification_status: undefined, outcome: undefined,
      source_pending_id: 'p9', p_status: 'diterima', p_outcome: 'approved', p_verified_by: 'u1', p_draft: base.draft_berhasil }]; } });
    const r = await rag.getReferences(db, context);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ verification_status: 'verified', outcome: 'diterima' });
    expect(query).toContain('JOIN bpjs_pending_responses');
    expect(args).toEqual(['RAWAT_JALAN']);
  });
});

/** DB palsu: kolom RAG dianggap ada kecuali kolomAda=false. */
function dbPalsu({ kolomAda = true, all = () => [], run = () => ({ changes: 1 }), query = async () => {} } = {}) {
  rag._resetSkema();
  const KOLOM = ['rag_referensi', 'rag_konfirmasi_hasil'];
  return {
    query,
    prepare: sql => ({
      all: async (...a) => (/information_schema/.test(sql) ? (kolomAda ? KOLOM.map(k => ({ k })) : []) : all(sql, a)),
      run: async (...a) => run(sql, a),
    }),
  };
}

describe('Tingkat kepercayaan referensi', () => {
  const jawab = 'Jawaban RS';
  test('hasil dikonfirmasi petugas untuk versi ini -> verified', () => {
    expect(rag.tingkatReferensi({ draft_berhasil: jawab, p_draft: jawab, p_outcome: 'rejected', p_verified_by: 'u1' }))
      .toEqual({ verification_status: 'verified', outcome: 'ditolak' });
  });
  test('jawaban diedit setelah konfirmasi -> hasil lama tidak berlaku', () => {
    expect(rag.tingkatReferensi({ draft_berhasil: jawab, p_draft: 'revisi', p_outcome: 'approved', p_verified_by: 'u1', p_status: 'diterima' }).verification_status).toBe('unverified');
  });
  test('jawaban yang dikirim RS / jawaban manual rekap -> jawaban_rs', () => {
    expect(rag.tingkatReferensi({ draft_berhasil: jawab, p_draft: jawab, p_status: 'dikirim' }).verification_status).toBe('jawaban_rs');
    expect(rag.tingkatReferensi({ draft_berhasil: jawab, source_kind: 'rs_manual', p_manual: jawab, p_status: 'draft' }).verification_status).toBe('jawaban_rs');
  });
  test('draf AI yang belum dikirim tidak pernah dipakai', () => {
    const r = { ...base, ...rag.tingkatReferensi({ draft_berhasil: jawab, source_kind: 'ai_draft', p_draft: jawab, p_status: 'draft' }) };
    expect(rag.selectReferences([r], context)).toEqual([]);
  });
  test('jawaban_rs dipakai dengan label belum dikonfirmasi; verified diurutkan lebih dulu', () => {
    const rs = { ...base, id: 'rs', verification_status: 'jawaban_rs', outcome: 'tidak_diketahui', draft_berhasil: 'lain' };
    const pilih = rag.selectReferences([rs, base], context);
    expect(pilih.map(r => r.id)).toEqual(['ref-1', 'rs']);
    expect(rag.formatReferences([rs])).toMatch(/hasil: belum_dikonfirmasi/);
    expect(rag.formatReferences([{ ...base, outcome: 'ditolak' }])).toMatch(/DITOLAK BPJS/);
  });
});

describe('Tahan error', () => {
  test('tabel baru tidak bisa dibuat -> simpan ke arsip lama (kasus tetap terkumpul), baca -> []', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ditulis = [];
    const db = dbPalsu({ kolomAda: false, query: async () => { throw Error('permission denied for schema public'); }, run: (sql, a) => ditulis.push([sql, a]) });
    expect(await rag.saveReference(db, { pendingId: 'p1', sourceKind: 'ai_draft', alasan: 'a', answer: 'b' })).toBe('tersimpan_kolom_lama');
    expect(ditulis[0][0]).not.toMatch(/source_pending_id/);
    expect(await rag.getReferences(db, context)).toEqual([]);
    expect(await rag.catatKonfirmasiHasil(db, 'p1', { outcome: 'approved', oleh: 'u1' })).toBe(false);
    warn.mockRestore();
  });
  test('penulisan gagal tidak pernah melempar', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = dbPalsu({ run: () => { throw Error('koneksi putus'); } });
    await expect(rag.saveReference(db, { pendingId: 'p1', alasan: 'a', answer: 'b' })).resolves.toBe('gagal');
    await expect(rag.catatKonfirmasiHasil(db, 'p1', { outcome: 'approved' })).resolves.toBe(false);
    warn.mockRestore();
  });
  test('tabel belum ada -> dibuat sekali, tanpa ALTER tabel lama', async () => {
    let ada = false; const q = jest.fn(async () => { ada = true; });
    rag._resetSkema();
    const db = { query: q, prepare: () => ({ all: async () => (ada ? ['rag_referensi', 'rag_konfirmasi_hasil'].map(k => ({ k })) : []) }) };
    expect(await rag.pastikanSkemaRag(db)).toBe(true);
    expect(await rag.pastikanSkemaRag(db)).toBe(true);
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS rag_referensi/);
    expect(q.mock.calls[0][0]).not.toMatch(/ALTER TABLE/);
  });
});

describe('Hasil melekat pada versi jawaban', () => {
  const existing = { status: 'diterima', outcome: 'approved', draft_klarifikasi: 'jawaban awal' };
  test('edit jawaban membatalkan hasil lama', () => {
    expect(rag.nextPendingState(existing, { draft_klarifikasi: 'jawaban baru' })).toMatchObject({ status: 'draft', outcome: null, draft: 'jawaban baru' });
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
    const db = dbPalsu({ run: (sql, a) => { query = sql; args = a; } });
    expect(await rag.saveReference(db, { pendingId: 'p1', sourceKind: 'ai_draft', alasan: 'asli', answer: 'jawaban asli', category: 'kode_tindakan', confidence: 100, jenisKlaim: 'RJ' })).toBe('tersimpan');
    expect(query).toContain('INSERT INTO rag_referensi');
    expect(query).not.toMatch(/outcome|verified/);
    expect(args).toContain('jawaban asli');
    expect(args).toContain('RAWAT_JALAN');
    expect(args.at(-1)).toMatch(/^[a-f0-9]{64}$/);
    expect((query.match(/\?/g) || []).length).toBe(args.length);
  });
});
