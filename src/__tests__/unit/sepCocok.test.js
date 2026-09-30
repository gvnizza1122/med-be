/**
 * Pencocokan SEP rekap pending vs klaim. Data sintetis, tanpa data pasien.
 */
const {
  normalisasiSep, bangunIndeksKlaim, cocokkanSatu, hitungStatistik, tautkanUlang, statistikDariDb, STATUS,
} = require('../../services/sepCocokService');

const SEP_A = '0170R0110826V003068';
const SEP_B = '0170R0110826V000001';
const SEP_MEI = '0170R0110526V000012';

describe('normalisasiSep', () => {
  test('SEP bersih tidak berubah', () => {
    const n = normalisasiSep(SEP_A);
    expect(n.kunci).toBe(SEP_A);
    expect(n.bentukLazim).toBe(true);
    expect(n.dibersihkan).toBe(false);
  });

  test('spasi, huruf kecil, dan spasi ujung dibersihkan', () => {
    expect(normalisasiSep('  0170R011 0826 V003068 ').kunci).toBe(SEP_A);
    expect(normalisasiSep('0170r0110826v003068').kunci).toBe(SEP_A);
  });

  test('karakter tersembunyi (zero-width, BOM, NBSP, soft hyphen) dibuang', () => {
    expect(normalisasiSep('0170R011​0826﻿V003068­').kunci).toBe(SEP_A);
    expect(normalisasiSep('0170R011 0826V003068').kunci).toBe(SEP_A);
    expect(normalisasiSep('‎0170R0110826V003068‏').kunci).toBe(SEP_A);
  });

  test('tanda petik awal Excel, strip, dan garis miring dibuang', () => {
    expect(normalisasiSep("'0170R0110826V003068").kunci).toBe(SEP_A);
    expect(normalisasiSep('0170R011-0826-V003068').kunci).toBe(SEP_A);
  });

  test('sisa label di depan/belakang dipangkas ke bentuk 19 karakter', () => {
    const n = normalisasiSep('No. SEP: 0170R0110826V003068 (RI)');
    expect(n.kunci).toBe(SEP_A);
    expect(n.dipangkas).toBe(true);
  });

  test('huruf Sirilik yang mirip Latin dipulihkan', () => {
    // "С" (Sirilik) dan "О" (Sirilik) menggantikan C/O Latin
    expect(normalisasiSep('0170R011 0826V003068').kunci).toBe(SEP_A);
    expect(normalisasiSep('ОО70R0110826V003068').kunci).toBe('OO70R0110826V003068');
  });

  test('huruf lebar penuh (NFKC) menjadi ASCII', () => {
    expect(normalisasiSep('０１７０Ｒ０１１０８２６Ｖ００３０６８').kunci).toBe(SEP_A);
  });

  test('kosong / null ditandai kosong', () => {
    expect(normalisasiSep(null).kosong).toBe(true);
    expect(normalisasiSep('   ').kosong).toBe(true);
    expect(normalisasiSep('---').kosong).toBe(true);
  });

  test('bentuk tidak lazim ditandai', () => {
    expect(normalisasiSep('12345').bentukLazim).toBe(false);
  });
});

describe('cocokkanSatu', () => {
  const indeks = bangunIndeksKlaim([
    { id: 'k1', sep: SEP_A },
    { id: 'k2', sep: ` ${SEP_B} ` }, // klaim sendiri berspasi
    { id: 'k3', sep: '', raw_data: JSON.stringify({ SEP: SEP_MEI }) }, // hanya ada di raw_data
  ]);

  test('persis', () => {
    const h = cocokkanSatu(SEP_A, indeks);
    expect(h).toMatchObject({ status: STATUS.COCOK, tipe: 'persis', klaimId: 'k1' });
  });

  test('cocok setelah normalisasi, kedua sisi berformat berbeda', () => {
    const h = cocokkanSatu('0170R011 0826 V000001', indeks);
    expect(h).toMatchObject({ status: STATUS.COCOK, tipe: 'normalisasi', klaimId: 'k2' });
  });

  test('SEP klaim yang hanya ada di raw_data ikut terindeks', () => {
    expect(cocokkanSatu(SEP_MEI, indeks)).toMatchObject({ status: STATUS.COCOK, klaimId: 'k3' });
  });

  test('bentuk wajar tetapi klaim tidak ada -> klaim_tidak_ada', () => {
    const h = cocokkanSatu('0170R0110226V000777', indeks);
    expect(h.status).toBe(STATUS.KLAIM_TIDAK_ADA);
    expect(h.periode).toBe('2026-02');
    expect(h.alasan).toMatch(/periode 2026-02/);
  });

  test('huruf O menggantikan angka 0 -> format, dengan kandidat, TIDAK ditautkan', () => {
    const h = cocokkanSatu('O170R0110826V003068', indeks);
    expect(h.status).toBe(STATUS.FORMAT);
    expect(h.kandidat).toContain('k1');
    expect(h.klaimId).toBeUndefined();
  });

  test('salah satu digit berbeda -> format dengan kandidat', () => {
    const h = cocokkanSatu('0170R0110826V003069', indeks);
    expect(h.status).toBe(STATUS.FORMAT);
    expect(h.kandidat).toContain('k1');
  });

  test('kelebihan satu karakter -> format dengan kandidat', () => {
    const h = cocokkanSatu('0170R0110826V0030688', indeks);
    expect(h.status).toBe(STATUS.FORMAT);
    expect(h.kandidat).toContain('k1');
  });

  test('bentuk tidak lazim tanpa kandidat -> format', () => {
    const h = cocokkanSatu('ABC123', indeks);
    expect(h.status).toBe(STATUS.FORMAT);
    expect(h.alasan).toMatch(/tidak lazim/);
  });

  test('kosong -> format', () => {
    expect(cocokkanSatu(null, indeks).status).toBe(STATUS.FORMAT);
  });
});

describe('hitungStatistik', () => {
  const indeks = bangunIndeksKlaim([{ id: 'k1', sep: SEP_A }, { id: 'k2', sep: SEP_B }]);

  test('memisahkan cocok / klaim_tidak_ada / format dan per periode', () => {
    const rekap = [
      { id: 'r1', sep: SEP_A },
      { id: 'r2', sep: '0170R011 0826 V000001' },
      { id: 'r3', sep: SEP_MEI },
      { id: 'r4', sep: 'O170R0110826V003068' },
      { id: 'r5', sep: '???' },
    ];
    const s = hitungStatistik(rekap, indeks);
    expect(s).toMatchObject({ total: 5, cocok: 2, cocok_persis: 1, cocok_normalisasi: 1, klaim_tidak_ada: 1, format: 2 });
    const agu = s.per_periode.find((p) => p.periode === '2026-08');
    const mei = s.per_periode.find((p) => p.periode === '2026-05');
    expect(agu).toMatchObject({ total: 3, cocok: 2, format: 1, klaim_di_periode_ini: 2 });
    expect(mei).toMatchObject({ total: 1, klaim_tidak_ada: 1, klaim_di_periode_ini: 0 });
  });

  test('nol dijelaskan: periode tidak beririsan', () => {
    const s = hitungStatistik([{ id: 'r1', sep: SEP_MEI }, { id: 'r2', sep: '0170R0110426V000098' }], indeks);
    expect(s.cocok).toBe(0);
    expect(s.klaim_tidak_ada).toBe(2);
    expect(s.penjelasan).toMatch(/0 dari 2/);
    expect(s.penjelasan).toMatch(/2026-04, 2026-05|2026-05, 2026-04/);
  });

  test('nol dijelaskan: tidak ada klaim sama sekali', () => {
    const s = hitungStatistik([{ id: 'r1', sep: SEP_A }], bangunIndeksKlaim([]));
    expect(s.penjelasan).toMatch(/Tidak ada klaim sama sekali/);
  });

  test('rincian per baris hanya bila diminta', () => {
    const s1 = hitungStatistik([{ id: 'r1', sep: SEP_A }], indeks);
    expect(s1.rincian).toEqual([]);
    const s2 = hitungStatistik([{ id: 'r1', sep: SEP_A }], indeks, { rincian: true });
    expect(s2.rincian[0]).toMatchObject({ id: 'r1', status: 'cocok', klaim_id: 'k1' });
  });
});

/** DB tiruan: dispatch berdasarkan potongan SQL. */
function dbTiruan({ klaim, rekap }) {
  const updates = [];
  return {
    updates,
    prepare: (sql) => ({
      all: async () => {
        if (/FROM claim_records/.test(sql)) return klaim;
        if (/FROM bpjs_pending_responses/.test(sql)) return rekap;
        return [];
      },
      run: async (...p) => { updates.push({ sql, p }); return { changes: 1 }; },
      get: async () => undefined,
    }),
  };
}

describe('akses DB (tiruan)', () => {
  test('tautkanUlang hanya menautkan kecocokan aman, tidak kandidat mirip', async () => {
    const db = dbTiruan({
      klaim: [{ id: 'k1', sep: SEP_A }],
      rekap: [{ id: 'r1', sep: '0170R011 0826 V003068' }, { id: 'r2', sep: 'O170R0110826V003068' }],
    });
    const r = await tautkanUlang(db);
    expect(r).toEqual({ diperiksa: 2, tertaut: 1 });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].p).toEqual(['k1', 'r1']);
    expect(db.updates[0].sql).toMatch(/claim_record_id IS NULL/);
  });

  test('statistikDariDb menyaring periode', async () => {
    const db = dbTiruan({
      klaim: [{ id: 'k1', sep: SEP_A }],
      rekap: [{ id: 'r1', sep: SEP_A }, { id: 'r2', sep: SEP_MEI }],
    });
    const s = await statistikDariDb(db, { periode: '2026-05' });
    expect(s.total).toBe(1);
    expect(s.klaim_tidak_ada).toBe(1);
  });

  test('statistikDariDb tidak menulis apa pun', async () => {
    const db = dbTiruan({ klaim: [{ id: 'k1', sep: SEP_A }], rekap: [{ id: 'r1', sep: SEP_A }] });
    await statistikDariDb(db, {});
    expect(db.updates).toHaveLength(0);
  });
});
