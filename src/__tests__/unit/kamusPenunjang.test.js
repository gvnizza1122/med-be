const {
  rapikan, cocokkan, temukanDalamTeks, catatVarianBelumDikenali, seedKamusPenunjang, SINGKATAN_BERTABRAKAN,
} = require('../../services/kamusPenunjangService');
const DATA = require('../../data/kamusPenunjang.json');

describe('rapikan', () => {
  test('Ro. Thorax, RO-THORAX, dan ro thorax jatuh ke satu kunci', () => {
    expect(rapikan('Ro. Thorax')).toBe('ro thorax');
    expect(rapikan('RO-THORAX')).toBe('ro thorax');
    expect(rapikan('ro   thorax')).toBe('ro thorax');
  });

  test('thorax / thoraks / torak disatukan', () => {
    expect(rapikan('rontgen thoraks')).toBe(rapikan('rontgen thorax'));
    expect(rapikan('rontgen torak')).toBe(rapikan('rontgen thorax'));
  });

  test('röntgen dan salah ejaan OCR menjadi rontgen', () => {
    expect(rapikan('röntgen thorax')).toBe('rontgen thorax');
    expect(rapikan('ronsen thorax')).toBe('rontgen thorax');
    expect(rapikan('rontgent thorax')).toBe('rontgen thorax');
  });

  test('garis miring dipertahankan karena bermakna', () => {
    expect(rapikan('UR / CR')).toBe('ur/cr');
    expect(rapikan('BT/CT')).toBe('bt/ct');
  });
});

describe('cocokkan — istilah biasa', () => {
  test('tiga penulisan rontgen toraks menghasilkan istilah yang sama', () => {
    for (const t of ['Ro. Thorax', 'RO-THORAX', 'foto thoraks', 'röntgen thorax', 'CXR']) {
      expect(cocokkan(t).istilah_id).toBe('rontgen_toraks');
    }
  });

  test('istilah Belanda dikenali', () => {
    expect(cocokkan('BBS').istilah_id).toBe('led');
    expect(cocokkan('BSS').istilah_id).toBe('gds');
    expect(cocokkan('BSN').istilah_id).toBe('gdp');
    expect(cocokkan('Astrup').istilah_id).toBe('agd');
    expect(cocokkan('maag slang').istilah_id).toBe('pemasangan_ngt');
    expect(cocokkan('BNO').istilah_id).toBe('foto_polos_abdomen');
    expect(cocokkan('GV').istilah_id).toBe('perawatan_luka');
    expect(cocokkan('hecting').istilah_id).toBe('penjahitan_luka');
    expect(cocokkan('heating').istilah_id).toBe('penjahitan_luka');
  });

  test('penanda syarat klaim terbawa', () => {
    expect(cocokkan('widal').menjadi_syarat).toBe(true);
    expect(cocokkan('NS1').menjadi_syarat).toBe(true);
    expect(cocokkan('GeneXpert').menjadi_syarat).toBe(true);
    expect(cocokkan('hematocrit').menjadi_syarat).toBe(true);
    expect(cocokkan('EKG').menjadi_syarat).toBe(false);
  });

  test('tulisan asing tidak dikenali, tidak ditebak', () => {
    expect(cocokkan('zzz pemeriksaan aneh').status).toBe('tidak_dikenali');
    expect(cocokkan('').status).toBe('tidak_dikenali');
  });
});

describe('kode hanya usulan', () => {
  // Aturan paling penting: tidak ada jalur yang menandai kode sudah sah.
  test('setiap hasil dikenali membawa kode_terverifikasi=false', () => {
    for (const e of DATA.istilah) {
      for (const v of e.varian) {
        const h = cocokkan(v);
        if (h.status === 'dikenali') expect(h.kode_terverifikasi).toBe(false);
      }
    }
  });

  test('kode dikembalikan sebagai kode_usulan, bukan kode', () => {
    const h = cocokkan('nebulizer');
    expect(h.kode_usulan).toBe('93.94');
    expect(h).not.toHaveProperty('kode');
  });
});

describe('singkatan bertabrakan', () => {
  test('sepuluh singkatan terdaftar', () => {
    expect([...SINGKATAN_BERTABRAKAN].sort()).toEqual(['al', 'bt', 'ct', 'dc', 'ht', 'pt', 'rm', 'tc', 'ua', 'ur'].sort());
  });

  // Contoh terburuk dari catatan: DC di lab bukan kateter.
  test('DC di bagian lab = hitung jenis, di bagian tindakan = kateter', () => {
    expect(cocokkan('DC', { bagian: 'lab' }).istilah_id).toBe('hitung_jenis');
    expect(cocokkan('DC', { bagian: 'tindakan' }).istilah_id).toBe('kateter_urin');
  });

  test('DC tanpa konteks = perlu konfirmasi, tidak menebak', () => {
    const h = cocokkan('DC');
    expect(h.status).toBe('perlu_konfirmasi');
    expect(h.kandidat.map(k => k.istilah_id).sort()).toEqual(['hitung_jenis', 'kateter_urin']);
    expect(h.kode_usulan).toBeUndefined();
  });

  test('DC di bagian yang tidak ada di kedua arti = perlu konfirmasi', () => {
    expect(cocokkan('DC', { bagian: 'radiologi' }).status).toBe('perlu_konfirmasi');
  });

  test('kata sekitar bisa memutuskan bila bagian tidak diketahui', () => {
    expect(cocokkan('DC', { sekitar: 'pasang kateter urin DC no 16' }).istilah_id).toBe('kateter_urin');
    expect(cocokkan('DC', { sekitar: 'leukosit neutrofil DC' }).istilah_id).toBe('hitung_jenis');
  });

  test('kata sekitar yang cocok dengan KEDUA arti tidak memutuskan', () => {
    expect(cocokkan('DC', { sekitar: 'kateter urin dan leukosit' }).status).toBe('perlu_konfirmasi');
  });

  test('UR: berpasangan UR/CR = ureum; berdiri sendiri = perlu konfirmasi', () => {
    expect(cocokkan('UR/CR').istilah_id).toBe('fungsi_ginjal');
    expect(cocokkan('UR').status).toBe('perlu_konfirmasi');
  });

  test('UA: nilai mg/dL = asam urat; disertai sedimen = urinalisa', () => {
    expect(cocokkan('UA', { sekitar: 'UA 6,5 mg/dL' }).istilah_id).toBe('asam_urat');
    expect(cocokkan('UA', { sekitar: 'UA sedimen leukosit' }).istilah_id).toBe('urin_lengkap');
  });

  test('BT/CT utuh = lab; BT bersatuan celcius = suhu', () => {
    expect(cocokkan('BT/CT').istilah_id).toBe('masa_perdarahan');
    expect(cocokkan('BT', { sekitar: 'BT 36,5 C' }).istilah_id).toBe('suhu_tubuh');
  });

  test('RM diikuti nomor = rekam medis; dengan lpm = masker', () => {
    expect(cocokkan('RM', { sekitar: 'No RM 123456' }).istilah_id).toBe('rekam_medis');
    expect(cocokkan('RM', { sekitar: 'RM 10 lpm' }).istilah_id).toBe('terapi_oksigen');
  });

  test('setiap kandidat bertabrakan menyebut konteks pembeda', () => {
    for (const [singkatan, kandidat] of Object.entries(DATA.ambigu)) {
      expect(kandidat.length).toBeGreaterThanOrEqual(2);
      for (const k of kandidat) {
        expect(k.pola || (k.bagian && k.bagian.length)).toBeTruthy();
      }
    }
  });

  test('singkatan bertabrakan tidak juga terdaftar sebagai varian biasa', () => {
    const biasa = new Set();
    for (const e of DATA.istilah) e.varian.forEach(v => biasa.add(rapikan(v)));
    for (const s of SINGKATAN_BERTABRAKAN) expect(biasa.has(s)).toBe(false);
  });
});

describe('temukanDalamTeks', () => {
  test('menemukan beberapa pemeriksaan sekaligus', () => {
    const t = temukanDalamTeks('Ro thorax, EKG, dan nebulisasi 2x');
    const ids = t.map(x => x.istilah_id);
    expect(ids).toEqual(expect.arrayContaining(['rontgen_toraks', 'ekg', 'nebulisasi']));
  });

  test('frasa terpanjang menang: "CT scan thorax" bukan CT kepala', () => {
    const t = temukanDalamTeks('CT scan thorax kontras');
    expect(t.map(x => x.istilah_id)).toContain('ct_toraks');
    expect(t.map(x => x.istilah_id)).not.toContain('ct_kepala');
  });

  // Singkatan pendek terselip di kalimat = terlalu sering bukan pemeriksaan.
  test('singkatan pendek di dalam kalimat tidak dipindai', () => {
    expect(temukanDalamTeks('pasien at home, sc dan NK tidak ada, obat 1 gram')).toEqual([]);
  });

  test('singkatan bertabrakan tidak pernah dipilih dari kalimat bebas', () => {
    expect(temukanDalamTeks('DC 10 dan CT baik')).toEqual([]);
  });

  test('semua hasil pindai membawa kode_terverifikasi=false', () => {
    for (const x of temukanDalamTeks('nebulisasi ekg rontgen thorax widal')) {
      expect(x.kode_terverifikasi).toBe(false);
    }
  });
});

describe('antrean varian belum dikenali', () => {
  test('mencatat bentuk yang sudah dirapikan dan menambah hitungan lewat upsert', async () => {
    const sql = [];
    const db = { run: async (s, p) => { sql.push({ s, p }); return { changes: 1 }; } };
    const kunci = await catatVarianBelumDikenali(db, 'Pemeriksaan-ABC.', 'klaim-1');
    expect(kunci).toBe('pemeriksaan abc');
    expect(sql[0].s).toMatch(/ON CONFLICT \(varian_rapi\) DO UPDATE/);
    expect(sql[0].s).toMatch(/jumlah_muncul \+ 1/);
    expect(sql[0].p).toEqual(['pemeriksaan abc', 'klaim-1']);
  });

  test('teks kosong tidak dicatat', async () => {
    const db = { run: jest.fn() };
    expect(await catatVarianBelumDikenali(db, '  ')).toBeNull();
    expect(db.run).not.toHaveBeenCalled();
  });
});

describe('seedKamusPenunjang', () => {
  test('semua kode masuk sebagai belum terverifikasi', async () => {
    const panggilan = [];
    const db = { run: async (s, p) => { panggilan.push({ s, p }); return { changes: 1 }; } };
    await seedKamusPenunjang(db);
    const istilah = panggilan.filter(c => /INTO kamus_penunjang/.test(c.s));
    expect(istilah.length).toBe(DATA.istilah.length + DATA.istilah_tambahan.length);
    for (const c of istilah) expect(c.s).toMatch(/FALSE/);
  });

  test('varian bertabrakan disimpan ambigu=TRUE dengan konteks pembeda', async () => {
    const panggilan = [];
    const db = { run: async (s, p) => { panggilan.push({ s, p }); return { changes: 1 }; } };
    await seedKamusPenunjang(db);
    const ambigu = panggilan.filter(c => /ambigu, konteks_pembeda/.test(c.s));
    expect(ambigu.length).toBe(Object.values(DATA.ambigu).reduce((n, k) => n + k.length, 0));
    for (const c of ambigu) expect(c.p[3]).toBeTruthy();
  });

  test('semua istilah kandidat bertabrakan ada di kamus (tidak melanggar kunci asing)', () => {
    const ids = new Set([...DATA.istilah, ...DATA.istilah_tambahan].map(e => e.id));
    for (const kandidat of Object.values(DATA.ambigu)) {
      for (const k of kandidat) expect(ids.has(k.istilah)).toBe(true);
    }
  });
});
