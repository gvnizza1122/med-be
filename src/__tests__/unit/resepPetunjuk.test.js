const { parseAturanPakai, cariObat, petunjukDariResep, KAMUS_OBAT } = require('../../services/resepPetunjukService');

describe('parseAturanPakai', () => {
  test.each([
    ['3dd1', 3, 1], ['3x1', 3, 1], ['3 x 1', 3, 1], ['2 dd 1/2', 2, 0.5], ['3dd1/2 tab', 3, 0.5], ['3 dd 1½', 3, 1.5], ['1x2', 1, 2],
  ])('%s', (teks, frek, dosis) => {
    const r = parseAturanPakai(teks);
    expect(r.frekuensi_per_hari).toBe(frek);
    expect(r.dosis_angka).toBe(dosis);
    expect(r.prn).toBe(false);
  });

  test('prn, k/p, s.n. dikenali sebagai pemakaian bila perlu', () => {
    expect(parseAturanPakai('prn').alasan_prn).toBe('prn');
    expect(parseAturanPakai('k/p').alasan_prn).toBe('k/p');
    expect(parseAturanPakai('kalau perlu').prn).toBe(true);
    expect(parseAturanPakai('s.n.').alasan_prn).toBe('s.n.');
    expect(parseAturanPakai('3dd1 prn').frekuensi_per_hari).toBe(3);
  });

  test('ac, pc, hs dan durasi', () => {
    expect(parseAturanPakai('3dd1 a.c.').waktu).toBe('sebelum_makan');
    expect(parseAturanPakai('3dd1 pc').waktu).toBe('sesudah_makan');
    expect(parseAturanPakai('1x1 sesudah makan').waktu).toBe('sesudah_makan');
    expect(parseAturanPakai('1x1 h.s.').waktu).toBe('sebelum_tidur');
    expect(parseAturanPakai('3dd1 selama 5 hari').durasi_hari).toBe(5);
  });

  test('singkatan tidak menangkap potongan kata lain', () => {
    expect(parseAturanPakai('Ascorbic acid tablet').waktu).toBeNull();
    expect(parseAturanPakai('Snack pagi').prn).toBe(false);
    expect(parseAturanPakai('hasil pcr').waktu).toBeNull();
  });

  test('teks tanpa aturan tidak dikenali', () => {
    expect(parseAturanPakai('').dikenali).toBe(false);
    expect(parseAturanPakai('abc').dikenali).toBe(false);
  });
});

describe('cariObat', () => {
  test('merek dan generik dipetakan', () => {
    expect(cariObat('Proris 400 mg 3dd1').entri.generik).toBe('ibuprofen');
    expect(cariObat('Ventasal 3dd1').entri.generik).toBe('salbutamol');
    expect(cariObat('Sucralfate syr 3dd1 c').entri.id).toBe('sukralfat');
    expect(cariObat('antasida doen 3dd1').entri.id).toBe('antasida');
  });

  test('bukan obat = null', () => {
    expect(cariObat('kontrol 1 minggu')).toBeNull();
  });
});

describe('petunjukDariResep', () => {
  test('sukralfat memberi pertanyaan lambung, bukan diagnosis', () => {
    const r = petunjukDariResep('R/ Sucralfate syr 3dd1 ac\nR/ Paracetamol 500 mg 3dd1');
    expect(r.petunjuk).toHaveLength(1);
    const p = r.petunjuk[0];
    expect(p.pertanyaan).toMatch(/gangguan lambung.*yang belum dicatat/);
    expect(p.menambah_diagnosis).toBe(false);
    expect(p.kode).toBeNull();
    expect(p.aturan_pakai.waktu).toBe('sebelum_makan');
  });

  test('obat simtomatik (Proris) tidak memberi petunjuk penyakit', () => {
    const r = petunjukDariResep('Proris 400 mg 3dd1');
    expect(r.petunjuk).toHaveLength(0);
    expect(r.baris[0].generik).toBe('ibuprofen');
  });

  test('bronkodilator memberi petunjuk napas; prn menurunkan kekuatan', () => {
    const r = petunjukDariResep('Ventasal 2,5 mg prn');
    expect(r.petunjuk[0].kelompok).toBe('napas');
    expect(r.petunjuk[0].kekuatan).toBe('lemah');
  });

  test('diagnosis sudah tercatat: tidak ada pertanyaan, hanya catatan sejalan', () => {
    const r = petunjukDariResep('Ventasal 3dd1', { teksDiagnosis: 'Diagnosa utama: Asma bronkial' });
    expect(r.petunjuk[0].pertanyaan).toBeNull();
    expect(r.petunjuk[0].sudah_tercatat_di_diagnosis).toBe(true);
  });

  test('satu petunjuk per kelompok walau beberapa obat', () => {
    const r = petunjukDariResep('Omeprazole 1x1\nSucralfate 3dd1\nAntasida 3dd1');
    expect(r.petunjuk).toHaveLength(1);
  });

  test('obat tidak dikenal beraturan pakai dicatat, tidak dibuang diam-diam', () => {
    const r = petunjukDariResep('Zorbex 3dd1');
    expect(r.obat_tidak_dikenali).toEqual(['Zorbex 3dd1']);
    expect(r.petunjuk).toHaveLength(0);
  });

  test('petunjuk beku dan tidak pernah membawa kode', () => {
    const p = petunjukDariResep('Amlodipine 1x1').petunjuk[0];
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.kode).toBeNull();
    expect(p.menambah_diagnosis).toBe(false);
  });
});

describe('kamusObat.json', () => {
  test('setiap entri punya generik/merek/golongan/kelompok dan tanda terverifikasi boolean', () => {
    for (const e of KAMUS_OBAT.obat) {
      expect(typeof e.terverifikasi).toBe('boolean');
      expect(Array.isArray(e.merek)).toBe(true);
      expect(e.golongan).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(KAMUS_OBAT.kelompok, e.kelompok)).toBe(true);
    }
  });

  test('tidak ada kode ICD di kamus obat', () => {
    expect(JSON.stringify(KAMUS_OBAT.obat)).not.toMatch(/\b[A-Z]\d{2}\.\d\b/);
  });

  test('entri yang belum pasti ditandai terverifikasi:false', () => {
    expect(KAMUS_OBAT.obat.find(e => e.id === 'narfoz').terverifikasi).toBe(false);
  });
});
