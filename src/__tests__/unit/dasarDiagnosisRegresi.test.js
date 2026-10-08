// Kutipan klinis anonim dari delapan berkas acuan. Tidak menyimpan nama/SEP/identitas.
jest.mock('../../database/init', () => ({ getDb: () => ({ all: async () => { throw Error('uji offline'); } }) }));
jest.mock('../../services/kodeDiagnosisWhoService', () => ({ petakanKeKodeWho: jest.fn(async () => null) }));
const acuan = require('../fixtures/berkasAcuanKlinis.json');
const { bacaDiagnosisAkhir, jagaSumberDiagnosis, klasifikasiPatologi, susunDasarDiagnosis } = require('../../services/dasarDiagnosisService');
const { terapkanUsulan } = require('../../services/agenTinjauService');
const { bacaTemuanTindakan, jagaSumberTindakan } = require('../../services/temuanTindakanService');
const { bacaTemuanPenunjang } = require('../../services/temuanPenunjangService');
const { kodeFinal, periksaAturan, periksaKritis } = require('../../services/pemeriksaKritisService');
const { tindakanBelumDikode } = require('../../services/konvensiKodingRs');
const { evaluasiSyaratPenunjang: evaluasiSyaratPenunjangAsli, cariKataKunci } = require('../../services/syaratPenunjangService');
const { lengkapiKodeNeoplasma } = require('../../services/kodingNeoplasmaService');
const { annotateKamusValid, hitungInacbgDanTarif } = require('../../services/aiReviewService');
const resume = a => ({ page_number: 3, ocr_text: `RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\n${a.diagnosis}\nDiagnosis Sekunder :\n${a.sekunder}\nTindakan/Prosedur :\n${a.tindakan}\nTerapi/pengobatan selama di rumah sakit :\nReaksi Obat : Tidak\nCara Keluar RS : Diijinkan Pulang` });
const pa = { page_number: 16, ocr_text: 'JAWABAN PEMERIKSAAN HISTOPATOLOGI\nBahan : Anal lesion\nSifat Keganasan : Tidak didapatkan tanda ganas\nKesimpulan : Anal lesion :\nHistopathological findings are consistent with fibroepithelial polyp accompanied\nby chronic suppurative inflammation\nDokter Pemeriksa' };
const sputum = { page_number: 8, ocr_text: 'LABORATORIUM\nJenis Spesimen : Sputum\nGram Negatif : Basil soliter (+)\nGram Positif : Diplococcus (++)\nPemeriksaan Gram' };
const s = (code, quotation, page_number = 3) => ({ type: 'diagnosis', code, quotation, page_number, kamus_valid: true });

test.each(acuan)('grouper acuan $id: kelompok/kelas cocok, severity tetap membutuhkan verifikasi', ({ referensi: r }) => {
  const hasil = hitungInacbgDanTarif(r.dx, r.px, 'RAWAT_INAP', r.kelas, null);
  expect(hasil.inacbgResult).toMatchObject({ code: r.cbg, severity_estimasi: true, severity_status: 'belum_terverifikasi', grouper_resmi: false });
  expect(hasil.tarifResult).toMatchObject({ amount: r.tarif, perlu_verifikasi_grouper: true });
  expect(hasil.tarifResult.skenario_severity[0]).toMatchObject({ code: r.cbg, amount: r.tarif });
});

test.each(acuan)('acuan $id: diagnosis akhir dan tindakan tidak tertelan bagian lain', a => {
  const p = resume(a);
  expect(bacaDiagnosisAkhir([p])[0].kutipan).toBe(a.diagnosis);
  expect(bacaDiagnosisAkhir([p]).some(d => d.kutipan.includes('Diijinkan Pulang'))).toBe(false);
  const tindakan = bacaTemuanTindakan([p]).map(t => t.kode_usulan);
  for (const k of a.kode_tindakan) expect(tindakan).toContain(k);
});

test('Acuan C: E86.0 dibakukan ke E86 walau database offline; tidak ada ReferenceError record', async () => {
  const codes = await annotateKamusValid([s('E86.0', 'Obs Vomitus dengan dehidrasi sedang')]);
  expect(codes[0]).toMatchObject({ code: 'E86', kode_asal: 'E86.0', kamus_valid: true });
  const valid = jagaSumberDiagnosis(codes, [resume(acuan[2])]);
  expect(kodeFinal({}, { suggested_codes: valid }).dx).toEqual(['E86']);
});

test('kode tanpa padanan disimpan untuk koder, tidak masuk kode final atau severity', async () => {
  const codes = await annotateKamusValid([s('Z99.999', 'pneumonia')]);
  expect(codes[0]).toMatchObject({ belum_who: true, boleh_isi_otomatis: false });
  expect(kodeFinal({}, { suggested_codes: codes }).dx).toEqual([]);
});

test('saran koding menampilkan alasan penahanan diagnosis, bukan menyebut semua kasus sebagai anamnesis', () => {
  const { susunSaranKoding } = require('../../services/saranKodingService');
  const ai = { suggested_codes: [{ ...s('D21.3', 'Tumor regio sternum'), boleh_isi_otomatis: false, alasan_tahan: 'Sifat neoplasma belum jelas; konfirmasi dokter.' }] };
  const hasil = susunSaranKoding({}, ai, hitungInacbgDanTarif);
  expect(hasil.diagnosis).toEqual([]);
  expect(hasil.tidak_dipakai[0].alasan).toBe('Sifat neoplasma belum jelas; konfirmasi dokter.');
});

test('Acuan G: PA tidak mengganti diagnosis dokter; dua prosedur masuk saat daftar kosong', () => {
  const pages = [resume(acuan[6]), pa];
  const suggestions = jagaSumberDiagnosis([s('I84.8', acuan[6].diagnosis), { ...s('K62.0', 'fibroepithelial polyp', 16), sumber_aturan: 'agen_tinjau' }], pages);
  const ai = { suggested_codes: suggestions, temuan_tindakan: bacaTemuanTindakan(pages) };
  expect(kodeFinal({}, ai)).toEqual({ dx: ['I84.8'], px: ['49.45', '49.46'] });
  const dasar = susunDasarDiagnosis(pages);
  expect(dasar.patologi[0]).toMatchObject({ kategori: 'peradangan', kesimpulan: expect.stringContaining('chronic suppurative inflammation') });
  const usulan = terapkanUsulan([s('I84.8', acuan[6].diagnosis)], [{ kode: 'K62.0', jenis: 'diagnosis', halaman: 16, kutipan: 'fibroepithelial polyp', mengganti: 'I84.8' }], pages);
  expect(usulan.diterima).toEqual([]);
  expect(usulan.saran.map(s => s.code)).toEqual(['I84.8']);
});

test('hasil penunjang positif sekalipun tidak menciptakan diagnosis akhir baru', () => {
  const p = { page_number: 7, ocr_text: 'HASIL PEMERIKSAAN RADIOLOGI\nKesan Dokter : Cardiomegali' };
  const r = jagaSumberDiagnosis([s('I51.7', 'Cardiomegali', 7)], [resume(acuan[5]), p]);
  expect(r[0].boleh_isi_otomatis).toBe(false);
});

test('catatan klinis tanpa judul tetap mengenali assessment dokter, bukan anamnesis', () => {
  const p = { page_number: 2, ocr_text: 'Anamnesis: nyeri ulu hati\nO Pemeriksaan Fisik: abdomen supel\nA Diagnosa kolik abdomen\nTindakan: observasi' };
  expect(bacaDiagnosisAkhir([p])).toEqual([{ peran: 'utama', page_number: 2, kutipan: 'kolik abdomen' }]);
  const r = jagaSumberDiagnosis([s('R10.4', 'A Diagnosa kolik abdomen', 2), s('K29.7', 'nyeri ulu hati', 2)], [p]);
  expect(r[0].diagnosis_akhir_terverifikasi).toBe(true);
  expect(r[1].boleh_isi_otomatis).toBe(false);
});

test('label diagnosis di formulir penunjang atau teks tanpa pemeriksaan dokter tetap ditahan', () => {
  for (const teks of ['Diagnosis: Pneumonia', 'HASIL PEMERIKSAAN LABORATORIUM\nAnamnesis: batuk\nPemeriksaan Fisik: sesak\nDiagnosis: Pneumonia']) {
    expect(bacaDiagnosisAkhir([{ page_number: 1, ocr_text: teks }])).toEqual([]);
  }
});

test.each([
  ['Tidak didapatkan tanda ganas', 'Jaringan dalam batas normal', 'normal'],
  ['Tidak ditemukan sel ganas', 'Chronic suppurative inflammation', 'peradangan'],
  ['No evidence of malignancy', 'Chronic inflammation', 'peradangan'],
  ['No signs of malignancy', 'Fibroepithelial polyp', 'tidak_ganas'],
  ['Tidak ditemukan tanda-tanda keganasan', 'Jaringan dalam batas normal', 'normal'],
  ['Tidak ada bukti adanya keganasan', 'Chronic inflammation', 'peradangan'],
  ['Carcinoma: not identified', 'Jaringan dalam batas normal', 'normal'],
  ['Tidak ditemukan metastasis', 'Chronic inflammation', 'peradangan'],
  ['Sifat Keganasan : Tidak didapatkan tanda ganas', 'Chronic inflammation', 'peradangan'],
  ['Sifat Keganasan : Ganas', 'Squamous cell carcinoma', 'ganas'],
  ['Tidak ganas', 'Lipoma', 'neoplasma_jinak'],
  ['Ganas', 'Squamous cell carcinoma', 'ganas'],
  ['Tidak ganas', 'Keloid DD dermatofibroma', 'belum_pasti'],
])('patologi: %s / %s dibaca sebagai %s', (sifat, kesimpulan, kategori) => {
  expect(klasifikasiPatologi({ sifat, kesimpulan })).toBe(kategori);
});

test('lokasi mamma dan hasil negatif keganasan tidak otomatis menjadi D24', () => {
  const p = { page_number: 10, ocr_text: 'JAWABAN PEMERIKSAAN HISTOPATOLOGI\nBahan : Mamma\nSifat Keganasan : Tidak didapatkan tanda ganas\nKesimpulan : Chronic inflammation' };
  const a = { diagnosis: 'Massa mamma', sekunder: '1. -', tindakan: '1. -' };
  const hasil = lengkapiKodeNeoplasma([s('R22.2', 'Massa mamma')], [resume(a), p]);
  expect(hasil.saran.map(s => s.code)).not.toContain('D24');
  expect(hasil.perubahan).toEqual([]);
});

test('kode neoplasma tanpa sifat klinis yang ditegakkan ditahan, termasuk asumsi D48 karena PA tidak ada', () => {
  const a = { diagnosis: 'Tumor regio sternum', sekunder: '-', tindakan: '-' };
  const r = jagaSumberDiagnosis([s('D21.3', a.diagnosis), s('D48.1', a.diagnosis)], [resume(a)]);
  expect(r.every(s => s.boleh_isi_otomatis === false)).toBe(true);
});

test.each(['Tumor mamma tidak ganas', 'Tumor mamma tidak ditemukan tanda keganasan', 'Tumor mamma dengan peradangan, tidak ganas', 'Suspek carcinoma mamma'])('diagnosis dokter %s tidak otomatis menjadi kode keganasan', diagnosis => {
  const p = resume({ diagnosis, sekunder: '-', tindakan: '-' });
  for (const sumber_aturan of [undefined, 'koding_neoplasma']) {
    expect(jagaSumberDiagnosis([{ ...s('C50.9', diagnosis), sumber_aturan }], [p])[0].boleh_isi_otomatis).toBe(false);
  }
});

test('diagnosis dokter carcinoma tanpa metastasis tetap menegakkan keganasan primer', () => {
  const diagnosis = 'Carcinoma mamma, tidak ditemukan metastasis';
  const p = resume({ diagnosis, sekunder: '-', tindakan: '-' });
  expect(jagaSumberDiagnosis([s('C50.9', diagnosis)], [p])[0].diagnosis_akhir_terverifikasi).toBe(true);
});

test('Acuan F: nebul + Gram terbaca, syarat memakai diagnosis final yang semula kosong', () => {
  const pages = [resume(acuan[5]), sputum];
  const ai = { suggested_codes: [s('J18.0', acuan[5].diagnosis)], temuan_tindakan: bacaTemuanTindakan(pages), temuan_penunjang: bacaTemuanPenunjang(pages).temuan };
  const final = kodeFinal({}, ai);
  expect(final.px).toEqual(expect.arrayContaining(['93.94', '90.41']));
  const syarat = evaluasiSyaratPenunjang(final.dx, final.px, pages)[0].syarat;
  expect(syarat.find(s => s.nama === 'Pemeriksaan gram sputum')).toMatchObject({ status: 'terpenuhi', page_number: 8 });
  expect(syarat.find(s => s.nama.includes('72 jam')).status).toBe('perlu_cek_manual');
});

test('PROCLIST sudah terisi sebagian: nebul yang terlewat tetap ditampilkan; isian koder dipertahankan', () => {
  const ai = { temuan_tindakan: bacaTemuanTindakan([resume(acuan[5])]) };
  expect(tindakanBelumDikode({ PROCLIST: '87.44;90.59' }, ai)).toContainEqual(expect.objectContaining({ kode: '93.94' }));
  expect(kodeFinal({ PROCLIST: '87.44;90.59' }, ai).px).toEqual(['87.44', '90.59']);
});

test.each(['nebul', 'nebu', 'nebulisasi', 'nebulizer', 'dinebulisasi'])('alias tindakan %s terbaca di resume', kata => {
  const p = resume({ diagnosis: 'bronkopneumonia', sekunder: '-', tindakan: kata });
  expect(bacaTemuanTindakan([p]).map(t => t.kode_usulan)).toContain('93.94');
});

test.each(['rencana nebulisasi', 'belum dinebulisasi', 'nebulisasi ditunda', 'tidak diberikan nebulisasi', 'riwayat nebulisasi'])('rencana/negasi %s tidak diklaim sebagai tindakan', kata => {
  const p = resume({ diagnosis: 'bronkopneumonia', sekunder: '-', tindakan: kata });
  expect(bacaTemuanTindakan([p]).map(t => t.kode_usulan)).not.toContain('93.94');
});

test('discharge: pelaksanaan eksplisit dibaca, rencana/obat pulang tidak dianggap sudah dilakukan', () => {
  const p = { page_number: 12, ocr_text: 'DISCHARGE PLANNING\nTelah dilakukan nebulisasi\nRencana nebulisasi di rumah' };
  expect(bacaTemuanTindakan([p])[0].bukti[0].kutipan).toBe('Telah dilakukan nebulisasi');
});

test('nama obat enema tidak diubah AI menjadi bukti pelaksanaan tindakan', () => {
  const p = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nTindakan/Prosedur : Ligasi dan eksisi hemoroid\nTerapi/pengobatan selama di rumah sakit :\n(4) NESFOL ENEMA\nReaksi Obat: Tidak' };
  const saran = [{ type: 'procedure', code: '96.39', kamus_valid: true, quotation: '(4) NESFOL ENEMA', page_number: 3 }];
  const tindakan = [{ id: 'ai_96.39', kode_usulan: '96.39', bukti: [{ page_number: 3, kutipan: '(4) NESFOL ENEMA', sumber: 'resume_medis' }] }];
  const r = jagaSumberTindakan(saran, tindakan, [p]);
  expect(r.saran[0]).toMatchObject({ boleh_isi_otomatis: false, alasan_tahan: expect.stringContaining('pelaksanaan') });
  expect(r.tindakan[0]).toMatchObject({ kode_usulan: null, kode_perlu_klarifikasi: '96.39' });
  expect(kodeFinal({}, { suggested_codes: r.saran, temuan_tindakan: r.tindakan }).px).toEqual([]);
  const { susunSaranKoding } = require('../../services/saranKodingService');
  expect(susunSaranKoding({}, { suggested_codes: r.saran, temuan_tindakan: r.tindakan }, hitungInacbgDanTarif).tidak_dipakai).toContainEqual(expect.objectContaining({ kode: '96.39', alasan: expect.stringContaining('pelaksanaan') }));
});

test('catatan pelaksanaan terapi/discharge tetap boleh menjadi tindakan; nama obat saja tidak', () => {
  const p = { page_number: 12, ocr_text: 'DISCHARGE PLANNING\nTelah dilakukan nebulisasi\nObat pulang: Ventasal Nebules' };
  const saran = [{ type: 'procedure', code: '93.94', quotation: 'Telah dilakukan nebulisasi', page_number: 12 }];
  expect(jagaSumberTindakan(saran, [], [p]).saran[0].boleh_isi_otomatis).not.toBe(false);
  expect(bacaTemuanTindakan([p]).map(t => t.kode_usulan)).toContain('93.94');
});

test.each(['Rencana dilakukan enema', 'Tidak diberikan enema', 'Belum dilakukan enema'])('catatan %s tidak menjadi bukti pelaksanaan', quotation => {
  const p = { page_number: 3, ocr_text: `RESUME MEDIS RAWAT INAP\nTerapi/pengobatan selama di rumah sakit:\n${quotation}` };
  const saran = [{ type: 'procedure', code: '96.39', quotation, page_number: 3 }];
  expect(jagaSumberTindakan(saran, [], [p]).saran[0].boleh_isi_otomatis).toBe(false);
});

test('kode tindakan yang dipetakan AI tanpa halaman sumber tidak menjadi kode final', () => {
  const r = jagaSumberTindakan([], [{ kode_usulan: '96.39', bukti: [{ page_number: null, kutipan: 'enema', sumber: 'resume_medis' }] }], []);
  expect(kodeFinal({}, { temuan_tindakan: r.tindakan }).px).toEqual([]);
});

test('petunjuk obat tidak membatalkan catatan tindakan yang terpisah', () => {
  const p = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nTindakan/Prosedur: Nebulisasi\nTerapi/pengobatan selama di rumah sakit:\nVentasal Nebules' };
  const t = { kode_usulan: '93.94', bukti: [{ page_number: 3, kutipan: 'Nebulisasi', sumber: 'resume_medis' }, { page_number: 3, kutipan: 'Ventasal Nebules', sumber: 'resume_medis' }] };
  expect(jagaSumberTindakan([], [t], [p]).tindakan[0].kode_usulan).toBe('93.94');
});

test('order sputum dan hasil kosong tidak menyatakan syarat Gram terpenuhi', () => {
  for (const teks of ['Pemeriksaan Penunjang: Sputum Gram', 'Jenis Spesimen : Sputum\nGram Positif :\nGram Negatif :']) {
    const hasil = evaluasiSyaratPenunjang(['J18.0'], [], [{ page_number: 3, ocr_text: teks }]);
    expect(hasil[0].syarat.find(s => s.nama.includes('gram')).status).not.toBe('terpenuhi');
  }
});

test('infiltrat disangkal tidak dianggap hasil radiologi positif', () => {
  expect(cariKataKunci([{ page_number: 7, ocr_text: 'Tidak tampak infiltrat' }], ['infiltrat'])).toBeNull();
});

test('tarif jauh di atas tagihan tidak otomatis membuktikan upcoding', () => {
  const ai = { suggested_codes: [s('J18.0', acuan[5].diagnosis)] };
  const pages = [resume(acuan[5]), { page_number: 17, ocr_text: 'Rincian Biaya\nTotal 1,281,324\nTerbilang' }];
  const temuan = periksaAturan({ record: { jenis_klaim: 'RAWAT_INAP', kelas_rawat: '3' }, ai, pages, hitungInacbgDanTarif });
  expect(temuan.some(t => t.jenis === 'potensi_upcoding')).toBe(false);
});

test('pemeriksa memakai kode/kelompok yang sama dengan hasil utama, tidak menghitung ulang dengan jalur berbeda', async () => {
  const ai = { suggested_codes: [s('K80.2', acuan[2].diagnosis)], kode_final: { dx: ['K80.2'], px: [] }, inacbg_result: { code: 'B-4-14-I' }, tariff_result: { amount: 3436700 } };
  const gateway = { panggilModel: async () => ({ ok: true, hasil: { keberatan: [] } }) };
  const r = await periksaKritis({ record: {}, ai, pages: [resume(acuan[2])], gateway, hitungInacbgDanTarif });
  expect(r.dinilai).toMatchObject({ inacbg: 'B-4-14-I', tarif: 3436700 });
});

function evaluasiSyaratPenunjang(dx,px,pages,opsi={}) { return evaluasiSyaratPenunjangAsli(dx,px,pages,{hospitalCode:'3371084',usia:35,...opsi}); }
