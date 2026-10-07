// Tarif Standard teks, diverifikasi 7 Oktober 2026: developers.openai.com/api/docs/pricing.
// Estimasi, bukan tagihan. Cache write memakai tarif tersendiri, bukan biaya tambahan.
const TARIF = {
  'gpt-6-luna': { input: 0.1, cache: 0.01, write: 0.125, output: 0.5 },
  'gpt-6.1-sol': { input: 2, cache: 0.1, write: 2.5, output: 10 },
};
function normalisasiPenggunaan(usage = {}) {
  const n = v => Math.max(0, Number(v) || 0);
  const input = n(usage.prompt_tokens);
  const output = n(usage.completion_tokens);
  const cached = Math.min(input, n(usage.prompt_tokens_details?.cached_tokens));
  return {
    prompt_tokens: input, completion_tokens: output,
    total_tokens: n(usage.total_tokens) || input + output,
    cached_tokens: cached,
    cache_write_tokens: Number.isFinite(usage.prompt_tokens_details?.cache_write_tokens)
      ? Math.min(input - cached, n(usage.prompt_tokens_details.cache_write_tokens)) : null,
    reasoning_tokens: Math.min(output, n(usage.completion_tokens_details?.reasoning_tokens)),
  };
}
function estimasiBiaya(model, usage, penyedia = 'openai_compat') {
  const tarif = penyedia === 'openai_compat' && TARIF[model];
  if (!tarif || !usage || !(usage.total_tokens > 0) || !(usage.prompt_tokens + usage.completion_tokens > 0)) return null;
  const panjang = usage.prompt_tokens > 272000;
  const writes = Math.min(usage.prompt_tokens - usage.cached_tokens, Number(usage.cache_write_tokens) || 0);
  const usd = ((usage.prompt_tokens - usage.cached_tokens - writes) * tarif.input * (panjang ? 2 : 1)
    + writes * tarif.write * (panjang ? 2 : 1)
    + usage.cached_tokens * tarif.cache * (panjang ? 2 : 1)
    + usage.completion_tokens * tarif.output * (panjang ? 1.5 : 1)) / 1e6;
  const kurs = Number(process.env.AI_USD_IDR) > 0 ? Number(process.env.AI_USD_IDR) : 18000;
  return { usd, idr: usd * kurs, kurs, dasar: 'standard_teks_2026-10-07' };
}
// Batas konservatif: token teks <= jumlah byte UTF-8, ditambah pembungkus pesan.
// Semua input dianggap cache write, sehingga diskon cache tidak dipakai untuk menjanjikan anggaran.
function batasBiaya(model, system, prompt, completion, penyedia = 'openai_compat') {
  const input = Buffer.byteLength(String(system || '') + String(prompt || ''), 'utf8') + 1024;
  return estimasiBiaya(model, { prompt_tokens: input, completion_tokens: completion,
    total_tokens: input + completion, cached_tokens: 0, cache_write_tokens: input }, penyedia);
}
module.exports = { normalisasiPenggunaan, estimasiBiaya, batasBiaya };
