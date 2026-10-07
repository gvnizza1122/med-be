/** Uji ulang grouper perkiraan dengan masukan referensi anonim, tanpa menyuapkan hasil casemix ke AI. */
const acuan = require('../../src/__tests__/fixtures/berkasAcuanKlinis.json');
const { hitungInacbgDanTarif } = require('../../src/services/aiReviewService');

function bandingkan() {
  return acuan.map(({ id, referensi: r }) => {
    const h = hitungInacbgDanTarif(r.dx, r.px, 'RAWAT_INAP', r.kelas, null);
    const kode = h.inacbgResult?.code ?? null;
    const tarif = h.tarifResult?.amount ?? null;
    return { kasus: id, masukan: { dx: r.dx, px: r.px, kelas: r.kelas },
      referensi: { kode: r.cbg, tarif: r.tarif }, perkiraan: { kode, tarif },
      cocok: kode === r.cbg && tarif === r.tarif,
      perlu_verifikasi_grouper: !!h.tarifResult?.perlu_verifikasi_grouper || kode !== r.cbg || tarif !== r.tarif,
      severity_status: h.inacbgResult?.severity_status ?? null,
      alasan_perkiraan: h.inacbgResult?.reasoning ?? null };
  });
}
if (require.main === module) process.stdout.write(JSON.stringify({
  tujuan: 'Pembanding pengembangan. Kecocokan pada delapan berkas tidak membuktikan kesetaraan dengan mesin grouper resmi.',
  hasil: bandingkan(),
}, null, 2) + '\n');
module.exports = { bandingkan };
