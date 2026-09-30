/**
 * Unit test murni untuk temuanPenunjangService — tanpa AI, tanpa DB.
 * Lihat catatan wiring di HANDOFF.md item 4: kamusPenunjangService.cocokkan/
 * temukanDalamTeks dipakai di sini untuk membaca halaman lab/radiologi dan
 * daftar "Pemeriksaan Penunjang" di resume/triase, murni sebagai anotasi.
 */

const { bacaTemuanPenunjang } = require('../../services/temuanPenunjangService');

afterEach(() => {
  delete process.env.KAMUS_PENUNJANG_PEMBACAAN_AKTIF;
});

const HAL_RESUME = [
  'Resume Medis Rawat Jalan',
  'Diagnosa: Pneumonia',
  'Pemeriksaan Penunjang: DL, Ro thorax, Widal, Pemeriksaan Xyz123',
  'Tindakan: Nebulisasi',
].join('\n');

const HAL_LAB = [
  'Hasil Pemeriksaan Laboratorium',
  'Hb  9.8  g/dL',
  'WBC  12.500  /uL',
  'Kadar Aneh Sekali  5  mg/dL',
].join('\n');

describe('bacaTemuanPenunjang — daftar "Pemeriksaan Penunjang" di resume', () => {
  test('istilah dikenali membawa nama baku + kode usulan belum terverifikasi', () => {
    const { temuan } = bacaTemuanPenunjang([{ page_number: 1, ocr_text: HAL_RESUME }]);
    const byId = id => temuan.find(t => t.istilah_id === id);

    expect(byId('darah_lengkap')).toMatchObject({ istilah_baku: 'Darah lengkap', kode_usulan: '90.59', kode_terverifikasi: false, page_number: 1 });
    expect(byId('rontgen_toraks')).toMatchObject({ istilah_baku: 'Rontgen toraks', kode_usulan: '87.44', kode_terverifikasi: false });
    expect(byId('widal')).toMatchObject({ istilah_baku: 'Widal', kode_terverifikasi: false, menjadi_syarat: true });
  });

  test('setiap temuan membawa kutipan & halaman untuk ditelusuri', () => {
    const { temuan } = bacaTemuanPenunjang([{ page_number: 3, ocr_text: HAL_RESUME }]);
    for (const t of temuan) {
      expect(t.page_number).toBe(3);
      expect(typeof t.kutipan).toBe('string');
      expect(t.kutipan.length).toBeGreaterThan(0);
    }
  });

  test('istilah yang tidak dikenali kamus manapun masuk tidak_dikenali, bukan dibuang diam-diam', () => {
    const { tidak_dikenali } = bacaTemuanPenunjang([{ page_number: 1, ocr_text: HAL_RESUME }]);
    expect(tidak_dikenali).toContainEqual({ ditulis: 'Pemeriksaan Xyz123', halaman: 1 });
  });

  test('tidak pernah mengisi field "kode" (hanya kode_usulan) -- kode ICD-9 selalu usulan', () => {
    const { temuan } = bacaTemuanPenunjang([{ page_number: 1, ocr_text: HAL_RESUME }]);
    for (const t of temuan) {
      if (t.status === 'dikenali') {
        expect(t).not.toHaveProperty('kode');
        expect(t.kode_terverifikasi).toBe(false);
      }
    }
  });
});

describe('bacaTemuanPenunjang — halaman lab_results: baris tabel dibaca dulu, baru nama dicocokkan', () => {
  test('parameter 2 huruf (Hb, WBC) tetap dikenali karena nama sudah terisolasi parser baris', () => {
    const { temuan } = bacaTemuanPenunjang([{ page_number: 2, ocr_text: HAL_LAB }]);
    const ids = temuan.map(t => t.istilah_id);
    expect(ids).toEqual(expect.arrayContaining(['hemoglobin', 'leukosit']));
  });

  test('DC pada baris tabel lab diselesaikan lewat bagian menjadi hitung_jenis, bukan ditebak', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Hasil Pemeriksaan Laboratorium\nDC 5 %' }];
    const { temuan } = bacaTemuanPenunjang(halaman);
    const dc = temuan.find(t => t.ditulis === 'DC');
    expect(dc).toBeDefined();
    expect(dc.istilah_id).toBe('hitung_jenis');
    expect(dc.dipilih_dari_konteks).toBe(true);
  });
});

describe('bacaTemuanPenunjang — halaman radiology dipindai bebas per baris', () => {
  test('istilah radiologi (>=3 huruf) dikenali dengan bagian "radiologi"', () => {
    const halaman = [{ page_number: 4, ocr_text: 'Hasil Pemeriksaan Radiologi\nKesan: USG abdomen tak tampak kelainan' }];
    const { temuan } = bacaTemuanPenunjang(halaman);
    expect(temuan.map(t => t.istilah_id)).toContain('usg_abdomen');
  });

  test('singkatan bertabrakan (CT) tidak pernah ditebak dari kalimat bebas radiologi', () => {
    const halaman = [{ page_number: 1, ocr_text: 'Hasil Pemeriksaan Radiologi\nCT baik, tidak ada kelainan' }];
    const { temuan } = bacaTemuanPenunjang(halaman);
    expect(temuan.find(t => t.ditulis === 'CT' || t.istilah_id === 'ct_kepala')).toBeUndefined();
  });
});

describe('bacaTemuanPenunjang — gate KAMUS_PENUNJANG_PEMBACAAN_AKTIF', () => {
  test('default (env tidak diset) aktif: menghasilkan temuan', () => {
    const { temuan } = bacaTemuanPenunjang([{ page_number: 1, ocr_text: HAL_RESUME }]);
    expect(temuan.length).toBeGreaterThan(0);
  });

  test('KAMUS_PENUNJANG_PEMBACAAN_AKTIF=false mematikan total pemindaian', () => {
    process.env.KAMUS_PENUNJANG_PEMBACAAN_AKTIF = 'false';
    const hasil = bacaTemuanPenunjang([{ page_number: 1, ocr_text: HAL_RESUME }, { page_number: 2, ocr_text: HAL_LAB }]);
    expect(hasil.temuan).toEqual([]);
    expect(hasil.tidak_dikenali).toEqual([]);
  });
});

describe('bacaTemuanPenunjang — halaman tanpa teks / kosong', () => {
  test('tidak melempar error pada halaman tanpa teks', () => {
    expect(() => bacaTemuanPenunjang([{ page_number: 1 }, null, undefined])).not.toThrow();
    expect(bacaTemuanPenunjang([])).toEqual({ temuan: [], tidak_dikenali: [] });
    expect(bacaTemuanPenunjang(undefined)).toEqual({ temuan: [], tidak_dikenali: [] });
  });
});
