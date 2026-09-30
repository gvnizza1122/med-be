/**
 * Negasi temuan (kesalahan tipe 3: salah tafsir).
 *
 * Contoh nyata: "Rh -/-" (ronkhi negatif kiri-kanan) terbaca "ada ronkhi".
 * Temuan yang disangkal TIDAK PERNAH dibuang dan TIDAK PERNAH dibaca positif:
 * ia dipertahankan dengan `disangkal: true` supaya pemeriksa manusia tahu
 * berkas memang menyebutnya, dan menyebutnya tidak ada.
 *
 * Modul murni (tanpa DB, tanpa AI). Belum tersambung ke alur live; dipakai oleh
 * pagarTemuanService.saringTemuan dan dapat dipanggil dari mana pun.
 *
 * Aturan:
 *  - "-/-" atau "(-)" setelah istilah  => disangkal
 *  - "+/+", "(+)", "positif"           => positif
 *  - campuran "-/+"                    => tidak_jelas (bukan disangkal)
 *  - "tidak ada", "tdk ada", "tanpa", "disangkal", "negatif", "tidak ditemukan"
 *    => disangkal bila terletak pada klausa yang sama dengan istilah.
 * Klausa dibatasi koma, titik koma, titik, dan baris baru: "hipertensi (+),
 * DM (-)" menghasilkan hipertensi positif dan DM disangkal.
 */

const MINUS = '[-\\u2212\\u2013\\u2014]';
const PLUS = '\\+';

// ─ pola tanda ──────────────────────────────────────────────────────────────
const RE_MINUS_GANDA = new RegExp(`${MINUS}\\s*/\\s*${MINUS}`);
const RE_PLUS_GANDA = new RegExp(`${PLUS}\\s*/\\s*${PLUS}`);
const RE_CAMPUR = new RegExp(`(${MINUS}\\s*/\\s*${PLUS})|(${PLUS}\\s*/\\s*${MINUS})`);
const RE_MINUS_KURUNG = new RegExp(`\\(\\s*${MINUS}\\s*\\)`);
const RE_PLUS_KURUNG = new RegExp(`\\(\\s*${PLUS}\\s*\\)`);
const RE_KATA_NEGASI = /\b(tidak\s+ada|tdk\s+ada|tak\s+ada|tanpa|disangkal|menyangkal|negatif|negative|neg|tidak\s+ditemukan|tdk\s+ditemukan|denies|deny)\b/;
const RE_KATA_POSITIF = /\b(positif|positive|pos|ada)\b/;

/** Pisah teks menjadi klausa; kembalikan [{teks, mulai}]. */
function pecahKlausa(teks) {
  const hasil = [];
  const re = /[^,;.\n]+/g;
  let m;
  while ((m = re.exec(teks)) !== null) {
    if (m[0].trim()) hasil.push({ teks: m[0], mulai: m.index });
  }
  return hasil;
}

function nilaiKlausa(klausa) {
  const k = klausa.toLowerCase();
  const adaMinusGanda = RE_MINUS_GANDA.test(k);
  const adaPlusGanda = RE_PLUS_GANDA.test(k);
  if (RE_CAMPUR.test(k)) return { polaritas: 'tidak_jelas', penanda: (k.match(RE_CAMPUR) || [])[0] };
  if (adaMinusGanda && !adaPlusGanda) return { polaritas: 'negatif', penanda: (k.match(RE_MINUS_GANDA) || [])[0] };
  if (adaPlusGanda && !adaMinusGanda) return { polaritas: 'positif', penanda: (k.match(RE_PLUS_GANDA) || [])[0] };
  if (RE_MINUS_KURUNG.test(k) && !RE_PLUS_KURUNG.test(k)) return { polaritas: 'negatif', penanda: (k.match(RE_MINUS_KURUNG) || [])[0] };
  if (RE_PLUS_KURUNG.test(k) && !RE_MINUS_KURUNG.test(k)) return { polaritas: 'positif', penanda: (k.match(RE_PLUS_KURUNG) || [])[0] };
  const kata = k.match(RE_KATA_NEGASI);
  if (kata) return { polaritas: 'negatif', penanda: kata[0] };
  const pos = k.match(RE_KATA_POSITIF);
  if (pos) return { polaritas: 'positif', penanda: pos[0] };
  return { polaritas: 'tidak_jelas', penanda: null };
}

/**
 * Nilai polaritas sebuah temuan.
 *
 * @param {string} teks   teks sekitar (kutipan atau seluruh halaman)
 * @param {string} [istilah] istilah temuan; bila diberikan hanya klausa yang
 *   memuat istilah itu yang dinilai (bukan seluruh teks)
 * @returns {{disangkal: boolean, polaritas: 'negatif'|'positif'|'tidak_jelas', penanda: string|null}}
 */
function deteksiNegasi(teks, istilah) {
  const sumber = String(teks || '');
  if (!sumber.trim()) return { disangkal: false, polaritas: 'tidak_jelas', penanda: null };

  let klausa = pecahKlausa(sumber);
  if (istilah) {
    const kunci = String(istilah).toLowerCase().trim();
    const terpilih = klausa.filter(k => k.teks.toLowerCase().includes(kunci));
    if (terpilih.length === 0) return { disangkal: false, polaritas: 'tidak_jelas', penanda: null };
    klausa = terpilih;
  }
  // Bila istilah muncul di beberapa klausa dengan polaritas bertentangan,
  // yang positif menang: lebih baik memeriksa temuan yang keliru dianggap
  // ada daripada membuang temuan yang benar ada. Disangkal hanya bila SEMUA
  // klausa yang memuat istilah itu menyangkal.
  const nilai = klausa.map(k => nilaiKlausa(k.teks));
  const semuaNegatif = nilai.every(n => n.polaritas === 'negatif');
  const adaPositif = nilai.some(n => n.polaritas === 'positif');
  if (semuaNegatif) return { disangkal: true, polaritas: 'negatif', penanda: nilai[0].penanda };
  if (adaPositif) return { disangkal: false, polaritas: 'positif', penanda: nilai.find(n => n.polaritas === 'positif').penanda };
  return { disangkal: false, polaritas: 'tidak_jelas', penanda: null };
}

/**
 * Tandai satu temuan. Temuan tidak pernah dibuang. Bila disangkal, ia
 * membawa `disangkal: true` dan catatan supaya tidak dibaca positif.
 * Nilai `disangkal` yang sudah diisi pemanggil (mis. oleh model) dihormati
 * bila TRUE; bila FALSE tetapi teks jelas menyangkal, teks yang menang
 * (model boleh salah tafsir, itulah tipe 3).
 */
function tandaiNegasi(temuan) {
  const salinan = { ...temuan };
  const sumber = salinan.kutipan || salinan.teks || '';
  const teks = String(salinan.teks || '').trim();
  const istilah = salinan.istilah || (salinan.kutipan && teks && String(salinan.kutipan).toLowerCase().includes(teks.toLowerCase()) ? teks : null);
  const cek = deteksiNegasi(sumber, istilah);
  const disangkal = salinan.disangkal === true || cek.disangkal;
  salinan.disangkal = disangkal;
  salinan.polaritas = disangkal ? 'negatif' : cek.polaritas;
  if (disangkal) {
    salinan.perlu_cek_manusia = true;
    salinan.catatan_negasi = `Berkas menyangkal temuan ini${cek.penanda ? ` (penanda "${cek.penanda}")` : ''}; tidak boleh dibaca sebagai ada.`;
  }
  return salinan;
}

module.exports = { deteksiNegasi, tandaiNegasi, pecahKlausa };
