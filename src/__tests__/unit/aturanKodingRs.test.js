const {
  ensureSchema, muatAturan, simpanAturan, pilihAturan, susunUsulanProsedur,
  kodeProclistDariUsulan, tentukanProsedurDariTemuan,
} = require('../../services/aturanKodingRsService');

const NEBUL = {
  id: 'nebulisasi', nama: 'Nebulisasi', kode_usulan: '93.94',
  bukti: [
    { page_number: 2, sumber: 'resume_medis', kutipan: 'Tindakan: Nebulisasi Ventasal' },
    { page_number: 3, sumber: 'resep', kutipan: 'R/ Masker Nebul DWS' },
  ],
};
const INFUS = { id: 'pemasangan_infus', nama: 'Pemasangan infus', kode_usulan: null, bukti: [{ page_number: 2, sumber: 'resume_medis', kutipan: 'pasang infus' }] };
const NEBUL_RESEP_SAJA = { ...NEBUL, bukti: [NEBUL.bukti[1]] };

const rule = (istilah_id, masuk_proclist, kondisi = 'selalu', extra = {}) => ({ istilah_id, masuk_proclist, kondisi, diputuskan_oleh: 'koder', catatan: null, ...extra });

describe('susunUsulanProsedur — kode usulan tidak mengisi PROCLIST otomatis', () => {
  test('tindakan tetap terbaca tetapi kode usulan tidak masuk PROCLIST', () => {
    const [u] = susunUsulanProsedur([NEBUL], new Map());
    expect(u.masuk_proclist).toBe(false);
    expect(u.kode_usulan).toBe('93.94');
    expect(u.kode_terverifikasi).toBe(false);
    expect(kodeProclistDariUsulan([u])).toEqual([]);
  });

  test('membawa penanda bahwa RS belum punya aturan untuk tindakan ini', () => {
    const [u] = susunUsulanProsedur([NEBUL], new Map());
    expect(u.belum_ada_aturan_rs).toBe(true);
    expect(u.aturan_rs).toBeNull();
    expect(u.alasan).toMatch(/belum diizinkan.*pengisian otomatis/i);
  });

  test('bukti (halaman dan sumber) ikut terbawa', () => {
    const [u] = susunUsulanProsedur([NEBUL], new Map());
    expect(u.halaman_bukti).toEqual([2, 3]);
    expect(u.sumber_bukti).toEqual(['resume_medis', 'resep']);
  });

  test('kode yang tidak pasti tidak pernah dimasukkan', () => {
    const [u] = susunUsulanProsedur([INFUS], new Map());
    expect(u.masuk_proclist).toBe(false);
    expect(u.alasan).toMatch(/tidak pernah ditebak/);
    expect(kodeProclistDariUsulan([u])).toEqual([]);
  });

  test('yang hanya tertulis di resep tidak masuk — resep adalah rencana', () => {
    const [u] = susunUsulanProsedur([NEBUL_RESEP_SAJA], new Map());
    expect(u.masuk_proclist).toBe(false);
  });

  test('temuan kosong / null aman', () => {
    expect(susunUsulanProsedur([], new Map())).toEqual([]);
    expect(susunUsulanProsedur(null, null)).toEqual([]);
  });
});

describe('susunUsulanProsedur — aturan RS sebagai override opsional', () => {
  test('aturan masuk_proclist=false menahan tindakan, tetapi temuan tetap dicatat', () => {
    const peta = new Map([['nebulisasi', [rule('nebulisasi', false, 'selalu', { catatan: 'Kebijakan RS: bagian dari tarif IGD' })]]]);
    const usulan = susunUsulanProsedur([NEBUL], peta);
    expect(usulan).toHaveLength(1); // tetap ada entri: tindakannya tetap TERBACA
    expect(usulan[0].masuk_proclist).toBe(false);
    expect(usulan[0].belum_ada_aturan_rs).toBe(false);
    expect(usulan[0].alasan).toMatch(/Kebijakan RS/);
    expect(kodeProclistDariUsulan(usulan)).toEqual([]);
  });

  test('aturan masuk_proclist=true tidak mengaktifkan kode usulan tanpa izin produk', () => {
    const peta = new Map([['nebulisasi', [rule('nebulisasi', true)]]]);
    const [u] = susunUsulanProsedur([NEBUL], peta);
    expect(kodeProclistDariUsulan([u])).toEqual([]);
    expect(u.alasan).toMatch(/belum diizinkan/i);
  });

  test('aturan TIDAK bisa memasukkan tindakan yang hanya ada di resep atau tanpa kode', () => {
    const peta = new Map([
      ['nebulisasi', [rule('nebulisasi', true)]],
      ['pemasangan_infus', [rule('pemasangan_infus', true)]],
    ]);
    const usulan = susunUsulanProsedur([NEBUL_RESEP_SAJA, INFUS], peta);
    expect(usulan.every(u => u.masuk_proclist === false)).toBe(true);
  });

  test('aturan kondisional di luar konteks tidak mengubah status kode usulan', () => {
    const peta = new Map([['nebulisasi', [rule('nebulisasi', false, 'rawat_inap')]]]);
    const [u] = susunUsulanProsedur([NEBUL], peta, { jenisKlaim: 'RAWAT_JALAN' });
    expect(u.masuk_proclist).toBe(false);
    expect(u.belum_ada_aturan_rs).toBe(true);
  });

  test('kondisi yang lebih khusus menang: igd > selalu', () => {
    const daftar = [rule('nebulisasi', true, 'selalu'), rule('nebulisasi', false, 'igd')];
    expect(pilihAturan(daftar, { jenisKlaim: 'RAWAT_JALAN', igd: true }).masuk_proclist).toBe(false);
    expect(pilihAturan(daftar, { jenisKlaim: 'RAWAT_JALAN', igd: false }).masuk_proclist).toBe(true);
  });

  test('kunjungan IGD dihitung rawat jalan', () => {
    const daftar = [rule('nebulisasi', false, 'rawat_jalan')];
    expect(pilihAturan(daftar, { jenisKlaim: 'RAWAT_JALAN', igd: true })).not.toBeNull();
  });

  test('injeksi_antibiotik dan injeksi_obat memakai aturan istilah "injeksi" di kamus', () => {
    const peta = new Map([['injeksi', [rule('injeksi', false)]]]);
    const t = { id: 'injeksi_obat', nama: 'Injeksi obat', kode_usulan: '99.29', bukti: [{ page_number: 2, sumber: 'resume_medis', kutipan: 'inj x' }] };
    expect(susunUsulanProsedur([t], peta)[0].masuk_proclist).toBe(false);
  });

  // Yang tidak tertulis tidak boleh dikodekan: saturasi rendah bukan tindakan.
  test('tidak ada temuan oksigen -> tidak ada kode oksigen di usulan', () => {
    expect(kodeProclistDariUsulan(susunUsulanProsedur([NEBUL], new Map()))).not.toContain('93.96');
  });
});

describe('basis data (mock)', () => {
  const dbMock = (overrides = {}) => ({
    run: jest.fn().mockResolvedValue({}),
    all: jest.fn().mockResolvedValue([]),
    prepare: jest.fn(() => ({ get: jest.fn().mockResolvedValue({ hospital_code: '3371084', jenis_klaim: 'RAWAT_JALAN' }) })),
    ...overrides,
  });

  test('ensureSchema: istilah_id bertipe TEXT (kamus_penunjang.id bukan UUID) dan kondisi dibatasi', async () => {
    const db = dbMock();
    await ensureSchema(db);
    const ddl = db.run.mock.calls.map(c => c[0]).join('\n');
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS aturan_koding_rs/);
    expect(ddl).toMatch(/istilah_id\s+TEXT NOT NULL REFERENCES kamus_penunjang\(id\)/);
    expect(ddl).not.toMatch(/UUID/i);
    expect(ddl).toMatch(/masuk_proclist\s+BOOLEAN/);
    expect(ddl).toMatch(/CHECK \(kondisi IN \('selalu','rawat_jalan','rawat_inap','igd'\)\)/);
    expect(ddl).toMatch(/DEFAULT 'selalu'/);
    expect(ddl).toMatch(/diputuskan_oleh/);
    expect(ddl).toMatch(/diputuskan_pada/);
    expect(ddl).toMatch(/catatan/);
  });

  test('muatAturan mengelompokkan per istilah', async () => {
    const db = dbMock({
      all: jest.fn().mockResolvedValue([
        { istilah_id: 'nebulisasi', masuk_proclist: false, kondisi: 'igd', diputuskan_oleh: 'dr. A', catatan: 'x' },
        { istilah_id: 'nebulisasi', masuk_proclist: true, kondisi: 'selalu' },
      ]),
    });
    const peta = await muatAturan(db, '3371084');
    expect(peta.get('nebulisasi')).toHaveLength(2);
    expect(db.all.mock.calls[0][1]).toEqual(['3371084']);
  });

  test('tabel belum ada / basis data gagal -> Map kosong, bukan galat (tidak ada gerbang baru)', async () => {
    const db = dbMock({ all: jest.fn().mockRejectedValue(new Error('relation "aturan_koding_rs" does not exist')) });
    const peta = await muatAturan(db, '3371084');
    expect(peta.size).toBe(0);
  });

  test('simpanAturan menolak kondisi tidak sah dan nilai bukan boolean', async () => {
    const db = dbMock();
    await expect(simpanAturan(db, { rsId: '1', istilahId: 'nebulisasi', masukProclist: true, kondisi: 'kapan_saja' })).rejects.toThrow(/kondisi/);
    await expect(simpanAturan(db, { rsId: '1', istilahId: 'nebulisasi', masukProclist: 'ya' })).rejects.toThrow(/boolean/);
    await simpanAturan(db, { rsId: '1', istilahId: 'nebulisasi', masukProclist: false, kondisi: 'igd', diputuskanOleh: 'koder' });
    expect(db.run.mock.calls[0][0]).toMatch(/ON CONFLICT \(rs_id, istilah_id, kondisi\)/);
    expect(db.run.mock.calls[0][1]).toEqual(['1', 'nebulisasi', false, 'igd', 'koder', null]);
  });

  test('tentukanProsedurDariTemuan: kode usulan tidak terisi tanpa izin produk', async () => {
    const hasil = await tentukanProsedurDariTemuan(dbMock(), 'rec-1', [NEBUL]);
    expect(hasil.kode).toEqual([]);
    expect(hasil.usulan[0].belum_ada_aturan_rs).toBe(true);
  });

  test('tentukanProsedurDariTemuan: aturan RS dari DB menahan tindakan', async () => {
    const db = dbMock({
      all: jest.fn().mockResolvedValue([{ istilah_id: 'nebulisasi', masuk_proclist: false, kondisi: 'selalu', diputuskan_oleh: 'koder' }]),
    });
    const hasil = await tentukanProsedurDariTemuan(db, 'rec-1', [NEBUL]);
    expect(hasil.kode).toEqual([]);
    expect(hasil.usulan[0].aturan_rs.masuk_proclist).toBe(false);
  });

  test('konteks klaim tak terbaca -> kode usulan tetap tidak masuk', async () => {
    const db = dbMock({ prepare: jest.fn(() => ({ get: jest.fn().mockRejectedValue(new Error('boom')) })) });
    const hasil = await tentukanProsedurDariTemuan(db, 'rec-1', [NEBUL]);
    expect(hasil.kode).toEqual([]);
  });
});
