function parse(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

// Pembacaan ulang mengganti analisis, tetapi riwayat koreksi tidak ikut hilang.
async function simpanAiReview(db, recordId, review) {
  const previous = await db.prepare('SELECT ai_review FROM claim_records WHERE id = ?').get(recordId);
  const old = parse(previous && previous.ai_review);
  const seen = new Set();
  review.penggantian_kode = [...(Array.isArray(old.penggantian_kode) ? old.penggantian_kode : []),
    ...(Array.isArray(review.penggantian_kode) ? review.penggantian_kode : [])]
    .filter(change => {
      const key = JSON.stringify([change.kode_asal, change.kode_baru, change.waktu]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  review.ekstraksi_kode_asli = old.ekstraksi_kode_asli || review.ekstraksi_kode_asli;
  await db.prepare('UPDATE claim_records SET ai_review = ? WHERE id = ?').run(JSON.stringify(review), recordId);
}

module.exports = { simpanAiReview };
