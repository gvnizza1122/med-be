const rv = require('../../services/ruleVersiService');

// DB tiruan stateful yang hanya mengerti pernyataan yang dipakai ruleVersiService.
function dbRule() {
  const rows = [];
  const cari = (k, v) => rows.find((r) => r.rule_kode === k && r.versi === v);
  return {
    rows,
    async get(sql, p) {
      if (/MAX\(versi\)/.test(sql)) return { maks: Math.max(0, ...rows.filter((r) => r.rule_kode === p[0]).map((r) => r.versi)) };
      if (/WHERE rule_kode = \? AND versi = \?/.test(sql)) { const r = cari(p[0], p[1]); return r ? { ...r } : undefined; }
      throw new Error('get tak dikenal: ' + sql);
    },
    async all(sql, p) {
      let hasil = rows.filter((r) => r.rule_kode === p[0]);
      const m = sql.match(/status IN \(([^)]*)\)/);
      if (m) { const st = m[1].replace(/'/g, '').split(',').map((s) => s.trim()); hasil = hasil.filter((r) => st.includes(r.status)); }
      return hasil.map((r) => ({ ...r })).sort((a, b) => a.versi - b.versi);
    },
    async run(sql, p) {
      if (/^\s*INSERT INTO rule_versi/.test(sql)) {
        const [rule_kode, versi, isi, berlaku_mulai, berlaku_sampai, sumber_jenis, sumber_kutipan, diusulkan_oleh] = p;
        if (cari(rule_kode, versi)) throw new Error('duplicate key');
        if (!sumber_kutipan || !sumber_kutipan.trim()) throw new Error('check constraint sumber_kutipan');
        rows.push({ rule_kode, versi, isi, berlaku_mulai, berlaku_sampai, status: 'usulan', sumber_jenis, sumber_kutipan, diusulkan_oleh, hasil_uji: null, disetujui_oleh: null, disetujui_pada: null });
        return { changes: 1 };
      }
      const m = sql.match(/SET (.+) WHERE rule_kode = \? AND versi = \? AND status IN \(([^)]*)\)/);
      if (m) {
        const kolom = m[1].split(',').map((s) => s.split('=')[0].trim());
        const n = kolom.length;
        const [k, v] = [p[n], p[n + 1]];
        const boleh = p.slice(n + 2);
        const r = cari(k, v);
        if (!r || !boleh.includes(r.status)) return { changes: 0 };
        kolom.forEach((c, i) => { r[c] = p[i]; });
        return { changes: 1 };
      }
      throw new Error('run tak dikenal: ' + sql);
    },
    async query() { return {}; },
  };
}

const usulanDasar = (o = {}) => ({
  rule_kode: 'R-DRG-01',
  isi: { ambang_hb: 8, syarat: ['lab'] },
  berlaku_mulai: '2026-07-01',
  sumber_jenis: 'pending_bpjs',
  sumber_kutipan: 'Rekap pending Juni 2026 hlm 3: "tidak didukung kenaikan kreatinin"',
  diusulkan_oleh: 'kimi',
  ...o,
});

describe('validasi usulan — tanpa dasar tidak bisa disimpan', () => {
  test.each([[''], ['   '], ['\n\t '], [null], [undefined], [123]])('sumber_kutipan %p ditolak', async (k) => {
    const db = dbRule();
    await expect(rv.buatUsulan(db, usulanDasar({ sumber_kutipan: k }))).rejects.toThrow(/sumber_kutipan/);
    expect(db.rows).toHaveLength(0);
  });

  test('enum tak valid, isi bukan objek, tanggal salah, sampai < mulai', async () => {
    const db = dbRule();
    for (const o of [
      { sumber_jenis: 'gosip' }, { diusulkan_oleh: 'gpt' }, { isi: 'teks' }, { isi: null },
      { berlaku_mulai: '2026-02-30' }, { berlaku_mulai: 'kemarin' },
      { berlaku_sampai: '2026-06-01' }, { rule_kode: ' ' }, { rule_kode: 'X'.repeat(21) },
    ]) {
      await expect(rv.buatUsulan(db, usulanDasar(o))).rejects.toThrow(/ditolak/);
    }
  });

  test('DDL memuat constraint DB yang sama', async () => {
    const sqls = [];
    await rv.ensureSchema({ query: async (s) => { sqls.push(s); } });
    const ddl = sqls.join('\n');
    expect(ddl).toMatch(/sumber_kutipan TEXT NOT NULL CHECK \(length\(btrim\(sumber_kutipan\)\) > 0\)/);
    expect(ddl).toMatch(/status IN \('usulan','diuji','aktif','dipantau','pensiun','ditolak'\)/);
    expect(ddl).toMatch(/sumber_jenis[\s\S]*'pending_bpjs','regulasi','casemix_rs','ba_kesepakatan'/);
    expect(ddl).toMatch(/diusulkan_oleh[\s\S]*'kimi','luna','manusia'/);
    expect(ddl).toMatch(/PRIMARY KEY \(rule_kode, versi\)/);
    expect(ddl).toMatch(/isi JSONB/);
  });
});

describe('alur status', () => {
  test('versi bertambah per rule_kode dan mulai dari usulan', async () => {
    const db = dbRule();
    expect((await rv.buatUsulan(db, usulanDasar())).versi).toBe(1);
    expect((await rv.buatUsulan(db, usulanDasar())).versi).toBe(2);
    expect((await rv.buatUsulan(db, usulanDasar({ rule_kode: 'LAIN' }))).versi).toBe(1);
    expect(db.rows[0].status).toBe('usulan');
  });

  test('setujui hanya dari diuji; usulan mentah ditolak', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar());
    await expect(rv.setujui(db, 'R-DRG-01', 1, { oleh: 'koder1' })).rejects.toThrow(/diuji/);
    await rv.catatHasilUji(db, 'R-DRG-01', 1, { tertangkap: 5, alarm_palsu: 1 });
    const r = await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'koder1' });
    expect(r.status).toBe('dipantau');
    const baris = db.rows[0];
    expect(baris.disetujui_oleh).toBe('koder1');
    expect(baris.disetujui_pada).toBeInstanceOf(Date);
    expect(JSON.parse(baris.hasil_uji)).toEqual({ tertangkap: 5, alarm_palsu: 1 });
  });

  test('setujui wajib mencatat penyetuju dan tidak bisa dua kali', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar());
    await rv.catatHasilUji(db, 'R-DRG-01', 1, { a: 1 });
    await expect(rv.setujui(db, 'R-DRG-01', 1, { oleh: '  ' })).rejects.toThrow(/oleh/);
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'koder1', mode: 'aktif' });
    expect(db.rows[0].status).toBe('aktif');
    await expect(rv.setujui(db, 'R-DRG-01', 1, { oleh: 'koder2' })).rejects.toThrow();
  });

  test('catatHasilUji tidak bisa pada rule yang sudah aktif/ditolak', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar());
    await rv.tolak(db, 'R-DRG-01', 1, { oleh: 'koder1', alasan: 'terlalu banyak alarm palsu' });
    await expect(rv.catatHasilUji(db, 'R-DRG-01', 1, {})).rejects.toThrow();
    expect(db.rows[0].status).toBe('ditolak');
    expect(JSON.parse(db.rows[0].hasil_uji).ditolak.oleh).toBe('koder1');
  });

  test('tolak dari status aktif ditolak', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar());
    await rv.catatHasilUji(db, 'R-DRG-01', 1, {});
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'k' });
    await expect(rv.tolak(db, 'R-DRG-01', 1, { oleh: 'k' })).rejects.toThrow();
  });

  test('akhiriPemantauan dipantau -> aktif', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar());
    await rv.catatHasilUji(db, 'R-DRG-01', 1, {});
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'k' });
    expect((await rv.akhiriPemantauan(db, 'R-DRG-01', 1)).status).toBe('aktif');
    await expect(rv.akhiriPemantauan(db, 'R-DRG-01', 1)).rejects.toThrow();
  });
});

describe('berlaku pada tanggal pelayanan', () => {
  async function siapkanDuaVersi() {
    const db = dbRule();
    // v1: INA-CBG sejak 2026-01-01; v2: INA-DRG sejak 2026-07-01
    await rv.buatUsulan(db, usulanDasar({ isi: { model: 'INA-CBG' }, berlaku_mulai: '2026-01-01' }));
    await rv.catatHasilUji(db, 'R-DRG-01', 1, {});
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'k', mode: 'aktif' });
    await rv.buatUsulan(db, usulanDasar({ isi: { model: 'INA-DRG' }, berlaku_mulai: '2026-07-01' }));
    await rv.catatHasilUji(db, 'R-DRG-01', 2, {});
    await rv.setujui(db, 'R-DRG-01', 2, { oleh: 'k' });
    return db;
  }

  test('INA-CBG dan INA-DRG berdampingan menurut tanggal pelayanan, batas inklusif/berdekatan', async () => {
    const db = await siapkanDuaVersi();
    expect(db.rows[0].berlaku_sampai).toBe('2026-06-30');
    expect(db.rows[0].status).toBe('pensiun');
    const model = async (t) => (await rv.ruleBerlakuPada(db, 'R-DRG-01', t)).isi.model;
    expect(await model('2026-06-30')).toBe('INA-CBG');
    expect(await model('2026-07-01')).toBe('INA-DRG');
    expect(await model(new Date(2026, 8, 30))).toBe('INA-DRG');
    expect(await model('2026-01-01')).toBe('INA-CBG');
  });

  test('sebelum rule pertama berlaku -> null; kode lain -> null', async () => {
    const db = await siapkanDuaVersi();
    expect(await rv.ruleBerlakuPada(db, 'R-DRG-01', '2025-12-31')).toBeNull();
    expect(await rv.ruleBerlakuPada(db, 'TIDAK-ADA', '2026-08-01')).toBeNull();
  });

  test('tanggal tidak valid melempar', async () => {
    await expect(rv.ruleBerlakuPada(dbRule(), 'X', 'besok')).rejects.toThrow(/Tanggal/);
  });

  test('usulan/diuji/ditolak tidak pernah berlaku', () => {
    const b = ['usulan', 'diuji', 'ditolak'].map((status, i) => ({ versi: i + 1, status, berlaku_mulai: '2026-01-01', berlaku_sampai: null }));
    expect(rv.pilihRuleBerlaku(b, '2026-05-05')).toBeNull();
  });

  test('tumpang tindih deterministik: mulai terbaru menang, seri -> versi tertinggi', () => {
    const b = [
      { versi: 1, status: 'aktif', berlaku_mulai: '2026-01-01', berlaku_sampai: null },
      { versi: 2, status: 'aktif', berlaku_mulai: '2026-03-01', berlaku_sampai: null },
      { versi: 3, status: 'dipantau', berlaku_mulai: '2026-03-01', berlaku_sampai: null },
    ];
    expect(rv.pilihRuleBerlaku(b, '2026-02-01').versi).toBe(1);
    expect(rv.pilihRuleBerlaku(b, '2026-04-01').versi).toBe(3);
    // urutan input tidak berpengaruh
    expect(rv.pilihRuleBerlaku([...b].reverse(), '2026-04-01').versi).toBe(3);
  });

  test('pensiunkan tanpa pengganti: tetap berlaku sampai tanggal itu saja', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar({ berlaku_mulai: '2026-01-01' }));
    await rv.catatHasilUji(db, 'R-DRG-01', 1, {});
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'k', mode: 'aktif' });
    await rv.pensiunkan(db, 'R-DRG-01', 1, { sampai: '2026-03-31' });
    expect((await rv.ruleBerlakuPada(db, 'R-DRG-01', '2026-03-31')).versi).toBe(1);
    expect(await rv.ruleBerlakuPada(db, 'R-DRG-01', '2026-04-01')).toBeNull();
  });
});

describe('rollback dalam masa pantau', () => {
  test('rule baru dibatalkan, rule lama dibuka lagi tanpa batas akhir', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar({ isi: { v: 'lama' }, berlaku_mulai: '2026-01-01' }));
    await rv.catatHasilUji(db, 'R-DRG-01', 1, {});
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'k', mode: 'aktif' });
    await rv.buatUsulan(db, usulanDasar({ isi: { v: 'baru' }, berlaku_mulai: '2026-07-01' }));
    await rv.catatHasilUji(db, 'R-DRG-01', 2, {});
    await rv.setujui(db, 'R-DRG-01', 2, { oleh: 'k' });
    expect((await rv.ruleBerlakuPada(db, 'R-DRG-01', '2026-08-01')).isi.v).toBe('baru');

    const r = await rv.kembalikanKeVersiLama(db, 'R-DRG-01', 2, { oleh: 'koder1', alasan: 'banyak alarm palsu' });
    expect(r).toMatchObject({ dibatalkan: 2, dipulihkan: 1 });
    expect((await rv.ruleBerlakuPada(db, 'R-DRG-01', '2026-08-01')).isi.v).toBe('lama');
    expect(db.rows[1].status).toBe('ditolak');
    expect(JSON.parse(db.rows[1].hasil_uji).rollback.oleh).toBe('koder1');
  });

  test('rollback hanya saat dipantau; tidak dari aktif', async () => {
    const db = dbRule();
    await rv.buatUsulan(db, usulanDasar());
    await rv.catatHasilUji(db, 'R-DRG-01', 1, {});
    await rv.setujui(db, 'R-DRG-01', 1, { oleh: 'k', mode: 'aktif' });
    await expect(rv.kembalikanKeVersiLama(db, 'R-DRG-01', 1, { oleh: 'k' })).rejects.toThrow(/pantau/);
  });
});

describe('bandingkanIsi — data diff layar persetujuan', () => {
  test('ditambah/dihapus/diubah/sama, termasuk objek dan array bersarang', () => {
    const lama = { ambang: { hb: 8, kreatinin: 1.5 }, syarat: ['lab', 'rontgen'], aktif: true };
    const baru = { ambang: { hb: 7, kreatinin: 1.5 }, syarat: ['lab'], catatan: 'baru' };
    const { baris, ringkas } = rv.bandingkanIsi(lama, baru);
    const per = Object.fromEntries(baris.map((b) => [b.path, b]));
    expect(per['ambang.hb']).toMatchObject({ jenis: 'diubah', lama: 8, baru: 7 });
    expect(per['ambang.kreatinin'].jenis).toBe('sama');
    expect(per['syarat[1]']).toMatchObject({ jenis: 'dihapus', lama: 'rontgen' });
    expect(per.aktif.jenis).toBe('dihapus');
    expect(per.catatan).toMatchObject({ jenis: 'ditambah', baru: 'baru' });
    expect(ringkas).toEqual({ ditambah: 1, dihapus: 2, diubah: 1, sama: 2 });
  });

  test('sertakanSama=false dan lama null (rule pertama)', () => {
    const r = rv.bandingkanIsi(null, { a: 1 }, { sertakanSama: false });
    expect(r.baris).toEqual([{ path: 'a', lama: undefined, baru: 1, jenis: 'ditambah' }]);
    expect(rv.bandingkanIsi({ a: 1 }, { a: 1 }, { sertakanSama: false }).baris).toEqual([]);
  });
});

describe('ujiKeKlaimLama — evaluator disuntikkan', () => {
  const klaim = [
    { id: 1, hasil_lama: 'pending', hb: 6 },
    { id: 2, hasil_lama: 'pending', hb: 7 },
    { id: 3, hasil_lama: 'lolos', hb: 7.5 },
    { id: 4, hasil_lama: 'lolos', hb: 12 },
    { id: 5, hasil_lama: 'pending', hb: 5 },
    { id: 6, hasil_lama: 'lolos', hb: 7.9 },
    { id: 7, hasil_lama: 'tak_tahu', hb: 6 },
  ];
  const evaluator = (rule, k) => k.hb < rule.ambang_hb;

  test('menghitung tertangkap, alarm palsu, dan membatasi contoh 3', () => {
    const r = rv.ujiKeKlaimLama({ ambang_hb: 8 }, klaim, evaluator);
    expect(r).toMatchObject({ tertangkap: 3, alarm_palsu: 2, tidak_diketahui: 1, galat: 0, total: 7 });
    expect(r.contoh).toHaveLength(3);
  });

  test('dengan ruleLama, contoh hanya klaim yang hasilnya berubah', () => {
    const r = rv.ujiKeKlaimLama({ ambang_hb: 8 }, klaim, evaluator, { ruleLama: { ambang_hb: 7 } });
    const ids = r.contoh.map((c) => c.id).sort();
    expect(ids).toEqual([2, 3, 6]); // hb 7, 7.5, 7.9: baru ditandai (<8), lama tidak (<7)
    expect(r.contoh[0].ditandai_rule_lama).toBe(false);
  });

  test('evaluator melempar -> dihitung galat, tidak menggagalkan uji', () => {
    const r = rv.ujiKeKlaimLama({}, [{ id: 1, hasil_lama: 'pending' }, { id: 2, hasil_lama: 'pending' }],
      (_, k) => { if (k.id === 1) throw new Error('x'); return true; });
    expect(r).toMatchObject({ galat: 1, tertangkap: 1, total: 2 });
  });

  test('daftar kosong dan evaluator bukan fungsi', () => {
    expect(rv.ujiKeKlaimLama({}, [], () => true)).toMatchObject({ total: 0, contoh: [] });
    expect(() => rv.ujiKeKlaimLama({}, [], null)).toThrow();
  });
});
