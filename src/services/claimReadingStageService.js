/**
 * Penyimpanan aditif jejak enam tahap pembacaan berkas.
 * Teks mentah halaman tetap di ocr_results; service ini menyimpan referensi
 * halaman dan hasil terstruktur per versi tahap.
 */

const { v4: uuidv4 } = require('uuid');

const TAHAP_PEMBACAAN = Object.freeze({
  AMBIL_TEKS: 'ambil_teks',
  JENIS_HALAMAN: 'jenis_halaman',
  BAGIAN: 'bagian',
  TEMUAN_KUTIPAN: 'temuan_kutipan',
  PEMBAKUAN: 'pembakuan',
  KODE_COCOK_SILANG: 'kode_cocok_silang',
});

const VERSI_TAHAP = Object.freeze({
  [TAHAP_PEMBACAAN.AMBIL_TEKS]: '1',
  [TAHAP_PEMBACAAN.JENIS_HALAMAN]: '1',
  [TAHAP_PEMBACAAN.BAGIAN]: '1',
  [TAHAP_PEMBACAAN.TEMUAN_KUTIPAN]: '1',
  [TAHAP_PEMBACAAN.PEMBAKUAN]: '1',
  [TAHAP_PEMBACAAN.KODE_COCOK_SILANG]: '1',
});

const STATUS_TAHAP = new Set(['selesai', 'gagal', 'dilewati']);
const KUNCI_TEKS_MENTAH = new Set(['ocr_text', 'raw_text', 'teks_halaman', 'full_page_text', 'page_text']);

function validasiTidakAdaTeksMentah(nilai, jalur = 'payload') {
  if (!nilai || typeof nilai !== 'object') return;
  if (Array.isArray(nilai)) {
    nilai.forEach((item, index) => validasiTidakAdaTeksMentah(item, `${jalur}[${index}]`));
    return;
  }
  for (const [kunci, isi] of Object.entries(nilai)) {
    if (KUNCI_TEKS_MENTAH.has(kunci.toLowerCase())) {
      throw new Error(`Teks halaman mentah tidak boleh disalin ke jejak tahap (${jalur}.${kunci}); gunakan referensi ocr_results.`);
    }
    validasiTidakAdaTeksMentah(isi, `${jalur}.${kunci}`);
  }
}

function serialisasiObjek(nilai, nama) {
  if (nilai === undefined || nilai === null) return '{}';
  if (typeof nilai !== 'object' || Array.isArray(nilai)) {
    throw new TypeError(`${nama} harus berupa objek JSON.`);
  }
  validasiTidakAdaTeksMentah(nilai, nama);
  let json;
  try {
    json = JSON.stringify(nilai);
  } catch (err) {
    throw new TypeError(`${nama} tidak dapat diserialisasi sebagai JSON: ${err.message}`);
  }
  if (json === undefined) throw new TypeError(`${nama} tidak dapat diserialisasi sebagai JSON.`);
  return json;
}

function validasiReferensiTeks(stageKey, inputRef) {
  if (stageKey !== TAHAP_PEMBACAAN.AMBIL_TEKS) return;
  if (inputRef.sumber !== 'ocr_results' || !Array.isArray(inputRef.halaman) || inputRef.halaman.length === 0) {
    throw new TypeError('Tahap ambil_teks wajib menunjuk halaman yang tersimpan di ocr_results melalui input_ref.sumber dan input_ref.halaman.');
  }
  if (inputRef.halaman.some(n => !Number.isInteger(n) || n < 1)) {
    throw new TypeError('Nomor halaman pada referensi ocr_results harus bilangan bulat positif.');
  }
}

/**
 * Simpan atau perbarui snapshot satu tahap. Panggilan berulang untuk klaim,
 * tahap, dan versi yang sama memperbarui baris yang sama (idempotent).
 *
 * @param {object} db dbHelper atau wrapper transaksi dari database/init
 * @param {{recordId:string,stageKey:string,stageVersion?:string,status?:string,inputRef?:object,output?:object}} data
 */
async function simpanTahapPembacaan(db, data = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('Koneksi database wajib menyediakan prepare().');
  const recordId = String(data.recordId || '').trim();
  if (!recordId) throw new TypeError('recordId wajib diisi.');
  const stageKey = data.stageKey;
  if (!Object.values(TAHAP_PEMBACAAN).includes(stageKey)) throw new TypeError(`Tahap pembacaan tidak dikenal: ${stageKey || '(kosong)'}.`);
  const stageVersion = String(data.stageVersion || VERSI_TAHAP[stageKey]).trim();
  if (!stageVersion) throw new TypeError('stageVersion wajib diisi.');
  const status = data.status || 'selesai';
  if (!STATUS_TAHAP.has(status)) throw new TypeError(`Status tahap tidak sah: ${status}.`);
  const inputRef = data.inputRef || {};
  const output = data.output || {};
  const inputRefJson = serialisasiObjek(inputRef, 'inputRef');
  const outputJson = serialisasiObjek(output, 'output');
  validasiReferensiTeks(stageKey, inputRef);

  const id = uuidv4();
  await db.prepare(`
    INSERT INTO claim_reading_stages
      (id, record_id, stage_key, stage_version, status, input_ref, output_json)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
    ON CONFLICT(record_id, stage_key, stage_version) DO UPDATE SET
      status = EXCLUDED.status,
      input_ref = EXCLUDED.input_ref,
      output_json = EXCLUDED.output_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, recordId, stageKey, stageVersion, status, inputRefJson, outputJson);

  return {
    record_id: recordId,
    stage_key: stageKey,
    stage_version: stageVersion,
    status,
    input_ref: JSON.parse(inputRefJson),
    output: JSON.parse(outputJson),
  };
}

module.exports = { TAHAP_PEMBACAAN, VERSI_TAHAP, simpanTahapPembacaan };
