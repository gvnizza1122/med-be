/**
 * Konsistensi klinis diagnosis (fix item 9, 18-19 Sep 2026) -- rules per
 * keluarga ICD-10 di src/data/diagnosis_consistency.json (JSON terpisah, bisa
 * diedit tanpa deploy ulang). MURNI deterministik (regex terhadap
 * evidencePool), TIDAK ada panggilan AI -- sama filosofinya dengan
 * kegawatdaruratanAggregation.js (auditable, tidak tergantung "mood" model).
 *
 * PENTING (batasan eksplisit dari tugas ini): TIDAK PERNAH mengubah/menghapus
 * kode DIAGLIST. Hasilnya HANYA flag 'perlu_review' + kode alternatif
 * (arah-netral -- severity_indicators yang cocok menunjukkan kemungkinan
 * derajat LEBIH BERAT dari yang dikode, TAPI ini sinyal untuk verifikator,
 * bukan simpulan final) + evidence lengkap + aksi "Klarifikasi DPJP". Sistem
 * ini BUKAN alat upcoding.
 */
const rules = require('../data/diagnosis_consistency.json');
const { classifyPageDocumentType } = require('./pdfPageClassifier');

function extractSnippet(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().substring(0, 200);
}

function buildReasonText(code, famRule, foundIndicators, undocumented, altEntry) {
  const indicatorParts = foundIndicators.map(i => `${i.label} (${i.document_type}, hal. ${i.page_number})`);
  const altCode = altEntry ? altEntry[0] : null;
  const altLabel = altCode ? famRule.variant_label[altCode] : null;
  let text = `Ditemukan ${foundIndicators.length} indikator severity yang tidak sejalan dengan derajat "${famRule.variant_label[code] || code}" yang dikode: ${indicatorParts.join('; ')}.`;
  if (altCode) text += ` Pertimbangkan klarifikasi ke DPJP apakah lebih sesuai ${altCode} (${altLabel}) -- kode TIDAK diubah otomatis.`;
  if (undocumented.length > 0) text += ` Indikator yang TIDAK ditemukan didokumentasikan: ${undocumented.map(u => u.label).join(', ')}.`;
  return text;
}

/**
 * @param {Array<string>} diagnosisCodes - kode DIAGLIST record ini (sudah di-trim)
 * @param {Array<{page_number:number, ocr_text:string}>} evidencePool - SEMUA
 *   halaman (bukan dibatasi satu tipe dokumen -- indikator severity boleh
 *   datang dari SPRI/Resume Medis/Lab/Triase manapun)
 * @returns {Array} flag per kode yang butuh review, format lihat buildReasonText
 */
function evaluateDiagnosisConsistency(diagnosisCodes, evidencePool) {
  const flags = [];
  for (const rawCode of diagnosisCodes || []) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) continue;
    const family = code.split('.')[0];
    const famRule = rules.families[family];
    if (!famRule || !famRule.variant_severity_rank) continue;
    const rank = famRule.variant_severity_rank[code];
    if (rank === undefined) continue;

    // Hanya varian PALING RINGAN (rank terkecil) dalam keluarga ini yang
    // dievaluasi untuk kemungkinan under-coding -- varian yang sudah lebih
    // berat tidak perlu "naik" lagi (arah netral: kita tidak punya rules
    // untuk turun derajat di sini, karena kasus sumber cuma soal under-coding;
    // menambah arah turun butuh indicator set terpisah, belum ada dasarnya).
    const ranks = Object.values(famRule.variant_severity_rank);
    const minRank = Math.min(...ranks);
    if (rank !== minRank) continue;

    const foundIndicators = [];
    for (const ind of famRule.severity_indicators || []) {
      let re;
      try { re = new RegExp(ind.pattern, 'i'); } catch { continue; }
      for (const page of evidencePool || []) {
        const text = page?.ocr_text || '';
        if (!text) continue;
        const m = text.match(re);
        if (m) {
          foundIndicators.push({
            id: ind.id,
            label: ind.label,
            page_number: page.page_number,
            document_type: classifyPageDocumentType(text),
            kutipan: extractSnippet(text, m.index, m[0].length),
          });
          break; // satu kutipan representatif per indikator sudah cukup
        }
      }
    }
    if (foundIndicators.length < (famRule.min_indicators_for_flag || Infinity)) continue;

    const undocumented = [];
    for (const ind of famRule.undocumented_indicators_to_mention || []) {
      let re;
      try { re = new RegExp(ind.pattern, 'i'); } catch { continue; }
      const anyMatch = (evidencePool || []).some(p => re.test(p?.ocr_text || ''));
      if (!anyMatch) undocumented.push({ id: ind.id, label: ind.label });
    }

    const entries = Object.entries(famRule.variant_severity_rank).sort((a, b) => a[1] - b[1]);
    const altEntry = entries.find(([, r]) => r > rank) || null;

    flags.push({
      code,
      family,
      status: 'perlu_review',
      alternative_code: altEntry ? altEntry[0] : null,
      alternative_label: altEntry ? famRule.variant_label[altEntry[0]] : null,
      indicators_found: foundIndicators,
      indicators_undocumented: undocumented,
      action: famRule.action || 'Klarifikasi DPJP',
      reason: buildReasonText(code, famRule, foundIndicators, undocumented, altEntry),
    });
  }
  return flags;
}

module.exports = { evaluateDiagnosisConsistency };
