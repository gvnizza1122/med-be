/**
 * Eksperimen: bandingkan gpt-5.6-sol vs gpt-5.6-luna untuk clinical-consistency
 * check (semantic diagnosis-vs-evidence reasoning) pada 3 kasus RANAP bedah
 * nyata. Standalone, tidak menyentuh DB/route/frontend produksi — lihat plan
 * di C:\Users\masam\.claude\plans\snuggly-discovering-gosling.md.
 *
 * Jalankan: node scripts/clinicalConsistencyExperiment.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const {
  validateQuotation,
  hasFinancialTerms,
} = require('../src/services/aiReviewService');

const CASES = [
  { label: '0170R0110126V000762', path: 'D:\\ranap\\KLAIM RI 2026\\01 JANUARI\\12 JANUARI - 7\\0170R0110126V000762.pdf' },
  { label: '0170R0110126V000334', path: 'D:\\ranap\\KLAIM RI 2026\\01 JANUARI\\06 JANUARI - 5\\0170R0110126V000334.pdf' },
  { label: '0170R0110126V001065', path: 'D:\\ranap\\KLAIM RI 2026\\01 JANUARI\\12 JANUARI - 7\\0170R0110126V001065.pdf' },
];

const MODELS = [
  { key: 'sol', model: process.env.CLINICAL_CONSISTENCY_MODEL_SOL || 'gpt-5.6-sol',
    priceIn: 4.5, priceOut: 25 }, // $/M token, titik tengah kisaran ~$4-5/$20-30
  { key: 'luna', model: process.env.CLINICAL_CONSISTENCY_MODEL_LUNA || 'gpt-5.6-luna',
    priceIn: 0.20, priceOut: 1.20 },
];

const OUTPUT_REPORT = 'C:\\Users\\masam\\OneDrive\\Dokumen\\production\\Clinical-Consistency-Experiment-Report.md';

const CLINICAL_CONSISTENCY_SYSTEM_PROMPT = `Kamu asisten audit klinis untuk verifikator BPJS rumah sakit, menilai satu berkas klaim RAWAT_INAP (RANAP).
Kamu diberi seluruh teks dokumen klaim (hasil ekstraksi PDF, ditandai per halaman "=== Halaman N ===").

TUGAS (kerjakan berurutan):
1. Cari dokumen "RESUME MEDIS RAWAT INAP" di dalam teks. Ringkas 6 field: Alasan Masuk, Ringkasan
   Penemuan Fisik Penting, Pemeriksaan Penunjang, Diagnosis Utama, Diagnosis Sekunder, Tindakan/Prosedur.
   Kalau tidak ditemukan, set resume_medis_found:false dan lewati task 1-2.
2. Nilai secara NARATIF (bukan sekadar ya/tidak) apakah kata-kata di Resume Medis (terutama Alasan
   Masuk, Ringkasan Penemuan Fisik, Pemeriksaan Penunjang) mendukung/konsisten dengan Diagnosis Utama
   yang ditegakkan. Jelaskan penalaran klinismu seperti seorang koder senior menjelaskan ke rekan kerja.
3. Cari hasil EKG, laboratorium, dan RO Thorax di seluruh dokumen (bisa di luar halaman Resume Medis).
   Untuk tiap jenis yang ditemukan: kutip temuannya, sebutkan halaman, dan nilai apakah temuan itu
   MENDUKUNG diagnosis utama secara klinis.
4. Tentukan apakah kasus ini kemungkinan TRAUMA (mis. riwayat kecelakaan/jatuh/benturan/cedera) dari
   narasi Alasan Masuk atau diagnosis. Kalau ya, cari apakah ada "LEMBAR KRONOLOGI" di dokumen. Kalau
   trauma tapi lembar kronologi tidak ditemukan, tandai found_in_document:false.
5. Nilai apakah panel laboratorium/pemeriksaan penunjang yang benar-benar diminta/dikerjakan (dari
   teks) secara klinis wajar untuk diagnosis yang dikodekan — atau ada ketidaksesuaian (misal diagnosis
   mengarah ke pemeriksaan tertentu yang seharusnya ada tapi tidak ditemukan, atau sebaliknya).

ATURAN ANTI-HALUSINASI (WAJIB):
- Setiap field "quotation" HARUS kutipan PERSIS (verbatim) dari teks yang diberikan, disertai
  "page_number" yang benar. Jangan parafrase, jangan mengarang.
- Kalau ragu atau tidak menemukan sesuatu, katakan demikian (found_in_document:false /
  tidak_dapat_dinilai) — jangan mengarang supaya terlihat lengkap.
- DILARANG KERAS menyebut nominal rupiah/biaya/tarif di manapun dalam jawaban.

FORMAT OUTPUT — JSON PERSIS SKEMA INI (tanpa markdown/teks lain di luar JSON):
{
  "resume_medis_found": true,
  "resume_medis_summary": { "alasan_masuk": "", "ringkasan_penemuan_fisik": "", "pemeriksaan_penunjang": "", "diagnosis_utama": "", "diagnosis_sekunder": [""], "tindakan_prosedur": "" },
  "wording_diagnosis_assessment": { "verdict": "sesuai|sebagian_sesuai|tidak_sesuai|tidak_dapat_dinilai", "narrative": "", "page_number": 0, "quotation": "" },
  "evidence_cross_checks": [ { "evidence_type": "ekg|laboratorium|ro_thorax", "found_in_document": true, "page_number": 0, "quotation": "", "supports_diagnosis": true, "reasoning": "" } ],
  "case_category": { "is_trauma": false, "is_surgical": false, "basis": "" },
  "kronologi_check": { "required": false, "found_in_document": false, "page_number": null, "note": "" },
  "lab_panel_diagnosis_consistency": { "consistent": true, "narrative": "", "flags": [ { "issue": "", "page_number": 0, "quotation": "" } ] },
  "overall_summary": ""
}`;

async function extractPages(filePath) {
  const data = fs.readFileSync(filePath);
  const parsed = await new PDFParse({ data }).getText();
  const text = parsed.text || '';
  const chunks = text.split(/--\s*\d+\s*of\s*\d+\s*--/i);
  return chunks.map((chunk, i) => ({ page_number: i + 1, ocr_text: chunk }));
}

function buildUserPrompt(pages) {
  return pages
    .filter(p => p.ocr_text.trim().length > 0)
    .map(p => `=== Halaman ${p.page_number} ===\n${p.ocr_text.trim()}`)
    .join('\n\n');
}

async function callModel(model, userPrompt) {
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  if (!apiKey) throw new Error('AI_PROVIDER_API_KEY tidak diset di .env');

  const start = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLINICAL_CONSISTENCY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { _parse_error: true, _raw: content };
  }

  return {
    latencyMs,
    promptTokens: json.usage?.prompt_tokens || 0,
    completionTokens: json.usage?.completion_tokens || 0,
    result: parsed,
  };
}

function estimateCost(promptTokens, completionTokens, priceIn, priceOut) {
  return (promptTokens / 1e6) * priceIn + (completionTokens / 1e6) * priceOut;
}

function collectQuotations(result) {
  const items = [];
  if (result.wording_diagnosis_assessment?.quotation) {
    items.push({
      source: 'wording_diagnosis_assessment',
      quotation: result.wording_diagnosis_assessment.quotation,
      page_number: result.wording_diagnosis_assessment.page_number,
    });
  }
  for (const ec of result.evidence_cross_checks || []) {
    if (ec.quotation) items.push({ source: `evidence_cross_checks[${ec.evidence_type}]`, quotation: ec.quotation, page_number: ec.page_number });
  }
  for (const flag of result.lab_panel_diagnosis_consistency?.flags || []) {
    if (flag.quotation) items.push({ source: 'lab_panel_diagnosis_consistency.flags', quotation: flag.quotation, page_number: flag.page_number });
  }
  return items;
}

function validateAllQuotations(result, evidencePool) {
  const items = collectQuotations(result);
  let failed = 0;
  let financial = 0;
  for (const item of items) {
    const valid = validateQuotation(item.quotation, item.page_number, evidencePool);
    if (!valid) failed++;
    if (hasFinancialTerms(item.quotation)) financial++;
  }
  return { total: items.length, failed, financial };
}

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

async function main() {
  const runResults = []; // { caseLabel, modelKey, model, latencyMs, cost, validation, result }

  for (const c of CASES) {
    console.log(`\n[case] ${c.label} — mengekstrak PDF...`);
    const pages = await extractPages(c.path);
    const userPrompt = buildUserPrompt(pages);
    console.log(`[case] ${c.label} — ${pages.length} halaman, ${userPrompt.length} char prompt`);

    for (const m of MODELS) {
      console.log(`[case] ${c.label} — memanggil ${m.key} (${m.model})...`);
      try {
        const { latencyMs, promptTokens, completionTokens, result } = await callModel(m.model, userPrompt);
        const cost = estimateCost(promptTokens, completionTokens, m.priceIn, m.priceOut);
        const validation = validateAllQuotations(result, pages);
        console.log(`[case] ${c.label} — ${m.key} selesai: ${latencyMs}ms, $${cost.toFixed(4)}, kutipan gagal validasi: ${validation.failed}/${validation.total}`);
        runResults.push({ caseLabel: c.label, modelKey: m.key, model: m.model, latencyMs, promptTokens, completionTokens, cost, validation, result });
      } catch (err) {
        console.error(`[case] ${c.label} — ${m.key} GAGAL: ${err.message}`);
        runResults.push({ caseLabel: c.label, modelKey: m.key, model: m.model, error: err.message });
      }
    }
  }

  writeReport(runResults);
  console.log(`\nLaporan ditulis ke: ${OUTPUT_REPORT}`);
}

function writeReport(runResults) {
  let md = `# Eksperimen Clinical-Consistency: gpt-5.6-sol vs gpt-5.6-luna\n\n`;
  md += `Dihasilkan otomatis dari \`scripts/clinicalConsistencyExperiment.js\`, ${CASES.length} kasus RANAP bedah x 2 model.\n\n`;

  md += `## Ringkasan Biaya & Waktu\n\n`;
  md += `| Kasus | Model | Latency | Prompt Tokens | Completion Tokens | Estimasi Biaya | Kutipan Gagal Validasi |\n`;
  md += `|---|---|---:|---:|---:|---:|---:|\n`;
  for (const r of runResults) {
    if (r.error) {
      md += `| ${r.caseLabel} | ${r.modelKey} | ERROR | - | - | - | ${mdEscape(r.error)} |\n`;
      continue;
    }
    md += `| ${r.caseLabel} | ${r.modelKey} (${r.model}) | ${(r.latencyMs / 1000).toFixed(1)}s | ${r.promptTokens} | ${r.completionTokens} | $${r.cost.toFixed(4)} | ${r.validation.failed}/${r.validation.total} |\n`;
  }

  const okResults = runResults.filter(r => !r.error);
  const totalCost = okResults.reduce((s, r) => s + r.cost, 0);
  md += `\n**Total estimasi biaya eksperimen: $${totalCost.toFixed(4)}**\n\n`;

  md += `---\n\n## Detail Per Kasus (sol vs luna berdampingan)\n\n`;
  for (const c of CASES) {
    md += `### ${c.label}\n\n`;
    for (const key of ['sol', 'luna']) {
      const r = runResults.find(x => x.caseLabel === c.label && x.modelKey === key);
      md += `#### Model: ${key}\n\n`;
      if (!r || r.error) {
        md += `_Gagal: ${mdEscape(r?.error || 'tidak ada hasil')}_\n\n`;
        continue;
      }
      const res = r.result;
      md += `- **Resume Medis ditemukan:** ${res.resume_medis_found}\n`;
      md += `- **Diagnosis Utama (ringkasan model):** ${mdEscape(res.resume_medis_summary?.diagnosis_utama)}\n`;
      md += `- **Verdict kesesuaian kata vs diagnosis:** ${res.wording_diagnosis_assessment?.verdict}\n`;
      md += `  - Narasi: ${mdEscape(res.wording_diagnosis_assessment?.narrative)}\n`;
      md += `- **Evidence cross-checks:**\n`;
      for (const ec of res.evidence_cross_checks || []) {
        md += `  - [${ec.evidence_type}] ditemukan:${ec.found_in_document}, mendukung diagnosis:${ec.supports_diagnosis} — ${mdEscape(ec.reasoning)}\n`;
      }
      md += `- **Kategori kasus:** trauma:${res.case_category?.is_trauma}, bedah:${res.case_category?.is_surgical} — ${mdEscape(res.case_category?.basis)}\n`;
      md += `- **Cek kronologi:** wajib:${res.kronologi_check?.required}, ditemukan:${res.kronologi_check?.found_in_document} — ${mdEscape(res.kronologi_check?.note)}\n`;
      md += `- **Kesesuaian panel lab vs diagnosis:** konsisten:${res.lab_panel_diagnosis_consistency?.consistent} — ${mdEscape(res.lab_panel_diagnosis_consistency?.narrative)}\n`;
      md += `- **Simpulan:** ${mdEscape(res.overall_summary)}\n\n`;
    }
  }

  fs.writeFileSync(OUTPUT_REPORT, md);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
