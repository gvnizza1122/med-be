const { simpanKeputusan, pelajaranRelevan, rapikanKode } = require('../../services/keputusanCasemixService');

function dbPalsu(barisPola = []) {
  const ditulis = [];
  return {
    ditulis,
    query: async () => {},
    run: async (sql, a) => { ditulis.push([sql, a]); return { changes: 1 }; },
    get: async () => null,
    all: async (sql) => (/FROM pola_beda_casemix/.test(sql) ? barisPola : []),
  };
}
const hitung = (dx) => ({ inacbgResult: { code: dx.includes('O41.0') ? 'O-6-10-II' : 'O-6-10-I' }, tarifResult: { amount: dx.includes('O41.0') ? 4926400 : 4656700 } });
const record = { id: 'r1', jenis_klaim: 'RAWAT_INAP', kelas_rawat: '3' };
const saran = { diagnosis: [{ kode: 'O42.1' }, { kode: 'O41.0' }, { kode: 'O82.1' }, { kode: 'Z37.0' }], prosedur: [{ kode: '74.1' }], inacbg: { kode: 'O-6-10-II', tarif: 4926400 } };

test('rapikan kode casemix: titik, huruf besar, tanpa dobel', () => {
  expect(rapikanKode('o421; Z37.0, z370', 'dx')).toEqual(['O42.1', 'Z37.0']);
  expect(rapikanKode('741', 'px')).toEqual(['74.1']);
});

test('keputusan casemix disimpan terpisah, dibandingkan dengan rekomendasi, dan dipelajari', async () => {
  const db = dbPalsu();
  const r = await simpanKeputusan({ db, record, saran, pages: [], dx: 'O42.1;O82.1;Z37.0', px: '74.1', oleh: 'u1', hitungInacbgDanTarif: hitung });
  expect(r).toMatchObject({ tersimpan: true, cocok: false, selisih_tarif: -269700 });
  expect(r.dihapus_casemix.diagnosis).toEqual(['O41.0']);
  expect(r.final.inacbg).toBe('O-6-10-I');
  const sql = db.ditulis.map(d => d[0]).join('\n');
  expect(sql).toMatch(/INSERT INTO keputusan_casemix/);
  expect(sql).toMatch(/INSERT INTO pola_beda_casemix/);
  expect(sql).not.toMatch(/UPDATE claim_records/);
});

test('validasi: diagnosis wajib, format salah ditolak', async () => {
  const db = dbPalsu();
  expect((await simpanKeputusan({ db, record, saran, dx: '', hitungInacbgDanTarif: hitung })).galat).toMatch(/wajib/);
  expect((await simpanKeputusan({ db, record, saran, dx: 'ABC', hitungInacbgDanTarif: hitung })).galat).toMatch(/Format/);
  expect(db.ditulis).toHaveLength(0);
});

describe('pelajaran dari kasus lain', () => {
  const baris = [
    { dx_aplikasi: 'O42.1;O41.0', dx_casemix: 'O42.1;Z37.0', px_aplikasi: '74.1', px_casemix: '74.1', jenis_klaim: 'RAWAT_INAP' },
    { dx_aplikasi: 'O42.1;O41.0', dx_casemix: 'O42.1;Z37.0', px_aplikasi: '74.1', px_casemix: '74.1', jenis_klaim: 'RAWAT_INAP' },
    { dx_aplikasi: 'O41.0', dx_casemix: 'O41.0', px_aplikasi: '', px_casemix: '', jenis_klaim: 'RAWAT_INAP' },
  ];
  test('kode yang berulang dihapus & ditambah casemix menjadi pelajaran', async () => {
    const p = await pelajaranRelevan(dbPalsu(baris), { dx: ['O42.1', 'O41.0'], recordId: 'r1', jenisKlaim: 'RAWAT_INAP', untukPerbandingan: true });
    const hapus = p.find(x => x.pola === 'sering_dihapus');
    expect(hapus).toMatchObject({ kode: 'O41.0', jumlah: 2, kasus: 3 });
    expect(p.find(x => x.pola === 'sering_ditambah')).toMatchObject({ kode: 'Z37.0' });
  });
  test('satu kasus saja belum jadi pelajaran; tabel belum ada -> []', async () => {
    expect(await pelajaranRelevan(dbPalsu(baris.slice(0, 1)), { dx: ['O41.0'] })).toEqual([]);
    const rusak = { all: async () => { throw Error('relation "pola_beda_casemix" does not exist'); } };
    expect(await pelajaranRelevan(rusak, { dx: ['O41.0'] })).toEqual([]);
  });
});
