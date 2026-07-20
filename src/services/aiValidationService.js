const https = require('https');
const http = require('http');

// Map the typescript types statuses to Postgres DB check constraints
function mapStatusToDb(status) {
  if (status === 'approved' || status === 'valid') return 'valid';
  if (status === 'flagged' || status === 'warning') return 'warning';
  if (status === 'review_required' || status === 'dispute') return 'dispute';
  return 'pending';
}

// ─── Rule-based fallback (if API unavailable) ────────────────────────────

const KELAS_RAWAT_MAP = {
  1: 'Kelas 1 (VIP)',
  2: 'Kelas 2',
  3: 'Kelas 3',
};

function analyzeSEP(sep) {
  if (!sep || sep.trim() === '') return 'Nomor SEP kosong — perlu diisi sebelum klaim.';
  if (sep !== sep.toUpperCase()) return 'Terdapat huruf kecil pada SEP — harus kapital semua.';
  if (sep.length < 5) return 'Nomor SEP terlalu pendek — periksa kembali.';
  return null;
}

function analyzeCardNumber(nokartu) {
  if (!nokartu || nokartu.trim() === '') return 'Nomor kartu BPJS kosong.';
  const digits = nokartu.replace(/\s|-/g, '');
  if (digits.length !== 13) return `Nomor kartu BPJS harus 13 digit (saat ini ${digits.length} digit setelah dibersihkan).`;
  if (nokartu.match(/[\s-]/)) return 'Terdapat spasi atau karakter strip pada nomor kartu — perlu dibersihkan.';
  return null;
}

function analyzeDiagnosis(diagnosa_list, inacbg_code, deskripsi_inacbg) {
  const issues = [];
  if (!diagnosa_list || diagnosa_list.trim() === '') {
    issues.push('Diagnosis kosong.');
  } else {
    const codes = diagnosa_list.split(/[,;]/).map(c => c.trim()).filter(Boolean);
    for (const code of codes) {
      if (!code.match(/^[A-Za-z]\d{2}/)) {
        issues.push(`Kode diagnosis "${code}" tidak sesuai format ICD-10.`);
      }
    }
  }
  if (diagnosa_list && !inacbg_code) {
    issues.push('Diagnosis terisi tapi kode INACBG belum ditentukan.');
  }
  if (inacbg_code && !deskripsi_inacbg) {
    issues.push('Kode INACBG ada tapi deskripsi kosong.');
  }
  return issues.length > 0 ? issues.join(' ') : null;
}

function analyzeProcedure(prosedur_list) {
  if (!prosedur_list || prosedur_list.trim() === '') return null;
  const codes = prosedur_list.split(/[,;]/).map(c => c.trim()).filter(Boolean);
  const issues = [];
  for (const code of codes) {
    if (!/^\d{2,3}(\.\d{1,4})?$/.test(code)) {
      issues.push(`Kode prosedur "${code}" tidak sesuai format ICD-9-CM.`);
    }
  }
  return issues.length > 0 ? issues.join(' ') : null;
}

function analyzeLOS(los, admission_date, discharge_date) {
  const issues = [];
  if (los < 0) issues.push('Length of Stay (LOS) negatif — tidak valid.');
  if (los === 0 && admission_date && discharge_date && admission_date !== discharge_date) {
    issues.push('LOS = 0 tapi tanggal masuk dan keluar berbeda.');
  }
  if (los > 30) issues.push(`LOS ${los} hari — rawat inap >30 hari perlu justifikasi khusus.`);
  if (los > 60) issues.push(`LOS sangat panjang (${los} hari) — perlu review kasus.`);
  return issues.length > 0 ? issues.join(' ') : null;
}

function analyzeDates(admission_date, discharge_date) {
  const issues = [];
  if (!admission_date) issues.push('Tanggal masuk (admission date) kosong.');
  if (!discharge_date) issues.push('Tanggal keluar (discharge date) kosong.');
  if (admission_date && discharge_date) {
    const adm = new Date(admission_date);
    const dis = new Date(discharge_date);
    if (isNaN(adm.getTime())) issues.push('Format tanggal masuk tidak valid.');
    if (isNaN(dis.getTime())) issues.push('Format tanggal keluar tidak valid.');
    if (!isNaN(adm.getTime()) && !isNaN(dis.getTime()) && dis < adm) {
      issues.push('Tanggal keluar lebih awal dari tanggal masuk — tidak valid.');
    }
    if (!isNaN(adm.getTime()) && adm > new Date()) {
      issues.push('Tanggal masuk masih di masa depan — periksa kembali.');
    }
  }
  return issues.length > 0 ? issues.join(' ') : null;
}

function analyzeTariff(tarif_inacbg, tarif_rs, total_tarif) {
  const issues = [];
  if (tarif_inacbg <= 0 && tarif_rs <= 0) return 'Tarif INACBG dan tarif RS kosong — perlu diisi.';
  if (tarif_inacbg <= 0 && tarif_rs > 0) issues.push('Tarif INACBG belum ditentukan.');
  if (tarif_rs <= 0 && tarif_inacbg > 0) issues.push('Tarif RS belum diisi.');
  if (tarif_inacbg < 1000000 && tarif_inacbg > 0) issues.push(`Tarif INACBG Rp ${tarif_inacbg.toLocaleString('id-ID')} — tergolong rendah, perlu validasi.`);
  if (tarif_rs > tarif_inacbg * 3 && tarif_inacbg > 0) issues.push('Tarif RS >3x tarif INACBG — perlu justifikasi.');
  return issues.length > 0 ? issues.join(' ') : null;
}

function analyzeICU(icu_indikator, vent_hour) {
  if (icu_indikator === 1 && vent_hour <= 0) return 'Indikator ICU aktif tapi jam ventilator 0 — periksa konsistensi data.';
  if (icu_indikator === 1 && vent_hour > 720) return `Ventilator ${vent_hour} jam (>30 hari) — perlu justifikasi.`;
  return null;
}

function analyzePatientInfo(nama_pasien, mrn) {
  const issues = [];
  if (!nama_pasien || nama_pasien.trim() === '') issues.push('Nama pasien kosong.');
  if (!mrn || mrn.trim() === '') issues.push('Nomor rekam medis (MRN) kosong.');
  return issues.length > 0 ? issues.join(' ') : null;
}

function analyzeKelasRawat(kelas_rawat) {
  const kr = Number(kelas_rawat);
  if (![1, 2, 3].includes(kr)) return `Kelas rawat "${kelas_rawat}" tidak valid (harus 1, 2, atau 3).`;
  return null;
}

function summarizeStatus(findings) {
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');

  if (errors.length > 0) {
    return {
      status: 'dispute',
      notes: `⚠️ ${errors.length} isu kritis ditemukan: ${errors.slice(0, 3).map(e => e.note).join('; ')}${errors.length > 3 ? ` +${errors.length - 3} lainnya` : ''}`,
    };
  }
  if (warnings.length > 0) {
    return {
      status: 'warning',
      notes: `⚡ ${warnings.length} catatan: ${warnings.slice(0, 3).map(w => w.note).join('; ')}${warnings.length > 3 ? ` +${warnings.length - 3} lainnya` : ''}`,
    };
  }
  return {
    status: 'valid',
    notes: `✅ Data klaim terlihat baik — tidak ditemukan masalah signifikan.`,
  };
}

function runRuleBasedAudit(records) {
  return records.map((record) => {
    const findings = [];

    const sepIssue = analyzeSEP(record.sep);
    if (sepIssue) findings.push({ severity: 'error', note: `SEP: ${sepIssue}` });

    const cardIssue = analyzeCardNumber(record.nokartu);
    if (cardIssue) findings.push({ severity: 'error', note: `No.Kartu: ${cardIssue}` });

    const dxIssue = analyzeDiagnosis(record.diagnosa_list, record.inacbg_code, record.deskripsi_inacbg);
    if (dxIssue) findings.push({ severity: 'warning', note: `Diagnosis: ${dxIssue}` });

    const procIssue = analyzeProcedure(record.prosedur_list);
    if (procIssue) findings.push({ severity: 'info', note: `Prosedur: ${procIssue}` });

    const losIssue = analyzeLOS(Number(record.los || 0), record.admission_date, record.discharge_date);
    if (losIssue) findings.push({ severity: 'warning', note: `LOS: ${losIssue}` });

    const dateIssue = analyzeDates(record.admission_date, record.discharge_date);
    if (dateIssue) findings.push({ severity: 'error', note: `Tanggal: ${dateIssue}` });

    const tariffIssue = analyzeTariff(Number(record.tarif_inacbg || 0), Number(record.tarif_rs || 0), Number(record.total_tarif || 0));
    if (tariffIssue) findings.push({ severity: 'warning', note: `Tarif: ${tariffIssue}` });

    const icuIssue = analyzeICU(Number(record.icu_indikator || 0), Number(record.vent_hour || 0));
    if (icuIssue) findings.push({ severity: 'info', note: `ICU: ${icuIssue}` });

    const patientIssue = analyzePatientInfo(record.nama_pasien, record.mrn);
    if (patientIssue) findings.push({ severity: 'error', note: `Data Pasien: ${patientIssue}` });

    const kelasIssue = analyzeKelasRawat(record.kelas_rawat);
    if (kelasIssue) findings.push({ severity: 'error', note: `Kelas Rawat: ${kelasIssue}` });

    const { status, notes } = summarizeStatus(findings);

    let suggestion = null;
    if (findings.length > 0) {
      const errorItems = findings.filter(f => f.severity === 'error');
      if (errorItems.length > 0) {
        suggestion = errorItems.slice(0, 2).map(e => `Perbaiki: ${e.note}`).join(' | ');
      } else {
        suggestion = findings.slice(0, 2).map(f => `Cek: ${f.note}`).join(' | ');
      }
    }

    return {
      recordId: record.id,
      ai_status: status,
      ai_notes: notes,
      ai_suggestions: suggestion,
    };
  });
}

// ─── Token estimation ─────────────────────────────────────────────────

/**
 * Estimate tokens using simple heuristic: ~4 chars = 1 token
 * Accounts for JSON structure overhead (~100 tokens base)
 */
function estimateTokens(textLength) {
  const contentTokens = Math.ceil(textLength / 4);
  const baseOverhead = 150; // system prompt + JSON overhead
  return contentTokens + baseOverhead;
}

function estimatePromptTokens(records, errorFields) {
  const systemPromptLength = 400;
  const jsonBaseLength = 50;
  const recordTokens = records.reduce((sum, r) => {
    let recordLength = JSON.stringify({
      id: r.id,
      errorFields: errorFields[r.id] || []
    }).length;
    // Add only error fields to count
    (errorFields[r.id] || []).forEach(field => {
      recordLength += String(r[field] || '').length;
    });
    return sum + recordLength;
  }, 0);

  return estimateTokens(systemPromptLength + recordTokens + jsonBaseLength);
}

function estimateCompletionTokens(recordCount) {
  // Rough estimate: ~150 tokens per record output (status, notes, suggestions)
  return Math.max(100, recordCount * 150);
}

// ─── AI API integration ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `AI Auditor BPJS E-Claim. Audit field-specific errors saja.
Validasi: ICD-10/diagnosa format valid, procedure ICD-9-CM sesuai, medication/tarif konsisten.
Output JSON array: [{"recordId":"","ai_status":"valid|warning|dispute","ai_notes":"detail","ai_suggestions":"rekomendasi"}]
STRICT: JSON array only, no markdown.`;

/**
 * Build message dengan field-specific audit (hemat token)
 * Hanya kirim field yang ada error untuk divalidasi AI
 */
function buildFieldAuditMessage(records, errorFieldsByRecord) {
  const data = records.map(r => {
    const errorFields = errorFieldsByRecord[r.id] || [];
    const auditData = { id: r.id, errors: [] };

    // Map field errors dengan konteks lengkap
    const fieldMap = {
      'sep': () => ({ field: 'SEP', value: r.sep, issue: 'format uppercase' }),
      'nokartu': () => ({ field: 'Kartu BPJS', value: r.nokartu, issue: '13 digit' }),
      'diagnosa_list': () => ({ field: 'Diagnosis ICD-10', value: r.diagnosa_list, issue: 'format valid' }),
      'prosedur_list': () => ({ field: 'Procedure ICD-9-CM', value: r.prosedur_list, issue: 'format valid' }),
      'los': () => ({ field: 'LOS', value: r.los, issue: 'reasonable days' }),
      'tarif_rs': () => ({ field: 'Tarif RS', value: r.tarif_rs, compare: r.total_tarif, issue: 'vs INACBG' }),
      'tarif_inacbg': () => ({ field: 'Tarif INACBG', value: r.tarif_inacbg, issue: 'reasonable' }),
      'kelas_rawat': () => ({ field: 'Kelas Rawat', value: r.kelas_rawat, issue: 'must be 1/2/3' }),
      'admission_date': () => ({ field: 'Tgl Masuk', value: r.admission_date, compare: r.discharge_date, issue: '<= discharge' }),
      'discharge_date': () => ({ field: 'Tgl Keluar', value: r.discharge_date, issue: 'valid date' }),
    };

    errorFields.forEach(field => {
      if (fieldMap[field]) {
        auditData.errors.push(fieldMap[field]());
      }
    });

    return auditData;
  });

  return JSON.stringify(data);
}

/**
 * Extract error fields from validation errors untuk field-specific audit
 */
function extractErrorFields(records, validationErrors) {
  const errorFieldsByRecord = {};

  records.forEach(r => {
    errorFieldsByRecord[r.id] = [];
  });

  validationErrors.forEach(errArr => {
    errArr.forEach(err => {
      if (err.record_id && err.field_name) {
        if (!errorFieldsByRecord[err.record_id]) {
          errorFieldsByRecord[err.record_id] = [];
        }
        if (!errorFieldsByRecord[err.record_id].includes(err.field_name)) {
          errorFieldsByRecord[err.record_id].push(err.field_name);
        }
      }
    });
  });

  return errorFieldsByRecord;
}

function buildUserMessage(records) {
  const simplified = records.map(r => ({
    id: r.id, sep: r.sep, nokartu: r.nokartu,
    dx: r.diagnosa_list, px: r.prosedur_list,
    los: r.los, tarif: r.tarif_rs, kelas: r.kelas_rawat,
  }));

  return JSON.stringify(simplified);
}

/**
 * Low-level POST ke endpoint OpenAI-compatible /chat/completions.
 * Reused oleh batch audit (runAiAudit) dan field audit (auditRecordField).
 */
async function postChatCompletion(bodyObj, apiKey, baseUrl) {
  const body = JSON.stringify(bodyObj);
  const url = new URL(`${baseUrl}/chat/completions`);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const transport = url.protocol === 'https:' ? https : http;

  // Resolve DNS first with timeout (skip for localhost)
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

async function callAiApi(records, apiKey, baseUrl, model, errorFieldsByRecord = null) {
  // Use field-specific audit if error fields provided, else fallback to generic
  const userMessage = errorFieldsByRecord
    ? buildFieldAuditMessage(records, errorFieldsByRecord)
    : buildUserMessage(records);

  const data = await postChatCompletion({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  }, apiKey, baseUrl);

  const msg = data?.choices?.[0]?.message || {};
  let content = msg.content || msg.reasoning_content || '';

  // Capture token usage
  const usage = data?.usage || {};
  _lastUsage = {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };

  if (!content) {
    throw new Error('AI returned empty response');
  }

  // Extract JSON from response (handle markdown ```json blocks)
  let jsonStr = content;
  // Try to extract JSON from ```json ... ``` block
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }
  // Fallback: find first [ to last ]
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    jsonStr = arrayMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }
    return parsed.map((item) => ({
      recordId: item.recordId || item.record_id || '',
      ai_status: mapStatusToDb(item.ai_status),
      ai_notes: item.ai_notes || item.ai_note || item.notes || '',
      ai_suggestions: item.ai_suggestions || item.suggestions || item.ai_suggestion || null,
    }));
  } catch (parseErr) {
    throw new Error(`Failed to parse AI response: ${parseErr.message}`);
  }
}

// ─── Degraded mode cache ──────────────────────────────────────────────────
// Skips AI API calls after first failure so subsequent batches return instantly
let _aiApiAvailable = null;
let _lastUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
let _totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function _resetAiApiCache() {
  _aiApiAvailable = null;
}

function getTotalUsage() {
  return { ..._totalUsage };
}

function _resetTotalUsage() {
  _totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

// ─── Main entry points ───────────────────────────────────────────────────

/**
 * Audit multiple records in batch
 * @param {Array} records
 * @param {Function} [onBatchComplete] - Optional callback called after each batch completes: (batchResults, completedCount) => Promise<void>
 * @param {Object} [errorFieldsByRecord] - Optional map of record ID to error field names for field-specific audit
 * @returns {Promise<Array>}
 */
async function runAiAudit(records, onBatchComplete, errorFieldsByRecord = null) {
  _resetTotalUsage();
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.AI_MODEL || 'google/gemini-2.5-flash-lite';

  // No API key configured — use rule-based fallback
  if (!apiKey || apiKey === '') {
    console.warn('[AI Audit] No API key configured, using rule-based fallback');
    const results = runRuleBasedAudit(records);
    if (onBatchComplete) {
      await onBatchComplete(results, records.length);
    }
    return results;
  }

  const BATCH_SIZE = 10;
  const allResults = [];

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchErrorFields = errorFieldsByRecord ? batch.reduce((acc, r) => {
      acc[r.id] = errorFieldsByRecord[r.id] || [];
      return acc;
    }, {}) : null;

    let batchResults;
    if (_aiApiAvailable === false) {
      batchResults = runRuleBasedAudit(batch);
    } else {
      try {
        batchResults = await callAiApi(batch, apiKey, baseUrl, model, batchErrorFields);
        _aiApiAvailable = true;
        if (_lastUsage.total_tokens > 0) {
          _totalUsage.prompt_tokens += _lastUsage.prompt_tokens;
          _totalUsage.completion_tokens += _lastUsage.completion_tokens;
          _totalUsage.total_tokens += _lastUsage.total_tokens;
        }
      } catch (err) {
        console.warn(`[AI Audit] API error, falling back to rules: ${err.message}`);
        _aiApiAvailable = false;
        batchResults = runRuleBasedAudit(batch);
      }
    }

    allResults.push(...batchResults);
    if (onBatchComplete) {
      await onBatchComplete(batchResults, allResults.length);
    }
    // Delay between batches to avoid rate limiting
    if (_aiApiAvailable !== false && i + BATCH_SIZE < records.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return allResults;
}

/**
 * Validate a single record (for bridging backward compatibility)
 * @param {Object} record 
 * @returns {Promise<{status: string, reason: string, suggestion: string}>}
 */
async function validateRecordWithAI(record) {
  const results = await runAiAudit([record]);
  if (results && results.length > 0) {
    return {
      status: results[0].ai_status,
      reason: results[0].ai_notes,
      suggestion: results[0].ai_suggestions
    };
  }
  return {
    status: 'warning',
    reason: 'Gagal melakukan audit AI.',
    suggestion: 'Silakan coba lagi.'
  };
}

// ─── Per-field AI audit (Phase 1) — OpenRouter with manual JSON parsing ────

const STYLE_DESCRIPTIONS = {
  ponytail: 'singkat dan actionable',
  caveman: 'ultra-singkat seperti telegram',
  neutral: 'formal dan lengkap untuk perawat verifikator',
};

const OPENROUTER_SYSTEM_PROMPT = `You are an expert medical claim auditor for the Indonesian BPJS Kesehatan E-Claim system. Your task is to analyze a specific field in a medical record that has failed validation and provide a clear, actionable correction suggestion for the hospital administration or coding team.

You must strictly output your analysis in a valid JSON format. Do not include any markdown formatting (like \`\`\`json), no backticks, and no conversational text outside the JSON.

Expected JSON structure:
{
  "field_name": "string (the name of the audited field)",
  "status": "string ('failed')",
  "error_description": "string (clear explanation of why this field failed based on BPJS rules, written in Indonesian)",
  "suggestion": "string (step-by-step actionable guidance in Indonesian on how the nurse/admin can fix it)",
  "confidence_score": float (a value between 0.0 and 1.0 representing your confidence)
}`;

function buildOpenRouterUserPrompt(fieldName, currentValue, errorMessage, medicalContext, auditStyle) {
  return `Please audit the following failed record field details:
- Field to Audit: ${fieldName}
- Current Value: ${currentValue || '(kosong/NULL)'}
- Validation Error Message: ${errorMessage}
- Medical Context/Diagnosis: ${medicalContext || '(tidak tersedia)'}
- Audit Style Requested: ${auditStyle} (${STYLE_DESCRIPTIONS[auditStyle] || 'formal'})

Provide the correction suggestion using the requested "Audit Style" but ensure the language used in the "suggestion" and "error_description" fields is Indonesian, so the hospital staff can easily understand it.`;
}

// Konteks pendamping per field supaya AI bisa cek konsistensi
const FIELD_CONTEXT = {
  sep: [],
  nokartu: [],
  diagnosa_list: ['inacbg_code', 'deskripsi_inacbg'],
  prosedur_list: ['diagnosa_list'],
  los: ['admission_date', 'discharge_date'],
  admission_date: ['discharge_date'],
  discharge_date: ['admission_date'],
  tarif_rs: ['tarif_inacbg', 'total_tarif'],
  tarif_inacbg: ['tarif_rs'],
  kelas_rawat: [],
  vent_hour: ['icu_indikator'],
};

/**
 * Fallback response jika JSON parsing gagal (Indonesian).
 */
function fallbackAuditResponse(fieldName, errorReason = '') {
  return {
    field_name: fieldName,
    status: 'failed',
    error_description: `Tidak dapat menganalisis field ini secara otomatis. ${errorReason}`,
    suggestion: 'Silakan periksa kembali data sesuai aturan BPJS dan konsultasikan dengan verifikator.',
    confidence_score: 0.3,
  };
}

/**
 * Audit satu field dari satu record via OpenRouter dengan manual JSON parsing.
 * @returns {{field_name, status, error_description, suggestion, confidence_score, style, tokens_used}}
 */
async function auditRecordField(record, fieldName, style = 'ponytail', validationError = null) {
  if (!['ponytail', 'caveman', 'neutral'].includes(style)) style = 'neutral';

  // Baca dari env dengan fallback ke default OpenRouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('[AI Audit] OPENROUTER_API_KEY belum dikonfigurasi.');

  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';

  const fieldKey = fieldName.toLowerCase();
  const currentValue = String(record[fieldKey] ?? '');

  // Ambil konteks medis (diagnosis) untuk enrichment prompt
  const medicalContext = record.deskripsi_inacbg || record.diagnosa_list || '';

  // Build user prompt menggunakan template yang diberikan
  const userMessage = buildOpenRouterUserPrompt(
    fieldName,
    currentValue,
    validationError || '(tidak diberikan)',
    medicalContext,
    style
  );

  // POST dengan custom headers OpenRouter
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: OPENROUTER_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: 'json_object' }, // hint ke model untuk JSON output
  });

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
      port: Number(url.port) || 443,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'E-Claim AI Auditor',
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
    throw new Error(`[OpenRouter] HTTP ${response.status}: ${response.body.substring(0, 150)}`);
  }

  let data;
  try {
    data = JSON.parse(response.body);
  } catch (e) {
    throw new Error(`[OpenRouter] Invalid JSON response: ${e.message}`);
  }

  const usage = data?.usage || {};
  const content = data?.choices?.[0]?.message?.content || '';

  if (!content) {
    throw new Error('[OpenRouter] Empty response content');
  }

  // Manual JSON parsing dari content (fallback dari markdown blocks)
  let auditResult;
  try {
    // Coba extract dari ```json ... ``` block dulu
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : content;
    auditResult = JSON.parse(jsonStr);
  } catch (parseErr) {
    console.warn(`[AI Audit] JSON parse failed for field ${fieldName}: ${parseErr.message}`);
    // Fallback: return default response dengan error message
    auditResult = fallbackAuditResponse(fieldName, `(parse error: ${parseErr.message})`);
  }

  // Normalize response fields
  const normalized = {
    field_name: auditResult.field_name || fieldName,
    status: auditResult.status || 'failed',
    error_description: auditResult.error_description || '',
    suggestion: auditResult.suggestion || '',
    confidence_score: Math.max(0, Math.min(1, Number(auditResult.confidence_score) || 0.5)),
    style,
    tokens_used: {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
      total: usage.total_tokens || 0,
    },
  };

  return normalized;
}

/**
 * Simpan hasil audit ke ai_audit_log. Return id log (dipakai untuk feedback perawat).
 */
async function logFieldAudit(db, { fileId, recordId, fieldName, result }) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();

  // Normalize result fields (OpenRouter response structure)
  const suggestion = result.status === 'failed' ? result.suggestion : null;
  const confidence = result.confidence_score ?? result.confidence ?? 0.5;
  const reasoning = result.error_description || '';

  await db.prepare(`
    INSERT INTO ai_audit_log (id, file_id, record_id, field_name, ai_suggestion, confidence, reasoning, style, tokens_input, tokens_output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, fileId, recordId, fieldName,
    suggestion,
    confidence, reasoning, result.style,
    result.tokens_used?.input || 0, result.tokens_used?.output || 0
  );
  return id;
}

module.exports = {
  runAiAudit,
  auditRecordField,
  logFieldAudit,
  validateRecordWithAI,
  resetAiApiCache: _resetAiApiCache,
  getTotalUsage,
  estimateTokens,
  estimatePromptTokens,
  estimateCompletionTokens,
  extractErrorFields,
  buildFieldAuditMessage,
  runRuleBasedAudit,
};
