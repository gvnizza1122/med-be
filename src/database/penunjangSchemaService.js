const KATEGORI = ['hematologi','kimia_klinik','serologi','urin_feses','mikrobiologi','radiologi','kardiologi','lain','tindakan','patologi','obstetri'];
async function ensureKategori(db) {
  const existing=await db.get(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='kamus_penunjang'::regclass AND conname='kamus_penunjang_kategori_check'`);
  if (KATEGORI.every(k=>existing?.definition?.includes(`'${k}'`))) return;
  const sql=`ALTER TABLE kamus_penunjang DROP CONSTRAINT IF EXISTS kamus_penunjang_kategori_check;
    ALTER TABLE kamus_penunjang ADD CONSTRAINT kamus_penunjang_kategori_check
    CHECK(kategori IN (${KATEGORI.map(k=>`'${k}'`).join(',')}));`;
  await db.transaction(tx=>tx.query(sql));
}
module.exports={KATEGORI,ensureKategori};
