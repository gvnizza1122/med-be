/**
 * Pneumonia anak dinilai dengan PNPK IDAI, bukan kriteria dewasa.
 * Fixture anonim meniru dua berkas BRPN anak 3 tahun (8 Okt 2026).
 */
const { nilaiPneumoniaAnak, usiaBulan, batasNapasCepat } = require('../../services/pneumoniaAnakService');
const { evaluasiSyaratPenunjang } = require('../../services/syaratPenunjangService');
const { susunPutusan } = require('../../services/putusanPendingService');

const rec = (o = {}) => ({ birth_date: '2023-02-15', admission_date: '2026-09-28', jenis_klaim: 'RAWAT_INAP', ...o });
const spriDehidrasi = { page_number: 1, ocr_text: 'SURAT PERINTAH RAWAT INAP\nDiagnosa : Febris H4 dengan dyspnea susp BRPN dehidrasi sedang' };
const triaseTabel = { page_number: 11, ocr_text: 'VITAL SIGN BB TB TD Heart Rate RR Temp SpO2\n18 kg 0/0 mmHg 152 x/mnt 30 x/mnt 39.4oC 95%\nsesak +, muntah-muntah +' };
const resumeTanpaKriteria = { page_number: 12, ocr_text: 'RESUME MEDIS RAWAT INAP\nRR : 30 x/mnt,\nSaO2 : 93%\nbatuk berdahak (+), pilek (+), mual muntah disangkal\nretraksi (-)\nDiagnosis Utama : BRPN' };

describe('PNPK IDAI pneumonia anak', () => {
  test('usia dan batas napas cepat per kelompok usia', () => {
    expect(usiaBulan(rec())).toBe(43);
    expect(batasNapasCepat(1).ambang).toBe(60);
    expect(batasNapasCepat(6).ambang).toBe(50);
    expect(batasNapasCepat(43).ambang).toBe(40);
    expect(batasNapasCepat(70)).toBeNull();
  });
  test('tabel tanda vital terbaca: RR kolom kedua x/mnt, SpO2 dari kolom %', () => {
    const r = nilaiPneumoniaAnak({ record: rec(), dx: ['J18.9'], pages: [triaseTabel] });
    expect(r.rr_tertinggi.nilai).toBe(30);
    expect(r.spo2_terendah.nilai).toBe(95);
    expect(r.napas_cepat).toBe(false);
  });
  test('dehidrasi tercatat -> rawat inap anak terdukung', () => {
    const r = nilaiPneumoniaAnak({ record: rec(), dx: ['J18.9'], pages: [spriDehidrasi, triaseTabel, {page_number:13,ocr_text:'CATATAN PERKEMBANGAN PASIEN TERINTEGRASI\nPemeriksaan: dehidrasi sedang; turgor menurun'}] });
    expect(r.rawat_inap_terdukung).toBe(true);
    expect(r.kriteria_rawat_inap.find(k => k.id === 'dehidrasi').status).toBe('terpenuhi');
    expect(r.perlu_telaah).toBe(false);
  });
  test('tanpa kriteria rawat inap -> perlu telaah; negasi "retraksi (-)" tidak dihitung', () => {
    const r = nilaiPneumoniaAnak({ record: rec({ birth_date: '2023-03-24' }), dx: ['J18.9'], pages: [resumeTanpaKriteria] });
    expect(r.retraksi).toEqual([]);
    expect(r.spo2_terendah.nilai).toBe(93);
    expect(r.rawat_inap_terdukung).toBe(false);
    expect(r.perlu_telaah).toBe(true);
  });
  test('bayi memakai ambang >=60 dan kriteria tidak mau minum', () => {
    const bayi = { page_number: 2, ocr_text: 'RR : 62 x/mnt\nbayi malas menetek' };
    const r = nilaiPneumoniaAnak({ record: rec({ birth_date: '2026-08-10' }), dx: ['J18.9'], pages: [bayi] });
    expect(r.kelompok).toBe('bayi');
    expect(r.kriteria_rawat_inap.find(k => k.id === 'napas').status).toBe('terpenuhi');
    expect(r.kriteria_rawat_inap.find(k => k.id === 'tidak_minum').status).toBe('terpenuhi');
  });
  test('dewasa tidak dinilai dengan PNPK anak', () => {
    expect(nilaiPneumoniaAnak({ record: rec({ birth_date: '1980-01-01' }), dx: ['J18.9'], pages: [triaseTabel] })).toBeNull();
  });
});

describe('SP-01 tanpa gram sputum untuk anak; alasan PNPK anak tidak wajib', () => {
  const profil = { hospital_code: '3371084', ketentuan_lokal: [{ id: 'SP-01', sumber_aturan: 'Rekap pending RS' }] };
  test('anak: gram sputum dilewati dengan alasan; dewasa: tetap disyaratkan', () => {
    const anak = evaluasiSyaratPenunjang('J18.9', '87.44', [], { profil, usia: 3 })[0];
    expect(anak.syarat.map(s => s.nama)).not.toContain('Pemeriksaan gram sputum');
    expect(anak.syarat_dilewati_usia[0]).toMatchObject({ nama: 'Pemeriksaan gram sputum' });
    const dewasa = evaluasiSyaratPenunjang('J18.9', '87.44', [], { profil, usia: 45 })[0];
    expect(dewasa.syarat.map(s => s.nama)).toContain('Pemeriksaan gram sputum');
  });
  test('telaah PNPK anak menjadi alasan sedang, bukan berisiko pending', () => {
    const r = nilaiPneumoniaAnak({ record: rec({ birth_date: '2023-03-24' }), dx: ['J18.9'], pages: [resumeTanpaKriteria] });
    const p = susunPutusan({ pneumonia_anak: r }, []);
    expect(p.status).toBe('perlu_dicek');
    expect(p.alasan[0]).toMatchObject({ kode: 'PNPK-IDAI-PNEUMONIA', keparahan: 'sedang', wajib_pending: false });
  });
});
