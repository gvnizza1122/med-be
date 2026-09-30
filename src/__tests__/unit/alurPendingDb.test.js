/**
 * Sisi DB tiruan dari alur pending: hitungTriase, koreksiKotak, skema, dan
 * penautan ulang saat klaim baru tersimpan.
 */
const { hitungTriase, koreksiKotak, ringkasanTriase } = require('../../services/triasePendingService');
const { ensureSchema } = require('../../services/alurJawabPendingSchema');
const { linkPendingBpjsForSep } = require('../../services/bpjsPendingLink');

function db({ baris = [], klaim = null, halaman = [], ringkas = [] } = {}) {
  const runs = [];
  return {
    runs,
    query: jest.fn().mockResolvedValue({ rows: [] }),
    prepare: (sql) => ({
      all: async () => {
        if (/FROM ocr_results/.test(sql)) return halaman;
        if (/LEFT JOIN pending_triase t ON t\.pending_id = bpr\.id\s+LEFT JOIN pending_alasan_peta m/.test(sql)) return ringkas;
        if (/FROM bpjs_pending_responses bpr/.test(sql)) return baris;
        if (/SELECT id, sep FROM bpjs_pending_responses/.test(sql)) return baris;
        return [];
      },
      get: async () => (/FROM claim_records/.test(sql) ? klaim : { id: 'p1' }),
      run: async (...p) => { runs.push({ sql, p }); return { changes: 1 }; },
    }),
  };
}

const KLAIM = { id: 'c1', sep: 'S', jenis_klaim: 'RAWAT_JALAN', diagnosa_list: 'A09', prosedur_list: '' };

describe('hitungTriase', () => {
  test('menyimpan kotak dan kriteria, dan tidak menyentuh kotak_manual', async () => {
    const d = db({
      baris: [{ id: 'p1', alasan_raw: 'kegawatan', claim_record_id: 'c1', kategori: 'kegawatdaruratan', sudah: null }],
      klaim: KLAIM,
      halaman: [{ page_number: 1, ocr_text: 'TRIASE IGD\nKategori triase: MERAH' }],
    });
    const r = await hitungTriase(d, { ulang: true });
    expect(r.dihitung).toBe(1);
    expect(r.per_kotak.A).toBe(1);
    const sql = d.runs[0].sql;
    expect(sql).toMatch(/INSERT INTO pending_triase/);
    expect(sql.split('DO UPDATE SET')[1]).not.toMatch(/kotak_manual|catatan_manual/);
    expect(JSON.parse(d.runs[0].p[3]).length).toBeGreaterThan(0); // kriteria tersimpan
  });

  test('baris tanpa kategori dilewati (harus dipetakan dulu); yang sudah dihitung dilewati tanpa ulang', async () => {
    const d = db({ baris: [
      { id: 'p1', alasan_raw: 'x', claim_record_id: null, kategori: null, sudah: null },
      { id: 'p2', alasan_raw: 'x', claim_record_id: null, kategori: 'kegawatdaruratan', sudah: '[]' },
    ] });
    const r = await hitungTriase(d, {});
    expect(r).toMatchObject({ tanpa_kategori: 1, dilewati: 1, dihitung: 0 });
    expect(d.runs).toHaveLength(0);
  });

  test('klaim tidak ada -> kotak B tersimpan', async () => {
    const d = db({ baris: [{ id: 'p1', alasan_raw: 'x', claim_record_id: null, kategori: 'kode_diagnosis', sudah: null }] });
    const r = await hitungTriase(d, {});
    expect(r.per_kotak.B).toBe(1);
  });
});

describe('koreksiKotak', () => {
  test('tulis kotak_manual', async () => {
    const d = db();
    await koreksiKotak(d, 'p1', 'C', 'catatan', 'u1');
    expect(d.runs[0].p).toEqual(['p1', 'C', 'catatan', 'u1']);
  });
  test('kotak tak dikenal ditolak; null (hapus putusan) boleh', async () => {
    await expect(koreksiKotak(db(), 'p1', 'Z', '', 'u')).rejects.toMatchObject({ kode: 'kotak_tidak_valid' });
    await expect(koreksiKotak(db(), 'p1', null, '', 'u')).resolves.toBeDefined();
  });
});

describe('ringkasanTriase', () => {
  test('menghitung kotak berlaku (manual menang) per jenis dan kategori', async () => {
    const d = db({ ringkas: [
      { kotak: 'A', kotak_manual: null, jenis_rawat: 'rawat_jalan', kategori: 'kegawatdaruratan' },
      { kotak: 'A', kotak_manual: 'D', jenis_rawat: 'rawat_jalan', kategori: 'kegawatdaruratan' },
      { kotak: null, kotak_manual: null, jenis_rawat: 'rawat_inap', kategori: 'kode_diagnosis' },
    ] });
    const r = await ringkasanTriase(d, {});
    expect(r.kotak.find((k) => k.kode === 'A').jumlah).toBe(1);
    expect(r.kotak.find((k) => k.kode === 'D').jumlah).toBe(1);
    expect(r.belum_diklasifikasi).toBe(1);
    expect(r.per_jenis.rawat_jalan.A).toBe(1);
  });
});

describe('ensureSchema', () => {
  test('hanya membuat tabel baru, tidak menyentuh tabel/kolom yang ada', async () => {
    const d = db();
    await ensureSchema(d);
    const ddl = d.query.mock.calls.map((c) => c[0]).join('\n');
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS pending_alasan_peta/);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS pending_triase/);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS draft_jawaban_pending/);
    expect(ddl).not.toMatch(/ALTER TABLE|DROP |DELETE |UPDATE /i);
    expect(ddl).not.toMatch(/jawaban_rs_manual/);
  });
});

describe('linkPendingBpjsForSep (ternormalisasi)', () => {
  test('menautkan baris rekap yang SEP-nya berbeda tulisan', async () => {
    const d = db({ baris: [{ id: 'r1', sep: '0170R011 0826 V003068' }, { id: 'r2', sep: '0170R0110826V000001' }] });
    await linkPendingBpjsForSep(d, '0170R0110826V003068', 'c9');
    const upd = d.runs.filter((x) => /WHERE id = \?/.test(x.sql));
    expect(upd).toHaveLength(1);
    expect(upd[0].p).toEqual(['c9', 'r1']);
  });
});
