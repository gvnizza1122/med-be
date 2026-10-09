const express=require('express');
const request=require('supertest');
let mockDb,mockRisk,record,file,pages,writes,history;
jest.mock('../../database/init',()=>({getDb:()=>mockDb}));
jest.mock('../../middleware/auth',()=>({authenticate:(req,res,next)=>{req.user={id:'petugas',hospital_code:'RS-A',role:'supervisor'};next();},authorize:()=> (_req,_res,next)=>next()}));
jest.mock('../../services/risikoKlaimTampilanService',()=>({perbaruiRisikoTampilan:()=>({putusan_pending:mockRisk})}));
jest.mock('../../services/keputusanCasemixService',()=>({ambilKeputusan:async()=>null,pelajaranRelevan:async()=>[],simpanKeputusan:jest.fn()}));
jest.mock('../../services/auditService',()=>({logAudit:jest.fn()}));
const app=express();app.use(express.json());app.use('/claims',require('../../routes/claimFiles'));
beforeEach(()=>{
 record={id:'rec',file_id:'file',diagnosa_list:'R52.9',prosedur_list:'',validation_status:'valid',jenis_klaim:'RAWAT_JALAN',umur_tahun:40,admission_date:'2026-10-01',ai_review:JSON.stringify({dasar_diagnosis:{},temuan_tindakan:[],syarat_penunjang:[],putusan_pending:{status:'tidak_ditemukan_alasan',alasan:[]},analisis_kritis:{}})};
 file={id:'file',hospital_code:'RS-A',file_name:'uji.pdf',status:'completed'};
 pages=[{page_number:3,ocr_text:'RESUME MEDIS\nDiagnosis: nyeri\nNRS: 7'}];history=[];writes=jest.fn(async()=>{});
 mockRisk={status:'tidak_ditemukan_alasan',alasan:[]};
 mockDb={query:jest.fn(async()=>({})),run:jest.fn(async(sql,args)=>{const [id,record_id,status,alasan,bukti,snapshot_hash,snapshot_aplikasi,dievaluasi_oleh]=args;history=[{id,record_id,status,alasan,bukti,snapshot_hash,snapshot_aplikasi,dievaluasi_oleh,dibuat_pada:'2026-10-09T10:00:00Z'}];}),
 prepare:sql=>({get:async()=>/FROM claim_records/.test(sql)?record:/COUNT/.test(sql)?{count:1}:file,all:async()=>/ocr_results/.test(sql)?pages:/evaluasi_casemix/.test(sql)?history:/SELECT cr\.\*|SELECT \* FROM claim_records/.test(sql)?[record]:[],run:async(...args)=>writes(sql,...args)}),
 transaction:async fn=>fn(mockDb)};
});
test('evaluasi pending memerlukan bukti, menyimpan pendapat dan menahan status klaim',async()=>{
 const body={status:'pending',alasan:'Dokumentasi pemeriksaan belum lengkap.',bukti:[{halaman:3,kutipan:'NRS: 7'}]};
 const r=await request(app).post('/claims/records/rec/evaluasi-casemix').send(body);
 expect(r.status).toBe(200);expect(r.body.tersimpan).toBe(true);
 expect(writes.mock.calls.some(([sql])=>sql.includes("validation_status = 'pending'"))).toBe(true);
 expect(writes.mock.calls.some(([sql])=>sql.includes('UPDATE claim_files SET valid_count'))).toBe(true);
 const laporan=await request(app).get('/claims/records/rec/laporan-casemix');
 expect(laporan.body.evaluasi_casemix.terakhir.status).toBe('pending');
 expect(laporan.body.alignment_checklist.komponen).toHaveLength(8);
});
test('rumah sakit lain tidak bisa membaca/menyimpan evaluasi atau menyetujui klaim',async()=>{
 file.hospital_code='RS-B';
 expect((await request(app).get('/claims/records/rec/laporan-casemix')).status).toBe(404);
 expect((await request(app).post('/claims/records/rec/evaluasi-casemix').send({})).status).toBe(404);
 expect((await request(app).post('/claims/file/approve')).status).toBe(404);
 expect(mockDb.run).not.toHaveBeenCalled();
});
test('kutipan rekaan dan valid tanpa alasan ditolak',async()=>{
 for(const body of [{status:'valid',alasan:' ',bukti:[{halaman:3,kutipan:'NRS: 7'}]},{status:'pending',alasan:'Tidak sesuai.',bukti:[{halaman:3,kutipan:'NRS: 3'}]}]){
   expect((await request(app).post('/claims/records/rec/evaluasi-casemix').send(body)).status).toBe(400);
 }
 expect(mockDb.run).not.toHaveBeenCalled();
});
test('aturan yang belum selesai menahan approve dan ekspor walau status tersimpan valid',async()=>{
 mockRisk={status:'perlu_dicek',alasan:[{kode:'PNPK-UJI',ringkas:'Bukti belum terbaca',pertahankan_otomatis:true,keparahan:'sedang'}]};
 for(const [method,url] of [['post','/claims/file/approve'],['get','/claims/export/siap-submit']]){
   const r=await request(app)[method](url);expect(r.status).toBe(409);expect(r.body.putusan_pending.alasan[0].kode).toBe('PNPK-UJI');
 }
 expect(writes).not.toHaveBeenCalled();
});
test('pendapat pending petugas menahan ekspor ketika aplikasi belum menemukan alasan',async()=>{
 await request(app).post('/claims/records/rec/evaluasi-casemix').send({status:'pending',alasan:'Butuh klarifikasi DPJP.',bukti:[{halaman:3,kutipan:'NRS: 7'}]});
 const r=await request(app).get('/claims/export/siap-submit');
 expect(r.status).toBe(409);expect(r.body.putusan_pending.alasan[0].kode).toBe('EVALUASI-CASEMIX');
});
