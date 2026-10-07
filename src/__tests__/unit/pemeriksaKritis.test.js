const { periksaKritis, periksaAturan, totalTagihan } = require('../../services/pemeriksaKritisService');
const { ekstrakPasangan, kunciIstilah } = require('../../services/pembelajaranCasemixService');
const { hitungInacbgDanTarif } = require('../../services/aiReviewService');

const resume = { page_number: 3, ocr_text: 'RESUME MEDIS RAWAT INAP\nDiagnosis Utama :\nTumor regio sternum (subfascia)\nDiagnosis Sekunder :\n1. -\nTindakan/Prosedur :\n1. Eksisi dan PA\nTerapi/pengobatan selama di rumah sakit :' };
const tagihan = { page_number: 14, ocr_text: 'Perincian Harga Jml Biaya\nTerbilang : Empat Juta\nTotal 4,584,840\nKurang/Kelebihan 4,584,840' };
const record = { id: 'r1', jenis_klaim: 'RAWAT_INAP', kelas_rawat: '3', diagnosa_list: '', prosedur_list: '' };
const s = (code, type, page_number = 3, extra = {}) => ({ code, type, kamus_valid: true, page_number, quotation: 'x', ...extra });

test('total tagihan RS terbaca dari rincian biaya', () => {
  expect(totalTagihan([tagihan])).toMatchObject({ jumlah: 4584840, page_number: 14 });
});

test('hasil yang beres: tanpa temuan aturan', () => {
  const t = periksaAturan({ record, ai: { suggested_codes: [s('D21.3', 'diagnosis'), s('86.3', 'procedure')] }, pages: [resume, tagihan], hitungInacbgDanTarif });
  expect(t).toEqual([]);
});

test('diagnosis sekunder tidak otomatis menaikkan severity atau memicu tuduhan upcoding', () => {
  const t = periksaAturan({ record, ai: { suggested_codes: [s('D21.3', 'diagnosis'), s('D64.9', 'diagnosis', 12), s('86.3', 'procedure')] }, pages: [resume, tagihan], hitungInacbgDanTarif });
  expect(t.some(x => x.jenis === 'potensi_upcoding')).toBe(false);
});

test('hasil tingkat II dengan kode sekunder yang belum didukung tetap memicu klarifikasi', () => {
  const hitung = () => ({ inacbgResult: { code: 'L-1-40-II' }, tarifResult: null });
  const t = periksaAturan({ record, ai: { suggested_codes: [s('D21.3', 'diagnosis'), s('D64.9', 'diagnosis', 12), s('86.3', 'procedure')] }, pages: [resume, tagihan], hitungInacbgDanTarif: hitung });
  expect(t.map(x => [x.jenis, x.keparahan])).toContainEqual(['potensi_upcoding', 'tinggi']);
  expect(t.find(x => x.jenis === 'potensi_upcoding').pesan).not.toMatch(/dipengaruhi/);
});

test('tarif jauh di bawah tagihan & operasi tanpa kode -> potensi rugi RS', () => {
  const t = periksaAturan({ record, ai: { suggested_codes: [s('D21.3', 'diagnosis')], konsistensi_data: [{ id: 'KD-OP', nama: 'Ada operasi, tetapi kode tindakan operasi belum ada', yang_ditemukan: { kutipan: 'Operasi Kecil', page_number: 13 } }] },
    pages: [resume, { ...tagihan, ocr_text: tagihan.ocr_text.replace('4,584,840', '9,584,840') }], hitungInacbgDanTarif });
  expect(t.filter(x => x.jenis === 'potensi_rugi_rs').length).toBe(2);
});

test('sesar dengan diagnosis utama bukan O -> inkonsistensi', () => {
  const t = periksaAturan({ record, ai: { suggested_codes: [s('Z35.9', 'diagnosis'), s('74.1', 'procedure')] }, pages: [resume], hitungInacbgDanTarif });
  expect(t.map(x => x.jenis)).toContain('inkonsistensi');
});

test('keberatan AI tanpa kutipan nyata dibuang; skor & pemicu Sol', async () => {
  const gateway = { panggilModel: jest.fn(async () => ({ ok: true, penggunaan: { total_tokens: 900 }, biaya: { idr: 2 }, model: 'gpt-6-luna', hasil: {
    kesimpulan: 'cek', keberatan: [
      { jenis: 'kode_terlewat', keparahan: 'tinggi', pesan: 'Eksisi tidak dikode', halaman: 3, kutipan: 'Eksisi dan PA', saran: 'kode 86.3' },
      { jenis: 'potensi_upcoding', keparahan: 'tinggi', pesan: 'karangan', halaman: 3, kutipan: 'tidak ada di halaman', saran: '-' },
    ] } })) };
  const r = await periksaKritis({ record, ai: { suggested_codes: [s('D21.3', 'diagnosis')] }, pages: [resume, tagihan], hitungInacbgDanTarif, gateway });
  expect(r.temuan.map(t => t.pesan)).toEqual(['Eksisi tidak dikode']);
  expect(r).toMatchObject({ skor_keyakinan: 75, tingkat: 'sedang', perlu_analisis_mendalam: true, tokens_used: 900 });
});

test('belajar: pasangan istilah resume -> kode casemix, tanpa angka/identitas', () => {
  const lembar = { diagnosis: [{ kode: 'D21.3', peran: 'utama' }], prosedur: [{ kode: '86.3' }, { kode: '90.59' }] };
  expect(ekstrakPasangan([resume], lembar)).toEqual([
    { jenis: 'diagnosis', kunci: 'tumor regio sternum subfascia', kode: 'D21.3', teks: 'Tumor regio sternum (subfascia)' },
    { jenis: 'prosedur', kunci: 'eksisi dan pa', kode: '86.3', teks: 'Eksisi dan PA' },
  ]);
  expect(kunciIstilah('KPD 3 hari, Oligohidramnion')).toBe('kpd oligohidramnion');
});

test('AI pemeriksa gagal (koneksi) -> diulang sekali, dan TIDAK dilaporkan aman', async () => {
  const gateway = { panggilModel: jest.fn(async () => ({ ok: false, error: 'fetch failed' })) };
  const r = await periksaKritis({ record, ai: { suggested_codes: [s('D21.3', 'diagnosis'), s('86.3', 'procedure')] }, pages: [resume, tagihan], hitungInacbgDanTarif, gateway });
  expect(gateway.panggilModel).toHaveBeenCalledTimes(2);
  expect(r).toMatchObject({ ai_gagal: true, tingkat: 'sedang', pesan_gangguan: 'fetch failed' });
  expect(r.skor_keyakinan).toBeLessThanOrEqual(70);
  expect(r.kesimpulan).toMatch(/belum berjalan/);
});

test('keberatan AI "kode tidak didukung" dibantah bila ada halaman hasil (EKG)', async () => {
  const ekg = { page_number: 8, ocr_text: 'Sinus tachycardia Abnormal ECG Vent. Rate QRS Duration' };
  const gateway = { panggilModel: jest.fn(async () => ({ ok: true, penggunaan: { total_tokens: 100 }, biaya: { idr: 1 }, model: 'gpt-6-luna', hasil: {
    keberatan: [{ jenis: 'kode_tidak_didukung', keparahan: 'sedang', pesan: 'Kode EKG 89.52 tidak didukung oleh bukti yang tersedia.', saran: 'Hapus 89.52.', kutipan: 'Tumor regio sternum', halaman: 3 }],
    kesimpulan: 'x' } })) };
  const ai = { suggested_codes: [s('D21.3', 'diagnosis'), s('86.3', 'procedure'), s('89.52', 'procedure', 8)],
    temuan_penunjang: [{ istilah_id: 'ekg', kode_usulan: '89.52', page_number: 8, jenis_halaman: 'ekg' }] };
  const r = await periksaKritis({ record, ai, pages: [resume, ekg, tagihan], hitungInacbgDanTarif, gateway });
  expect(r.temuan.some(t => /89\.52/.test(t.pesan))).toBe(false);
  expect(r.keberatan_dibantah_bukti).toEqual([expect.objectContaining({ kode: '89.52', halaman: 8 })]);
});
