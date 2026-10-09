const {simpanEvaluasi,ambilEvaluasi,snapshot,temuanEvaluasi,validasi}=require('../../services/evaluasiCasemixService');
const record={id:'record',diagnosa_list:'N39.0',prosedur_list:'91.39',admission_date:'2026-10-01',discharge_date:'2026-10-05',umur_tahun:40,jenis_klaim:'RAWAT_INAP'};
const pages=[{page_number:3,ocr_text:'RESUME MEDIS\nKeluhan: disuria, nyeri suprapubik.\nDiagnosis: ISK'}];
const putusan={status:'tidak_ditemukan_alasan',alasan:[]};
const input={status:'pending',alasan:'Hasil kultur perlu dikonfirmasi.',bukti:[{halaman:3,kutipan:'Keluhan: disuria, nyeri suprapubik.'}]};
let db,rows;
beforeEach(()=>{
  rows=[];
  db={query:jest.fn(async()=>({})),run:jest.fn(async(sql,args)=>{const [id,record_id,status,alasan,bukti,snapshot_hash,snapshot_aplikasi,dievaluasi_oleh]=args;rows.unshift({id,record_id,status,alasan,bukti,snapshot_hash,snapshot_aplikasi,dievaluasi_oleh,dibuat_pada:'2026-10-09T10:00:00Z'});}),
    prepare:()=>({all:async()=>rows})};
});
test('pending maupun valid harus memiliki alasan dan kutipan halaman yang nyata',async()=>{
  for(const status of ['pending','valid','perlu_klarifikasi']){
    expect(validasi({...input,status,alasan:' '})).toMatch(/Alasan/);
    expect(validasi({...input,status,bukti:[]})).toMatch(/rujukan/);
    const hasil=await simpanEvaluasi({db,record,pages,putusan,input:{...input,status,bukti:[{halaman:3,kutipan:'Kultur darah positif'}]},oleh:'user'});
    expect(hasil.galat).toMatch(/sesuai teks/);
  }
  expect(db.run).not.toHaveBeenCalled();
});
test('riwayat menyimpan petugas, bukti dan pendapat; tidak menulis diagnosis/klaim atau melatih dari hasil sendiri',async()=>{
  const original=JSON.stringify(record);
  expect(await simpanEvaluasi({db,record,pages,putusan,input,oleh:'petugas'})).toMatchObject({tersimpan:true,perbedaan_dengan_aplikasi:true});
  await simpanEvaluasi({db,record,pages,putusan,input:{...input,status:'valid',alasan:'Bukti telah dikonfirmasi.'},oleh:'petugas-2'});
  const r=await ambilEvaluasi({db,record,pages,putusan});
  expect(r.riwayat).toHaveLength(2);
  expect(r.terakhir).toMatchObject({status:'valid',dievaluasi_oleh:'petugas-2',perlu_evaluasi_ulang:false});
  expect(r.riwayat[1].status).toBe('pending');
  expect(db.run.mock.calls.every(([sql])=>sql.startsWith('INSERT INTO evaluasi_casemix'))).toBe(true);
  expect(JSON.stringify(record)).toBe(original);
  expect(temuanEvaluasi(r)).toBeNull();
});
test('perubahan kode, berkas atau putusan membuat evaluasi valid perlu ditelaah ulang',async()=>{
  await simpanEvaluasi({db,record,pages,putusan,input:{...input,status:'valid'},oleh:'petugas'});
  for (const extra of [{record:{...record,diagnosa_list:'N30.0'}},{pages:[{...pages[0],ocr_text:pages[0].ocr_text+'\nKultur negatif'}]},{putusan:{status:'perlu_dicek',alasan:[{kode:'PNPK',ringkas:'Kultur belum terlihat',keparahan:'sedang'}]}}]){
    const r=await ambilEvaluasi({db,record,pages,putusan,...extra});
    expect(r.terakhir.perlu_evaluasi_ulang).toBe(true);
    expect(temuanEvaluasi(r).alasan[0].pertahankan_otomatis).toBe(true);
  }
  expect(snapshot(record,pages,putusan).hash).toBe(snapshot(record,[...pages,{page_number:1,ocr_text:'BERKAS KLAIM INDIVIDUAL\nINA-CBG'}],putusan).hash);
});
test('petugas pending atau klarifikasi menahan klaim; petugas valid tidak menghapus risiko aplikasi',async()=>{
  for (const status of ['pending','perlu_klarifikasi']) {
    await simpanEvaluasi({db,record,pages,putusan,input:{...input,status},oleh:'petugas'});
    expect(temuanEvaluasi(await ambilEvaluasi({db,record,pages,putusan}))).toMatchObject({status:'perlu_dicek'});
  }
  await simpanEvaluasi({db,record,pages,putusan:{status:'berisiko_pending',alasan:[]},input:{...input,status:'valid'},oleh:'petugas'});
  expect(rows[0].snapshot_aplikasi).toContain('berisiko_pending');
});
