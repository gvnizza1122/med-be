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
module.exports = { bulanKini, rentangBulan, ringkasanBulanan, gabung };
