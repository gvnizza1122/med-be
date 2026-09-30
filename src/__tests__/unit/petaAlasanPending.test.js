/**
 * Pemetaan alasan pending -> kategori + pemisahan rawat jalan/inap.
 * Data sintetis. AI ditiru lewat parameter `panggil`.
 */
const {
  KATEGORI, petakanDenganAturan, tentukanJenis, jenisDariLabel, petakanDenganAi, petakanBaris, koreksiKategori, ringkasan,
} = require('../../services/petaAlasanPendingService');

describe('petakanDenganAturan', () => {
  test('alasan kegawatan yang paling sering muncul', () => {
    const r = petakanDenganAturan('Harap cek kembali penagihan kondisi kegawatan');
    expect(r.kategori).toBe('kegawatdaruratan');
    expect(r.aturan_id).toBe('gawat_1');
  });

  test.each([
    ['Kode diagnosis sekunder tidak sesuai dengan resume', 'kode_diagnosis'],
    ['Mohon cek kode tindakan ICD-9 yang diajukan', 'kode_tindakan'],
    ['Lampirkan hasil laboratorium', 'hasil_penunjang'],
    ['Lampirkan resume medis pasien', 'dokumen_tidak_lengkap'],
    ['Indikasi rawat inap belum jelas', 'indikasi_rawat_inap'],
    ['Pasien PRB obat kronis diberikan di RS', 'prb_obat_kronis'],
    ['Kunjungan berulang pasien yang sama pada hari yang sama', 'kunjungan_berulang'],
    ['Perawatan ICU tidak ada bukti', 'icu_ventilator'],
  ])('%s -> %s', (alasan, kategori) => {
    expect(petakanDenganAturan(alasan).kategori).toBe(kategori);
  });

  test('tanda baca dan huruf besar tidak berpengaruh', () => {
    expect(petakanDenganAturan('  KEGAWATAN!!!  ').kategori).toBe('kegawatdaruratan');
  });

  test('kategori lain yang ikut cocok dicatat', () => {
    const r = petakanDenganAturan('Kegawatan tidak sesuai, cek kode diagnosis');
    expect(r.kategori).toBe('kegawatdaruratan');
    expect(r.kategori_lain).toContain('kode_diagnosis');
  });

  test('teks tanpa kata kunci dikenal -> tidak_terpetakan', () => {
    expect(petakanDenganAturan('xyz qwerty').kategori).toBe('tidak_terpetakan');
    expect(petakanDenganAturan('').kategori).toBe('tidak_terpetakan');
    expect(petakanDenganAturan(null).kategori).toBe('tidak_terpetakan');
  });

  test('semua kategori aturan ada di daftar KATEGORI', () => {
    const { ATURAN } = require('../../services/petaAlasanPendingService');
    for (const a of ATURAN) expect(KATEGORI).toContain(a.kategori);
  });
});

describe('jenis rawat jalan / inap', () => {
  test('label sheet dan nilai klaim dikenali', () => {
    expect(jenisDariLabel('RJ')).toBe('rawat_jalan');
    expect(jenisDariLabel('RI')).toBe('rawat_inap');
    expect(jenisDariLabel('RAWAT_INAP')).toBe('rawat_inap');
    expect(jenisDariLabel('Rawat Jalan')).toBe('rawat_jalan');
    expect(jenisDariLabel('Pending Lain')).toBeNull();
    expect(jenisDariLabel(null)).toBeNull();
  });

  test('rekap didahulukan; klaim jadi cadangan', () => {
    expect(tentukanJenis({ jenis_klaim: 'RI' }, { jenis_klaim: 'RAWAT_INAP' }))
      .toEqual({ jenis: 'rawat_inap', sumber: 'rekap', jenis_konflik: false });
    expect(tentukanJenis({ jenis_klaim: 'Sheet1' }, { jenis_klaim: 'RAWAT_JALAN' }))
      .toEqual({ jenis: 'rawat_jalan', sumber: 'klaim', jenis_konflik: false });
  });

  test('konflik rekap vs klaim ditandai, bukan disembunyikan', () => {
    const j = tentukanJenis({ jenis_klaim: 'RJ' }, { jenis_klaim: 'RAWAT_INAP' });
    expect(j.jenis).toBe('rawat_jalan');
    expect(j.jenis_konflik).toBe(true);
  });

  test('tidak diketahui bila keduanya kosong', () => {
    expect(tentukanJenis({}, null)).toEqual({ jenis: 'tidak_diketahui', sumber: null, jenis_konflik: false });
  });
});

describe('petakanDenganAi', () => {
  test('menyamarkan identitas lewat parameter dikenal dan menerima kategori sah', async () => {
    const panggil = jest.fn().mockResolvedValue({ ok: true, hasil: { kategori: 'kode_diagnosis' }, model: 'luna-x' });
    const r = await petakanDenganAi('teks aneh', { nama: 'BUDI TEST' }, { panggil });
    expect(r).toEqual({ kategori: 'kode_diagnosis', model: 'luna-x' });
    expect(panggil.mock.calls[0][0]).toBe('petakan_alasan_pending');
    expect(panggil.mock.calls[0][1].dikenal).toEqual({ nama: 'BUDI TEST' });
  });

  test('kategori di luar daftar ditolak', async () => {
    const panggil = jest.fn().mockResolvedValue({ ok: true, hasil: { kategori: 'karangan_baru' } });
    expect(await petakanDenganAi('x', {}, { panggil })).toBeNull();
  });

  test('model gagal -> null', async () => {
    const panggil = jest.fn().mockResolvedValue({ ok: false, error: 'HTTP 500' });
    expect(await petakanDenganAi('x', {}, { panggil })).toBeNull();
  });
});

/** DB tiruan untuk petakanBaris/koreksi/ringkasan. */
function dbTiruan({ baris = [], pending = null } = {}) {
  const peta = new Map();
  const upserts = [];
  return {
    peta, upserts,
    prepare: (sql) => ({
      all: async () => {
        if (/FROM bpjs_pending_responses bpr/.test(sql) && /LEFT JOIN pending_alasan_peta m/.test(sql)) {
          return baris.map((b) => ({ ...b, ...(peta.get(b.id) ? { peta_sumber: peta.get(b.id).sumber, kategori: peta.get(b.id).kategori, jenis_rawat: peta.get(b.id).jenis_rawat } : {}) }));
        }
        return [];
      },
      get: async () => pending,
      run: async (...p) => {
        if (/INSERT INTO pending_alasan_peta/.test(sql)) {
          const [id, kategori] = p;
          const ada = peta.get(id);
          if (!(ada && ada.sumber === 'manual' && !/'manual'/.test(sql.split('VALUES')[1]))) {
            // meniru ON CONFLICT ... WHERE sumber <> 'manual'
          }
          if (/VALUES \(\?, \?, 'manual'/.test(sql)) peta.set(id, { kategori, sumber: 'manual', jenis_rawat: p[2] });
          else if (!ada || ada.sumber !== 'manual') peta.set(id, { kategori, sumber: p[2], jenis_rawat: p[6] });
          upserts.push({ sql, p });
        }
        return { changes: 1 };
      },
    }),
  };
}

describe('petakanBaris', () => {
  const baris = [
    { id: 'p1', sep: 'S1', alasan_raw: 'Harap cek kembali penagihan kondisi kegawatan', jenis_klaim: 'RJ' },
    { id: 'p2', sep: 'S2', alasan_raw: 'Kode diagnosis tidak sesuai', jenis_klaim: 'RI', klaim_jenis_klaim: 'RAWAT_INAP' },
    { id: 'p3', sep: 'S3', alasan_raw: 'ada yang janggal di sini', jenis_klaim: 'RI', nama_peserta: 'BUDI TEST' },
  ];

  test('aturan dulu; AI hanya untuk yang tersisa', async () => {
    const db = dbTiruan({ baris });
    const panggil = jest.fn().mockResolvedValue({ ok: true, hasil: { kategori: 'dokumen_tidak_lengkap' }, model: 'm' });
    const r = await petakanBaris(db, { panggil });
    expect(r).toMatchObject({ diperiksa: 3, oleh_aturan: 2, oleh_ai: 1, tidak_terpetakan: 0 });
    expect(panggil).toHaveBeenCalledTimes(1);
    // identitas dikenal dari baris diteruskan untuk penyamaran
    expect(panggil.mock.calls[0][1].dikenal).toMatchObject({ nama: 'BUDI TEST', sep: 'S3' });
    expect(db.peta.get('p1')).toMatchObject({ kategori: 'kegawatdaruratan', sumber: 'aturan', jenis_rawat: 'rawat_jalan' });
    expect(db.peta.get('p3')).toMatchObject({ kategori: 'dokumen_tidak_lengkap', sumber: 'ai' });
  });

  test('tanpa AI (pakaiAi=false) sisa jadi tidak_terpetakan dan model tidak dipanggil', async () => {
    const db = dbTiruan({ baris });
    const panggil = jest.fn();
    const r = await petakanBaris(db, { panggil, pakaiAi: false });
    expect(panggil).not.toHaveBeenCalled();
    expect(r.tidak_terpetakan).toBe(1);
  });

  test('AI gagal -> tidak_terpetakan, bukan dikarang', async () => {
    const db = dbTiruan({ baris });
    const panggil = jest.fn().mockResolvedValue({ ok: false, error: 'x' });
    const r = await petakanBaris(db, { panggil });
    expect(r.ai_gagal).toBe(1);
    expect(db.peta.get('p3').kategori).toBe('tidak_terpetakan');
  });

  test('alasan identik hanya memanggil AI sekali', async () => {
    const db = dbTiruan({ baris: [
      { id: 'a', sep: 'S1', alasan_raw: 'sesuatu yang aneh', jenis_klaim: 'RJ' },
      { id: 'b', sep: 'S2', alasan_raw: 'Sesuatu   yang ANEH!', jenis_klaim: 'RJ' },
    ] });
    const panggil = jest.fn().mockResolvedValue({ ok: true, hasil: { kategori: 'kode_tindakan' } });
    await petakanBaris(db, { panggil });
    expect(panggil).toHaveBeenCalledTimes(1);
    expect(db.peta.get('b').kategori).toBe('kode_tindakan');
  });

  test('koreksi manual tidak ditimpa pemetaan ulang', async () => {
    const db = dbTiruan({ baris: [baris[0]], pending: { id: 'p1', jenis_klaim: 'RJ' } });
    await koreksiKategori(db, 'p1', 'kode_diagnosis', 'u1');
    expect(db.peta.get('p1')).toMatchObject({ kategori: 'kode_diagnosis', sumber: 'manual' });
    const r = await petakanBaris(db, { ulang: true, pakaiAi: false });
    expect(r.dilewati_manual).toBe(1);
    expect(db.peta.get('p1').kategori).toBe('kode_diagnosis');
  });

  test('SQL pemetaan melindungi baris manual di sisi DB juga', async () => {
    const db = dbTiruan({ baris: [baris[0]] });
    await petakanBaris(db, {});
    expect(db.upserts[0].sql).toMatch(/WHERE pending_alasan_peta\.sumber <> 'manual'/);
  });

  test('konflik jenis dihitung', async () => {
    const db = dbTiruan({ baris: [{ id: 'k', sep: 'S', alasan_raw: 'kegawatan', jenis_klaim: 'RJ', klaim_jenis_klaim: 'RAWAT_INAP' }] });
    const r = await petakanBaris(db, { pakaiAi: false });
    expect(r.konflik_jenis).toBe(1);
  });
});

describe('koreksiKategori', () => {
  test('kategori tidak dikenal ditolak', async () => {
    await expect(koreksiKategori(dbTiruan({ pending: { id: 'x' } }), 'x', 'ngawur', 'u')).rejects.toMatchObject({ kode: 'kategori_tidak_valid' });
  });
  test('pending tidak ada -> tidak_ada', async () => {
    await expect(koreksiKategori(dbTiruan({ pending: undefined }), 'x', 'kode_diagnosis', 'u')).rejects.toMatchObject({ kode: 'tidak_ada' });
  });
});

describe('ringkasan', () => {
  test('menghitung per kategori x jenis dengan pangsa, tanpa persentase keyakinan', async () => {
    const db = {
      prepare: () => ({
        all: async () => [
          ...Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, sep: 'S', alasan_raw: 'Harap cek kembali penagihan kondisi kegawatan', kategori: 'kegawatdaruratan', jenis_rawat: i < 4 ? 'rawat_jalan' : 'rawat_inap' })),
          { id: 'd1', sep: 'S', alasan_raw: 'kode salah', kategori: 'kode_diagnosis', jenis_rawat: 'rawat_inap' },
        ],
      }),
    };
    const r = await ringkasan(db, {});
    expect(r.total).toBe(6);
    expect(r.per_kategori[0]).toMatchObject({ kategori: 'kegawatdaruratan', total: 5, rawat_jalan: 4, rawat_inap: 1 });
    expect(r.per_kategori[0].pangsa).toBeCloseTo(0.8333, 3);
    expect(r.alasan_teratas[0].jumlah).toBe(5);
    expect(JSON.stringify(r)).not.toMatch(/confidence|keyakinan|persen/i);
  });
});
