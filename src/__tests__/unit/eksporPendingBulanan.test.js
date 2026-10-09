/**
 * Ekspor pending bulanan: satu lembar berisi judul, tabel alasan pending &
 * saran dengan kolom Jawaban Rumah Sakit kosong, dan keterangan di bawah.
 * Data sintetis -- bukan pasien asli.
 */
const ExcelJS = require('exceljs');
const {
  KOLOM, BARIS_JUDUL_TABEL, alasanDanSaran, satuPerSep, kelompokkanKunjungan, pilihKlaimPending, waktuWib, labelKolom,
  buatEksporPendingBulanan, namaBerkasPendingBulanan,
} = require('../../services/eksporPendingBulananService');

const KLAIM = [
  {
    id: 'a', sep: '0170R0110826V009902', nama_pasien: 'PASIEN UJI DUA', kode_rs: '3371084',
    validation_status: 'error', created_at: '2026-09-03',
    ai_review: JSON.stringify({
      putusan_pending: { ringkasan: 'Ada risiko pending yang perlu ditinjau.', alasan: [
        { ringkas: 'Pneumonia tanpa hasil foto toraks', bukti: 'Tidak ada lembar radiologi', tindakan: 'Lampirkan hasil foto toraks' },
      ] },
      field_notes: { dpjp_name: 'Isi sesuai resume medis.' },
    }),
    errors: [{ field_name: 'dpjp_name', error_message: 'DPJP wajib diisi.' }],
  },
  {
    id: 'b', sep: '0170R0110826V009901', nama_pasien: 'PASIEN UJI SATU', kode_rs: '3371084',
    validation_status: 'pending', created_at: '2026-09-02',
    ai_review: JSON.stringify({ putusan_pending: { ringkasan: 'Berisiko pending', alasan: [
      { ringkas: 'Kunjungan IGD tanpa kriteria gawat darurat', bukti: 'Triase hal. 1', tindakan: 'Lengkapi kriteria K1-K5' },
    ] } }),
    errors: [],
  },
];

async function bacaLembar(records, cakupan = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buatEksporPendingBulanan(records, { periode: '2026-08', diexportOleh: 'uji@medaudit', waktu: new Date('2026-10-07T15:19:00Z'), ...cakupan }));
  return wb;
}
const isiBaris = (ws, r) => ws.getRow(r).values.slice(1);

describe('bentuk berkas', () => {
  test('hanya satu lembar', async () => {
    const wb = await bacaLembar(KLAIM);
    expect(wb.worksheets).toHaveLength(1);
    expect(wb.worksheets[0].name).toBe('Pending Agustus 2026');
  });

  test('judul di atas tabel, bukan tabel polos', async () => {
    const ws = (await bacaLembar(KLAIM)).worksheets[0];
    expect(ws.getCell('A1').value).toBe('DAFTAR KLAIM PENDING');
    expect(ws.getCell('A1').font.bold).toBe(true);
    expect(ws.getCell('A2').value).toBe('RS Lestari Raharja (3371084) · Periode Agustus 2026');
    expect(String(ws.getCell('A3').value)).toMatch(/bukan keputusan BPJS/);
  });

  test('kolom tabel: Masalah data klaim diganti Jawaban Rumah Sakit', async () => {
    const ws = (await bacaLembar(KLAIM)).worksheets[0];
    const header = isiBaris(ws, BARIS_JUDUL_TABEL);
    expect(header).toEqual(['No', 'Status', 'SEP', 'Nama Pasien', 'Tanggal', 'ICD-10 (Diagnosis)', 'ICD-9-CM (Prosedur)', 'Alasan Pending', 'Saran / Tindakan', 'Jawaban Rumah Sakit']);
    expect(header).not.toContain('Masalah data klaim');
    expect(header).not.toContain('Ringkasan');
  });

  test('baris data urut SEP, Jawaban Rumah Sakit kosong untuk diisi casemix', async () => {
    const ws = (await bacaLembar(KLAIM)).worksheets[0];
    const b1 = ws.getRow(BARIS_JUDUL_TABEL + 1);
    const b2 = ws.getRow(BARIS_JUDUL_TABEL + 2);
    expect(b1.getCell(1).value).toBe(1);
    expect(b1.getCell(3).value).toBe('0170R0110826V009901');
    expect(b2.getCell(3).value).toBe('0170R0110826V009902');
    for (const b of [b1, b2]) {
      expect([null, undefined, ''].includes(b.getCell(KOLOM.length).value)).toBe(true);
      expect(b.getCell(KOLOM.length).fill.fgColor.argb).toBe('FFFFF2CC');
    }
    expect(b2.getCell(2).value).toBe('PENDING');
  });

  test('keterangan ada di bawah tabel, jam ekspor dalam WIB', async () => {
    const ws = (await bacaLembar(KLAIM)).worksheets[0];
    const akhirTabel = BARIS_JUDUL_TABEL + KLAIM.length;
    expect(ws.getCell(akhirTabel + 2, 1).value).toBe('Keterangan');
    const ket = {};
    for (let r = akhirTabel + 3; r <= ws.rowCount; r++) ket[ws.getCell(r, 1).value] = ws.getCell(r, 3).value;
    expect(ket).toEqual({
      Periode: 'Agustus 2026',
      Isi: 'Klaim berstatus pending menurut medaudit (bukan keputusan BPJS)',
      'Cara hitung': 'Satu baris per kunjungan (SEP) yang masih punya unggahan berstatus pending. Bila berkas yang sama diunggah berkali-kali, alasan diambil dari unggahan pending terbaru.',
      'Jumlah klaim': 2,
      'Tanggal ekspor': '07/10/2026 22:19 WIB',
      'Diekspor oleh': 'uji@medaudit',
    });
  });

  test('periode tanpa klaim pending: tabel tetap ada, kode RS dari akun tetap tampil', async () => {
    const ws = (await bacaLembar([], { kodeRs: '3371084' })).worksheets[0];
    expect(ws.getCell(BARIS_JUDUL_TABEL + 1, 1).value).toBe('Tidak ada klaim pending pada periode ini.');
    expect(ws.getCell('A2').value).toBe('RS Lestari Raharja (3371084) · Periode Agustus 2026');
    expect(namaBerkasPendingBulanan([], '2026-10', '3371084')).toBe('3371084_202610_PENDING.xlsx');
  });

  test('periode yang semua klaimnya valid: tidak ada baris pending', async () => {
    const valid = [{ id: 'v1', sep: 'S1', validation_status: 'valid', created_at: '2026-10-01', ai_review: '{}', errors: [] }];
    const ws = (await bacaLembar(valid)).worksheets[0];
    expect(ws.getCell(BARIS_JUDUL_TABEL + 1, 1).value).toBe('Tidak ada klaim pending pada periode ini.');
  });

  test('SEP tidak terbaca: ditandai dengan nama berkas, bukan dibiarkan kosong', async () => {
    const tanpaSep = [{ id: 't1', sep: '', file_name: '178677.pdf', nama_pasien: 'PASIEN UJI', validation_status: 'error', created_at: '2026-09-01', ai_review: '{}', errors: [] }];
    const ws = (await bacaLembar(tanpaSep)).worksheets[0];
    expect(ws.getCell(BARIS_JUDUL_TABEL + 1, 3).value).toBe('(SEP tidak terbaca — berkas 178677.pdf)');
  });
});

describe('alasan pending & saran', () => {
  test('alasan putusan dan masalah data digabung, nama kolom terbaca', () => {
    const a = alasanDanSaran(KLAIM[0]);
    expect(a.ringkasan).toBe('Ada risiko pending yang perlu ditinjau.');
    expect(a.alasan).toBe('1. Pneumonia tanpa hasil foto toraks (Tidak ada lembar radiologi)\n2. Data klaim DPJP: DPJP wajib diisi.');
    expect(a.saran).toBe('1. Lampirkan hasil foto toraks\n2. DPJP: Isi sesuai resume medis.');
    expect(a.alasan).not.toMatch(/dpjp_name/);
  });
  test('klaim pending hanya karena data tetap punya alasan dan ringkasan', () => {
    const a = alasanDanSaran({ ai_review: '{}', errors: [{ field_name: 'diagnosa_list', error_message: 'DIAGLIST wajib diisi.' }] });
    expect(a.ringkasan).toBe('Ada data klaim yang perlu diperbaiki.');
    expect(a.alasan).toBe('1. Data klaim DIAGLIST: DIAGLIST wajib diisi.');
  });
  test('label kolom', () => {
    expect(labelKolom('dpjp_name')).toBe('DPJP');
    expect(labelKolom('kolom_lain')).toBe('KOLOM_LAIN');
  });
});

describe('satu baris per kunjungan, unggahan terakhir menentukan (kasus 7 Okt 2026)', () => {
  // Meniru data September: pasien A diunggah 5x (terakhir pending), pasien B
  // diunggah 6x -- 4 unggahan lama SEP tidak terbaca & bermasalah, 2 unggahan
  // terakhir ber-SEP dan valid -- pasien C sekali, valid.
  const u = (id, o) => ({ id, ai_review: '{}', errors: [], ...o });
  const A = (id, st, t) => u(id, { sep: '0170R0110926V001943', mrn: '105088', admission_date: '2026-09-17', validation_status: st, created_at: t });
  const B = (id, st, t, sep = '') => u(id, { sep, mrn: '178677', admission_date: '2026-09-15', validation_status: st, created_at: t, file_name: '178677.pdf' });
  const DATA = [
    A('a1', 'valid', '2026-09-23T07:39'), A('a2', 'valid', '2026-09-25T09:07'), A('a3', 'valid', '2026-09-25T19:59'),
    A('a4', 'valid', '2026-09-25T20:26'), A('a5', 'pending', '2026-09-25T20:46'),
    B('b1', 'valid', '2026-09-22T01:04'), B('b2', 'error', '2026-09-23T08:21'), B('b3', 'valid', '2026-09-23T15:17'),
    B('b4', 'error', '2026-09-25T08:57'), B('b5', 'valid', '2026-10-04T01:30', '0170R0110926V001733'),
    B('b6', 'valid', '2026-10-04T03:05', '0170R0110926V001733'),
    u('c1', { sep: '0170R0110926V002984', mrn: '178894', admission_date: '2026-09-26', validation_status: 'valid', created_at: '2026-10-06' }),
  ];

  test('12 unggahan = 3 kunjungan', () => {
    const k = kelompokkanKunjungan(DATA);
    expect(k).toHaveLength(3);
    expect(Object.fromEntries(k.map(x => [x.sep, [x.id, x.jumlah_unggahan]]))).toEqual({
      '0170R0110926V001943': ['a5', 5],
      '0170R0110926V001733': ['b6', 6],
      '0170R0110926V002984': ['c1', 1],
    });
  });

  test('setiap kunjungan yang masih punya unggahan pending diekspor (sama dengan layar)', () => {
    // A: unggahan pending terbaru a5. B: masih punya 2 unggahan error di layar
    // -> masuk, diwakili error terbaru b4, SEP dari unggahan lain. C: valid.
    const hasil = pilihKlaimPending(DATA);
    expect(hasil.map(x => [x.id, x.sep])).toEqual([
      ['b4', '0170R0110926V001733'],
      ['a5', '0170R0110926V001943'],
    ]);
  });

  test('unggahan lama pending tetap terekspor walau unggahan terbaru valid', () => {
    const d = [A('lama', 'pending', '2026-09-01'), A('baru', 'valid', '2026-09-02')];
    expect(pilihKlaimPending(d).map(x => x.id)).toEqual(['lama']);
  });

  test('kunjungan yang semua unggahannya valid tidak diekspor', () => {
    expect(pilihKlaimPending([A('v1', 'valid', '2026-09-01'), A('v2', 'valid', '2026-09-02')])).toEqual([]);
  });

  test('tanpa SEP & tanpa padanan: kunjungan berdiri sendiri per MRN + tanggal masuk', () => {
    const d = [B('x1', 'error', '2026-09-01'), B('x2', 'error', '2026-09-02')];
    const k = pilihKlaimPending(d);
    expect(k.map(x => [x.id, x.jumlah_unggahan])).toEqual([['x2', 2]]);
  });

  test('dua SEP berbeda di MRN + tanggal yang sama: unggahan tanpa SEP tidak ditebak masuk salah satunya', () => {
    const d = [
      u('s1', { sep: 'SEP-POLI-A', mrn: 'M1', admission_date: '2026-09-10', validation_status: 'valid', created_at: '2026-09-10T08:00' }),
      u('s2', { sep: 'SEP-POLI-B', mrn: 'M1', admission_date: '2026-09-10', validation_status: 'valid', created_at: '2026-09-10T09:00' }),
      u('s3', { sep: '', mrn: 'M1', admission_date: '2026-09-10', validation_status: 'error', created_at: '2026-09-11' }),
    ];
    expect(kelompokkanKunjungan(d)).toHaveLength(3);
    expect(pilihKlaimPending(d).map(x => x.id)).toEqual(['s3']);
  });

  test('tanggal masuk berupa Date tidak bergeser zona waktu', () => {
    const d = [
      u('d1', { sep: 'S9', mrn: 'M9', admission_date: new Date(2026, 8, 15), validation_status: 'valid', created_at: '2026-09-20' }),
      u('d2', { sep: '', mrn: 'M9', admission_date: '2026-09-15', validation_status: 'error', created_at: '2026-09-16' }),
    ];
    expect(kelompokkanKunjungan(d)).toHaveLength(1);
  });
});

describe('kolom Tanggal & ICD', () => {
  test('tanggal masuk–pulang dan kode ICD tampil di baris', async () => {
    const d = [{
      id: 'i1', sep: 'SEP1', nama_pasien: 'PASIEN UJI', validation_status: 'pending', created_at: '2026-09-01',
      admission_date: '2026-09-15', discharge_date: new Date(2026, 8, 18), diagnosa_list: 'I51.7;I48', prosedur_list: '90.59;89.52',
      ai_review: '{}', errors: [],
    }, {
      id: 'i2', sep: 'SEP2', nama_pasien: 'PASIEN UJI 2', validation_status: 'error', created_at: '2026-09-02',
      admission_date: '2026-09-20', discharge_date: '2026-09-20', diagnosa_list: 'R10.4', prosedur_list: '',
      ai_review: '{}', errors: [],
    }];
    const ws = (await bacaLembar(d)).worksheets[0];
    const b1 = isiBaris(ws, BARIS_JUDUL_TABEL + 1);
    const b2 = isiBaris(ws, BARIS_JUDUL_TABEL + 2);
    expect(b1.slice(4, 7)).toEqual(['15/09/2026 – 18/09/2026', 'I51.7; I48', '90.59; 89.52']);
    expect(b2.slice(4, 7)).toEqual(['20/09/2026', 'R10.4', '-']);
  });
});

describe('pembantu', () => {
  test('unggahan ulang SEP yang sama: yang terbaru dipakai', () => {
    const d = satuPerSep([
      { id: 'lama', sep: 'A1', created_at: '2026-09-01' },
      { id: 'baru', sep: 'a1', created_at: '2026-09-05' },
      { id: 'lain', sep: 'B2', created_at: '2026-09-02' },
    ]);
    expect(d.map(r => r.id)).toEqual(['baru', 'lain']);
  });
  test('waktu WIB tidak bergantung zona waktu server', () => {
    expect(waktuWib(new Date('2026-12-31T17:30:00Z'))).toBe('01/01/2027 00:30 WIB');
  });
  test('nama berkas', () => {
    expect(namaBerkasPendingBulanan([{ raw_data: { KODE_RS: '3371084' } }], '2026-08')).toBe('3371084_202608_PENDING.xlsx');
  });
});
