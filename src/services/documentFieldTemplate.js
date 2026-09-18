/**
 * Model tri-state untuk field form (fix item 4, 18-19 Sep 2026): recorded |
 * empty_on_form | not_in_form -- menggantikan asumsi lama "nilai null berarti
 * perlu dilengkapi" yang menghasilkan false positive (mis. "Lengkapi/cek
 * SpO2" padahal form Triase IGD RS ybs memang tidak punya kolom SpO2 sama
 * sekali).
 *
 * Deterministik murni (regex terhadap teks mentah halaman), TIDAK memakai AI
 * -- template per tipe dokumen ada di src/data/document_field_templates.json,
 * bisa ditambah/diubah tanpa ubah kode ini.
 */
const templates = require('../data/document_field_templates.json');

/**
 * @param {string} fieldKey - key field yang dicek (mis. 'SpO2')
 * @param {string} docType - tipe dokumen (mis. 'triase_igd'), harus ada di
 *   document_field_templates.json
 * @param {Array<{page_number:number, ocr_text:string}>} pages - halaman
 *   dokumen tipe ini yang relevan (SUDAH difilter ke tipe/nomor halaman yang
 *   tepat oleh pemanggil)
 * @param {boolean} hasValue - apakah nilai field ini berhasil diekstrak
 *   (sudah lolos validasi kutipan) untuk record ini
 * @returns {'recorded'|'empty_on_form'|'not_in_form'}
 */
function resolveFieldFormStatus(fieldKey, docType, pages, hasValue) {
  if (hasValue) return 'recorded';

  const templateForDoc = templates[docType];
  const fieldTemplate = templateForDoc && templateForDoc[fieldKey];
  // Tidak ada template untuk field/tipe dokumen ini -- fallback ke perilaku
  // LAMA (anggap "empty_on_form", supaya tidak diam-diam menyembunyikan
  // action item untuk field yang belum ada template-nya) sampai template
  // ditambah di document_field_templates.json.
  if (!fieldTemplate || !Array.isArray(fieldTemplate.label_patterns) || fieldTemplate.label_patterns.length === 0) {
    return 'empty_on_form';
  }

  const combinedText = (Array.isArray(pages) ? pages : [])
    .map(p => p?.ocr_text || '')
    .join('\n');
  if (!combinedText) return 'empty_on_form';

  const found = fieldTemplate.label_patterns.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(combinedText);
    } catch {
      return false;
    }
  });
  return found ? 'empty_on_form' : 'not_in_form';
}

module.exports = { resolveFieldFormStatus };
