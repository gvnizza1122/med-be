/**
 * Resume Medis (IGD / rawat jalan poli) sebagai sumber pemeriksaan fisik dan
 * tanda vital -- permintaan klien 1 Okt 2026, menggantikan Opsi A 11 Sep 2026.
 *
 * SINTETIS, tata letak meniru berkas IGD anak dengan sesak (resume hal 2,
 * triase hal 4): ronki/wheezing hanya tertulis di pemeriksaan fisik dokter di
 * resume, dan dulu tidak pernah terbaca.
 */
const { assessKegawatdaruratan } = require('../../services/aiReviewService');

const RESUME = {
  page_number: 2,
  ocr_text: 'RESUME MEDIS IGD\nKu : sesak, cm\nca -/- si -/-\nth : sdv +/+, ronki +/+, wheezing +/+ retraksi dada -\n'
    + 'cor : dbn\nVital Sign\nBB TB TD Heart Rate RR Temp SpO2\n33 KG 163 Kali 32 Kali 36.2 94 %',
  confidence: 99,
};
const TRIASE = {
  page_number: 4,
  ocr_text: 'TRIAGE IGD\nVITAL SIGN\nHeart Rate 163 x/mnt\nRR 32 x/mnt\nKEADAAN\nThorak Normal\nSkor ESI : ESI 2',
  confidence: 99,
};

const parameter = (key, page_number, kutipan, status) => ({ key, ditemukan: true, status, nilai: kutipan, page_number, kutipan });

function mockModel(body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
      usage: { total_tokens: 100 },
    })),
  });
}

const promptTerkirim = () => {
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  return body.messages.map(m => m.content).join('\n');
};

beforeEach(() => { process.env.AI_PROVIDER_API_KEY = 'test-key'; });
afterEach(() => { delete process.env.AI_PROVIDER_API_KEY; jest.restoreAllMocks(); });

describe('dengan Triase IGD: Resume Medis IGD sebagai pelengkap', () => {
  beforeEach(() => mockModel({
    parameter_findings: [
      parameter('thorak', 4, 'Thorak Normal', 'normal'),
      parameter('ronkhi', 2, 'th : sdv +/+, ronki +/+, wheezing +/+ retraksi dada -', 'abnormal'),
      parameter('wheezing', 2, 'th : sdv +/+, ronki +/+, wheezing +/+ retraksi dada -', 'abnormal'),
      parameter('konjungtiva_anemis', 2, 'ca -/- si -/-', 'normal'),
    ],
    vital_findings: {
      HR: { nilai: 163, page_number: 4, kutipan: 'Heart Rate 163 x/mnt' },
      RR: { nilai: 32, page_number: 4, kutipan: 'RR 32 x/mnt' },
      // Tidak ada di triase -> boleh dari resume.
      SpO2: { nilai: 94, page_number: 2, kutipan: '33 KG 163 Kali 32 Kali 36.2 94 %' },
    },
    k1: { status: 'tidak' },
    tindakan_keperawatan: [],
    esi: { skor: 2, page_number: 4, kutipan: 'Skor ESI : ESI 2' },
  }));

  test('prompt memuat Resume Medis IGD berlabel PELENGKAP', async () => {
    await assessKegawatdaruratan([RESUME, TRIASE], [4], 10, null, [], [2]);
    expect(promptTerkirim()).toContain('=== RESUME MEDIS (PELENGKAP) ===');
    expect(promptTerkirim()).toContain('ronki +/+');
  });

  test('ronki & wheezing dari pemeriksaan fisik resume terbaca, bersumber resume_medis', async () => {
    const r = await assessKegawatdaruratan([RESUME, TRIASE], [4], 10, null, [], [2]);
    const per = Object.fromEntries(r.parameter_findings.map(p => [p.key, p]));
    expect(per.ronkhi).toMatchObject({ ditemukan: true, status: 'abnormal', page_number: 2, sumber_dokumen: 'resume_medis' });
    expect(per.wheezing).toMatchObject({ ditemukan: true, status: 'abnormal', sumber_dokumen: 'resume_medis' });
    expect(per.konjungtiva_anemis).toMatchObject({ ditemukan: true, status: 'normal' });
    expect(per.thorak).toMatchObject({ sumber_dokumen: 'triase_igd' });
  });

  test('vital: triase tetap dipakai, yang kosong di triase diisi dari resume', async () => {
    const r = await assessKegawatdaruratan([RESUME, TRIASE], [4], 10, null, [], [2]);
    expect(r.vital_findings.HR).toMatchObject({ nilai: 163, page_number: 4, sumber_dokumen: 'triase_igd' });
    expect(r.vital_findings.SpO2).toMatchObject({ nilai: 94, page_number: 2, sumber_dokumen: 'resume_medis' });
  });

  test('ronki/wheezing abnormal ikut menjadi bukti K2', async () => {
    const r = await assessKegawatdaruratan([RESUME, TRIASE], [4], 10, null, [], [2]);
    const k2 = r.kriteria.find(k => k.kriteria === 'K2');
    expect(k2.status).toBe('ya');
    expect(JSON.stringify(k2.evidence || k2)).toMatch(/ronkhi|wheezing/);
  });
});

describe('tanpa Triase IGD (klaim poli rawat jalan): Resume Medis menjadi sumber utama', () => {
  beforeEach(() => mockModel({
    parameter_findings: [parameter('wheezing', 2, 'th : sdv +/+, ronki +/+, wheezing +/+ retraksi dada -', 'abnormal')],
    vital_findings: { HR: { nilai: 163, page_number: 2, kutipan: '33 KG 163 Kali 32 Kali 36.2 94 %' } },
    k1: { status: 'tidak' },
    tindakan_keperawatan: [],
    esi: null,
  }));

  test('penilaian tetap dijalankan dan membaca resume', async () => {
    const r = await assessKegawatdaruratan([RESUME], [], 10, null, [], [2]);
    expect(global.fetch).toHaveBeenCalled();
    expect(promptTerkirim()).toContain('=== RESUME MEDIS (SUMBER UTAMA - TRIASE IGD TIDAK ADA) ===');
    expect(r.parameter_findings.find(p => p.key === 'wheezing')).toMatchObject({ ditemukan: true, sumber_dokumen: 'resume_medis' });
    expect(r.vital_findings.HR).toMatchObject({ nilai: 163, sumber_dokumen: 'resume_medis' });
  });

  test('tanpa triase, resume, maupun dokumen fallback -> tidak dijalankan', async () => {
    const r = await assessKegawatdaruratan([{ page_number: 1, ocr_text: 'SURAT ELEGIBILITAS PESERTA' }], [], 10, null, [], []);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(r.has_data).toBe(false);
  });
});

describe('Resume Medis RAWAT INAP: ditampilkan, tidak ikut menilai K1-K5', () => {
  const RANAP = {
    page_number: 6,
    ocr_text: 'RESUME MEDIS RAWAT INAP\nPemeriksaan fisik: pulmo ronki +/+\nNadi 170 x/mnt',
    confidence: 99,
  };
  beforeEach(() => mockModel({
    parameter_findings: [parameter('ronkhi', 6, 'pulmo ronki +/+', 'abnormal')],
    vital_findings: { HR: { nilai: 170, page_number: 6, kutipan: 'Nadi 170 x/mnt' } },
    k1: { status: 'tidak' },
    tindakan_keperawatan: [],
    esi: null,
  }));

  test('temuan & vital dari resume rawat inap tampil, tapi K2/K4 tidak terpicu olehnya', async () => {
    const r = await assessKegawatdaruratan([TRIASE, RANAP], [4], 10, null, [], [6]);
    expect(r.parameter_findings.find(p => p.key === 'ronkhi')).toMatchObject({ ditemukan: true, sumber_dokumen: 'resume_medis' });
    expect(r.vital_findings.HR).toMatchObject({ nilai: 170, sumber_dokumen: 'resume_medis' });
    expect(r.kriteria.find(k => k.kriteria === 'K2').status).toBe('tidak');
    expect(r.kriteria.find(k => k.kriteria === 'K4').status).toBe('tidak');
  });
});

describe('vital yang dilaporkan null tidak berubah menjadi "tertulis 0"', () => {
  beforeEach(() => mockModel({
    parameter_findings: [],
    vital_findings: {
      SpO2: { nilai: null, page_number: null, kutipan: null },
      TD_sistolik: { nilai: '', page_number: null, kutipan: null },
      HR: { nilai: 0, page_number: 4, kutipan: 'Heart Rate 163 x/mnt' },
    },
    k1: { status: 'tidak' }, tindakan_keperawatan: [], esi: null,
  }));

  test('null / "" -> belum tercatat, bukan tercatat_nol; angka 0 asli tetap tercatat_nol', async () => {
    const r = await assessKegawatdaruratan([RESUME, TRIASE], [4], 10, null, [], [2]);
    expect(r.vital_findings.SpO2.tercatat_nol).toBeUndefined();
    expect(r.vital_findings.TD_sistolik.tercatat_nol).toBeUndefined();
    expect(r.vital_findings.HR.tercatat_nol).toBe(true);
  });
});

describe('pending dari kriteria kegawatdaruratan', () => {
  const { kegawatdaruratanMemicuPending } = require('../../services/kegawatdaruratanAggregation');
  const { susunPutusan } = require('../../services/putusanPendingService');
  const { bentukPutusan } = require('../../services/putusanPendingAiService');
  const penilaian = (kunjungan_igd, ...status) => ({
    kunjungan_igd, has_data: true,
    kriteria: status.map((st, i) => ({ kriteria: `K${i + 1}`, status: st, catatan: st === 'borderline' ? 'TD_sistolik=141' : '' })),
  });

  test('IGD tanpa kriteria terpenuhi -> pending', () => {
    expect(kegawatdaruratanMemicuPending(penilaian(true, 'tidak', 'tidak', 'tidak', 'tidak', 'tidak'))).toBe(true);
  });

  test('IGD hanya borderline -> tetap pending (belum terpenuhi)', () => {
    expect(kegawatdaruratanMemicuPending(penilaian(true, 'tidak', 'tidak', 'tidak', 'borderline', 'tidak'))).toBe(true);
  });

  test('IGD dengan minimal satu kriteria "ya" -> tidak pending', () => {
    expect(kegawatdaruratanMemicuPending(penilaian(true, 'tidak', 'ya', 'tidak', 'borderline', 'tidak'))).toBe(false);
  });

  test('kunjungan poli tidak pernah pending karena kriteria', () => {
    expect(kegawatdaruratanMemicuPending(penilaian(false, 'tidak', 'tidak', 'tidak', 'tidak', 'tidak'))).toBe(false);
    expect(kegawatdaruratanMemicuPending(penilaian(undefined, 'tidak'))).toBe(false);
  });

  test('penilaian tidak dijalankan -> tidak pending', () => {
    expect(kegawatdaruratanMemicuPending({ kunjungan_igd: true, has_data: false, kriteria: [] })).toBe(false);
    expect(kegawatdaruratanMemicuPending(null)).toBe(false);
  });

  test('putusan: IGD tanpa kriteria -> alasan wajib berisiko pending, borderline disebut', () => {
    const p = susunPutusan({ kegawatdaruratan_assessment: penilaian(true, 'tidak', 'tidak', 'tidak', 'borderline', 'tidak') }, []);
    expect(p.status).toBe('berisiko_pending');
    const a = p.alasan.find(x => x.kode === 'KGD-IGD');
    expect(a).toMatchObject({ ringkas: 'Kunjungan IGD tidak memenuhi kriteria kegawatdaruratan', wajib_pending: true });
    expect(a.penjelasan).toMatch(/K4 \(TD_sistolik=141\)/);
  });

  test('putusan: poli atau IGD dengan kriteria ya -> tidak ada alasan KGD-IGD', () => {
    expect(susunPutusan({ kegawatdaruratan_assessment: penilaian(false, 'tidak') }, []).alasan).toEqual([]);
    expect(susunPutusan({ kegawatdaruratan_assessment: penilaian(true, 'ya') }, []).alasan).toEqual([]);
  });

  test('AI tidak boleh menggugurkan alasan wajib', () => {
    const kandidat = susunPutusan({ kegawatdaruratan_assessment: penilaian(true, 'tidak') }, []);
    const hasil = bentukPutusan(kandidat, { status: 'tidak_ditemukan_alasan', alasan_ids: [] });
    expect(hasil.ok).toBe(true);
    expect(hasil.putusan.status).toBe('berisiko_pending');
    expect(hasil.putusan.alasan.map(a => a.kode)).toEqual(['KGD-IGD']);
  });
});
