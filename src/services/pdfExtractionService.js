const { PDF_FIELDS, SYSTEM_FIELDS, buildRecord, toTSV, COLUMNS } = require('./vclaimSchema');

/**
 * Ekstrak teks halaman claim-data → 1 record vClaim (60 kolom, format asli vClaim).
 * Kolom bersumber 'system' (CODER_ID, C1-C4, TARIF_RS, dst) TIDAK diminta ke AI —
 * data itu tidak ada di PDF; mengarang nilainya = data palsu.
 *
 * @param {string} claimDataText - hasil classifyPdfPages().claimDataText
 * @param {string} [jenisKlaim] - kategori pelayanan (RAWAT_JALAN/RAWAT_INAP/GAWAT_DARURAT),
 *   dipilih user saat upload — dipakai untuk instruksi khusus KELAS_RAWAT (lihat prompt).
 * @returns {Promise<{success, record, tokens, missingSystemFields, errors}>}
 */
async function extractClaimData(claimDataText, jenisKlaim) {
  const result = {
    success: false,
    record: {},
    tokens: { prompt: 0, completion: 0, total: 0 },
    attempts: 0,
    missingSystemFields: [...SYSTEM_FIELDS],
    errors: [],
  };

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  if (!apiKey) { result.errors.push('AI_PROVIDER_API_KEY tidak diisi di .env'); return result; }
  if (!claimDataText || !claimDataText.trim()) { result.errors.push('claimDataText kosong'); return result; }

  const kelasRawatRule = jenisKlaim === 'RAWAT_JALAN'
    ? `8. KELAS_RAWAT khusus rawat jalan: pasien rawat jalan TIDAK dirawat inap, jadi field "Kelas Rawat"/"Kls Rawat" di dokumen wajar KOSONG atau "-". Untuk kasus ini, isi KELAS_RAWAT dari NOMOR KELAS di field "Kelas Hak"/"Kls Hak" (kelas hak kepesertaan BPJS pasien, BUKAN kelas ruangan rawat inap) — ambil hanya angkanya (contoh: "Kelas 2" -> "2"). Kalau "Kelas Hak" juga tidak ada, baru isi KELAS_RAWAT dengan "".`
    : `8. KELAS_RAWAT: ambil dari field "Kelas Rawat"/"Kls Rawat" (kelas ruangan rawat inap pasien), ambil hanya angkanya (contoh: "Kelas 2" -> "2"). JANGAN pakai "Kelas Hak" untuk field ini.`;

  const prompt = `Kamu ekstraktor data klaim BPJS dari halaman "Berkas Klaim Individual" (output E-Klaim Indonesia)
dan halaman pendukung seperti "Surat Eligibilitas Peserta" (SEP) dalam dokumen yang sama.
Data sudah ter-kode (ICD-10 diagnosa, ICD-9 prosedur, INA-CBG). Tugasmu HANYA MENYALIN, bukan menyimpulkan.

ATURAN KETAT:
1. Output HANYA JSON object. Tanpa markdown, tanpa backtick, tanpa penjelasan.
2. Tanggal WAJIB format DD/MM/YYYY (contoh: 09/06/2026).
3. DIAGLIST & PROCLIST: kode dipisah titik-koma, TANPA spasi (contoh: I13.1;D63.8;L28.2).
4. Angka tarif: digit polos tanpa Rp/titik/koma (contoh: 3287300).
5. SEX: 1=laki-laki, 2=perempuan. KODE_TARIF: kode singkat saja (TARIF RS KELAS D SWASTA -> DS).
6. Kalau sebuah field TIDAK ADA di teks, isi string kosong "". JANGAN menebak, JANGAN menyalin dari field lain.
7. SEP dan NOKARTU boleh diambil dari halaman "Surat Eligibilitas Peserta" kalau ada — di
   halaman itu labelnya sering disingkat "No. SEP" (bukan "Nomor SEP") dan "No. Kartu"
   (bukan "Nomor Kartu"). Tetap SAMA PERSIS field SEP dan NOKARTU, cuma beda halaman sumber.
${kelasRawatRule}
9. Isi HANYA field berikut: ${PDF_FIELDS.join(', ')}.

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
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'Kamu mengembalikan HANYA satu JSON object. Dilarang menulis penjelasan, penalaran, atau markdown.' },
              { role: 'user', content: prompt },
            ],
            // max_completion_tokens (bukan max_tokens) & tanpa temperature custom
            // — lihat catatan sama di aiReviewService.js.
            max_completion_tokens: 2000,
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
