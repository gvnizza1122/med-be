/**
 * Fakta klinis terstruktur dari berkas -- bahan penalaran diagnosis.
 *
 * Urutan berpikir dokter/casemix: anamnesis (keluhan, riwayat) -> pemeriksaan
 * fisik & tanda vital -> penunjang -> tindakan & terapi -> baru diagnosis.
 * Modul ini menyusun fakta per kategori, masing-masing dengan halaman dan
 * kutipan sumbernya, TANPA AI. Format resume yang dikenali: resume rawat
 * inap ("Alasan Masuk", "Ringkasan Penemuan Fisik", "Diagnosis Utama"),
 * resume IGD/poli SOAP ("S Keluhan", "O Pemeriksaan Fisik", "A Diagnosa",
 * "P Tindakan"), dan triase ("Keluhan :", "Riwayat Penyakit :").
 */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { susunPemeriksaanPenunjang } = require('./pemeriksaanPenunjangService');

// Label bagian -> kategori fakta. Urutan penting (lebih spesifik dulu).
const LABEL = [
  ['diagnosis_utama', /^\s*diagnos[ai]s?\s+utama\b/i],
  ['diagnosis_sekunder', /^\s*diagnos[ai]s?\s+sekunder\b/i],
  ['diagnosis_dokter', /^\s*A\s+diagnos[ai]\b|^\s*diagnos[ai]\s+(?:akhir|kerja|klinis)\b|^\s*Obs\b|^\s*assessment\b/i],
  ['keluhan', /^\s*alasan\s+masuk(?:\s+rawat\s+inap)?\b|^\s*keluhan(?:\s+utama)?\s*(?::|$)|^\s*S\s+keluhan\b|^\s*anamne(?:sa|sis)\b|^\s*riwayat\s+penyakit\s+sekarang\b/i],
  ['riwayat', /^\s*riwayat\s+penyakit(?:\s+dahulu)?\s*:?|^\s*RPD\b/i],
  ['fisik', /^\s*ringkasan\s+penemuan\s+fisik(?:\s+penting)?|^\s*O\s+pemeriksaan\b|^\s*pemeriksaan\s+fisik\b|^\s*status\s+lokalis\b/i],
  ['penunjang', /^\s*pemeriksaan\s+penunjang\b|^\s*penunjang\s+lain\b|^\s*hasil\s+konsultasi\b/i],
  ['tindakan', /^\s*tindakan\s*\/?\s*prosedur\b|^\s*P\s+tindakan\b|^\s*tindakan\s*:/i],
  ['terapi', /^\s*terapi\s*\/?\s*pengobatan(?:\s+selama\s+di\s+rumah\s+sakit)?|^\s*terapi\s+(?:selama\s+di\s+rumah\s+sakit|pulang)\b|^\s*terapi\s*:|^\s*P\s+terapi\b/i],
];
// Akhir bagian tanpa kategori (isi administratif).
// Termasuk blok tanda tangan/pengesahan dan header tabel obat pulang.
const BERHENTI = /^\s*(?:no\s+obat\s+aturan|rs\s+.*menyatakan\s+dokumen|ditandatangani|tanggal\s*:|pengkajian\s+selesai|perawat\s*\/\s*bidan|reaksi\s+obat|diet\b|instruksi|keadaan\s+keluar|cara\s+keluar|pengobatan\s+dilanjutkan|tgl\s+kontrol|kontrol\s+di|alergi|skala\s+nyeri|identifikasi|kebutuhan\s+pasien|permintaan\s+obat|skor\s+esi|vital\s+sign|rencana\b|anjuran\b|kelanjutan|magelang,|powered\s+by|dokter\s+penanggung|pasien\s*\/\s*keluarga|diagnosis\s+keperawatan|psikososial|primary\s+survey|inventaris\s+medis|tiba\s+di\s+ruangan|tindakan\s+medis\s+yang|terpasang\s+infus)/i;

// Kelompok obat -> petunjuk kondisi yang ditangani (bukan diagnosis).
const KELAS_OBAT = [
  ['antibiotik', /ceftriax|cefotax|ceftazid|cefazol|cefurox|cefix|cefadrox|amoxi|ampicil|ampisil|gentami|metronid|levoflox|ciproflox|meropen|azithro|cotrimox|clinda|vancomy|anbacyn|sulbactam/i, 'infeksi'],
  ['transfusi', /\bprc\b|transfusi|whole\s+blood|\bwb\b|trombosit\s+konsentrat|\btc\b|\bffp\b/i, 'anemia/perdarahan'],
  ['diuretik', /furosemid|diutensi|lasix|spironol/i, 'kelebihan cairan/edema/gagal jantung'],
  ['oksigen', /\bo2\b|oksigen|nasal\s+kanul|selang\s+o2|\bnrm\b/i, 'gangguan oksigenasi'],
  ['bronkodilator', /nebul|salbutamol|ventolin|ventasal|combivent|ipratrop|aminofil|budesonid|pulmicort/i, 'obstruksi jalan napas'],
  ['insulin_antidiabetes', /insulin|novorapid|lantus|levemir|metformin|glimepir|glibenk/i, 'gangguan gula darah'],
  ['antihipertensi', /amlodip|nifedip|captopril|candesar|valsar|lisinop|bisoprol|nitrokaf|isosorbid|nicardip/i, 'hipertensi/kardiovaskular'],
  ['kortikosteroid', /dexameth|metilpred|methylpred|hidrokort|hydrocort|prednis/i, 'inflamasi/alergi/obstruksi'],
  ['uterotonika', /oxytocin|oksitosin|methylergo|metilergo|misoprost/i, 'persalinan/perdarahan pascasalin'],
  ['antikoagulan', /heparin|enoxapar|lovenox|warfarin|clopidog|aspilet|aspirin/i, 'trombosis/kardiovaskular'],
  ['antikonvulsan', /phenytoin|fenitoin|diazepam|valpro|levetirac|carbamaz/i, 'kejang'],
  ['mukolitik_antitusif', /erdost|ambroxol|ambroksol|bromhex|acetylcyst|asetilsis|guaifen|gliseril|\bobh\b|codein|kodein|dextrometor|dekstrometor/i, 'batuk/gangguan saluran napas'],
  ['penekan_asam_lambung', /omeprazol|lansopraz|pantopraz|esomepraz|ranitid|famotid|sucralf|sukralf|antasid|rebamip/i, 'gangguan lambung/dispepsia'],
  ['antiemetik', /ondans|ondanc|domperid|metoclop|metoklop/i, 'mual/muntah'],
  ['cairan_infus', /asering|ringer|\brl\b|nacl\s*0[.,]9|\bns\b|kaen|dextrose|dekstrosa|loading\s+\d+\s*cc/i, 'kebutuhan cairan/dehidrasi'],
  ['analgesik', /ketorolac|tramadol|paracetamol|parasetamol|metamizol|fentanyl|morfin|pethidin|patracet/i, 'nyeri'],
];

function kelasObat(teks) {
  const k = KELAS_OBAT.find(([, pola]) => pola.test(teks));
  return k ? { kelas: k[0], petunjuk: k[2] } : null;
}

/** Fakta dari halaman resume/triase/SPRI berdasarkan label bagian. */
function faktaDariHalaman(p) {
  const hasil = [];
  const baris = String(p.ocr_text || '').split(/\r?\n/);
  let aktif = null;
  for (const mentah of baris) {
    const b = mentah.trim();
    if (!b) continue;
    const label = LABEL.find(([, pola]) => pola.test(b));
    if (label) {
      aktif = label[0];
      const isi = b.replace(label[1], '').replace(/^[\s:.-]+/, '').trim();
      if (isi && !/^[-.\s]*$/.test(isi)) hasil.push({ kategori: aktif, teks: isi, halaman: p.page_number, kutipan: b.slice(0, 200) });
      continue;
    }
    if (BERHENTI.test(b)) { aktif = null; continue; }
    if (!aktif) continue;
    // Daftar pilihan cetak ("• Asma • DM • HIV/AIDS") pada formulir bukan isian
    // pasien -- tanpa tanda centang yang terbaca, tidak dianggap fakta.
    if (/^[•●○□■▪\-–]\s*\S/.test(b) && aktif === 'riwayat') continue;
    const isi = b.replace(/^\(?\d+[.)]\s*/, '').replace(/^:\s*/, '').trim();
    if (!isi || /^[-.\s]*$/.test(isi)) continue;
    hasil.push({ kategori: aktif, teks: isi, halaman: p.page_number, kutipan: b.slice(0, 200) });
  }
  return hasil;
}

/**
 * @param {Array} pages halaman berkas [{page_number, ocr_text}]
 * @param {object} ai ai_review (opsional: vital_findings, parameter_findings, temuan_tindakan)
 * @returns {{fakta: Array, per_kategori: object}}
 */
function susunFaktaKlinis(pages, ai = {}) {
  const halaman = (pages || []).filter(p => p && String(p.ocr_text || '').trim());
  const fakta = [];
  const tambah = f => {
    if (!f || !f.teks) return;
    if (fakta.some(x => x.kategori === f.kategori && x.teks === f.teks && x.halaman === f.halaman)) return;
    fakta.push(f);
  };

  for (const p of halaman) {
    const jenis = classifyPageDocumentType(p.ocr_text || '');
    if (jenis === 'resume_medis' || jenis === 'triase_igd') faktaDariHalaman(p).forEach(tambah);
    // Formulir serah terima/pindah ruang memuat anamnesis & tindakan IGD
    // ("Alasan Masuk Rawat Inap : Demam 7 hari ... batuk +").
    else if (/alasan\s+masuk\s+rawat\s+inap\s*:/i.test(p.ocr_text || '')) faktaDariHalaman(p).forEach(tambah);
    if (jenis === 'spri') {
      for (const b of String(p.ocr_text).split(/\r?\n/)) {
        const m = /^\s*(diagnosa|indikasi\s+rawat\s+inap)\s*:\s*(.+)$/i.exec(b);
        if (m && m[2].trim()) tambah({ kategori: m[1].toLowerCase().startsWith('diag') ? 'diagnosis_awal' : 'keluhan', teks: m[2].trim(), halaman: p.page_number, kutipan: b.trim().slice(0, 200) });
      }
    }
    if (jenis === 'sep') {
      const b = String(p.ocr_text).split(/\r?\n/).find(x => /diagnosa\s+awal/i.test(x));
      if (b) tambah({ kategori: 'diagnosis_awal', teks: b.replace(/.*diagnosa\s+awal\s*:?\s*/i, '').trim(), halaman: p.page_number, kutipan: b.trim().slice(0, 200) });
    }
    // Hasil persalinan: surat kelahiran / assesmen neonatus (bukti Z37).
    if (/telah\s+lahir|surat\s+(?:keterangan\s+)?kelahiran|asses?men\s+awal\s+neonatus|data\s+bayi\s+baru\s+lahir/i.test(p.ocr_text || '')) {
      for (const b of String(p.ocr_text).split(/\r?\n/)) {
        if (/telah\s+lahir|tanggal\s*:|jam\s*:|jenis\s+kelamin\s*:|berat\s+(?:badan|lahir)\s*:?\s*\d|panjang\s+(?:badan|lahir)|kelahiran\s+dengan\s+cara|apgar|lahir\s+hidup|anak\s+ke/i.test(b)) {
          tambah({ kategori: 'tindakan', teks: `Hasil persalinan: ${b.trim().slice(0, 160)}`, halaman: p.page_number, kutipan: b.trim().slice(0, 200), sumber: 'kelahiran' });
        }
      }
    }
    if (jenis === 'radiology' || jenis === 'ekg') {
      for (const b of String(p.ocr_text).split(/\r?\n/)) {
        if (/\b(?:kesan|kesimpulan|impression|conclusion|interpretasi|sinus|cardiomegal|kardiomegal|infiltrat|efusi|fraktur|normal\s+ecg|abnormal\s+ecg)\b/i.test(b)) {
          tambah({ kategori: 'penunjang', teks: b.trim().slice(0, 200), halaman: p.page_number, kutipan: b.trim().slice(0, 200), sumber: jenis });
        }
      }
    }
  }

  // "Gram sputum dilakukan" kehilangan isi hasil yang penting. Sertakan
  // laporan aslinya, termasuk Gram negatif/positif dan temuan (+)/(-), tanpa
  // mengubahnya menjadi spesies kuman atau diagnosis baru.
  for (const gram of require('./pemeriksaanSputumService').bacaGramSputum(halaman)) {
    tambah({ kategori: 'penunjang', teks: gram.kutipan, kutipan: gram.kutipan,
      halaman: gram.page_number, sumber: 'gram_sputum' });
  }

  // Diagnosis akhir dan tindakan singkat cukup sebagai dokumentasi awal.
  for (const d of require('./dasarDiagnosisService').bacaDiagnosisAkhir(halaman))
    tambah({kategori:d.peran==='utama'?'diagnosis_utama':'diagnosis_sekunder',teks:d.kutipan,kutipan:d.kutipan,halaman:d.page_number});
  for (const e of require('./buktiResusitasiService').cariBuktiResusitasi(require('./referensiKlaimService').halamanKlinis(halaman)).bukti)
    tambah({kategori:'tindakan',teks:e.kutipan,kutipan:e.kutipan,halaman:e.page_number,sumber:'resusitasi_cairan'});

  // Tanda vital terukur.
  const vf = ai.kegawatdaruratan_assessment && ai.kegawatdaruratan_assessment.vital_findings;
  for (const [k, v] of Object.entries(vf || {})) {
    if (v && v.nilai != null && v.nilai !== '') tambah({ kategori: 'tanda_vital', teks: `${k} ${v.nilai}${v.band && v.band !== 'normal' ? ` (${v.band})` : ''}`, halaman: v.page_number || null, kutipan: v.kutipan || null });
  }
  // Pemeriksaan fisik terstruktur (parameter yang tercatat).
  for (const pf of (ai.kegawatdaruratan_assessment && ai.kegawatdaruratan_assessment.parameter_findings) || []) {
    if (pf && pf.ditemukan && pf.nilai) tambah({ kategori: 'fisik', teks: `${pf.label}: ${pf.nilai}${pf.status === 'abnormal' ? ' (abnormal)' : ''}`, halaman: pf.page_number || null, kutipan: pf.kutipan || null });
  }
  // Penunjang: hasil lab di luar rujukan + kesimpulan PA.
  try {
    const pj = susunPemeriksaanPenunjang(halaman);
    for (const h of pj.laboratorium) {
      for (const k of h.kelompok) for (const b of k.baris) {
        if (b.status === 'tinggi' || b.status === 'rendah') tambah({ kategori: 'penunjang', teks: `${b.parameter} ${b.hasil}${b.satuan ? ` ${b.satuan}` : ''} (${b.status}; rujukan ${b.rujukan || '-'})`, halaman: h.halaman, kutipan: b.kutipan, sumber: 'lab' });
        // Hasil kualitatif (serologi, NS1, HBsAg, Widal) selalu relevan untuk
        // menilai diagnosis -- termasuk yang negatif/sesuai rujukan.
        else if (/[a-z]/i.test(String(b.hasil || '')) && !/\d/.test(String(b.hasil || ''))) tambah({ kategori: 'penunjang', teks: `${b.parameter} ${b.hasil}${b.status === 'normal' ? ' (sesuai rujukan' : ' ('}${b.rujukan ? `${b.status === 'normal' ? '; ' : ''}rujukan ${b.rujukan}` : ''})`, halaman: h.halaman, kutipan: b.kutipan, sumber: 'lab' });
      }
    }
    for (const p of pj.pemeriksaan) {
      if (p.hasil_ringkas) tambah({ kategori: 'penunjang', teks: `${p.nama}: ${p.hasil_ringkas}${p.sifat ? ` (${p.sifat === 'ganas' ? 'ganas' : 'tidak ganas'})` : ''}`, halaman: (p.bukti.find(b => b.peran === 'hasil') || {}).halaman || null, kutipan: (p.bukti.find(b => b.peran === 'hasil') || {}).kutipan || null, sumber: p.id });
      else if (p.ada_hasil) tambah({ kategori: 'penunjang', teks: `${p.nama} dilakukan`, halaman: (p.bukti[0] || {}).halaman || null, kutipan: (p.bukti[0] || {}).kutipan || null, sumber: p.id });
    }
  } catch (_) { /* penunjang opsional */ }

  // Terapi -> kelompok obat & petunjuk kondisi yang ditangani.
  for (const f of fakta.filter(x => x.kategori === 'terapi')) {
    const k = kelasObat(f.teks);
    if (k) { f.kelas_obat = k.kelas; f.petunjuk = k.petunjuk; }
  }

  const per_kategori = {};
  for (const f of fakta) (per_kategori[f.kategori] = per_kategori[f.kategori] || []).push(f);
  return { fakta, per_kategori };
}

/** Teks ringkas untuk prompt AI (hemat token): satu baris per fakta. */
function faktaUntukPrompt({ per_kategori }) {
  const URUT = [['keluhan', 'ANAMNESIS/KELUHAN'], ['riwayat', 'RIWAYAT'], ['tanda_vital', 'TANDA VITAL'], ['fisik', 'PEMERIKSAAN FISIK'],
    ['penunjang', 'PENUNJANG'], ['tindakan', 'TINDAKAN'], ['terapi', 'TERAPI'], ['diagnosis_awal', 'DIAGNOSIS AWAL (SEP/SPRI, bukan final)'],
    ['diagnosis_utama', 'DIAGNOSIS UTAMA DOKTER'], ['diagnosis_sekunder', 'DIAGNOSIS SEKUNDER DOKTER'], ['diagnosis_dokter', 'DIAGNOSIS/ASSESSMENT DOKTER']];
  const teks = URUT.filter(([k]) => (per_kategori[k] || []).length).map(([k, judul]) => `${judul}:\n${per_kategori[k].map(f => `- ${f.teks}${f.kelas_obat ? ` [${f.kelas_obat} -> ${f.petunjuk}]` : ''} [hal ${f.halaman || '?'}]`).join('\n')}`).join('\n');
  return teks;
}

module.exports = { susunFaktaKlinis, faktaUntukPrompt, kelasObat, faktaDariHalaman };
