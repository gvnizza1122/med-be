/**
 * Tarif INA-CBG dan iDRG berdampingan untuk satu klaim, disusun saat dibaca
 * (tanpa AI, tanpa basis data) dari data klaim dan ai_review yang tersimpan.
 *
 * INA-CBG -- urutan sumber (yang pertama tersedia dipakai sebagai "resmi"):
 *   1. Lembar cetak E-Klaim di berkas (ai_review.lembar_grouper): hasil
 *      grouper Kemenkes, resmi.
 *   2. Kolom INACBG / TARIF_INACBG / TOTAL_TARIF data klaim (ekspor E-Klaim).
 *   Hitungan medaudit sendiri (inacbg_result / tariff_result) selalu
 *   ditampilkan TERPISAH sebagai pembanding, tidak pernah menggantikan 1-2.
 *
 * iDRG -- Tarif = Cost Weight (CW) x National Base Rate (NBR).
 *   Rumus terbukti pada contoh respons E-Klaim (koleksi Postman E-Klaim
 *   iDRG): total CW 7,1976662 x NBR 8.037.060 = Rp 57.848.075, sama dengan
 *   total_tarif keluaran grouper. NBR yang dipakai adalah angka rancangan
 *   Kemenkes (rawat inap Rp 8.037.060, rawat jalan Rp 461.474) dan bisa
 *   diubah lewat env IDRG_NBR_RANAP / IDRG_NBR_RAJAL begitu angka resmi terbit.
 *   Kode DRG dan CW HANYA dihasilkan grouper iDRG (di dalam E-Klaim); tabel
 *   CW belum dipublikasikan resmi. Tanpa keduanya tarif iDRG TIDAK ditebak --
 *   statusnya "belum_dapat_dihitung" dengan alasan yang jelas.
 */

const { konversiKeIdrg, SUMBER: SUMBER_KAMUS_IM } = require('./kamusIdrgService');

const NBR_DRAF = { RAWAT_INAP: 8037060, RAWAT_JALAN: 461474 };

function nbrIdrg(jenisKlaim) {
  const ranap = /INAP/i.test(String(jenisKlaim || ''));
  const env = Number(ranap ? process.env.IDRG_NBR_RANAP : process.env.IDRG_NBR_RAJAL);
  const nilai = Number.isFinite(env) && env > 0 ? env : (ranap ? NBR_DRAF.RAWAT_INAP : NBR_DRAF.RAWAT_JALAN);
  return {
    nilai,
    jenis: ranap ? 'rawat_inap' : 'rawat_jalan',
    status: Number.isFinite(env) && env > 0 ? 'dari_konfigurasi' : 'rancangan_kemenkes',
  };
}

/** Tarif iDRG = CW x NBR, dibulatkan ke rupiah. */
function hitungTarifIdrg(costWeight, jenisKlaim) {
  const cw = Number(costWeight);
  if (!Number.isFinite(cw) || cw <= 0) return null;
  const nbr = nbrIdrg(jenisKlaim);
  return { tarif: Math.round(cw * nbr.nilai), cost_weight: cw, nbr };
}

const angka = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function bagianInacbg(raw, ai) {
  const lembar = ai && ai.lembar_grouper;
  let resmi = null;
  if (lembar && lembar.inacbg && lembar.inacbg.kode) {
    resmi = {
      sumber: 'lembar_grouper_eklaim',
      kode: lembar.inacbg.kode,
      deskripsi: lembar.inacbg.deskripsi || null,
      tarif: lembar.total_tarif != null ? lembar.total_tarif : lembar.inacbg.tarif,
      versi_eklaim: lembar.versi_eklaim || null,
      halaman: lembar.halaman || null,
    };
  } else if (raw && raw.INACBG && String(raw.INACBG).trim() && String(raw.INACBG).trim() !== '-') {
    resmi = {
      sumber: 'data_klaim',
      kode: String(raw.INACBG).trim(),
      deskripsi: raw.DESKRIPSI_INACBG || null,
      tarif: angka(raw.TOTAL_TARIF) || angka(raw.TARIF_INACBG),
      versi_eklaim: raw.VERSI_INACBG || null,
      halaman: null,
    };
  }

  const hasil = ai && ai.inacbg_result;
  const tarifHitung = ai && ai.tariff_result;
  const hitungan = hasil && hasil.code ? {
    kode: hasil.code,
    deskripsi: hasil.description || null,
    tarif: tarifHitung && tarifHitung.amount != null ? Number(tarifHitung.amount) : null,
    catatan: (tarifHitung && tarifHitung.note) || null,
    sumber_tarif: (tarifHitung && tarifHitung.source) || null,
  } : null;

  return {
    resmi,
    hitungan_medaudit: hitungan,
    cocok: resmi && hitungan ? resmi.kode === hitungan.kode : null,
  };
}

function bagianIdrg(raw, ai, jenisKlaim) {
  const rumus = 'Tarif iDRG = Cost Weight (CW) x National Base Rate (NBR)';
  const nbr = nbrIdrg(jenisKlaim);
  // Lembar cetak iDRG dari E-Klaim (bila pembacanya sudah tersedia) -- resmi.
  const lembar = ai && ai.lembar_grouper_idrg;
  if (lembar && (lembar.total_tarif || lembar.cost_weight)) {
    const hitung = lembar.cost_weight ? hitungTarifIdrg(lembar.total_cost_weight || lembar.cost_weight, jenisKlaim) : null;
    return {
      status: 'tersedia',
      sumber: 'lembar_grouper_eklaim',
      drg: lembar.drg || null,
      deskripsi: lembar.drg_deskripsi || null,
      cost_weight: lembar.total_cost_weight || lembar.cost_weight || null,
      nbr,
      tarif: lembar.total_tarif || (hitung && hitung.tarif) || null,
      rumus,
    };
  }
  return {
    status: 'belum_dapat_dihitung',
    sumber: null,
    drg: null,
    deskripsi: null,
    cost_weight: null,
    nbr,
    tarif: null,
    rumus,
    alasan: 'Kode DRG dan cost weight hanya dihasilkan grouper iDRG Kemenkes (di aplikasi E-Klaim), dan tabel cost weight iDRG belum dipublikasikan resmi. Tarif iDRG akan terisi otomatis bila berkas memuat lembar hasil grouper iDRG dari E-Klaim.',
  };
}

/**
 * @param {object} record baris claim_records (raw_data boleh string)
 * @param {object} ai ai_review (sudah di-parse)
 */
function susunTarifGanda(record, ai) {
  let raw = record && record.raw_data;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = {}; } }
  raw = raw || {};
  const jenisKlaim = record.jenis_klaim || raw.JENIS_KLAIM || null;
  const diaglist = record.diagnosa_list || raw.DIAGLIST || '';
  const proclist = record.prosedur_list || raw.PROCLIST || '';

  return {
    jenis_klaim: jenisKlaim,
    inacbg: bagianInacbg(raw, ai || {}),
    idrg: bagianIdrg(raw, ai || {}, jenisKlaim),
    koding_idrg: { ...konversiKeIdrg(diaglist, proclist), sumber_kamus_im: SUMBER_KAMUS_IM },
  };
}

module.exports = { susunTarifGanda, hitungTarifIdrg, nbrIdrg, NBR_DRAF };
