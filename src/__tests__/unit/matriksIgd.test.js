/** Matriks IGD BA 2024: kriteria a-e dari triase, durasi dari jam tercatat, indikasi, ruang/DPJP. Fixture anonim. */
const { kriteriaGawatDarurat, durasiIgd, indikasiRawatInap } = require('../../services/matriksIgdService');
const p = (n, t) => ({ page_number: n, ocr_text: t });
const triase = (o = {}) => p(4, ['TRIAGE IGD', `Tanggal : ${o.tgl || '3 Oktober 2026'}`, `Mulai Pukul : ${o.jam || '21:25'} WIB`, `Skor ESI : ESI ${o.esi || 2}`,
  'BB TB TD Heart Rate RR Temp SpO2', 'VITAL SIGN', o.vital || '60 kg 139/82 mmHg 72 x/mnt 22 x/mnt 37oC 98%',
  'PRIMARY Airway Breathing Circulation Disability Exposure', `SURVEY ${o.abc || 'Clear Clear Clear Clear Clear'}`, o.gcs || 'Hasil Compos Menthis'].join('\n'));
const dewasa = { umur_tahun: 30, admission_date: '2026-10-03' };

test('tanpa kriteria a-e: daftar yang terbaca disebut', () => {
  const r = kriteriaGawatDarurat(dewasa, [triase()]);
  expect(r.kena).toEqual([]);
  expect(r.terbaca.join(' ')).toMatch(/ESI 2.*GCS 15.*TD sistolik 139.*SpO2 98%/);
});
test.each([
  ['ESI 1', { esi: 1 }, 'a'],
  ['primary survey abnormal', { abc: 'Clear Sesak Clear Clear Clear' }, 'b'],
  ['GCS <=8', { gcs: 'GCS : 7' }, 'c'],
  ['SpO2 <91', { vital: '60 kg 120/80 mmHg 90 x/mnt 24 x/mnt 37oC 88%' }, 'b'],
  ['TD sistolik <90', { vital: '60 kg 80/50 mmHg 110 x/mnt 22 x/mnt 37oC 96%' }, 'd'],
])('kriteria gawat darurat: %s', (_, o, kode) => {
  expect(kriteriaGawatDarurat(dewasa, [triase(o)]).kena.map(k => k.kode)).toContain(kode);
});
test('anak memakai batas tanda vital menurut usia (PNPK Sepsis Anak)', () => {
  const anak = { umur_tahun: 10, birth_date: '2016-01-01', admission_date: '2026-10-03' };
  expect(kriteriaGawatDarurat(anak, [triase({ vital: '33 kg 163 x/mnt 32 x/mnt 36.2°C' })]).kena[0].nama).toMatch(/Nadi 163.*>140/);
  expect(kriteriaGawatDarurat(anak, [triase({ vital: '33 kg 120 x/mnt 32 x/mnt 36.2°C' })]).kena).toEqual([]);
});
test('durasi IGD dari jam triase sampai tiba di ruang rawat dari UGD', () => {
  const d = durasiIgd([triase(), p(9, 'Tiba di ruangan : Graha dari ruangan : UGD Tanggal : 3 Oktober 2026 Pukul : 21:45 Dokter yang merawat : dr. A, Sp.PD')]);
  expect(d.jam).toBe(0.3);
  expect(durasiIgd([triase()]).jam).toBeNull();
});
test('indikasi rawat inap pada baris berikut terbaca; label kosong yang diikuti label lain tidak', () => {
  expect(indikasiRawatInap([p(1, 'Indikasi Rawat Inap :\nObs febris H4')])[0].kutipan).toMatch(/Obs febris/);
  expect(indikasiRawatInap([p(1, 'Alasan masuk rawat inap:\nTerapi/Pengobatan selama di rumah sakit:')])).toEqual([]);
});
