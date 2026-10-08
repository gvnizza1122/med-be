const { bacaDiagnosisAkhir, jagaSumberDiagnosis, klasifikasiPatologi } = require('../../services/dasarDiagnosisService');
const { lengkapiKodeBedah } = require('../../services/kodingBedahService');
const { jagaSumberTindakan, bacaTemuanTindakan } = require('../../services/temuanTindakanService');
const { informasiKelas } = require('../../services/kelasPerawatanService');
const { applyDeterministicFallback } = require('../../services/pdfExtractionPipeline');
const { evaluasiSyaratPenunjang: evaluasiSyaratPenunjangAsli } = require('../../services/syaratPenunjangService');
const { susunSaranKoding } = require('../../services/saranKodingService');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');
const { pulihkanPembacaan } = require('../../services/pemulihanPembacaanService');
const { analisisDenganPemulihan } = require('../../services/pemulihanAnalisisService');
const p = (page_number, ocr_text) => ({ page_number, ocr_text });
const resume = txt => p(3, `RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\n${txt}\nDiagnosis Sekunder :\n1. -\nTindakan/Prosedur :\n1. -`);

test('apendektomi melalui laparotomi tidak menghasilkan eksplorasi tambahan yang mengubah kelompok', () => {
  const pages = [p(3, 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nApendisitis akut\nGravid 5 bulan\nDiagnosis Sekunder :\n1. -\nTindakan/Prosedur :\n1. Laparotomi apendektomi (pararectal)')];
  const px = lengkapiKodeBedah([], pages).saran.map(s => s.code);
  expect(px).toEqual(['47.09']);
  expect(hitungInacbgDanTarif(['K35.8'], px, 'RAWAT_INAP', 3).inacbgResult.code).toBe('K-1-13-I');
  expect(jagaSumberTindakan([{ type: 'procedure', code: '54.11', page_number: 3, quotation: 'Laparotomi apendektomi (pararectal)' }], [], pages).saran[0].boleh_isi_otomatis).toBe(false);
});
test('diagnosis akhir bronchitis menang atas diagnosis awal SPRI, dan kelas hak berbeda dari kamar', () => {
  const pages = [p(1, 'SURAT PERINTAH RAWAT INAP\nDiagnosis : Asma'), resume('Bronkitis akut')];
  expect(bacaDiagnosisAkhir(pages).map(d => d.kutipan).join(' ')).toContain('Bronkitis');
  expect(bacaDiagnosisAkhir(pages).map(d => d.kutipan).join(' ')).not.toContain('Asma');
  const record = applyDeterministicFallback({ KELAS_RAWAT: '1' }, 'Kls.Hak : Kelas 2\nKls.Rawat : Kelas 1', 'RAWAT_INAP', 'acuan.pdf');
  expect(informasiKelas(record)).toMatchObject({ kelas_hak: '2', kelas_ditempati: '1', kelas_tarif: '2', naik_kelas: true, selisih_biaya_pasien: null });
  const saran = susunSaranKoding({ ...record, DIAGLIST: 'J20.9', JENIS_KLAIM: 'RAWAT_INAP' }, {}, hitungInacbgDanTarif);
  expect(saran.inacbg.tarif).toBe(3193100);
  const laporan = require('../../services/agenCasemixService').alternatifKoding({ record: { ...record, JENIS_KLAIM: 'RAWAT_INAP' }, dx: ['J20.9'], px: ['93.94'], hitung: hitungInacbgDanTarif });
  expect(laporan.dasar.tarif).toBe(saran.inacbg.tarif);
});
test('label kelas SEP dalam kolom tetap berpasangan dengan hak dan kamar; blok ambigu tidak ditebak', () => {
  const { bacaKelasSep } = require('../../services/kelasPerawatanService');
  const teks = 'SURAT ELIGIBILITAS PESERTA\nKls.Hak\nKls.Rawat\nPenjamin\n: PEGAWAI PEMERINTAH NON PNS\n: R.Inap\n: -\n: Kelas 2\n: Kelas 1\n*Saya menyetujui BPJS';
  expect(bacaKelasSep(teks)).toEqual({ kelas_hak: '2', kelas_ditempati: '1' });
  expect(bacaKelasSep('Kls.Hak\nKls.Rawat\n: Kelas 2\n: Kelas 1\n: Kelas 3')).toEqual({ kelas_hak: null, kelas_ditempati: null });
});
test('kreatinin tunggal bukan bukti kenaikan AKI; Gram sputum aktual tetap ditemukan', () => {
  const pages = [p(8, 'HASIL LABORATORIUM\nCreatinin 1.35 H 0.7-1.2 mg/dL'), p(12, 'HASIL PEMERIKSAAN GRAM SPUTUM\nGram Negatif : Basil soliter (+)\nGram Positif : Coccus bergerombol (+)')];
  const temuan = evaluasiSyaratPenunjang(['N17.9', 'J18.9'], ['90.59', '90.41'], pages, { pakaiBacaLab: true });
  expect(temuan.find(t => t.kode_diagnosis === 'N17.9').syarat[0]).toMatchObject({ nilai: 1.35, status: 'perlu_cek_manual', memenuhi_ambang: null });
  expect(temuan.find(t => t.kode_diagnosis === 'J18.9').syarat[1].status).toBe('terpenuhi');
});
test('anemia CKD memakai padanan WHO dan tindakan GDS tidak dikode sebagai pemeriksaan fisik', () => {
  expect(require('../../services/kamusKodeService').padananWho('D63.1')).toBe('D63.8');
  const pages = [resume('CKD G5 on HD\nAnemia on CKD')];
  for (const code of ['89.29', '89.39']) expect(jagaSumberTindakan([{ type: 'procedure', code, page_number: 3, quotation: 'cek GDS' }], [], pages).saran[0].boleh_isi_otomatis).toBe(false);
});
test('kode GDS yang ditambahkan sebagai temuan tidak dapat melewati gerbang kode final', () => {
  const pages = [p(16, 'DISCHARGE PLANNING\nmelakukan cek GDS\nmelakukan ekg')];
  const hasil = jagaSumberTindakan([], [
    { id: 'baru', kode_usulan: '89.29', bukti: [{ page_number: 16, sumber: 'resume_medis', kutipan: 'melakukan cek GDS' }] },
    { id: 'ekg', kode_usulan: '89.52', bukti: [{ page_number: 16, sumber: 'resume_medis', kutipan: 'melakukan ekg' }] },
    { id: 'kutipan_palsu', kode_usulan: '54.11', bukti: [{ page_number: 16, sumber: 'resume_medis', kutipan: 'dilakukan laparotomi eksplorasi' }] },
  ], pages);
  expect(require('../../services/konvensiKodingRs').tindakanTerverifikasi({ temuan_tindakan: hasil.tindakan })).toEqual(['89.52']);
  expect(require('../../services/pemeriksaKritisService').kodeFinal({}, { temuan_tindakan: hasil.tindakan }).px).toEqual(['89.52']);
});
test('kode IM anemia dinormalisasi ke WHO untuk saran INA-CBG sekalipun sudah ditandai sah oleh pengusul', async () => {
  const a = await require('../../services/aiReviewService').annotateKamusValid([
    { code: 'D63.1', type: 'diagnosis', kamus_valid: true, quotation: 'Anemia on CKD' },
  ]);
  expect(a[0]).toMatchObject({ code: 'D63.8', kode_asal: 'D63.1', kamus_valid: true });
});
test('catatan pemberian nebulisasi pada halaman lain tidak tertutup oleh resep yang belum membuktikan pelaksanaan', async () => {
  const pages = [p(3, 'RESUME MEDIS RAWAT INAP\nTerapi :\nLasalcom NEBU'), p(10, 'DISCHARGE PLANNING\nmemberikan nebulizer ventasal : budesma 1/2 resp')];
  const ai = { suggested_codes: [{ code: '93.94', type: 'procedure', page_number: 3, quotation: 'Lasalcom NEBU', kamus_valid: true }],
    temuan_tindakan: [{ id: 'nebulisasi', nama: 'Nebulisasi', kode_usulan: '93.94', bukti: [
      { page_number: 3, sumber: 'resume_medis', kutipan: 'Lasalcom NEBU' },
      { page_number: 10, sumber: 'triase_igd', kutipan: 'memberikan nebulizer ventasal : budesma 1/2 resp' },
    ] }] };
  await require('../../services/aiReviewService').periksaKodeAkhir(ai, pages);
  const sah = ai.suggested_codes.filter(s => s.boleh_isi_otomatis !== false);
  expect(sah).toContainEqual(expect.objectContaining({ code: '93.94', page_number: 10 }));
  expect(ai.temuan_tindakan[0].bukti_kode.map(b => b.page_number)).toEqual([10]);
  const panel = susunSaranKoding({ diagnosa_list: 'J20.9', jenis_klaim: 'RAWAT_INAP' }, ai, hitungInacbgDanTarif);
  expect(panel.prosedur.find(p => p.kode === '93.94').bukti.every(b => b.halaman === 10)).toBe(true);
  const negatif = { suggested_codes: [], temuan_tindakan: [{ id: 'nebulisasi', nama: 'Nebulisasi', kode_usulan: '93.94', bukti: [{ page_number: 3, sumber: 'resume_medis', kutipan: 'Lasalcom NEBU' }] }] };
  await require('../../services/aiReviewService').periksaKodeAkhir(negatif, pages);
  expect(negatif.suggested_codes).toEqual([]);
  const rencana = jagaSumberTindakan([], [{ kode_usulan: '93.94', bukti: [{ page_number: 10, sumber: 'triase_igd', kutipan: 'rencana memberikan nebulizer' }] }], [p(10, 'DISCHARGE PLANNING\nrencana memberikan nebulizer')]);
  expect(rencana.tindakan[0].kode_usulan).toBeNull();
});
test('gerbang akhir menyaring pengusul baru sekaligus mempertahankan alasan penolakan awal', async () => {
  const pages = [resume('CKD G5 on HD\nAnemia on CKD'), p(16, 'DISCHARGE PLANNING\nmelakukan cek GDS')];
  const ai = { suggested_codes: [
    { code: 'D63.1', type: 'diagnosis', kamus_valid: true, page_number: 3, quotation: 'Anemia on CKD' },
    { code: '54.11', type: 'procedure', page_number: 16, quotation: 'laparotomi eksplorasi' },
  ], temuan_tindakan: [{ id: 'baru', kode_usulan: '89.29', bukti: [{ page_number: 16, sumber: 'resume_medis', kutipan: 'melakukan cek GDS' }] }],
  pagar_temuan: { ditolak: [{ kode: 'kode_lama', halaman: 3, alasan: 'kutipan_tidak_ada_di_halaman' }] } };
  await require('../../services/aiReviewService').periksaKodeAkhir(ai, pages);
  expect(ai.suggested_codes.map(s => s.code)).toEqual(['D63.8']);
  expect(require('../../services/pemeriksaKritisService').kodeFinal({}, ai)).toEqual({ dx: ['D63.8'], px: [] });
  expect(ai.pagar_temuan.ditolak.map(e => e.kode)).toEqual(expect.arrayContaining(['kode_lama', '54.11']));
});
test('foto manus dari lembar hasil terbaca sebagai foto tangan, tidak berubah menjadi thorax atau MRI', () => {
  const baca = require('../../services/temuanPenunjangService').bacaTemuanPenunjang;
  const radiologi = 'HASIL PEMERIKSAAN RADIOLOGI\nPemeriksaan : Manus\nStruktur dan trabekulasi tulang baik\nTak tampak fraktur';
  expect(baca([p(9, radiologi)]).temuan.some(t => t.kode_usulan === '88.23')).toBe(true);
  expect(baca([p(9, radiologi + '\nMRI manus')]).temuan.some(t => t.kode_usulan === '88.23')).toBe(false);
});
test('hubungan penyakit dengan kehamilan harus tertulis positif, bukan hanya konsul atau penyangkalan', () => {
  const nilai = q => jagaSumberDiagnosis([{ type: 'diagnosis', code: 'O99.6', page_number: 3, quotation: q }], [resume(q)])[0];
  expect(nilai('Apendisitis akut pada kehamilan').boleh_isi_otomatis).not.toBe(false);
  expect(nilai('Apendisitis tidak menyulitkan kehamilan').boleh_isi_otomatis).toBe(false);
  expect(nilai('Gravid 5 bulan, konsul SpOG').boleh_isi_otomatis).toBe(false);
});
test('PA benign inclusion lesion tidak otomatis menjadi neoplasma jaringan lunak', () => {
  const pages = [p(1, 'SURAT PERINTAH RAWAT INAP\nDiagnosis : suspek lipoma'), resume('Tumor regio colli dextra et buccal dextra')];
  expect(bacaDiagnosisAkhir(pages).some(d => /suspek/i.test(d.kutipan))).toBe(false);
  expect(klasifikasiPatologi({ kesimpulan: 'Benign inclusion lesion. Tidak didapatkan tanda ganas.' })).toBe('tidak_ganas');
});
test('urutan diagnosis otomatis mengikuti tinjauan akhir yang didukung tanpa menghapus diagnosis saat belum pasti', () => {
  const urut = require('../../services/tinjauanDiagnosisService').urutkanDiagnosisTerverifikasi;
  const tinjauan = { versi: 1, status: 'ada_saran', kode_rekomendasi: ['R22.1', 'R22.0'], kandidat: ['R22.1', 'R22.0'].map(kode => ({ kode, status: 'didukung' })) };
  expect(urut(['R22.0', 'R22.1'], tinjauan)).toEqual(['R22.1', 'R22.0']);
  expect(urut(['J18.9', 'N17.9'], { ...tinjauan, status: 'perlu_klarifikasi', kode_rekomendasi: ['J18.9'] })).toEqual(['J18.9', 'N17.9']);
});
test('luka jari tanpa rincian kuku tidak membuktikan kode with damage to nail', () => {
  const pages = [resume('open wound dig 3 manus dx')];
  expect(jagaSumberDiagnosis([{ type: 'diagnosis', code: 'S61.1', page_number: 3, quotation: 'open wound dig 3 manus dx' }], pages)[0]).toMatchObject({ boleh_isi_otomatis: false });
});
test('kateter terapeutik terdokumentasi terbaca walaupun tidak dikode pada kasus casemix lain', () => {
  const pages = [p(3, 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama : Retensi urin\nTindakan/Prosedur :\n1. pemasangan DC\nAnjuran : kontrol')];
  expect(bacaTemuanTindakan(pages).some(t => t.kode_usulan === '57.94')).toBe(true);
  const s = susunSaranKoding({ DIAGLIST: 'R33', JENIS_KLAIM: 'RAWAT_INAP', KELAS_RAWAT: 3 }, { temuan_tindakan: bacaTemuanTindakan(pages) }, hitungInacbgDanTarif);
  expect(s.prosedur.some(t => t.kode === '57.94')).toBe(true);
});
test('lembar casemix mengubah pembandingan, tidak mengubah diagnosis/prosedur/kelompok/tarif saran', () => {
  const record = { diagnosa_list: 'K35.8', prosedur_list: '47.09', jenis_klaim: 'RAWAT_INAP', kelas_rawat: 3 };
  const tanpa = susunSaranKoding(record, {}, hitungInacbgDanTarif);
  const dengan = susunSaranKoding(record, { lembar_grouper: { diagnosis: [{ kode: 'O99.6' }], prosedur: [{ kode: '54.11' }], inacbg: { kode: 'K-1-40-III', tarif: 99999999 } } }, hitungInacbgDanTarif);
  for (const key of ['diagnosis', 'prosedur', 'inacbg']) expect(dengan[key]).toEqual(tanpa[key]);
  expect(dengan.casemix.alasan_perbedaan.length).toBeGreaterThan(0);
  expect(tanpa.klaim_saat_ini.tarif).toBeNull();
});
test('riwayat casemix tidak dikirim ke analisis baru', async () => {
  const db = { all: jest.fn(), exec: jest.fn(), prepare: jest.fn() };
  const pelajaran = require('../../services/pembelajaranCasemixService');
  expect(await pelajaran.cariPola(db, [resume('Apendisitis akut')], 'kasus')).toEqual([]);
  expect(await pelajaran.cariPenunjangDipelajari(db, [], 'kasus')).toEqual([]);
  expect(await require('../../services/keputusanCasemixService').pelajaranRelevan(db, { dx: ['K35.8'] })).toEqual([]);
  expect(db.all).not.toHaveBeenCalled();
});
test('halaman gagal dipulihkan satu kali sebelum analisis, halaman baik tetap tersimpan', async () => {
  const baca = jest.fn().mockResolvedValue({ success: true, pages: [{ page_number: 7, text: 'hasil pemeriksaan' }] });
  const hasil = await pulihkanPembacaan({ success: true, pages: [{ page_number: 3, text: 'resume' }], errors: [{ page_number: 7 }], skipped_pages: [{ page_number: 2, reason: 'sep_page_native_text_available' }] }, baca);
  expect(baca).toHaveBeenCalledTimes(1); expect(baca).toHaveBeenCalledWith([7]);
  expect(hasil.pages.map(p => p.page_number)).toEqual([3, 7]);
  expect(hasil.pemulihan_otomatis.belum_terbaca).toEqual([]);
});
test('pemulihan analisis hanya untuk gangguan tahapan, bukan klarifikasi klinis', async () => {
  const baca = jest.fn().mockResolvedValueOnce({ tinjauan_diagnosis: { status: 'belum_dinilai' } }).mockResolvedValueOnce({ tinjauan_diagnosis: { status: 'ada_saran' } });
  expect((await analisisDenganPemulihan(baca)).pemulihan_analisis.berhasil).toBe(true); expect(baca).toHaveBeenCalledTimes(2);
  const klinis = jest.fn().mockResolvedValue({ tinjauan_diagnosis: { status: 'perlu_klarifikasi' } });
  await analisisDenganPemulihan(klinis); expect(klinis).toHaveBeenCalledTimes(1);
});
test('antibiotik 72 jam perlu periode pemberian IV, bukan lama rawat atau resep', () => {
  const baca = require('../../services/pemberianAntibiotikService').bacaPemberianAntibiotik;
  expect(baca([p(3, 'RESUME MEDIS RAWAT INAP\nDiberikan ceftriaxone IV mulai 01/07/2026 08:00 sampai 04/07/2026 08:00')]).durasi_jam).toBe(72);
  expect(baca([p(3, 'RESUME MEDIS RAWAT INAP\nRencana diberikan ceftriaxone IV mulai 01/07/2026 08:00 sampai 04/07/2026 08:00')])).toBeNull();
  expect(baca([p(3, 'RESUME MEDIS RAWAT INAP\nCeftriaxone 1gr INJEKSI\nLama rawat 4 hari')])).toBeNull();
});
test('panel penunjang dan syarat diagnosis sepakat bahwa hasil Gram sputum terbaca', () => {
  const pages = [p(12, 'HASIL PEMERIKSAAN GRAM SPUTUM\nGram Negatif : Basil soliter (+)\nGram Positif : Coccus bergerombol (+)')];
  const panel = require('../../services/pemeriksaanPenunjangService').susunPemeriksaanPenunjang(pages);
  expect(panel.pemeriksaan.find(p => p.id === 'gram_sputum')).toMatchObject({ ada_hasil: true });
});
test('CTG pada tagihan tidak menjadi bukti hasil atau kode otomatis; rekaman FHR berbeda dari fetal EKG scalp', () => {
  const baca = require('../../services/temuanPenunjangService').bacaTemuanPenunjang;
  const panel = require('../../services/pemeriksaanPenunjangService').susunPemeriksaanPenunjang;
  const tagihan = [p(14, 'RINCIAN BIAYA\nCTG 150,000 1.00 150,000')];
  const ai = { temuan_penunjang: baca(tagihan).temuan };
  expect(require('../../services/konvensiKodingRs').penunjangBerhasil(ai)).toEqual([]);
  const saran = susunSaranKoding({ diagnosa_list: 'K35.8', prosedur_list: '47.09', jenis_klaim: 'RAWAT_INAP', kelas_rawat: 3 }, {
    ...ai, lembar_grouper: { diagnosis: [{ kode: 'K35.8' }], prosedur: [{ kode: '47.09' }, { kode: '75.32' }], inacbg: { kode: 'K-1-13-I', tarif: 3167600 } },
  }, hitungInacbgDanTarif);
  expect(saran.prosedur.map(p => p.kode)).toEqual(['47.09']);
  expect(saran.casemix.prosedur.hanya_ai).toEqual([]);
  expect(saran.casemix.prosedur.hanya_casemix).toEqual(['75.32']);
  expect(saran.tidak_dipakai).toContainEqual(expect.objectContaining({ kode: '75.34' }));
  expect(panel(tagihan).pemeriksaan.find(p => p.id === 'ctg').ada_hasil).toBe(false);
  const rekaman = [p(7, 'RM.46\nFHR 140 bpm MEDI-GRAPH')];
  expect(require('../../services/konvensiKodingRs').penunjangBerhasil({ temuan_penunjang: baca(rekaman).temuan })).toEqual(['75.34']);
});
test('pemeriksa kritis menerima hasil mikrobiologi dan tidak meminta mengganti padanan WHO kembali menjadi IM', async () => {
  const pages = [resume('CKD G5 on HD\nAnemia on CKD'), p(12, 'HASIL PEMERIKSAAN GRAM SPUTUM\nGram Negatif : Basil soliter (+)')];
  const gateway = { panggilModel: jest.fn(async () => ({ ok:true, hasil: { kesimpulan:'periksa', keberatan:[{jenis:'kode_tidak_didukung',keparahan:'sedang',pesan:'D63.8 salah',saran:'Koreksi kode anemia menjadi D63.1',halaman:3,kutipan:'Anemia on CKD'}] } })) };
  const ai = { suggested_codes:[{code:'N18.5',type:'diagnosis',kamus_valid:true},{code:'D63.8',type:'diagnosis',kamus_valid:true}], temuan_penunjang:require('../../services/temuanPenunjangService').bacaTemuanPenunjang(pages).temuan };
  const hasil = await require('../../services/pemeriksaKritisService').periksaKritis({record:{jenis_klaim:'RAWAT_INAP',kelas_rawat:3},ai,pages,hitungInacbgDanTarif,gateway});
  expect(gateway.panggilModel.mock.calls[0][1].prompt).toContain('Basil soliter (+)');
  expect(hasil.temuan.some(t=>t.pesan==='D63.8 salah')).toBe(false);
  expect(hasil.keberatan_dibantah_bukti).toContainEqual(expect.objectContaining({kode:'D63.1',padanan_who:'D63.8'}));
});
test('hasil Gram sampai ke fakta penalaran; urine mikroskopis dibaca berdasarkan hasil, bukan lembar kosong', () => {
  const pages = [p(12, 'HASIL PEMERIKSAAN GRAM SPUTUM\nGram Negatif : Basil soliter (+)\nGram Positif : Coccus gerombol (+)'),
    p(7, 'HASIL PEMERIKSAAN LABORATORIUM\nURINE RUTIN\nMIKROSKOPIS\nEritrosit 40 - 45 <10:Negatif Ery/uL Microscopic\nBakteri + 1 Negatif Microscopic'),
    p(9, 'HASIL PEMERIKSAAN LABORATORIUM\nNo.Periksa : 1\nDiagnosa Klinis :\nMengetahui dokter')];
  const fakta = require('../../services/faktaKlinisService').susunFaktaKlinis(pages);
  expect(require('../../services/faktaKlinisService').faktaUntukPrompt(fakta)).toContain('Basil soliter (+)');
  const temuan = require('../../services/temuanPenunjangService').bacaTemuanPenunjang(pages).temuan;
  expect(temuan.filter(t=>t.kode_usulan==='91.39').map(t=>t.page_number)).toEqual([7]);
});

function evaluasiSyaratPenunjang(dx,px,pages,opsi={}) { return evaluasiSyaratPenunjangAsli(dx,px,pages,{hospitalCode:'3371084',usia:35,...opsi}); }
