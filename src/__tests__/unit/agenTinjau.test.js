const { jalankanAgenTinjau, temukanMasalah, terapkanUsulan } = require('../../services/agenTinjauService');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');

const pages = [
  { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nTumor regio sternum (subfascia)\nTindakan/Prosedur :\n1. Eksisi dan PA' },
  { page_number: 12, ocr_text: 'JAWABAN PEMERIKSAAN HISTOPATOLOGI\nKesimpulan : sesuai untuk keloid DD dermatofibroma' },
];
const record = { jenis_klaim: 'RAWAT_INAP', kelas_rawat: '3', diagnosa_list: '' };
const db = { all: jest.fn(async () => [{ code: 'D21.3', judul: 'Benign neoplasm, connective and other soft tissue of thorax' }]) };
const gw = (...jawaban) => {
  const fn = jest.fn();
  for (const j of jawaban) fn.mockResolvedValueOnce({ ok: true, hasil: j, penggunaan: { total_tokens: 1000 }, biaya: { idr: 3 }, model: 'gpt-6-luna' });
  return { panggilModel: fn };
};

test('berkas tanpa masalah tidak memanggil agen (biaya 0)', async () => {
  const g = gw();
  const r = await jalankanAgenTinjau({ saran: [{ code: 'D21.3', type: 'diagnosis', kamus_valid: true }, { code: '86.3', type: 'procedure', kamus_valid: true }], record, pages, hitungInacbgDanTarif, db, gateway: g });
  expect(r.metadata.status).toBe('tidak_diperlukan');
  expect(g.panggilModel).not.toHaveBeenCalled();
});

test('kode belum WHO -> agen mencari di kamus lalu mengganti, berkutipan', async () => {
  const g = gw(
    { langkah: 'cari_kode', sistem: 'icd10', teks: 'benign connective tissue thorax' },
    { langkah: 'selesai', ringkasan: 'Tumor jinak jaringan lunak toraks.', perlu_analisis_mendalam: false,
      usulan: [{ kode: 'D21.3', jenis: 'diagnosis', peran: 'utama', halaman: 3, kutipan: 'Tumor regio sternum (subfascia)', alasan: 'PA jinak, subfascia', mengganti: 'X99.9' }] },
  );
  const saran = [{ code: 'X99.9', type: 'diagnosis', kamus_valid: false, belum_who: true, page_number: 3, quotation: 'Tumor regio sternum (subfascia)' }];
  const r = await jalankanAgenTinjau({ saran, record, pages, hitungInacbgDanTarif, db, gateway: g });
  expect(g.panggilModel).toHaveBeenCalledTimes(2);
  expect(g.panggilModel.mock.calls[1][1].prompt).toMatch(/D21\.3 Benign neoplasm/);
  expect(r.saran.map(s => s.code)).toEqual(['D21.3']);
  expect(r.metadata).toMatchObject({ status: 'selesai', diterima: ['D21.3'], tokens_used: 2000, biaya_idr: 6 });
});

test('usulan kode karangan atau kutipan palsu ditolak; agen ragu -> perlu analisis mendalam', async () => {
  const hasil = terapkanUsulan([], [
    { kode: 'Z99.999', jenis: 'diagnosis', halaman: 3, kutipan: 'Tumor regio sternum' },
    { kode: 'D21.3', jenis: 'diagnosis', halaman: 3, kutipan: 'tulisan yang tidak ada' },
  ], pages);
  expect(hasil.diterima).toEqual([]);
  expect(hasil.ditolak.map(t => t.alasan)).toEqual(['tidak ada di kamus', 'kutipan tidak ditemukan di halaman']);
  const g = gw({ langkah: 'selesai', usulan: [], perlu_analisis_mendalam: true, ringkasan: 'bukti kurang' });
  const r = await jalankanAgenTinjau({ saran: [], record, pages, hitungInacbgDanTarif, db, gateway: g });
  expect(r.metadata).toMatchObject({ status: 'belum_yakin', perlu_analisis_mendalam: true });
});

test('jawaban di luar protokol menghentikan agen, tidak menghabiskan langkah', async () => {
  const g = gw({ field_notes: {} });
  const r = await jalankanAgenTinjau({ saran: [], record, pages, hitungInacbgDanTarif, db, gateway: g });
  expect(g.panggilModel).toHaveBeenCalledTimes(1);
  expect(r.metadata.status).toBe('gagal');
});

test('masalah terdeteksi tanpa AI: operasi tanpa kode & INA-CBG tidak terhitung', () => {
  // U09.9 (kondisi pasca COVID-19) belum ada di tabel resmi -> INA-CBG tidak
  // terhitung. (P07.3 kini terpetakan resmi ke P-8-17, jadi tidak lagi cocok
  // sebagai contoh "tak terhitung".)
  const m = temukanMasalah({ saran: [{ code: 'U09.9', type: 'diagnosis', kamus_valid: true }], record, operasiTanpaKode: { nama: 'Ada operasi, tetapi kode tindakan operasi belum ada', yang_ditemukan: { kutipan: 'Operasi Kecil', page_number: 13 } }, hitungInacbgDanTarif });
  expect(m.join(' ')).toMatch(/kode tindakan operasi/);
  expect(m.join(' ')).toMatch(/INA-CBG tidak terhitung/);
});
