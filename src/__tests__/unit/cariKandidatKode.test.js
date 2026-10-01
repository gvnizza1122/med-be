const pk = require('../../services/pencarianKodeService');

function buatDb({ layer1 = [], layer2exact = [], layer2mirip = [], layer3 = [], refKodeJudul = {} } = {}) {
  const panggilan = [];
  return {
    panggilan,
    async all(sql, params) {
      panggilan.push({ sql, params });
      if (/FROM kamus_lokal_kode/.test(sql)) return layer1;
      if (/similarity\(/.test(sql)) return layer3;
      if (/ILIKE/.test(sql)) return layer2mirip;
      if (/FROM ref_istilah_kode/.test(sql) && /istilah_rapi = \?/.test(sql)) return layer2exact;
      if (/SELECT kode, judul FROM ref_kode WHERE kode IN/.test(sql)) {
        return params.filter((k) => Object.prototype.hasOwnProperty.call(refKodeJudul, k)).map((k) => ({ kode: k, judul: refKodeJudul[k] }));
      }
      throw new Error(`query tak terduga dalam tes: ${sql}`);
    },
    async get() { return undefined; },
    async run() { return { changes: 1 }; },
  };
}

describe('cariKandidatKode -- waterfall berhenti di layer pertama yang confident', () => {
  test('teks kosong -> [] tanpa panggilan DB sama sekali', async () => {
    const db = buatDb();
    expect(await pk.cariKandidatKode(db, { teks: '   ', sistem: 'icd10_2010', rsId: 'rs1' })).toEqual([]);
    expect(db.panggilan.length).toBe(0);
  });

  test('layer 1 (pasti): kamus lokal RS ditemukan -> berhenti, layer 2/3 tidak dijalankan', async () => {
    const db = buatDb({ layer1: [{ kode: 'R10.4', sistem: 'icd10_2010', judul: 'Other and unspecified abdominal pain' }] });
    const hasil = await pk.cariKandidatKode(db, { teks: 'nyeri perut lain', sistem: 'icd10_2010', rsId: 'rs1' });
    expect(hasil).toEqual([{ kode: 'R10.4', sistem: 'icd10_2010', judul: 'Other and unspecified abdominal pain', lapis: 1, skor: 1 }]);
    expect(db.panggilan.some((p) => /ref_istilah_kode/.test(p.sql))).toBe(false);
  });

  test('tanpa rsId: layer 1 dilewati total (tidak ada query kamus_lokal_kode)', async () => {
    const db = buatDb({ layer2exact: [{ kode: 'R10', sistem: 'icd10_2010' }], refKodeJudul: { R10: 'Abdominal and pelvic pain' } });
    await pk.cariKandidatKode(db, { teks: 'abdominal and pelvic pain', sistem: 'icd10_2010' });
    expect(db.panggilan.some((p) => /kamus_lokal_kode/.test(p.sql))).toBe(false);
  });

  test('rsId ada tapi kamus lokal kosong -> lanjut ke layer 2', async () => {
    const db = buatDb({
      layer1: [],
      layer2exact: [{ kode: 'R10', sistem: 'icd10_2010' }],
      refKodeJudul: { R10: 'Abdominal and pelvic pain' },
    });
    const hasil = await pk.cariKandidatKode(db, { teks: 'abdominal and pelvic pain', sistem: 'icd10_2010', rsId: 'rs1' });
    expect(hasil).toEqual([{ kode: 'R10', sistem: 'icd10_2010', judul: 'Abdominal and pelvic pain', lapis: 2, skor: 1 }]);
  });

  test('layer 2 cocok JUDUL persis (exact) -> skor 1, lapis 2, layer 3 tidak dijalankan', async () => {
    const db = buatDb({ layer2exact: [{ kode: 'A00', sistem: 'icd10_2010' }], refKodeJudul: { A00: 'Cholera' } });
    const hasil = await pk.cariKandidatKode(db, { teks: 'Cholera', sistem: 'icd10_2010' });
    expect(hasil).toEqual([{ kode: 'A00', sistem: 'icd10_2010', judul: 'Cholera', lapis: 2, skor: 1 }]);
    expect(db.panggilan.some((p) => /similarity\(/.test(p.sql))).toBe(false);
  });

  test('layer 2 exact kosong, near-exact (ILIKE) ditemukan -> skor 0.8, lapis 2', async () => {
    const db = buatDb({
      layer2exact: [],
      layer2mirip: [{ kode: 'A00', sistem: 'icd10_2010' }],
      refKodeJudul: { A00: 'Cholera' },
    });
    const hasil = await pk.cariKandidatKode(db, { teks: 'cholera akut', sistem: 'icd10_2010' });
    expect(hasil).toEqual([{ kode: 'A00', sistem: 'icd10_2010', judul: 'Cholera', lapis: 2, skor: 0.8 }]);
  });

  test('layer 2 kosong total -> lanjut ke layer 3 (trigram)', async () => {
    const db = buatDb({
      layer2exact: [],
      layer2mirip: [],
      layer3: [{ kode: 'R10', sistem: 'icd10_2010', skor: 0.55 }],
      refKodeJudul: { R10: 'Abdominal and pelvic pain' },
    });
    const hasil = await pk.cariKandidatKode(db, { teks: 'nyri perot', sistem: 'icd10_2010' });
    expect(hasil).toEqual([{ kode: 'R10', sistem: 'icd10_2010', judul: 'Abdominal and pelvic pain', lapis: 3, skor: 0.55 }]);
  });

  test('layer 3: hasil di bawah ambang 0.3 dibuang', async () => {
    const db = buatDb({
      layer3: [
        { kode: 'R10', sistem: 'icd10_2010', skor: 0.29 },
        { kode: 'A00', sistem: 'icd10_2010', skor: 0.5 },
      ],
      refKodeJudul: { R10: 'Abdominal and pelvic pain', A00: 'Cholera' },
    });
    const hasil = await pk.cariKandidatKode(db, { teks: 'xx', sistem: 'icd10_2010' });
    expect(hasil.map((h) => h.kode)).toEqual(['A00']);
  });

  test('layer 3: dikelompokkan per kode (ambil skor tertinggi), diurutkan desc, dipotong top 5', async () => {
    const layer3 = [];
    for (let i = 1; i <= 7; i++) layer3.push({ kode: `K${i}`, sistem: 'icd10_2010', skor: 0.3 + i * 0.05 });
    // duplikat utk K1 dengan skor lebih tinggi -- harus menang
    layer3.push({ kode: 'K1', sistem: 'icd10_2010', skor: 0.99 });
    const refKodeJudul = Object.fromEntries(layer3.map((r) => [r.kode, `judul ${r.kode}`]));
    const db = buatDb({ layer3, refKodeJudul });
    const hasil = await pk.cariKandidatKode(db, { teks: 'xx', sistem: 'icd10_2010' });
    expect(hasil.length).toBe(5); // MAKS_KANDIDAT
    expect(hasil[0]).toEqual({ kode: 'K1', sistem: 'icd10_2010', judul: 'judul K1', lapis: 3, skor: 0.99 });
    expect(hasil.every((h, i) => i === 0 || hasil[i - 1].skor >= h.skor)).toBe(true);
  });

  test('semua layer kosong -> []', async () => {
    const db = buatDb();
    expect(await pk.cariKandidatKode(db, { teks: 'tidak ada yang cocok sama sekali', sistem: 'icd10_2010' })).toEqual([]);
  });

  test('kandidat yang kodenya tidak ada di ref_kode dibuang (jaring pengaman "jangan mengarang kode")', async () => {
    const db = buatDb({
      layer2exact: [{ kode: 'KODE_TIDAK_ADA', sistem: 'icd10_2010' }],
      refKodeJudul: {}, // kosong -- simulasi bug seed, kode tidak ketemu di ref_kode
    });
    const hasil = await pk.cariKandidatKode(db, { teks: 'apapun', sistem: 'icd10_2010' });
    expect(hasil).toEqual([]);
  });
});

describe('simpanPersetujuanKoder', () => {
  test('validasi field wajib', async () => {
    const db = { get: async () => ({ kode: 'R10' }), run: async () => ({ changes: 1 }) };
    await expect(pk.simpanPersetujuanKoder(db, { tulisanRapi: 'x', kode: 'R10' })).rejects.toThrow(/rsId/);
    await expect(pk.simpanPersetujuanKoder(db, { rsId: 'rs1', kode: 'R10' })).rejects.toThrow(/tulisanRapi/);
    await expect(pk.simpanPersetujuanKoder(db, { rsId: 'rs1', tulisanRapi: 'x' })).rejects.toThrow(/kode/);
  });

  test('tolak kode yang tidak ada di ref_kode -- tidak boleh mengarang kode', async () => {
    const db = { get: async () => undefined, run: async () => ({ changes: 1 }) };
    await expect(pk.simpanPersetujuanKoder(db, { rsId: 'rs1', tulisanRapi: 'nyeri perut', kode: 'ZZ99' }))
      .rejects.toThrow(/tidak ditemukan di ref_kode/);
  });

  test('upsert sukses: tulisan dinormalisasi sebelum disimpan', async () => {
    let paramsRun;
    const db = {
      get: async () => ({ kode: 'R10.4' }),
      run: async (sql, p) => { paramsRun = { sql, p }; return { changes: 1 }; },
    };
    const hasil = await pk.simpanPersetujuanKoder(db, { rsId: ' rs1 ', tulisanRapi: 'Nyeri Perut, Lain!', kode: ' R10.4 ' });
    expect(hasil).toEqual({ rsId: 'rs1', tulisanRapi: 'nyeri perut lain', kode: 'R10.4' });
    expect(paramsRun.sql).toMatch(/ON CONFLICT \(rs_id, tulisan_rapi, kode\) DO UPDATE/);
    expect(paramsRun.sql).toMatch(/jumlah_disetujui = kamus_lokal_kode\.jumlah_disetujui \+ 1/);
    expect(paramsRun.p).toEqual(['rs1', 'nyeri perut lain', 'R10.4']);
  });
});
