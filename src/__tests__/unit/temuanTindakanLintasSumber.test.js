/**
 * Perluasan pemeriksaan silang lintas sumber + pagar "yang tidak tertulis tidak
 * boleh dikodekan". Melengkapi temuanTindakan.test.js (tidak menggantikannya).
 */
const { bacaTemuanTindakan, periksaSilangTindakan } = require('../../services/temuanTindakanService');
const { periksaWaktuTriase } = require('../../services/konsistensiWaktuService');
const { evaluasiKonsistensi } = require('../../services/konsistensiAntarDataService');

const hal = (page_number, ocr_text) => ({ page_number, ocr_text });
const RESUME_KOSONG = hal(2, 'RESUME MEDIS IGD\nDiagnosa Pneumonia\nTindakan\nRencana Rawat jalan');

describe('peringatan silang digeneralisasi lewat kamus tindakan', () => {
  test('alat nebul di resep tanpa kata "nebul" pada obatnya (Masker Nebul) -> peringatan', () => {
    const t = bacaTemuanTindakan([RESUME_KOSONG, hal(3, 'RESEP\n1 Masker Nebul DWS 1 pcs')]);
    const c = periksaSilangTindakan(t);
    expect(c.map(x => x.id)).toEqual(['nebulisasi']);
    expect(c[0].pesan).toMatch(/Kemungkinan tindakan nebulisasi belum terbaca/);
  });

  test('obat nebul + triase menyebut nebul, resume kosong -> SATU peringatan (bukan dua)', () => {
    const t = bacaTemuanTindakan([
      RESUME_KOSONG,
      hal(3, 'RESEP\nR/ Ventasal (salbutamol) NEBUL 1'),
      hal(5, 'TRIAGE IGD\nTindakan Keperawatan\nnebul ventasal 1 ; nacl 2cc\nEvaluasi'),
    ]);
    const c = periksaSilangTindakan(t);
    expect(c).toHaveLength(1);
    expect(c[0].pesan).toMatch(/resep dan triase_igd/);
  });

  test('salbutamol TABLET di resep bukan sinyal nebulisasi', () => {
    const t = bacaTemuanTindakan([RESUME_KOSONG, hal(3, 'RESEP\nR/ Salbutamol tab 2 mg 3x1')]);
    expect(t.find(x => x.id === 'nebulisasi')).toBeUndefined();
  });

  test('oksigen: alat di resep (nasal kanul) dengan resume kosong -> peringatan oksigen', () => {
    const t = bacaTemuanTindakan([RESUME_KOSONG, hal(3, 'RESEP\nNasal kanul dewasa 1 pcs')]);
    expect(periksaSilangTindakan(t).map(x => x.id)).toEqual(['terapi_oksigen']);
  });

  test('infus: abocath di resep dengan resume kosong -> peringatan, tanpa kode tebakan', () => {
    const t = bacaTemuanTindakan([RESUME_KOSONG, hal(3, 'RESEP\nAbocath no 22 1 pcs\nInfus set 1 pcs')]);
    const infus = t.find(x => x.id === 'pemasangan_infus');
    expect(infus.kode_usulan).toBeNull();
    expect(periksaSilangTindakan(t).map(x => x.id)).toEqual(['pemasangan_infus']);
  });
});

describe('yang tidak tertulis tidak boleh dikodekan', () => {
  // Saturasi 88% menggoda untuk "menambahkan" oksigen. Tidak boleh: koding
  // mengikuti apa yang TERTULIS dikerjakan, bukan apa yang seharusnya.
  test('SpO2 88% tanpa catatan pemberian oksigen -> TIDAK ada temuan oksigen', () => {
    const t = bacaTemuanTindakan([
      hal(2, 'RESUME MEDIS IGD\nSpO2 88%\nTindakan\nRencana Rawat jalan'),
      hal(5, 'TRIAGE IGD\nTanda vital: SpO2 88 %, RR 28x/menit\nTindakan Keperawatan\nKaji KU dan TTV\nEvaluasi'),
    ]);
    expect(t.find(x => x.id === 'terapi_oksigen')).toBeUndefined();
    expect(t.some(x => x.kode_usulan === '93.96')).toBe(false);
  });

  test('saturasi rendah hanya memunculkan peringatan konsistensi (KD-08), bukan kode', () => {
    const berkas = [hal(2, 'RESUME MEDIS IGD\nSpO2 88%\nTindakan\nRencana Rawat jalan')];
    const t = bacaTemuanTindakan(berkas);
    const f = evaluasiKonsistensi({}, berkas, t);
    expect(f.map(x => x.id)).toContain('KD-08');
    expect(t).toEqual([]);
  });

  test('oksigen yang DISANGKAL ("tanpa oksigen") tidak terbaca sebagai dilakukan', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS IGD\nTindakan tanpa oksigen, observasi\nRencana Rawat jalan')]);
    expect(t.find(x => x.id === 'terapi_oksigen')).toBeUndefined();
  });

  test('oksigen yang tertulis diberikan tetap terbaca', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS IGD\nTindakan O2 nasal kanul 3 lpm\nRencana Rawat jalan')]);
    expect(t.find(x => x.id === 'terapi_oksigen').kode_usulan).toBe('93.96');
  });

  test('belum dinebulisasi -> tidak terbaca', () => {
    const t = bacaTemuanTindakan([hal(2, 'RESUME MEDIS IGD\nTindakan belum nebulisasi\nRencana Rawat jalan')]);
    expect(t).toEqual([]);
  });
});

describe('waktu triase tidak wajar (KW-01)', () => {
  test('mulai 21:54, selesai pukul 07:00 -> temuan', () => {
    const t = periksaWaktuTriase([hal(5, 'TRIAGE IGD\nJam mulai triase 21:54\nselesai pukul 07:00')]);
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe('KW-01');
    expect(t[0].pesan).toMatch(/21:54/);
    expect(t[0].pesan).toMatch(/9 jam 6 menit/);
    expect(t[0].yang_ditemukan.page_number).toBe(5);
  });

  test('selisih wajar (21:54 -> 22:20) tidak menghasilkan temuan', () => {
    expect(periksaWaktuTriase([hal(5, 'TRIAGE IGD\nJam mulai triase 21:54\nselesai pukul 22:20')])).toEqual([]);
  });

  test('melewati tengah malam yang wajar (23:50 -> 00:10) tidak ditandai', () => {
    expect(periksaWaktuTriase([hal(5, 'TRIAGE IGD\nJam mulai triase 23:50\nselesai pukul 00:10')])).toEqual([]);
  });

  test('halaman bukan triase atau waktu tidak lengkap diabaikan', () => {
    expect(periksaWaktuTriase([hal(2, 'RESUME MEDIS IGD\nmulai 21:54 selesai pukul 07:00')])).toEqual([]);
    expect(periksaWaktuTriase([hal(5, 'TRIAGE IGD\nJam mulai triase 21:54')])).toEqual([]);
    expect(periksaWaktuTriase(null)).toEqual([]);
  });
});

describe('ketentuan penunjang untuk Pneumonia/PPOK (KD-09, KD-12, KD-13, KD-15)', () => {
  const tanpaPenunjang = [hal(2, 'RESUME MEDIS IGD\nDiagnosa PPOK, Pneumonia\nPenunjang lain: -')];
  const RI = { jenis_klaim: 'RAWAT_INAP' };
  const RJ = { jenis_klaim: 'RAWAT_JALAN' };

  test('rawat inap: J44 di DIAGLIST tanpa penunjang -> KD-12', () => {
    const f = evaluasiKonsistensi({ ...RI, diagnosa_list: 'J44.1' }, tanpaPenunjang, []);
    expect(f.map(x => x.id)).toContain('KD-12');
    expect(f.find(x => x.id === 'KD-12').keparahan).toBe('tinggi');
  });

  test('rawat inap: J44 dengan hasil laboratorium di berkas -> tidak ada temuan', () => {
    const f = evaluasiKonsistensi({ ...RI, diagnosa_list: 'J44.1' }, [...tanpaPenunjang, hal(4, 'HASIL PEMERIKSAAN LABORATORIUM\nHematologi\nLeukosit 12.000')], []);
    expect(f.map(x => x.id)).not.toContain('KD-12');
  });

  test('rawat inap: DIAGLIST kosong tetapi resume menulis pneumonia/PPOK -> KD-13', () => {
    const f = evaluasiKonsistensi({ ...RI, diagnosa_list: '' }, tanpaPenunjang, []);
    expect(f.map(x => x.id)).toContain('KD-13');
  });

  test('rawat inap: DIAGLIST sudah terisi J18 -> KD-09 yang menilai, KD-13 tidak dobel', () => {
    const f = evaluasiKonsistensi({ ...RI, diagnosa_list: 'J18.9' }, tanpaPenunjang, []);
    expect(f.map(x => x.id)).toContain('KD-09');
    expect(f.map(x => x.id)).not.toContain('KD-13');
  });

  // MUNAWIR (0170R0110926V001943): PPOK eksaserbasi + nebulisasi di IGD, dipulangkan.
  test('rawat jalan: PPOK tanpa penunjang tidak dipersoalkan (KD-12/KD-13 tidak menyala)', () => {
    for (const diagnosa_list of ['', 'J44.1']) {
      const id = evaluasiKonsistensi({ ...RJ, diagnosa_list }, tanpaPenunjang, []).map(x => x.id);
      expect(id).not.toContain('KD-12');
      expect(id).not.toContain('KD-13');
    }
  });

  test('rawat jalan: pneumonia J18 tanpa penunjang -> KD-15 rendah (perlu dicek), bukan KD-09', () => {
    const f = evaluasiKonsistensi({ ...RJ, diagnosa_list: 'J44.1;J18.9' }, tanpaPenunjang, []);
    expect(f.map(x => x.id)).toContain('KD-15');
    expect(f.map(x => x.id)).not.toContain('KD-09');
    expect(f.find(x => x.id === 'KD-15').keparahan).toBe('rendah');
  });

  test('record alur sungguhan (huruf besar JENIS_KLAIM/DIAGLIST) dibaca sama', () => {
    expect(evaluasiKonsistensi({ JENIS_KLAIM: 'RAWAT_INAP', DIAGLIST: 'J44.1' }, tanpaPenunjang, []).map(x => x.id)).toContain('KD-12');
    expect(evaluasiKonsistensi({ JENIS_KLAIM: 'RAWAT_JALAN', DIAGLIST: 'J44.1' }, tanpaPenunjang, []).map(x => x.id)).not.toContain('KD-12');
  });

  test('temuan paru resume (rh +/+) vs triase Thorax Normal: KD-10 rendah, kutipan baris utuh', () => {
    const f = evaluasiKonsistensi({}, [
      hal(2, 'RESUME MEDIS IGD\nkepala: ca -/-, si -/-,\nthorax: sdv +/+, rh +/+, wh +/+\nabdomen: soepl+'),
      hal(5, 'TRIAGE IGD\nThorak Normal'),
    ], []);
    const kd10 = f.find(x => x.id === 'KD-10');
    expect(kd10.keparahan).toBe('rendah');
    expect(kd10.yang_ditemukan.kutipan).toBe('thorax: sdv +/+, rh +/+, wh +/+');
  });
});
