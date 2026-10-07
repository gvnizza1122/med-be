const bulanKini = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
};

function rentangBulan(bulan) {
  if (typeof bulan !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(bulan)) {
    const err = new Error('Pilih bulan yang valid (YYYY-MM).');
    err.status = 400;
    throw err;
  }
  const [tahun, nomor] = bulan.split('-').map(Number);
  const waktu = m => new Date(Date.UTC(tahun, m, 1) - 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  return [waktu(nomor - 1), waktu(nomor)];
}

const bidangJumlah = ['calls', 'failed_calls', 'measured_calls', 'priced_calls', 'input_tokens',
  'output_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens'];
function gabung(rows) {
  const hasil = Object.fromEntries(bidangJumlah.map(k => [k, rows.reduce((n, r) => n + Number(r[k] || 0), 0)]));
  // NULL berarti belum bisa dihitung; tidak menyamarkan biaya hilang sebagai nol.
  hasil.estimated_usd = hasil.priced_calls || !hasil.calls ? rows.reduce((n, r) => n + Number(r.estimated_usd || 0), 0) : null;
  hasil.estimated_idr = hasil.priced_calls || !hasil.calls ? rows.reduce((n, r) => n + Number(r.estimated_idr || 0), 0) : null;
  hasil.unmeasured_calls = hasil.calls - hasil.measured_calls;
  hasil.unpriced_calls = hasil.calls - hasil.priced_calls;
  return hasil;
}
function kelompok(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const id = JSON.stringify(keys.map(k => row[k] || null));
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups.values()].map(group => ({
    ...Object.fromEntries(keys.map(k => [k, group[0][k] || null])), ...gabung(group),
  }));
}

async function ringkasanBulanan(db, hospitalCode, bulan = bulanKini()) {
  const [awal, akhir] = rentangBulan(bulan);
  if (!hospitalCode) {
    const err = new Error('Rumah sakit pada akun belum ditentukan. Hubungi administrator.');
    err.status = 403;
    throw err;
  }
  const rows = await db.all(`SELECT
      TO_CHAR((waktu AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS day,
      penyedia AS provider, model, effort, tugas AS task, jenis_klaim AS claim_type,
      COUNT(*) AS calls, COUNT(*) FILTER (WHERE NOT ok) AS failed_calls,
      COUNT(*) FILTER (WHERE COALESCE(total_tokens, prompt_tokens + completion_tokens, 0) > 0) AS measured_calls,
      COUNT(estimasi_usd) AS priced_calls,
      SUM(prompt_tokens) AS input_tokens, SUM(completion_tokens) AS output_tokens,
      SUM(COALESCE(total_tokens, prompt_tokens + completion_tokens)) AS total_tokens,
      SUM(cached_tokens) AS cached_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
      SUM(estimasi_usd) AS estimated_usd, SUM(estimasi_idr) AS estimated_idr
    FROM catatan_panggilan_model
    WHERE hospital_code = ? AND waktu >= ?::timestamp AND waktu < ?::timestamp
    GROUP BY day, penyedia, model, effort, tugas, jenis_klaim
    ORDER BY day, model, tugas`, [String(hospitalCode), awal, akhir]);
  return {
    month: bulan, timezone: 'Asia/Jakarta', updated_at: new Date().toISOString(),
    exchange_rate: Number(process.env.AI_USD_IDR) > 0 ? Number(process.env.AI_USD_IDR) : 18000,
    summary: gabung(rows),
    models: kelompok(rows, ['provider', 'model', 'effort']).sort((a, b) => b.total_tokens - a.total_tokens),
    days: kelompok(rows, ['day']),
    tasks: kelompok(rows, ['task']).sort((a, b) => b.calls - a.calls),
    claim_types: kelompok(rows, ['claim_type']),
  };
}
async function biayaBerkas(db,hospitalCode,bulan=bulanKini(),page=1) {
  const [awal,akhir]=rentangBulan(bulan);
  if(!hospitalCode) {const e=Error('Rumah sakit pada akun belum ditentukan.');e.status=403;throw e;}
  if(!/^\d+$/.test(String(page)) || !Number.isSafeInteger(Number(page)) || Number(page)<1 || Number(page)>100000) {
    const e=Error('Nomor halaman tidak valid.');e.status=400;throw e;
  }
  const limit=25,offset=(Number(page)-1)*limit;
  const rows=await db.all(`WITH biaya AS (
    SELECT cr.file_id,COUNT(*) AS calls,COUNT(c.estimasi_idr) AS priced_calls,
      SUM(c.total_tokens) AS total_tokens,SUM(c.estimasi_idr) AS estimated_idr,MAX(c.waktu) AS last_used
    FROM catatan_panggilan_model c JOIN claim_records cr ON cr.id=c.record_id
      JOIN claim_files cf ON cf.id=cr.file_id AND cf.hospital_code=c.hospital_code
    WHERE c.hospital_code=? AND c.waktu>=?::timestamp AND c.waktu<?::timestamp GROUP BY cr.file_id
  ), daftar AS (
    SELECT cf.id AS file_id,cf.file_name,b.calls,b.priced_calls,b.total_tokens,b.estimated_idr,b.last_used,
      a.target_idr,a.batas_idr,a.terpakai_idr,a.dicadangkan_idr,a.belum_pasti_idr,a.gagal_idr,a.tambahan_alasan
    FROM claim_files cf LEFT JOIN biaya b ON b.file_id=cf.id
      LEFT JOIN ai_anggaran_berkas a ON a.id=cf.ai_anggaran_id AND a.hospital_code=cf.hospital_code
    WHERE cf.hospital_code=? AND (b.file_id IS NOT NULL OR cf.created_at>=?::timestamp AND cf.created_at<?::timestamp)
  ) SELECT *,COUNT(*) OVER() AS total_files FROM daftar
    ORDER BY last_used DESC NULLS LAST,file_id LIMIT ? OFFSET ?`,[String(hospitalCode),awal,akhir,String(hospitalCode),awal,akhir,limit,offset]);
  const n=v=>Number(v)||0;
  return {month:bulan,page:Number(page),page_size:limit,total_files:n(rows[0]?.total_files),
    policy:{target_idr:500,batas_normal_idr:600,batas_maksimum_idr:5000},
    files:rows.map(r=>({file_id:r.file_id,file_name:r.file_name,calls:n(r.calls),priced_calls:n(r.priced_calls),
      total_tokens:r.total_tokens==null?null:n(r.total_tokens),estimated_idr:n(r.priced_calls)?n(r.estimated_idr):null,
      budget:r.target_idr==null?null:{target_idr:n(r.target_idr),batas_idr:n(r.batas_idr),terpakai_idr:n(r.terpakai_idr),
        dicadangkan_idr:n(r.dicadangkan_idr),belum_pasti_idr:n(r.belum_pasti_idr),gagal_idr:n(r.gagal_idr),
        tambahan_alasan:r.tambahan_alasan||[]}}))};
}
module.exports = { bulanKini, rentangBulan, ringkasanBulanan, gabung,biayaBerkas };
