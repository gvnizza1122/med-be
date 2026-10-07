const { mulaiSesiAgen } = require('../../services/agenCasemixOrkestrator');

const pages = [
  { page_number: 1, ocr_text: 'SURAT PERINTAH RAWAT INAP\nTanggal MRS : 31-12-2025\nDiagnosa : G3P2A0 uk 38 minggu, kpd + oligohidramnion' },
  { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nKeluhan Utama : kenceng-kenceng, keluar air ketuban 3 hari\nDiagnosis Utama : KPD 3 hari\nTerapi : ceftriaxone 2x1 g\nDokter Penanggung Jawab' },
];
const record = { id: 'r1', jenis_klaim: 'RAWAT_INAP', kelas_rawat: '3' };
const db = { all: async (sql) => (/pola_casemix_contoh/.test(sql) ? [{ kode: 'O42.1', jumlah: 3 }] : []), query: async () => {} };

test('agen menyiapkan bekal Luna dari berkas: dokumen, kronologi, fakta, pola casemix, konvensi', async () => {
  const sesi = await mulaiSesiAgen({ record, pages, db });
  const c = sesi.catatanUntukLuna();
  expect(c).toMatch(/BUKAN bukti/);
  expect(c).toMatch(/Resume medis \(hal\. 3\)/);
  expect(c).toMatch(/2025-12-31 Rencana masuk rawat inap/);
  expect(c).toMatch(/kenceng-kenceng/);
  expect(c).not.toMatch(/dikode casemix/);
  expect(sesi.pola).toEqual([]);
  expect(sesi.langkah.map(l => l.nama)).toEqual(['Memetakan dokumen & menyusun fakta klinis', 'Mencari pola keputusan casemix RS (kasus lain)']);
});

test('grouper oleh agen: wasit Luna vs grouper aplikasi; tidak terhitung -> eskalasi Sol', async () => {
  const sesi = await mulaiSesiAgen({ record, pages, db: null });
  const tabel = { 'O-6-10-I': 4656700, 'O-6-10-II': 4926400, 'J-4-15-I': 1, 'J-4-16-I': 2, 'K-5-18-0': 3, 'B-2-12-0': 4 };
  const hasil = k => ({ inacbgResult: k ? { code: k } : null, tarifResult: k ? { amount: tabel[k] } : null });
  // Severity beda dalam kelompok sama -> yang lebih rendah.
  let h = sesi.hitungGrouper((dx, px, j, kls, luna) => hasil(luna || 'O-6-10-II'), ['O42.1', 'O41.0'], ['74.1'], 'O-6-10-I');
  expect(h.inacbgResult.code).toBe('O-6-10-I');
  expect(sesi.langkah.at(-1).keterangan).toMatch(/severity berbeda/);
  h = sesi.hitungGrouper((dx, px, j, kls, luna) => hasil(luna ? 'O-6-10-III' : 'O-6-10-II'), ['O42.1'], ['74.1'], 'O-6-10-III');
  expect(h.inacbgResult.code).toBe('O-6-10-II');
  // Kelompok medis beda -> grouper aplikasi (A90 virus = A-4-13, bukan tebakan A-4-14 bakteri).
  h = sesi.hitungGrouper((dx, px, j, kls, luna) => hasil(luna || 'J-4-16-I'), ['J18.9'], [], 'J-4-15-I');
  expect(h.inacbgResult.code).toBe('J-4-16-I');
  expect(sesi.ringkasan().grouper).toMatchObject({ kode: 'J-4-16-I', grouper_aplikasi: 'J-4-16-I', tebakan_luna: 'J-4-15-I', dx: ['J18.9'] });
  // Luna kelompok prosedur yang belum dipetakan grouper -> Luna.
  h = sesi.hitungGrouper((dx, px, j, kls, luna) => hasil(luna || 'K-5-18-0'), ['K80.2'], ['51.22'], 'B-2-12-0');
  expect(h.inacbgResult.code).toBe('B-2-12-0');
  sesi.hitungGrouper(() => hasil(null), ['X99.9'], []);
  expect(sesi.pemicuSol).toContain('agen_inacbg_tidak_terhitung');
});

test('diagnosis utama lemah -> agen meminta Sol dan memberi catatan', async () => {
  const sesi = await mulaiSesiAgen({ record, pages, db: null });
  const ai = { penalaran_diagnosis: { status: 'selesai', diagnosis: [{ kode: 'O42.1', peran: 'utama', status: 'belum_cukup_bukti', belum_ada: ['lama KPD'] }] }, inacbg_result: { code: 'O-6-10-I' } };
  const pemicu = await sesi.nilaiSebelumSol(null, ai, ['O42.1'], []);
  expect(pemicu).toContain('agen_diagnosis_utama_lemah');
  const c = sesi.catatanUntukSol(ai);
  expect(c).toMatch(/O42\.1 utama = belum_cukup_bukti/);
  expect(c).toMatch(/Grouper agen: O-6-10-I/);
  const r = sesi.ringkasan();
  expect(r).toMatchObject({ peran: 'casemix_rujukan', mulai_setelah: 'ocr_selesai' });
  expect(r.pemicu_sol).toContain('agen_diagnosis_utama_lemah');
});

test('berkas kosong / db rusak tidak melempar', async () => {
  const rusak = { all: async () => { throw Error('db mati'); }, query: async () => { throw Error('db mati'); } };
  const sesi = await mulaiSesiAgen({ record, pages: [], db: rusak });
  expect(sesi.catatanUntukLuna()).toMatch(/Dokumen tersedia: -/);
});

test('pemicu agen hanya berlaku bila Sol aktif', async () => {
  const { tinjauLanjutan } = require('../../services/tinjauanLanjutanService');
  const gateway = { panggilModel: jest.fn() };
  process.env.AI_HYBRID_SOL_ENABLED = 'false';
  const r = await tinjauLanjutan(record, {}, pages, [3], null, { gateway, pemicuAgen: ['agen_diagnosis_utama_lemah'] });
  delete process.env.AI_HYBRID_SOL_ENABLED;
  expect(r.metadata.status).toBe('tidak_diperlukan');
  expect(gateway.panggilModel).not.toHaveBeenCalled();
});
