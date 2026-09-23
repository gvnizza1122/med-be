const { parseVitalSignsTable } = require('../../services/tableParsingService');

// Baris nyata dari berkas 0170R0110926V001943 (MUNAWIR, 68 th, IGD).
const FORMAT_BARU = 'TRIAGE IGD\nVITAL SIGN BB TB TD Heart Rate RR Temp SpO2\n141/86 mmHg 71 x/mnt 20 x/mnt 36.9oC 88%';
const FORMAT_LAMA = 'Vital Sign BB TB TD Heart Rate RR Temp\n141/86 71 Kali 20 Kali 36.9oC';

describe('Tabel Vital Sign triase — formulir format baru', () => {
  // Inti perbaikannya. Sebelum ini, kolom SpO2 di formulir baru tidak pernah
  // terbaca sama sekali.
  test('SpO2 terbaca dari kolomnya', () => {
    expect(parseVitalSignsTable(FORMAT_BARU).SpO2.value).toBe('88');
  });

  // REGRESI YANG MAHAL: nama kolom "SpO2" berada di ujung baris header, dan
  // angka pertama baris nilai di bawahnya adalah tekanan darah sistolik.
  // Selama pemisah label membolehkan ganti baris, "SpO2\n141" cocok dan
  // saturasi terbaca 141 — dinilai borderline, padahal 88% yang sebenarnya
  // dinilai GAWAT. Bug ini menurunkan derajat kegawatan pasien.
  test('SpO2 TIDAK mengambil angka tekanan darah dari baris di bawahnya', () => {
    const hasil = parseVitalSignsTable(FORMAT_BARU);
    expect(hasil.SpO2.value).not.toBe('141');
    expect(hasil.BloodPressure.value).toBe('141/86');
  });

  test('seluruh tanda vital lain ikut terbaca benar', () => {
    const h = parseVitalSignsTable(FORMAT_BARU);
    expect(h.BloodPressure.value).toBe('141/86');
    expect(h.HeartRate.value).toBe('71');
    expect(h.RespiratoryRate.value).toBe('20');
    expect(h.Temperature.value).toBe('36.9');
  });

  // Nadi dan laju napas sama-sama bersatuan "x/mnt", jadi dipisahkan menurut
  // urutan kemunculan — mengikuti urutan kolomnya di header.
  test('nadi dan laju napas tidak tertukar', () => {
    const h = parseVitalSignsTable(FORMAT_BARU);
    expect(h.HeartRate.value).toBe('71');
    expect(h.RespiratoryRate.value).toBe('20');
  });
});

describe('Tabel Vital Sign triase — formulir format lama', () => {
  test('terbaca walau satuannya "Kali" dan tekanan darah tanpa mmHg', () => {
    const h = parseVitalSignsTable(FORMAT_LAMA);
    expect(h.BloodPressure.value).toBe('141/86');
    expect(h.HeartRate.value).toBe('71');
    expect(h.RespiratoryRate.value).toBe('20');
    expect(h.Temperature.value).toBe('36.9');
  });

  // Formulir lama memang tidak punya kolom SpO2. Kosong di sini benar —
  // yang salah adalah mengisinya dengan angka dari kolom lain.
  test('SpO2 tetap kosong karena kolomnya memang tidak ada', () => {
    expect(parseVitalSignsTable(FORMAT_LAMA).SpO2).toBeUndefined();
  });
});

describe('Bentuk berlabel tetap bekerja', () => {
  test('label eksplisit "SpO2: 97%" terbaca', () => {
    const h = parseVitalSignsTable('VITAL SIGN\nTD: 120/80 HR: 88 x/mnt RR: 20 x/mnt Temp: 36.5 C SpO2: 97%');
    expect(h.SpO2.value).toBe('97');
    expect(h.SpO2.source).toBe('label');
    expect(h.BloodPressure.value).toBe('120/80');
  });

  // Tanda % wajib di jalur label. Tanpa itu, "SpO2" apa pun yang diikuti angka
  // akan diterima — termasuk nama kolom yang diikuti nilai kolom lain.
  test('angka tanpa tanda % tidak diterima lewat jalur label', () => {
    const h = parseVitalSignsTable('VITAL SIGN\nSpO2 97');
    expect(h.SpO2).toBeUndefined();
  });
});

describe('Kehati-hatian', () => {
  test('nilai tunggal x/mnt tidak ditebak jadi nadi maupun laju napas', () => {
    // Menebak di sini berarti mengarang angka yang tidak pernah tertulis.
    const h = parseVitalSignsTable('VITAL SIGN BB TB TD Heart Rate RR Temp\n120/80 mmHg 80 x/mnt');
    expect(h.HeartRate).toBeUndefined();
    expect(h.RespiratoryRate).toBeUndefined();
    expect(h.BloodPressure.value).toBe('120/80');
  });

  test('teks tanpa tabel vital tidak menghasilkan apa-apa', () => {
    expect(parseVitalSignsTable('Halaman rincian biaya\nTotal 1.264.200')).toEqual({});
    expect(parseVitalSignsTable('')).toEqual({});
    expect(parseVitalSignsTable(null)).toEqual({});
  });
});
