const pm = require('../../services/pemantauPergeseranPendingService');

// Baris sintetis: bentuk mengikuti bpjs_pending_responses (tanggal_pending, alasan_parsed, kdinacbg).
function baris(bulan, kategori, n, dx = 'A-4-10-I') {
  return Array.from({ length: n }, (_, i) => ({
    tanggal_pending: `${bulan}-${String((i % 27) + 1).padStart(2, '0')}`,
    alasan_parsed: kategori,
    kdinacbg: dx,
    nama_peserta: 'JANGAN KELUAR',
    sep: 'RAHASIA',
  }));
}

// Tiga bulan dasar: 100 kasus/bulan, 60% koding, 30% penunjang, 10% dokumen.
function dasar() {
  const r = [];
  for (const b of ['2026-05', '2026-06', '2026-07']) {
    r.push(...baris(b, 'koding_diagnosis', 60, 'J-4-10-I'), ...baris(b, 'penunjang', 30, 'K-1-1-I'), ...baris(b, 'kelengkapan_dokumen', 10, 'A-4-10-I'));
  }
  return r;
}

describe('bulanDari / normKategori', () => {
  test('format tanggal Indonesia dan ISO', () => {
    expect(pm.bulanDari('2026-07-15')).toBe('2026-07');
    expect(pm.bulanDari('15/07/2026')).toBe('2026-07');
    expect(pm.bulanDari('5-7-2026')).toBe('2026-07');
    expect(pm.bulanDari('2026-07')).toBe('2026-07');
    expect(pm.bulanDari(new Date(2026, 6, 15))).toBe('2026-07');
    expect(pm.bulanDari('2026-13-01')).toBeNull();
    expect(pm.bulanDari('')).toBeNull();
    expect(pm.bulanDari(null)).toBeNull();
  });
  test('normKategori', () => {
    expect(pm.normKategori(' Koding Diagnosis ')).toBe('koding_diagnosis');
    expect(pm.normKategori(null)).toBe('tidak_terklasifikasi');
  });
});

describe('pantauPergeseran', () => {
  test('tabel kosong / tanpa pembanding: jujur, tidak ada tanda', () => {
    const kosong = pm.pantauPergeseran([]);
    expect(kosong).toMatchObject({ data_cukup: false, kategori_baru: [], lonjakan_pangsa: [], lonjakan_diagnosis: [] });
    const satuBulan = pm.pantauPergeseran(baris('2026-07', 'apa_saja', 20));
    expect(satuBulan.data_cukup).toBe(false);
    expect(satuBulan.kategori_baru).toEqual([]);
    expect(satuBulan.catatan).toMatch(/pembanding/);
  });

  test('pola stabil -> tidak ada tanda', () => {
    const r = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'koding_diagnosis', 60, 'J-4-10-I'), ...baris('2026-08', 'penunjang', 30, 'K-1-1-I'), ...baris('2026-08', 'kelengkapan_dokumen', 10)]);
    expect(r.bulan).toBe('2026-08');
    expect(r.data_cukup).toBe(true);
    expect(r.kategori_baru).toEqual([]);
    expect(r.lonjakan_pangsa).toEqual([]);
    expect(r.lonjakan_diagnosis).toEqual([]);
  });

  test('kategori baru terdeteksi', () => {
    const r = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'koding_diagnosis', 50), ...baris('2026-08', 'ba_kesepakatan_baru', 3)]);
    expect(r.kategori_baru).toEqual([{ kategori: 'ba_kesepakatan_baru', jumlah: 3, pangsa: 0.0566 }]);
  });

  test('kategoriDikenal dari luar membuat kategori tak dianggap baru', () => {
    const r = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'koding_diagnosis', 50), ...baris('2026-08', 'ba_kesepakatan_baru', 3)],
      { kategoriDikenal: ['ba_kesepakatan_baru'] });
    expect(r.kategori_baru).toEqual([]);
  });

  test('pangsa naik jauh di atas rata-rata 3 bulan terdeteksi (10% -> 35%)', () => {
    const r = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'koding_diagnosis', 40), ...baris('2026-08', 'penunjang', 25), ...baris('2026-08', 'kelengkapan_dokumen', 35)]);
    expect(r.lonjakan_pangsa).toHaveLength(1);
    expect(r.lonjakan_pangsa[0]).toMatchObject({ kategori: 'kelengkapan_dokumen', jumlah: 35 });
    expect(r.lonjakan_pangsa[0].rasio).toBe(3.5);
    expect(r.lonjakan_pangsa[0].bulan_pembanding).toHaveLength(3);
  });

  test('kenaikan kecil (10% -> 15%) tidak dianggap lonjakan; kategori kecil di bawah minKasus diabaikan', () => {
    const r = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'koding_diagnosis', 55), ...baris('2026-08', 'penunjang', 30), ...baris('2026-08', 'kelengkapan_dokumen', 15)]);
    expect(r.lonjakan_pangsa).toEqual([]);
    const kecil = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'kelengkapan_dokumen', 4)], { minKasus: 5 });
    expect(kecil.lonjakan_pangsa).toEqual([]);
  });

  test('lonjakan per diagnosis, termasuk diagnosis yang baru muncul', () => {
    const r = pm.pantauPergeseran([
      ...dasar(),
      ...baris('2026-08', 'koding_diagnosis', 60, 'J-4-10-I'),
      ...baris('2026-08', 'penunjang', 30, 'K-1-1-I'),
      ...baris('2026-08', 'kelengkapan_dokumen', 20, 'A-4-10-I'), // 10 -> 20
      ...baris('2026-08', 'penunjang', 8, 'Z-9-9-I'),            // baru
    ]);
    const per = Object.fromEntries(r.lonjakan_diagnosis.map((d) => [d.diagnosis, d]));
    expect(per['A-4-10-I']).toMatchObject({ jumlah: 20, rata_pembanding: 10, rasio: 2, baru_muncul: false });
    expect(per['Z-9-9-I']).toMatchObject({ jumlah: 8, baru_muncul: true, rasio: null });
    expect(per['J-4-10-I']).toBeUndefined();
    // yang baru muncul diurutkan paling atas
    expect(r.lonjakan_diagnosis[0].diagnosis).toBe('Z-9-9-I');
  });

  test('bulan kosong di tengah jendela tidak menarik rata-rata ke bawah', () => {
    // Mei kosong; Juni & Juli 10 kasus koding_diagnosis dari 20.
    const rows = [...baris('2026-06', 'a', 10), ...baris('2026-06', 'b', 10), ...baris('2026-07', 'a', 10), ...baris('2026-07', 'b', 10), ...baris('2026-08', 'a', 10), ...baris('2026-08', 'b', 10)];
    const r = pm.pantauPergeseran(rows);
    expect(r.bulan_pembanding).toEqual(['2026-07', '2026-06']);
    expect(r.lonjakan_pangsa).toEqual([]);
  });

  test('lintas tahun: jendela Jan mengambil Okt-Des tahun lalu', () => {
    const rows = [];
    for (const b of ['2025-10', '2025-11', '2025-12']) rows.push(...baris(b, 'a', 9), ...baris(b, 'b', 1));
    rows.push(...baris('2026-01', 'a', 4), ...baris('2026-01', 'b', 6));
    const r = pm.pantauPergeseran(rows);
    expect(r.bulan).toBe('2026-01');
    expect(r.bulan_pembanding).toEqual(['2025-12', '2025-11', '2025-10']);
    expect(r.lonjakan_pangsa[0]).toMatchObject({ kategori: 'b', rasio: 6 });
  });

  test('opsi bulan eksplisit dan kategorikan/kunciDiagnosis suntikan', () => {
    const rows = dasar().map((r) => ({ ...r, alasan_parsed: undefined, alasan_raw: `Alasan ${r.alasan_parsed}` }));
    const r = pm.pantauPergeseran(rows, {
      bulan: '2026-07', kategorikan: (x) => x.alasan_raw.replace('Alasan ', ''), kunciDiagnosis: (x) => x.kdinacbg,
    });
    expect(r.bulan).toBe('2026-07');
    expect(r.total_bulan_ini).toBe(100);
    expect(r.bulan_pembanding).toEqual(['2026-06', '2026-05']);
  });

  test('identitas peserta tidak ikut dikembalikan', () => {
    const r = pm.pantauPergeseran([...dasar(), ...baris('2026-08', 'baru', 10)]);
    const teks = JSON.stringify(r);
    expect(teks).not.toContain('JANGAN KELUAR');
    expect(teks).not.toContain('RAHASIA');
  });

  test('baris rusak (tanpa tanggal, null) diabaikan tanpa melempar', () => {
    expect(() => pm.pantauPergeseran([null, {}, { tanggal_pending: 'x' }, ...dasar()])).not.toThrow();
  });
});
