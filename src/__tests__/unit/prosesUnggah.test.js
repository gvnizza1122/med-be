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

test('berkas tersimpan dengan analisis sebagian tidak diberi label selesai berhasil', async () => {
  const id = await pu.buat(db,{hospitalCode:'PARTIAL',fileName:'kasus.pdf'});
  await pu.selesai(db,id,{success:true,file_id:'f-partial',record_id:'r-partial',analysis_status:'sebagian',analysis_warning:'Analisis belum lengkap.'});
  const p = (await pu.daftar(db,{hospitalCode:'PARTIAL'})).proses[0];
  expect(p).toMatchObject({status:'perlu_dicek',persen:100,sisa_detik:0,file_id:'f-partial',pesan:'Analisis belum lengkap.'});
  expect(pu.statusHasil({success:true,analysis_status:'gagal'})).toBe('perlu_dicek');
  expect(pu.statusHasil({success:false})).toBe('gagal');
});

test('perkiraan sisa: membaca berkas memperhitungkan jumlah halaman', () => {
  const kal = { detik_per_halaman: 4, detik_review: 150 };
  const baru = new Date().toISOString();
  expect(pu.sisaDetik({ tahap: 'membaca_berkas', jumlah_halaman: 10, tahap_mulai: baru }, kal)).toBe(40 + 10 + 150 + 5);
  expect(pu.sisaDetik({ tahap: 'review_ai', tahap_mulai: baru }, kal)).toBe(155);
  expect(pu.sisaDetik({ tahap: 'review_ai', tahap_mulai: new Date(Date.now() - 600000).toISOString() }, kal)).toBeNull();
});

test('antrean membatasi jumlah proses paralel', async () => {
  const a = pu.buatAntrean(2);
  let jalan = 0; let puncak = 0;
  const tugas = () => a.tambah(async () => { jalan++; puncak = Math.max(puncak, jalan); await new Promise(r => setTimeout(r, 10)); jalan--; });
  await Promise.all([tugas(), tugas(), tugas(), tugas(), tugas()]);
  expect(puncak).toBe(2);
});

test('300 pekerjaan dengan kegagalan tetap diproses sekali, maksimal 20 paralel, dan semuanya tercatat', async () => {
  pu._memori.clear();
  const antrean = pu.buatAntrean(20);
  const ids = [];
  for (let i = 0; i < 300; i++) ids.push(await pu.buat(db, {
    batchId: 'bulk-300', hospitalCode: 'BULK', fileName: `${i}.pdf`, urutanFile: i,
  }));
  const percobaan = new Map(); let aktif = 0; let puncak = 0;
  const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await Promise.all(ids.map((id, i) => antrean.tambah(async () => {
      percobaan.set(id, (percobaan.get(id) || 0) + 1);
      aktif++; puncak = Math.max(puncak, aktif);
      try {
        await pu.pencatat(db, id)('membaca_berkas');
        await new Promise(resolve => setImmediate(resolve));
        if (i % 10 === 0) {
          await pu.selesai(db, id, { success: false, error: 'Simulasi gangguan satu berkas.' });
          throw Error('Simulasi kegagalan pekerjaan');
        }
        await pu.selesai(db, id, { success: true, file_id: `file-${i}`, record_id: `record-${i}`,
          analysis_status: i % 10 === 1 ? 'sebagian' : 'lengkap', analysis_warning: 'Analisis belum lengkap.' });
      } finally { aktif--; }
    })));
    const rows = (await pu.daftar(db, { hospitalCode: 'BULK', batasParalel: 20 })).proses;
    expect(puncak).toBe(20);
    expect(antrean.berjalan).toBe(0); expect(antrean.menunggu).toBe(0);
    expect(percobaan.size).toBe(300);
    expect([...percobaan.values()].every(n => n === 1)).toBe(true);
    expect(rows).toHaveLength(300);
    expect(rows.filter(p => p.status === 'selesai')).toHaveLength(240);
    expect(rows.filter(p => p.status === 'perlu_dicek')).toHaveLength(30);
    expect(rows.filter(p => p.status === 'gagal')).toHaveLength(30);
    expect(rows.every(p => p.persen === 100 && p.sisa_detik === 0)).toBe(true);
    expect(logError).toHaveBeenCalledTimes(30);
  } finally { logError.mockRestore(); }
});

test('ETA mengikuti slot yang tersedia dan lama setiap berkas, bukan gelombang rata-rata', () => {
  const now = Date.now();
  const kal = { detik_per_halaman: 4, detik_review: 100 };
  const rows = [
    { id: 'a', status: 'berjalan', tahap: 'review_ai', tahap_mulai: new Date(now - 90000) },
    { id: 'b', status: 'berjalan', tahap: 'review_ai', tahap_mulai: new Date(now) },
    ...['c', 'd', 'e'].map(id => ({ id, status: 'antre', tahap: 'antre' })),
  ];
  const eta = pu.estimasiAntrean(rows, kal, 2, now);
  expect([...eta.values()]).toEqual([15, 105, 190, 280, 365]);
});

test('ETA antrean tak diketahui bila semua slot melampaui perkiraan; slot kosong tetap terpakai', () => {
  const now = Date.now(); const kal = { detik_per_halaman: 4, detik_review: 100 };
  const rows = [{ id: 'a', status: 'berjalan', tahap: 'review_ai', tahap_mulai: new Date(now - 200000) },
    { id: 'b', status: 'antre', tahap: 'antre' }];
  expect(pu.estimasiAntrean(rows, kal, 1, now).get('b')).toBeNull();
  expect(pu.estimasiAntrean(rows, kal, 2, now).get('b')).toBe(175);
});

test('progres mengikuti tahap dan tidak mencapai 100 sebelum terminal', () => {
  const kal = { detik_per_halaman: 4, detik_review: 150 }; const now = Date.now();
  const b = { status: 'berjalan', tahap_mulai: new Date(now - 9999999) };
  const stages = ['membaca_berkas', 'menyimpan', 'review_ai', 'mengisi_kode'];
  const percentages = stages.map(tahap => pu.persenTahap({ ...b, tahap }, kal, now));
  expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
  expect(percentages.every(n => n < 100)).toBe(true);
  expect(pu.persenTahap({ status: 'gagal' }, kal)).toBe(100);
});

test('jumlah halaman yang datang kemudian tidak mengulang jam tahap OCR', async () => {
  const id = await pu.buat(db, { hospitalCode: 'RS4', fileName: 'native.pdf', urutanFile: 2 });
  const record = pu._memori.get(id); const catat = pu.pencatat(db, id);
  await catat('membaca_berkas'); const started = record.tahap_mulai;
  await catat('membaca_berkas', { jumlah_halaman: 40 });
  expect(record.tahap_mulai).toEqual(started);
  expect(record.jumlah_halaman).toBe(40);
  expect(record.urutan_file).toBe(2);
});

test('antrean RS lain memengaruhi ETA tanpa membocorkan nama berkasnya', async () => {
  pu._memori.clear();
  const foreign = await pu.buat(db, { hospitalCode: 'OTHER', fileName: 'private.pdf' });
  const own = await pu.buat(db, { hospitalCode: 'OWN', fileName: 'own.pdf' });
  const rows = (await pu.daftar(db, { hospitalCode: 'OWN', batasParalel: 1 })).proses;
  expect(rows.map(p => p.id)).toEqual([own]);
  expect(rows[0].sisa_detik).toBe(450);
  await pu.tutup(db, { ids: [foreign], hospitalCode: 'OWN' });
  expect(pu._memori.get(foreign).ditutup).toBe(false);
});

test('aktif lebih dari 24 jam dan antrean lebih dari 400 berkas tetap terlihat', async () => {
  pu._memori.clear();
  for (let i = 0; i < 401; i++) await pu.buat(db, { hospitalCode: 'MANY', fileName: `${i}.pdf` });
  const first = [...pu._memori.values()][0]; first.dibuat = new Date(Date.now() - 2 * 86400000);
  expect((await pu.daftar(db, { hospitalCode: 'MANY' })).proses).toHaveLength(401);
});
