const { susunSaranKoding } = require('../../services/saranKodingService');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');

const saran = (code, type, extra = {}) => ({ code, type, kamus_valid: true, page_number: 2, quotation: code, ...extra });
const susun = (record, ai) => susunSaranKoding(record, ai, hitungInacbgDanTarif);

// MUNAWIR (0170R0110926V001943): PPOK + pneumonia di IGD, nebulisasi.
describe('saran koding — kasus PPOK + pneumonia rawat jalan', () => {
  const record = { diagnosa_list: 'J44.9;J18.9', prosedur_list: '93.94', jenis_klaim: 'RAWAT_JALAN', kelas_rawat: 3 };
  const ai = {
    tinjauan_diagnosis: { versi: 1, status: 'ada_saran', kode_rekomendasi: ['J44.9', 'J18.9'], kandidat: [{ kode: 'J44.9', status: 'didukung' }, { kode: 'J18.9', status: 'didukung' }] },
    suggested_codes: [saran('J44.9', 'diagnosis', { quotation: 'PPOK,' }), saran('J18.9', 'diagnosis', { quotation: 'Pneumonia' })],
    temuan_tindakan: [{
      id: 'nebulisasi', kode_usulan: '93.94',
      bukti: [
        { sumber: 'resume_medis', page_number: 2, kutipan: 'Tindakan Nebulisasi Ventasal' },
        { sumber: 'resep', page_number: 3, kutipan: 'Ventasal NEBUL' },
      ],
    }],
    // J44.0 (hasil gabung KMB-12) -> Q-5-38-0 di tabel resmi alt_diagnosis
    // (Rp245.100); dulu heuristik menebak Q-5-43-0/264100.
    inacbg_result: { code: 'Q-5-38-0' }, tariff_result: { amount: 245100 },
  };

  test('J44.9 + J18.9 digabung menjadi J44.0 (KMB-12) beserta bukti asalnya', () => {
    const h = susun(record, ai);
    expect(h.diagnosis.map(d => d.kode)).toEqual(['J44.0']);
    expect(h.diagnosis[0]).toMatchObject({ peran: 'utama', asal: ['kombinasi'] });
    expect(h.diagnosis[0].deskripsi).toMatch(/acute lower respiratory infection/);
    expect(h.diagnosis[0].bukti.map(b => b.kutipan)).toEqual(['PPOK,', 'Pneumonia']);
    expect(h.perubahan[0]).toMatchObject({ aturan: 'KMB-12', menjadi: 'J44.0', sumber: 'Berita Acara Kesepakatan 2018' });
    expect(h.sama_dengan_klaim).toBe(false);
  });

  test('prosedur nebulisasi dengan bukti resume; resep tidak dijadikan bukti', () => {
    const h = susun(record, ai);
    expect(h.prosedur.map(p => p.kode)).toEqual(['93.94']);
    expect(h.prosedur[0].bukti.map(b => b.sumber)).toEqual(['resume_medis']);
  });

  test('INA-CBG & tarif dihitung dari kode saran, dibandingkan dengan klaim', () => {
    const h = susun(record, ai);
    expect(h.inacbg).toMatchObject({ kode: 'J-3-13-0', tarif: 321700 });
    expect(h.klaim_saat_ini).toMatchObject({ diagnosis: ['J44.9', 'J18.9'], tarif: null });
    expect(h.selisih_tarif).toBeNull(); // Hasil estimasi AI bukan tarif pada berkas klaim asli.
  });
});

describe('saran koding — penyaringan', () => {
  test('kode DIAGLIST di luar kamus WHO tidak dipakai, dengan alasan', () => {
    const h = susun({ diagnosa_list: 'R06.0;J45.3', jenis_klaim: 'RAWAT_JALAN' }, {});
    expect(h.diagnosis.map(d => d.kode)).toEqual(['R06.0']);
    expect(h.tidak_dipakai).toEqual([expect.objectContaining({ kode: 'J45.3', jenis: 'diagnosis' })]);
  });

  test('saran yang disangkal / belum tervalidasi kamus tidak dipakai', () => {
    const h = susun({ jenis_klaim: 'RAWAT_JALAN' }, {
      suggested_codes: [
        saran('H61.2', 'diagnosis'),
        saran('J18.9', 'diagnosis', { boleh_isi_otomatis: false }),
        saran('R10.84', 'diagnosis', { kamus_valid: false }),
      ],
    });
    expect(h.diagnosis.map(d => d.kode)).toEqual(['H61.2']);
    expect(h.tidak_dipakai.map(t => t.kode).sort()).toEqual(['J18.9', 'R10.84']);
  });

  test('tindakan yang hanya ada di resep tidak menjadi saran prosedur', () => {
    const h = susun({ diagnosa_list: 'J45.9', jenis_klaim: 'RAWAT_JALAN' }, {
      temuan_tindakan: [{ id: 'nebulisasi', kode_usulan: '93.94', bukti: [{ sumber: 'resep', page_number: 3, kutipan: 'NEBUL' }] }],
    });
    expect(h.prosedur).toEqual([]);
  });

  test('urutan DIAGLIST koder dipertahankan sebagai diagnosis utama', () => {
    const h = susun({ diagnosa_list: 'N18.5', prosedur_list: '39.95', jenis_klaim: 'RAWAT_JALAN' }, { suggested_codes: [saran('I10', 'diagnosis')] });
    expect(h.diagnosis.map(d => [d.kode, d.peran])).toEqual([['N18.5', 'utama'], ['I10', 'sekunder']]);
  });

  test('tanpa diagnosis sama sekali -> tanpa INA-CBG, dengan catatan', () => {
    const h = susun({ jenis_klaim: 'RAWAT_JALAN' }, {});
    expect(h.inacbg).toBeNull();
    expect(h.catatan[0]).toMatch(/Belum ada diagnosis/);
  });
});
