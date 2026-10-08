/**
 * Aspek medis BA Kesepakatan Bersama 2018 (butir 1-63) sebagai persyaratan
 * valid/pending, tanpa kartu atau alasan ganda dengan aturan yang sudah ada.
 * Fixture anonim.
 */
const katalog = require('../../data/baPnpkAnak.json');
const { DETEKTOR, KHUSUS } = require('../../services/baKesepakatan2018Service');
const { evaluasiReferensiKlaim } = require('../../services/referensiKlaimService');
const { susunPutusan } = require('../../services/putusanPendingService');
const { perbaruiRisikoTampilan } = require('../../services/risikoKlaimTampilanService');

const rec = (o = {}) => ({ jenis_klaim: 'RAWAT_INAP', admission_date: '2026-10-01', discharge_date: '2026-10-05', hospital_code: '9999999', umur_tahun: 45, gender: '2', ...o });
const anak = (o = {}) => rec({ umur_tahun: 6, birth_date: '2020-03-01', ...o });
const hal = (n, t) => ({ page_number: n, ocr_text: t });
const lab = (...baris) => hal(2, `HASIL LABORATORIUM\nTanggal 02-10-2026\n${baris.join('\n')}`);
const resume = (...baris) => hal(3, `RESUME MEDIS RAWAT INAP\n${baris.join('\n')}`);
const temuan = (r, pages) => evaluasiReferensiKlaim(r, pages).temuan;
const cariBa = (t, id) => t.find(x => x.id === id) || t.flatMap(x => x.rujukan_ba_2018 || []).find(b => b.id === id);
const alasanBa = (t) => susunPutusan({ referensi_klaim: { temuan: t } }).alasan.filter(a => a.sumber_pemeriksaan === 'BA kesepakatan Kemenkes-BPJS');

describe('cakupan katalog BA 2018', () => {
  test('63 butir aspek medis terpetakan; detektor dan penilai tersedia', () => {
    const butir = new Set(katalog.aturan.filter(a => a.sumber_id === 'BA-KLAIM-2018').flatMap(a => (String(a.butir).match(/\d+/g) || []).map(Number)));
    expect([...Array(63)].map((_, i) => i + 1).filter(n => !butir.has(n))).toEqual([]);
    for (const a of katalog.aturan) {
      for (const k of (a.kriteria || []).flat()) expect(DETEKTOR[k]).toBeDefined();
      if (a.pemeriksa_ba) expect(KHUSUS[a.pemeriksa_ba]).toBeDefined();
    }
    expect(new Set(katalog.aturan.map(a => a.id)).size).toBe(katalog.aturan.length);
  });
});

describe('tanpa tumpang tindih', () => {
  test('topik yang sudah dinilai aturan lain: butir BA ditempel ke kartu itu, bukan kartu baru', () => {
    const t = temuan(rec({ diagnosa_list: 'A15.0' }), [resume('Diagnosis Utama : TB paru')]);
    expect(t.some(x => x.id === 'BA-18-M04')).toBe(false);
    const rk = t.find(x => x.id === 'RK-07');
    expect(rk.rujukan_ba_2018.map(b => b.id)).toEqual(['BA-18-M04']);
    expect(rk.keterbatasan.join(' ')).toMatch(/BA 2018.*Aspek medis 4/);
  });
  test('catatan BDD hanya untuk RS tertentu: di RS lain butir BA berdiri sendiri', () => {
    const halaman = [resume('TD : 80/50 mmHg', 'Terapi: drip norepinefrin', 'Diagnosis Utama : ADHF')];
    expect(temuan(rec({ diagnosa_list: 'I50.0;R57.0' }), halaman).some(x => x.id === 'BA-18-M01')).toBe(true);
    const rs = temuan(rec({ hospital_code: '3371084', diagnosa_list: 'I50.0;R57.0' }), halaman);
    expect(rs.some(x => x.id === 'BA-18-M01')).toBe(false);
    expect(rs.find(x => x.id === 'BDD-26').rujukan_ba_2018[0].id).toBe('BA-18-M01');
  });
  test('satu alasan per topik: bila syarat RS (SP-04) sudah memberi alasan, butir anemia BA tidak menambah', () => {
    const t = temuan(rec({ diagnosa_list: 'N18.5;D63.8' }), [lab('Hemoglobin 9.0 g/dL 12-16'), resume('Diagnosis Utama : CKD')]);
    expect(alasanBa(t).map(a => a.kode)).toEqual(['BA-18-M13']);
    const p = susunPutusan({ referensi_klaim: { temuan: t }, syarat_penunjang: [{ id: 'SP-04', diverifikasi: true, kode_diagnosis: 'D63.8',
      sumber_aturan: 'Rekap pending RS', syarat: [{ nama: 'Hemoglobin di bawah 8 g/dL', status: 'tidak_ada' }] }] });
    expect(p.alasan.filter(a => ['SP-04', 'BA-18-M13'].includes(a.kode)).map(a => a.kode)).toEqual(['SP-04']);
  });
  test('butir rujukan tanpa kriteria berkas tidak menjadi alasan', () => {
    const t = temuan(rec({ jenis_klaim: 'RAWAT_JALAN', diagnosa_list: 'O26.8;Z34.0', prosedur_list: '88.76' }), [resume('USG kehamilan')]);
    expect(cariBa(t, 'BA-18-M02').status).toBe('perlu_cek_manual');
    expect(alasanBa(t)).toEqual([]);
  });
});

describe('ambang angka', () => {
  test('D70 pada kanker: leukosit terbaca >=3.000 -> tinggi (tidak wajib); <3.000 -> tanpa alasan', () => {
    const r = rec({ diagnosa_list: 'C50.9;D70' });
    const a = alasanBa(temuan(r, [lab('Leukosit 3500 /uL 4000-10000'), resume('Diagnosis Utama : Ca mammae')]));
    expect(a[0]).toMatchObject({ kode: 'BA-18-M15', keparahan: 'tinggi', wajib_pending: false });
    expect(alasanBa(temuan(r, [lab('Leukosit 2400 /uL 4000-10000'), resume('Diagnosis Utama : Ca mammae')]))).toEqual([]);
  });
  test('nilai tidak terbaca bukan kontradiksi: sedang', () => {
    const a = alasanBa(temuan(rec({ diagnosa_list: 'C50.9;D70' }), [resume('Diagnosis Utama : Ca mammae')]));
    expect(a[0].keparahan).toBe('sedang');
  });
  test('N19: ambang kreatinin mengikuti jenis kelamin; jenis kelamin kosong pada 1,1-1,3 tidak dianggap kontradiksi', () => {
    const p = [lab('Kreatinin 1.2 mg/dL 0.5-1.1'), resume('Diagnosis Utama : CKD')];
    expect(cariBa(temuan(rec({ diagnosa_list: 'I10;N19', gender: '2' }), p), 'BA-18-M36').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(rec({ diagnosa_list: 'I10;N19', gender: '1' }), p), 'BA-18-M36').kontradiksi_angka).toBe(true);
    const kosong = cariBa(temuan(rec({ diagnosa_list: 'I10;N19', gender: '' }), p), 'BA-18-M36');
    expect(kosong.status).toBe('bukti_belum_cukup');
    expect(kosong.kontradiksi_angka).toBe(false);
  });
  test('D72.8 karena infeksi bukan leukositosis sekunder; kehamilan s.d. 16.000 fisiologis', () => {
    const infeksi = cariBa(temuan(rec({ diagnosa_list: 'N39.0;D72.8' }), [lab('Leukosit 18000 /uL 4000-10000'), resume('Diagnosis Utama : ISK')]), 'BA-18-M14');
    expect(infeksi.status).toBe('bukti_belum_cukup');
    expect(infeksi.bukti.find(b => b.id === 'bukan_infeksi_obat_mpn').bukti[0].kutipan).toMatch(/N39\.0/);
    const hamil = cariBa(temuan(rec({ diagnosa_list: 'O80.0;D72.8' }), [lab('Leukosit 15000 /uL 4000-10000'), resume('Persalinan spontan')]), 'BA-18-M14');
    expect(hamil.kontradiksi_angka).toBe(true);
  });
});

describe('jalur anak (BA 2018) dan dewasa', () => {
  test('transfusi thalassemia: anak Hb <6 rawat inap; sesak (-) tidak dihitung; dewasa perlu komplikasi', () => {
    const tx = { diagnosa_list: 'D56.1', prosedur_list: '99.04' };
    expect(cariBa(temuan(anak(tx), [lab('Hemoglobin 5.4 g/dL 11-14'), resume('Diagnosis Utama : Thalassemia')]), 'BA-18-M10-ANAK').status).toBe('bukti_ditemukan');
    const tanpa = temuan(anak(tx), [lab('Hemoglobin 7.0 g/dL 11-14'), resume('Keluhan: lemas, sesak (-)', 'Diagnosis Utama : Thalassemia')]);
    expect(cariBa(tanpa, 'BA-18-M10-ANAK').status).toBe('bukti_belum_cukup');
    expect(cariBa(tanpa, 'BA-18-M10')).toBeUndefined();
    expect(cariBa(temuan(rec(tx), [lab('Hemoglobin 5.4 g/dL 12-16'), resume('Diagnosis Utama : Thalassemia')]), 'BA-18-M10').status).toBe('bukti_belum_cukup');
  });
  test('disfagia + tonsilektomi hanya anak dengan gizi kurang', () => {
    const k = { diagnosa_list: 'J35.0;R13', prosedur_list: '28.2' };
    expect(cariBa(temuan(anak(k), [resume('Status gizi: gizi kurang (BB/U < -2 SD)', 'Diagnosis Utama : Tonsilitis kronis')]), 'BA-18-M19').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(rec(k), [resume('Status gizi: gizi kurang', 'Diagnosis Utama : Tonsilitis kronis')]), 'BA-18-M19').status).toBe('bukti_belum_cukup');
  });
  test('chalazion rawat inap: anak dengan anestesi umum memenuhi, dewasa tidak', () => {
    const k = { diagnosa_list: 'H00.1', prosedur_list: '08.21' };
    expect(cariBa(temuan(anak(k), [hal(4, 'LAPORAN OPERASI\nJenis anestesi : GA\nTindakan: eksisi chalazion')]), 'BA-18-M24').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(rec(k), [hal(4, 'LAPORAN OPERASI\nAnestesi lokal\nTindakan: eksisi chalazion')]), 'BA-18-M24').status).toBe('bukti_belum_cukup');
  });
  test('CKD anak rawat inap: albumin <2,5 memenuhi salah satu kriteria; dewasa tidak memakai kriteria anak', () => {
    const p = [lab('Albumin 2.2 g/dL 3.5-5.0'), resume('Diagnosis Utama : CKD stage 5')];
    expect(cariBa(temuan(anak({ diagnosa_list: 'N18.5' }), p), 'BA-18-M45-ANAK').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(rec({ diagnosa_list: 'N18.5' }), p), 'BA-18-M45-ANAK')).toBeUndefined();
  });
  test('N19 anak: ureum/kreatinin berulang, bukan ambang dewasa', () => {
    const t = temuan(anak({ diagnosa_list: 'N19' }), [lab('Kreatinin 0.9 mg/dL 0.3-0.7', 'Ureum 60 mg/dL 10-40'), hal(5, 'HASIL LABORATORIUM\nTanggal 04-10-2026\nKreatinin 0.8 mg/dL 0.3-0.7')]);
    expect(cariBa(t, 'BA-18-M36').bukti[0].id).toBe('ureum_kreatinin_berulang');
    expect(cariBa(t, 'BA-18-M36').status).toBe('bukti_ditemukan');
  });
  test('kejang neonatus dikode P90; kejang demam anak tanpa konflik tidak menambah butir R56', () => {
    const neo = temuan(rec({ umur_tahun: 0, umur_hari: 10, diagnosa_list: 'R56.8' }), [resume('Kejang')]);
    expect(cariBa(neo, 'BA-18-M60')).toMatchObject({ status: 'bukti_belum_cukup' });
    expect(alasanBa(neo)[0].ringkas).toMatch(/P90/);
    expect(cariBa(temuan(anak({ diagnosa_list: 'R56.0' }), [resume('Kejang demam')]), 'BA-18-M60')).toBeUndefined();
  });
  test('hiponatremia anak: Na <130 dengan koreksi memenuhi; 132 tanpa kejang/penurunan kesadaran tidak', () => {
    const ok = temuan(anak({ diagnosa_list: 'A09;E87.1' }), [lab('Natrium 127 mmol/L 135-145'), resume('Terapi: koreksi Na dengan NaCl 3%', 'Diagnosis Utama : GEA')]);
    expect(cariBa(ok, 'BA-18-M05-ANAK').status).toBe('bukti_ditemukan');
    const kurang = temuan(anak({ diagnosa_list: 'A09;E87.1' }), [lab('Natrium 132 mmol/L 135-145'), resume('Terapi: koreksi Na', 'Diagnosis Utama : GEA')]);
    expect(cariBa(kurang, 'BA-18-M05-ANAK').status).toBe('bukti_belum_cukup');
  });
});

describe('kriteria klinis', () => {
  test('vertigo perifer: muntah saja belum cukup, muntah + dehidrasi memenuhi', () => {
    const r = rec({ diagnosa_list: 'H81.1' });
    expect(cariBa(temuan(r, [resume('Keluhan: pusing berputar, muntah 3x', 'Diagnosis Utama : BPPV')]), 'BA-18-M21-PERIFER').status).toBe('bukti_belum_cukup');
    expect(cariBa(temuan(r, [resume('Keluhan: muntah >5x, tidak bisa makan', 'Pemeriksaan: turgor menurun', 'Diagnosis Utama : BPPV')]), 'BA-18-M21-PERIFER').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(rec({ diagnosa_list: 'M32.9;R42' }), [resume('Diagnosis Utama : SLE')]), 'BA-18-M21-SENTRAL')).toBeUndefined();
  });
  test('gagal napas akut: SpO2 <91 dan terapi oksigen', () => {
    const r = rec({ diagnosa_list: 'J18.9;J96.0' });
    expect(cariBa(temuan(r, [resume('SpO2 : 86%', 'Terapi: O2 NRM 10 lpm', 'Diagnosis Utama : Pneumonia')]), 'BA-18-M17').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(r, [resume('SpO2 : 96%', 'Terapi: O2 nasal kanul 3 lpm', 'Diagnosis Utama : Pneumonia')]), 'BA-18-M17').status).toBe('bukti_belum_cukup');
  });
  test('RIRS: batu >2 cm dianjurkan PCNL/operasi terbuka', () => {
    const t = temuan(rec({ diagnosa_list: 'N20.0', prosedur_list: '56.0' }), [hal(4, 'HASIL RADIOLOGI\nKesan: batu ginjal kanan ukuran 25 mm')]);
    expect(cariBa(t, 'BA-18-M59').status).toBe('bukti_belum_cukup');
    expect(cariBa(t, 'BA-18-M59').bukti[0].catatan).toMatch(/2,5 cm/);
  });
  test('laparotomi eksplorasi insidental sebagai prosedur utama ditandai', () => {
    const t = temuan(rec({ diagnosa_list: 'K35.8', prosedur_list: '54.11;47.09' }), [hal(4, 'LAPORAN OPERASI\nTemuan: appendix hiperemis, tidak ada perforasi')]);
    const m = cariBa(t, 'BA-18-M62');
    expect(m.status).toBe('bukti_belum_cukup');
    expect(m.bukti.map(b => b.id)).toEqual(expect.arrayContaining(['bukan_prosedur_utama']));
  });
  test('hemoroidektomi: grade rentang pada SPRI ("grade 2-3") memenuhi; grade II tanpa penyulit tidak', () => {
    const r = rec({ diagnosa_list: 'I84.8', prosedur_list: '49.45;49.46' });
    const spri = g => hal(1, `SURAT PERINTAH RAWAT INAP\nDiagnosa : Hemoroid interna grade ${g}`);
    expect(cariBa(temuan(r, [spri('2-3'), resume('Diagnosis Utama : Mixed hemoroid dengan perdarahan')]), 'BA-18-M33').status).toBe('bukti_ditemukan');
    expect(cariBa(temuan(r, [spri('2'), resume('Diagnosis Utama : Hemoroid interna')]), 'BA-18-M33').status).toBe('bukti_belum_cukup');
    expect(cariBa(temuan(r, [spri('2'), resume('Diagnosis Utama : Hemoroid interna dengan perdarahan')]), 'BA-18-M33').status).toBe('bukti_ditemukan');
  });
  test('skin graft untuk tato tidak dijamin', () => {
    const t = temuan(rec({ diagnosa_list: 'L81.8', prosedur_list: '86.69' }), [resume('Indikasi: koreksi tato lengan', 'Diagnosis Utama : Tato')]);
    expect(cariBa(t, 'BA-18-M11').bukti.find(b => b.id === 'bukan_estetik').status).toBe('bukti_belum_cukup');
  });
});

test('dibuka ulang: alasan BA lama disegarkan dari halaman tersimpan tanpa mengubah record', () => {
  const r = rec({ diagnosa_list: 'C50.9;D70', ai_review: { putusan_pending: { status: 'berisiko_pending', alasan: [
    { sumber_pemeriksaan: 'BA kesepakatan 2018', kode: 'BA-18-M15', ringkas: 'Leukopenia lama', keparahan: 'tinggi' }] } } });
  const sebelum = JSON.stringify(r);
  const a = perbaruiRisikoTampilan(r, [], { pages: [lab('Leukosit 2400 /uL 4000-10000'), resume('Diagnosis Utama : Ca mammae')] });
  expect(a.putusan_pending.alasan.some(x => x.kode === 'BA-18-M15')).toBe(false);
  expect(JSON.stringify(r)).toBe(sebelum);
});
