/**
 * Kesesuaian klaim rawat inap STT dengan BA 2024 aspek medis no. 1.
 * Kasus acuan (anonim): laporan operasi tiga tumor; hanya massa 5x4 cm di
 * antara otot pectoralis (dinding dada) yang di bawah fascia, tetapi klaim
 * diajukan dengan 86.3 + R22.0/R22.3 dan PA hanya mencantumkan frontal &
 * antebrachii.
 */
const { nilaiKesesuaianStt } = require('../../services/kesesuaianSttService');
const { susunPutusan } = require('../../services/putusanPendingService');

const OPERASI = {
  page_number: 14,
  ocr_text: 'LAPORAN OPERASI\nOperator dr. A, SpB\nJaringan yang diexcisi / incisi\n- Tumor regio frontal - Tumor regio antebrac\n'
    + 'Nama/ macam tindakan operasi\nEksisi dan PA\nDiagnosis pasca tindakan\n- Tumor regio frontal - Tumor regio antebrachii dekstra - Tumor regio dinding dada\n'
    + 'Prosedur operasi yang dilakukan dan rincian temuan\n- Aseptik antiseptik - Insisi di atas massa, perdalam lapis demi\n'
    + 'lapis - Setelah subcutis, sampai ke lapisan otot platysma - Platysma split sampai massa tumor\n'
    + 'diameter 3x2 cm, mobile, konsistensi padat - Eksisi in toto (PA) - Setelah subcutis,\n'
    + 'sampai ke lapisan otot pectoralis mayor - Otot pectoralis mayor split kanan kiri, mencapai massa tumor di\n'
    + 'dalamnya - Massa tumor berada di antara otot : massa tumor diameter 5x4 cm, mobile, konsistensi\n'
    + 'padat - Eksisi massa tumor in toto --> sampel PA - Jahit luka lapis demi lapis - Operasi selesai',
};
const PA = {
  page_number: 16,
  ocr_text: 'LABORATORIUM PATOLOGI ANATOMIK\nJAWABAN PEMERIKSAAN HISTOPATOLOGI\nBahan : Frontal dan Antebrachii Dextra\n'
    + 'Makroskopik : Tiga buah jaringan, terbesar berukuran 3x2.5x1.5 cm\nSifat Keganasan : Tidak didapatkan tanda ganas\n'
    + 'Kesimpulan : Benign mesenchymal neoplasm jenis adipocytic',
};
const masukan = (o = {}) => ({ jenisKlaim: 'RAWAT_INAP', dx: ['R22.0', 'R22.3'], px: ['86.3', '89.52', '90.59'], pages: [OPERASI, PA], tanggal: '2026-10-01', ...o });

describe('kesesuaian STT rawat inap (BA 2024)', () => {
  test('tumor dalam ada di laporan operasi, tetapi kode menggambarkan lesi superfisial -> wajib pending', () => {
    const r = nilaiKesesuaianStt(masukan());
    expect(r).toMatchObject({ id: 'BA-STT-KODE', keparahan: 'tinggi', wajib_pending: true });
    expect(r.penjelasan).toMatch(/86\.3/);
    expect(r.penjelasan).toMatch(/5x4 cm/);
    expect(r.penjelasan).toMatch(/dada/); // lesi dalam di dinding dada belum dikode
    expect(r.penjelasan).toMatch(/bahan PA/i);
    // Alasan harus terbaca sekilas: ukuran, letak, halaman, dan kode yang bermasalah ada di ringkasan.
    expect(r.ringkas).toMatch(/5x4 cm.*di bawah fascia.*hal\. \d+.*86\.3/);
    expect(r.penjelasan).toMatch(/\(2\) tidak terpenuhi/);
    expect(r.bukti_ringkas).toMatch(/pectoralis/);
  });
  test('lesi dalam dikode sebagai eksisi jaringan lunak/otot -> sesuai', () => {
    expect(nilaiKesesuaianStt(masukan({ px: ['83.39', '86.3'] }))).toBeNull();
  });
  test('tidak ada kriteria sama sekali pada laporan yang terbaca -> wajib pending (diklaimkan rawat jalan)', () => {
    const dangkal = { page_number: 14, ocr_text: 'LAPORAN OPERASI\nProsedur operasi yang dilakukan dan rincian temuan\n- Insisi di atas massa - '
      + 'Setelah subcutis tampak massa tumor diameter 2x2 cm, mobile - Eksisi in toto - Jahit luka lapis demi lapis - Operasi selesai '
      + '- Kontrol perdarahan, tidak ada perdarahan aktif, luka ditutup kasa steril dan plester.' };
    expect(nilaiKesesuaianStt(masukan({ pages: [dangkal, PA] }))).toMatchObject({ id: 'BA-STT-KRITERIA', keparahan: 'tinggi', wajib_pending: true });
  });
  test('STT ganas memenuhi kriteria', () => {
    const ganas = { ...PA, ocr_text: 'LABORATORIUM PATOLOGI ANATOMIK\nJAWABAN PEMERIKSAAN HISTOPATOLOGI\nKesimpulan : Liposarkoma (ganas)' };
    expect(nilaiKesesuaianStt(masukan({ pages: [OPERASI, ganas] }))).toBeNull();
  });
  test('rawat jalan atau episode sebelum BA berlaku tidak dinilai', () => {
    expect(nilaiKesesuaianStt(masukan({ jenisKlaim: 'RAWAT_JALAN' }))).toBeNull();
    expect(nilaiKesesuaianStt(masukan({ tanggal: '2024-11-30' }))).toBeNull();
  });
  test('alasan wajib membuat putusan berisiko pending', () => {
    const p = susunPutusan({ kesesuaian_stt: nilaiKesesuaianStt(masukan()) }, []);
    expect(p.status).toBe('berisiko_pending');
    expect(p.alasan[0]).toMatchObject({ kode: 'BA-STT-KODE', wajib_pending: true, sumber_pemeriksaan: 'Kesesuaian STT (BA 2024)' });
  });
});
