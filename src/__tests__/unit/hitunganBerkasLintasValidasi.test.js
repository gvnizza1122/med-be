/**
 * Validasi ulang lintas berkas (episode internal & PRB) mengubah status klaim
 * di BERKAS LAIN. Hitungan valid/pending/error berkas-berkas itu wajib ikut
 * diperbarui -- dulu tidak, sehingga Riwayat Upload menampilkan "perlu
 * dikerjakan" untuk klaim yang sudah valid (ditemukan 7 Okt 2026).
 */
jest.mock('../../database/init', () => ({ getDb: () => null }));
jest.mock('../../services/validasiRecordKamusService', () => ({ validasiRecordDenganKamus: jest.fn(async () => []) }));

const { detectAndFlagInternalEpisodes, detectAndFlagPRB } = require('../../routes/claimFiles');

/** DB tiruan: mencatat setiap UPDATE claim_files beserta file_id-nya. */
function dbTiruan({ saudara = [], semuaRecord = [] } = {}) {
  const updateBerkas = [];
  const db = {
    prepare: (sql) => ({
      all: async () => {
        if (/FROM validation_rules/.test(sql)) return [];
        if (/JOIN claim_files cf ON cf.id = cr.file_id\s+WHERE cr.nokartu = \? AND cr.admission_date/.test(sql)) return saudara;
        if (/SELECT cr.id, cr.admission_date, cr.diagnosa_list/.test(sql)) return semuaRecord;
        if (/SELECT \* FROM claim_records WHERE id IN/.test(sql)) return semuaRecord;
        return [];
      },
      get: async () => (/SUM\(CASE WHEN validation_status/.test(sql) ? { valid_count: 1, error_count: 0, pending_count: 0 } : null),
      run: async (...nilai) => { if (/UPDATE claim_files SET valid_count/.test(sql)) updateBerkas.push(nilai[nilai.length - 1]); },
    }),
    transaction: async (fn) => fn(db),
  };
  return { db, updateBerkas };
}

const rec = (id, fileId, o = {}) => ({
  id, file_id: fileId, nokartu: '0001111111111', admission_date: '2026-09-17', sep: `SEP-${id}`,
  klinik_poli: 'POLI A', raw_data: '{}', diagnosa_list: 'J45.9', ...o,
});

test('episode internal: hitungan SEMUA berkas saudara diperbarui, masing-masing sekali', async () => {
  const { db, updateBerkas } = dbTiruan({ saudara: [rec('r1', 'berkas-1'), rec('r2', 'berkas-2'), rec('r3', 'berkas-2')] });
  await detectAndFlagInternalEpisodes(db, { hospitalCode: '3371084', nokartu: '0001111111111', admissionDate: '2026-09-17' });
  expect(updateBerkas.sort()).toEqual(['berkas-1', 'berkas-2']);
});

test('episode internal: satu kunjungan saja -- tidak ada validasi ulang & tidak ada update berkas', async () => {
  const { db, updateBerkas } = dbTiruan({ saudara: [rec('r1', 'berkas-1')] });
  await detectAndFlagInternalEpisodes(db, { hospitalCode: '3371084', nokartu: '0001111111111', admissionDate: '2026-09-17' });
  expect(updateBerkas).toEqual([]);
});

test('PRB: hitungan berkas tiap periode pasien ikut diperbarui', async () => {
  // Diagnosis hipertensi (kategori PRB) di dua bulan berbeda, dua berkas.
  const semua = [
    rec('p1', 'berkas-agustus', { admission_date: '2026-08-10', diagnosa_list: 'I10' }),
    rec('p2', 'berkas-september', { admission_date: '2026-09-10', diagnosa_list: 'I10' }),
  ];
  const { db, updateBerkas } = dbTiruan({ semuaRecord: semua });
  await detectAndFlagPRB(db, { hospitalCode: '3371084', mrn: '000101', nokartu: '0001111111111', admissionDate: '2026-09-10', diagnosaList: 'I10' });
  expect(updateBerkas.sort()).toEqual(['berkas-agustus', 'berkas-september']);
});
