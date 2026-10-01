const ak = require('../../services/ambangKlinisService');

function barisDariDefault() {
  return ak.DEFAULT_AMBANG.map((d) => ({
    penanda: d.penanda,
    nilai_ambang: JSON.stringify(d.nilaiAmbang),
    arti: d.arti,
    sumber: 'default_awal',
  }));
}

describe('DEFAULT_AMBANG sesuai nilai awal dari catatan produk', () => {
  test('lima penanda ada semua', () => {
    const nama = ak.DEFAULT_AMBANG.map((d) => d.penanda).sort();
    expect(nama).toEqual(['nadi', 'nyeri_vas', 'spo2', 'suhu', 'tekanan_darah'].sort());
  });

  test('nilai cocok persis dengan spek', () => {
    const byPenanda = Object.fromEntries(ak.DEFAULT_AMBANG.map((d) => [d.penanda, d]));
    expect(byPenanda.tekanan_darah.nilaiAmbang).toEqual({ sistolOp: '>=', sistol: 180, diastolOp: '>=', diastol: 120 });
    expect(byPenanda.suhu.nilaiAmbang).toEqual({ op: '>=', nilai: 40 });
    expect(byPenanda.nyeri_vas.nilaiAmbang).toEqual({ berat: [7, 10], sedang: [4, 6], ringan: [1, 3] });
    expect(byPenanda.spo2.nilaiAmbang).toEqual({ op: '<', nilai: 94 });
    expect(byPenanda.nadi.nilaiAmbang).toEqual({ op: '>', nilai: 100 });
  });
});

describe('buatPenerjemahDariBaris (murni, tanpa DB)', () => {
  const t = ak.buatPenerjemahDariBaris(barisDariDefault());

  test('cocokTekananDarah: krisis hipertensi lewat sistol SAJA', () => {
    expect(t.cocokTekananDarah(185, 80).cocok).toBe(true);
  });
  test('cocokTekananDarah: krisis hipertensi lewat diastol SAJA', () => {
    expect(t.cocokTekananDarah(130, 125).cocok).toBe(true);
  });
  test('cocokTekananDarah: tidak krisis', () => {
    const r = t.cocokTekananDarah(120, 80);
    expect(r.cocok).toBe(false);
    expect(r.arti).toBe(null);
  });
  test('cocokTekananDarah: tepat di batas (inklusif >=)', () => {
    expect(t.cocokTekananDarah(180, 70).cocok).toBe(true);
    expect(t.cocokTekananDarah(179, 70).cocok).toBe(false);
  });

  test('cocokSuhu', () => {
    expect(t.cocokSuhu(40).cocok).toBe(true);
    expect(t.cocokSuhu(40.5).cocok).toBe(true);
    expect(t.cocokSuhu(39.9).cocok).toBe(false);
  });

  test('cocokVas: kategori berat memicu bukti kegawatan', () => {
    const r = t.cocokVas(8);
    expect(r.kategori).toBe('berat');
    expect(r.cocok).toBe(true);
    expect(r.arti).toBe('Bukti kegawatan');
  });
  test('cocokVas: kategori sedang TIDAK memicu bukti kegawatan (hanya dikategorikan)', () => {
    const r = t.cocokVas(5);
    expect(r.kategori).toBe('sedang');
    expect(r.cocok).toBe(false);
  });
  test('cocokVas: kategori ringan', () => {
    const r = t.cocokVas(2);
    expect(r.kategori).toBe('ringan');
    expect(r.cocok).toBe(false);
  });
  test('cocokVas: di luar rentang (0) -> kategori null', () => {
    const r = t.cocokVas(0);
    expect(r.kategori).toBe(null);
    expect(r.cocok).toBe(false);
  });
  test('cocokVas: batas tepat 7 (inklusif)', () => {
    expect(t.cocokVas(7).kategori).toBe('berat');
    expect(t.cocokVas(6).kategori).toBe('sedang');
  });

  test('cocokSpo2', () => {
    expect(t.cocokSpo2(93).cocok).toBe(true);
    expect(t.cocokSpo2(94).cocok).toBe(false);
    expect(t.cocokSpo2(88).cocok).toBe(true);
  });

  test('cocokNadi', () => {
    expect(t.cocokNadi(101).cocok).toBe(true);
    expect(t.cocokNadi(100).cocok).toBe(false);
  });
});

describe('buatPenerjemahDariBaris: baris hilang/rusak jatuh ke default, tidak pernah throw', () => {
  test('tabel kosong -> tetap pakai default', () => {
    const t = ak.buatPenerjemahDariBaris([]);
    expect(t.cocokSuhu(40).cocok).toBe(true);
    expect(t.ambang.suhu.sumber).toMatch(/default_awal/);
  });

  test('nilai_ambang rusak (bukan JSON valid) -> jatuh ke default, tidak throw', () => {
    const baris = [{ penanda: 'nadi', nilai_ambang: 'bukan json valid {{{', arti: 'custom', sumber: 'casemix' }];
    const t = ak.buatPenerjemahDariBaris(baris);
    expect(() => t.cocokNadi(150)).not.toThrow();
    expect(t.cocokNadi(150).cocok).toBe(true); // fallback nilai default (>100)
  });

  test('arti kustom dari DB dipakai (bukan arti default) kalau baris ada', () => {
    const baris = barisDariDefault();
    baris.find((b) => b.penanda === 'suhu').arti = 'Ambang suhu versi casemix Oktober';
    const t = ak.buatPenerjemahDariBaris(baris);
    expect(t.cocokSuhu(41).arti).toBe('Ambang suhu versi casemix Oktober');
  });
});

describe('ensureSchema', () => {
  test('DDL membuat tabel ambang_klinis dengan UNIQUE penanda', async () => {
    const ditulis = [];
    const dijalankan = [];
    const db = {
      query: async (q) => { ditulis.push(q); },
      run: async (sql, p) => { dijalankan.push({ sql, p }); return { changes: 1 }; },
    };
    await ak.ensureSchema(db);
    expect(ditulis[0]).toMatch(/CREATE TABLE IF NOT EXISTS ambang_klinis/);
    expect(ditulis[0]).toMatch(/penanda VARCHAR\(40\) NOT NULL UNIQUE/);
  });

  test('seed 5 baris default lewat INSERT ... ON CONFLICT DO NOTHING', async () => {
    const dijalankan = [];
    const db = {
      query: async () => {},
      run: async (sql, p) => { dijalankan.push({ sql, p }); return { changes: 1 }; },
    };
    await ak.ensureSchema(db);
    expect(dijalankan.length).toBe(5);
    expect(dijalankan.every((d) => /ON CONFLICT \(penanda\) DO NOTHING/.test(d.sql))).toBe(true);
    const penanda = dijalankan.map((d) => d.p[0]).sort();
    expect(penanda).toEqual(['nadi', 'nyeri_vas', 'spo2', 'suhu', 'tekanan_darah'].sort());
  });
});

describe('modul tidak memakai jaringan', () => {
  test('tidak ada fetch/axios/http', () => {
    const src = require('fs').readFileSync(require.resolve('../../services/ambangKlinisService'), 'utf8');
    expect(src).not.toMatch(/fetch\(|require\('https?'\)|axios/);
  });
});
