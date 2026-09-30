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
const { normalisasiSep } = require('./sepCocokService');

async function linkPendingBpjsForSep(db, sep, recordId) {
  if (!sep || !recordId) return;
  try {
    await db.prepare(`
      UPDATE bpjs_pending_responses SET claim_record_id = ?
      WHERE sep = ? AND claim_record_id IS NULL
    `).run(recordId, sep);

    // Cadangan: SEP rekap bisa berbeda tulisan (spasi, karakter tersembunyi,
    // sisa label) dari SEP klaim. Bandingkan lewat kunci ternormalisasi.
    // Hanya kecocokan aman (bukan tebakan huruf mirip) yang ditautkan.
    const kunci = normalisasiSep(sep).kunci;
    if (!kunci) return;
    const belumTertaut = await db.prepare(
      'SELECT id, sep FROM bpjs_pending_responses WHERE claim_record_id IS NULL'
    ).all();
    for (const b of belumTertaut) {
      if (normalisasiSep(b.sep).kunci === kunci) {
        await db.prepare(
          'UPDATE bpjs_pending_responses SET claim_record_id = ? WHERE id = ? AND claim_record_id IS NULL'
        ).run(recordId, b.id);
      }
    }
  } catch (e) {
    console.error('[bpjsPendingLink] gagal sinkronisasi:', e.message);
  }
}

module.exports = { linkPendingBpjsForSep };
