const { deteksiNegasi, tandaiNegasi } = require('../../services/negasiTemuanService');
const {
  BAGIAN, petakanBagian, bagianKutipan, tentukanPeranTemuan, beriPeran,
} = require('../../services/bagianTemuanService');

describe('deteksiNegasi', () => {
  test.each([
    'Rh -/-', 'Wh -/-', 'rh: -/-', 'sesak (-)', 'tdk ada sesak', 'tidak ada demam',
    'demam disangkal', 'hasil negatif', 'Rh −/−', 'tanpa muntah',
  ])('%s => disangkal', (t) => {
    expect(deteksiNegasi(t).disangkal).toBe(true);
  });

  test.each(['Rh +/+', 'sesak (+)', 'ada ronkhi', 'hasil positif'])('%s => tidak disangkal', (t) => {
    const r = deteksiNegasi(t);
    expect(r.disangkal).toBe(false);
    expect(r.polaritas).toBe('positif');
  });

  test('campuran -/+ tidak dianggap disangkal', () => {
    const r = deteksiNegasi('Rh -/+');
    expect(r.disangkal).toBe(false);
    expect(r.polaritas).toBe('tidak_jelas');
  });

  test('per klausa: hipertensi (+), DM (-)', () => {
    const t = 'riwayat hipertensi (+), DM (-)';
    expect(deteksiNegasi(t, 'hipertensi').disangkal).toBe(false);
    expect(deteksiNegasi(t, 'DM').disangkal).toBe(true);
  });

  test('teks kosong atau istilah tak ada tidak disangkal', () => {
    expect(deteksiNegasi('').disangkal).toBe(false);
    expect(deteksiNegasi('nyeri (-)', 'batuk').disangkal).toBe(false);
  });
});

describe('tandaiNegasi', () => {
  test('rh -/- tidak pernah dibaca "ada ronkhi": dipertahankan dan ditandai', () => {
    const t = tandaiNegasi({ jenis: 'penunjang', teks: 'ronkhi', kutipan: 'Rh -/-' });
    expect(t.disangkal).toBe(true);
    expect(t.perlu_cek_manusia).toBe(true);
    expect(t.teks).toBe('ronkhi');
  });

  test('model bilang tidak disangkal tetapi teks menyangkal: teks menang', () => {
    expect(tandaiNegasi({ teks: 'sesak', kutipan: 'sesak (-)', disangkal: false }).disangkal).toBe(true);
  });

  test('istilah diambil dari teks temuan pada klausa yang benar', () => {
    const k = 'riwayat hipertensi (+), DM (-)';
    expect(tandaiNegasi({ teks: 'hipertensi', kutipan: k }).disangkal).toBe(false);
    expect(tandaiNegasi({ teks: 'DM', kutipan: k }).disangkal).toBe(true);
  });
});

const RESUME = [
  'Anamnesa: batuk 3 hari',
  'Riwayat hipertensi (+)',
  'Pemeriksaan fisik: Rh -/-',
  'Diagnosa Utama : Bronkitis akut',
  'Diagnosa Sekunder : Hipertensi',
  'Terapi: ambroxol 3dd1',
].join('\n');

describe('petakanBagian dan peran', () => {
  test('bagian dikenali', () => {
    const b = petakanBagian(RESUME).map(x => x.bagian);
    expect(b).toEqual(expect.arrayContaining([BAGIAN.ANAMNESIS, BAGIAN.DIAGNOSIS, BAGIAN.TERAPI, BAGIAN.FISIK]));
  });

  test('riwayat hipertensi di anamnesis bukan diagnosis', () => {
    expect(bagianKutipan(RESUME, 'Riwayat hipertensi (+)')).toBe(BAGIAN.ANAMNESIS);
    const t = beriPeran({ teks: 'hipertensi', kutipan: 'Riwayat hipertensi (+)' }, RESUME);
    expect(t.peran).toBe('riwayat');
    expect(t.boleh_jadi_diagnosis).toBe(false);
  });

  test('hipertensi di blok diagnosis boleh menjadi diagnosis', () => {
    const t = beriPeran({ teks: 'hipertensi', kutipan: 'Diagnosa Sekunder : Hipertensi' }, RESUME);
    expect(t.bagian).toBe(BAGIAN.DIAGNOSIS);
    expect(t.boleh_jadi_diagnosis).toBe(true);
  });

  test('anamnesis + bukti terapi: hanya saran berlabel, belum diagnosis', () => {
    const p = tentukanPeranTemuan({ bagian: BAGIAN.ANAMNESIS, adaBuktiTerapi: true });
    expect(p.peran).toBe('saran_diagnosis');
    expect(p.boleh_jadi_diagnosis).toBe(false);
    expect(p.label).toMatch(/Disarankan/);
  });

  test('terapi/resep hanya petunjuk; disangkal tidak pernah diagnosis', () => {
    expect(tentukanPeranTemuan({ bagian: BAGIAN.TERAPI }).boleh_jadi_diagnosis).toBe(false);
    expect(tentukanPeranTemuan({ bagian: BAGIAN.DIAGNOSIS, disangkal: true }).boleh_jadi_diagnosis).toBe(false);
  });

  test('diagnosis banding bukan diagnosis', () => {
    const t = 'Diagnosa Banding: TB paru';
    expect(bagianKutipan(t, 'TB paru')).toBe(BAGIAN.DIAGNOSIS_BANDING);
  });

  test('kutipan tak ada di teks mengembalikan null', () => {
    expect(bagianKutipan(RESUME, 'kolera')).toBeNull();
  });
});
