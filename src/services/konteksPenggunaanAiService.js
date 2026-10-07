// Konteks audit lokal; identitas ini tidak dimasukkan ke prompt model.
const { AsyncLocalStorage } = require('node:async_hooks');
const konteks = new AsyncLocalStorage();
const saatIni = () => konteks.getStore() || {};
const jalankan = (nilai, fn) => konteks.run({ ...saatIni(), ...nilai }, fn);

async function untukRecord(db, record, fn) {
  let asal;
  let nilai = { record_id: record?.id || null, jenis_klaim: record?.jenis_klaim || record?.JENIS_KLAIM,
    hospital_code: record?.hospital_code || record?.KODE_RS || saatIni().hospital_code || null };
  if (record?.id && db) {
    try {
      asal = await db.get(`SELECT cf.id AS file_id,cf.file_path,cf.file_name,cf.hospital_code, cf.jenis_klaim,cf.ai_anggaran_id
        FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id WHERE cr.id = ?`, [record.id]);
      if (asal?.hospital_code) nilai = { ...nilai, hospital_code: asal.hospital_code, jenis_klaim: nilai.jenis_klaim || asal.jenis_klaim };
      if(asal?.ai_anggaran_id && !saatIni().anggaran_ai) nilai.anggaran_ai={id:asal.ai_anggaran_id,hospital_code:asal.hospital_code};
    } catch {
      // Pencatatan best-effort tidak menghentikan penilaian klaim.
    }
  }
  if(!saatIni().anggaran_ai && !nilai.anggaran_ai && /\.pdf$/i.test(asal?.file_name || '')) {
    // Berkas lama juga mengikuti batas biaya sebelum panggilan interaktif.
    nilai.anggaran_ai=await require('./anggaranAiService').untukBerkas(db,{filePath:asal.file_path,
      hospitalCode:asal.hospital_code,jenis:[asal.jenis_klaim],recordId:record.id});
    await db.run('UPDATE claim_files SET ai_anggaran_id=? WHERE id=? AND hospital_code=?',
      [nilai.anggaran_ai.id,asal.file_id,asal.hospital_code]);
  }
  nilai.profil_klaim_rs = await require('./profilKlaimRsService').muatProfil(db, nilai.hospital_code);
  return jalankan(nilai, fn);
}
module.exports = { saatIni, jalankan, untukRecord };
