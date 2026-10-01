/**
 * Client Kimi K3 (Moonshot AI) — dipakai KHUSUS untuk pipeline training RAG
 * (backfill arsip lama via scripts/importTrainingData.js, dan hook otomatis
 * setelah generate-draft di routes/bpjsPending.js). TIDAK dipakai di alur
 * review klaim utama (itu tetap AI_PROVIDER_API_KEY/AI_MODEL/gpt-5.6-luna).
 * API Moonshot kompatibel format OpenAI chat-completions, jadi bentuk client
 * ini sengaja disamakan dengan callAi() di routes/bpjsPending.js.
 */

const KIMI_SYSTEM_PROMPT = `Kamu asisten casemix BPJS. Kamu diberi teks mentah 1 kasus pending BPJS
(alasan pending + jawaban klarifikasi RS, dan kalau ada, hasil akhirnya). Tugasmu MERINGKAS jadi
data terstruktur untuk basis pengetahuan (RAG), BUKAN membuat jawaban baru.

Kembalikan JSON dengan struktur persis:
{
  "sep": "nomor SEP kalau ditemukan, atau null",
  "kategori_pending": "kategori singkat (mis. kode_tindakan, kegawatan, prb, koding_diagnosis, kelengkapan_dokumen, lainnya)",
  "alasan_pending": "ringkasan alasan pending BPJS, Bahasa Indonesia",
  "jawaban_klarifikasi": "ringkasan argumen/jawaban RS, Bahasa Indonesia",
  "outcome": "diterima | ditolak | revisi | tidak_diketahui",
  "poin_kunci": ["poin argumen kunci 1", "poin argumen kunci 2"],
  "confidence": 0-100 (seberapa yakin kamu data ini terbaca lengkap & jelas dari teksnya)
}

ATURAN KERAS:
- Semua isi field HANYA boleh berasal dari teks yang diberikan. JANGAN mengarang SEP, kategori, atau
  argumen yang tidak ada dasarnya di teks.
- Kalau outcome tidak disebutkan/tidak jelas di teks, isi "tidak_diketahui" — JANGAN menebak.
- Kalau teks terlalu rusak/tidak jelas untuk diringkas, tetap kembalikan JSON dengan field kosong/null
  seadanya dan confidence rendah (di bawah 30), JANGAN menolak merespons.`;

async function callKimi(prompt) {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
  const model = process.env.KIMI_MODEL || 'kimi-k3';
  const timeoutMs = Number(process.env.KIMI_TIMEOUT_MS || 60000);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: KIMI_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_completion_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });
    const respText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
    const data = JSON.parse(respText);
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('Kimi membalas kosong');
    try {
      return JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Kimi tidak mengembalikan JSON');
      return JSON.parse(m[0]);
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callKimi, KIMI_SYSTEM_PROMPT };
