/**
 * Sinkronisasi klaim_record_id di bpjs_pending_responses.
 *
 * Saat import rekap Excel pending BPJS, pencocokan SEP -> claim_records cuma
 * dilakukan SEKALI (SELECT id FROM claim_records WHERE sep = ?) di saat itu
 * juga — kalau klaim PDF-nya belum pernah diupload waktu itu, baris pending
 * tetap claim_record_id = NULL SELAMANYA walau klaimnya baru diupload
 * belakangan (badge "belum ditemukan" tidak pernah hilang sendiri).
 * Dipanggil best-effort setiap kali ada record klaim baru tersimpan, supaya
 * pending yang tadinya "belum ditemukan" otomatis ke-link begitu klaim
 * aslinya akhirnya diupload — tanpa perlu re-import Excel-nya lagi.
 */
async function linkPendingBpjsForSep(db, sep, recordId) {
  if (!sep || !recordId) return;
  try {
    await db.prepare(`
      UPDATE bpjs_pending_responses SET claim_record_id = ?
      WHERE sep = ? AND claim_record_id IS NULL
    `).run(recordId, sep);
  } catch (e) {
    console.error('[bpjsPendingLink] gagal sinkronisasi:', e.message);
  }
}

module.exports = { linkPendingBpjsForSep };
