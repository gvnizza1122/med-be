/**
 * Tahap 4 — AI-powered audit suggestions dengan validasi anti-upcoding
 *
 * Logika:
 * 1. Terima record (DIAGLIST, PROCLIST) + semua OCR results (dengan page numbers)
 * 2. Panggil AI semantic matching SEKALI untuk semua kode
 * 3. Validasi server-side: quotations harus substring nyata dari teks OCR
 * 4. Filter out financial terms (rupiah, biaya, tarif, dst)
 * 5. Return hasil yang sudah diverifikasi atau array kosong
 */

const https = require('https');
const http = require('http');

const AUDIT_SYSTEM_PROMPT = `Kamu asisten audit koding klaim BPJS. Tugasmu: cek apakah kode diagnosis/prosedur
yang diklaim punya bukti tertulis di dokumen scan rumah sakit (hasil lab, EKG,
catatan medis, dst).

ATURAN MUTLAK — PELANGGARAN = HASIL DITOLAK SISTEM:
1. HANYA nyatakan "ada bukti" kalau kamu bisa kutip kalimat PERSIS dari teks yang
   diberikan (bukan parafrase, bukan simpulan) yang mendukung kode itu.
2. WAJIB sertakan nomor halaman dan kutipan PERSIS untuk setiap klaim "ada bukti".
3. DILARANG KERAS menyebut nominal rupiah, biaya, tarif, atau dampak finansial
   dalam bentuk apapun.
4. DILARANG mengarang atau menyimpulkan kode dari konteks umum — hanya dari
   bukti eksplisit di teks.
5. Kalau ragu, JANGAN sertakan — lebih baik tidak menyarankan daripada salah.
6. Kamu HANYA memberi saran. Verifikator/coder manusia yang memutuskan.

Output HANYA JSON, tanpa markdown/penjelasan, format:
{
  "claimed_evidence": [
    { "code": "...", "found": true/false, "page_number": N, "quotation": "..." }
  ],
  "suggested_codes": [
    { "code": "...", "page_number": N, "quotation": "...", "reasoning": "..." }
  ]
}
suggested_codes HANYA diisi kalau ada bukti kuat kode itu relevan tapi belum
diklaim — kalau tidak yakin, biarkan array kosong.`;

/**
 * Build prompt untuk AI dengan format kode + teks OCR per halaman
 */
function buildAuditPrompt(claimedCodes, ocrResults) {
  let prompt = `DAFTAR KODE YANG DIKLAIM:\n`;

  const diagCodes = claimedCodes.diaglist ? claimedCodes.diaglist.split(';').filter(Boolean) : [];
  const procCodes = claimedCodes.proclist ? claimedCodes.proclist.split(';').filter(Boolean) : [];

  if (diagCodes.length > 0) {
    prompt += `Diagnosis (ICD-10): ${diagCodes.join(', ')}\n`;
  }
  if (procCodes.length > 0) {
    prompt += `Prosedur (ICD-9-CM): ${procCodes.join(', ')}\n`;
  }

  prompt += `\nBUKTI DARI DOKUMEN (teks OCR per halaman):\n`;
  prompt += `================================\n`;

  // Sort OCR by page number
  const sorted = [...ocrResults].sort((a, b) => a.page_number - b.page_number);
  for (const ocr of sorted) {
    const confidence = ocr.confidence || 0;
    prompt += `=== Halaman ${ocr.page_number} (confidence ${confidence}%) ===\n`;
    prompt += `${ocr.ocr_text}\n\n`;
  }

  prompt += `Berdasarkan bukti di atas, analisis apakah setiap kode diagnosis/prosedur yang diklaim memiliki bukti tekstual dalam dokumen.\n`;

  return prompt;
}

/**
 * Validasi bahwa quotation adalah substring nyata dari teks OCR pada halaman tertentu
 */
function validateQuotation(quotation, pageNumber, ocrResults) {
  if (!quotation || typeof quotation !== 'string') return false;

  const ocrPage = ocrResults.find(o => o.page_number === pageNumber);
  if (!ocrPage || !ocrPage.ocr_text) return false;

  // Case-insensitive substring check
  return ocrPage.ocr_text.toLowerCase().includes(quotation.toLowerCase());
}

/**
 * Filter out financial terms (anti-upcoding rambu)
 */
function hasFinancialTerms(text) {
  if (!text || typeof text !== 'string') return false;

  const financialPatterns = [
    /rupiah/i,
    /biaya/i,
    /tarif/i,
    /\bRp\b/,
    /\bbayar\b/i,
    /\bnilaib/i, // nilai tagihan, nilai pembayaran
    /\bharga\b/i,
    /\bongkos\b/i,
    /\bcost\b/i,
    /\bfee\b/i,
    /\d+\s*(?:juta|ribu|rb)/i, // angka besar dengan satuan (1 juta, 500 ribu)
  ];

  return financialPatterns.some(pattern => pattern.test(text));
}

/**
 * Post ke AI provider dengan retry logic (pola sama seperti pdfExtractionService)
 */
async function postChatCompletion(bodyObj, apiKey, baseUrl) {
  const body = JSON.stringify(bodyObj);
  const url = new URL(`${baseUrl}/chat/completions`);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const transport = url.protocol === 'https:' ? https : http;

  let ip = url.hostname;
  if (!isLocal) {
    ip = await new Promise((resolveIp, rejectIp) => {
      const timer = setTimeout(() => { rejectIp(new Error('DNS timeout')); }, 5000);
      require('dns').lookup(url.hostname, { family: 4 }, (err, addr) => {
        clearTimeout(timer);
        if (err) rejectIp(err);
        else resolveIp(addr);
      });
    });
  }

  const response = await new Promise((resolve, reject) => {
    const opts = {
      hostname: ip,
      path: url.pathname + (url.search || ''),
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
        'Host': url.hostname,
      },
      timeout: 30000,
    };
    if (url.protocol === 'https:') opts.rejectUnauthorized = true;

    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });

  if (response.status !== 200) {
    throw new Error(`AI API error ${response.status}: ${response.body.substring(0, 200)}`);
  }

  return JSON.parse(response.body);
}

/**
 * Main function: Generate audit suggestions
 * @param {Object} record - Claim record with diagnosa_list, prosedur_list
 * @param {Array} ocrResults - OCR results with page_number, ocr_text, confidence
 * @returns {Promise<{available, claimed_evidence, suggested_codes, tokens_used}>}
 */
async function generateAuditSuggestions(record, ocrResults) {
  const result = {
    available: false,
    claimed_evidence: [],
    suggested_codes: [],
    tokens_used: 0,
    errors: [],
  };

  // Validate inputs
  if (!record) {
    result.errors.push('Record tidak ditemukan');
    return result;
  }

  // Check if OCR results exist
  if (!ocrResults || ocrResults.length === 0) {
    result.available = false;
    result.message = 'Belum ada bukti tersedia untuk diperiksa';
    return result;
  }

  // Validate we have at least some text to analyze
  const hasText = ocrResults.some(o => o.ocr_text && o.ocr_text.trim().length > 0);
  if (!hasText) {
    result.available = false;
    result.message = 'Hasil OCR kosong atau tidak terbaca';
    return result;
  }

  // Prepare claimed codes
  const claimedCodes = {
    diaglist: record.diagnosa_list || record.DIAGLIST || '',
    proclist: record.prosedur_list || record.PROCLIST || '',
  };

  if (!claimedCodes.diaglist && !claimedCodes.proclist) {
    result.available = true;
    result.message = 'Tidak ada kode diagnosis atau prosedur untuk diperiksa';
    return result;
  }

  // Build audit prompt
  const userPrompt = buildAuditPrompt(claimedCodes, ocrResults);

  // Get API credentials
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    result.errors.push('AI_PROVIDER_API_KEY tidak dikonfigurasi');
    return result;
  }

  // Call AI with retry logic
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
              { role: 'system', content: AUDIT_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0,
            max_tokens: 4000,
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
      result.tokens_used = data.usage?.total_tokens || 0;

      if (!content) {
        throw new Error('Model membalas kosong');
      }

      // Parse JSON from response
      let aiResult;
      try {
        aiResult = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Model tidak mengembalikan JSON');
        aiResult = JSON.parse(m[0]);
      }

      result.available = true;

      // ===== SERVER-SIDE VALIDATION (CRITICAL) =====

      // Validate claimed_evidence
      if (Array.isArray(aiResult.claimed_evidence)) {
        for (const entry of aiResult.claimed_evidence) {
          // Skip entries where found=false (no quotation needed)
          if (!entry.found) {
            result.claimed_evidence.push({
              code: entry.code,
              found: false,
              page_number: null,
              quotation: null,
            });
            continue;
          }

          // For found=true, validate quotation is real
          const pageNum = entry.page_number;
          const quotation = entry.quotation;

          if (!quotation || !pageNum) {
            console.warn(`[AUDIT] Skipped entry without quotation: code=${entry.code}`);
            continue;
          }

          // Check if quotation is substring of actual OCR text
          if (!validateQuotation(quotation, pageNum, ocrResults)) {
            console.warn(`[AUDIT] Quotation mismatch (AI hallucination?): code=${entry.code}, page=${pageNum}`);
            continue;
          }

          // Filter financial terms in quotation
          if (hasFinancialTerms(quotation)) {
            console.warn(`[AUDIT] Filtered financial term in quotation: code=${entry.code}`);
            continue;
          }

          // Valid entry
          result.claimed_evidence.push({
            code: entry.code,
            found: true,
            page_number: pageNum,
            quotation: quotation.substring(0, 200), // Truncate if very long
          });
        }
      }

      // Pengaman: AI kadang tidak mengembalikan entry untuk SEMUA kode yang diminta
      // (dikonfirmasi lewat test nyata — 2 dari 8 kode hilang tanpa keterangan).
      // Kalau ada kode diklaim yang tidak muncul sama sekali di respons AI, tambahkan
      // sebagai found:false — coder harus tetap lihat SEMUA kodenya diperhitungkan,
      // jangan sampai kode hilang diam-diam dari tampilan audit.
      const allClaimedCodes = [
        ...(claimedCodes.diaglist ? claimedCodes.diaglist.split(';').filter(Boolean) : []),
        ...(claimedCodes.proclist ? claimedCodes.proclist.split(';').filter(Boolean) : []),
      ];
      const coveredCodes = new Set(result.claimed_evidence.map(e => e.code));
      for (const code of allClaimedCodes) {
        if (!coveredCodes.has(code)) {
          result.claimed_evidence.push({ code, found: false, page_number: null, quotation: null });
        }
      }

      // Validate suggested_codes
      if (Array.isArray(aiResult.suggested_codes)) {
        for (const entry of aiResult.suggested_codes) {
          const pageNum = entry.page_number;
          const quotation = entry.quotation;

          if (!quotation || !pageNum) {
            console.warn(`[AUDIT] Skipped suggestion without quotation: code=${entry.code}`);
            continue;
          }

          // Check if quotation is substring
          if (!validateQuotation(quotation, pageNum, ocrResults)) {
            console.warn(`[AUDIT] Suggestion quotation mismatch: code=${entry.code}`);
            continue;
          }

          // Filter financial terms
          if (hasFinancialTerms(quotation) || hasFinancialTerms(entry.reasoning)) {
            console.warn(`[AUDIT] Filtered financial term in suggestion: code=${entry.code}`);
            continue;
          }

          // Valid suggestion
          result.suggested_codes.push({
            code: entry.code,
            page_number: pageNum,
            quotation: quotation.substring(0, 200),
            reasoning: (entry.reasoning || '').substring(0, 200),
          });
        }
      }

      return result;
    } catch (error) {
      const msg = error.name === 'AbortError' ? `timeout ${timeoutMs}ms` : error.message;
      result.errors.push(`Attempt ${attempt}: ${msg}`);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 800 * attempt));
      }
    }
  }

  result.available = true; // Mark available even if AI failed (so FE knows to retry)
  return result;
}

module.exports = {
  generateAuditSuggestions,
  AUDIT_SYSTEM_PROMPT,
};
