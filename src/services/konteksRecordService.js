/** Hanya konteks klaim; hasil AI lama bukan bukti pasien dan tidak dikirim ulang. */
function dataUntukPrompt(record = {}, pages = []) {
  const { ai_review, ...data } = record;
  if (!data.raw_data) return data;
  let raw;
  try { raw=typeof data.raw_data==='string' ? JSON.parse(data.raw_data) : data.raw_data; } catch { return data; }
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return data;
  if (pages.some(p=>String(p.ocr_text || '').trim())) {
    // Arsip ekstraksi menduplikasi teks yang disertakan per halaman. Data
    // asli tetap tersimpan; angka hasil/tanda vital langsung tetap dikirim.
    const {physical_exam_findings,structured_extraction,_ocr_clinical_findings_notation,...fields}=raw;
    data.raw_data=fields;
  } else data.raw_data=raw;
  return data;
}
module.exports={dataUntukPrompt};
