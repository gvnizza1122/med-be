const express=require('express');const request=require('supertest');
jest.mock('../../middleware/auth',()=>({authenticate:(req,res,next)=>req.headers.authorization==='Bearer catalog-test'?next():res.status(401).json({error:'Login diperlukan.'})}));
const app=express();app.use('/catalogue',require('../../routes/katalogPedoman'));
test('daftar dan PDF memerlukan autentikasi',async()=>{
 expect((await request(app).get('/catalogue')).status).toBe(401);expect((await request(app).get('/catalogue/KMK-2025-1168/pdf')).status).toBe(401);
});
test('daftar autentikasi menampilkan PDF tersedia tanpa data pasien',async()=>{
 const r=await request(app).get('/catalogue?q=1168').set('Authorization','Bearer catalog-test');expect(r.status).toBe(200);expect(r.body.total).toBe(1);expect(r.body.dokumen[0].id).toBe('KMK-2025-1168');
});
test('PDF memakai tipe benar; input varian tidak sah dan berkas hilang ditolak',async()=>{
 const r=await request(app).get('/catalogue/KMK-2025-1168/pdf').set('Authorization','Bearer catalog-test');expect(r.status).toBe(200);expect(r.headers['content-type']).toMatch(/application\/pdf/);expect(r.body.subarray(0,4).toString()).toBe('%PDF');
 for(const [url,status] of [['/catalogue/BA-KLAIM-2017-1/pdf',404],['/catalogue/KMK-2025-1168/pdf?varian=-1',400],['/catalogue/KMK-2025-1168/pdf?varian=0.5',400],['/catalogue/no-such-id',404]])expect((await request(app).get(url).set('Authorization','Bearer catalog-test')).status).toBe(status);
});
