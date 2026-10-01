// Tarif Standard teks, diverifikasi 1 Oktober 2026. Estimasi, bukan tagihan.
const TARIF = {
  'gpt-6-luna': { input: 0.1, cache: 0.01, output: 0.5 },
  'gpt-6.1-sol': { input: 2, cache: 0.1, output: 10 },
};
function normalisasiPenggunaan(usage = {}) {
  const n = v => Math.max(0, Number(v) || 0);
  const input = n(usage.prompt_tokens);
  const output = n(usage.completion_tokens);
  return {
    prompt_tokens: input, completion_tokens: output,
    total_tokens: n(usage.total_tokens) || input + output,
    cached_tokens: Math.min(input, n(usage.prompt_tokens_details?.cached_tokens)),
    reasoning_tokens: Math.min(output, n(usage.completion_tokens_details?.reasoning_tokens)),
  };
}
function estimasiBiaya(model, usage, penyedia = 'openai_compat') {
  const tarif = penyedia === 'openai_compat' && TARIF[model];
  if (!tarif || !usage || !(usage.total_tokens > 0) || !(usage.prompt_tokens + usage.completion_tokens > 0)) return null;
  const panjang = usage.prompt_tokens > 272000;
  const usd = ((usage.prompt_tokens - usage.cached_tokens) * tarif.input * (panjang ? 2 : 1)
    + usage.cached_tokens * tarif.cache * (panjang ? 2 : 1)
    + usage.completion_tokens * tarif.output * (panjang ? 1.5 : 1)) / 1e6;
  const kurs = Number(process.env.AI_USD_IDR) > 0 ? Number(process.env.AI_USD_IDR) : 18000;
  return { usd, idr: usd * kurs, kurs, dasar: 'standard_teks_2026-10-01' };
}
module.exports = { normalisasiPenggunaan, estimasiBiaya };
