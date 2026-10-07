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
 *   Tampilan hasil berkas hanya memakai tarif, CW dan NBR dari berkas itu.
 *   NBR rancangan/configurasi hanya tersedia melalui helper simulasi terpisah.
 *   Aplikasi belum memiliki mesin iDRG atau tabel CW terverifikasi untuk
 *   menghitung kode dan tarif iDRG secara mandiri.
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
const desimal = v => {
  const s = String(v ?? '').trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return n > 0 ? n : null;
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
    alasan: hasil.reasoning || null,
    perlu_verifikasi_grouper: true,
    versi_perkiraan: hasil.versi_perkiraan || null,
  } : null;

  return {
    resmi,
    hitungan_medaudit: hitungan,
    // Perkiraan kasus berdiri sendiri; ketiadaan pembanding bukan ketiadaan
    // perhitungan aplikasi. Field lama dipertahankan untuk klien sebelumnya.
    perkiraan_klaim: hitungan ? {
      ...hitungan,
      status: hitungan.tarif == null ? 'tarif_belum_tersedia' : 'tersedia',
      label: 'Perkiraan klaim kasus ini',
      keterangan: hasil.severity_estimasi
        ? 'Tingkat keparahan I merupakan acuan sementara. Nilai ini belum merupakan hasil final grouper E-Klaim.'
        : 'Perkiraan berdasarkan diagnosis dan prosedur kasus ini; perlu verifikasi dengan hasil E-Klaim.',
    } : null,
    cocok: resmi && hitungan ? resmi.kode === hitungan.kode : null,
  };
}

function bagianIdrg(raw, ai, jenisKlaim) {
  const rumus = 'Tarif iDRG = Cost Weight (CW) x National Base Rate (NBR)';
  const nbr = { nilai: null, jenis: /INAP/i.test(String(jenisKlaim || '')) ? 'rawat_inap' : 'rawat_jalan', status: 'tidak_tersedia' };
  // Lembar cetak iDRG dari E-Klaim (bila pembacanya sudah tersedia) -- resmi.
  const lembar = ai && ai.lembar_grouper_idrg;
  if (lembar && (lembar.total_tarif || lembar.total_cost_weight || lembar.cost_weight)) {
    const cw = desimal(lembar.total_cost_weight || lembar.cost_weight);
    const nbrLembar = desimal(lembar.nbr?.nilai ?? lembar.nbr ?? lembar.national_base_rate);
    const tarifLembar = desimal(lembar.total_tarif);
    const tarif = tarifLembar || (cw && nbrLembar ? Math.round(cw * nbrLembar) : null);
    return {
      status: tarif ? 'tersedia' : 'belum_dapat_dihitung',
      sumber: 'lembar_grouper_eklaim',
      drg: lembar.drg || null,
      deskripsi: lembar.drg_deskripsi || null,
      cost_weight: cw,
      nbr: nbrLembar ? { ...nbr, nilai: nbrLembar, status: 'dari_lembar_eklaim' } : nbr,
      tarif, rumus,
      verifikasi_rumus: tarifLembar && cw && nbrLembar ? Math.round(cw * nbrLembar) === tarifLembar : null,
      ...(tarif ? {} : { alasan: 'Cost weight terbaca, tetapi tarif dan NBR dari hasil E-Klaim belum tersedia. NBR rancangan tidak dipakai untuk menetapkan tarif klaim.' }),
    };
  }
  // Ekspor MIX juga membawa hasil iDRG. Ini pembacaan hasil yang sudah ada,
  // bukan perhitungan kode iDRG oleh aplikasi, dan tidak memakai NBR rancangan.
  if (raw.IDRG_DRG_CODE && desimal(raw.IDRG_TOTAL_TARIF)) {
    const cw = desimal(raw.IDRG_TOTAL_COST_WEIGHT);
    const nbrEkspor = desimal(raw.IDRG_NBR);
    const tarif = desimal(raw.IDRG_TOTAL_TARIF);
    return { status: 'tersedia', sumber: 'data_klaim', drg: String(raw.IDRG_DRG_CODE).trim(),
      deskripsi: raw.IDRG_DRG_DESCRIPTION || null, cost_weight: cw,
      nbr: nbrEkspor ? { nilai: nbrEkspor, jenis: nbr.jenis, status: 'dari_ekspor_eklaim' } : { nilai: null, jenis: nbr.jenis, status: 'tidak_tersedia' },
      tarif, rumus, versi_grouper: raw.IDRG_GROUPER_VERSION || null,
      verifikasi_rumus: cw && nbrEkspor ? Math.round(cw * nbrEkspor) === tarif : null,
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
    alasan: 'Aplikasi belum memiliki mesin grouper iDRG atau tabel cost weight terverifikasi untuk menghitung kode dan tarif mandiri. Hasil iDRG dapat dibaca dari lembar atau ekspor E-Klaim bila tersedia.',
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
  // Selalu hitung pembanding INA-CBG dari kode masukan terkini, tidak menyalin
  // hasil casemix/AI lama. Tidak perlu mengulang OCR atau panggilan model.
  const review = { ...(ai || {}) };
  const final = require('./pemeriksaKritisService').kodeFinal({ ...record, diagnosa_list: diaglist, prosedur_list: proclist }, review);
  if (final.dx.length && ['RAWAT_INAP', 'RAWAT_JALAN'].includes(jenisKlaim)) {
    const h = require('./aiReviewService').hitungInacbgDanTarif(final.dx, final.px, jenisKlaim,
      require('./kelasPerawatanService').kelasTarif(record), null);
    review.inacbg_result = h.inacbgResult;
    review.tariff_result = h.tarifResult;
  }

  return {
    jenis_klaim: jenisKlaim,
    inacbg: bagianInacbg(raw, review),
    idrg: bagianIdrg(raw, ai || {}, jenisKlaim),
    koding_idrg: { ...konversiKeIdrg(diaglist, proclist), sumber_kamus_im: SUMBER_KAMUS_IM },
  };
}

module.exports = { susunTarifGanda, hitungTarifIdrg, nbrIdrg, NBR_DRAF };
