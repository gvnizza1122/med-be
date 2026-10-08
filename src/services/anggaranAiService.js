/** Anggaran dan cache lokal per isi PDF. Tidak menyimpan prompt atau identitas pasien. */
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const VERSI = 'tinggi-hemat-2026-10-07-v1';
// Identitas/cache tetap memakai versi lama: perubahan kebijakan biaya bukan
// alasan membayar ulang hasil yang sudah berhasil.
const KEBIJAKAN = 'tinggi-adaptif-2026-10-07-v2';
const BATAS_NORMAL = 600, BATAS_KLINIS = 1500, BATAS_MENDALAM = 5000;
const sedangJalan = new Map();
const sedangMenghitung = new Map();
const antreReservasi = new Map();
let skema;

async function ensureSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_anggaran_berkas (
    id TEXT PRIMARY KEY, hospital_code TEXT NOT NULL, fingerprint TEXT NOT NULL,
    target_idr NUMERIC NOT NULL DEFAULT 500, batas_idr NUMERIC NOT NULL DEFAULT 600,
    terpakai_idr NUMERIC NOT NULL DEFAULT 0, dicadangkan_idr NUMERIC NOT NULL DEFAULT 0,
    belum_pasti_idr NUMERIC NOT NULL DEFAULT 0, dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(hospital_code, fingerprint)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS ai_cache_berkas (
    kunci TEXT PRIMARY KEY, anggaran_id TEXT NOT NULL REFERENCES ai_anggaran_berkas(id) ON DELETE CASCADE,
    jawaban JSONB NOT NULL, dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`ALTER TABLE ai_anggaran_berkas
    ADD COLUMN IF NOT EXISTS gagal_idr NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tambahan_alasan JSONB NOT NULL DEFAULT '[]'::jsonb`);
  // Biaya belum pasti karena server dimulai ulang (bukan kegagalan jawaban
  // model) dicatat terpisah: tetap dihitung, tetapi tidak menahan anggaran klinis.
  await db.query(`ALTER TABLE ai_anggaran_berkas ADD COLUMN IF NOT EXISTS belum_pasti_restart_idr NUMERIC NOT NULL DEFAULT 0`);
  await db.query(`CREATE TABLE IF NOT EXISTS ai_kegagalan_berkas (
    kunci TEXT PRIMARY KEY, anggaran_id TEXT NOT NULL REFERENCES ai_anggaran_berkas(id) ON DELETE CASCADE,
    kode TEXT NOT NULL, dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await require('../database/schemaIdempotent').pastikanKolom(db, 'claim_files', { ai_anggaran_id:'TEXT' });
  await pulihkanSisaProsesLama(db);
}

// Proses ini baru menyala: tidak ada permintaan AI maupun reservasi yang masih
// hidup dari proses sebelumnya. Penanda "sedang berjalan" yang tertinggal karena
// server dimulai ulang di tengah permintaan (KASUS ACUAN SLE 0000R0000126V000003,
// 8 Okt 2026 11:56) dulu memblokir tahap itu SELAMANYA sebagai "mungkin sudah
// berbiaya", sehingga review AI tidak pernah selesai dan DIAGLIST kosong.
// Sekarang: penanda pertama yang terputus diberi kode terputus_restart (boleh
// dikirim ulang SATU kali); penanda percobaan ulang yang terputus lagi menjadi
// biaya_belum_pasti (tetap diblokir). Reservasi yang menggantung dipindah ke
// belum_pasti -- tetap dihitung terhadap batas, tidak dihapus.
const PROSES_MULAI = new Date();
async function pulihkanSisaProsesLama(db) {
  try {
    await db.run(`UPDATE ai_kegagalan_berkas SET kode = CASE
        WHEN kode='permintaan_sedang_berjalan' THEN 'terputus_restart' ELSE 'biaya_belum_pasti' END
      WHERE kode IN ('permintaan_sedang_berjalan','permintaan_ulang_setelah_restart') AND dibuat < ?`, [PROSES_MULAI]);
    await db.run(`UPDATE ai_anggaran_berkas SET belum_pasti_idr = belum_pasti_idr + dicadangkan_idr,
        belum_pasti_restart_idr = belum_pasti_restart_idr + dicadangkan_idr, dicadangkan_idr = 0
      WHERE dicadangkan_idr > 0`);
  } catch (e) {
    console.warn('[AnggaranAi] pemulihan sisa proses lama dilewati:', e.message);
  }
}
async function siap(db) {
  if (!skema) skema=ensureSchema(db).catch(e=>{skema=null;throw e;});
  return skema;
}
async function sidikBerkas(filePath, jenis) {
  const h=createHash('sha256');
  // Pergantian kategori tidak memberikan kuota baru untuk isi PDF yang sama.
  // Kategori masuk kunci jawaban, bukan identitas anggaran.
  h.update(VERSI);
  for await (const chunk of fs.createReadStream(filePath)) h.update(chunk);
  return h.digest('hex');
}
async function untukBerkas(db, {filePath,hospitalCode,jenis,recordId,anggaranId}) {
  await siap(db);
  if (anggaranId) {
    const existing=await db.get('SELECT * FROM ai_anggaran_berkas WHERE id=? AND hospital_code=?',[anggaranId,hospitalCode]);
    if(existing) return {id:existing.id,hospital_code:hospitalCode};
  }
  const fingerprint=await sidikBerkas(filePath,jenis);
  // Hasil lama tidak menghapus biaya yang sudah tercatat. Anggaran baru berlaku
  // pada pemakaian berikutnya; riwayat yang telanjur di atas batas tetap terlihat.
  const prior=recordId ? await db.get('SELECT COALESCE(SUM(estimasi_idr),0) AS idr FROM catatan_panggilan_model WHERE record_id=? AND hospital_code=?',[recordId,hospitalCode]) : null;
  const id=randomUUID();
  await db.run(`INSERT INTO ai_anggaran_berkas(id,hospital_code,fingerprint,target_idr,batas_idr,terpakai_idr)
    VALUES(?,?,?,500,600,?) ON CONFLICT(hospital_code,fingerprint) DO NOTHING`,[id,hospitalCode,fingerprint,Number(prior?.idr)||0]);
  const row=await db.get('SELECT id FROM ai_anggaran_berkas WHERE hospital_code=? AND fingerprint=?',[hospitalCode,fingerprint]);
  if(!row) throw Error('Pengendalian anggaran AI belum dapat disimpan.');
  return {id:row.id,hospital_code:hospitalCode};
}
function plafon(opsi={}) { return opsi.pendalaman ? BATAS_MENDALAM : opsi.klinis ? BATAS_KLINIS : BATAS_NORMAL; }
async function cadangkan(db, scope, nilai, optional=false, opsi={}) {
  if(!Number.isFinite(nilai) || nilai<=0) return false;
  const limit=optional ? BATAS_NORMAL : plafon(opsi);
  const alasan=opsi.pendalaman ? 'Pemeriksaan mendalam berdasarkan bukti yang perlu klarifikasi.' : 'Penyelesaian tahap analisis klinis wajib.';
  const row=await db.get(`UPDATE ai_anggaran_berkas SET dicadangkan_idr=dicadangkan_idr+?::numeric,
    batas_idr=CASE WHEN ?::boolean THEN batas_idr ELSE GREATEST(batas_idr,CEIL(terpakai_idr+belum_pasti_idr+dicadangkan_idr+?::numeric)) END,
    tambahan_alasan=CASE WHEN NOT ?::boolean AND terpakai_idr+belum_pasti_idr+dicadangkan_idr+?::numeric>batas_idr
      THEN tambahan_alasan || ?::jsonb ELSE tambahan_alasan END
    WHERE id=? AND hospital_code=? AND terpakai_idr+belum_pasti_idr+dicadangkan_idr+?::numeric <=
    CASE WHEN ?::boolean THEN LEAST(target_idr,?::numeric-175)
      WHEN gagal_idr=0 AND belum_pasti_idr<=belum_pasti_restart_idr THEN GREATEST(batas_idr,?::numeric) ELSE batas_idr END RETURNING id`,
    [nilai,optional,nilai,optional,nilai,JSON.stringify([alasan]),scope.id,scope.hospital_code,nilai,optional,BATAS_NORMAL,limit]);
  return Boolean(row);
}
// Pertahankan paralelisme antartahap, tetapi tunggu reservasi aktif selesai
// sebelum memperbesar anggaran. Penantian ini tidak memanggil penyedia lagi.
async function cadangkanSaatSiap(db,scope,nilai,optional=false,opsi={}) {
  if(!Number.isFinite(nilai) || nilai<=0) return null;
  const before=antreReservasi.get(scope.id)||Promise.resolve();
  let unlock;const lock=new Promise(resolve=>{unlock=resolve;});
  const queued=before.catch(()=>{}).then(()=>lock);antreReservasi.set(scope.id,queued);
  await before.catch(()=>{});
  try {
    const deadline=Date.now()+Math.max(60000,Number(process.env.AI_BUDGET_RESERVATION_WAIT_MS)||600000);
    while(true) {
      const running=sedangMenghitung.get(scope.id);
      if(running?.size) {
        const r=await ringkasan(db,scope);
        if(r && r.terpakai_idr+r.belum_pasti_idr+r.dicadangkan_idr+nilai>r.batas_idr) {
          if(Date.now()>=deadline) return null;
          // Timer dibersihkan ketika reservasi selesai, agar antrean besar
          // tidak meninggalkan timer aktif yang tidak lagi diperlukan.
          let timer;
          try {await Promise.race([...running,new Promise(resolve=>{timer=setTimeout(resolve,deadline-Date.now());})]);}
          finally {clearTimeout(timer);}
          continue;
        }
      }
      return await cadangkan(db,scope,nilai,optional,opsi) ? tandaiAktif(scope) : null;
    }
  } finally {unlock();if(antreReservasi.get(scope.id)===queued)antreReservasi.delete(scope.id);}
}
function tandaiAktif(scope) {
  let done;const p=new Promise(resolve=>{done=resolve;});
  if(!sedangMenghitung.has(scope.id)) sedangMenghitung.set(scope.id,new Set());
  sedangMenghitung.get(scope.id).add(p);
  return ()=>{const set=sedangMenghitung.get(scope.id);set?.delete(p);if(!set?.size)sedangMenghitung.delete(scope.id);done();};
}
async function lunasi(db,scope,reserved,{biaya,usageKnown,definiteNoCharge=false,gagal=false}) {
  const spent=usageKnown && biaya ? biaya.idr : 0;
  const unknown=(usageKnown && biaya) || definiteNoCharge ? 0 : reserved;
  await db.run(`UPDATE ai_anggaran_berkas SET dicadangkan_idr=GREATEST(0,dicadangkan_idr-?::numeric),
    terpakai_idr=terpakai_idr+?::numeric,belum_pasti_idr=belum_pasti_idr+?::numeric,
    gagal_idr=gagal_idr+?::numeric WHERE id=? AND hospital_code=?`,
    [reserved,spent,unknown,gagal ? spent : 0,scope.id,scope.hospital_code]);
}
async function ringkasan(db,scope) {
  const r=await db.get('SELECT * FROM ai_anggaran_berkas WHERE id=? AND hospital_code=?',[scope.id,scope.hospital_code]);
  if(!r) return null;
  const n=k=>Number(r[k])||0;
  return {versi:KEBIJAKAN,profil:'Analisis tinggi · biaya adaptif',target_idr:n('target_idr'),batas_normal_idr:BATAS_NORMAL,
    batas_maksimum_idr:BATAS_MENDALAM,tambahan_alasan:[...new Set(r.tambahan_alasan||[])],gagal_idr:n('gagal_idr'),batas_idr:n('batas_idr'),
    terpakai_idr:n('terpakai_idr'),dicadangkan_idr:n('dicadangkan_idr'),belum_pasti_idr:n('belum_pasti_idr'),
    belum_pasti_restart_idr:n('belum_pasti_restart_idr'),
    sisa_idr:Math.max(0,n('batas_idr')-n('terpakai_idr')-n('dicadangkan_idr')-n('belum_pasti_idr')),
    dasar:'Estimasi tarif Standard teks dan kurs aplikasi; biaya yang belum diketahui tetap dicadangkan.'};
}
async function ambilKegagalan(db,key,scope) {
  return db.get('SELECT kode FROM ai_kegagalan_berkas WHERE kunci=? AND anggaran_id=?',[key,scope.id]);
}
async function mulaiPanggilan(db,key,scope,kode='permintaan_sedang_berjalan') {
  const row=await db.get(`INSERT INTO ai_kegagalan_berkas(kunci,anggaran_id,kode) VALUES(?,?,?)
    ON CONFLICT(kunci) DO NOTHING RETURNING kunci`,[key,scope.id,kode]);
  return Boolean(row);
}
/** Penanda terputus karena restart dilepas agar permintaan itu dapat dikirim ulang sekali. */
async function izinkanUlangSetelahRestart(db,key,scope) {
  const row=await db.get(`DELETE FROM ai_kegagalan_berkas WHERE kunci=? AND anggaran_id=? AND kode='terputus_restart' RETURNING kunci`,[key,scope.id]);
  return Boolean(row);
}
async function hapusPenanda(db,key,scope) {
  await db.run('DELETE FROM ai_kegagalan_berkas WHERE kunci=? AND anggaran_id=?',[key,scope.id]);
}
async function simpanKegagalan(db,key,scope,kode) {
  const safe=['output_terpotong','jawaban_belum_valid'].includes(kode) ? kode : 'biaya_belum_pasti';
  await db.run(`INSERT INTO ai_kegagalan_berkas(kunci,anggaran_id,kode) VALUES(?,?,?)
    ON CONFLICT(kunci) DO UPDATE SET kode=EXCLUDED.kode WHERE ai_kegagalan_berkas.anggaran_id=EXCLUDED.anggaran_id`,[key,scope.id,safe]);
}
function kunciCache(scope,tugas,rute,system,prompt,effort,maxTokens,jenis) {
  return createHash('sha256').update(JSON.stringify([VERSI,scope.id,tugas,rute.penyedia,rute.model,system,prompt,effort,maxTokens,jenis||null])).digest('hex');
}
async function ambilCache(db,key,scope) {
  // Bukti, instruksi, model dan versi sudah masuk kunci. Umur hasil sendiri
  // bukan alasan membaca berkas yang sama sekali lagi dan menambah biaya.
  const r=await db.get(`SELECT jawaban FROM ai_cache_berkas WHERE kunci=? AND anggaran_id=?`,[key,scope.id]);
  return r?.jawaban ? (typeof r.jawaban==='string' ? JSON.parse(r.jawaban) : r.jawaban) : null;
}
async function simpanCache(db,key,scope,answer) {
  // Jawaban masih disamarkan. Pemulihan identitas dilakukan gateway setelah cache dibaca.
  await db.run(`INSERT INTO ai_cache_berkas(kunci,anggaran_id,jawaban) VALUES(?,?,?::jsonb)
    ON CONFLICT(kunci) DO UPDATE SET jawaban=EXCLUDED.jawaban,dibuat=CURRENT_TIMESTAMP`,[key,scope.id,JSON.stringify(answer)]);
}
function satuPanggilan(key,fn) {
  if(sedangJalan.has(key)) return sedangJalan.get(key).then(r=>({...r,reused:true}));
  const p=Promise.resolve().then(fn).finally(()=>sedangJalan.delete(key));
  sedangJalan.set(key,p);return p;
}
module.exports={VERSI,KEBIJAKAN,ensureSchema,untukBerkas,cadangkan,cadangkanSaatSiap,tandaiAktif,lunasi,ringkasan,kunciCache,ambilCache,simpanCache,ambilKegagalan,mulaiPanggilan,izinkanUlangSetelahRestart,hapusPenanda,simpanKegagalan,satuPanggilan,sidikBerkas};
