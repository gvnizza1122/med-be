const express=require('express'),request=require('supertest');
const svc=require('../../services/profilKlaimRsService');
let mockDb,mockUser;
jest.mock('../../database/init',()=>({getDb:()=>mockDb}));
jest.mock('../../middleware/auth',()=>({
  authenticate:(req,res,next)=>{req.user=mockUser;next();},
  authorize:()=> (req,res,next)=>mockUser.role==='admin'?next():res.status(403).json({error:'Tidak diizinkan.'}),
}));
const app=express();app.use(express.json());app.use('/settings',require('../../routes/hospitalSettings'));
const payload={layanan:{rehabilitasi_medis:true},referensi_dinonaktifkan:[],ketentuan_lokal:[]};
beforeEach(()=>{mockUser={id:'admin-rs',email:'uji@example.invalid',hospital_code:'RS-B',role:'admin'};
  mockDb={get:jest.fn(async()=>undefined),run:jest.fn(async()=>({changes:1})),query:jest.fn(async()=>({})),transaction:async fn=>fn(mockDb)};});
test('RS baru tidak mendapatkan ketentuan pending atau adaptasi Lestari',async()=>{
  const r=await request(app).get('/settings/claim-profile');expect(r.status).toBe(200);
  expect(r.body.profil.ketentuan_lokal).toEqual([]);expect(r.body.profil.layanan.rehabilitasi_medis).toBeNull();expect(r.body.katalog.aturan).toHaveLength(18);
});
test('simpan hanya kode RS dari akun; payload tidak bisa mengubah RS lain',async()=>{
  const r=await request(app).put('/settings/claim-profile').send(payload);expect(r.status).toBe(200);
  expect(mockDb.run.mock.calls[0][1][0]).toBe('RS-B');expect(mockDb.run.mock.calls[1][1]).toContain('UPDATE_CLAIM_PROFILE');
  const bad=await request(app).put('/settings/claim-profile').send({...payload,hospital_code:'RS-A'});expect(bad.status).toBe(400);
});
test('pengguna nonadmin tidak dapat mengubah profil',async()=>{
  mockUser.role='verifikator';const r=await request(app).put('/settings/claim-profile').send(payload);expect(r.status).toBe(403);expect(mockDb.run).not.toHaveBeenCalled();
});
test('profil tidak boleh disimpan tanpa kode RS akun',async()=>{
  mockUser.hospital_code=null;expect((await request(app).put('/settings/claim-profile').send(payload)).status).toBe(403);
});
test.each([
  {layanan:{rehabilitasi_medis:'false'}},{referensi_dinonaktifkan:['RK-TIDAK-ADA']},
  {ketentuan_lokal:[{id:'SP-01',sumber_aturan:'',disahkan_oleh:''}]},
  {ketentuan_lokal:[{id:'SP-01',sumber_aturan:'Ketentuan BPJS untuk RS B',disahkan_oleh:'Tim RS B',berlaku_mulai:'2026-02-30'}]},
  {ketentuan_lokal:[{id:'SP-01',sumber_aturan:'Ketentuan BPJS untuk RS B',disahkan_oleh:'Tim RS B',berlaku_mulai:'2026-09-01',berlaku_sampai:'2026-08-01'}]},
])('konfigurasi tidak sah ditolak sebelum menulis: %p',async bad=>{
  const r=await request(app).put('/settings/claim-profile').send(bad);expect(r.status).toBe(400);expect(mockDb.run).not.toHaveBeenCalled();
});
test('gangguan DB tidak diam-diam mengaktifkan ketentuan bawaan Lestari',async()=>{
  mockDb.get.mockRejectedValue(Error('offline'));const p=await svc.muatProfil(mockDb,'3371084');expect(p.ketentuan_lokal).toEqual([]);expect(p.konfigurasi_belum_terbaca).toBe(true);
});
test('schema menyimpan katalog berversi dan profil terpisah per RS',async()=>{
  await svc.ensureSchema(mockDb);expect(mockDb.query.mock.calls[0][0]).toMatch(/referensi_klaim_catalog/);expect(mockDb.query.mock.calls[0][0]).toMatch(/hospital_code TEXT PRIMARY KEY/);
});
