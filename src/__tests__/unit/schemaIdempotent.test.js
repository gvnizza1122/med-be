const {pastikanIndeks,pastikanKolom}=require('../../database/schemaIdempotent');
test('akun tanpa hak DDL dapat startup ketika indeks dan kolom sudah tersedia',async()=>{
  const db={get:async()=>({ada:1}),all:async()=>[{column_name:'is_testing'}],query:jest.fn(async()=>{throw Error('must be owner of table');})};
  await expect(pastikanIndeks(db,'CREATE INDEX IF NOT EXISTS idx_test ON claim_files(id)')).resolves.toBeUndefined();
  await expect(pastikanKolom(db,'claim_files',{is_testing:'BOOLEAN'})).resolves.toBeUndefined();
  expect(db.query).not.toHaveBeenCalled();
});
test('kolom baru tetap dibuat dan tidak mengubah kolom yang ada',async()=>{
  const db={all:async()=>[{column_name:'lama'}],query:jest.fn(async()=>({}))};
  await pastikanKolom(db,'uji',{lama:'TEXT',baru:'INTEGER'});
  expect(db.query.mock.calls[0][0]).toBe('ALTER TABLE uji ADD COLUMN IF NOT EXISTS baru INTEGER');
});
test('migrasi yang belum tersedia tetap melaporkan kekurangan hak, tidak dianggap sukses',async()=>{
  const db={get:async()=>undefined,query:async()=>{throw Error('must be owner');}};
  await expect(pastikanIndeks(db,'CREATE INDEX IF NOT EXISTS idx_test ON uji(id)')).rejects.toThrow('must be owner');
});
