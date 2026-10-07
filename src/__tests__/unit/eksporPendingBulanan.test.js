/**
 * Ekspor pending bulanan: satu lembar berisi judul, tabel alasan pending &
 * saran dengan kolom Jawaban Rumah Sakit kosong, dan keterangan di bawah.
 * Data sintetis -- bukan pasien asli.
 */
const ExcelJS = require('exceljs');
const {
  KOLOM, BARIS_JUDUL_TABEL, alasanDanSaran, satuPerSep, waktuWib, labelKolom,
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
    expect(header).toEqual(['No', 'SEP', 'Nama Pasien', 'Status', 'Ringkasan', 'Alasan Pending', 'Saran / Tindakan', 'Jawaban Rumah Sakit']);
    expect(header).not.toContain('Masalah data klaim');
  });

  test('baris data urut SEP, Jawaban Rumah Sakit kosong untuk diisi casemix', async () => {
    const ws = (await bacaLembar(KLAIM)).worksheets[0];
    const b1 = ws.getRow(BARIS_JUDUL_TABEL + 1);
    const b2 = ws.getRow(BARIS_JUDUL_TABEL + 2);
    expect(b1.getCell(1).value).toBe(1);
    expect(b1.getCell(2).value).toBe('0170R0110826V009901');
    expect(b2.getCell(2).value).toBe('0170R0110826V009902');
    for (const b of [b1, b2]) {
      expect([null, undefined, ''].includes(b.getCell(KOLOM.length).value)).toBe(true);
      expect(b.getCell(KOLOM.length).fill.fgColor.argb).toBe('FFFFF2CC');
    }
    expect(b2.getCell(4).value).toBe('PENDING');
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
      'Jumlah klaim': 2,
      'Tanggal ekspor': '07/10/2026 22:19 WIB',
      'Diekspor oleh': 'uji@medaudit',
    });
  });

  test('periode tanpa klaim pending: tabel tetap ada dengan keterangan kosong', async () => {
    const ws = (await bacaLembar([])).worksheets[0];
    expect(ws.getCell(BARIS_JUDUL_TABEL + 1, 1).value).toBe('Tidak ada klaim pending pada periode ini.');
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
