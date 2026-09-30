const bk = require('../../services/bacaKeduaService');

const T = (kunci, nilai, kutipan, extra = {}) => ({ kunci, nilai, kutipan, halaman: 1, ...extra });

describe('perluBacaKedua', () => {
  const dasar = { jenis_klaim: 'RJ', tarif: 500000, punya_tulisan_tangan: false, keyakinan_luna: 95, diagnosis: 'K30' };

  test('klaim biasa tidak perlu baca kedua', () => {
    expect(bk.perluBacaKedua(dasar)).toEqual({ perlu: false, alasan: [] });
  });

  test.each([
    ['rawat inap (RI)', { jenis_klaim: 'RI' }, 'rawat_inap'],
    ['rawat inap (teks)', { jenis_klaim: 'Rawat Inap' }, 'rawat_inap'],
    ['tarif di atas ambang', { tarif: 15000000 }, 'tarif_tinggi'],
    ['tulisan tangan', { punya_tulisan_tangan: true }, 'tulisan_tangan'],
    ['keyakinan rendah skala 0-100', { keyakinan_luna: 55 }, 'keyakinan_luna_rendah'],
    ['keyakinan rendah skala 0-1', { keyakinan_luna: 0.4 }, 'keyakinan_luna_rendah'],
    ['diagnosis dengan syarat penunjang', { diagnosis: 'J18.9' }, 'diagnosis_punya_syarat_penunjang'],
    ['daftar diagnosis campur', { diagnosis: ['K30', 'J18'] }, 'diagnosis_punya_syarat_penunjang'],
  ])('pemicu: %s', (_, ubah, alasan) => {
    const r = bk.perluBacaKedua({ ...dasar, ...ubah });
    expect(r.perlu).toBe(true);
    expect(r.alasan).toContain(alasan);
  });

  test('ambang bisa diatur lewat opsi dan env', () => {
    expect(bk.perluBacaKedua({ ...dasar, tarif: 600000 }, { ambangTarif: 500000 }).alasan).toContain('tarif_tinggi');
    process.env.BACA_KEDUA_AMBANG_TARIF = '400000';
    expect(bk.perluBacaKedua(dasar).alasan).toContain('tarif_tinggi');
    delete process.env.BACA_KEDUA_AMBANG_TARIF;
    expect(bk.perluBacaKedua(dasar).perlu).toBe(false);
  });

  test('data tak lengkap tidak melempar dan tidak memicu', () => {
    expect(bk.perluBacaKedua({}).perlu).toBe(false);
    expect(bk.perluBacaKedua(null).perlu).toBe(false);
  });

  test('aturan syarat penunjang tidak menangkap kode mirip (J180 bukan J18)', () => {
    expect(bk.perluBacaKedua({ ...dasar, diagnosis: 'J180' }).perlu).toBe(false);
  });
});

describe('bandingkanBacaan', () => {
  test('sama -> usulan dengan dua kutipan, keyakinan naik tapi tetap wajib cek tabel', () => {
    const r = bk.bandingkanBacaan(
      [T('hb', '7,5', 'Hb 7,5 g/dL', { keyakinan: 0.8 })],
      [T('hb', 7.5, 'Hemoglobin: 7.5', { keyakinan: 0.9 })],
    );
    expect(r.perlu_tinjauan).toEqual([]);
    expect(r.usulan).toHaveLength(1);
    const u = r.usulan[0];
    expect(u.sepakat).toBe(true);
    expect(u.kutipan.map((k) => k.pembaca)).toEqual(['luna', 'kimi']);
    expect(u.keyakinan).toBeCloseTo(0.9);
    expect(u.cek_tabel_rujukan_tetap_wajib).toBe(true);
  });

  test('keyakinan tidak pernah lewat 1', () => {
    expect(bk.naikkanKeyakinan(0.98)).toBe(1);
    expect(bk.naikkanKeyakinan(99)).toBe(1);
    expect(bk.naikkanKeyakinan(undefined)).toBeNull();
  });

  test('beda -> perlu_tinjauan, dua versi dengan kutipan masing-masing, tanpa pemenang', () => {
    const r = bk.bandingkanBacaan(
      [T('dx', 'J18.9', 'diagnosis: pneumonia')],
      [T('dx', 'A15.0', 'diagnosis: TB paru')],
    );
    expect(r.usulan).toEqual([]);
    expect(r.perlu_tinjauan).toHaveLength(1);
    expect(r.perlu_tinjauan[0]).toMatchObject({
      status: 'perlu_tinjauan',
      versi_luna: { nilai: 'J18.9', kutipan: 'diagnosis: pneumonia' },
      versi_kimi: { nilai: 'A15.0', kutipan: 'diagnosis: TB paru' },
    });
  });

  test.each([
    ['luna tanpa kutipan', [T('hb', 7, '')], [T('hb', 7, 'Hb 7')], 'kimi'],
    ['kimi tanpa kutipan (spasi)', [T('hb', 7, 'Hb 7')], [T('hb', 7, '   ')], 'luna'],
  ])('versi tanpa kutipan dibuang: %s -> usulan hanya dari pembaca yang berkutipan', (_, l, k, sisa) => {
    const r = bk.bandingkanBacaan(l, k);
    expect(r.perlu_tinjauan).toEqual([]);
    expect(r.usulan).toHaveLength(1);
    expect(r.usulan[0].sumber).toBe(sisa);
    expect(r.usulan[0].sepakat).toBe(false);
    // tanpa kenaikan keyakinan karena bukan kesepakatan
    expect(r.usulan[0].keyakinan).toBeNull();
  });

  test('nilai berbeda tetapi salah satu tanpa kutipan -> bukan perlu_tinjauan', () => {
    const r = bk.bandingkanBacaan([T('hb', 7, 'Hb 7')], [T('hb', 9, '')]);
    expect(r.perlu_tinjauan).toEqual([]);
    expect(r.usulan[0].nilai).toBe(7);
    expect(r.dibuang.kimi).toHaveLength(1);
  });

  test('kedua tanpa kutipan -> tidak ada usulan sama sekali (kesepakatan tak menyelamatkan)', () => {
    const r = bk.bandingkanBacaan([T('hb', 7, '')], [T('hb', 7, null)]);
    expect(r.usulan).toEqual([]);
    expect(r.perlu_tinjauan).toEqual([]);
  });

  test('validasiKutipan suntikan membuang kutipan yang tidak ada di berkas', () => {
    const berkas = 'Hasil lab Hb 7,5 g/dL';
    const validasi = (t) => berkas.includes(t.kutipan);
    const r = bk.bandingkanBacaan([T('hb', 7.5, 'Hb 7,5')], [T('hb', 7.5, 'Hb 7,5 dikarang')], { validasiKutipan: validasi });
    expect(r.usulan[0].sumber).toBe('luna');
    expect(r.dibuang.kimi).toHaveLength(1);
  });

  test('temuan hanya di satu pembaca menjadi usulan biasa; kunci beda-beda digabung', () => {
    const r = bk.bandingkanBacaan(
      [T('a', 1, 'a=1'), T('b', 2, 'b=2')],
      [T('b', 2, 'b: 2'), T('c', 3, 'c=3')],
    );
    const per = Object.fromEntries(r.usulan.map((u) => [u.kunci, u]));
    expect(per.a.sumber).toBe('luna');
    expect(per.b.sepakat).toBe(true);
    expect(per.c.sumber).toBe('kimi');
  });

  test('normalisasi nilai: koma desimal, huruf besar, titik akhir', () => {
    expect(bk.normNilai('7,50')).toBe('7.5');
    expect(bk.normNilai(' PNEUMONIA. ')).toBe('pneumonia');
    expect(bk.normNilai(null)).toBe('');
  });
});

describe('jalankanBacaKedua', () => {
  const luna = [T('hb', 7, 'Hb 7')];

  test('klaim tidak berisiko: Kimi TIDAK dipanggil', async () => {
    const panggil = jest.fn();
    const r = await bk.jalankanBacaKedua({ klaim: { jenis_klaim: 'RJ', tarif: 1, keyakinan_luna: 99, diagnosis: 'K30' }, bacaanLuna: luna, panggilKimi: panggil });
    expect(panggil).not.toHaveBeenCalled();
    expect(r.dipanggil).toBe(false);
    expect(r.usulan).toHaveLength(1);
  });

  test('klaim berisiko: Kimi dipanggil dan dibandingkan', async () => {
    const panggil = jest.fn(async () => [T('hb', 9, 'Hb 9')]);
    const r = await bk.jalankanBacaKedua({ klaim: { jenis_klaim: 'RI' }, bacaanLuna: luna, panggilKimi: panggil });
    expect(panggil).toHaveBeenCalledTimes(1);
    expect(r.dipanggil).toBe(true);
    expect(r.alasan).toContain('rawat_inap');
    expect(r.perlu_tinjauan).toHaveLength(1);
  });

  test('Kimi gagal -> hasil Luna tetap dipakai, klaim tidak tertahan', async () => {
    const r = await bk.jalankanBacaKedua({ klaim: { jenis_klaim: 'RI' }, bacaanLuna: luna, panggilKimi: async () => { throw new Error('timeout'); } });
    expect(r.kimi_gagal).toBe(true);
    expect(r.usulan).toHaveLength(1);
    expect(r.perlu_tinjauan).toEqual([]);
  });
});
