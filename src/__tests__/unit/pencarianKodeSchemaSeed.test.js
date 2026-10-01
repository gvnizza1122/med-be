const pk = require('../../services/pencarianKodeService');

describe('ensureSchema (mock DB, cek DDL)', () => {
  test('membuat extension pg_trgm + 3 tabel + index trgm + unique index + ambang_klinis', async () => {
    const query = [];
    const run = [];
    const db = {
      query: async (q) => { query.push(q); },
      run: async (sql, p) => { run.push({ sql, p }); return { changes: 1 }; },
    };
    await pk.ensureSchema(db);

    expect(query[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/);
    expect(query.some((q) => /CREATE TABLE IF NOT EXISTS ref_kode/.test(q))).toBe(true);
    expect(query.some((q) => /CREATE TABLE IF NOT EXISTS ref_istilah_kode/.test(q))).toBe(true);
    expect(query.some((q) => /CREATE TABLE IF NOT EXISTS kamus_lokal_kode/.test(q))).toBe(true);
    expect(query.some((q) => /CREATE TABLE IF NOT EXISTS ambang_klinis/.test(q))).toBe(true);
    expect(query.some((q) => /USING gin \(istilah_rapi gin_trgm_ops\)/.test(q))).toBe(true);
    expect(query.some((q) => /CREATE UNIQUE INDEX IF NOT EXISTS uq_ref_istilah_kode/.test(q))).toBe(true);

    // Kolom embedding vector(1536) HANYA komentar, bukan DDL nyata (vector extension tidak ada).
    expect(query.some((q) => /ref_kode/.test(q) && /^(?!.*--).*vector\(1536\)/m.test(q))).toBe(false);

    // PK komposit kamus_lokal_kode & CHECK jenis/sistem di ref_istilah_kode ada persis.
    const kamusLokalDdl = query.find((q) => /kamus_lokal_kode/.test(q) && /CREATE TABLE/.test(q));
    expect(kamusLokalDdl).toMatch(/PRIMARY KEY \(rs_id, tulisan_rapi, kode\)/);
    const istilahDdl = query.find((q) => /CREATE TABLE IF NOT EXISTS ref_istilah_kode/.test(q));
    expect(istilahDdl).toMatch(/CHECK \(sistem IN \('icd10_2010','icd9cm_2010'\)\)/);
    expect(istilahDdl).toMatch(/CHECK \(jenis IN \('judul','inklusi','indeks','sinonim_id'\)\)/);

    // ambang_klinis juga tersambung (satu titik wiring untuk 4 tabel + seed thresholds).
    expect(run.length).toBe(5); // 5 baris default ambang_klinis
  });

  test('idempoten: semua CREATE pakai IF NOT EXISTS', async () => {
    const query = [];
    const db = { query: async (q) => query.push(q), run: async () => ({ changes: 1 }) };
    await pk.ensureSchema(db);
    const ddlCreate = query.filter((q) => /CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(q) && !/EXTENSION/.test(q));
    expect(ddlCreate.every((q) => /IF NOT EXISTS/.test(q))).toBe(true);
  });
});

// ───────────────────────── seedDariTabelReferensi ──────────────────────────

function dbTiruanSeed({ icd10, icd9 }) {
  const insertsRefKode = [];
  const insertsIstilah = [];
  const db = {
    insertsRefKode,
    insertsIstilah,
    async all(sql) {
      if (/FROM icd10_who_codes/.test(sql) && /chapter_number/.test(sql)) {
        return icd10.map((r) => ({ code: r.code, description_en: r.description_en, description_id: r.description_id, chapter_number: r.chapter_number }));
      }
      if (/FROM icd10_who_codes/.test(sql)) {
        return icd10.map((r) => ({ code: r.code, description_en: r.description_en, description_id: r.description_id }));
      }
      if (/FROM icd9_cm_procedures/.test(sql) && /block/.test(sql)) {
        return icd9.map((r) => ({ code: r.code, description_en: r.description_en, block: r.block }));
      }
      if (/FROM icd9_cm_procedures/.test(sql)) {
        return icd9.map((r) => ({ code: r.code, description_en: r.description_en }));
      }
      throw new Error(`query tak terduga dalam tes: ${sql}`);
    },
    async run(sql, p) {
      if (/INSERT INTO ref_kode/.test(sql)) { insertsRefKode.push({ sql, p }); return { changes: 1 }; }
      if (/INSERT INTO ref_istilah_kode/.test(sql)) { insertsIstilah.push({ sql, p }); return { changes: 1 }; }
      throw new Error(`run tak terduga dalam tes: ${sql}`);
    },
  };
  return db;
}

const ICD10_SAMPLE = [
  { code: 'R10', description_en: 'Abdominal and pelvic pain', description_id: null, chapter_number: 'XVIII' },
  { code: 'R10.4', description_en: 'Other and unspecified abdominal pain', description_id: 'Lain dan tidak spesifik sakit perut', chapter_number: 'XVIII' },
  { code: 'O80', description_en: 'Single spontaneous delivery', description_id: null, chapter_number: 'XV' },
  { code: 'P07', description_en: 'Disorders related to short gestation and low birth weight', description_id: 'Berat badan lahir rendah', chapter_number: 'XVI' },
  { code: 'V01', description_en: 'Pedestrian injured in collision with pedal cycle', description_id: null, chapter_number: 'XX' },
  { code: 'A00', description_en: 'Cholera', description_id: 'Kolera', chapter_number: 'I' },
];

const ICD9_SAMPLE = [
  { code: '00', description_en: 'Procedures and interventions, NEC', block: 'Procedures and Interventions, Not Elsewhere Classified' },
  { code: '00.0', description_en: 'Therapeutic ultrasound', block: 'Procedures and Interventions, Not Elsewhere Classified' },
  { code: '65.6', description_en: 'Removal of both ovaries at same operative episode', block: 'Operations on the Female Genital Organs' },
];

describe('seedDariTabelReferensi (mock DB)', () => {
  let db;
  beforeAll(async () => {
    db = dbTiruanSeed({ icd10: ICD10_SAMPLE, icd9: ICD9_SAMPLE });
    await pk.seedDariTabelReferensi(db);
  });

  function cariRefKode(kode) {
    const row = db.insertsRefKode.find((r) => r.p[0] === kode);
    if (!row) throw new Error(`tidak ada insert ref_kode untuk ${kode}`);
    const [kodeP, sistem, judul, punyaTurunan, jenisKelamin, umurMin, umurMaks, asterisk, sebabLuar, kodeGejala] = row.p;
    return { kode: kodeP, sistem, judul, punyaTurunan, jenisKelamin, umurMin, umurMaks, asterisk, sebabLuar, kodeGejala };
  }

  test('ref_kode diisi untuk semua kode icd10 + icd9', () => {
    expect(db.insertsRefKode.length).toBe(ICD10_SAMPLE.length + ICD9_SAMPLE.length);
  });

  test('semua INSERT ref_kode idempoten (ON CONFLICT (kode) DO NOTHING)', () => {
    expect(db.insertsRefKode.every((r) => /ON CONFLICT \(kode\) DO NOTHING/.test(r.sql))).toBe(true);
  });

  test('R10: punya anak (R10.4) -> punya_turunan true; kode gejala (bab R)', () => {
    const r = cariRefKode('R10');
    expect(r.sistem).toBe('icd10_2010');
    expect(r.judul).toBe('Abdominal and pelvic pain');
    expect(r.punyaTurunan).toBe(true);
    expect(r.kodeGejala).toBe(true);
    expect(r.sebabLuar).toBe(false);
    expect(r.jenisKelamin).toBe(null);
  });

  test('R10.4: leaf -> punya_turunan false, tetap kode gejala', () => {
    const r = cariRefKode('R10.4');
    expect(r.punyaTurunan).toBe(false);
    expect(r.kodeGejala).toBe(true);
  });

  test('O80 (bab XV kehamilan): jenis_kelamin P', () => {
    const r = cariRefKode('O80');
    expect(r.jenisKelamin).toBe('P');
    expect(r.umurMin).toBe(null);
  });

  test('P07 (bab XVI perinatal): umur 0-1 (heuristik tahun)', () => {
    const r = cariRefKode('P07');
    expect(r.umurMin).toBe(0);
    expect(r.umurMaks).toBe(1);
    expect(r.jenisKelamin).toBe(null);
  });

  test('V01 (bab XX): sebab_luar true', () => {
    const r = cariRefKode('V01');
    expect(r.sebabLuar).toBe(true);
    expect(r.kodeGejala).toBe(false);
  });

  test('A00: tidak ada heuristik khusus yang kepicu', () => {
    const r = cariRefKode('A00');
    expect(r.sebabLuar).toBe(false);
    expect(r.kodeGejala).toBe(false);
    expect(r.jenisKelamin).toBe(null);
  });

  test('asterisk selalu FALSE (tidak terdeteksi di data sumber)', () => {
    for (const kode of ['R10', 'R10.4', 'O80', 'P07', 'V01', 'A00']) {
      expect(cariRefKode(kode).asterisk).toBe(false);
    }
  });

  test('icd9 "00": punya anak "00.0" -> punya_turunan true', () => {
    const r = cariRefKode('00');
    expect(r.sistem).toBe('icd9cm_2010');
    expect(r.punyaTurunan).toBe(true);
  });

  test('icd9 "00.0": leaf dalam sample ini -> punya_turunan false', () => {
    expect(cariRefKode('00.0').punyaTurunan).toBe(false);
  });

  test('icd9 "65.6": blok "Operations on the Female Genital Organs" -> jenis_kelamin P', () => {
    expect(cariRefKode('65.6').jenisKelamin).toBe('P');
  });

  test('ref_istilah_kode: icd10 R10 (description_id null) hanya 1 baris (description_en)', () => {
    const barisR10 = db.insertsIstilah.filter((r) => r.p[0] === 'R10');
    expect(barisR10.length).toBe(1);
    expect(barisR10[0].p).toEqual(['R10', 'icd10_2010', 'Abdominal and pelvic pain', 'judul', 'abdominal and pelvic pain']);
  });

  test('ref_istilah_kode: icd10 R10.4 (description_id ada) -> 2 baris, EN + ID terpisah', () => {
    const baris = db.insertsIstilah.filter((r) => r.p[0] === 'R10.4');
    expect(baris.length).toBe(2);
    const rapiSet = baris.map((b) => b.p[4]).sort();
    expect(rapiSet).toEqual(['lain dan tidak spesifik sakit perut', 'other and unspecified abdominal pain']);
    expect(baris.every((b) => b.p[3] === 'judul')).toBe(true);
  });

  test('ref_istilah_kode: icd9 hanya description_en (tidak ada kolom description_id di sumbernya)', () => {
    const baris = db.insertsIstilah.filter((r) => r.p[0] === '00.0');
    expect(baris.length).toBe(1);
    expect(baris[0].p[1]).toBe('icd9cm_2010');
    expect(baris[0].p[4]).toBe('therapeutic ultrasound');
  });

  test('semua INSERT ref_istilah_kode idempoten (ON CONFLICT DO NOTHING)', () => {
    expect(db.insertsIstilah.every((r) => /ON CONFLICT \(kode, sistem, jenis, istilah_rapi\) DO NOTHING/.test(r.sql))).toBe(true);
  });

  test('tidak ada baris ref_istilah_kode dengan istilah kosong', () => {
    expect(db.insertsIstilah.every((r) => r.p[2] && r.p[2].trim().length > 0)).toBe(true);
  });
});

describe('modul tidak memakai jaringan', () => {
  test('tidak ada fetch/axios/http', () => {
    const src = require('fs').readFileSync(require.resolve('../../services/pencarianKodeService'), 'utf8');
    expect(src).not.toMatch(/fetch\(|require\('https?'\)|axios/);
  });
});
