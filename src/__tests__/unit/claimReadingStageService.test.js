const {
  TAHAP_PEMBACAAN,
  VERSI_TAHAP,
  simpanTahapPembacaan,
} = require('../../services/claimReadingStageService');

function dbMock() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    prepare(sql) {
      return {
        async run(id, recordId, stageKey, stageVersion, status, inputRef, output) {
          calls.push({ sql, args: [id, recordId, stageKey, stageVersion, status, inputRef, output] });
          const key = `${recordId}|${stageKey}|${stageVersion}`;
          rows.set(key, { id: rows.get(key)?.id || id, recordId, stageKey, stageVersion, status, inputRef, output });
        },
      };
    },
  };
}

describe('claimReadingStageService', () => {
  test('menetapkan enam stage key dengan versi awal', () => {
    expect(Object.values(TAHAP_PEMBACAAN)).toEqual([
      'ambil_teks', 'jenis_halaman', 'bagian', 'temuan_kutipan', 'pembakuan', 'kode_cocok_silang',
    ]);
    expect(Object.keys(VERSI_TAHAP)).toHaveLength(6);
    expect(Object.values(VERSI_TAHAP).every(v => v === '1')).toBe(true);
  });

  test('upsert idempotent: pemanggilan ulang memperbarui stage+versi yang sama', async () => {
    const db = dbMock();
    await simpanTahapPembacaan(db, {
      recordId: 'klaim-1', stageKey: TAHAP_PEMBACAAN.JENIS_HALAMAN,
      output: { halaman: [{ nomor: 2, jenis: 'resume_medis' }] },
    });
    const pertama = [...db.rows.values()][0];
    await simpanTahapPembacaan(db, {
      recordId: 'klaim-1', stageKey: TAHAP_PEMBACAAN.JENIS_HALAMAN,
      output: { halaman: [{ nomor: 2, jenis: 'triase_igd' }] },
    });

    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0].id).toBe(pertama.id);
    expect(JSON.parse([...db.rows.values()][0].output)).toEqual({ halaman: [{ nomor: 2, jenis: 'triase_igd' }] });
    expect(db.calls[0].sql).toMatch(/ON CONFLICT\(record_id, stage_key, stage_version\) DO UPDATE/);
  });

  test('serialisasi objek keluaran dan referensi JSON aman', async () => {
    const db = dbMock();
    const disimpan = await simpanTahapPembacaan(db, {
      recordId: 'klaim-2', stageKey: TAHAP_PEMBACAAN.TEMUAN_KUTIPAN,
      inputRef: { tahap_sebelumnya: 'bagian', halaman: [2] },
      output: { temuan: [{ teks: 'Diagnosa kolik abdomen', kutipan: 'A Diagnosa kolik abdomen', halaman: 2 }] },
    });
    expect(JSON.parse(db.calls[0].args[5])).toEqual({ tahap_sebelumnya: 'bagian', halaman: [2] });
    expect(JSON.parse(db.calls[0].args[6])).toEqual(disimpan.output);
  });

  test('tahap ambil teks hanya menyimpan referensi halaman ocr_results', async () => {
    const db = dbMock();
    await simpanTahapPembacaan(db, {
      recordId: 'klaim-3', stageKey: TAHAP_PEMBACAAN.AMBIL_TEKS,
      inputRef: { sumber: 'ocr_results', halaman: [1, 2] },
      output: { jumlah_halaman: 2, metode: 'native_text' },
    });
    expect(JSON.parse(db.calls[0].args[5])).toEqual({ sumber: 'ocr_results', halaman: [1, 2] });
    await expect(simpanTahapPembacaan(db, {
      recordId: 'klaim-3', stageKey: TAHAP_PEMBACAAN.AMBIL_TEKS,
      inputRef: { sumber: 'ocr_results', halaman: [1] },
      output: { ocr_text: 'teks mentah duplikat' },
    })).rejects.toThrow(/tidak boleh disalin/);
  });

  test('menolak referensi teks yang bukan ocr_results serta status tidak sah', async () => {
    const db = dbMock();
    await expect(simpanTahapPembacaan(db, {
      recordId: 'klaim-4', stageKey: TAHAP_PEMBACAAN.AMBIL_TEKS,
      inputRef: { sumber: 'inline', halaman: [1] },
    })).rejects.toThrow(/ocr_results/);
    await expect(simpanTahapPembacaan(db, {
      recordId: 'klaim-4', stageKey: TAHAP_PEMBACAAN.BAGIAN, status: 'menunggu_review',
    })).rejects.toThrow(/Status tahap tidak sah/);
    expect(db.calls).toHaveLength(0);
  });
});
