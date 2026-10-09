const { createHash, randomUUID } = require('crypto');
const skema = new WeakMap();
async function ensureSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS evaluasi_casemix (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL, status TEXT NOT NULL
      CHECK (status IN ('pending','valid','perlu_klarifikasi')),
    alasan TEXT NOT NULL, bukti TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    snapshot_aplikasi TEXT NOT NULL, dievaluasi_oleh TEXT NOT NULL,
    dibuat_pada TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_evaluasi_casemix_record ON evaluasi_casemix(record_id, dibuat_pada DESC)');
}
function siap(db) {
  if (!skema.has(db)) skema.set(db, ensureSchema(db).catch(e => { skema.delete(db); throw e; }));
  return skema.get(db);
}
function snapshot(record, pages, putusan) {
  const data = { diagnosis: record.diagnosa_list || record.DIAGLIST || '', prosedur: record.prosedur_list || record.PROCLIST || '',
    admission_date: record.admission_date, discharge_date: record.discharge_date,
    umur: require('./usiaPasienService').resolveUsia(record), jenis_klaim: record.jenis_klaim,
    versi_pnpk: require('../data/kriteriaPnpk.json').versi,
    versi_ba: require('../data/baPnpkAnak.json').versi,
    halaman: (pages || []).filter(p=>!require('./lembarGrouperService').isLembarGrouper(p.ocr_text ?? p.text))
      .map(p => [Number(p.page_number), String(p.ocr_text ?? p.text ?? '')]).sort((a,b) => a[0]-b[0]),
    putusan: {status:putusan?.status || null, alasan:(putusan?.alasan || []).map(a => ({kode:a.kode,ringkas:a.ringkas,keparahan:a.keparahan}))} };
  return { hash: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    aplikasi: {status:data.putusan.status,alasan:data.putusan.alasan,versi_pnpk:data.versi_pnpk} };
}
function validasi(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Format evaluasi tidak sah.';
  if (!['pending','valid','perlu_klarifikasi'].includes(input.status)) return 'Pilih pending, valid, atau perlu klarifikasi.';
  if (typeof input.alasan !== 'string' || !input.alasan.trim()) return 'Alasan evaluasi wajib diisi, termasuk bila dinilai valid.';
  if (input.alasan.length > 4000) return 'Alasan evaluasi maksimal 4000 karakter.';
  if (!Array.isArray(input.bukti) || !input.bukti.length || input.bukti.length > 20) return 'Cantumkan 1–20 rujukan bukti evaluasi.';
  if (input.bukti.some(b => !b || !Number.isInteger(b.halaman) || b.halaman < 1 || typeof b.kutipan !== 'string' || !b.kutipan.trim() || b.kutipan.length > 1000)) return 'Setiap bukti perlu nomor halaman dan kutipan (maksimal 1000 karakter).';
  return null;
}
function norm(s) { return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
async function simpanEvaluasi({db,record,pages,putusan,input,oleh}) {
  const galat = validasi(input); if (galat) return {galat};
  if (!oleh) return {galat:'Identitas petugas belum terkonfirmasi.'};
  const peta = new Map((pages || []).map(p => [Number(p.page_number), norm(p.ocr_text ?? p.text)]));
  if (input.bukti.some(b => !peta.get(b.halaman)?.includes(norm(b.kutipan)))) return {galat:'Kutipan bukti harus sesuai teks pada halaman berkas yang disebut.'};
  const s = snapshot(record,pages,putusan), id=randomUUID();
  await siap(db);
  await db.run(`INSERT INTO evaluasi_casemix (id,record_id,status,alasan,bukti,snapshot_hash,snapshot_aplikasi,dievaluasi_oleh)
    VALUES (?,?,?,?,?,?,?,?)`,[id,String(record.id),input.status,input.alasan.trim(),JSON.stringify(input.bukti),s.hash,JSON.stringify(s.aplikasi),String(oleh)]);
  return {tersimpan:true,id,status:input.status,alasan:input.alasan.trim(),perbedaan_dengan_aplikasi:beda(input.status,s.aplikasi.status),
    catatan:'Evaluasi petugas disimpan terpisah beserta bukti dan versi analisis. Hasil BPJS dicatat melalui alur hasil klaim.'};
}
function beda(status, app) {
  return !app ? null : status === 'valid' ? app !== 'tidak_ditemukan_alasan' : status === 'pending' ? app === 'tidak_ditemukan_alasan' : app === 'tidak_ditemukan_alasan';
}
async function ambilEvaluasi({db,record,pages,putusan}) {
  const rows=await db.prepare('SELECT e.*,u.full_name AS nama_petugas FROM evaluasi_casemix e LEFT JOIN users u ON u.id = e.dievaluasi_oleh WHERE e.record_id = ? ORDER BY e.dibuat_pada DESC, e.id DESC LIMIT 20').all(String(record.id));
  const s=snapshot(record,pages,putusan);
  const riwayat=rows.map(r=>({...r,bukti:JSON.parse(r.bukti),snapshot_aplikasi:JSON.parse(r.snapshot_aplikasi),
    perlu_evaluasi_ulang:r.snapshot_hash!==s.hash,perbedaan_dengan_aplikasi:beda(r.status,s.aplikasi.status)}));
  return {terakhir:riwayat[0]||null,riwayat};
}
async function ambilTerakhirBanyak(db,ids) {
  if (!ids.length) return new Map();
  const rows=await db.prepare(`SELECT DISTINCT ON (record_id) * FROM evaluasi_casemix WHERE record_id IN (${ids.map(()=>'?').join(',')}) ORDER BY record_id,dibuat_pada DESC,id DESC`).all(...ids);
  return new Map(rows.map(r=>[r.record_id,r]));
}
function dariBaris(r,record,pages,putusan) {
  if (!r) return null;
  return {...r,bukti:JSON.parse(r.bukti),snapshot_aplikasi:JSON.parse(r.snapshot_aplikasi),
    perlu_evaluasi_ulang:r.snapshot_hash!==snapshot(record,pages,putusan).hash,perbedaan_dengan_aplikasi:beda(r.status,putusan?.status)};
}
function temuanEvaluasi(evaluasi) {
  const e=evaluasi?.terakhir;
  if (!e || (e.status==='valid' && !e.perlu_evaluasi_ulang)) return null;
  return {status:'perlu_dicek',alasan:[{kode:'EVALUASI-CASEMIX',sumber_pemeriksaan:'Evaluasi petugas casemix',
    ringkas:e.perlu_evaluasi_ulang?'Berkas atau analisis berubah setelah evaluasi petugas; evaluasi ulang diperlukan.':`Petugas casemix menilai ${e.status==='pending'?'pending':'perlu klarifikasi'}: ${e.alasan}`,
    keparahan:'sedang',pertahankan_otomatis:true,wajib_pending:false,
    bukti:e.bukti, tindakan:'Tinjau alasan dan bukti petugas, perbaiki data yang diperlukan, lalu catat evaluasi terbaru.'}]};
}
module.exports={ensureSchema,simpanEvaluasi,ambilEvaluasi,snapshot,validasi,temuanEvaluasi,ambilTerakhirBanyak,dariBaris};
