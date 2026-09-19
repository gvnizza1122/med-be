/**
 * Agregasi Kriteria Kegawatdaruratan (Tabel 3) -- MURNI kode deterministik,
 * TIDAK ada panggilan AI di sini. K2-K5 dihitung dari hasil ekstraksi
 * (parameter_findings/Tabel 1 + vital_findings/Tabel 2, dan PROCLIST untuk
 * K5) menurut aturan Tabel 3 yang sudah disepakati. K1 SENGAJA tidak
 * dihitung di sini -- itu tetap keputusan AI (self-harm/risk keyword di
 * anamnesis adalah pemahaman bahasa, bukan lookup angka), dibawa apa adanya
 * dari hasil ekstraksi.
 *
 * Keputusan 10-11 Sep 2026: memindahkan K2-K5 dari "AI menilai gawat/tidak"
 * ke "AI ekstrak angka mentah, kode yang menentukan band" -- selain lebih
 * murah (extraction < judgment dalam token & risiko halusinasi), juga bikin
 * hasilnya 100% konsisten untuk nilai yang sama (tidak tergantung mood model).
 */
const { lookupBand, K5_WHITELIST_CODES } = require('./kegawatdaruratanReference');
const { freetextPromotesToYa, getEsiSignalThreshold } = require('./procedureRulesService');

const KRITERIA_LABELS = {
  K1: 'Mengancam nyawa / membahayakan diri, orang lain, atau lingkungan',
  K2: 'Gangguan jalan napas, pernapasan, dan/atau sirkulasi',
  K3: 'Penurunan kesadaran',
  K4: 'Gangguan hemodinamik',
  K5: 'Memerlukan tindakan/intervensi segera',
};

function findParam(parameterFindings, key) {
  return parameterFindings.find(p => p.key === key) || null;
}

function paramEvidence(p) {
  return { sumber: 'parameter_findings', key: p.key, label: p.label, nilai: p.nilai, kutipan: p.kutipan, page_number: p.page_number };
}

function vitalEvidence(key, vf) {
  return { sumber: 'vital_findings', key, nilai: vf.nilai, band: vf.band, kutipan: vf.kutipan, page_number: vf.page_number };
}

/**
 * @param {Array} parameterFindings - hasil ekstraksi Tabel 1, tiap entri
 *   {key, label, nilai, status:'normal'|'abnormal'|null, page_number, kutipan}
 * @param {Object} vitalFindings - hasil ekstraksi Tabel 2, keyed by
 *   parameter (RR/SpO2/HR/TD_sistolik/Suhu/GCS/Nyeri), tiap value
 *   {nilai, band, page_number, kutipan} (band sudah dihitung lookupBand)
 * @param {Object} k1Result - hasil AI untuk K1: {status:'ya'|'tidak', kutipan, page_number, catatan}
 * @param {Array<string>} procedureCodes - PROCLIST record ini, sudah di-split/trim
 * @param {Array} [tindakanSegera] - tindakan keperawatan segera dari TEKS BEBAS
 *   (bukan kode PROCLIST resmi), hasil procedureRulesService.matchTindakanSegera()
 *   -- {id, label, page_number, kutipan}[]. Ditambah 19 Sep 2026 (fix item 5):
 *   PROCLIST cuma berisi kode ICD-9-CM final e-Klaim, TIDAK PERNAH mencatat
 *   tindakan keperawatan segera (mis. "IVFD asering loading") yang dicatat di
 *   Triase IGD/CPPT sebagai teks naratif, bukan kode.
 * @param {Object} [esi] - skor ESI (Emergency Severity Index) dari Triase IGD,
 *   {skor, page_number, kutipan} -- SINYAL PENDUKUNG saja, TIDAK menentukan
 *   status K5 otomatis (lihat esi_signal_threshold di procedure_rules.json).
 * @returns {Array} 5 entri kriteria K1-K5, format seragam
 */
function aggregateKriteria(parameterFindings, vitalFindings, k1Result, procedureCodes, tindakanSegera = [], esi = null) {
  const out = [];

  // K1 -- dibawa dari hasil AI apa adanya (bahasa, bukan lookup).
  out.push({
    kriteria: 'K1', label: KRITERIA_LABELS.K1,
    status: k1Result?.status === 'ya' ? 'ya' : 'tidak',
    evidence: k1Result?.kutipan ? [{ sumber: 'ai_k1', kutipan: k1Result.kutipan, page_number: k1Result.page_number || null }] : [],
    catatan: k1Result?.catatan || '',
  });

  // K2 -- Tabel 1 (ronkhi, wheezing, sdv, retraksi, sianosis, akral, crt) + Tabel 2 (RR, SpO2)
  {
    const paramKeys = ['ronkhi', 'wheezing', 'sdv', 'retraksi', 'sianosis', 'akral', 'crt'];
    const evidence = [];
    let hasGawat = false, hasBorderline = false;
    for (const key of paramKeys) {
      const p = findParam(parameterFindings, key);
      if (p && p.status === 'abnormal') { hasGawat = true; evidence.push(paramEvidence(p)); }
    }
    for (const vk of ['RR', 'SpO2']) {
      const vf = vitalFindings[vk];
      if (!vf || !vf.band) continue;
      if (vf.band === 'gawat') { hasGawat = true; evidence.push(vitalEvidence(vk, vf)); }
      else if (vf.band === 'borderline') { hasBorderline = true; evidence.push(vitalEvidence(vk, vf)); }
    }
    const status = hasGawat ? 'ya' : hasBorderline ? 'borderline' : 'tidak';
    out.push({ kriteria: 'K2', label: KRITERIA_LABELS.K2, status, evidence, catatan: buildCatatanK2K4(paramKeys, ['RR', 'SpO2'], parameterFindings, vitalFindings, evidence, status) });
  }

  // K3 -- Tabel 1 (kesadaran_kualitatif) + Tabel 2 (GCS)
  {
    const evidence = [];
    let status = 'tidak';
    const kesadaran = findParam(parameterFindings, 'kesadaran_kualitatif');
    const gcs = vitalFindings.GCS;
    const gcsAbnormal = gcs && Number.isFinite(Number(gcs.nilai)) && Number(gcs.nilai) <= 12;
    const kesadaranAbnormal = kesadaran && kesadaran.status === 'abnormal';
    if (gcsAbnormal || kesadaranAbnormal) {
      status = 'ya';
      if (gcs && gcsAbnormal) evidence.push(vitalEvidence('GCS', gcs));
      if (kesadaran && kesadaranAbnormal) evidence.push(paramEvidence(kesadaran));
    } else if (gcs && gcs.band === 'borderline') {
      status = 'borderline';
      evidence.push(vitalEvidence('GCS', gcs));
    }
    out.push({ kriteria: 'K3', label: KRITERIA_LABELS.K3, status, evidence, catatan: buildCatatanK3(gcs, kesadaran, status) });
  }

  // K4 -- Tabel 2 (HR, TD_sistolik, TD_diastolik) primer + Tabel 1 (akral, edema) konteks kardiak.
  // TD_diastolik ditambah 14 Sep 2026, diperlakukan SAMA/independen spt TD_sistolik
  // (bisa memicu gawat/borderline sendiri, TIDAK disyaratkan bergerak bareng sistolik)
  // -- keputusan eksplisit pengguna: output Kegawatdaruratan ini murni advisory (tidak
  // menyentuh validation_status), risiko over-flag rendah, dan diastolik ekstrem memang
  // relevan klinis utk hemodinamik (krisis hipertensi/perfusi buruk) sama spt sistolik.
  {
    const evidence = [];
    let hasGawat = false, hasBorderline = false;
    for (const vk of ['HR', 'TD_sistolik', 'TD_diastolik']) {
      const vf = vitalFindings[vk];
      if (!vf || !vf.band) continue;
      if (vf.band === 'gawat') { hasGawat = true; evidence.push(vitalEvidence(vk, vf)); }
      else if (vf.band === 'borderline') { hasBorderline = true; evidence.push(vitalEvidence(vk, vf)); }
    }
    // Akral/edema abnormal = konteks tambahan, BUKAN pemicu utama (sesuai Tabel 3:
    // "Tabel 1 (akral, edema pada konteks kardiak)" muncul setelah HR/TD sbg sumber primer).
    for (const key of ['akral', 'edema']) {
      const p = findParam(parameterFindings, key);
      if (p && p.status === 'abnormal') evidence.push(paramEvidence(p));
    }
    const status = hasGawat ? 'ya' : hasBorderline ? 'borderline' : 'tidak';
    out.push({ kriteria: 'K4', label: KRITERIA_LABELS.K4, status, evidence, catatan: buildCatatanK2K4(['akral', 'edema'], ['HR', 'TD_sistolik', 'TD_diastolik'], parameterFindings, vitalFindings, evidence, status) });
  }

  // K5 -- diperluas 19 Sep 2026 (fix item 5): SEBELUMNYA murni cek PROCLIST
  // vs whitelist kode (TIDAK ADA komponen AI). Sekarang TETAP deterministik
  // (tidak ada AI judgment di sini), tapi ditambah 2 sumber: (a) tindakan
  // segera dari TEKS BEBAS Triase IGD/CPPT (procedureRulesService,
  // matchTindakanSegera -- dipanggil oleh pemanggil, hasilnya dioper lewat
  // parameter tindakanSegera), (b) skor ESI sebagai SINYAL (tidak menentukan
  // status). 3 hasil: YA (kode PROCLIST resmi ditemukan -- SAMA seperti
  // perilaku lama, tidak berubah), BORDERLINE (HANYA tindakan teks bebas yang
  // ditemukan, kode PROCLIST kosong -- default rules, bisa diubah ke YA lewat
  // procedure_rules.json), TIDAK (keduanya kosong).
  {
    const matchedCodes = (procedureCodes || []).filter(code => K5_WHITELIST_CODES[code]);
    const freetextMatches = Array.isArray(tindakanSegera) ? tindakanSegera : [];
    let status;
    if (matchedCodes.length > 0) status = 'ya';
    else if (freetextMatches.length > 0) status = freetextPromotesToYa() ? 'ya' : 'borderline';
    else status = 'tidak';

    const evidence = [
      ...matchedCodes.map(code => ({ sumber: 'proclist', kode: code, deskripsi: K5_WHITELIST_CODES[code] })),
      ...freetextMatches.map(t => ({ sumber: 'tindakan_segera', id: t.id, label: t.label, kutipan: t.kutipan, page_number: t.page_number })),
    ];
    let esiSignal = false;
    if (esi && Number.isFinite(Number(esi.skor))) {
      esiSignal = Number(esi.skor) <= getEsiSignalThreshold();
      evidence.push({ sumber: 'esi', skor: esi.skor, kutipan: esi.kutipan, page_number: esi.page_number, signal: esiSignal });
    }

    const catatanParts = [];
    if (matchedCodes.length > 0) {
      catatanParts.push(`Kode tindakan darurat terdeteksi di PROCLIST: ${matchedCodes.map(c => `${c} (${K5_WHITELIST_CODES[c]})`).join(', ')}.`);
    }
    if (freetextMatches.length > 0) {
      catatanParts.push(`Tindakan segera tercatat di dokumentasi (teks bebas, bukan kode PROCLIST resmi): ${freetextMatches.map(f => `${f.label} ("${f.kutipan}")`).join('; ')}.`);
    }
    if (matchedCodes.length === 0 && freetextMatches.length === 0) {
      catatanParts.push('Tidak ada kode tindakan darurat (RJP/DC shock/intubasi/infus/oksigenasi) di PROCLIST, maupun pola tindakan segera di dokumentasi.');
    }
    if (status === 'borderline') {
      catatanParts.push('Status BORDERLINE: tindakan segera hanya ditemukan dari teks bebas (bukan kode resmi PROCLIST) -- verifikator wajib cek manual; aturan default bisa diubah jadi YA otomatis lewat procedure_rules.json kalau dinilai cukup andal.');
    }
    if (esi && Number.isFinite(Number(esi.skor))) {
      catatanParts.push(`Skor ESI tercatat: ${esi.skor} (sinyal pendukung${esiSignal ? ', konsisten dengan kegawatan' : ''} -- tidak menentukan status K5 secara otomatis).`);
    }

    out.push({ kriteria: 'K5', label: KRITERIA_LABELS.K5, status, evidence, catatan: catatanParts.join(' ') });
  }

  return out;
}

/**
 * Ditambah 17 Sep 2026 (permintaan klien): status 'tidak' SEBELUMNYA selalu
 * mengembalikan satu kalimat template yang SAMA PERSIS di semua klaim
 * ("Tidak ditemukan parameter abnormal/gawat yang relevan.") -- terlihat
 * seperti boilerplate walau technically benar. Sekarang kalau ada data yang
 * memang tercatat normal untuk kriteria ini (parameterFindings.status==='normal'
 * / vitalFindings.band==='normal'), sebutkan APA yang tercatat normal itu --
 * jadi catatannya benar2 berbeda per pasien (tergantung parameter mana yang
 * terdokumentasi di formulir masing-masing), bukan lagi satu kalimat generik.
 * Kalau memang TIDAK ADA data sama sekali yang tercatat (bukan cuma "normal",
 * tapi genuinely tidak terdokumentasi di formulir), baru pakai kalimat fallback
 * -- itu tetap jujur (tidak ada yang bisa disebut spesifik) drpd mengarang.
 */
function buildCatatanK2K4(paramKeys, vitalKeys, parameterFindings, vitalFindings, evidence, status) {
  if (status === 'tidak') {
    const normalParts = [];
    for (const key of paramKeys) {
      const p = findParam(parameterFindings, key);
      if (p && p.status === 'normal') normalParts.push(`${p.label}: normal${p.nilai ? ` (${p.nilai})` : ''}`);
    }
    for (const vk of vitalKeys) {
      const vf = vitalFindings[vk];
      if (vf && vf.band === 'normal' && vf.nilai !== null && vf.nilai !== undefined) normalParts.push(`${vk}=${vf.nilai} (normal)`);
    }
    if (normalParts.length === 0) return 'Tidak ditemukan parameter abnormal/gawat yang relevan -- tidak ada data pembanding yang tercatat di formulir untuk kriteria ini.';
    return `Tercatat normal: ${normalParts.join(', ')}.`;
  }
  const parts = evidence.map(e => {
    if (e.sumber === 'vital_findings') return `${e.key}=${e.nilai} (${e.band})`;
    return `${e.label || e.key}: ${e.nilai || 'abnormal'}`;
  });
  if (status === 'borderline') {
    return `Status BORDERLINE: Ditemukan parameter di ambang batas (borderline) pada: ${parts.join(', ')}. Verifikator wajib mengevaluasi secara klinis apakah kondisi ini merupakan gawat atau tidak berdasarkan konteks klinis pasien.`;
  }
  return `${status === 'ya' ? 'Ditemukan' : 'Ada indikasi borderline pada'}: ${parts.join(', ')}.`;
}

function buildCatatanK3(gcs, kesadaran, status) {
  const parts = [];
  if (gcs && Number.isFinite(Number(gcs.nilai))) parts.push(`GCS ${gcs.nilai}`);
  if (kesadaran && kesadaran.nilai) parts.push(`kesadaran: ${kesadaran.nilai}`);
  if (parts.length === 0) return status === 'tidak' ? 'Data GCS/kesadaran tidak tercatat di formulir.' : '';
  const partsSummary = parts.join(', ') + '.';
  if (status === 'borderline') {
    return `Status BORDERLINE: ${partsSummary} Penurunan kesadaran di ambang batas -- verifikator wajib mengevaluasi klinis apakah pasien benar-benar mengalami penurunan kesadaran yang signifikan.`;
  }
  return partsSummary;
}

module.exports = { aggregateKriteria, KRITERIA_LABELS };
