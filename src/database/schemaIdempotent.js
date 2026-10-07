// IF NOT EXISTS tetap memerlukan hak pemilik di beberapa DDL PostgreSQL.
// Periksa katalog dahulu; jangan memperluas hak akun aplikasi untuk startup.
async function pastikanIndeks(db, sql) {
  const name = /^\s*CREATE INDEX IF NOT EXISTS (\w+)\s+ON\s+/i.exec(sql)?.[1];
  if (!name) throw Error('Definisi indeks tidak dikenal.');
  const row = typeof db.get==='function' ? await db.get("SELECT 1 AS ada FROM pg_indexes WHERE schemaname='public' AND indexname=?",[name]) : null;
  if (Number(row?.ada)!==1) await (db.query || db.run).call(db,sql);
}
async function pastikanKolom(db, table, definitions) {
  if (!/^\w+$/.test(table) || Object.keys(definitions).some(k=>!/^\w+$/.test(k))) throw Error('Nama skema tidak sah.');
  const rows = typeof db.all==='function' ? await db.all("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?",[table]) : [];
  const existing = new Set(rows.map(r=>r.column_name));
  const missing = Object.entries(definitions).filter(([name])=>!existing.has(name));
  if (missing.length) await db.query(`ALTER TABLE ${table} ${missing.map(([name,type])=>`ADD COLUMN IF NOT EXISTS ${name} ${type}`).join(', ')}`);
}
module.exports={pastikanIndeks,pastikanKolom};
