const pu = require('../../services/prosesUnggahService');

// DB tanpa izin membuat tabel -> status disimpan di memori (tidak pernah melempar).
const db = { query: async () => { throw Error('permission denied'); }, run: async () => ({}), get: async () => null, all: async () => [] };
beforeAll(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));

test('alur tahap tercatat, perkiraan sisa waktu turun per tahap, hasil tersimpan', async () => {
  const id = await pu.buat(db, { batchId: 'b1', hospitalCode: 'RS1', userId: 'u1', fileName: 'a.pdf' });
  let d = (await pu.daftar(db, { hospitalCode: 'RS1', batasParalel: 2 })).proses.find(p => p.id === id);
  expect(d).toMatchObject({ status: 'antre', tahap_label: 'Menunggu giliran' });
  const sisaAntre = d.sisa_detik;

  const catat = pu.pencatat(db, id);
  await catat('membaca_berkas');
  await catat('menyimpan', { jumlah_halaman: 20, file_id: 'f1', record_id: 'r1' });
  await catat('review_ai');
  d = (await pu.daftar(db, { hospitalCode: 'RS1' })).proses.find(p => p.id === id);
  expect(d).toMatchObject({ status: 'berjalan', tahap: 'review_ai', jumlah_halaman: 20, file_id: 'f1' });
  expect(d.sisa_detik).toBeLessThan(sisaAntre);

  await pu.selesai(db, id, { success: true, file_id: 'f1', record_id: 'r1' });
  d = (await pu.daftar(db, { hospitalCode: 'RS1' })).proses.find(p => p.id === id);
  expect(d).toMatchObject({ status: 'selesai', persen: 100, sisa_detik: 0, file_id: 'f1' });

  // Proses RS lain tidak terlihat; tutup menyembunyikan yang selesai.
  expect((await pu.daftar(db, { hospitalCode: 'RS2' })).proses).toHaveLength(0);
  await pu.tutup(db, { ids: [id], hospitalCode: 'RS1' });
  expect((await pu.daftar(db, { hospitalCode: 'RS1' })).proses.find(p => p.id === id)).toBeUndefined();
});

test('gagal menyimpan pesan; kalibrasi memakai riwayat selesai', async () => {
  const id = await pu.buat(db, { hospitalCode: 'RS3', fileName: 'b.pdf' });
  await pu.selesai(db, id, { success: false, error: 'SEP sudah pernah diupload' });
  const d = (await pu.daftar(db, { hospitalCode: 'RS3' })).proses[0];
  expect(d).toMatchObject({ status: 'gagal', pesan: 'SEP sudah pernah diupload' });
  const kal = await pu.kalibrasi(db);
  expect(kal.detik_per_halaman).toBeGreaterThan(0);
  expect(kal.detik_review).toBeGreaterThan(0);
});

test('perkiraan sisa: membaca berkas memperhitungkan jumlah halaman', () => {
  const kal = { detik_per_halaman: 4, detik_review: 150 };
  const baru = new Date().toISOString();
  expect(pu.sisaDetik({ tahap: 'membaca_berkas', jumlah_halaman: 10, tahap_mulai: baru }, kal)).toBe(40 + 10 + 150);
  expect(pu.sisaDetik({ tahap: 'review_ai', tahap_mulai: baru }, kal)).toBe(150);
  expect(pu.sisaDetik({ tahap: 'review_ai', tahap_mulai: new Date(Date.now() - 600000).toISOString() }, kal)).toBe(10);
});

test('antrean membatasi jumlah proses paralel', async () => {
  const a = pu.buatAntrean(2);
  let jalan = 0; let puncak = 0;
  const tugas = () => a.tambah(async () => { jalan++; puncak = Math.max(puncak, jalan); await new Promise(r => setTimeout(r, 10)); jalan--; });
  await Promise.all([tugas(), tugas(), tugas(), tugas(), tugas()]);
  expect(puncak).toBe(2);
});
