/**
 * Ekspor pending bulanan berstruktur MIX E-Klaim. Data sintetis -- bukan pasien asli.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { parseClaimFile } = require('../../services/fileParser');
const {
  KOLOM_MIX, KOLOM_ANGKA, barisMix, alasanDanSaran, satuPerSep, buatEksporPendingMix, namaBerkasPendingMix,
} = require('../../services/eksporPendingMixService');

function nilaiSintetis(k, i) {
  const contoh = {
    KODE_RS: '3371084', KELAS_RS: 'D', KELAS_RAWAT: '3', KODE_TARIF: 'DS', PTD: '2',
    ADMISSION_DATE: '01/08/2026', DISCHARGE_DATE: '01/08/2026', BIRTH_DATE: '12/01/1965', SEX: '1',
    DISCHARGE_STATUS: '1', DIAGLIST: 'Z09.8;G62.9', PROCLIST: '-', INACBG: 'Q-5-44-0',
    DESKRIPSI_INACBG: 'PENYAKIT KRONIS KECIL LAIN-LAIN', TARIF_INACBG: '192400', TOTAL_TARIF: '192400',
    TARIF_RS: '250000', NAMA_PASIEN: `PASIEN UJI ${i}`, MRN: '000123', SEP: `0170R0110826V00000${i}`,
    NOKARTU: '0001234567890', IDRG_DIAG_LISTS: 'Z09.8;G62.9', IDRG_DRG_CODE: '1160220',
    IDRG_TOTAL_COST_WEIGHT: '0.61', IDRG_NBR: '461474', IDRG_TOTAL_TARIF: '281499', IDRG_COST_WEIGHT: '0.61',
  };
  return contoh[k] !== undefined ? contoh[k] : (KOLOM_ANGKA.has(k) ? '0' : '');
}

function tulisMixSintetis(jumlah = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'));
  const berkas = path.join(dir, '3371084_20260901_MIX.TXT');
  const baris = [KOLOM_MIX.join('\t')];
  for (let i = 1; i <= jumlah; i++) baris.push(KOLOM_MIX.map(k => nilaiSintetis(k, i)).join('\t'));
  fs.writeFileSync(berkas, baris.join('\r\n') + '\r\n');
  return berkas;
}

describe('struktur MIX', () => {
  test('93 kolom, urutan tetap, kolom iDRG di akhir', () => {
    expect(KOLOM_MIX).toHaveLength(93);
    expect(KOLOM_MIX[0]).toBe('KODE_RS');
    expect(KOLOM_MIX[92]).toBe('IDRG_LOGIC_VERSION');
    expect(new Set(KOLOM_MIX).size).toBe(93);
  });
});

describe('TXT MIX -> pembaca upload -> Excel -> isi sama', () => {
  test('setiap sel lembar MIX sama dengan TXT aslinya', async () => {
    const parsed = parseClaimFile(tulisMixSintetis(2));
    expect(parsed.records).toHaveLength(2);
    const records = parsed.records.map((r, i) => ({
      id: `r${i}`, sep: r._rawData.SEP, created_at: '2026-09-01', validation_status: 'pending',
      raw_data: JSON.stringify(r._rawData), diagnosa_list: r._rawData.DIAGLIST, prosedur_list: r._rawData.PROCLIST,
    }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buatEksporPendingMix(records, { periode: '2026-08' }));
    const ws = wb.getWorksheet('MIX');
    expect(ws.getRow(1).values.slice(1)).toEqual(KOLOM_MIX);
    const asli = fs.readFileSync(tulisMixSintetis(2), 'utf8').split('\r\n').filter(Boolean).slice(1).map(l => l.split('\t'));
    for (let b = 0; b < 2; b++) {
      const sel = ws.getRow(b + 2).values.slice(1);
      KOLOM_MIX.forEach((k, j) => {
        const harap = KOLOM_ANGKA.has(k) && asli[b][j] !== '' ? Number(asli[b][j]) : asli[b][j];
        expect([k, sel[j] ?? '']).toEqual([k, harap]);
      });
    }
  });
});

describe('barisMix', () => {
  test('nomor kartu & MRN tetap teks (nol di depan tidak hilang), tarif angka', () => {
    const b = barisMix({ raw_data: { NOKARTU: '0001234567890', MRN: '000123', TOTAL_TARIF: '192400', IDRG_TOTAL_COST_WEIGHT: '0.61' } });
    expect(b.NOKARTU).toBe('0001234567890');
    expect(b.MRN).toBe('000123');
    expect(b.TOTAL_TARIF).toBe(192400);
    expect(b.IDRG_TOTAL_COST_WEIGHT).toBe(0.61);
  });
  test('DIAGLIST memakai nilai terkini sesudah koreksi koder', () => {
    expect(barisMix({ diagnosa_list: 'J45.9', raw_data: { DIAGLIST: 'J45.3' } }).DIAGLIST).toBe('J45.9');
  });
  test('klaim dari PDF tanpa kolom di raw_data memakai kolom basis data; tanggal format TXT', () => {
    const b = barisMix({ sep: '0170R0110826V000009', nama_pasien: 'PASIEN UJI', admission_date: '2026-08-03', raw_data: {} });
    expect(b.SEP).toBe('0170R0110826V000009');
    expect(b.ADMISSION_DATE).toBe('03/08/2026');
    expect(b.IDRG_DRG_CODE).toBe('');
  });
});

describe('alasan pending & saran', () => {
  test('dari putusan pending dan masalah data, bernomor', () => {
    const a = alasanDanSaran({
      ai_review: JSON.stringify({
        putusan_pending: { ringkasan: 'Berisiko pending', alasan: [{ ringkas: 'Diagnosis tidak didukung resume', bukti: 'hal. 2', tindakan: 'Lengkapi resume' }] },
        field_notes: { diagnosa_list: 'Kode J45.3 perlu dicek' },
      }),
      errors: [{ field_name: 'diagnosa_list', error_message: 'asli' }],
    });
    expect(a.ringkasan).toBe('Berisiko pending');
    expect(a.alasan).toBe('1. Diagnosis tidak didukung resume (hal. 2)');
    expect(a.saran).toBe('1. Lengkapi resume');
    expect(a.masalah_data).toBe('1. diagnosa_list: Kode J45.3 perlu dicek');
  });
});

describe('satu klaim per SEP & nama berkas', () => {
  test('unggahan ulang SEP yang sama: yang terbaru dipakai', () => {
    const d = satuPerSep([
      { id: 'lama', sep: 'A1', created_at: '2026-09-01' },
      { id: 'baru', sep: 'a1', created_at: '2026-09-05' },
      { id: 'lain', sep: 'B2', created_at: '2026-09-02' },
    ]);
    expect(d.map(r => r.id)).toEqual(['baru', 'lain']);
  });
  test('nama berkas meniru pola E-Klaim', () => {
    expect(namaBerkasPendingMix([{ raw_data: { KODE_RS: '3371084' } }], '2026-08')).toBe('3371084_202608_PENDING.xlsx');
  });
});
