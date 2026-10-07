/**
 * Kalibrasi severity INA-CBG dari lembar grouper casemix (hasil E-Klaim resmi).
 *
 * Daftar CC resmi (cclist) menandai banyak kode sebagai CC, tetapi apakah CC itu
 * menaikkan severity bergantung pada kelompok dasar -- matriks per kelompok itu
 * ada di berkas grouper terenkripsi dan tidak dipakai. Akibatnya perkiraan
 * aplikasi bisa terlalu tinggi:
 *   SUPRIYATI  I63.9 + E11.9 -> E-Klaim G-4-14-I  (aplikasi G-4-14-II)
 *   SLAMET     D64.9 + K62.5 -> E-Klaim D-4-13-I  (aplikasi D-4-13-II, +Rp871.400)
 *
 * Setiap lembar grouper ber-severity I adalah bukti langsung dari E-Klaim bahwa
 * SEMUA diagnosis sekundernya tidak menaikkan severity untuk kelompok dasar itu.
 * Pasangan (kelompok dasar, kode sekunder) dikumpulkan di memori dari lembar
 * yang tersimpan di claim_records.ai_review.lembar_grouper (dimuat saat server
 * menyala, ditambah setiap berkas berlembar grouper selesai diproses).
 *
 * Hanya MENURUNKAN perkiraan, tidak pernah menaikkan. Ini kalibrasi perilaku
 * mesin grouper (fakta E-Klaim), bukan pilihan koding casemix.
 */
const norm = (k) => String(k || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const tidakMenaikkan = new Map(); // "D-4-13|K625" -> jumlah lembar

function dasar(kodeInacbg) {
  const m = /^([A-Z]-\d-\d+)-(I{1,3}|0)$/i.exec(String(kodeInacbg || '').trim());
  return m ? { dasar: m[1].toUpperCase(), severity: m[2].toUpperCase() } : null;
}

/** Catat pasangan dari satu lembar grouper. @returns {number} pasangan baru */
function catatDariLembar(lembar) {
  if (!lembar || !lembar.inacbg) return 0;
  const g = dasar(lembar.inacbg.kode);
  if (!g || g.severity !== 'I') return 0;
  let baru = 0;
  for (const d of lembar.diagnosis || []) {
    if (!d || !d.kode || d.peran === 'utama') continue;
    const kunci = `${g.dasar}|${norm(d.kode)}`;
    if (!tidakMenaikkan.has(kunci)) baru++;
    tidakMenaikkan.set(kunci, (tidakMenaikkan.get(kunci) || 0) + 1);
  }
  // Diagnosis sekunder yang tidak diberi peran: semua selain yang pertama.
  if (!(lembar.diagnosis || []).some(d => d && d.peran)) {
    for (const d of (lembar.diagnosis || []).slice(1)) {
      if (!d || !d.kode) continue;
      const kunci = `${g.dasar}|${norm(d.kode)}`;
      if (!tidakMenaikkan.has(kunci)) baru++;
      tidakMenaikkan.set(kunci, (tidakMenaikkan.get(kunci) || 0) + 1);
    }
  }
  return baru;
}

/** Apakah kode sekunder ini terbukti tidak menaikkan severity kelompok dasar ini. */
function terbuktiTidakMenaikkan(kelompokDasar, kodeSekunder) {
  return tidakMenaikkan.has(`${String(kelompokDasar).toUpperCase()}|${norm(kodeSekunder)}`);
}

/** Muat semua lembar grouper tersimpan. Tidak pernah melempar. */
async function muat(db) {
  try {
    const baris = await db.all(`SELECT ai_review::jsonb->'lembar_grouper' AS lembar FROM claim_records
      WHERE jsonb_typeof(ai_review::jsonb->'lembar_grouper') = 'object'`);
    let n = 0;
    for (const b of baris) {
      const lembar = typeof b.lembar === 'string' ? JSON.parse(b.lembar) : b.lembar;
      n += catatDariLembar(lembar);
    }
    return n;
  } catch (e) {
    console.warn('[KalibrasiSeverity] gagal memuat lembar grouper:', e.message);
    return 0;
  }
}

module.exports = { catatDariLembar, terbuktiTidakMenaikkan, muat, _peta: tidakMenaikkan };
