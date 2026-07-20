const { PDF_FIELDS, SYSTEM_FIELDS, buildRecord, toTSV, COLUMNS } = require('./vclaimSchema');

// OpenRouter OpenAI-compatible endpoint
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/**
 * Ekstrak teks halaman claim-data → 1 record vClaim (60 kolom, format asli vClaim).
 * Kolom bersumber 'system' (CODER_ID, C1-C4, TARIF_RS, dst) TIDAK diminta ke AI —
 * data itu tidak ada di PDF; mengarang nilainya = data palsu.
 *
 * @param {string} claimDataText - hasil classifyPdfPages().claimDataText
 * @returns {Promise<{success, record, tokens, missingSystemFields, errors}>}
 */
async function extractClaimData(claimDataText) {
  const result = {
    success: false,
    record: {},
    tokens: { prompt: 0, completion: 0, total: 0 },
    attempts: 0,
    missingSystemFields: [...SYSTEM_FIELDS],
    errors: [],
  };

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.AI_MODEL || 'openrouter/free';

  if (!apiKey) { result.errors.push('OPENROUTER_API_KEY tidak diisi di .env'); return result; }
  if (!claimDataText || !claimDataText.trim()) { result.errors.push('claimDataText kosong'); return result; }

  const prompt = `Kamu ekstraktor data klaim BPJS dari halaman "Berkas Klaim Individual" (output E-Klaim Indonesia).
Data sudah ter-kode (ICD-10 diagnosa, ICD-9 prosedur, INA-CBG). Tugasmu HANYA MENYALIN, bukan menyimpulkan.

ATURAN KETAT:
1. Output HANYA JSON object. Tanpa markdown, tanpa backtick, tanpa penjelasan.
2. Tanggal WAJIB format DD/MM/YYYY (contoh: 09/06/2026).
3. DIAGLIST & PROCLIST: kode dipisah titik-koma, TANPA spasi (contoh: I13.1;D63.8;L28.2).
4. Angka tarif: digit polos tanpa Rp/titik/koma (contoh: 3287300).
5. SEX: 1=laki-laki, 2=perempuan. KODE_TARIF: kode singkat saja (TARIF RS KELAS D SWASTA -> DS).
6. Kalau sebuah field TIDAK ADA di teks, isi string kosong "". JANGAN menebak, JANGAN menyalin dari field lain.
7. Isi HANYA field berikut: ${PDF_FIELDS.join(', ')}.

TEKS KLAIM:
${claimDataText}

JSON:`;

  // Model kadang balas teks penalaran / kosong alih-alih JSON (terutama model gratis).
  // Retry dengan jeda menaik; sekali sukses langsung berhenti.
  const maxAttempts = Number(process.env.AI_MAX_ATTEMPTS || 3);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let respText;
      try {
        const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'eClaim PDF Extraction',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'Kamu mengembalikan HANYA satu JSON object. Dilarang menulis penjelasan, penalaran, atau markdown.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0,
            max_tokens: 2000,
            response_format: { type: 'json_object' },
          }),
        });
        respText = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
      } finally {
        clearTimeout(timer);
      }

      const data = JSON.parse(respText);
      const content = data.choices?.[0]?.message?.content || '';
      result.tokens.prompt = data.usage?.prompt_tokens || 0;
      result.tokens.completion = data.usage?.completion_tokens || 0;
      result.tokens.total = result.tokens.prompt + result.tokens.completion;
      result.attempts = attempt;

      // Ambil JSON object dari response (toleran markdown fence / teks pengantar).
      let extracted;
      try {
        extracted = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) throw new Error(content.trim() ? 'model membalas teks, bukan JSON' : 'model membalas kosong');
        extracted = JSON.parse(m[0]);
      }

      // Buang field yang bukan milik PDF (kalau model tetap mengarang system field).
      for (const k of SYSTEM_FIELDS) delete extracted[k];

      result.record = buildRecord(extracted);
      result.success = true;
      result.errors = [];
      return result;
    } catch (error) {
      const msg = error.name === 'AbortError' ? `timeout ${timeoutMs}ms` : error.message;
      result.errors.push(`percobaan ${attempt}: ${msg}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }

  result.attempts = maxAttempts;
  return result;
}

module.exports = { extractClaimData, toTSV, COLUMNS };
