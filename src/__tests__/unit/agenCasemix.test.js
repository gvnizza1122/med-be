const { susunFaktaKlinis, faktaUntukPrompt } = require('../../services/faktaKlinisService');
const { nilaiDiagnosis } = require('../../services/penalaranDiagnosisService');
const { susunKronologi, ambilTanggal, ambilJam } = require('../../services/kronologiService');
const { susunLaporanCasemix } = require('../../services/agenCasemixService');
const { tanyaAgenCasemix } = require('../../services/agenCasemixInteraktifService');
const { cariRegulasi, labelSumber, semuaButir } = require('../../services/registriRegulasiService');

const pages = [
  { page_number: 2, ocr_text: 'RESUME MEDIS RAWAT INAP\nKeluhan Utama : sesak napas 3 hari\nRiwayat Penyakit : hipertensi\n• Asma\nPemeriksaan Fisik : ronki +/+ edema tungkai\nDiagnosis Utama : CHF\nTerapi : furosemid inj 2x20 mg\nDokter Penanggung Jawab\ndr. Contoh' },
  { page_number: 5, ocr_text: 'HASIL PEMERIKSAAN EKG\nKesimpulan : sinus takikardi, LVH' },
];
const record = { jenis_klaim: 'RAWAT_INAP', kelas_rawat: '3', diagnosa_list: 'I50.0', prosedur_list: '' };
const gw = (...jawaban) => {
  const fn = jest.fn();
  for (const j of jawaban) fn.mockResolvedValueOnce(j === null ? { ok: false, error: 'timeout' } : { ok: true, hasil: j, penggunaan: { total_tokens: 500 }, biaya: { idr: 2 }, model: 'gpt-6-luna' });
  return { panggilModel: fn };
};

describe('fakta klinis', () => {
  test('membaca label resume per kategori, melewati opsi checklist & tanda tangan', () => {
    const { fakta, per_kategori } = susunFaktaKlinis(pages, {});
    expect(per_kategori.keluhan[0]).toMatchObject({ teks: 'sesak napas 3 hari', halaman: 2 });
    expect(per_kategori.riwayat.map(f => f.teks)).toEqual(['hipertensi']);
    expect(per_kategori.terapi[0]).toMatchObject({ teks: 'furosemid inj 2x20 mg', kelas_obat: 'diuretik' });
    expect(fakta.some(f => /dr\. Contoh|Asma/.test(f.teks))).toBe(false);
    expect(faktaUntukPrompt({ per_kategori })).toMatch(/KELUHAN[\s\S]*sesak napas/);
  });
});

describe('penalaran diagnosis', () => {
  const faktaKlinis = susunFaktaKlinis(pages, {});

  test('bukti berkutipan dipertahankan; kutipan karangan dibuang; terkonfirmasi tanpa bukti diturunkan', async () => {
    const g = gw({
      diagnosis: [
        { kode: 'I50.0', status: 'terkonfirmasi', alasan: 'sesak, edema, diuretik', mendukung: [{ jenis: 'fisik', kutipan: 'ronki +/+ edema tungkai', halaman: 2 }, { kutipan: 'tidak ada di berkas', halaman: 2 }] },
        { kode: 'I10', status: 'terkonfirmasi', mendukung: [{ kutipan: 'karangan', halaman: 2 }] },
      ],
      kondisi_tersirat: [], pertanyaan_klarifikasi: [{ untuk: 'dokter', pertanyaan: 'Apakah hipertensi ditangani?' }], ringkasan: 'ok',
    });
    const r = await nilaiDiagnosis({ faktaKlinis, kodeDiagnosis: ['I50.0', 'I10'], pages, record, gateway: g });
    expect(r.status).toBe('selesai');
    expect(r.diagnosis[0]).toMatchObject({ kode: 'I50.0', peran: 'utama', status: 'terkonfirmasi' });
    expect(r.diagnosis[0].mendukung).toHaveLength(1);
    expect(r.diagnosis[1]).toMatchObject({ kode: 'I10', status: 'perlu_klarifikasi' });
    expect(r.pertanyaan_klarifikasi[0].untuk).toBe('dokter');
  });

  test('gagal dua kali -> status gagal, tidak melempar', async () => {
    const g = gw(null, null);
    const r = await nilaiDiagnosis({ faktaKlinis, kodeDiagnosis: ['I50.0'], pages, record, gateway: g });
    expect(g.panggilModel).toHaveBeenCalledTimes(2);
    expect(r.status).toBe('gagal');
  });

  test('tanpa kode atau dimatikan -> tidak memanggil AI', async () => {
    const g = gw();
    expect((await nilaiDiagnosis({ faktaKlinis, kodeDiagnosis: [], pages, gateway: g })).status).toBe('tidak_dinilai');
    process.env.PENALARAN_DIAGNOSIS_AI = 'false';
    expect((await nilaiDiagnosis({ faktaKlinis, kodeDiagnosis: ['I50.0'], pages, gateway: g })).status).toBe('dimatikan');
    delete process.env.PENALARAN_DIAGNOSIS_AI;
    expect(g.panggilModel).not.toHaveBeenCalled();
  });
});

describe('kronologi', () => {
  test('format tanggal & jam', () => {
    expect(ambilTanggal('Tgl : 2 Jan 2026')).toBe('2026-01-02');
    expect(ambilTanggal('31/12/2025')).toBe('2025-12-31');
    expect(ambilTanggal('tanpa tanggal')).toBeNull();
    expect(ambilJam('pukul 08.30')).toBe('08:30');
  });

  test('tanggal diambil setelah label (tanggal lahir tidak terbaca sebagai operasi)', () => {
    const k = susunKronologi([{ page_number: 11, ocr_text: 'LAPORAN OPERASI\nNama Pasien Tgl Lahir 19/01/2004 Tgl Operasi : 02/01/2026\nJam mulai 09:15\nNama Operasi : Eksisi\nAhli Bedah : dr. X\nJenis Anestesi : GA' }]);
    const op = k.find(e => e.peristiwa === 'Operasi');
    expect(op).toMatchObject({ tanggal: '2026-01-02', jam: '09:15', halaman: 11 });
    expect(k.some(e => e.tanggal === '2004-01-19')).toBe(false);
  });
});

describe('laporan casemix', () => {
  const hitung = jest.fn((dx) => ({ inacbgResult: { code: dx.includes('I10') ? 'I-4-12-II' : 'I-4-12-I', description: 'Gagal jantung' }, tarifResult: { amount: dx.includes('I10') ? 5000000 : 4000000 } }));
  const ai = {
    penalaran_diagnosis: {
      status: 'selesai', ringkasan: 'CHF didukung.', pertanyaan_klarifikasi: [{ untuk: 'dokter', pertanyaan: 'Hipertensi ditangani?' }], kondisi_tersirat: [],
      diagnosis: [
        { kode: 'I50.0', peran: 'utama', status: 'terkonfirmasi', alasan: 'x', mendukung: [{ kutipan: 'edema tungkai', halaman: 2 }], melemahkan: [], belum_ada: [] },
        { kode: 'I10', peran: 'sekunder', status: 'belum_cukup_bukti', alasan: 'y', mendukung: [], melemahkan: [], belum_ada: ['terapi antihipertensi'] },
      ],
    },
    kegawatdaruratan_assessment: { kunjungan_igd: true, kriteria: [{ kriteria: 'K3', status: 'ya' }] },
  };
  const rec = { ...record, diagnosa_list: 'I50.0;I10' };

  test('status per kode, pertanyaan, regulasi bersumber, alternatif sah dengan selisih tarif dari grouper', () => {
    const l = susunLaporanCasemix({ record: rec, ai, faktaKlinis: susunFaktaKlinis(pages, ai), saran: {}, hitungInacbgDanTarif: hitung, kronologi: [] });
    expect(l.status).toBe('perlu_klarifikasi');
    expect(l.rekomendasi_koding.map(r => [r.kode, r.status])).toEqual([['I50.0', 'didukung_bukti'], ['I10', 'belum_cukup_bukti']]);
    expect(l.pertanyaan_klarifikasi[0].pertanyaan).toBe('Hipertensi ditangani?');
    const igd = l.persyaratan.find(s => /kegawatdaruratan/i.test(s.syarat));
    expect(igd).toMatchObject({ status: 'terpenuhi', regulasi: { id: 'PMK-47-2018', berlaku: true } });
    const alt = l.alternatif_koding.alternatif.find(a => a.jenis === 'kepatuhan');
    expect(alt).toMatchObject({ diagnosis: ['I50.0'], inacbg: 'I-4-12-I', selisih_tarif: -1000000 });
    expect(l.catatan).toMatch(/milik dokter/);
  });
});

describe('agen casemix interaktif', () => {
  const faktaKlinis = susunFaktaKlinis(pages, {});

  test('memakai alat lalu menjawab; rujukan palsu dibuang dan diberi catatan', async () => {
    const g = gw(
      { langkah: 'cari_teks', teks: 'furosemid' },
      { langkah: 'jawab', jawaban: 'CHF didukung edema dan diuretik.', rujukan: [{ halaman: 2, kutipan: 'Terapi : furosemid inj 2x20 mg' }, { halaman: 2, kutipan: 'kalimat karangan' }] },
    );
    const r = await tanyaAgenCasemix({ pertanyaan: 'Kenapa CHF?', record, pages, faktaKlinis, laporan: null, gateway: g });
    expect(g.panggilModel).toHaveBeenCalledTimes(2);
    expect(g.panggilModel.mock.calls[0][0]).toBe('agen_casemix');
    expect(g.panggilModel.mock.calls[1][1].prompt).toMatch(/hal 2: Terapi : furosemid/);
    expect(r.rujukan).toEqual([{ halaman: 2, kutipan: 'Terapi : furosemid inj 2x20 mg' }]);
    expect(r.jawaban).toMatch(/1 rujukan tidak ditemukan/);
    expect(r).toMatchObject({ langkah: 2, tokens_used: 1000, biaya_idr: 4 });
  });

  test('alat regulasi & fakta tersedia; gangguan AI tidak melempar', async () => {
    const g = gw({ langkah: 'cari_regulasi', teks: 'kegawatdaruratan' }, { langkah: 'lihat_fakta', kategori: 'terapi' }, null);
    const r = await tanyaAgenCasemix({ pertanyaan: 'Syarat IGD?', record, pages, faktaKlinis, laporan: null, gateway: g });
    expect(g.panggilModel.mock.calls[1][1].prompt).toMatch(/PMK-47-2018/);
    expect(g.panggilModel.mock.calls[2][1].prompt).toMatch(/furosemid inj/);
    expect(r.gagal).toBe(true);
  });

  test('pertanyaan kosong tidak memanggil AI', async () => {
    const g = gw();
    const r = await tanyaAgenCasemix({ pertanyaan: '  ', record, pages, faktaKlinis, gateway: g });
    expect(r.jawaban).toMatch(/kosong/);
    expect(g.panggilModel).not.toHaveBeenCalled();
  });
});

describe('registri regulasi', () => {
  test('sumber bernomor & berversi; butir dari data aturan ikut terindeks', () => {
    expect(labelSumber('PMK-3-2023')).toMatchObject({ nomor: '3 Tahun 2023', berlaku: true });
    expect(labelSumber('TIDAK-ADA')).toBeNull();
    expect(semuaButir().some(b => b.kode === 'SP-01')).toBe(true);
    const r = cariRegulasi('pneumonia gram');
    expect(r.some(x => x.kode === 'SP-01' && x.sumber.id === 'REKAP-PENDING-RS')).toBe(true);
    expect(cariRegulasi('')).toEqual([]);
  });
});

describe('referensi pending (RAG aman)', () => {
  test('skema lama -> kosong, tanpa contoh acak; agen tetap menjawab', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = { prepare: () => ({ all: async () => { throw Error('column e.verification_status does not exist'); } }) };
    const g = gw({ langkah: 'cari_referensi_pending', teks: 'pemeriksaan gram' }, { langkah: 'jawab', jawaban: 'Draf: [isi: hasil gram]', rujukan: [] });
    const r = await tanyaAgenCasemix({ pertanyaan: 'Draf jawaban pending pneumonia', record, pages, faktaKlinis: susunFaktaKlinis(pages, {}), db, gateway: g });
    expect(g.panggilModel.mock.calls[1][1].prompt).toMatch(/belum ada referensi terverifikasi/);
    expect(r.jawaban).toMatch(/\[isi: hasil gram\]/);
    warn.mockRestore();
  });
});
