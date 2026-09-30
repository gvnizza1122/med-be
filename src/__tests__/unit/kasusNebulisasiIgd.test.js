/**
 * Fixture regresi — kasus SEP 0170R0110926V001943 ("Tindakan yang Tidak Terbaca").
 *
 * SINTETIS DAN DISANITASI: tidak ada nama pasien, nomor kartu, maupun SEP lain.
 * Yang nyata dari berkas asli hanya (a) empat koordinat y hasil `pdftotext
 * -bbox` halaman 2 dan (b) kata-kata tindakan di tiga halaman. Kalimat lain dan
 * kotak kata lainnya direkaan agar menyerupai tata letaknya.
 *
 * Kasus: nebulisasi tertulis TIGA kali (resume hlm 2, resep hlm 3, triase hlm 5)
 * sementara daftar prosedur kosong, karena pada resume label "Tindakan"
 * terpusat vertikal di selnya dan isinya menempel di atas.
 */
const { bacaTemuanTindakan, periksaSilangTindakan, kalimatTindakanTakDikenal } = require('../../services/temuanTindakanService');
const { bacaLabelHalaman } = require('../../services/pasanganLabelPosisiService');
const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');
const { susunUsulanProsedur, kodeProclistDariUsulan } = require('../../services/aturanKodingRsService');
const { evaluasiKonsistensi } = require('../../services/konsistensiAntarDataService');

const w = (text, x0, top) => ({ text, x0, x1: x0 + text.length * 5, top, bottom: top + 9 });

// Kotak kata halaman 2 (koordinat y nyata: 441.3 / 481.5 / 489.6 / 513.6).
const KATA_HAL2 = [
  w('Diagnosa', 40, 441.3), w('PPOK,', 150, 441.3), w('Pneumonia', 150, 453.0),
  w('Penyebab', 40, 465.0), w('Cedera', 92, 465.0), w('-', 150, 465.0),
  w('Nebulisasi', 150, 481.5), w('Ventasal', 205, 481.5),
  w('Tindakan', 40, 489.6),
  w('Rencana', 40, 513.6), w('Rawat', 150, 513.6), w('jalan', 180, 513.6),
];

// Teks urutan baca murni halaman 2: "Tindakan" tanpa isi, isi menempel ke
// label "Penyebab Cedera".
const TEKS_HAL2 = 'RESUME MEDIS IGD\nDiagnosa\nPPOK,\nPneumonia\nPenyebab Cedera\nNebulisasi Ventasal\nTindakan\nRencana Rawat jalan\nPenunjang lain: -\nCara Bayar : UMUM';
const HAL1 = { page_number: 1, ocr_text: 'SURAT ELEGIBILITAS PESERTA\nNo. SEP 0170R0110926V001943' };
const HAL3 = { page_number: 3, ocr_text: 'RESEP\n1 R/ Masker Nebul DWS 1 pcs\n2 R/ Ventasal (salbutamol) NEBUL 1 -' };
const HAL4 = { page_number: 4, ocr_text: 'TRIAGE IGD\nRisiko Jatuh\nTindakan\nEvaluasi' };
const HAL5 = { page_number: 5, ocr_text: 'TRIAGE IGD\nIntervensi Keperawatan Tindakan Keperawatan\nKaji KU dan TTV\nnebul ventasal 1 ; nacl 2cc\nEvaluasi' };
const HAL6 = { page_number: 6, ocr_text: 'Lembar persetujuan' };

const halaman2Teks = { page_number: 2, ocr_text: TEKS_HAL2 };
const halaman2Posisi = {
  ...halaman2Teks,
  nilai_label: bacaLabelHalaman(KATA_HAL2, classifyPageDocumentType(TEKS_HAL2)),
};

describe('kasus nebulisasi IGD — dengan pasangan label dari posisi kata', () => {
  const berkas = [HAL1, halaman2Posisi, HAL3, HAL4, HAL5, HAL6];
  const temuan = bacaTemuanTindakan(berkas);
  const nebul = temuan.find(t => t.id === 'nebulisasi');

  test('nebulisasi terbaca dengan usulan kode 93.94', () => {
    expect(nebul).toBeDefined();
    expect(nebul.kode_usulan).toBe('93.94');
  });

  test('tiga kutipan dari tiga halaman: resume hlm 2, resep hlm 3, triase hlm 5', () => {
    expect(nebul.bukti).toHaveLength(3);
    const per = Object.fromEntries(nebul.bukti.map(b => [b.page_number, b]));
    expect(per[2].sumber).toBe('resume_medis');
    expect(per[2].kutipan).toBe('Tindakan: Nebulisasi Ventasal');
    expect(per[3].sumber).toBe('resep');
    expect(per[3].kutipan).toMatch(/Nebul/i);
    expect(per[5].sumber).toBe('triase_igd');
    expect(per[5].kutipan).toMatch(/nebul ventasal/);
  });

  test('"Tindakan" kosong di Risiko Jatuh (hlm 4) tidak menyumbang apa pun', () => {
    expect(nebul.bukti.map(b => b.page_number)).not.toContain(4);
  });

  test('resume sudah memuatnya -> tidak ada peringatan silang', () => {
    expect(periksaSilangTindakan(temuan)).toEqual([]);
  });

  test('tahap koding: masuk usulan prosedur 93.94 (perilaku bawaan, tanpa aturan RS)', () => {
    const usulan = susunUsulanProsedur(temuan, new Map(), { jenisKlaim: 'RAWAT_JALAN', igd: true });
    expect(kodeProclistDariUsulan(usulan)).toEqual(['93.94']);
    expect(usulan[0].belum_ada_aturan_rs).toBe(true);
    expect(usulan[0].kode_terverifikasi).toBe(false);
  });

  test('kolom Tindakan yang sudah dikenali tidak dilempar lagi ke AI untuk dikodekan', () => {
    // (Sisa label triase seperti "Kaji KU dan TTV" adalah perilaku lama di luar
    // cakupan perubahan ini; yang diuji hanya kolom Tindakan resume.)
    expect(kalimatTindakanTakDikenal(berkas).some(k => /nebulisasi|ventasal/i.test(k))).toBe(false);
  });

  test('temuan lain di berkas yang sama (cara bayar UMUM vs SEP, tanpa penunjang) tetap terdeteksi', () => {
    const t = evaluasiKonsistensi({ sep: '0170R0110926V001943', diagnosa_list: '' }, berkas, temuan);
    const id = t.map(x => x.id);
    expect(id).toContain('KD-02'); // resume UMUM padahal SEP BPJS
    expect(id).toContain('KD-13'); // pneumonia/PPOK di resume tanpa penunjang
  });
});

describe('kasus nebulisasi IGD — TANPA koordinat (jalur teks lama)', () => {
  // Bila PDF scan / koordinat gagal, perilaku lama dipertahankan: resume tetap
  // tidak terbaca, tetapi peringatan silang menangkapnya.
  const berkas = [HAL1, halaman2Teks, HAL3, HAL4, HAL5, HAL6];
  const temuan = bacaTemuanTindakan(berkas);

  test('nebulisasi tetap terbaca dari resep dan triase, resume tidak', () => {
    const nebul = temuan.find(t => t.id === 'nebulisasi');
    expect(nebul.bukti.map(b => b.sumber).sort()).toEqual(['resep', 'triase_igd']);
  });

  test('peringatan: kemungkinan tindakan nebulisasi belum terbaca', () => {
    const c = periksaSilangTindakan(temuan);
    expect(c).toHaveLength(1);
    expect(c[0].pesan).toMatch(/^Kemungkinan tindakan nebulisasi belum terbaca/);
    expect(c[0].jenis).toBe('tindakan_tidak_ada_di_resume');
    expect(c[0].kemungkinan_belum_terbaca).toBe(true);
    // Peringatan, bukan tindakan tambahan.
    expect(c[0].keparahan).toBe('sedang');
  });

  test('halaman scan tanpa nilai_label: isian kosong tidak merusak jalur teks', () => {
    const kosong = { ...halaman2Teks, nilai_label: { Tindakan: '' } };
    const t = bacaTemuanTindakan([kosong, HAL3, HAL5]).find(x => x.id === 'nebulisasi');
    expect(t.bukti.map(b => b.sumber).sort()).toEqual(['resep', 'triase_igd']);
  });
});
