/**
 * Rules terpisah (JSON, src/data/procedure_rules.json -- bisa diedit tanpa
 * deploy ulang kode) untuk dua hal (fix item 5 & 8, 18-19 Sep 2026):
 * (1) checkProcedureCodability -- tandai kode PROCLIST yang evidence-nya
 *     valid tapi codability-nya meragukan (lab rutin dsb) sebagai
 *     'perlu_review', BUKAN 'valid' otomatis. TIDAK PERNAH mengubah/menghapus
 *     kode -- murni flag + alasan.
 * (2) matchTindakanSegera -- cari pola tindakan keperawatan segera dari teks
 *     BEBAS (Triase IGD/CPPT), dipakai kegawatdaruratanAggregation.js sebagai
 *     TAMBAHAN dari K5_WHITELIST_CODES (kode PROCLIST resmi) untuk K5.
 */
const rules = require('../data/procedure_rules.json');

/**
 * @param {string} code - kode ICD-9-CM prosedur (mis. "90.59")
 * @returns {{review:boolean, reason:string|null}}
 */
function checkProcedureCodability(code) {
  if (!code || typeof code !== 'string') return { review: false, reason: null };
  const normalized = code.trim();
  const matches = (rules.non_codable_or_review_procedures || [])
    .filter(r => r.match_type === 'prefix' && normalized.startsWith(r.code_prefix))
    // Rule dengan code_prefix LEBIH PANJANG (lebih spesifik) menang duluan.
    .sort((a, b) => b.code_prefix.length - a.code_prefix.length);
  if (matches.length === 0) return { review: false, reason: null };
  return { review: true, reason: matches[0].reason };
}

/**
 * Cari pola tindakan segera (teks bebas) di kumpulan halaman -- dipakai
 * untuk K5 sebagai sinyal TAMBAHAN dari PROCLIST (bukan pengganti).
 * @param {Array<{page_number:number, ocr_text:string}>} pages
 * @returns {Array<{id:string, label:string, page_number:number, kutipan:string}>}
 */
function matchTindakanSegera(pages) {
  const out = [];
  const patterns = rules.k5_tindakan_segera_patterns || [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const text = page?.ocr_text || '';
    if (!text) continue;
    for (const p of patterns) {
      let re;
      try {
        re = new RegExp(p.pattern, 'i');
      } catch {
        continue;
      }
      const idx = text.search(re);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + 120);
      const kutipan = text.slice(start, end).replace(/\s+/g, ' ').trim();
      out.push({ id: p.id, label: p.label, page_number: page.page_number, kutipan });
    }
  }
  return out;
}

function freetextPromotesToYa() {
  return rules._k5_freetext_promotes_to_ya === true;
}

function getEsiSignalThreshold() {
  return Number.isFinite(rules.esi_signal_threshold) ? rules.esi_signal_threshold : 3;
}

module.exports = { checkProcedureCodability, matchTindakanSegera, freetextPromotesToYa, getEsiSignalThreshold };
