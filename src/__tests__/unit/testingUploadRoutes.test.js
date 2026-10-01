const express = require('express');
const request = require('supertest');
let mockDb;
const mockProcess = jest.fn();
jest.mock('../../database/init', () => ({ getDb: () => mockDb }));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req,res,next) => { if (!req.headers['x-role']) return res.sendStatus(401); req.user={id:'tester',role:req.headers['x-role'],hospital_code:'RS-A'}; next(); },
  authorize: (...roles) => (req,res,next) => roles.includes(req.user.role) ? next() : res.sendStatus(403),
}));
jest.mock('../../routes/claimFiles', () => ({
  pdfUpload: require('multer')({storage:require('multer').memoryStorage()}),
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
