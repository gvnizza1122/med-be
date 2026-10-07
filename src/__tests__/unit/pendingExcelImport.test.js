const express = require('express');
const request = require('supertest');
const XLSX = require('xlsx');
let mockDb;
jest.mock('../../database/init',()=>({getDb:()=>mockDb}));
jest.mock('../../middleware/auth',()=>({authenticate:(req,_res,next)=>{req.user={id:'pengguna-uji'};next();},authorize:()=> (_req,_res,next)=>next()}));
jest.mock('../../services/sepCocokService',()=>({muatIndeksKlaim:jest.fn(async()=>({})),cocokkanSatu:jest.fn(()=>({status:'klaim_tidak_ada'}))}));
jest.mock('../../services/ragReferenceService',()=>({saveReference:jest.fn(async()=>{})}));
jest.mock('../../services/gatewayModelService',()=>({panggilModel:jest.fn()}));
const rag = require('../../services/ragReferenceService');
const gateway = require('../../services/gatewayModelService');
const router = require('../../routes/bpjsPending');
const app=express(); app.use('/records',router);
let writes,duplicate,changes;
beforeEach(()=>{
  jest.clearAllMocks();writes=[];duplicate=null;changes=1;
  jest.spyOn(XLSX,'read').mockReturnValue({SheetNames:['RJ'],Sheets:{RJ:XLSX.utils.aoa_to_sheet([
    ['NOSEP','TGLSEP','TGLPLG','ALASANPENDING','Konfirmasi'],
    ['0170R0110126V000001','2026-01-02','2026-01-02','Konfirmasi kode DU','Jawaban RS sintetis'],
  ])}});
  mockDb={prepare:sql=>({get:async()=>duplicate,run:async(...params)=>{writes.push({sql,params});return{changes};}})};
});
afterEach(()=>jest.restoreAllMocks());
const unggah=()=>request(app).post('/records/pending-import-xlsx').attach('file',Buffer.from('uji-sintetis'),{filename:'rekap.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});

test('impor mempertahankan Konfirmasi tanpa mengubahnya menjadi persetujuan BPJS atau memanggil AI',async()=>{
  const r=await unggah();expect(r.status).toBe(200);expect(r.body).toMatchObject({total_rows:1,imported:1,updated_confirmation:0});
  const insert=writes.find(w=>/INSERT INTO bpjs_pending_responses/.test(w.sql));
  expect(insert.params).toContain('Jawaban RS sintetis');
  expect(insert.sql).not.toMatch(/outcome/);expect(insert.sql).toMatch(/'draft'/);
  expect(gateway.panggilModel).not.toHaveBeenCalled();
  expect(rag.saveReference).toHaveBeenCalledWith(mockDb,expect.objectContaining({sourceKind:'rs_manual',answer:'Jawaban RS sintetis'}));
});

test('unggah ulang hanya melengkapi jawaban yang kosong, tanpa membuat file atau klaim baru',async()=>{
  duplicate={id:'pending-lama',jawaban_rs_manual:''};
  const r=await unggah();expect(r.status).toBe(200);expect(r.body).toMatchObject({file_id:null,imported:0,skipped_duplicate:1,updated_confirmation:1});
  expect(writes).toHaveLength(1);expect(writes[0].sql).toMatch(/UPDATE bpjs_pending_responses SET jawaban_rs_manual/);
  expect(writes[0].sql).not.toMatch(/status|outcome|draft_klarifikasi/);
  expect(rag.saveReference).toHaveBeenCalledWith(mockDb,expect.objectContaining({pendingId:'pending-lama',sourceKind:'rs_manual'}));
});

test('jawaban yang sudah diisi petugas tidak ditimpa ketika mengunggah ulang',async()=>{
  duplicate={id:'pending-lama',jawaban_rs_manual:'Jawaban hasil koreksi petugas'};
  const r=await unggah();expect(r.body.updated_confirmation).toBe(0);expect(writes).toEqual([]);expect(rag.saveReference).not.toHaveBeenCalled();
});

test('pengisian bersamaan tidak dilaporkan berhasil bila jawaban sudah lebih dulu terisi',async()=>{
  duplicate={id:'pending-lama',jawaban_rs_manual:null};changes=0;
  const r=await unggah();expect(r.body.updated_confirmation).toBe(0);expect(rag.saveReference).not.toHaveBeenCalled();
  expect(writes[0].sql).toMatch(/jawaban_rs_manual IS NULL OR TRIM/);
});

test('file tanpa baris klaim ditolak tanpa penulisan data',async()=>{
  XLSX.read.mockReturnValue({SheetNames:['Sheet1'],Sheets:{Sheet1:XLSX.utils.aoa_to_sheet([['Alasan','Konfirmasi'],['alasan','jawaban']])}});
  const r=await unggah();expect(r.status).toBe(400);expect(writes).toEqual([]);
});

test('tanggal tidak valid ditolak sebelum penulisan, bukan hilang diam-diam',async()=>{
  XLSX.read.mockReturnValue({SheetNames:['RJ'],Sheets:{RJ:XLSX.utils.aoa_to_sheet([
    ['NOSEP','TGLSEP','ALASANPENDING','Konfirmasi'],['0170R0110126V000001','31 Februari 2026','alasan','jawaban'],
  ])}});
  const r=await unggah();expect(r.status).toBe(422);expect(r.body.kode).toBe('tanggal_rekap_tidak_valid');expect(writes).toEqual([]);
});
