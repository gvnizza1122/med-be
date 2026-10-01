const express = require('express');
const request = require('supertest');
let mockDb;
const mockProcess = jest.fn();
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req,res,next) => { if (!req.headers['x-role']) return res.sendStatus(401); req.user={id:'tester',role:req.headers['x-role'],hospital_code:req.headers['x-hospital'] || 'RS-A'}; next(); },
  authorize: (...roles) => (req,res,next) => roles.includes(req.user.role) ? next() : res.sendStatus(403),
}));
jest.mock('../../routes/claimFiles', () => ({
  pdfUpload: require('multer')({storage:require('multer').memoryStorage()}),
  pdfUploadBatch: require('multer')({storage:require('multer').memoryStorage()}),
  runWithConcurrencyLimit: async (items, limit, fn) => Promise.all(items.map(fn)),
  BATCH_AI_CONCURRENCY: 2,
  processSinglePdfUpload: (db, options) => mockProcess(db, options),
}));
const app=express(); app.use('/testing',require('../../routes/testingPending'));
const upload=(outcome='pending',category='RAWAT_JALAN') => request(app).post('/testing/upload').set('x-role','admin')
  .field('jenis_klaim',category).field('actual_result',outcome).field('reference_source','BPJS')
  .field('actual_reason','Hasil acuan rahasia').field('notes','Catatan rahasia').attach('file',Buffer.from('%PDF-1.4'),'uji.pdf');
beforeEach(()=>{
  mockProcess.mockReset(); mockProcess.mockResolvedValue({success:true,file_id:'file',record_id:'rec'});
  mockDb={get:jest.fn(async sql=>sql.includes('has_table_privilege')?{can_read:true,can_write:true}:{id:'rec',validation_status:'pending',diagnosa_list:'J44.9;J18.9'}),all:jest.fn(async()=>[]),run:jest.fn(async()=>({changes:1}))};
});
test.each(['RAWAT_JALAN','RAWAT_INAP'])('upload khusus %s menyimpan label sesudah prediksi tanpa memberi jawaban kepada AI',async category=>{
  const res=await upload('pending',category);expect(res.status).toBe(200);expect(res.body.label_saved).toBe(true);
  const options=mockProcess.mock.calls[0][1];expect(options).toEqual({filePath:undefined,originalName:'uji.pdf',jenisKlaim:category,userId:'tester',hospitalCode:'RS-A',isTesting:true});
  expect(JSON.stringify(options)).not.toMatch(/rahasia|actual_result|actual_reason|notes|reference_source/);
  const [sql,values]=mockDb.run.mock.calls[0];expect(sql).toContain('INSERT INTO testing_pending');expect(values[2]).toBe('pending');expect(values[4]).toBe('pending');
});
test('ACC tetap menghasilkan patokan pending jika analisis menemukan risiko',async()=>{
  const res=await upload('diterima');expect(res.body.prediction.status).toBe('pending');expect(mockDb.run.mock.calls[0][1][4]).toBe('diterima');
});
test.each([['belum_diketahui','RAWAT_JALAN'],['pending','IGD']])('input %s/%s ditolak sebelum analisis',async(outcome,category)=>{
 expect((await upload(outcome,category)).status).toBe(400);expect(mockProcess).not.toHaveBeenCalled();expect(mockDb.run).not.toHaveBeenCalled();
});
test('kegagalan analisis tidak menyimpan hasil acuan atau prediksi palsu',async()=>{
 mockProcess.mockResolvedValue({success:false,error:'PDF tidak terbaca'});expect((await upload()).status).toBe(422);expect(mockDb.run).not.toHaveBeenCalled();
});
test('gagal menyimpan acuan tidak meminta upload ulang PDF yang sudah diproses',async()=>{
 mockDb.run.mockRejectedValue(Error('offline'));const res=await upload();expect(res.status).toBe(200);expect(res.body.label_saved).toBe(false);expect(res.body.record_id).toBe('rec');
});
test('akses penyimpanan tidak tersedia: jangan mulai AI',async()=>{
 mockDb.get.mockResolvedValue({can_read:true,can_write:false});expect((await upload()).status).toBe(503);expect(mockProcess).not.toHaveBeenCalled();
});

const batch = (categories = ['RAWAT_JALAN','RAWAT_INAP']) => request(app).post('/testing/upload-batch').set('x-role','admin')
  .field('allowed_jenis_klaim',JSON.stringify(categories)).field('actual_reason','JANGAN DIKIRIM')
  .attach('files',Buffer.from('%PDF-1.4'),'sama.pdf').attach('files',Buffer.from('%PDF-1.4'),'sama.pdf');
test('batch campur tanpa hasil acuan, progres dua nama sama dipisahkan per indeks', async()=>{
 mockProcess.mockResolvedValueOnce({success:true,file_id:'file-rj',record_id:'rec-rj',jenis_klaim:'RAWAT_JALAN'})
  .mockResolvedValueOnce({success:false,error:'PDF tidak terbaca'});
 const accepted=await batch();expect(accepted.status).toBe(202);
 const state=await request(app).get(`/testing/jobs/${accepted.body.job_id}`).set('x-role','admin');
 expect(state.status).toBe(200);expect(state.body.active).toBe(false);expect(state.body.completed).toBe(2);
 expect(state.body.successful).toBe(1);expect(state.body.failed).toBe(1);
 expect(state.body.statuses.map(s=>s.status)).toEqual(['done','failed']);
 for (const [,options] of mockProcess.mock.calls) {expect(options.isTesting).toBe(true);expect(options.allowedJenisKlaim).toEqual(['RAWAT_JALAN','RAWAT_INAP']);expect(options.jenisKlaim).toBeUndefined();expect(JSON.stringify(options)).not.toContain('JANGAN');}
});
test('kategori batch invalid ditolak tanpa AI',async()=>{
 expect((await batch(['IGD'])).status).toBe(400);expect(mockProcess).not.toHaveBeenCalled();
});
test('progres tetap processing sampai analisis selesai, bukan dianggap berhasil ketika HTTP selesai',async()=>{
 let finish; mockProcess.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
 const accepted=await request(app).post('/testing/upload-batch').set('x-role','admin')
  .field('allowed_jenis_klaim','["RAWAT_INAP"]').attach('files',Buffer.from('%PDF-1.4'),'lama.pdf');
 expect(accepted.status).toBe(202);const state=await request(app).get(`/testing/jobs/${accepted.body.job_id}`).set('x-role','admin');
 expect(state.body.active).toBe(true);expect(state.body.statuses[0].status).toBe('processing');
 expect((await batch()).status).toBe(409);
 finish({success:true,file_id:'file',jenis_klaim:'RAWAT_INAP'});
 await new Promise(resolve=>setImmediate(resolve));
 expect((await request(app).get(`/testing/jobs/${accepted.body.job_id}`).set('x-role','admin')).body.active).toBe(false);
});
test('ekspor hanya mengambil dataset testing dengan scope RS dan patokan awal',async()=>{
 mockDb.all.mockImplementation(async sql => sql.includes('SELECT cr.*') ? [{id:'rec',file_id:'file',file_name:'uji.pdf',sep:'123',jenis_klaim:'RAWAT_JALAN',raw_data:'{"DIAGLIST":"J44.9"}',ai_review:'{"ringkasan":"risiko"}',prediction_snapshot:{status:'pending'}}]:[]);
 const res=await request(app).get('/testing/export').set('x-role','admin');expect(res.status).toBe(200);expect(res.body.total).toBe(1);
 expect(mockDb.all.mock.calls[0][0]).toContain('cf.is_testing=TRUE');expect(mockDb.all.mock.calls[0][1]).toEqual(['RS-A']);
 expect(res.body.records[0].extracted_claim.DIAGLIST).toBe('J44.9');expect(res.body.records[0].prediction.status).toBe('pending');
 expect(JSON.stringify(res.body)).not.toMatch(/file_path|password|hospitalCode/);
});

test('progres testing tidak dapat dibaca rumah sakit lain',async()=>{
 const accepted=await batch(['RAWAT_JALAN']);
 const other=await request(app).get(`/testing/jobs/${accepted.body.job_id}`).set('x-role','admin').set('x-hospital','RS-B');
 expect(other.status).toBe(404);expect(other.body.statuses).toBeUndefined();
});
