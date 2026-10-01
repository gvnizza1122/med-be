// Konteks audit lokal; identitas ini tidak dimasukkan ke prompt model.
const { AsyncLocalStorage } = require('node:async_hooks');
const konteks = new AsyncLocalStorage();
const saatIni = () => konteks.getStore() || {};
const jalankan = (nilai, fn) => konteks.run({ ...saatIni(), ...nilai }, fn);

async function untukRecord(db, record, fn) {
  let nilai = { record_id: record?.id || null, jenis_klaim: record?.jenis_klaim || record?.JENIS_KLAIM };
  if (record?.id && db) {
    try {
      const asal = await db.get(`SELECT cf.hospital_code, cf.jenis_klaim
        FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id WHERE cr.id = ?`, [record.id]);
      if (asal?.hospital_code) nilai = { ...nilai, hospital_code: asal.hospital_code, jenis_klaim: nilai.jenis_klaim || asal.jenis_klaim };
    } catch {
      // Pencatatan best-effort tidak menghentikan penilaian klaim.
    }
  }
  return jalankan(nilai, fn);
}
module.exports = { saatIni, jalankan, untukRecord };
