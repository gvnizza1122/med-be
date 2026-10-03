/**
 * Konvensi koding yang sudah ditetapkan RS -- satu sumber untuk semua lapisan
 * AI (penalaran diagnosis, pemeriksa kritis, agen). Kode bertanda [aturan RS]
 * berasal dari konvensi ini dan hanya dipersoalkan bila bukti berkas
 * BERTENTANGAN LANGSUNG, bukan sekadar karena dokumentasinya ringkas.
 */
const KONVENSI_KODING_RS = `KONVENSI KODING RS (sudah ditetapkan; jangan dipersoalkan kecuali bukti berkas BERTENTANGAN LANGSUNG):
- KPD: lama ketuban pecah > 24 jam = O42.1 (termasuk persalinan seksio); tidak perlu catatan mulai kontraksi.
- Persalinan: cara persalinan O80-O84 dan hasil persalinan Z37.- dikode sebagai sekunder; surat kelahiran/data bayi
  lahir = bukti Z37.0; SC tanpa keterangan jenis = 74.1.
- Tumor: kode menurut hasil PA dan letak jaringan klinis (resume "subfascia" = jaringan lunak D21.x); diagnosis banding
  PA tidak dikode terpisah.
- Penunjang darah (darah rutin, kimia, serologi) = 90.59.
- Prosedur yang dikode casemix RS: tindakan utama/operasi dan penunjang diagnostik (90.59 lab darah, 89.52 EKG,
  87.44 rontgen toraks, 75.32 CTG, dll). Tindakan rutin perawatan/terapi TIDAK dikode: injeksi/infus obat (99.21,
  99.22, 99.23, 99.24, 99.29), infus elektrolit (99.18), pemasangan IV cath (38.93), kateter urin (57.94), oksigen (93.96).
- Diagnosis yang dikode adalah diagnosis akhir dokter di resume; diagnosis masuk (SPRI/SEP/IGD) yang tidak ditulis ulang
  sebagai diagnosis akhir menjadi pertanyaan klarifikasi, bukan kode.`;

/**
 * Prosedur rutin yang TIDAK dikode casemix RS (dipelajari dari keputusan
 * casemix pada berkas berlembar grouper: KHOIRIYAH, YETY, ANNISA -- 99.21,
 * 99.23, 99.24, 99.29, 38.93, 57.94, 93.96 selalu dibuang casemix) ditambah
 * kerabat terdekatnya (99.18 infus elektrolit, 99.22 injeksi anti-infeksi lain).
 */
const PROSEDUR_RUTIN_TIDAK_DIKODE = new Set(['99.18', '99.21', '99.22', '99.23', '99.24', '99.29', '38.93', '57.94', '93.96']);
const ALASAN_PROSEDUR_RUTIN = 'Konvensi casemix RS: tindakan rutin perawatan/terapi (injeksi, infus, IV cath, kateter, oksigen) tidak dikode.';

const HALAMAN_HASIL_PENUNJANG = new Set(['lab_results', 'radiology', 'ekg']);
/**
 * Kode penunjang yang dibuktikan LEMBAR HASIL di berkas (lab -> 90.59, rontgen
 * -> 87.44, EKG -> 89.52, CTG -> 75.32) -- bukan sekadar disebut di resume/resep.
 * Satu sumber untuk pengisian PROCLIST dan kode final semua lapisan.
 */
function penunjangBerhasil(ai) {
  const { deskripsiProsedur } = require('./kamusKodeService');
  return [...new Set((Array.isArray(ai && ai.temuan_penunjang) ? ai.temuan_penunjang : [])
    .filter(t => t && t.kode_usulan && (HALAMAN_HASIL_PENUNJANG.has(t.jenis_halaman)
      || (String(t.kode_usulan) === '75.32' && t.jenis_halaman && !['resume_medis', 'triase_igd'].includes(t.jenis_halaman))))
    .map(t => String(t.kode_usulan).trim())
    .filter(k => deskripsiProsedur(k) && !PROSEDUR_RUTIN_TIDAK_DIKODE.has(k)))];
}

module.exports = { KONVENSI_KODING_RS, PROSEDUR_RUTIN_TIDAK_DIKODE, ALASAN_PROSEDUR_RUTIN, penunjangBerhasil };
