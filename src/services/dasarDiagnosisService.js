/** Bukti diagnosis akhir dokter dan hasil PA dibaca terpisah, tanpa membuat diagnosis baru. */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const norm = x => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
const BATAS = /^\s*(?:diagnos[ai]s?\s+(?:utama|sekunder|akhir|keluar)|tindakan|prosedur|terapi|pengobatan|pemeriksaan|hasil\s+konsultasi|reaksi|diet|instruksi|keadaan\s+keluar|cara\s+keluar|prognosis|dokter|pasien\/)/i;

function bacaDiagnosisAkhir(pages) {
  const hasil = [];
  for (const p of pages || []) {
    const teks = String(p.ocr_text || '');
    const tipe = classifyPageDocumentType(teks);
    // Catatan SOAP dapat kehilangan judul saat OCR. Harus tetap memuat
    // anamnesis, pemeriksaan fisik, dan assessment; label diagnosis saja
    // pada formulir penunjang bukan diagnosis akhir dokter.
    const catatanKlinis = tipe === 'lainnya'
      && /(?:^|\n)\s*(?:s\s+)?anamnesis\b/i.test(teks)
      && /(?:^|\n)\s*(?:o\s+)?pemeriksaan\s+fisik\b/i.test(teks)
      && /(?:^|\n)\s*(?:a\s+)?(?:diagnos[ai]s?|assessment|asesmen)\b/i.test(teks);
    if (tipe !== 'resume_medis' && !catatanKlinis) continue;
    const baris = teks.split(/\r?\n/);
    for (let i = 0; i < baris.length; i++) {
      let m = /^\s*diagnos[ai]s?\s+(utama|sekunder|akhir|keluar)\s*:?\s*(.*)$/i.exec(baris[i]);
      if (!m && !baris.some(b => /^\s*diagnos[ai]s?\s+(utama|sekunder|akhir|keluar)\b/i.test(b))) {
        const umum = /^\s*(?:a\s+)?(?:diagnos[ai]s?|assessment|asesmen)\s*:?\s*(.*)$/i.exec(baris[i]);
        if (umum) m = [umum[0], 'utama', umum[1]];
      }
      if (!m) continue;
      const isi = [m[2]];
      for (let j = i + 1; j < baris.length && !BATAS.test(baris[j]) && !/^\s*(?:p\s*$|rencana|penyebab\s+cedera|keluhan|status\s+lokalis)/i.test(baris[j]); j++) isi.push(baris[j]);
      const kutipan = isi.join('\n').trim();
      if (!kutipan || /^[\d\s.\-:]+$/.test(kutipan)) continue;
      hasil.push({ peran: m[1].toLowerCase() === 'sekunder' ? 'sekunder' : 'utama', page_number: Number(p.page_number), kutipan });
    }
  }
  return hasil;
}

/** Kutipan AI harus menunjuk diagnosis akhir, bukan diagnosis klinis pada formulir lab/PA. */
function buktiDiagnosisAkhir(s, pages) {
  const q = norm(s.quotation || s.kutipan);
  if (q.length < 3) return false;
  return bacaDiagnosisAkhir(pages).some(d => Number(d.page_number) === Number(s.page_number)
    && (norm(d.kutipan).includes(q) || q.includes(norm(d.kutipan))));
}

function klasifikasiPatologi(pa) {
  if (!pa) return 'belum_terbaca';
  const isi = `${pa.sifat || ''} ${pa.kesimpulan || ''}`.replace(/\bsifat\s+keganasan\s*:?\s*/gi, '');
  // Hilangkan pernyataan negatif keganasan sebelum mencari keganasan positif.
  const ganas = '(?:keganasan|ganas|malignan\\w*|karsinoma|carcinoma|sarkoma|sarcoma|metasta\\w*)';
  const positif = isi.replace(new RegExp(`(?:tidak\\s+(?:(?:didapatkan|ditemukan|tampak|ada|terlihat)\\s+)?(?:(?:tanda(?:[-\\s]+tanda)?|sel|bukti|gambaran)\\s+(?:adanya\\s+)?)?${ganas}|(?:no\\s+(?:(?:evidence|signs|features)\\s+of\\s+)?|negative\\s+for\\s+)${ganas}|non[\\s-]?(?:malignan\\w*|ganas)|${ganas}\\s*:?\\s*(?:not\\s+(?:identified|found)|tidak\\s+(?:ditemukan|didapatkan)|\\(-\\)))`, 'gi'), '');
  if (/\b(?:suspek|suspicious|kemungkinan|dd|differential|atypia|atipia|uncertain|indeterminate)\b/i.test(positif)) return 'belum_pasti';
  if (/\b(?:karsinoma|carcinoma|adenokarsinoma|adenocarcinoma|sarkoma|sarcoma|limfoma|lymphoma|melanoma|malignan\w*|ganas|metasta\w*)\b/i.test(positif)) return 'ganas';
  // Negatif keganasan tidak membuktikan neoplasma jinak. Morfologi harus tertulis.
  if (/\b(?:lipoma|fibroadenoma|dermatofibroma|leiomyoma|adenoma|nevus|naevus|benign\s+(?:mesenchymal\s+)?neoplasm|neoplasma?\s+jinak|tumou?r\s+jinak)\b/i.test(positif)) return 'neoplasma_jinak';
  if (/\b(?:radang|inflam\w*|inflamm\w*|suppurative|supuratif|abses|abscess|granuloma\w*)\b/i.test(positif)) return 'peradangan';
  if (/\b(?:normal|within\s+normal\s+limits|tidak\s+(?:ditemukan|didapatkan|tampak)\s+kelainan)\b/i.test(positif)) return 'normal';
  if (/\b(?:jinak|benign|kista|cyst|polyp|polip|keloid)\b/i.test(positif) || positif !== isi) return 'tidak_ganas';
  return 'belum_pasti';
}

const ATURAN_DIAGNOSIS = new Set(['koding_obstetri', 'koding_luka_bakar']);
function alasanTahanDiagnosis(s, pages) {
  if (!ATURAN_DIAGNOSIS.has(s.sumber_aturan) && !buktiDiagnosisAkhir(s, pages)) {
    return 'Kutipan belum membuktikan diagnosis akhir dokter. Temuan pemeriksaan, diagnosis masuk, dan diagnosis banding perlu dikonfirmasi sebelum menjadi kode klaim.';
  }
  const code = String(s.code || '').toUpperCase();
  if (code === 'S61.1' && (!/\b(?:kuku|nail)\b/i.test(s.quotation || '')
    || /\b(?:tanpa|tidak|no|without)\b[^\n]{0,35}\b(?:kuku|nail|damage)\b/i.test(s.quotation || ''))) {
    return 'Luka jari tidak sendiri membuktikan kerusakan kuku yang disyaratkan S61.1. Pilih kode luka jari sesuai diagnosis dan rincian cedera yang tercatat.';
  }
  if (code === 'O99.6' && (!/(?:apend\w*|append\w*|penyakit|gangguan)[^\n;]{0,35}\b(?:pada|dalam|menyulitkan|komplikasi)\s+kehamilan|(?:complicat\w*|menyulitkan)\s+(?:pregnan\w*|kehamilan)/i.test(s.quotation || '')
    || /\b(?:tidak|bukan|tanpa|not|no)\b[^\n;]{0,25}\b(?:menyulitkan|komplikasi|complicat\w*)\b/i.test(s.quotation || ''))) {
    return 'Kehamilan yang tercatat bersama penyakit pencernaan tidak sendiri menjelaskan hubungan keduanya. Pemilihan O99.6 perlu penetapan dokter/koder; konsul SpOG saja tidak menjadi bukti hubungan diagnosis.';
  }
  if (/^D(?:3[789]|4[0-8])/.test(code) && !/uncertain\s+behavio|sifat\s+(?:tak\s+tentu|tidak\s+pasti)|perilaku\s+(?:tak\s+tentu|tidak\s+pasti)/i.test(s.quotation || '')) {
    return 'Tidak adanya PA atau diagnosis massa umum tidak membuktikan neoplasma dengan sifat tak tentu. Pilih kode setelah klarifikasi dokter/koder.';
  }
  if (/^(?:C\d|D[123]\d)/.test(code)) {
    const q = String(s.quotation || '');
    const sifatKutipan = klasifikasiPatologi({ kesimpulan: q });
    if (/^C/.test(code) && sifatKutipan !== 'ganas'
      && (s.sumber_aturan !== 'koding_neoplasma' || sifatKutipan !== 'belum_pasti'
        || /\b(?:suspek|suspicious|kemungkinan|dd|differential|uncertain|indeterminate)\b/i.test(q))) {
      return 'Kutipan diagnosis dokter belum menegakkan keganasan atau memuat penyangkalan/ketidakpastian. Kode keganasan perlu klarifikasi, bukan ditentukan dari kata ganas saja.';
    }
    const sifatKlinis = /^C/.test(code)
      ? /karsinoma|carcinoma|sarkoma|sarcoma|limfoma|lymphoma|melanoma|ganas|malignan|kanker|cancer/i
      : /\bjinak\b|benign|lipoma|fibroadenoma|adenoma|leiomyoma|dermatofibroma|nevus|naevus|\bfam\b/i;
    if (!sifatKlinis.test(q) && s.sumber_aturan !== 'koding_neoplasma') {
      return 'Kode neoplasma memerlukan sifat/jenis yang jelas dan hubungan dengan diagnosis dokter. Tumor/massa umum atau hasil negatif keganasan saja tidak membuktikannya.';
    }
  }
  return null;
}
function jagaSumberDiagnosis(saran, pages) {
  return (saran || []).map(s => {
    if (!s || s.type !== 'diagnosis' || s.disangkal || s.boleh_isi_otomatis === false) return s;
    const alasan = alasanTahanDiagnosis(s, pages);
    if (!alasan) return { ...s, diagnosis_akhir_terverifikasi: true };
    return { ...s, boleh_isi_otomatis: false, diagnosis_akhir_terverifikasi: false,
      alasan_tahan: alasan };
  });
}

function susunDasarDiagnosis(pages) {
  const { bacaPa } = require('./kodingNeoplasmaService');
  const diagnosis = bacaDiagnosisAkhir(pages);
  const patologi = (pages || []).filter(p => classifyPageDocumentType(p.ocr_text || '') === 'patologi_anatomi')
    .map(p => bacaPa([p])).filter(Boolean).map(pa => ({ ...pa, kategori: klasifikasiPatologi(pa) }));
  return { versi: 1, diagnosis_dokter: diagnosis, patologi,
    catatan: patologi.length
      ? 'Hasil patologi menggambarkan jaringan yang diperiksa. Cocokkan lokasi, spesimen, waktu hasil, diagnosis akhir dokter, dan tindakan. Hasil normal, radang, atau tidak ganas tidak otomatis mengganti diagnosis dokter maupun menentukan kelayakan rawat inap.'
      : 'Diagnosis akhir dokter di resume dinilai bersama pemeriksaan fisik, penunjang, dan tindakan.' };
}

module.exports = { bacaDiagnosisAkhir, buktiDiagnosisAkhir, jagaSumberDiagnosis, klasifikasiPatologi, susunDasarDiagnosis, alasanTahanDiagnosis };
