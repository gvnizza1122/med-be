/**
 * BA 2019 (aspek medis 64-69), BA koding 2023 dan kriteria PNPK dari Katalog
 * Pedoman sebagai persyaratan valid/pending, tanpa kartu/alasan ganda.
 * Fixture anonim.
 */
const kriteria = require('../../data/kriteriaPnpk.json');
const katalogPedoman = require('../../data/katalogPedoman.json');
const { DETEKTOR } = require('../../services/baKesepakatan2018Service');
const { evaluasiReferensiKlaim } = require('../../services/referensiKlaimService');
const { evaluasiKombinasiKode } = require('../../services/ketentuanKlaimService');
const { susunPutusan } = require('../../services/putusanPendingService');
const { berlakuPadaEpisode } = require('../../services/katalogPedomanService');

const rec = (o = {}) => ({ jenis_klaim: 'RAWAT_INAP', admission_date: '2026-10-01', discharge_date: '2026-10-05', hospital_code: '9999999', umur_tahun: 45, gender: '2', ...o });
const anak = (o = {}) => rec({ umur_tahun: 5, birth_date: '2021-06-01', ...o });
const hal = (n, t) => ({ page_number: n, ocr_text: t });
const resume = (...b) => hal(3, `RESUME MEDIS RAWAT INAP\n${b.join('\n')}`);
const lab = (...b) => hal(2, `HASIL LABORATORIUM\nTanggal 01-10-2026\n${b.join('\n')}`);
const temuan = (r, p) => evaluasiReferensiKlaim(r, p).temuan;
const cari = (t, id) => t.find(x => x.id === id) || t.flatMap(x => x.rujukan_ba_2018 || []).find(b => b.id === id);
const alasan = t => susunPutusan({ referensi_klaim: { temuan: t } }).alasan.filter(a => ['PNPK Kemenkes', 'BA kesepakatan Kemenkes-BPJS'].includes(a.sumber_pemeriksaan));

describe('katalog kriteria PNPK', () => {
  test('setiap aturan menunjuk dokumen katalog dan detektor yang ada', () => {
    for (const a of kriteria.aturan) {
      expect(katalogPedoman.dokumen.some(d => d.id === a.katalog_id)).toBe(true);
      for (const k of (a.kriteria || []).flat()) expect(DETEKTOR[k]).toBeDefined();
    }
  });
  test('versi PNPK mengikuti tanggal awal episode', () => {
    expect(berlakuPadaEpisode('KMK-2024-2009', '2024-06-01')).toBe(false);
    expect(berlakuPadaEpisode('KMK-2024-2009', '2026-10-01')).toBe(true);
    expect(berlakuPadaEpisode('KMK-2023-2147', '2026-10-01')).toBe(false); // diganti 1168/2025
    expect(berlakuPadaEpisode('KMK-2024-2009', null)).toBeNull();
    const dm = { diagnosa_list: 'E10.9' }, p = [resume('Diagnosis Utama : DM tipe 1')];
    expect(cari(temuan(anak({ ...dm, admission_date: '2024-06-01' }), p), 'PNPK-DM-ANAK-01')).toBeUndefined();
    expect(cari(temuan(anak(dm), p), 'PNPK-DM-ANAK-01')).toBeDefined();
  });
});

describe('PNPK anak', () => {
  test('sepsis anak: PELOD-2 terbaca <10 bertentangan (tinggi, tidak wajib), >=10 memenuhi; digabung ke TK-25-09', () => {
    const r = anak({ diagnosa_list: 'A41.9;J18.9' });
    const rendah = temuan(r, [resume('Fokus infeksi: pneumonia', 'PELOD-2: 6', 'Diagnosis Utama : sepsis')]);
    expect(rendah.some(t => t.id === 'PNPK-SEPSIS-ANAK-01')).toBe(false);
    expect(rendah.find(t => t.id === 'TK-25-09').rujukan_ba_2018.map(b => b.id)).toContain('PNPK-SEPSIS-ANAK-01');
    expect(alasan(rendah)[0]).toMatchObject({ kode: 'PNPK-SEPSIS-ANAK-01', keparahan: 'tinggi', wajib_pending: false, sumber_pemeriksaan: 'PNPK Kemenkes' });
    expect(cari(temuan(r, [resume('Fokus infeksi: pneumonia', 'Skor PELOD-2 = 11', 'Diagnosis Utama : sepsis')]), 'PNPK-SEPSIS-ANAK-01').status).toBe('bukti_ditemukan');
    expect(cari(temuan(rec({ diagnosa_list: 'A41.9' }), [resume('SOFA 4')]), 'PNPK-SEPSIS-ANAK-01')).toBeUndefined(); // dewasa
  });
  test('epilepsi anak: kejang pertama/terprovokasi tidak memenuhi; kejang berulang dengan OAE memenuhi', () => {
    const r = anak({ diagnosa_list: 'G40.9' });
    expect(cari(temuan(r, [resume('Kejang pertama kali, tanpa demam', 'Diagnosis Utama : epilepsi')]), 'PNPK-EPILEPSI-ANAK-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(r, [resume('Riwayat kejang berulang tanpa demam, rutin asam valproat', 'Diagnosis Utama : epilepsi')]), 'PNPK-EPILEPSI-ANAK-01').status).toBe('bukti_ditemukan');
  });
  test('DM anak: GDS >=200 perlu gejala klasik; GDP >=126 cukup', () => {
    const r = anak({ umur_tahun: 10, birth_date: '2016-01-01', diagnosa_list: 'E10.9' });
    expect(cari(temuan(r, [lab('GDS 260 mg/dL 70-140'), resume('Diagnosis Utama : DM')]), 'PNPK-DM-ANAK-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(r, [lab('GDS 260 mg/dL 70-140'), resume('Keluhan: poliuria, polidipsia', 'Diagnosis Utama : DM')]), 'PNPK-DM-ANAK-01').status).toBe('bukti_ditemukan');
    expect(cari(temuan(r, [lab('Gula darah puasa 140 mg/dL 70-100'), resume('Diagnosis Utama : DM')]), 'PNPK-DM-ANAK-01').status).toBe('bukti_ditemukan');
  });
  test('TB anak: TCM "not detected" bukan konfirmasi; skor >=6 memenuhi', () => {
    const r = anak({ diagnosa_list: 'A16.2' });
    expect(cari(temuan(r, [resume('TCM: MTB not detected', 'Skor TB 4')]), 'PNPK-TB-ANAK-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(r, [resume('TCM: MTB not detected', 'Skoring TB anak: 7')]), 'PNPK-TB-ANAK-01').status).toBe('bukti_ditemukan');
  });
  test('hiperbilirubinemia: keputusan fototerapi butuh TSB (bukan Kramer saja), digabung ke TK-25-06', () => {
    const r = rec({ umur_tahun: 0, umur_hari: 4, diagnosa_list: 'P59.9', prosedur_list: '99.83' });
    const kramer = temuan(r, [resume('Ikterik Kramer III', 'Fototerapi 2x24 jam')]);
    expect(kramer.find(t => t.id === 'TK-25-06').rujukan_ba_2018.find(b => b.id === 'PNPK-HIPERBILIRUBINEMIA-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(r, [lab('Bilirubin total 17.2 mg/dL 0-12'), resume('Fototerapi')]), 'PNPK-HIPERBILIRUBINEMIA-01').status).toBe('bukti_ditemukan');
  });
});

describe('BA 2019 dan BA 2023', () => {
  test('gagal jantung tanpa ekokardiografi ditelaah; dengan hasil ekokardiografi memenuhi', () => {
    expect(alasan(temuan(rec({ diagnosa_list: 'I50.0' }), [resume('Diagnosis Utama : CHF')])).map(a => a.kode)).toEqual(['BA-19-M64']);
    expect(cari(temuan(rec({ diagnosa_list: 'I50.0' }), [resume('Ekokardiografi: EF 35%, dilatasi LV')]), 'BA-19-M64').status).toBe('bukti_ditemukan');
  });
  test('PPOK di RS dengan catatan BDD-06: satu kartu dan satu alasan', () => {
    const t = temuan(rec({ hospital_code: '3371084', diagnosa_list: 'J44.1' }), [resume('Diagnosis Utama : PPOK eksaserbasi')]);
    expect(t.some(x => x.id === 'BA-19-M65')).toBe(false);
    const a = susunPutusan({ referensi_klaim: { temuan: t } }).alasan.filter(x => ['BDD-06', 'BA-19-M65'].includes(x.kode));
    expect(a).toHaveLength(1);
  });
  test('asfiksia berat P21.0: Apgar menit pertama >3 bertentangan (tinggi) dan menggantikan telaah TKMKB yang lebih ringan', () => {
    const r = rec({ umur_tahun: 0, umur_hari: 1, diagnosa_list: 'P21.0' });
    const p = susunPutusan({ referensi_klaim: { temuan: temuan(r, [resume('Apgar score 5/7/8', 'Diagnosis Utama : asfiksia berat')]) } });
    expect(p.status).toBe('berisiko_pending');
    expect(p.alasan.filter(a => ['TK-25-07', 'BA-23-K34'].includes(a.kode)).map(a => a.kode)).toEqual(['BA-23-K34']);
    expect(cari(temuan(r, [resume('AS 2-5-7')]), 'BA-23-K34').status).toBe('bukti_ditemukan');
  });
  test('kombinasi koding BA 2023: aturan pasti tinggi, aturan telaah sedang, syarat prosedur dan urutan dihormati', () => {
    expect(evaluasiKombinasiKode('K35.2;K63.1')[0]).toMatchObject({ kode: 'KMB-13', keparahan: 'tinggi' });
    expect(evaluasiKombinasiKode('N20.0;N39.0')[0].kode).toBe('KMB-04'); // diperluas, bukan aturan kembar
    expect(evaluasiKombinasiKode('N13.6;N23').map(k => k.kode)).toEqual(['KMB-16']);
    expect(evaluasiKombinasiKode('O80.0;R57.1;Z37.0')[0]).toMatchObject({ kode: 'KMB-22', aksi: 'telaah', keparahan: 'sedang', kode_saran: 'O75.1' });
    expect(evaluasiKombinasiKode('Z37.0;O34.2', { px: '73.59' })[0].kode).toBe('KMB-26');
    expect(evaluasiKombinasiKode('Z37.0;O34.2', { px: '74.1' })).toEqual([]);
    expect(evaluasiKombinasiKode('Z37.0;O34.2')).toEqual([]); // prosedur tidak diberikan: tidak dinilai
    expect(evaluasiKombinasiKode('P03.4;P59.9')[0].kode).toBe('KMB-25');
    expect(evaluasiKombinasiKode('P59.9;P03.4')).toEqual([]);
  });
});

// Regresi "analisis kurang": data yang terbaca harus dinilai tegas, bukan jatuh ke cek manual.
describe('tidak ada analisis kurang bila data terbaca', () => {
  const urin = s => hal(2, `HASIL PEMERIKSAAN LABORATORIUM\nURINE RUTIN\n${s}`);
  test('ISK: Leu/uL dibandingkan nilai rujukan pada baris yang sama; sedimen normal tanpa kultur = tinggi', () => {
    const r = rec({ diagnosa_list: 'N39.0' });
    const normal = temuan(r, [urin('MIKROSKOPIS\nLekosit 5 - 7 * < 15:Negatif Leu/uL Microscopic'), resume('Keluhan: disuria', 'Diagnosis Utama : ISK')]);
    expect(cari(normal, 'PNPK-ISK-01').status).toBe('bukti_belum_cukup');
    const p = susunPutusan({ referensi_klaim: { temuan: normal } });
    expect(p.status).toBe('berisiko_pending');
    expect(p.alasan.filter(a => ['BA-18-M37', 'PNPK-ISK-01'].includes(a.kode))).toHaveLength(1);
    const tinggi = temuan(r, [urin('Lekosit 40 Leu/uL 0-25'), resume('Keluhan: disuria', 'Diagnosis Utama : ISK')]);
    expect(cari(tinggi, 'PNPK-ISK-01').status).toBe('bukti_ditemukan');
    expect(cari(tinggi, 'BA-18-M37').status).toBe('bukti_ditemukan');
  });
  test('gejala ISK terbaca walau ejaan OCR berbeda atau terpotong di akhir baris; temuan pendukung disebut di alasan', () => {
    const t = temuan(rec({ diagnosa_list: 'N39.0' }), [urin('Lekosit +1 * Negatif Leu/ul CC\nMIKROSKOPIS\nLekosit 5 - 7 * < 15:Negatif Leu/uL Microscopic\nBakteri +2 * Negatif Microscopic'),
      resume('Keluhan: nyeri pinggang kanan, mual muntah, BAK anyang-', 'anyangen. Sudah berobat masih nyeri'), hal(5, 'HASIL USG\nKesan Dokter Gambaran cystitis')]);
    const isk = cari(t, 'PNPK-ISK-01');
    expect(isk.bukti.find(b => b.id === 'gejala_isk').status).toBe('bukti_ditemukan');
    const a = susunPutusan({ referensi_klaim: { temuan: t } }).alasan.find(x => ['BA-18-M37', 'PNPK-ISK-01'].includes(x.kode));
    expect(a.keparahan).toBe('tinggi');
    expect(a.penjelasan).toMatch(/dipstick tertulis \+1/);
    expect(a.penjelasan).toMatch(/Temuan pendukung yang tertulis: .*cystitis/);
    expect(a.penjelasan).not.toMatch(/Belum terlihat: Gejala ISK/);
  });
  test('butir BA 2018 bawaan dinilai dengan kriteria, bukan selalu cek manual', () => {
    const pn = temuan(rec({ diagnosa_list: 'J18.9' }), [hal(4, 'HASIL RADIOLOGI\nThorax: tampak infiltrat di parahiler kanan\nKesan: pneumonia'),
      resume('Keluhan: batuk bertambah, demam', 'Pemeriksaan: ronki +/+')]);
    expect(cari(pn, 'BA-18-M03').status).toBe('bukti_ditemukan');
    expect(cari(temuan(rec({ diagnosa_list: 'J18.9' }), [resume('Diagnosis Utama : pneumonia')]), 'BA-18-M03').status).toBe('bukti_belum_cukup');
    const kd = anak({ diagnosa_list: 'R56.0;J06.9' });
    expect(cari(temuan(kd, [resume('Kejang demam', 'Terapi: diazepam iv 5 mg')]), 'BA-18-M61').status).toBe('bukti_ditemukan');
    expect(cari(temuan(anak({ diagnosa_list: 'R56.0;G03.9' }), [resume('Kejang demam')]), 'BA-18-M61').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(anak({ diagnosa_list: 'J06.9;R56.0' }), [resume('Kejang demam')]), 'BA-18-M61')).toBeUndefined(); // bukan DU
    const sp = temuan(rec({ diagnosa_list: 'A41.9' }), [resume('Suhu 39,2 C', 'Nadi 118 x/mnt', 'RR 26 x/mnt'), hal(5, 'HASIL LABORATORIUM\nKultur darah: tumbuh E. coli')]);
    expect(cari(sp, 'BA-18-M43').status).toBe('bukti_ditemukan');
  });
  test('pneumonia anak: tabel vital dengan baris label di antara judul dan nilai tetap terbaca; SpO2 tidak tercatat = belum terlihat', () => {
    const t = temuan(anak({ diagnosa_list: 'J18.9', birth_date: '2025-06-01', umur_tahun: 1 }), [hal(6, 'BB TB TD Heart Rate RR Temp\nVITAL SIGN\n9.5 kg 123 x/mnt 24 x/mnt 40.1°C'), resume('Diagnosis Utama : bronkopneumonia')]);
    const rk19 = t.find(x => x.id === 'RK-19');
    expect(rk19.penilaian_pneumonia.rr_tertinggi.nilai).toBe(24);
    expect(rk19.status).not.toBe('belum_dapat_dinilai');
    expect(rk19.bukti.every(b => b.status !== 'perlu_cek_manual')).toBe(true);
  });
});

describe('BA 2019 aspek koding', () => {
  test('pneumonia + PPOK eksaserbasi (J44.1) dikode terpisah; pneumonia + PPOK lain digabung J44.0', () => {
    expect(evaluasiKombinasiKode('J18.9;J44.1')).toEqual([]);
    expect(evaluasiKombinasiKode('J18.9;J44.9')[0]).toMatchObject({ kode: 'KMB-12', kode_gabungan: 'J44.0' });
  });
  test('kode pelengkap wajib dan dua subkode sejenis', () => {
    expect(evaluasiKombinasiKode('O80.0')[0]).toMatchObject({ kode: 'KMB-51', aksi: 'telaah', kode_saran: 'Z37.-' });
    expect(evaluasiKombinasiKode('O80.0;Z37.0')).toEqual([]);
    expect(evaluasiKombinasiKode('B20.0;B20.1')[0]).toMatchObject({ kode: 'KMB-31', kode_gabungan: 'B20.7' });
    expect(evaluasiKombinasiKode('B20.0')).toEqual([]);
  });
  test('gejala/kode tercakup dibuang; kombinasi yang perlu konteks hanya ditelaah', () => {
    expect(evaluasiKombinasiKode('A16.2;J18.9')[0]).toMatchObject({ kode: 'KMB-29', aksi: 'buang_pasangan', keparahan: 'tinggi' });
    expect(evaluasiKombinasiKode('I10;I50.0')[0]).toMatchObject({ kode: 'KMB-40', aksi: 'telaah', keparahan: 'sedang' });
    expect(evaluasiKombinasiKode('N17.9;I10')).toEqual([]); // BA 2019 butir 60: GGA tidak digabung ke I12
  });
  test('J40 pada anak <15 tahun dikode J20', () => {
    expect(cari(temuan(anak({ diagnosa_list: 'J40' }), [resume('Diagnosis Utama : bronkitis')]), 'BA-19-K87')).toMatchObject({ status: 'bukti_belum_cukup' });
    expect(cari(temuan(rec({ diagnosa_list: 'J40' }), [resume('Diagnosis Utama : bronkitis')]), 'BA-19-K87')).toBeUndefined();
  });
});

describe('PNPK batch 2', () => {
  const bayi = (o = {}) => rec({ umur_tahun: 0, umur_hari: 2, ...o });
  test('BBLR: berat lahir dan usia gestasi dicocokkan dengan kode P07', () => {
    expect(cari(temuan(bayi({ diagnosa_list: 'P07.1;P07.3' }), [resume('BB lahir 2100 gram', 'Usia gestasi 34 minggu')]), 'PNPK-BBLR-01').status).toBe('bukti_ditemukan');
    const salah = cari(temuan(bayi({ diagnosa_list: 'P07.1' }), [resume('BBL : 2.650 gr')]), 'PNPK-BBLR-01');
    expect(salah).toMatchObject({ status: 'bukti_belum_cukup', kontradiksi_angka: true });
    expect(cari(temuan(bayi({ diagnosa_list: 'P07.1' }), [resume('Berat lahir 850 gram')]), 'PNPK-BBLR-01').bukti[0].catatan).toMatch(/P07\.0/);
    expect(cari(temuan(bayi({ diagnosa_list: 'P07.3' }), [resume('UK 38 minggu')]), 'PNPK-BBLR-01').kontradiksi_angka).toBe(true);
  });
  test('DM tipe 2 dewasa: HbA1c >=6,5 cukup; GDS >=200 tanpa gejala perlu dua kali', () => {
    const r = rec({ diagnosa_list: 'E11.9' });
    expect(cari(temuan(r, [lab('HbA1c 7.2 % 4.5-5.6'), resume('Diagnosis Utama : DM tipe 2')]), 'PNPK-DM2-DEWASA-01').status).toBe('bukti_ditemukan');
    expect(cari(temuan(r, [lab('GDS 245 mg/dL 70-140'), resume('Diagnosis Utama : DM tipe 2')]), 'PNPK-DM2-DEWASA-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(r, [lab('GDS 245 mg/dL 70-140'), resume('Rutin minum metformin', 'Diagnosis Utama : DM tipe 2')]), 'PNPK-DM2-DEWASA-01').status).toBe('bukti_ditemukan');
  });
});

test('tulisan diagnosis tidak membuktikan dirinya sendiri (DM, epilepsi, AF)', () => {
  expect(cari(temuan(rec({ diagnosa_list: 'E11.9' }), [resume('Diagnosis Utama : DM tipe 2')]), 'PNPK-DM2-DEWASA-01').status).toBe('bukti_belum_cukup');
  expect(cari(temuan(anak({ diagnosa_list: 'G40.9' }), [resume('Diagnosis Utama : epilepsi')]), 'PNPK-EPILEPSI-ANAK-01').status).toBe('bukti_belum_cukup');
  expect(cari(temuan(rec({ diagnosa_list: 'I48' }), [resume('Diagnosis Utama : AF RVR')]), 'BA-18-M46').status).toBe('bukti_belum_cukup');
  expect(cari(temuan(rec({ diagnosa_list: 'I48' }), [resume('EKG: AF rapid ventricular response, irama ireguler')]), 'BA-18-M46').status).toBe('bukti_ditemukan');
});

describe('BA 2019 butir prosedur dan BA 2023 no. 18', () => {
  test('tindakan diklaim harus tertulis di berkas', () => {
    const t = cari(temuan(rec({ diagnosa_list: 'N39.0', prosedur_list: '57.94;89.52;96.07' }), [resume('Tindakan: pasang DC no 16, EKG sinus rhythm')]), 'BA-23-K18');
    expect(t.bukti.map(b => [b.id, b.status])).toEqual([['tindakan_57.94', 'bukti_ditemukan'], ['tindakan_89.52', 'bukti_ditemukan'], ['tindakan_96.07', 'bukti_belum_cukup']]);
  });
  test('13.71 tanpa ekstraksi katarak ditandai; bersama ekstraksi tidak', () => {
    expect(cari(temuan(rec({ diagnosa_list: 'H26.9', prosedur_list: '13.71' }), [resume('Tindakan IOL')]), 'BA-19-K156').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(rec({ diagnosa_list: 'H26.9', prosedur_list: '13.41;13.71' }), [resume('Fako + IOL')]), 'BA-19-K156')).toBeUndefined();
  });
  test('86.22 butuh eksisi; laporan operasi tak terbaca diminta cek PDF, bukan dianggap tidak ada', () => {
    const r = rec({ diagnosa_list: 'T24.2', prosedur_list: '86.22' });
    expect(cari(temuan(r, [resume('Tindakan/Prosedur :', '1. Debrideman')]), 'BA-19-K188').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(r, [hal(5, 'LAPORAN OPERASI\nDebridement: eksisi jaringan nekrotik')]), 'BA-19-K188').status).toBe('bukti_ditemukan');
    expect(cari(temuan(r, [hal(5, 'LAPORAN OPERASI\nJenis Operasi DCBR BENAN\nLAPORAN OPERASI LENGKAP\nzo + Tgl 34/2f2ors')]), 'BA-19-K188').status).toBe('perlu_cek_manual');
  });
  test('persalinan dengan penyulit: penyulit menjadi diagnosis utama', () => {
    expect(evaluasiKombinasiKode('O82.1;O34.2;Z37.0')[0]).toMatchObject({ kode: 'KMB-58', aksi: 'urutan' });
    expect(evaluasiKombinasiKode('O34.2;O82.1;Z37.0').some(k => k.kode === 'KMB-58')).toBe(false);
  });
});

describe('PNPK onkologi, infeksi, kardiovaskular, endokrin, dan lainnya', () => {
  const dewasa = (dx, o = {}) => rec({ diagnosa_list: dx, umur_tahun: 55, ...o });
  // [nama, record, halaman, id aturan, status bila ada bukti, halaman tanpa bukti]
  const kasus = [
    ['Ca mammae: PA', dewasa('C50.9'), [hal(4, 'HASIL PEMERIKSAAN PATOLOGI ANATOMI\nKesimpulan: invasive carcinoma of no special type, grade 2')], 'PNPK-ONKO-PAYUDARA-2026'],
    ['Ca nasofaring: biopsi', dewasa('C11.9'), [hal(4, 'HASIL PATOLOGI ANATOMI\nBiopsi nasofaring: karsinoma tidak berdiferensiasi')], 'PNPK-ONKO-NASOFARING'],
    ['LLA anak: BMP', anak({ diagnosa_list: 'C91.0' }), [hal(4, 'BMP: blast 85%, kesan LLA L1')], 'PNPK-ONKO-LLA-ANAK'],
    ['HIV reaktif', dewasa('B20.0'), [lab('Anti HIV (rapid 1) Reaktif', 'Anti HIV (rapid 2) Reaktif', 'Anti HIV (rapid 3) Reaktif')], 'PNPK-HIV-01'],
    ['Malaria: plasmodium', dewasa('B54'), [lab('Malaria (DDR) : ditemukan Plasmodium falciparum stadium tropozoit')], 'PNPK-MALARIA-01'],
    ['Hepatitis B: HBsAg', dewasa('B18.1'), [lab('HBsAg Reaktif')], 'PNPK-HEPATITIS-B-01'],
    ['Hipertensi: TD', dewasa('I10'), [resume('TD : 170/100 mmHg')], 'PNPK-HIPERTENSI-DEWASA-2026'],
    ['Hipotiroid: TSH', dewasa('E03.9'), [lab('TSH 12.5 uIU/mL 0.27-4.2')], 'PNPK-HIPOTIROID-01'],
    ['Glaukoma: TIO', dewasa('H40.1'), [resume('TIO OD 32 mmHg OS 18 mmHg')], 'PNPK-GLAUKOMA-01'],
    ['Retinopati DM: fundus', dewasa('H36.0'), [resume('Funduskopi: mikroaneurisma dan perdarahan dot blot, kesan NPDR')], 'PNPK-RETINOPATI-DM-01'],
    ['Hemofilia: FVIII', anak({ diagnosa_list: 'D66' }), [lab('Faktor VIII 0.8 %')], 'PNPK-HEMOFILIA-01'],
    ['COT: mekanisme + tanda', dewasa('S06.0'), [resume('Pasien jatuh dari motor, kepala terbentur, muntah 2x')], 'PNPK-COT-01'],
    ['RSK: >=12 minggu', dewasa('J32.9'), [resume('Hidung tersumbat dan pilek sejak 6 bulan, penciuman berkurang')], 'PNPK-RSK-01'],
    ['OMSK: perforasi', dewasa('H66.3'), [resume('Otoskopi: MT perforasi sentral AD, sekret mukopurulen')], 'PNPK-OMSK-01'],
    ['Tonsilektomi: frekuensi', dewasa('J35.0', { prosedur_list: '28.2' }), [resume('Nyeri telan kambuh 7 kali dalam 1 tahun')], 'PNPK-TONSILEKTOMI-01'],
    ['Hirschsprung: biopsi', anak({ diagnosa_list: 'Q43.1' }), [hal(4, 'Hasil PA biopsi rektum: tidak ditemukan sel ganglion')], 'PNPK-HIRSCHSPRUNG-01'],
    ['Sirosis: USG', dewasa('K74.6'), [hal(4, 'USG abdomen: kesan sirosis hepatis dengan splenomegali')], 'PNPK-SIROSIS-01'],
    ['Fraktur: rontgen', dewasa('S72.0'), [hal(4, 'Rontgen pelvis: kesan fraktur collum femur dextra')], 'PNPK-FRAKTUR-01'],
    ['OA: radiologi', dewasa('M17.1'), [hal(4, 'Foto genu: osteofit, penyempitan celah sendi medial')], 'PNPK-OSTEOARTRITIS-01'],
    ['Demensia: MMSE', dewasa('F03'), [resume('MMSE 18/30')], 'PNPK-DEMENSIA-01'],
  ];
  test.each(kasus)('%s: bukti ditemukan; tanpa penunjang menjadi bukti belum cukup', (_n, r, pages, id) => {
    expect(cari(temuan(r, pages), id)).toMatchObject({ status: 'bukti_ditemukan' });
    expect(cari(temuan(r, [resume('Keluhan lemas')]), id)).toMatchObject({ status: 'bukti_belum_cukup' });
  });

  test('BAJH kelenjar leher saja bukan diagnosis pasti KNF', () => {
    expect(cari(temuan(dewasa('C11.9'), [hal(4, 'Hasil BAJH KGB colli: metastasis karsinoma tidak berdiferensiasi')]), 'PNPK-ONKO-NASOFARING').status).toBe('bukti_belum_cukup');
  });

  test('hasil negatif tidak dibaca sebagai bukti', () => {
    expect(cari(temuan(dewasa('B54'), [lab('Malaria (DDR) : tidak ditemukan plasmodium')]), 'PNPK-MALARIA-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(dewasa('B18.1'), [lab('HBsAg Non Reaktif')]), 'PNPK-HEPATITIS-B-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(dewasa('B20.0'), [lab('Anti HIV Non Reaktif')]), 'PNPK-HIV-01').status).toBe('bukti_belum_cukup');
  });

  test('label diagnosis tidak membuktikan dirinya sendiri (COT, OA, sirosis)', () => {
    expect(cari(temuan(dewasa('S06.0'), [resume('Diagnosis: CKR')]), 'PNPK-COT-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(dewasa('M17.1'), [resume('Diagnosis: osteoarthritis genu')]), 'PNPK-OSTEOARTRITIS-01').status).toBe('bukti_belum_cukup');
    expect(cari(temuan(dewasa('K74.6'), [resume('Diagnosis: sirosis hepatis')]), 'PNPK-SIROSIS-01').status).toBe('bukti_belum_cukup');
  });

  test('angka yang terbaca tetapi bertentangan menjadi kontradiksi tinggi', () => {
    expect(cari(temuan(dewasa('E66.9'), [resume('BB 55 kg TB 165 cm IMT 20.2')]), 'PNPK-OBESITAS-01')).toMatchObject({ status: 'bukti_belum_cukup', kontradiksi_angka: true });
    expect(cari(temuan(dewasa('M41.1'), [hal(4, 'Rontgen: sudut Cobb 8 derajat')]), 'PNPK-SKOLIOSIS-01')).toMatchObject({ status: 'bukti_belum_cukup', kontradiksi_angka: true });
    expect(cari(temuan(dewasa('M41.1'), [hal(4, 'Rontgen: sudut Cobb 32 derajat')]), 'PNPK-SKOLIOSIS-01').status).toBe('bukti_ditemukan');
    const fako = dewasa('H25.9', { prosedur_list: '13.41' });
    expect(cari(temuan(fako, [resume('Visus VOD 1/60 VOS 6/9')]), 'PNPK-KATARAK-DEWASA-2026').status).toBe('bukti_ditemukan');
    expect(cari(temuan(fako, [resume('Visus VOD 6/9 VOS 6/6')]), 'PNPK-KATARAK-DEWASA-2026')).toMatchObject({ status: 'bukti_belum_cukup', kontradiksi_angka: true });
  });

  test('luka bakar: luas % harus sesuai subkode T31', () => {
    const t = dx => cari(temuan(dewasa(dx, { prosedur_list: '86.22' }), [resume('Luka bakar derajat IIA luas 15%')]), 'PNPK-LUKA-BAKAR-01');
    expect(t('T24.2;T31.1').status).toBe('bukti_ditemukan');
    expect(t('T24.2;T31.2')).toMatchObject({ status: 'bukti_belum_cukup', kontradiksi_angka: true });
    expect(t('T24.2;T31.2').bukti[0].catatan).toMatch(/T31\.1/);
  });

  test('PNPK rujukan (PPOK, gagal jantung, asfiksia) menempel ke kartu BA, bukan kartu sendiri', () => {
    const ppok = temuan(dewasa('J44.9'), [resume('Sesak')]);
    expect(ppok.some(x => x.id === 'PNPK-PPOK-01')).toBe(false);
    expect(cari(ppok, 'BA-19-M65').rujukan_ba_2018.map(b => b.id)).toContain('PNPK-PPOK-01');
  });

  test('PNPK tanpa aturan tercatat alasannya dan tidak tumpang dengan aturan aktif', () => {
    const aktif = new Set(kriteria.aturan.map(a => a.katalog_id));
    for (const x of kriteria.tanpa_aturan) {
      expect(x.alasan.length).toBeGreaterThan(10);
      expect(aktif.has(x.katalog_id)).toBe(false);
    }
  });
});
