const { petakanKeKodeWho } = require('./kodeDiagnosisWhoService');

async function adaDiKamusWho(db, kode) {
  try {
    const rows = await db.all('SELECT code FROM icd10_who_codes WHERE UPPER(code) = ?', [kode]);
    return Array.isArray(rows) && rows.some(row => String(row.code).toUpperCase() === kode);
  } catch (err) {
    console.warn(`[PastikanWho] Kamus WHO tidak terbaca untuk ${kode}: ${err.message}`);
    return false;
  }
}

/** Pastikan setiap kode DIAGLIST ada di kamus WHO; kode tanpa padanan tetap ditandai. */
async function pastikanDiagnosisWho(db, diaglist, teksDiagnosis = '') {
  const kodeAsli = String(diaglist || '').split(/[;,]/).map(k => k.trim()).filter(Boolean);
  const hasil = [];
  const kodeLuarKamus = [];

  for (const nilai of kodeAsli) {
    const kode = nilai.toUpperCase();
    if (await adaDiKamusWho(db, kode)) {
      hasil.push(kode);
      continue;
    }

    let pemetaan = null;
    try {
      pemetaan = await petakanKeKodeWho(kode, teksDiagnosis);
    } catch (err) {
      console.warn(`[PastikanWho] Pemetaan ${kode} gagal: ${err.message}`);
    }
    if (pemetaan && pemetaan.kode && await adaDiKamusWho(db, String(pemetaan.kode).toUpperCase())) {
      hasil.push(String(pemetaan.kode).toUpperCase());
    } else {
      hasil.push(kode);
      kodeLuarKamus.push({
        kode,
        jenis: 'diagnosis',
        status: 'kode_luar_kamus',
        pesan: `Kode diagnosis "${kode}" tidak ada di ICD-10 WHO dan belum punya padanan pasti. BPJS hanya mengenal ICD-10 WHO, bukan ICD-10-CM.`,
      });
    }
  }

  return { diaglist: [...new Set(hasil)].join(';'), kodeLuarKamus };
}

module.exports = { pastikanDiagnosisWho };
