const express=require('express');
const request=require('supertest');
let mockDb;
jest.mock('../../database/init',()=>({getDb:()=>mockDb}));
jest.mock('../../middleware/auth',()=>({authenticate:(req,res,next)=>{req.user={hospital_code:'3371084'};next();},authorize:()=> (req,res,next)=>next()}));
const app=express();app.use('/claims',require('../../routes/claimFiles'));
let file,record,pages;
beforeEach(()=>{
  file={id:'file',hospital_code:'3371084'};record={id:'record',file_id:'file',ai_review:'{}'};
  pages=[{page_number:14,ocr_text:'LAPORAN OPERASI\nTumor diameter 5x4 cm, massa berada di antara otot.'}];
  mockDb={get:jest.fn(async sql=>sql.includes('claim_files')?file:record),all:jest.fn(async()=>pages),run:jest.fn()};
});
test('tab mengembalikan bukti terbaru tanpa cache/tulis record dan tanpa panggilan model',async()=>{
  const before=JSON.stringify(record);
  const a=await request(app).get('/claims/records/record/laporan-operasi');
  expect(a.status).toBe(200);expect(a.headers['cache-control']).toBe('no-store');
  expect(a.body.laporan[0].ukuran[0].ukuran).toEqual([5,4]);
  pages=[{page_number:14,ocr_text:'LAPORAN OPERASI\nTumor diameter 6x4 cm.'}];
  const b=await request(app).get('/claims/records/record/laporan-operasi');
  expect(b.body.laporan[0].ukuran[0].ukuran).toEqual([6,4]);expect(a.body.hash_bukti).not.toBe(b.body.hash_bukti);
  expect(mockDb.run).not.toHaveBeenCalled();expect(JSON.stringify(record)).toBe(before);
});
test('laporan rumah sakit lain tidak tersedia dan OCR-nya tidak dibaca',async()=>{
  file.hospital_code='RS-LAIN';
  const r=await request(app).get('/claims/records/record/laporan-operasi');
  expect(r.status).toBe(404);expect(mockDb.all).not.toHaveBeenCalled();
});
test('record tidak ada mengembalikan 404',async()=>{
  record=null;expect((await request(app).get('/claims/records/record/laporan-operasi')).status).toBe(404);
});
