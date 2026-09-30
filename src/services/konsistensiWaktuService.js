/**
 * Konsistensi waktu pada triase IGD.
 *
 * Ditemukan pada berkas 0170R0110926V001943: triase dimulai 21:54 tetapi
 * tertulis "selesai pukul 07:00" — sembilan jam kemudian. Triase adalah
 * penilaian awal yang berlangsung menit, paling lama beberapa jam; selisih
 * sepanjang itu hampir pasti salah tulis jam dan mudah dilihat verifikator.
 *
 * Deterministik, tanpa AI. Menghasilkan temuan berbentuk sama dengan
 * evaluasiKonsistensi() supaya bisa digabung ke `konsistensi_data`.
 *
 * BATAS YANG DIKETAHUI
 *   - BATAS_WAJAR_MENIT (6 jam) adalah ambang heuristik, bukan aturan resmi.
 *   - Pola "mulai"/"selesai" dirancang dari potongan teks yang dilaporkan,
 *     bukan dari PDF triase asli; format cetak sebenarnya perlu dicek.
 *   - Selisih dihitung melewati tengah malam (23:50 -> 00:10 = 20 menit).
 */

const { classifyPageDocumentType } = require('./pdfPageClassifier');

const BATAS_WAJAR_MENIT = 6 * 60;

const POLA_MULAI = /\b(?:mulai|datang|masuk|jam\s*triase|waktu\s*triase|jam\s*triage)\b\D{0,20}?(\d{1,2})[:.](\d{2})/i;
const POLA_SELESAI = /\bselesai\b(?:\s*(?:pukul|jam|pada))?\s*[:\-]?\s*(\d{1,2})[:.](\d{2})/i;

function menit(jam, mnt) {
  const j = Number(jam), m = Number(mnt);
  if (!(j >= 0 && j <= 23 && m >= 0 && m <= 59)) return null;
  return j * 60 + m;
}

/** Selisih menit dari mulai ke selesai, melewati tengah malam bila perlu. */
function selisihMenit(mulai, selesai) {
  return (selesai - mulai + 1440) % 1440;
}

/**
 * @param {Array<{page_number:number, ocr_text:string}>} halaman
 * @returns {Array} temuan (kosong bila waktu wajar atau tidak terbaca)
 */
function periksaWaktuTriase(halaman) {
  const temuan = [];
  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text || hal.text);
    if (!teks || classifyPageDocumentType(teks) !== 'triase_igd') continue;

    const m = POLA_MULAI.exec(teks);
    const s = POLA_SELESAI.exec(teks);
    if (!m || !s) continue;
    const mulai = menit(m[1], m[2]);
    const selesai = menit(s[1], s[2]);
    if (mulai === null || selesai === null) continue;

    const selisih = selisihMenit(mulai, selesai);
    if (selisih <= BATAS_WAJAR_MENIT) continue;

    const jam = Math.floor(selisih / 60), sisa = selisih % 60;
    temuan.push({
      id: 'KW-01',
      nama: 'Waktu triase tidak wajar',
      keparahan: 'sedang',
      pesan: `Triase tercatat mulai ${m[1].padStart(2, '0')}:${m[2]} dan selesai ${s[1].padStart(2, '0')}:${s[2]}, selisih ${jam} jam ${sisa} menit. Triase hanya berlangsung menit hingga beberapa jam; selisih sepanjang ini kemungkinan salah tulis jam dan mudah dipersoalkan verifikator.`,
      yang_ditemukan: { page_number: hal.page_number || null, kutipan: `${m[0].trim()} ... ${s[0].trim()}`.slice(0, 160) },
      yang_dicari: `Waktu selesai triase dalam ${BATAS_WAJAR_MENIT / 60} jam dari waktu mulai`,
      sumber_aturan: 'Ditemukan pada berkas 0170R0110926V001943: mulai 21:54, "selesai pukul 07:00". Ambang 6 jam adalah heuristik.',
      diverifikasi: true,
    });
  }
  return temuan;
}

module.exports = { periksaWaktuTriase, BATAS_WAJAR_MENIT, selisihMenit };
