const {KATEGORI,ensureKategori}=require('../../database/penunjangSchemaService');
const data=require('../../data/kamusPenunjang.json');
test('semua istilah kamus dapat masuk database termasuk histopatologi dan CTG',()=>{
  for(const e of [...data.istilah,...data.istilah_tambahan]) expect(KATEGORI).toContain(e.kategori);
});
test('constraint yang sudah mendukung kategori baru tidak meminta hak DDL saat restart',async()=>{
  const db={get:async()=>({definition:KATEGORI.map(k=>`'${k}'`).join(',')}),transaction:jest.fn(async()=>{throw Error('must be owner');})};
  await expect(ensureKategori(db)).resolves.toBeUndefined();expect(db.transaction).not.toHaveBeenCalled();
});
