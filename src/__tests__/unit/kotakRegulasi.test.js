const kr = require('../../services/kotakRegulasiService');

function dbTiruan() {
  const rows = new Map();
  return {
    rows,
    async run(sql, p) {
      if (/^\s*INSERT/.test(sql)) { rows.set(p[0], { id: p[0], judul: p[1], berlaku_mulai: p[2], berkas: p[3], status: 'diunggah' }); return { changes: 1 }; }
      if (/^\s*UPDATE/.test(sql)) {
        const r = rows.get(p[1]);
        if (!r || r.status !== p[2]) return { changes: 0 };
        r.status = p[0];
        return { changes: 1 };
      }
    },
    async get(sql, p) { const r = rows.get(p[0]); return r ? { ...r } : undefined; },
    async all() { return [...rows.values()]; },
    async query() {},
  };
}

describe('kotakRegulasiService', () => {
  test('unggah -> status diunggah; validasi input', async () => {
    const db = dbTiruan();
    const r = await kr.unggah(db, { judul: ' Permenkes 3/2023 ', berlaku_mulai: '2026-07-01', berkas: 'uploads/regulasi/a.pdf' });
    expect(r.status).toBe('diunggah');
    expect(db.rows.get(r.id).judul).toBe('Permenkes 3/2023');
    await expect(kr.unggah(db, { judul: '', berkas: 'x' })).rejects.toThrow(/judul/);
    await expect(kr.unggah(db, { judul: 'a', berkas: ' ' })).rejects.toThrow(/berkas/);
    await expect(kr.unggah(db, { judul: 'a', berkas: 'x', berlaku_mulai: '2026-13-40' })).rejects.toThrow(/tanggal/);
  });

  test('jalur maju yang sah', async () => {
    const db = dbTiruan();
    const { id } = await kr.unggah(db, { judul: 'j', berkas: 'b' });
    await kr.ubahStatus(db, id, 'dianalisis');
    await kr.ubahStatus(db, id, 'usulan_dibuat');
    await kr.ubahStatus(db, id, 'selesai');
    expect(db.rows.get(id).status).toBe('selesai');
  });

  test('dianalisis -> selesai boleh (tidak ada usulan)', async () => {
    const db = dbTiruan();
    const { id } = await kr.unggah(db, { judul: 'j', berkas: 'b' });
    await kr.ubahStatus(db, id, 'dianalisis');
    await kr.ubahStatus(db, id, 'selesai');
  });

  test.each([
    ['diunggah', 'usulan_dibuat'], ['diunggah', 'selesai'], ['dianalisis', 'diunggah'],
    ['usulan_dibuat', 'dianalisis'], ['selesai', 'diunggah'], ['selesai', 'selesai'], ['diunggah', 'diunggah'],
  ])('transisi %s -> %s ditolak', async (dari, ke) => {
    const db = dbTiruan();
    const { id } = await kr.unggah(db, { judul: 'j', berkas: 'b' });
    db.rows.get(id).status = dari;
    await expect(kr.ubahStatus(db, id, ke)).rejects.toThrow(/tidak sah/);
    expect(db.rows.get(id).status).toBe(dari);
  });

  test('status tak dikenal & id tak ada', async () => {
    const db = dbTiruan();
    await expect(kr.ubahStatus(db, 'x', 'ngawur')).rejects.toThrow(/tidak dikenal/);
    await expect(kr.ubahStatus(db, 'x', 'dianalisis')).rejects.toThrow(/tidak ditemukan/);
  });

  test('DDL memuat CHECK status', async () => {
    const s = [];
    await kr.ensureSchema({ query: async (q) => s.push(q) });
    expect(s[0]).toMatch(/status IN \('diunggah','dianalisis','usulan_dibuat','selesai'\)/);
  });

  test('modul tidak memakai jaringan', () => {
    const src = require('fs').readFileSync(require.resolve('../../services/kotakRegulasiService'), 'utf8');
    expect(src).not.toMatch(/fetch\(|require\('https?'\)|axios/);
  });
});
