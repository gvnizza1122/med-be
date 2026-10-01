const { perbaruiRisikoTampilan } = require('../../services/risikoKlaimTampilanService');
const { susunPutusan } = require('../../services/putusanPendingService');
const lama = { status: 'berisiko_pending', alasan: [{ kode: 'KD-02', sumber_pemeriksaan: 'Konsistensi antar data', keparahan: 'tinggi', ringkas: 'Cara bayar umum' }], jumlah: { total: 1, berat: 1 } };
const record = (extra = {}) => ({ sep: 'SEP-UJI', diagnosa_list: 'J44.9;J18.9', prosedur_list: '93.94', validation_status: 'pending', ai_review: { konsistensi_data: [{ id: 'KD-02' }], putusan_pending: lama }, ...extra });

test('SEP BPJS + resume UMUM: buang alarm lama, tampilkan risiko koding dari DIAGLIST saat ini', () => {
  const rec = record();
  const before = JSON.stringify(rec);
  const h = perbaruiRisikoTampilan(rec);
  expect(h.penjaminan.jenis).toBe('BPJS');
  expect(h.konsistensi_data).toEqual([]);
  expect(h.putusan_pending.alasan.map(a => a.kode)).toEqual(['KMB-12']);
  expect(h.putusan_pending.status).toBe('berisiko_pending');
  expect(h.kesiapan_koding.judul).toMatch(/belum siap upload/);
  expect(h.kesiapan_koding.alasan[0]).toMatchObject({ kode_asal: ['J18.9', 'J44.9'], kode_saran: 'J44.0' });
  expect(JSON.stringify(rec)).toBe(before); // tidak mengubah data asli
});

test('kode sudah J44.0: alarm kombinasi tidak tertinggal; tidak menganggap semua pemeriksaan sudah lolos', () => {
  const h = perbaruiRisikoTampilan(record({ diagnosa_list: 'J44.0' }));
  expect(h.putusan_pending.alasan).toEqual([]);
  expect(h.kesiapan_koding.status).toBe('tidak_ada_temuan_kombinasi');
  expect(h.kesiapan_koding.judul).not.toMatch(/siap upload/);
});

test('alasan klinis lain dan error validasi tetap dipertahankan', () => {
  const klinis = { kode: 'KGD-IGD', sumber_pemeriksaan: 'Kriteria kegawatdaruratan', keparahan: 'tinggi', wajib_pending: true };
  const validasi = { kode: 'RV-06', sumber_pemeriksaan: 'Aturan validasi', keparahan: 'tinggi' };
  const h = perbaruiRisikoTampilan(record({ diagnosa_list: 'J44.0', ai_review: { putusan_pending: { ...lama, alasan: [...lama.alasan, klinis, validasi] } } }), [{ rule_id: 'RV-06' }]);
  expect(h.putusan_pending.alasan).toEqual([klinis, validasi]);
  expect(h.putusan_pending.status).toBe('berisiko_pending');
});

test('tanpa SEP tidak memberi label BPJS; raw_data SEP terisi tetap dikenali', () => {
  expect(perbaruiRisikoTampilan({ sep: '', diagnosa_list: 'J44.0' }).penjaminan).toBeNull();
  expect(perbaruiRisikoTampilan({ raw_data: '{"SEP":"SEP-UJI"}' }).penjaminan.jenis).toBe('BPJS');
  expect(perbaruiRisikoTampilan({ sep: '-' }).penjaminan).toBeNull();
});

test('hasil AI bersih lama tidak menutupi kombinasi yang masih terpasang', () => {
  const h = perbaruiRisikoTampilan(record({ ai_review: JSON.stringify({ putusan_pending: { ...lama, status: 'tidak_ditemukan_alasan', alasan: [] } }) }));
  expect(h.putusan_pending.status).toBe('berisiko_pending');
  expect(h.putusan_pending.alasan[0].kode).toBe('KMB-12');
});

test('saran AI berbeda saja tidak dianggap risiko kombinasi yang sudah terpasang', () => {
  const h = perbaruiRisikoTampilan(record({ diagnosa_list: 'R10.4', ai_review: { suggested_codes: [{ type: 'diagnosis', code: 'J44.9' }, { type: 'diagnosis', code: 'J18.9' }] } }));
  expect(h.kesiapan_koding.alasan).toEqual([]);
});

test('putusan baru tidak menerima lagi KD-02 tersimpan', () => {
  expect(susunPutusan({ konsistensi_data: [{ id: 'KD-02', keparahan: 'tinggi' }] }).alasan).toEqual([]);
});

test('klaim yang belum dianalisis tidak diberi putusan risiko bersih', () => {
  expect(perbaruiRisikoTampilan({ diagnosa_list: 'R10.4', ai_review: null }).putusan_pending).toBeNull();
});
