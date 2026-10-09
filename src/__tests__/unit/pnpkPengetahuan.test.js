/**
 * Pengetahuan PNPK untuk agen: seluruh PNPK Katalog Pedoman tersusun berhalaman,
 * dipilih sesuai kode/usia/versi episode, dan dipakai agen tanpa boleh
 * mengutip PNPK/halaman di luar konteks.
 */
const pokok = require('../../data/pnpkPokok.json');
const katalog = require('../../data/katalogPedoman.json');
const svc = require('../../services/pnpkPengetahuanService');
const { nilaiDiagnosis } = require('../../services/penalaranDiagnosisService');
const { tanyaAgenCasemix } = require('../../services/agenCasemixInteraktifService');

const dewasa = { admission_date: '2026-10-01', umur_tahun: 50, birth_date: '1976-01-01', jenis_klaim: 'RAWAT_INAP' };
const anak = { admission_date: '2026-10-01', umur_tahun: 6, birth_date: '2020-01-01', jenis_klaim: 'RAWAT_INAP' };

describe('basis pengetahuan PNPK', () => {
  test('setiap PNPK katalog tersusun, berhalaman, dan terpetakan ke kode', () => {
    const pnpk = katalog.dokumen.filter(d => ['pnpk', 'pnpk_profesi'].includes(d.jenis));
    expect(pokok.dokumen.map(d => d.katalog_id).sort()).toEqual(pnpk.map(d => d.id).sort());
    for (const d of pokok.dokumen) {
      expect(d.bagian.length).toBeGreaterThan(0);
      expect(d.dx.length + d.px.length).toBeGreaterThan(0);
      for (const b of d.bagian) {
        expect(b.halaman).toBeGreaterThan(0);
        expect(b.halaman).toBeLessThanOrEqual(d.jumlah_halaman);
        expect(b.kutipan.length).toBeGreaterThan(100);
      }
    }
  });
  test('bagian pokok mencakup kriteria diagnosis dan indikasi rawat inap', () => {
    const topik = d => new Set(pokok.dokumen.find(x => x.katalog_id === d).bagian.map(b => b.topik));
    expect(topik('KMK-2021-4636').has('rawat_inap')).toBe(true); // dengue anak: Tabel 8 kriteria rawat inap
    expect(topik('KMK-2025-1168').has('kriteria_diagnosis')).toBe(true); // pneumonia dewasa: infiltrat + >=2 gejala
  });
});

describe('pemilihan PNPK untuk klaim', () => {
  test('usia: dengue anak vs dewasa', () => {
    expect(svc.dokumenUntukKlaim(anak, { dx: 'A91' }).map(d => d.katalog_id)).toEqual(['KMK-2021-4636']);
    expect(svc.dokumenUntukKlaim({ ...dewasa, umur_tahun: 30, birth_date: '1996-01-01' }, { dx: 'A91' }).map(d => d.katalog_id)).toEqual(['KMK-2020-9845']);
  });
  test('versi mengikuti tanggal awal episode', () => {
    expect(svc.dokumenUntukKlaim({ ...dewasa, admission_date: '2025-06-01' }, { dx: 'I10' })[0].katalog_id).toBe('KMK-2021-4634');
    expect(svc.dokumenUntukKlaim(dewasa, { dx: 'I10' })[0].katalog_id).toBe('KMK-2026-303');
  });
  test('pedoman tindakan dipilih dari kode prosedur', () => {
    expect(svc.dokumenUntukKlaim(dewasa, { dx: 'M54.5', px: '99.92' }).map(d => d.katalog_id)).toContain('KMK-2024-1933');
  });
  test('tanpa kartu: konteks prompt berhalaman dan menyertakan hasil aturan BA/PNPK', () => {
    process.env.AGEN_PAKAI_KARTU = 'false';
    const k = svc.konteksAgen(anak, { dx: 'A91', referensiKlaim: { temuan: [{ id: 'PNPK-X-01', nama: 'Uji', status: 'bukti_belum_cukup', bukti: [{ nama: 'Hasil X', status: 'bukti_belum_cukup' }] }] } });
    expect(k.teks).toMatch(/\[KMK-2021-4636\].*\n- .*\(hal\. \d+\)/);
    expect(k.teks).toMatch(/PNPK-X-01 Uji: bukti_belum_cukup; belum ada: Hasil X/);
    delete process.env.AGEN_PAKAI_KARTU;
  });
  test('pencarian isi PNPK menunjuk dokumen dan halaman', () => {
    const h = svc.cariPnpk('kriteria rawat inap', { kode: 'A91' });
    expect(h.length).toBeGreaterThan(0);
    expect(h[0]).toMatchObject({ katalog_id: expect.stringMatching(/^KMK-/), halaman: expect.any(Number) });
  });
});

describe('agen memakai PNPK', () => {
  test('penalaran diagnosis menerima PNPK; rujukan PNPK di luar konteks dibuang', async () => {
    process.env.AGEN_PAKAI_KARTU = 'false';
    let prompt = '';
    const gateway = { panggilModel: async (_t, m) => { prompt = m.prompt; return { ok: true, hasil: { diagnosis: [{ kode: 'A91', status: 'terkonfirmasi', alasan: 'x',
      mendukung: [{ jenis: 'penunjang', kutipan: 'NS1 positif', halaman: 2 }], melemahkan: [], belum_ada: [],
      pedoman: [
        { katalog_id: 'KMK-2021-4636', halaman: svc.dokumenUntukKlaim(anak, { dx: 'A91' })[0].bagian[0].halaman, syarat: 'tes diagnostik', status: 'terpenuhi', dasar: 'NS1 positif' },
        { katalog_id: 'KMK-2021-4636', halaman: 999, syarat: 'karangan', status: 'belum_ada' },
        { katalog_id: 'KMK-9999-1', halaman: 3, syarat: 'PNPK lain', status: 'bertentangan' },
      ] }] } }; } };
    const fakta = { fakta: [{ teks: 'NS1 positif', kutipan: 'NS1 positif', halaman: 2, kategori: 'penunjang' }], per_kategori: { penunjang: [{ teks: 'NS1 positif', halaman: 2 }] } };
    const r = await nilaiDiagnosis({ faktaKlinis: fakta, kodeDiagnosis: ['A91'], pages: [{ page_number: 2, ocr_text: 'NS1 positif' }], record: anak, gateway });
    expect(prompt).toMatch(/PEDOMAN PNPK YANG BERLAKU/);
    expect(r.diagnosis[0].pedoman).toHaveLength(1);
    expect(r.diagnosis[0].pedoman[0]).toMatchObject({ katalog_id: 'KMK-2021-4636', status: 'terpenuhi' });
    expect(r.pedoman_dipakai.map(d => d.katalog_id)).toEqual(['KMK-2021-4636']);
    delete process.env.AGEN_PAKAI_KARTU;
  });

  test('agen casemix interaktif dapat mencari isi PNPK', async () => {
    const jawaban = [{ langkah: 'cari_pnpk', teks: 'kriteria rawat inap', kode: 'A91' }, { langkah: 'jawab', jawaban: 'Lihat PNPK dengue anak.', rujukan: [] }];
    const prompts = [];
    const gateway = { panggilModel: async (_t, m) => { prompts.push(m.prompt); return { ok: true, hasil: jawaban.shift() }; } };
    const r = await tanyaAgenCasemix({ pertanyaan: 'Apa indikasi rawat inap?', record: { ...anak, diagnosa_list: 'A91' },
      pages: [{ page_number: 1, ocr_text: 'Resume' }], faktaKlinis: { fakta: [], per_kategori: {} }, laporan: null, gateway });
    expect(prompts[0]).toMatch(/KARTU PERSYARATAN|PNPK YANG BERLAKU/);
    expect(prompts[1]).toMatch(/"langkah":"cari_pnpk".*KMK-/);
    expect(r.jawaban).toBe('Lihat PNPK dengue anak.');
  });
});
