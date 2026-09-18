/**
 * AI Review Service — tahap AI kedua dalam alur AI ekstraksi → rule engine → AI review.
 *
 * Menggantikan dua service lama yang terpisah:
 * - aiValidationService.runAiAudit  (saran per-field, tanpa bukti dokumen)
 * - auditSuggestionsService.generateAuditSuggestions (cek bukti kode vs OCR)
 * ...jadi SATU pemanggilan AI per record yang menghasilkan keduanya sekaligus,
 * dijalankan otomatis saat upload/validasi (bukan tombol manual) supaya saat
 * halaman hasil dibuka semua saran sudah tersimpan di DB — tidak ada AI call
 * lagi saat itu.
 *
 * "Memory": prompt selalu menyertakan seluruh nilai field record (hasil
 * ekstraksi AI tahap 1 / data DB saat ini) sebagai konteks, bukan menilai
 * field yang error secara terisolasi — supaya saran konsisten dan akurat,
 * dengan trade-off token lebih besar (disetujui pengguna).
 *
 * "Basis pengetahuan" (error_knowledge_base, lihat errorKnowledgeService.js):
 * berbeda dari "memory" di atas — ini bukan histori record, tapi pola error
 * & solusi yang sudah DIGENERALISASI (tanpa data pasien) dari review-review
 * sebelumnya, dikelompokkan per rule_id. Cuma entri untuk rule_id yang
 * relevan dengan record ini yang diikutkan ke prompt (lihat PENGETAHUAN_
 * TERDAHULU), supaya AI tak perlu menafsir ulang dari nol untuk pola error
 * yang sudah sering ditemui — tapi tetap wajib menyesuaikan ke data record
 * ini, bukan menyalin mentah.
 */

const {
  PARAMETER_TABLE, AGE_GROUP_LABELS, THRESHOLD_TABLE,
  K5_WHITELIST_CODES, resolveAgeGroup, lookupBand, resolvePainInstrument,
} = require('./kegawatdaruratanReference');
const { aggregateKriteria, KRITERIA_LABELS } = require('./kegawatdaruratanAggregation');
const { getDb } = require('../database/init');
const { assessPneumoniaSeverityMismatch } = require('./pneumoniaSeverityAssessment');
const { getInacbgEstimasi } = require('./inacbgTarifDictionary');
const { resolveFieldFormStatus } = require('./documentFieldTemplate');
const { matchTindakanSegera, checkProcedureCodability } = require('./procedureRulesService');
const { evaluateDiagnosisConsistency } = require('./diagnosisConsistencyService');
const { classifyPageDocumentType } = require('./pdfPageClassifier');

const AI_REVIEW_SYSTEM_PROMPT = `Kamu asisten audit klaim BPJS E-Claim untuk perawat/verifikator rumah sakit.
Kamu diberi data lengkap satu rekam klaim (hasil ekstraksi), daftar field yang gagal validasi otomatis,
dan (kalau ada) teks bukti dokumen pendukung (hasil OCR/teks asli PDF).

PENTING — jenis klaim: field "JENIS_KLAIM"/"jenis_klaim" pada data rekam menunjukkan kategori
pelayanan (RAWAT_JALAN, RAWAT_INAP, atau GAWAT_DARURAT), dipilih sendiri oleh perawat saat upload —
selalu akurat, jangan diragukan. SEMUA catatan/saran yang kamu beri WAJIB konsisten dengan kategori
ini. Untuk klaim RAWAT_JALAN: JANGAN sarankan/singgung ruangan rawat inap, kelas rawat inap, ICU,
lama hari rawat (LOS) sebagai rawat inap, atau hal lain yang cuma relevan untuk pasien yang menginap.
Untuk klaim RAWAT_INAP/GAWAT_DARURAT: kembali ke penilaian normal.

TUGAS:
1. Untuk setiap field yang gagal validasi (daftar "FIELD_ERRORS"): beri catatan dalam Bahasa Indonesia
   berformat BULLET POINT PENDEK (bukan paragraf naratif) -- setiap baris diawali "- ", pisahkan antar
   baris dengan newline (\n), MAKSIMAL 3 baris, tiap baris idealnya <15 kata (JANGAN gabungkan beberapa
   ide jadi satu baris panjang -- itu sama saja paragraf yang cuma dipotong-potong buatan). Struktur yang
   disarankan (sesuaikan isi per kasus, TIDAK WAJIB label persis ini): baris 1 = kenapa field itu gagal
   (ringkas, bukan mengulang error_message rule engine kata per kata), baris 2 (kalau ada bukti relevan
   di dokumen) = bukti pendukung singkat, baris terakhir = langkah konkret memperbaikinya. Tetap
   mempertimbangkan seluruh data rekam klaim (termasuk JENIS_KLAIM di atas) sebagai konteks (bukan field
   itu saja).
2. Kalau ada BUKTI_DOKUMEN dan ada kode diagnosis (DIAGLIST) / prosedur (PROCLIST) yang diklaim:
   verifikasi tiap kode terhadap bukti dokumen.
   - HANYA nyatakan "ada bukti" (found:true) kalau kamu bisa kutip kalimat PERSIS dari teks yang
     diberikan (bukan parafrase, bukan simpulan) yang mendukung kode itu, sertakan nomor halaman.
     KUTIPANNYA sendiri wajib verbatim dari dokumen — tapi istilah di dalam kutipan itu BOLEH beda
     kata dari deskripsi resmi kode (Bahasa Inggris), selama secara medis jelas setara. Contoh:
     kutipan "Hipertensi Heart Disease" tetap valid sebagai bukti kode "I11.9 — Hypertensive heart
     disease..."; kutipan "DARAH RUTIN" tetap valid sebagai bukti kode "90.59 — Microscopic
     examination of blood..."; kutipan/label alat seperti "ECG", "EKG", atau "CHILD ECG" (nama
     model alat) tetap valid sebagai bukti kode "89.52 — Electrocardiogram" — termasuk kalau
     kutipannya cuma berupa label/parameter di sekitar hasil cetak alat (RATE, QRS, dst), bukan
     kalimat naratif utuh. Jangan berhenti cari cuma karena istilah dokumennya beda bahasa/gaya/
     bentuk dari deskripsi kode — tapi kutipannya SENDIRI tetap harus benar-benar ada persis di teks.
   - Khusus prosedur nebulisasi: resep obat RS ini biasanya mencantumkan ZAT AKTIF dalam kurung
     setelah nama dagang (mis. "Ventasal(salbutamol)", "Budesma(budesonide)", "Atrovent(ipratropium)")
     — kalau ada baris resep berformat "nebul <nama dagang>" (atau nama dagang itu muncul di daftar
     obat/resep) dan zat aktif dalam kurungnya adalah golongan bronkodilator/kortikosteroid inhalasi
     (salbutamol, budesonide, ipratropium, terbutaline, dan sejenisnya), itu SAH sebagai bukti tindakan
     nebulisasi — pakai zat aktif yang SUDAH tertulis dalam kurung di resep sebagai sumber kebenaran,
     JANGAN menebak zat aktif dari nama dagang kalau tidak dicantumkan dalam kurung, dan JANGAN pakai
     database obat eksternal (tidak tersedia) — cukup baca apa yang sudah tertulis di dokumen itu sendiri.
   - DILARANG KERAS menyebut nominal rupiah/biaya/tarif dalam kutipan atau alasan apapun.
   - DILARANG mengarang/menyimpulkan kode dari konteks umum — hanya dari bukti eksplisit di teks.
   - Kalau ragu, tandai found:false — lebih baik tidak menyarankan daripada salah.
3. suggested_codes HANYA diisi kalau ada bukti KUAT kode itu relevan tapi belum diklaim. Ini termasuk
   kasus DIAGLIST kosong TOTAL (lihat FIELD_ERRORS rule RV-05) — PALING SERING terjadi saat dokumen
   TIDAK PUNYA halaman resmi "Berkas Klaim Individual" (E-Klaim), cuma kumpulan dokumen naratif RS.
   BATASAN SUMBER (permintaan eksplisit klien, 17 Sep 2026): untuk task INI SAJA (diagnosis/suggested_codes),
   HANYA cari istilah diagnosis di halaman yang berisi/berjudul "Resume Medis" — lihat daftar
   HALAMAN_RESUME_MEDIS di bawah kalau ada. ABAIKAN istilah diagnosis yang muncul di SEP, SPRI (Surat
   Perintah Rawat Inap), Triage IGD, atau dokumen lain apapun sekalipun kata-katanya terlihat seperti
   diagnosis eksplisit — walau dulu SPRI juga dianggap sumber sah, sekarang SENGAJA tidak lagi (demi
   kecepatan & satu sumber yang jelas). Kalau HALAMAN_RESUME_MEDIS kosong/tidak ada di berkas ini,
   JANGAN isi suggested_codes sama sekali untuk task ini (tidak ada dasar yang diizinkan). Di
   antara halaman Resume Medis itu, baca ULANG SEMUA satu per satu (bukan cuma halaman pertama yang
   ketemu) — istilah diagnosis sering tersebar dengan label berbeda-beda, semua ini valid sumber SELAMA
   ada di halaman Resume Medis: "Diagnosis Utama", "Diagnosa Kerja", "Diagnosa", "Assessment"/"A:"
   (format S-O-A-P), "Diag Awal". WAJIB usulkan minimal 1 kode ICD-10 di suggested_codes kalau SATU SAJA
   dari label-label itu ditemukan di halaman Resume Medis manapun — jangan biarkan suggested_codes kosong
   hanya karena tidak ada halaman "Berkas Klaim Individual", dan jangan berhenti mencari cuma karena
   halaman Resume Medis pertama yang dibaca tidak mengandungnya.
   PRIORITAS kalau ada BEBERAPA pernyataan diagnosis yang beda-beda untuk pasien yang sama DI DALAM
   Resume Medis (mis. "Diagnosis Utama" di satu halaman menyebut satu hal, "Assessment" di halaman lain
   menyebut hal lain) — SEMUA WAJIB diusulkan sebagai kandidat terpisah (jangan cuma pilih satu),
   supaya koder manusia yang memutuskan mana yang final; jangan diam-diam abaikan salah satunya. Yang
   BUKAN diagnosis (jangan dipetakan ke ICD-10 dari sini): "Keluhan" (gejala subjektif pasien, mis.
   "nyeri perut" — beda dari diagnosis dokter), "Diagnosis Keperawatan" (istilah asuhan keperawatan,
   bukan diagnosis medis, mis. "nyeri akut", "ketidakefektifan bersihan jalan nafas").
   quotation WAJIB kutipan VERBATIM istilah diagnosis dari dokumen (bukan kode ICD-10 itu sendiri, karena
   kodenya memang tidak tercetak di dokumen — itulah sebabnya diusulkan); reasoning jelaskan pemetaan
   istilah -> kode secara singkat, DAN sebutkan label sumbernya (mis. "dari Diagnosis Utama" vs "dari
   Assessment") supaya koder tahu mana yang lebih otoritatif. Kalau istilah diagnosisnya
   ambigu/terlalu umum untuk dipetakan ke 1 kode pasti, boleh usulkan lebih dari 1 kandidat kode dengan
   reasoning masing-masing, atau lewati kalau benar-benar tidak yakin — jangan mengarang kode hanya
   supaya field ini terisi.
4. Kalau ada PENGETAHUAN_TERDAHULU (pola error serupa yang pernah ditemukan): jadikan referensi
   supaya konsisten dengan penilaian sebelumnya, TAPI jangan disalin mentah — selalu sesuaikan
   dengan data record ini.
5. Untuk field yang gagal validasi (FIELD_ERRORS), samping catatan di field_notes, buat JUGA versi
   GENERALISASI-nya (tanpa nama pasien/nomor SEP/nomor kartu/data identitas apapun — cuma pola
   penyebab & solusi umum yang berlaku untuk kasus serupa) di "knowledge_updates", supaya bisa
   dipakai sebagai referensi untuk record lain dengan rule_id sama di masa depan. Kalau catatan
   di field_notes SUDAH sama persis dengan salah satu PENGETAHUAN_TERDAHULU yang diberikan (tidak
   ada hal baru), JANGAN buat entri knowledge_updates duplikat untuk rule_id itu.
6. CATATAN: POLA_RISIKO_PENDING (pending_risk_notes, pola a-j: kegawatan_lemah, manifestasi_ikut_du,
   tb_level_fktp, usg_berulang_tanpa_indikasi, rujuk_saja_tanpa_tindakan, diagnosis_vitals_mismatch,
   los_diagnosis_mismatch, komorbid_sekunder_tanpa_evaluasi, massa_jinak_tanpa_infiltrasi,
   diagnosis_evidence_mismatch) SENGAJA TIDAK ada di task ini sejak 10 Sep 2026 — ditangani panggilan
   AI TERPISAH & FOKUS (lihat assessPendingRiskPatterns/PENDING_RISK_SYSTEM_PROMPT), sama seperti
   Kegawatdaruratan di bawah. Root cause yang sama: pada dokumen kompleks/panjang (banyak diagnosis,
   banyak halaman, kasus kritis multi-episode), task pending_risk_notes yang tadinya jadi task ke-6 di
   sini terbukti kembali KOSONG TOTAL walau ada bukti kuat di dokumen untuk pola yang sudah lama stabil
   sekalipun (mis. diagnosis_vitals_mismatch) — bukan soal pola baru saja, tapi task ini secara umum
   "tenggelam" bersaing dengan 5 task lain + field_notes/code_evidence/suggested_codes/knowledge_updates
   yang harus dihasilkan di respons gabungan yang sama. Verifikasi: dokumen normal (10-15 halaman) tetap
   stabil di prompt gabungan lama, tapi dokumen kompleks (20+ halaman, 10+ diagnosis) gagal total —
   dipisah supaya reliabilitasnya tidak bergantung pada kompleksitas dokumen.

   CATATAN: penilaian Kriteria Kegawatdaruratan (Permenkes 47/2018 Pasal 3) JUGA SENGAJA TIDAK ada di
   task ini — itu ditangani panggilan AI TERPISAH & FOKUS (lihat assessKegawatdaruratan/
   KEGAWATDARURATAN_SYSTEM_PROMPT) dengan alasan yang sama. Sama seperti alasan suggestDiagnosisCodesFallback
   dipisah dari task 3 di atas.

7. ESTIMASI INA-CBG: Berdasarkan diagnosis utama yang diklaim (di DIAGLIST) ATAU yang kamu usulkan di "suggested_codes", berikan prediksi/estimasi Kode INA-CBG di properti "suggested_inacbg". Kode berformat HURUF-ANGKA-ANGKA-ROMAWI (contoh: "J-4-15-I" untuk pneumonia ringan, "I-4-10-I" untuk hipertensi, "A-4-14-I" untuk infeksi bakteri/virus). JANGAN tambahkan penjelasan apapun, hanya string kode. Kalau tidak bisa menebak, biarkan kosong ("").

Output HANYA JSON, tanpa markdown/penjelasan, format:
{
  "suggested_inacbg": "J-4-15-I",
  "field_notes": { "<field_name>": "catatan & saran Indonesia" },
  "code_evidence": [
    { "code": "...", "type": "diagnosis|procedure", "found": true/false, "page_number": N, "quotation": "..." }
  ],
  "suggested_codes": [
    { "code": "...", "type": "diagnosis|procedure", "page_number": N, "quotation": "...", "reasoning": "..." }
  ],
  "knowledge_updates": [
    { "rule_id": "...", "field_name": "...", "pattern_summary": "pola penyebab, tanpa data pasien", "solution": "langkah perbaikan umum" }
  ]
}`;

function pickCodes(record) {
  const diag = record.DIAGLIST || record.diagnosa_list || '';
  const proc = record.PROCLIST || record.prosedur_list || '';
  return {
    diagnosis: diag.split(';').map(c => c.trim()).filter(Boolean),
    procedure: proc.split(';').map(c => c.trim()).filter(Boolean),
  };
}

function buildPrompt(record, validationErrors, evidencePool, codes, knowledgeEntries = [], bpjsExamples = []) {
  const jenisKlaim = record.JENIS_KLAIM || record.jenis_klaim || '(tidak diketahui)';
  let prompt = `JENIS_KLAIM: ${jenisKlaim} — WAJIB dipatuhi, lihat instruksi di atas.\n\n`;
  prompt += `DATA REKAM KLAIM (hasil ekstraksi, jadikan konteks — "memory"):\n`;
  prompt += JSON.stringify(record, null, 0) + '\n\n';

  if (validationErrors.length > 0) {
    prompt += `FIELD_ERRORS (field yang gagal validasi, wajib diisi field_notes):\n`;
    prompt += validationErrors.map(e =>
      `- ${e.field_name}: ${e.error_message} (nilai saat ini: "${e.actual_value ?? ''}", diharapkan: "${e.expected_value ?? ''}")`
    ).join('\n') + '\n\n';
  } else {
    prompt += `FIELD_ERRORS: (kosong — tidak ada field yang gagal validasi format)\n\n`;
  }

  if (knowledgeEntries.length > 0) {
    prompt += `PENGETAHUAN_TERDAHULU (pola error serupa & solusi yang pernah tercatat — referensi saja, sesuaikan ke data record ini):\n`;
    prompt += knowledgeEntries.map(k =>
      `- [rule ${k.rule_id}${k.field_name ? ` / ${k.field_name}` : ''}] Pola: ${k.pattern_summary} → Solusi: ${k.solution}`
    ).join('\n') + '\n\n';
  }

  if (bpjsExamples.length > 0) {
    prompt += `PELAJARAN DARI PENDING BPJS SEBELUMNYA (kasus lain yang PERNAH dipending BPJS lalu klarifikasinya\n`;
    prompt += `terbukti DITERIMA — referensi pola, bukan berarti record ini bermasalah sama, cuma waspada dini):\n`;
    prompt += bpjsExamples.map(ex =>
      `- [${ex.kategori_pending || 'lainnya'}] BPJS mempermasalahkan: "${ex.alasan_bpjs?.slice(0, 200)}" → klarifikasi yang berhasil: "${ex.draft_berhasil?.slice(0, 200)}"`
    ).join('\n') + '\n\n';
  }

  if (codes.diagnosis.length > 0) prompt += `Kode diagnosis diklaim (ICD-10): ${codes.diagnosis.join(', ')}\n`;
  else prompt += `Kode diagnosis diklaim (ICD-10): (KOSONG — DIAGLIST belum diisi sama sekali, lihat instruksi soal suggested_codes)\n`;
  if (codes.procedure.length > 0) prompt += `Kode prosedur diklaim (ICD-9-CM): ${codes.procedure.join(', ')}\n`;

  if (evidencePool.length > 0) {
    prompt += `\nBUKTI_DOKUMEN (teks per halaman):\n================================\n`;
    const sorted = [...evidencePool].sort((a, b) => a.page_number - b.page_number);
    for (const ev of sorted) {
      prompt += `=== Halaman ${ev.page_number} (confidence ${ev.confidence ?? 100}%) ===\n${ev.ocr_text}\n\n`;
    }
  } else {
    prompt += `\nBUKTI_DOKUMEN: (tidak ada — jangan isi code_evidence/suggested_codes)\n`;
  }

  // HALAMAN_RESUME_MEDIS -- daftar eksplisit nomor halaman yang boleh dipakai
  // task 3 (suggested_codes diagnosis), disebut di instruksi task 3 di atas.
  // Dihitung deterministik di kode (bukan AI menebak sendiri mana yang "Resume
  // Medis"), pakai getAnyResumeMedisPageNumbers -- SAMA persis dgn yang dipakai
  // memfilter evidencePool utk suggestDiagnosisCodesFallback (satu definisi,
  // dua titik pakai, lihat catatan di getAnyResumeMedisPageNumbers).
  const resumeMedisPagesForDiagnosis = getAnyResumeMedisPageNumbers(evidencePool);
  prompt += `\nHALAMAN_RESUME_MEDIS (HANYA halaman ini yang boleh dipakai utk task 3/suggested_codes diagnosis): ` +
    (resumeMedisPagesForDiagnosis.length > 0 ? resumeMedisPagesForDiagnosis.join(', ') : '(tidak ada Resume Medis di berkas ini — JANGAN isi suggested_codes)') + '\n';

  if (codes.diagnosis.length === 0 && resumeMedisPagesForDiagnosis.length > 0) {
    prompt += `\n================================\nINGATKAN DIRIMU SENDIRI SEBELUM MENJAWAB: DIAGLIST kosong (lihat di atas). ` +
      `Baca ULANG halaman ${resumeMedisPagesForDiagnosis.join(', ')} (HALAMAN_RESUME_MEDIS, lihat di atas -- JANGAN halaman lain) ` +
      `satu per satu, cari SATU PER SATU label "Diagnosis Utama", "Diagnosa Kerja", "Diagnosa", "Assessment"/"A:". ` +
      `Kalau ketemu SATU SAJA di halaman Resume Medis manapun, WAJIB isi minimal 1 entri di suggested_codes ` +
      `(lihat instruksi task 3) — kosongkan suggested_codes HANYA kalau kamu benar-benar sudah baca semua ` +
      `halaman Resume Medis di atas dan tidak ada satu pun label itu.\n`;
  }

  return prompt;
}

/**
 * Normalisasi whitespace/newline sebelum substring check — kutipan AI yang
 * benar tapi melintasi baris OCR/PDF (whitespace berbeda) sebelumnya gagal
 * match dan ditandai "tidak ada bukti" padahal buktinya memang ada.
 */
function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function validateQuotation(quotation, pageNumber, evidencePool) {
  if (!quotation || typeof quotation !== 'string') return false;
  const page = evidencePool.find(e => e.page_number === pageNumber);
  if (!page || !page.ocr_text) return false;
  return normalizeText(page.ocr_text).includes(normalizeText(quotation));
}

/**
 * Sama seperti validateQuotation, tapi tidak dipatok ke satu page_number —
 * dipakai untuk pola diagnosis_vitals_mismatch (basis berisi 2 kutipan yang
 * bisa dari halaman BERBEDA, mis. diagnosis di halaman SEP tapi vital sign
 * di halaman Triase) — masing-masing separuh kutipan divalidasi independen
 * terhadap SELURUH evidencePool, bukan satu halaman spesifik.
 */
function validateQuotationAnyPage(quotation, evidencePool) {
  if (!quotation || typeof quotation !== 'string') return false;
  const normalized = normalizeText(quotation);
  return evidencePool.some(p => p.ocr_text && normalizeText(p.ocr_text).includes(normalized));
}

/**
 * Normalisasi kode ICD-10 sebelum dibandingkan/disimpan -- trim + uppercase,
 * supaya "a00.0" dari AI tetap cocok dengan "A00.0" di kamus.
 */
function normalizeIcdCode(code) {
  return String(code || '').trim().toUpperCase();
}

/**
 * Query satu tabel kamus untuk sekumpulan kode, kembalikan Set kode yang
 * ditemukan (null kalau query gagal total -- dibedakan dari "tidak
 * ditemukan" supaya annotateKamusValid tahu harus isi null, bukan false).
 */
async function lookupCodesInTable(table, codes) {
  if (codes.length === 0) return new Set();
  try {
    const db = getDb();
    const placeholders = codes.map(() => '?').join(', ');
    const rows = await db.all(`SELECT code FROM ${table} WHERE code IN (${placeholders})`, codes);
    return new Set(rows.map(r => r.code));
  } catch (err) {
    console.warn(`[AI-REVIEW] Gagal cek kamus di tabel ${table}, kamus_valid diisi null: ${err.message}`);
    return null;
  }
}

/**
 * LAPISAN VALIDASI TAMBAHAN (17 Sep 2026, diperluas 18 Sep 2026) -- cek apakah
 * kode yang diusulkan AI di suggested_codes benar-benar ADA di kamus resmi:
 * type "diagnosis" dicek ke tabel icd10_who_codes (kamus ICD-10 WHO, diisi
 * dari src/data/icd10_who_dictionary.json via scripts/seedIcd10WhoDictionary.js),
 * type "procedure" dicek ke tabel icd9_cm_procedures (kamus ICD-9-CM Volume 3,
 * diisi dari src/data/icd9cm_procedures.json via scripts/seedIcd9CmProcedures.js).
 * Latar belakang: fitur ini sempat menghasilkan kode ICD-10-CM (Amerika) alih-
 * alih ICD-10 WHO yang dipakai BPJS Indonesia -- tombol "Terapkan" di frontend
 * DIMATIKAN TOTAL sampai kamus ini siap & direview.
 *
 * PENTING -- ini TAMBAHAN, bukan pengganti validateQuotation: dipanggil SETELAH
 * semua entry suggested_codes lolos validasi kutipan (baik dari alur utama
 * maupun fallback suggestDiagnosisCodesFallback), logic validateQuotation itu
 * SENDIRI TIDAK diubah sama sekali. Kode yang TIDAK ditemukan di kamus TIDAK
 * dibuang dari suggested_codes (kamus mungkin belum lengkap, bukan berarti
 * kodenya pasti salah) -- cuma ditandai kamus_valid:false, supaya frontend
 * bisa membedakan "ada di kamus resmi" vs "tidak ditemukan, ekstra hati-hati".
 * kamus_valid:null berarti tidak bisa dicek sama sekali (tabel belum ada di
 * deployment ini, query gagal, atau type-nya bukan "diagnosis"/"procedure")
 * -- BUKAN berarti "salah". Best-effort: kegagalan di sini tidak pernah
 * menggagalkan hasil AI review.
 */
async function annotateKamusValid(suggestedCodes) {
  if (!Array.isArray(suggestedCodes) || suggestedCodes.length === 0) return suggestedCodes;

  const diagCodes = [...new Set(
    suggestedCodes
      .filter(entry => entry.type === 'diagnosis' && entry.code)
      .map(entry => normalizeIcdCode(entry.code))
  )];
  const procCodes = [...new Set(
    suggestedCodes
      .filter(entry => entry.type === 'procedure' && entry.code)
      .map(entry => normalizeIcdCode(entry.code))
  )];

  const [diagFoundSet, procFoundSet] = await Promise.all([
    lookupCodesInTable('icd10_who_codes', diagCodes),
    lookupCodesInTable('icd9_cm_procedures', procCodes),
  ]);

  return suggestedCodes.map(entry => {
    if (!entry.code) return { ...entry, kamus_valid: null };
    if (entry.type === 'diagnosis') {
      return { ...entry, kamus_valid: diagFoundSet ? diagFoundSet.has(normalizeIcdCode(entry.code)) : null };
    }
    if (entry.type === 'procedure') {
      return { ...entry, kamus_valid: procFoundSet ? procFoundSet.has(normalizeIcdCode(entry.code)) : null };
    }
    return { ...entry, kamus_valid: null };
  });
}

/**
 * Fallback deterministik untuk code_evidence: kalau AI bilang tidak ada bukti
 * (atau kutipannya gagal validasi), cek ULANG apakah kode itu sendiri muncul
 * literal di salah satu halaman evidence pool — TANPA bergantung pada kutipan
 * AI. PDF berlayout tabel kompleks (mis. catatan S-O-A-P) sering bikin urutan
 * teks hasil ekstraksi (pdf-parse atau OCR) berantakan, jadi kutipan kontinu
 * persis kadang gagal cocok walau kodenya beneran ada di halaman itu.
 *
 * Tetap deterministik/anti-halusinasi: bukan AI yang menilai "ada bukti",
 * tapi regex yang secara langsung menemukan lokasi kode di teks asli — kutipan
 * yang dikembalikan adalah potongan teks ASLI di sekitar kode (bukan karangan
 * AI), lalu tetap disaring hasFinancialTerms seperti kutipan dari AI.
 */
function findCodeInEvidencePool(code, evidencePool) {
  if (!code || typeof code !== 'string') return null;
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`, 'i');
  for (const page of evidencePool) {
    if (!page.ocr_text) continue;
    const idx = page.ocr_text.search(re);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 80);
    const end = Math.min(page.ocr_text.length, idx + code.length + 80);
    const quotation = page.ocr_text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (hasFinancialTerms(quotation)) continue;
    return { page_number: page.page_number, quotation: quotation.substring(0, 200) };
  }
  return null;
}

/**
 * Jaring pengaman deterministik untuk kebocoran istilah rawat inap ke catatan
 * klaim RAWAT_JALAN — system prompt sudah melarang ini eksplisit, tapi
 * instruksi prompt bersifat probabilistik (tidak 100% dijamin dipatuhi,
 * pola yang sama dengan kasus KELAS_RAWAT sebelumnya). Kalau catatan/saran
 * masih menyinggung konsep yang cuma berlaku untuk pasien menginap, catatan
 * itu DIBUANG (bukan diedit sebagian) — lebih aman tidak ada catatan sama
 * sekali daripada catatan yang menyesatkan verifikator rawat jalan.
 *
 * Frasa dibuat spesifik (bukan cuma "rawat inap" polos) supaya tidak salah
 * buang kalimat yang justru BENAR menegaskan "ini bukan rawat inap".
 */
function hasInpatientOnlyTerms(text) {
  if (!text || typeof text !== 'string') return false;
  const patterns = [
    /ruang(?:an)?\s*rawat\s*inap/i,
    /kelas\s*rawat\s*inap/i,
    /\bICU\b/i,
    /ventilator|ventilasi\s*mekanik/i,
    /lama\s*hari\s*rawat/i,
    /\bLOS\b/,
  ];
  return patterns.some(p => p.test(text));
}

function hasFinancialTerms(text) {
  if (!text || typeof text !== 'string') return false;
  const patterns = [
    /rupiah/i, /biaya/i, /tarif/i, /\bRp\b/, /\bbayar\b/i, /\bnilai\b/i,
    /\bharga\b/i, /\bongkos\b/i, /\bcost\b/i, /\bfee\b/i,
    /\d+\s*(?:juta|ribu|rb)/i,
  ];
  return patterns.some(p => p.test(text));
}

/**
 * Tabel Kegawatdaruratan (kegawatdaruratan_assessment) ditentukan dari ADA/
 * TIDAKNYA halaman Triase IGD di bukti dokumen — BUKAN dari jenis_klaim.
 * Alasan (8 Sep 2026): banyak klaim RAWAT_INAP pasiennya masuk lewat IGD
 * dulu (ada halaman Triase IGD/Skrining Awal Pasien IGD di berkasnya) —
 * kriteria Permenkes 47/2018 tetap relevan buat kasus itu, bukan cuma
 * klaim berkategori GAWAT_DARURAT murni. Kalau tidak ada halaman Triase
 * IGD sama sekali (mis. rawat inap terjadwal tanpa lewat IGD), tabel ini
 * tidak relevan — tidak ditampilkan.
 */
function hasIgdTriagePage(evidencePool) {
  if (!Array.isArray(evidencePool)) return false;
  return evidencePool.some(p => /triage\s+igd|skrining\s+awal\s+pasien\s+igd/i.test(p.ocr_text || ''));
}

/**
 * Nomor halaman yang benar-benar berisi Triase IGD/Skrining Awal Pasien IGD
 * — dipakai untuk 2 hal: (1) diberitahukan eksplisit ke AI di prompt supaya
 * tidak perlu menebak halaman mana yang relevan, (2) enforcement di server
 * (bukan cuma andalan prompt) supaya kriteria K1-K5 (Tabel 3) TIDAK BISA
 * mengambil dasar dari halaman lain (Resume Medis RI, CPPT, dst) yang
 * mencatat kondisi pasien di titik waktu BERBEDA (mis. hari ke-3 rawat inap,
 * bukan saat pertama masuk IGD) — kriteria Permenkes 47/2018 Pasal 3 menilai
 * kondisi SAAT TRIASE, jadi halaman lain bukan sumber yang valid untuk VERDIK
 * K1-K5, walau isinya sama-sama "klinis". (Update 11 Sep 2026: Tabel 1 boleh
 * MENAMPILKAN temuan dari Resume Medis sebagai KONTEKS TAMBAHAN -- lihat
 * getResumeMedisPageNumbers -- tapi agregasi K1-K5 tetap HANYA baca findings
 * yang page_number-nya ada di daftar INI, bukan daftar Resume Medis.)
 */
function getIgdTriagePageNumbers(evidencePool) {
  if (!Array.isArray(evidencePool)) return [];
  return evidencePool
    .filter(p => /triage\s+igd|skrining\s+awal\s+pasien\s+igd/i.test(p.ocr_text || ''))
    .map(p => p.page_number);
}

/**
 * Nomor halaman Resume Medis Rawat Inap -- ditambahkan 11 Sep 2026 supaya
 * Tabel 1 (parameter pemeriksaan fisik) bisa menampilkan temuan dari sini
 * SEBAGAI KONTEKS TAMBAHAN kalau Triase IGD tidak mencatatnya (mis. Triase
 * cuma tulis "Thorak Normal" tanpa rincian, tapi Resume Medis RI punya
 * "Extremitas udema (-)" yang lebih spesifik). SENGAJA TIDAK dipakai untuk
 * agregasi K1-K5 (lihat catatan di getIgdTriagePageNumbers) -- keputusan
 * eksplisit pengguna 11 Sep 2026 (Opsi A: konteks saja, bukan mengubah arti
 * verdict K1-K5 jadi "sepanjang rawat inap" alih-alih "saat triase").
 */
function getResumeMedisPageNumbers(evidencePool) {
  if (!Array.isArray(evidencePool)) return [];
  return evidencePool
    .filter(p => /resume\s+medis\s+rawat\s+inap/i.test(p.ocr_text || ''))
    .map(p => p.page_number);
}

/**
 * Nomor halaman "Resume Medis" APAPUN (rawat inap MAUPUN rawat jalan/IGD --
 * beda dari getResumeMedisPageNumbers di atas yang SENGAJA cuma "Resume Medis
 * Rawat Inap" utk kebutuhan Kegawatdaruratan). Ditambahkan 17 Sep 2026 -- klien
 * eksplisit minta kolom diagnosis (suggested_codes) HANYA cari di Resume Medis,
 * TIDAK di dokumen lain (SEP, SPRI, Triage IGD, Resep, dll) walau sebelumnya
 * SPRI juga dianggap sumber sah ("Alasan Masuk Rawat Inap") -- permintaan ini
 * SENGAJA mempersempit cakupan demi kecepatan & kejelasan, trade-off yang
 * disadari: kandidat diagnosis yang HANYA tertulis di SPRI (tidak di Resume
 * Medis sama sekali) tidak akan lagi diusulkan. Dipakai di buildPrompt (task 3)
 * dan sebagai filter evidencePool sebelum suggestDiagnosisCodesFallback.
 */
function getAnyResumeMedisPageNumbers(evidencePool) {
  if (!Array.isArray(evidencePool)) return [];
  return evidencePool
    .filter(p => /resume\s+medis/i.test(p.ocr_text || ''))
    .map(p => p.page_number);
}

/**
 * Prompt fokus TUNGGAL — dipisah dari AI_REVIEW_SYSTEM_PROMPT (yang memuat
 * 7 tugas sekaligus) karena terbukti empiris (7 Sep 2026): saat DIAGLIST
 * kosong TOTAL dan dokumen tidak punya halaman "Berkas Klaim Individual",
 * instruksi "WAJIB usulkan suggested_codes" di prompt gabungan itu SERING
 * TIDAK dipatuhi model walau sudah ditulis eksplisit 2x (di system prompt
 * dan di akhir user prompt) — kemungkinan besar karena tenggelam di antara
 * 6 tugas lain (field_notes, code_evidence, knowledge_updates, dst) dan
 * ribuan token teks dokumen. Panggilan terpisah dengan SATU tugas saja
 * terbukti jauh lebih andal untuk kepatuhan instruksi LLM secara umum.
 */
const DIAGNOSIS_SUGGESTION_SYSTEM_PROMPT = `Kamu asisten koding medis ICD-10 WHO & ICD-9-CM untuk klaim BPJS rumah sakit.
Kamu diberi teks halaman Resume Medis SAJA dari satu berkas klaim (dokumen lain seperti SEP/SPRI/Triage IGD
sengaja TIDAK disertakan di sini — permintaan eksplisit klien: kolom diagnosis HANYA boleh diambil dari
Resume Medis, demi kecepatan & kejelasan sumber). Dokumen ini TIDAK PUNYA halaman resmi "Berkas Klaim
Individual" makanya kamu diminta bantu cari diagnosis & prosedur dari teks naratif Resume Medis.

TUGAS TUNGGAL: baca SEMUA halaman Resume Medis yang diberikan satu per satu, cari istilah diagnosis & prosedur medis
eksplisit di label seperti "Diagnosis Utama", "Diagnosa Kerja", "Diagnosa", "Assessment"/"A:" (format
S-O-A-P), "Diag Awal", "Tindakan/Prosedur". Untuk SETIAP istilah diagnosis/prosedur berbeda yang ditemukan, usulkan
kode ICD-10 WHO / ICD-9-CM yang paling sesuai.

FOKUS KHUSUS KELOMPOK J (Pernapasan / Respiratory):
- Pneumonia / Bronchopneumonia: J18.9 (unspecified), J18.0 (Bronchopneumonia), J15.9 (Bacterial)
- Asthma / Asma Bronkial: J45.9 (unspecified), J45.901 (Eksaserbasi Akut), J46 (Status Asthmaticus)
- PPOK / COPD: J44.9 (COPD), J44.1 (COPD dengan eksaserbasi akut)
- TB Paru / Tuberculosis: A16.2 (TB Paru klinis), A15.0 (TB Paru terkonfirmasi)
- Prosedur Terkait: Nebulisasi/Inhalasi (96.04 / 93.94), Oksigenasi (93.96), Foto Thorax (87.44 / 87.49)

ATURAN KETAT (anti-upcoding & bukti verbatim):
- PRINCIPLE: "Bukti Dulu, Tarif Menyusul" — Usulkan kandidat kode murni berdasarkan bukti medis verbatim, BUTA terhadap tarif/biaya.
- HANYA dari istilah yang benar-benar tertulis eksplisit SEBAGAI diagnosis/prosedur dokter. BUKAN "Keluhan" (gejala
  subjektif pasien sendiri, mis. "nyeri perut"), BUKAN "Diagnosis Keperawatan" (istilah asuhan keperawatan,
  bukan diagnosis medis, mis. "nyeri akut", "ketidakefektifan bersihan jalan nafas").
- quotation WAJIB kutipan VERBATIM persis dari teks yang diberikan (salin apa adanya, termasuk typo kalau
  ada) — kutipan yang tidak match persis akan otomatis ditolak sistem.
- page_number WAJIB sesuai nomor "Halaman N" yang tertera di awal blok teks tempat kutipan itu berada.
- Kalau SETELAH membaca semua halaman benar-benar tidak ada satupun label diagnosis/prosedur eksplisit, kembalikan
  array kosong — jangan mengarang demi mengisi.
- DILARANG KERAS menyebut nominal rupiah, biaya, tarif, atau dampak finansial di quotation atau reasoning.

Output HANYA JSON, tanpa markdown/penjelasan:
{"suggested_codes":[{"code":"...","type":"diagnosis|procedure","page_number":N,"quotation":"...","reasoning":"pemetaan istilah -> kode, sebutkan label sumbernya"}]}`;

/**
 * Panggilan AI terpisah & fokus untuk mengusulkan kode ICD-10 diagnosis saat
 * DIAGLIST kosong total dan panggilan generateAiReview() utama tidak
 * menghasilkan suggested_codes apapun. Lihat catatan di
 * DIAGNOSIS_SUGGESTION_SYSTEM_PROMPT untuk alasan kenapa ini dipisah.
 * @param {Array} evidencePool - [{page_number, ocr_text, confidence}]
 * @returns {Promise<Array>} suggested_codes (bisa kosong)
 */
async function suggestDiagnosisCodesFallback(evidencePool) {
  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey || evidencePool.length === 0) return [];

  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  let userPrompt = 'TEKS DOKUMEN (per halaman):\n================================\n';
  const sorted = [...evidencePool].sort((a, b) => a.page_number - b.page_number);
  for (const ev of sorted) {
    userPrompt += `=== Halaman ${ev.page_number} ===\n${ev.ocr_text}\n\n`;
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let respText;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: DIAGNOSIS_SUGGESTION_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_completion_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
      });
      respText = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }

    const data = JSON.parse(respText);
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) return [];

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return [];
      parsed = JSON.parse(m[0]);
    }

    const raw = Array.isArray(parsed.suggested_codes) ? parsed.suggested_codes : [];
    const out = [];
    for (const entry of raw) {
      const { page_number: pageNum, quotation } = entry || {};
      if (!quotation || !pageNum) continue;
      if (!validateQuotation(quotation, pageNum, evidencePool)) {
        console.warn(`[AI-REVIEW] Fallback saran diagnosis: kutipan tidak cocok di halaman ${pageNum}, dibuang.`);
        continue;
      }
      if (hasFinancialTerms(quotation) || hasFinancialTerms(entry.reasoning)) continue;
      out.push({
        code: entry.code, type: 'diagnosis', page_number: pageNum,
        quotation: quotation.substring(0, 200),
        reasoning: (entry.reasoning || '').substring(0, 200),
      });
    }
    return out;
  } catch (error) {
    console.warn(`[AI-REVIEW] Fallback saran diagnosis gagal: ${error.message}`);
    return [];
  }
}

// ============================================================================
// KEGAWATDARURATAN -- restrukturisasi TOTAL 10-11 Sep 2026: dari "AI menilai
// gawat/tidak per kriteria a-e secara freeform" jadi 3-tabel (Parameter,
// Ambang Batas, Agregasi Kriteria K1-K5) -- lihat kegawatdaruratanReference.js
// & kegawatdaruratanAggregation.js. AI SEKARANG HANYA mengekstrak data mentah
// (parameter fisik + nilai vital + K1 yang tetap butuh pemahaman bahasa),
// K2-K5 dihitung deterministik oleh kode dari hasil ekstraksi itu -- BUKAN
// lagi AI yang "menilai gawat atau tidak" untuk K2-K5. Alasan: (1) lebih
// murah -- ekstraksi angka mentah jauh lebih ringan dari judgment freeform,
// (2) hasil konsisten untuk nilai yang sama (tidak tergantung "mood" model
// tiap panggilan), (3) auditable -- ambang batas & aturan agregasi ada di
// kode, bisa diperiksa/diubah tanpa menebak apa yang "dipikirkan" AI.
// ============================================================================
const KEGAWATDARURATAN_SYSTEM_PROMPT = `Kamu perawat/verifikator yang mengekstrak data MENTAH dari dokumentasi
klinis sebuah rumah sakit, untuk dipakai sistem menilai 5 kriteria kegawatdaruratan resmi Pasal 3 ayat (2)
Permenkes RI No. 47 Tahun 2018 (K1-K5).

TUGAS: kamu diberi teks halaman dari DUA kemungkinan sumber dokumen -- TRIASE IGD (SELALU ada) dan, kalau
tersedia, RESUME MEDIS RAWAT INAP (OPSIONAL, dilabeli jelas dengan header "=== RESUME MEDIS RAWAT INAP ==="
di teks yang diberikan kalau ada) -- Tugasmu MURNI EKSTRAKSI DATA MENTAH apa adanya, BUKAN menilai gawat/
tidak gawat (K2-K5 dihitung OTOMATIS oleh sistem dari data yang kamu ekstrak, memakai tabel ambang batas
baku) -- KECUALI Bagian 3 (K1) yang tetap butuh penilaian bahasamu. PENTING soal sumber: Bagian 1 (parameter
pemeriksaan fisik) BOLEH memakai KEDUA sumber (lihat aturan prioritas di Bagian 1) -- tapi Bagian 2 (nilai
vital) dan Bagian 3 (K1) WAJIB HANYA memakai teks TRIASE IGD, JANGAN memakai Resume Medis Rawat Inap untuk
kedua bagian itu sama sekali, walau datanya ada di sana -- ini karena kriteria kegawatdaruratan resmi
menilai kondisi SAAT TRIASE, bukan sepanjang rawat inap; Resume Medis di sini HANYA untuk melengkapi Tabel 1
sebagai konteks tambahan kalau Triase tidak mencatatnya.

FORMULIR TRIASE IGD di RS ini biasanya berisi bagian-bagian berlabel berikut (nama section PERSIS seperti
yang tercetak, tapi tata letak bisa sedikit beda antar dokumen):
- "VITAL SIGN" — tabel BB, TB, TD, Heart Rate, RR, Temp, kadang SpO2
- "PRIMARY SURVEY" — baris Airway/Breathing/Circulation/Disability/Exposure
- "KESADARAN PASIEN / GCS" — rincian Buka mata (E)/Respon Verbal (V)/Respon Motorik (M), baris "Hasil"
- "Skala Nyeri" — VAS/NRS 0-10
- "PSIKOSOSIAL/SPIRITUAL" (termasuk baris SIRS/Suicidal Intention Rating Scale kalau ada)
- Pemeriksaan fisik (ronkhi, wheezing, SDV, retraksi, sianosis, akral, CRT, edema, bunyi jantung,
  deformitas/luka) bisa tersebar di beberapa bagian (KEADAAN UMUM, PRIMARY SURVEY, pemeriksaan fisik
  tambahan) — cari di semua bagian, jangan cuma satu section.
Kalau dokumen tidak memakai label section persis seperti di atas, tetap cari data setara secara maknanya.

=== BAGIAN 1: EKSTRAK 16 PARAMETER PEMERIKSAAN FISIK ===
CATATAN NOTASI & SINGKATAN (baca ini dulu sebelum ekstraksi Bagian 1 -- dokumen RS ini sering pakai notasi
singkat, bukan kalimat lengkap):
- Notasi tanda: "+" = ada/positif, "-" atau "−" = tidak ada/negatif. Untuk pasangan sisi kanan/kiri: "+/+" =
  ada di kedua sisi (bilateral), "-/-" = tidak ada di kedua sisi, "+/-" = ada di kanan tidak di kiri, "-/+" =
  ada di kiri tidak di kanan (konvensi urutan kanan-dulu-baru-kiri) -- untuk menentukan status normal/abnormal
  di bawah ini, sisi kanan/kiri TIDAK krusial, yang penting apakah SALAH SATU sisi "+".
- Kamus singkatan pemeriksaan fisik yang sering dipakai RS ini (kenali variasi ejaan): "Rh"/"ronchi"/"ronkhi"
  = ronki; "Wh"/"whezing"/"wheezing" = mengi (catat: ejaan "whezing" -- kurang huruf "e" -- tetap WAJIB
  dikenali sebagai wheezing, ini typo umum di dokumen RS ini bukan istilah lain); "SDV" = suara dasar
  vesikuler; "pulmo" = paru; "ku" = keadaan umum; "cm" = compos mentis (sadar penuh); "sdg" = sedang; "eks" =
  ekstremitas; "akral" = akral; "oedema"/"edema" = edema; "CRT" = capillary refill time; "abd" = abdomen;
  "supel" = lemas/tidak tegang (abdomen tidak kaku); "S1 S2" = bunyi jantung I & II; "sesak"/"sesek" = sesak
  napas; "obs" = observasi (diagnosis berawalan "obs", mis. "obs asma attack", berarti dokter masih menduga
  BELUM final -- kalau ini relevan ke penilaian K1 di Bagian 3, JANGAN perlakukan sebagai diagnosis final).
- PRIORITAS SUMBER (WAJIB, ini akar masalah yang sering bikin salah pilih bukti): kalau parameter yang sama
  disebutkan di DUA bagian berbeda dalam dokumen yang sama -- bagian KELUHAN/anamnesis (laporan subjektif
  pasien/keluarga, mis. "nafas berbunyi mengi") DAN bagian PEMERIKSAAN FISIK (temuan objektif dokter/perawat,
  mis. "pulmo ronchi +/+ whezing +/+") -- WAJIB utamakan kutipan dari PEMERIKSAAN FISIK, JANGAN dari Keluhan,
  karena itu bukti objektif dokter bukan laporan subjektif orang tua/pasien. Baca SELURUH bagian Pemeriksaan
  Fisik dulu sebelum menyerah dan memakai kutipan dari Keluhan untuk parameter yang sama.
- Field "CA" (conjunctiva anemis) dan "SI" (sklera ikterik) bisa muncul di teks pemeriksaan mata -- keduanya
  BUKAN salah satu dari 16 parameter di bawah, JANGAN dipetakan ke parameter manapun. Khusus "SI": dalam
  konteks pemeriksaan fisik/mata ini artinya sklera ikterik, BUKAN field "SI" INA-CBG/tarif -- jangan tertukar.

Untuk TIAP parameter di bawah: cari DULU di teks TRIASE IGD. Kalau TIDAK disebutkan di Triase IGD SAMA
SEKALI DAN teks Resume Medis Rawat Inap TERSEDIA (lihat header di atas), boleh cari di sana juga sebagai
pelengkap -- TAPI kalau parameter itu disebutkan di KEDUA sumber, WAJIB pakai kutipan dari Triase IGD
(sumber utama), JANGAN dari Resume Medis. Laporkan status "normal" (sesuai contoh nilai normal) atau
"abnormal" (sesuai contoh nilai abnormal) HANYA kalau ada kutipan eksplisit. Kalau parameter itu TIDAK
disebutkan sama sekali di KEDUA sumber, JANGAN mengarang — laporkan "ditemukan":false, "status":null.
- ronkhi (Rh): normal="(-/-)", abnormal="(+/+) atau sejenis (ada ronkhi)"
- wheezing (Wh): normal="(-/-)", abnormal="(+/+) atau sejenis (ada wheezing)"
- sdv (suara napas dasar/SDV): normal="vesikuler (+/+)", abnormal="menurun/menghilang"
- retraksi (retraksi dinding dada): normal="tidak ada", abnormal="ada (ringan/sedang/berat)" -- KHUSUS
  parameter ini SAJA (bukan 10 parameter lain), kalau abnormal DAN dokumen menyebutkan LOKASI retraksi
  secara eksplisit, isi juga field "retraksi_grade": "subkostal" (retraksi di BAWAH tulang rusuk/tulang
  dada, distres napas derajat biasa) atau "interkostal" (retraksi di SELA-SELA tulang rusuk, tanda distres
  napas LEBIH BERAT per PNPK Tatalaksana Pneumonia pada Anak IDAI). Kalau dokumen HANYA bilang "retraksi
  (+)"/"retraksi dinding dada (+)" TANPA sebutan lokasi spesifik, isi "retraksi_grade":null -- JANGAN
  menebak salah satu kalau tidak disebut eksplisit. Field ini TIDAK berlaku untuk 10 parameter lain
  (biarkan null/tidak usah diisi untuk parameter selain retraksi).
- sianosis: normal="tidak ada", abnormal="ada (perioral/perifer/sentral)"
- akral: normal="hangat, kering", abnormal="dingin, basah, pucat"
- crt (capillary refill time): normal="<2 detik", abnormal=">=2 detik"
- edema (edema ekstremitas): normal="tidak ada/(-/-/-/-)", abnormal="ada, derajat/pitting"
- bunyi_jantung (bunyi jantung tambahan): normal="reguler, tanpa murmur", abnormal="gallop/murmur"
- kesadaran_kualitatif: normal="compos mentis", abnormal="somnolen/sopor/koma/delirium"
- deformitas_luka: normal="tidak ada", abnormal="ada, deskripsi luka/cedera"
- kepala (kepala/wajah, TERMASUK mukosa mulut/bibir/konjungtiva -- dipakai kalau dokumen menyebut kondisi
  mukosa, mis. "mukosa kering"/"mukosa lembab", tanpa section "kepala" eksplisit): normal="normocephal, mukosa
  lembab", abnormal="mukosa kering/pucat/ikterik, atau deformitas kepala/wajah"
- leher: normal="tidak ada pembesaran KGB/tiroid, kaku kuduk (-)", abnormal="ada pembesaran KGB/tiroid, atau
  kaku kuduk (+)"
- thorak (dari baris "KEADAAN"/pemeriksaan fisik region toraks -- BEDA dari ronkhi/wheezing/sdv/retraksi di
  atas yang lebih spesifik; thorak di sini rangkuman umum bentuk/simetri dada, BOLEH tumpang tindih narasi):
  normal="simetris, tidak ada jejas/retraksi", abnormal="asimetris/jejas/retraksi/nyeri tekan dada"
- abdomen (mis. "abd supel bu+" = abdomen supel, bising usus positif = NORMAL): normal="supel, bising usus
  (BU) normal", abnormal="distensi/nyeri tekan/BU abnormal (meningkat/menurun/tidak ada)"
- ekstremitas (KEADAAN umum ekstremitas -- BEDA dari parameter "edema" & "akral" & "crt" di atas yang lebih
  spesifik; ekstremitas di sini rangkuman umum bentuk/gerak, BOLEH tumpang tindih narasi): normal="tidak ada
  kelainan bentuk/gerak", abnormal="ada kelainan bentuk/gerak/kelemahan"
Untuk 5 parameter baru ini (kepala/leher/thorak/abdomen/ekstremitas), cari juga di baris "PRIMARY SURVEY"
(Airway/Breathing/Circulation/Disability/Exposure) kalau tabel "KEADAAN" tidak ada -- mis. "Exposure: Clear"
tanpa rincian lebih lanjut TETAP boleh dipetakan sebagai status normal untuk parameter yang relevan HANYA
kalau redaksinya eksplisit menyebut region itu baik-baik saja, JANGAN menebak dari "Clear" umum saja tanpa
konteks region yang jelas.

=== BAGIAN 2: EKSTRAK 7 NILAI VITAL/SKOR MENTAH (HANYA dari TRIASE IGD) ===
WAJIB HANYA cari di teks TRIASE IGD untuk bagian ini -- JANGAN pakai Resume Medis Rawat Inap sama sekali
walau nilai vitalnya ada di sana, karena kriteria menilai kondisi SAAT TRIASE. Untuk TIAP parameter, ekstrak
NILAI NUMERIK MENTAH (BUKAN kesimpulan normal/abnormal — band dihitung sistem dari angka ini). Kalau tidak
tercatat sama sekali di Triase IGD, "nilai":null — JANGAN mengarang angka, dan JANGAN ambil dari Resume
Medis walau ada di sana.
- RR: laju napas, x/menit
- SpO2: saturasi oksigen, %
- HR: heart rate/nadi, x/menit
- TD_sistolik: angka SISTOLIK saja dari tekanan darah (mis. dari "120/80 mmHg", ambil 120)
- TD_diastolik: angka DIASTOLIK saja dari tekanan darah (mis. dari "120/80 mmHg", ambil 80) -- SATU kutipan
  baris yang sama boleh dipakai utk TD_sistolik DAN TD_diastolik (biasanya tercatat bersamaan format "X/Y mmHg")
- Suhu: derajat Celcius
- GCS: skor GCS TOTAL (3-15). Kalau formulir cuma mencantumkan rincian E/V/M (bukan angka total tercetak),
  HITUNG sendiri: E(Eye) 1-4 [4=spontan,3=thd suara,2=thd nyeri,1=tidak ada], V(Verbal) 1-5 [5=orientasi
  baik,4=bingung,3=kata tak jelas,2=suara tak jelas,1=tidak ada], M(Motorik) 1-6 [6=menurut perintah,
  5=melokalisir nyeri,4=withdrawal,3=fleksi abnormal,2=ekstensi abnormal,1=tidak ada], total=E+V+M. Kalau
  formulir HANYA mencantumkan label kualitatif "Compos Mentis" TANPA rincian E/V/M sama sekali, boleh
  petakan "Compos Mentis"=15 — tapi cari rincian E/V/M eksplisit DULU sebelum pakai pemetaan ini.
- Nyeri: skala nyeri 0-10. Kalau ada baris "INSTRUMEN SKALA NYERI YANG DIHARAPKAN" di awal pesan ini, itu
  petunjuk notasi yang KEMUNGKINAN dipakai formulir untuk usia pasien ini (mis. FLACC anak kecil sering
  berupa penjumlahan 5 komponen 0-2 atau checklist wajah/gerakan, BUKAN angka polos seperti VAS dewasa) —
  pakai sebagai petunjuk cara membaca, TAPI tetap catat instrumen APAPUN yang benar-benar tercantum di
  formulir (VAS/NRS/FLACC/Wong-Baker/lainnya), jangan paksakan instrumen yang beda dari yang tertulis
Field "kutipan" WAJIB kutipan verbatim baris tempat nilai itu tercatat (mis. "TD 120/80 mmHg", "RR 22
x/mnt"), field "page_number" WAJIB nomor halaman tempat kutipan itu berada.

=== BAGIAN 3: K1 — PENILAIAN BAHASA (HANYA dari TRIASE IGD, bukan ekstraksi angka, tetap butuh judgmentmu) ===
WAJIB HANYA cari di teks TRIASE IGD untuk bagian ini -- JANGAN pakai Resume Medis Rawat Inap sama sekali,
sama seperti Bagian 2. K1 (Mengancam nyawa, membahayakan diri sendiri/orang lain/lingkungan): cari kata
kunci EKSPLISIT di anamnesis/keluhan/PSIKOSOSIAL (baris SIRS/Suicidal Intention Rating Scale kalau ada) di
TRIASE IGD yang menunjukkan risiko
bunuh diri, membahayakan diri sendiri, membahayakan orang lain, atau bahaya lingkungan (mis. percobaan bunuh
diri, ancaman kekerasan, overdosis sengaja, dsb). "status":"ya" HANYA kalau ADA kutipan eksplisit yang
mendukung — JANGAN simpulkan dari nama diagnosis semata (mis. "sesak napas" TIDAK otomatis K1). Field
"kutipan" WAJIB diisi kalau status "ya". Field "catatan" (1 kalimat Indonesia) jelaskan singkat alasannya.

=== BAGIAN 4: TINDAKAN KEPERAWATAN SEGERA & SKOR ESI (HANYA dari TRIASE IGD) === (ditambah 19 Sep 2026, fix
item 5 -- PROCLIST cuma berisi kode ICD-9-CM final e-Klaim, TIDAK PERNAH mencatat tindakan keperawatan yang
dilakukan SAAT TRIASE sebagai teks naratif, mis. "IVFD asering loading 250cc lanjut 20tpm". Sistem butuh
teks tindakan itu APA ADANYA -- JANGAN menilai sendiri apakah itu "tindakan segera" atau bukan, itu
keputusan kode deterministik di luar prompt ini berdasarkan rules terpisah.)
WAJIB HANYA cari di teks TRIASE IGD (sama seperti Bagian 2 & 3). Ekstrak:
- "tindakan_keperawatan": array tindakan/intervensi yang tercatat DILAKUKAN (bukan direncanakan/instruksi
  dokter yang belum dikerjakan) di Triase IGD -- mis. pemasangan infus/IVFD (sertakan detail cairan/rate
  kalau ada), pemberian oksigen, injeksi obat, pemasangan NGT, dst. Untuk TIAP tindakan: quotation WAJIB
  kutipan verbatim baris tempat tindakan itu tercatat, page_number nomor halamannya. Kalau tidak ada tindakan
  tercatat sama sekali, array kosong [] -- JANGAN mengarang.
- "esi": skor ESI (Emergency Severity Index, skala 1-5, kalau formulir mencantumkannya -- kadang berlabel
  "ESI", "Triage Level", atau "Level"). Kalau ADA, isi {"skor":N,"page_number":N,"kutipan":"..."}. Kalau
  TIDAK dicantumkan sama sekali di formulir, isi {"skor":null,"page_number":null,"kutipan":null} -- JANGAN
  menebak/menghitung skor ESI sendiri dari kondisi klinis, HANYA laporkan angka yang benar-benar tercetak.

ATURAN ANTI-HALUSINASI (WAJIB untuk SEMUA field kutipan di KEEMPAT bagian):
- SEMUA "kutipan"/"quotation" WAJIB kutipan PERSIS dari teks yang diberikan — DILARANG mengarang/parafrase.
- "page_number" WAJIB sesuai halaman tempat kutipan itu benar-benar ada di teks yang diberikan.
- DILARANG KERAS menyebut nominal rupiah/biaya di kutipan/catatan manapun.
- Kalau parameter/nilai TIDAK ditemukan sama sekali, laporkan "ditemukan":false (Bagian 1) atau "nilai":null
  (Bagian 2) — JANGAN diam-diam hilangkan field itu dari output, dan JANGAN mengarang supaya "lengkap".

Output HANYA JSON, tanpa markdown/penjelasan, PERSIS struktur ini (parameter_findings WAJIB 16 entri, key
harus persis seperti di atas; vital_findings WAJIB 8 key seperti di atas):
{
  "parameter_findings": [
    {"key":"ronkhi","ditemukan":true/false,"status":"normal"|"abnormal"|null,"nilai":"kutipan singkat nilai apa adanya atau null","page_number":N,"kutipan":"..."},
    {"key":"retraksi","ditemukan":true/false,"status":"normal"|"abnormal"|null,"nilai":"...","page_number":N,"kutipan":"...","retraksi_grade":"subkostal"|"interkostal"|null}
  ],
  "vital_findings": {
    "RR": {"nilai":N,"page_number":N,"kutipan":"..."},
    "SpO2": {"nilai":N,"page_number":N,"kutipan":"..."},
    "HR": {"nilai":N,"page_number":N,"kutipan":"..."},
    "TD_sistolik": {"nilai":N,"page_number":N,"kutipan":"..."},
    "TD_diastolik": {"nilai":N,"page_number":N,"kutipan":"..."},
    "Suhu": {"nilai":N,"page_number":N,"kutipan":"..."},
    "GCS": {"nilai":N,"page_number":N,"kutipan":"..."},
    "Nyeri": {"nilai":N,"page_number":N,"kutipan":"..."}
  },
  "k1": {"status":"ya"|"tidak","page_number":N,"kutipan":"...","catatan":"..."},
  "tindakan_keperawatan": [{"quotation":"...","page_number":N}],
  "esi": {"skor":N,"page_number":N,"kutipan":"..."}
}`;

/**
 * Panggilan AI TERPISAH & FOKUS untuk EKSTRAKSI data Kegawatdaruratan
 * (Permenkes 47/2018 Pasal 3, K1-K5) — AI ekstrak data mentah saja (Bagian
 * 1+2) + judgment K1 (Bagian 3); K2-K5 dihitung deterministik di kode lewat
 * aggregateKriteria() setelah quote-validation, TIDAK ada AI judgment untuk
 * K2-K5 lagi. Restrukturisasi total 10-11 Sep 2026 (sebelumnya: AI menilai
 * true/false freeform utk 5 kriteria a-e sekaligus, lihat histori git untuk
 * versi lama kalau perlu).
 * @param {Array} evidencePool - [{page_number, ocr_text, confidence}]
 * @param {Array<number>} triagePageNumbers - Halaman yang benar-benar Triase IGD
 * @param {string|number} [umurTahun] - Umur pasien tahun (untuk kelompok usia ambang batas)
 * @param {string|number} [umurHari] - Umur pasien hari (untuk neonatus/bayi <1 tahun)
 * @param {Array<string>} [procedureCodes] - PROCLIST record ini (untuk K5, tidak butuh AI)
 * @returns {Promise<{ringkasan:string, parameter_findings:Array, vital_findings:Object, kriteria:Array}>}
 */
async function assessKegawatdaruratan(evidencePool, triagePageNumbers, umurTahun, umurHari, procedureCodes = [], resumeMedisPageNumbers = []) {
  const ageGroup = resolveAgeGroup(umurTahun, umurHari);
  // Instrumen skala nyeri yang diharapkan untuk usia pasien ini (4-tier,
  // dihitung DI SINI dari umur -- bukan AI -- jadi konsisten & auditable,
  // dipakai sbg petunjuk di prompt DAN ditempel ke output Nyeri apa adanya).
  const painInstrument = resolvePainInstrument(umurTahun, umurHari, ageGroup);
  const emptyResult = (catatan) => ({
    ringkasan: catatan,
    parameter_findings: PARAMETER_TABLE.map(p => ({ key: p.key, label: p.label, ditemukan: false, status: null, nilai: null, page_number: null, kutipan: null, sumber_dokumen: null, ...(p.key === 'retraksi' ? { retraksi_grade: null } : {}) })),
    vital_findings: Object.fromEntries(['RR', 'SpO2', 'HR', 'TD_sistolik', 'TD_diastolik', 'Suhu', 'GCS', 'Nyeri'].map(k =>
      [k, {
        nilai: null, band: null, page_number: null, kutipan: null,
        // Tri-state (fix item 4, 19 Sep 2026): tanpa halaman Triase IGD sama
        // sekali TIDAK BISA menentukan not_in_form vs empty_on_form secara
        // andal (tidak ada teks buat dicek) -- fallback 'empty_on_form'
        // (perilaku lama, tetap tampilkan sebagai perlu dicek) daripada diam-
        // diam menyembunyikannya sebagai not_in_form tanpa dasar.
        form_status: 'empty_on_form',
        ...(k === 'Nyeri' ? { instrumen_diharapkan: painInstrument } : {}),
      }])),
    kriteria: aggregateKriteria([], {}, null, procedureCodes, [], null),
    tindakan_keperawatan: [],
    esi: { skor: null, page_number: null, kutipan: null },
    age_group: ageGroup,
  });

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const triagePages = evidencePool.filter(p => triagePageNumbers.includes(p.page_number));
  if (!apiKey || triagePages.length === 0) return emptyResult('Penilaian Kegawatdaruratan tidak dijalankan — tidak ada halaman Triase IGD.');
  // Resume Medis Rawat Inap -- KONTEKS TAMBAHAN saja untuk Tabel 1 (keputusan
  // 11 Sep 2026, Opsi A), TIDAK mempengaruhi Bagian 2/3 atau agregasi K1-K5
  // (lihat catatan di getResumeMedisPageNumbers & prompt Bagian 1-3 di atas).
  const resumeMedisPages = evidencePool.filter(p => resumeMedisPageNumbers.includes(p.page_number));

  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  let userPrompt = umurTahun ? `UMUR_TAHUN pasien: ${umurTahun}\n\n` : '';
  if (painInstrument) userPrompt += `INSTRUMEN SKALA NYERI YANG DIHARAPKAN untuk pasien usia ini: ${painInstrument}\n\n`;
  userPrompt += '=== TRIASE IGD ===\nTEKS HALAMAN TRIASE IGD (sumber utama, WAJIB untuk Bagian 2 & 3):\n================================\n';
  const sorted = [...triagePages].sort((a, b) => a.page_number - b.page_number);
  for (const ev of sorted) {
    userPrompt += `=== Halaman ${ev.page_number} ===\n${ev.ocr_text}\n\n`;
  }
  if (resumeMedisPages.length > 0) {
    userPrompt += '=== RESUME MEDIS RAWAT INAP ===\nTEKS HALAMAN RESUME MEDIS RAWAT INAP (KONTEKS TAMBAHAN untuk Bagian 1 SAJA -- ' +
      'JANGAN dipakai untuk Bagian 2 atau Bagian 3):\n================================\n';
    const sortedResume = [...resumeMedisPages].sort((a, b) => a.page_number - b.page_number);
    for (const ev of sortedResume) {
      userPrompt += `=== Halaman ${ev.page_number} ===\n${ev.ocr_text}\n\n`;
    }
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let respText;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: KEGAWATDARURATAN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          // 2000 cukup untuk output lama (5 kriteria a-e), TAPI TIDAK CUKUP untuk
          // skema baru (11 parameter + 7 vital + K1, tiap field ada kutipan) --
          // ditemukan lewat verifikasi nyata: SEP 0170R0110426V000098 terpotong
          // persis di completion=2000, JSON tidak valid, hasil jatuh ke
          // emptyResult diam-diam (tidak ada log jelas karena gagal di parse,
          // bukan di HTTP/exception level). Naikkan ke 3500 dengan margin.
          // Naikkan LAGI ke 4200 (19 Sep 2026, fix item 5/6): Bagian 1 nambah 5
          // parameter (11->16) + Bagian 4 baru (tindakan_keperawatan + esi) --
          // output makin panjang, risiko kepotong sama seperti kasus di atas.
          max_completion_tokens: 4200,
          response_format: { type: 'json_object' },
        }),
      });
      respText = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }

    const data = JSON.parse(respText);
    console.warn(`[AI-REVIEW] assessKegawatdaruratan tokens: prompt=${data.usage?.prompt_tokens ?? '?'} completion=${data.usage?.completion_tokens ?? '?'} total=${data.usage?.total_tokens ?? '?'}`);
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) {
      console.warn('[AI-REVIEW] assessKegawatdaruratan: respons AI kosong.');
      return emptyResult('Penilaian Kegawatdaruratan gagal dibuat — coba Baca Ulang.');
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) {
        // Kemungkinan besar output KEPOTONG (kena max_completion_tokens) --
        // finish_reason 'length' + content tidak diakhiri '}' yang matching.
        console.warn(`[AI-REVIEW] assessKegawatdaruratan: gagal parse JSON (kemungkinan terpotong, finish_reason=${data.choices?.[0]?.finish_reason ?? '?'}, panjang content=${content.length}).`);
        return emptyResult('Penilaian Kegawatdaruratan gagal dibuat — coba Baca Ulang.');
      }
      parsed = JSON.parse(m[0]);
    }

    // --- Validasi & bangun parameter_findings (Bagian 1, anti-halusinasi) ---
    // Sumber diterima: TRIASE IGD (utama) ATAU RESUME MEDIS RAWAT INAP
    // (konteks tambahan, Opsi A 11 Sep 2026) -- page_number WAJIB masuk
    // salah satu daftar ini, kalau tidak (mis. halaman lain sama sekali)
    // ditolak sama seperti sebelumnya. sumber_dokumen dihitung DI SINI dari
    // page_number, BUKAN dipercaya dari klaim AI -- supaya tidak bisa salah
    // label sumber walau AI keliru.
    const validParamPages = new Set([...triagePageNumbers, ...resumeMedisPageNumbers]);
    const rawParams = Array.isArray(parsed.parameter_findings) ? parsed.parameter_findings : [];
    const paramByKey = new Map(rawParams.map(p => [p?.key, p]));
    const parameterFindings = PARAMETER_TABLE.map(spec => {
      const p = paramByKey.get(spec.key);
      if (!p || p.ditemukan !== true) return { key: spec.key, label: spec.label, ditemukan: false, status: null, nilai: null, page_number: null, kutipan: null, sumber_dokumen: null };
      const validQuote = p.kutipan && p.page_number
        && validParamPages.has(p.page_number)
        && validateQuotation(p.kutipan, p.page_number, evidencePool) && !hasFinancialTerms(p.kutipan);
      if (!validQuote) return { key: spec.key, label: spec.label, ditemukan: false, status: null, nilai: null, page_number: null, kutipan: null, sumber_dokumen: null };
      const status = p.status === 'abnormal' ? 'abnormal' : p.status === 'normal' ? 'normal' : null;
      const sumberDokumen = triagePageNumbers.includes(p.page_number) ? 'triase_igd' : 'resume_medis';
      // retraksi_grade: HANYA berlaku utk key 'retraksi', diabaikan (selalu null) utk 10
      // parameter lain -- dipakai assessPneumoniaSeverityMismatch (modul pneumonia J12-J18),
      // TIDAK dipakai aggregateKriteria (K2 tetap murni cek status==='abnormal', tidak berubah).
      const retraksiGrade = spec.key === 'retraksi' && (p.retraksi_grade === 'subkostal' || p.retraksi_grade === 'interkostal')
        ? p.retraksi_grade : null;
      return {
        key: spec.key, label: spec.label, ditemukan: true, status,
        nilai: typeof p.nilai === 'string' ? p.nilai.substring(0, 100) : null,
        page_number: p.page_number, kutipan: p.kutipan.substring(0, 200),
        sumber_dokumen: sumberDokumen,
        ...(spec.key === 'retraksi' ? { retraksi_grade: retraksiGrade } : {}),
      };
    });

    // --- Validasi & bangun vital_findings (Bagian 2) + hitung band via lookupBand ---
    const rawVitals = parsed.vital_findings && typeof parsed.vital_findings === 'object' ? parsed.vital_findings : {};
    const vitalFindings = {};
    for (const key of ['RR', 'SpO2', 'HR', 'TD_sistolik', 'TD_diastolik', 'Suhu', 'GCS', 'Nyeri']) {
      const v = rawVitals[key];
      const nilai = v && Number.isFinite(Number(v.nilai)) ? Number(v.nilai) : null;
      const validQuote = nilai !== null && v.kutipan && v.page_number
        && triagePageNumbers.includes(v.page_number)
        && validateQuotation(v.kutipan, v.page_number, evidencePool) && !hasFinancialTerms(v.kutipan);
      const nyeriExtra = key === 'Nyeri' ? { instrumen_diharapkan: painInstrument } : {};
      // Tri-state (fix item 4, 19 Sep 2026): bedakan "kolomnya ada di form tapi
      // kosong" (empty_on_form, perlu ditindak) dari "form ini memang tidak
      // punya kolom itu" (not_in_form, BUKAN masalah -- mis. SpO2 tidak
      // dicetak di form Triase IGD RS ybs). Deterministik (regex ke teks
      // mentah halaman Triase), lihat documentFieldTemplate.js.
      const formStatus = resolveFieldFormStatus(key, 'triase_igd', triagePages, validQuote);
      if (!validQuote) {
        vitalFindings[key] = { nilai: null, band: null, page_number: null, kutipan: null, form_status: formStatus, ...nyeriExtra };
        continue;
      }
      vitalFindings[key] = {
        nilai, band: ageGroup ? lookupBand(key, nilai, ageGroup) : null,
        page_number: v.page_number, kutipan: v.kutipan.substring(0, 200),
        form_status: formStatus,
        ...nyeriExtra,
      };
    }

    // --- Validasi K1 (Bagian 3, tetap AI judgment) ---
    const rawK1 = parsed.k1 || {};
    let k1Result = { status: 'tidak', page_number: null, kutipan: null, catatan: '' };
    if (rawK1.status === 'ya') {
      const validQuote = rawK1.kutipan && rawK1.page_number
        && triagePageNumbers.includes(rawK1.page_number)
        && validateQuotation(rawK1.kutipan, rawK1.page_number, evidencePool) && !hasFinancialTerms(rawK1.kutipan);
      if (validQuote) {
        k1Result = {
          status: 'ya', page_number: rawK1.page_number, kutipan: rawK1.kutipan.substring(0, 200),
          catatan: typeof rawK1.catatan === 'string' && !hasFinancialTerms(rawK1.catatan) ? rawK1.catatan.trim().substring(0, 300) : '',
        };
      }
    }

    // --- Validasi tindakan_keperawatan & esi (Bagian 4, fix item 5) ---
    // Sama seperti Bagian 2/3: WAJIB dari Triase IGD saja, quote-validated
    // sama seperti field lain (anti-halusinasi, TIDAK ada pengecualian).
    const rawTindakan = Array.isArray(parsed.tindakan_keperawatan) ? parsed.tindakan_keperawatan : [];
    const tindakanKeperawatan = [];
    for (const t of rawTindakan) {
      const validQuote = t && t.quotation && t.page_number
        && triagePageNumbers.includes(t.page_number)
        && validateQuotation(t.quotation, t.page_number, evidencePool) && !hasFinancialTerms(t.quotation);
      if (validQuote) {
        tindakanKeperawatan.push({ quotation: String(t.quotation).substring(0, 200), page_number: t.page_number });
      }
    }
    // matchTindakanSegera (procedure_rules.json) dijalankan terhadap TEKS ASLI
    // halaman Triase (bukan terhadap tindakanKeperawatan hasil ekstraksi AI di
    // atas) -- deterministik murni, tidak tergantung AI menangkap semua
    // tindakan dengan benar. tindakanKeperawatan (ekstraksi AI, quote-
    // validated) tetap dikembalikan terpisah sebagai data mentah utk display.
    const tindakanSegeraMatches = matchTindakanSegera(triagePages);

    const rawEsi = parsed.esi || {};
    let esiResult = { skor: null, page_number: null, kutipan: null };
    if (Number.isFinite(Number(rawEsi.skor))) {
      const validQuote = rawEsi.kutipan && rawEsi.page_number
        && triagePageNumbers.includes(rawEsi.page_number)
        && validateQuotation(rawEsi.kutipan, rawEsi.page_number, evidencePool) && !hasFinancialTerms(rawEsi.kutipan);
      if (validQuote) {
        esiResult = { skor: Number(rawEsi.skor), page_number: rawEsi.page_number, kutipan: rawEsi.kutipan.substring(0, 200) };
      }
    }

    // --- Agregasi K1-K5 (murni kode, lihat kegawatdaruratanAggregation.js) ---
    // WAJIB pakai HANYA temuan bersumber Triase IGD -- temuan dari Resume
    // Medis Rawat Inap TETAP ditampilkan di parameter_findings (Tabel 1,
    // untuk konteks) tapi TIDAK BOLEH ikut menentukan verdict K1-K5 (Opsi A,
    // lihat catatan di getIgdTriagePageNumbers/getResumeMedisPageNumbers).
    const triageOnlyFindings = parameterFindings.filter(p => p.sumber_dokumen === 'triase_igd' || p.sumber_dokumen === null);
    const kriteria = aggregateKriteria(triageOnlyFindings, vitalFindings, k1Result, procedureCodes, tindakanSegeraMatches, esiResult.skor !== null ? esiResult : null);

    const ringkasan = buildRingkasan(kriteria, ageGroup);
    return {
      ringkasan, parameter_findings: parameterFindings, vital_findings: vitalFindings, kriteria,
      tindakan_keperawatan: tindakanKeperawatan, esi: esiResult, age_group: ageGroup,
    };
  } catch (error) {
    console.warn(`[AI-REVIEW] assessKegawatdaruratan gagal: ${error.message}`);
    return emptyResult('Penilaian Kegawatdaruratan gagal dibuat — coba Baca Ulang.');
  }
}

/**
 * Rangkuman singkat (ditampilkan sebelum Tabel 1 di UI) — dibangun dari hasil
 * agregasi yang SUDAH dihitung, murni kode, bukan panggilan AI tambahan.
 */
function buildRingkasan(kriteria, ageGroup) {
  const ya = kriteria.filter(k => k.status === 'ya').map(k => k.kriteria);
  const borderline = kriteria.filter(k => k.status === 'borderline').map(k => k.kriteria);
  const ageLabel = ageGroup ? AGE_GROUP_LABELS[ageGroup] : 'tidak diketahui';
  if (ya.length === 0 && borderline.length === 0) {
    return `Kelompok usia: ${ageLabel}. Tidak ada kriteria kegawatdaruratan (K1-K5) yang terpenuhi berdasarkan parameter dan nilai vital yang terekstrak dari formulir Triase IGD.`;
  }
  const parts = [];
  if (ya.length > 0) parts.push(`kriteria terpenuhi ("Ya"): ${ya.join(', ')}`);
  if (borderline.length > 0) parts.push(`kriteria borderline: ${borderline.join(', ')}`);
  return `Kelompok usia: ${ageLabel}. Berdasarkan parameter dan nilai vital yang terekstrak dari formulir Triase IGD, ${parts.join('; ')}. Lihat Tabel 1-3 di bawah untuk rincian dan bukti kutipan per kriteria.`;
}

const PENDING_RISK_SYSTEM_PROMPT = `Kamu asisten audit klaim BPJS E-Claim untuk perawat/verifikator rumah sakit.

TUGAS TUNGGAL: kamu diberi data satu rekam klaim (DATA REKAM KLAIM) dan teks lengkap dokumen pendukungnya
(BUKTI_DOKUMEN) — di luar validasi format (rule engine), periksa apakah rekam ini menunjukkan indikasi
salah satu pola berikut yang PALING SERING bikin klaim RS ini di-pending verifikator BPJS (diambil dari
data pending riil, sudah diurutkan dari yang paling sering). Rule engine TIDAK bisa mendeteksi pola ini
secara otomatis (butuh penilaian klinis atas isi dokumen). Kalau YA dan kamu bisa kutip kalimat PERSIS
dari dokumen sebagai dasarnya, laporkan di "pending_risk_notes". Kalau TIDAK ada indikasi, atau tidak ada
kutipan pasti, JANGAN laporkan apa pun untuk pola itu — lebih baik diam daripada menuduh salah.
PENTING — jenis klaim: field "JENIS_KLAIM"/"jenis_klaim" pada data rekam menunjukkan kategori pelayanan
(RAWAT_JALAN, RAWAT_INAP, atau GAWAT_DARURAT), dipilih sendiri oleh perawat saat upload — selalu akurat,
jangan diragukan. Pola-pola yang menyinggung rawat inap/ICU/LOS TIDAK relevan untuk RAWAT_JALAN.
   a. [kegawatan_lemah] — Khusus GAWAT_DARURAT (atau kunjungan IGD): keluhan/subjektif pasien HANYA
      menyebut nyeri/tidak nyaman tanpa tanda objektif pendukung, DAN tanda vital (TTV) yang tercatat
      normal semua. Kombinasi ini sering ditolak BPJS dengan alasan "tidak memenuhi kriteria gawat
      darurat". Jangan laporkan kalau ada tanda objektif abnormal (mis. TTV di luar normal, temuan
      pemeriksaan fisik abnormal) yang mendukung kegawatan — itu justru bukti kuat, bukan pola risiko.
      Konteks tambahan (SAMA PERSIS dengan RV-20 di rule engine, supaya catatanmu tidak beda pendapat
      dengan hasil validasi otomatis): kode "nyeri saja" yang jadi pemicu pola ini —
      R10.x, R51, R52, R07.x, M54.x, G43.x, M79.x. Kode kegawatan pendamping yang membatalkan pola ini
      kalau ADA — I21.x/I22.x/I46.x, J96.x/J18.x, N17.x/K35.x, R57.x/A41.x, R41.x.
      Kalau pola ini terdeteksi DAN UMUR_TAHUN pasien di bawah 7 tahun: note WAJIB menambahkan kalimat
      bahwa skala nyeri VAS tidak valid untuk usia ini, sarankan FLACC (Face Legs Activity Cry
      Consolability) atau Wong-Baker FACES, dan pastikan skala yang dipakai tercantum jelas di berkas
      — tapi HANYA sebagai saran umum, JANGAN mengklaim dokumen sudah/belum pakai skala tertentu
      kecuali kamu benar-benar melihat itu tertulis (kutip kalau ada, kalau tidak ada jangan menuduh).
      JANGAN usulkan penggantian kode diagnosis (mis. "ganti R10.9 jadi R10.0") — itu keputusan koder
      berdasarkan bukti klinis di dokumen yang cuma manusia yang boleh putuskan, bukan tabel umum ICD.
   b. [manifestasi_ikut_du] — Diagnosis sekunder (DS) di DIAGLIST (kode kedua dst.) yang secara medis
      cuma manifestasi/gejala langsung dari diagnosis utama (DU/kode pertama), bukan kondisi berdiri
      sendiri. BPJS sering minta kode manifestasi begini dihapus/tidak dikode terpisah dari DU-nya.
   c. [tb_level_fktp] — Diagnosis tuberkulosis (TB) tanpa komplikasi/penyulit yang tercatat, dengan
      tatalaksana berupa obat program TB rutin (OAT) — pelayanan ini biasanya cukup di FKTP
      (Puskesmas), bukan RS, kecuali ada bukti komplikasi/kegawatan di dokumen.
   d. [usg_berulang_tanpa_indikasi] — Prosedur USG obstetri (kehamilan) yang tercatat dilakukan lagi
      dalam kunjungan ini TANPA keluhan spesifik terkait kehamilan (mis. perdarahan, flek, nyeri perut
      hebat) yang tercatat di dokumen — USG rutin berulang tanpa indikasi klinis baru sering dipending.
   e. [rujuk_saja_tanpa_tindakan] — Dokumen menunjukkan kunjungan ini murni untuk MERUJUK pasien ke
      faskes lain (tanpa tindakan/terapi definitif di RS ini), tapi DIAGLIST belum/tidak memuat kode
      Z71.9 (konsultasi medis lain yang tidak diklasifikasikan) sebagai kode yang seharusnya dipakai
      untuk kunjungan rujukan-saja.
   f. [diagnosis_vitals_mismatch] — VERIFIKASI SILANG antara diagnosis (DIAGLIST di DATA REKAM KLAIM,
      atau uraian klinis di dokumen) dengan vital sign/Primary Survey yang TERCATAT di dokumen (halaman
      Triase IGD kalau ada, atau catatan vital sign lain). Laporkan HANYA kalau ada KETIDAKCOCOKAN nyata
      dan bisa dikutip dari KEDUA sisi (diagnosis DAN vital sign) — mis. diagnosis/uraian klinis menyiratkan
      kondisi berat (distress napas, syok, sepsis) tapi vital sign/Primary Survey yang tercatat NORMAL
      semua tanpa catatan abnormal apa pun; atau sebaliknya, vital sign jelas abnormal berat (mis. RR/nadi
      ekstrem, TD sangat rendah, ATAU TD sangat tinggi/krisis hipertensi mis. sistolik >180-200) tapi tidak
      ada satu pun diagnosis/tatalaksana di dokumen yang mencerminkan kegawatan itu -- kedua arah TD
      (sangat rendah MAUPUN sangat tinggi) sama-sama termasuk "abnormal berat" di sini, jangan cuma anggap
      TD rendah yang layak dicek. JANGAN laporkan hanya karena datanya SEDIKIT/kosong (itu ketiadaan data, bukan
      ketidakcocokan) — harus ada bukti eksplisit dari kedua sisi yang saling bertentangan. Field "basis"
      HARUS memuat KEDUA kutipan (diagnosis & vital sign), pisahkan dengan " || ".
      TD (tekanan darah) WAJIB jadi salah satu yang dicek di sini, bukan cuma RR/HR/suhu — verifikator BPJS
      dilaporkan sering menilai kecocokan TD terhadap diagnosis secara spesifik (bagian dari kriteria
      Circulation di ABCD, lihat Permenkes 47/2018 Pasal 3 angka 6e), jadi jangan lewati TD hanya karena
      parameter lain sudah dicek. Referensi kasar (BUKAN aturan resmi, cuma pola umum yang sering dipakai
      verifikator untuk menilai kewajaran — pakai sebagai sinyal tambahan, bukan ambang pasti): nyeri perut
      berat biasanya disertai HR >100 dan/atau TD >140 sistolik; sesak napas/PPOK biasanya disertai HR
      cepat, RR >20, (SpO2 <94% kalau tercatat). Kalau diagnosis mengarah ke kondisi semacam itu TAPI TD
      yang tercatat justru normal/rendah tanpa penjelasan lain, itu layak dilaporkan sebagai mismatch.
   g. [los_diagnosis_mismatch] — VERIFIKASI SILANG antara LOS (hitung sendiri dari ADMISSION_DATE dan
      DISCHARGE_DATE di DATA REKAM KLAIM, dalam hari — ini angka hasil hitung, BUKAN kutipan dokumen,
      jadi tidak perlu dicari teksnya) dengan diagnosis utama. Laporkan HANYA kalau LOS sangat pendek
      (1-2 hari) SEMENTARA diagnosis utama tergolong kondisi yang lazimnya butuh observasi/tatalaksana
      lebih lama secara medis umum (mis. sepsis, gagal napas, kondisi pasca-operasi mayor, infark, gagal
      jantung dekompensasi) — bukan untuk diagnosis ringan yang wajar pulang cepat (mis. observasi febris,
      gastroenteritis ringan). Ini SEKADAR sinyal untuk dicek verifikator (kenapa pulang cepat — membaik
      cepat? APS/pulang paksa? atau memang salah kode?), BUKAN tuduhan bahwa LOS/diagnosis salah. Field
      "basis" untuk pola INI KHUSUS diisi kutipan verbatim baris diagnosis dari dokumen (mis. "Diagnosis
      Utama: ...") — BUKAN kutipan tentang LOS/tanggal. Sebutkan LOS terhitung (dalam hari) di field
      "note".
   h. [komorbid_sekunder_tanpa_evaluasi] POLA PALING SERING dari data pending BPJS riil RS ini (Jan-Mei
      2026, sekitar 17 dari 96 kasus pending yang punya dokumen lengkap -- bucket TERBESAR, lebih sering
      dari pola lain manapun termasuk kegawatan_lemah). Klaim RAWAT_INAP dengan DIAGNOSIS SEKUNDER (DS,
      kode kedua dst di DIAGLIST) berupa kondisi kronis yang UMUMNYA STABIL: I10/I11.x/I15.x (hipertensi),
      E78.x (dislipidemia), E79.x (hiperurisemia/gout), E11.9 (DM tipe 2 TANPA komplikasi akut -- JANGAN
      untuk E11.0/E11.1/E11.2 dst yang MEMANG komplikasi akut, itu beda kasus) -- SEMENTARA diagnosis
      utama (DU) adalah kondisi LAIN yang tidak terkait (pola paling sering di data riil: operasi katarak
      elektif/H26.x, tapi bisa kondisi lain). Laporkan HANYA kalau dokumen menyebutkan penanganan DS itu
      SECARA GENERIK (mis. "mendapat terapi Sp.PD", "konsul Sp.PD", sebatas nama dokter spesialis plus
      "terapi") TANPA bukti evaluasi/tatalaksana YANG SPESIFIK UNTUK KRISIS akut kondisi itu -- evaluasi
      krisis yang MEMBATALKAN pola ini kalau ADA (jangan laporkan): penilaian kerusakan organ target
      (mis. EKG akut, funduskopi, fungsi ginjal yang memburuk KARENA kondisi itu), narasi eksplisit
      "krisis hipertensi" atau "hypertensive emergency/urgency", titrasi obat akut yang didokumentasikan
      terkait kondisi itu, atau pemantauan intensif (ICU/HCU) yang jelas UNTUK kondisi sekunder itu. TD
      tinggi SAJA (walau angkanya tinggi, mis. lebih dari 160/100) TIDAK otomatis membatalkan pola ini
      kalau tatalaksananya tetap cuma "terapi Sp.PD" generik tanpa evaluasi krisis spesifik -- data riil
      BPJS RS ini menunjukkan kasus dengan TD 160/100 pun tetap dipending kalau dokumentasinya cuma
      sebatas itu. Field "basis" kutip PERSIS narasi penanganan DS itu (mis. "mendapatkan terapi Sp.PD").
      Field "note" jelaskan diagnosis sekunder apa, kenapa penanganannya terkesan generik/tidak
      menunjukkan evaluasi krisis, dan sebutkan bahwa pola BA Kesepakatan RS ini secara historis sering
      meminta kondisi sekunder stabil semacam ini ditatalaksana rawat jalan kecuali ada bukti krisis --
      SARAN untuk dicek verifikator/koder (mis. lengkapi dokumentasi evaluasi krisis kalau memang ada,
      atau pertimbangkan apakah rawat inap sudah tepat), BUKAN tuduhan bahwa klaim ini pasti salah.
   i. [massa_jinak_tanpa_infiltrasi] Pola kedua PALING SERING dari data pending BPJS riil RS ini (Jan-Mei
      2026, sekitar 14 dari 96 kasus pending). Klaim RAWAT_INAP dengan tindakan eksisi massa/tumor/kista
      (kode prosedur eksisi mis. 86.3, diagnosis DU biasanya D21.x [neoplasma jinak jaringan ikat/lain],
      D17.x [lipoma], L72.0 [kista epidermoid/pilar], M71.26 [kista Baker], atau sejenis) DI MANA HASIL
      PEMERIKSAAN PATOLOGI ANATOMI (PA)/HISTOPATOLOGI yang terdokumentasi di berkas menyimpulkan (bagian
      "Kesimpulan") diagnosis histologi yang SECARA DEFINISI KLINIS berasal dari kulit/jaringan subkutan
      dan bersifat jinak -- misalnya (contoh, bukan daftar lengkap): kista epidermoid, kista pilar/pilar
      cyst, lipoma/benign mesenchymal neoplasm jenis adipocytic, fibroepithelial polyp, benign inclusion
      lession, callus/penebalan kulit, dan sejenisnya -- SELAMA "Sifat Keganasan"/kesimpulan histologi
      TIDAK menyebut keganasan, invasi ke fascia/otot/struktur vital, atau perluasan di luar kulit-subkutis.
      PENTING (temuan empiris dari data riil RS ini): kesimpulan histologi semacam itu SUDAH CUKUP sebagai
      bukti sifat superfisial/non-infiltratif -- ini textbook implisit dari diagnosisnya sendiri (lipoma/
      kista/callus secara definisi klinis terbatas di kulit-subkutan). JANGAN menunggu kalimat terpisah
      yang secara eksplisit menyebut kata "subkutan" atau "tidak menginfiltrasi fascia/otot" -- laporan PA
      RS ini pada praktiknya TIDAK menuliskan itu secara literal, cukup baris "Kesimpulan" diagnosis
      histologinya saja sebagai basis kutipan. Hasil PA (bukan sekadar kode diagnosis atau klaim naratif
      operator) adalah sumber bukti paling kuat untuk sifat massa di sini -- data riil RS ini menunjukkan
      BPJS tetap mempending klaim ini walau laporan operasi/resume dokter operator mengklaim sebaliknya
      (mis. "letak tumor dalam, menempel dasar otot", "risiko perdarahan besar") SELAMA kesimpulan PA
      resmi tetap berupa diagnosis histologi jinak superfisial semacam di atas -- jadi klaim naratif
      operator TANPA kesimpulan PA yang mendukungnya TIDAK otomatis membatalkan pola ini. Pola ini BERBEDA
      dari kasus "PA wajib dilakukan tapi belum/tidak dilakukan" -- itu bukan bagian pola ini (jangan
      laporkan pola ini kalau berkas justru menunjukkan PA belum dilakukan/hasil PA belum ada). JANGAN
      laporkan kalau KESIMPULAN PA ITU SENDIRI menyebut keganasan, invasi ke fascia/otot/struktur
      vital/tulang, atau margin sayatan positif mengenai jaringan dalam -- itu justru bukti kuat yang
      membatalkan pola ini, alasan medis sah untuk rawat inap. Field "basis" kutip PERSIS baris
      "Kesimpulan" dari hasil PA (mis. "Kesimpulan : Digiti V manus dextra : Benign mesenchymal neoplasm
      jenis adipocytic", atau "Kesimpulan : Kulit plantar pedis : Lesi jinak, pendapat callus"). Field
      "note" sebutkan diagnosis+kode, jelaskan kenapa kesimpulan histologi itu mengindikasikan massa
      jinak superfisial/non-infiltratif, dan sebutkan bahwa BA Kesepakatan RS ini secara historis sering
      meminta eksisi massa jinak superfisial semacam ini ditagihkan rawat jalan kecuali hasil PA
      menunjukkan keganasan/infiltrasi struktur vital -- SARAN untuk dicek verifikator/koder, BUKAN
      keputusan final.
   j. [diagnosis_evidence_mismatch] Perluasan pola diagnosis_vitals_mismatch (f) ke jenis bukti SELAIN
      vital sign -- pemeriksaan penunjang (kultur/lab) dan imaging -- untuk 2 kelompok diagnosis yang
      paling sering dipending BPJS RS ini karena ketiadaan bukti penunjang total (BUKAN soal kecukupan/
      durasi/jenis tatalaksana -- itu di luar kompetensimu, JANGAN menilai apakah suatu antibiotik
      "cukup kuat"/"lini berapa", HANYA cek ADA/TIDAK ADA bukti):
      (1) Infeksi (pneumonia/bronkopneumonia/BRPN kode J12-J18, sepsis kode A40-A41.x, atau ISK yang
      menyertai kode N30.x/N39.0 sebagai diagnosis): laporkan HANYA kalau dokumen SAMA SEKALI TIDAK
      menyebut satupun dari: (a) pemeriksaan kultur/gram/urine rutin/urinalisis DENGAN hasil (mis.
      "Bakteri +1", "Leukosit +2"), ATAU (b) nama obat antibiotik apapun (mis. ceftriaxone, cefotaxime,
      levofloxacin, ampicillin, meropenem, dll) di daftar terapi. Kalau SALAH SATU dari itu ADA di
      dokumen manapun (walau cuma satu), JANGAN laporkan -- ketiadaan SEBAGIAN bukan target pola ini,
      HANYA ketiadaan TOTAL.
      (2) Diagnosis serebrovaskular (stroke/TIA/infark serebral kode I60-I69.x atau G45.x) sebagai DU:
      laporkan HANYA kalau dokumen SECARA EKSPLISIT menyatakan pemeriksaan CT Scan/MRI kepala TIDAK
      dilakukan/tidak terambil (mis. "CT-Scan Non Kontras... tidak terambil karena pasien tidak
      transportable") ATAU SAMA SEKALI tidak ada satupun sebutan CT Scan/MRI/imaging kepala di seluruh
      dokumen. JANGAN laporkan kalau ada sebutan CT Scan/MRI dilakukan (termasuk cuma baris tagihan/
      billing "CT Scan") walau hasil interpretasinya tidak ikut terekstrak -- itu bukan ketiadaan
      pemeriksaan, cuma keterbatasan dokumen yang diunggah, bukan pola risiko ini.
      (3) Diagnosis cardiac arrest (kode I46.x) di DIAGLIST: laporkan HANYA kalau dokumen SAMA SEKALI
      TIDAK menyebut satupun tindakan resusitasi (mis. "RJP", "CPR", "bagging", "resusitasi", "kompresi
      dada", defibrilasi/DC shock) di seluruh dokumen. Kalau ADA sebutan tindakan resusitasi apapun
      (walau cuma satu, di halaman manapun), JANGAN laporkan.
      Field "basis": kalau kasusnya "dinyatakan eksplisit tidak dilakukan/tidak terambil", kutip PERSIS
      kalimat itu. Kalau kasusnya "sama sekali tidak ada bukti apapun", kutip baris diagnosis utama dari
      dokumen (mis. "Diagnosis Utama : Pneumonia" atau baris DIAGLIST terkait). Field "note" sebutkan
      diagnosis+kode, jenis bukti penunjang yang seharusnya ada tapi tidak ditemukan/dinyatakan tidak
      dilakukan, dan sebutkan bahwa BPJS verifikator RS ini historically sering meminta bukti kultur/
      lab/imaging/resusitasi semacam ini untuk diagnosis tersebut -- SARAN untuk dicek verifikator/koder
      (mungkin buktinya ada tapi belum ikut terunggah/terekstrak), BUKAN tuduhan bahwa diagnosisnya
      pasti salah.
   k. [observasi_igd_tidak_terdokumentasi] Klaim RAWAT_INAP dengan diagnosis utama (DU) berupa keluhan/
      gejala non-spesifik TANPA temuan objektif berat yang jelas (kode "nyeri/gejala saja" -- SAMA
      PERSIS dengan daftar kode pemicu pola kegawatan_lemah di atas: R10.x, R51, R52, R07.x, M54.x,
      G43.x, M79.x, plus R42 [pusing], K30 [dispepsia], A09.x [diare]) -- laporkan HANYA kalau SELURUH
      dokumen HANYA memuat SATU KALI penilaian klinis berwaktu (satu kali Triase IGD ATAU satu kali
      catatan SOAP/CPPT) TANPA ada catatan penilaian ULANG/observasi lanjutan sesudahnya (mis. entri
      SOAP kedua dengan jam berbeda, "observasi X menit" diikuti reassessment S/O/A/P berikutnya, atau
      rangkaian tanda vital berulang) sebelum keputusan "rawat inap" tercatat. BPJS verifikator RS ini
      sering minta bukti observasi/pemantauan di UGD sebelum admisi untuk kasus nyeri/gejala non-spesifik
      semacam ini, BUKAN cuma satu kali penilaian awal. JANGAN laporkan kalau ADA penilaian ulang/
      observasi lanjutan dalam bentuk apapun di dokumen manapun (walau formatnya bukan "lembar observasi"
      resmi -- mis. entri CPPT kedua dengan jam berbeda TETAP dihitung sebagai bukti observasi, jangan
      terlalu kaku soal nama/format dokumennya). JANGAN pula laporkan kalau DU disertai temuan objektif
      abnormal yang jelas (TTV signifikan abnormal, pemeriksaan fisik abnormal spesifik, hasil penunjang
      abnormal) yang sudah cukup jadi dasar admisi tanpa perlu observasi tambahan -- pola ini KHUSUS untuk
      kasus yang benar-benar cuma mengandalkan SATU penilaian awal tanpa penguat apapun. Field "basis"
      kutip PERSIS baris penilaian klinis TUNGGAL itu (mis. baris "Diagnosa :"/"A Diagnosa :"/"Keluhan :"
      dari satu-satunya entri yang ada). Field "note" sebutkan DU+kode, jelaskan bahwa dokumen hanya
      menunjukkan satu kali penilaian tanpa observasi lanjutan, dan sebutkan bahwa BPJS verifikator RS
      ini historically sering meminta bukti observasi UGD untuk kasus nyeri/gejala non-spesifik semacam
      ini sebelum admisi -- SARAN untuk dicek verifikator/koder (mungkin observasinya ada tapi belum
      ikut terunggah), BUKAN tuduhan bahwa admisinya pasti tidak tepat.
   l. [rawat_inap_rujuk_hari_sama] Klaim RAWAT_INAP di mana ADMISSION_DATE dan DISCHARGE_DATE (dari DATA
      REKAM KLAIM, hitung sendiri -- ini perbandingan TANGGAL, BUKAN kutipan dokumen) adalah TANGGAL YANG
      SAMA (LOS = 0 hari) DAN dokumen menunjukkan pasien pada akhirnya DIRUJUK/DIPINDAHKAN ke fasilitas
      kesehatan lain sebagai ALASAN KELUAR dari RS ini (bukan pulang membaik/APS/meninggal) -- kata kunci:
      "dirujuk", "advice DPJP rujuk", "pindah RS", "surat rujukan", nama RS tujuan. Pola ini BERBEDA dari
      [rujuk_saja_tanpa_tindakan] (e): pola e itu KHUSUS kunjungan yang MURNI rujukan TANPA tindakan/
      terapi definitif apapun (soal kode Z71.9 yang belum dipakai). Pola INI (l) untuk kasus yang MEMANG
      dapat tindakan/terapi UGD (mis. nebulizer, obat IV, observasi, upaya stabilisasi) dan DIKLAIM SEBAGAI
      rawat inap, tapi karena masuk-keluarnya di HARI YANG SAMA (LOS=0) dan alasan keluarnya adalah
      rujukan (bukan membaik/pulang), BPJS menilai seharusnya cukup dikategorikan pelayanan rawat jalan,
      bukan rawat inap -- independen dari ada/tidaknya kode Z71.9, walau pasien sempat kondisi berat/
      kritis sebelum dirujuk. Laporkan HANYA kalau KEDUA syarat terpenuhi: (1) LOS=0 hari (dihitung dari
      tanggal), (2) ADA kutipan eksplisit dari dokumen yang menyatakan pasien dirujuk/dipindahkan ke
      faskes lain sebagai alasan keluar. JANGAN laporkan kalau LOS>0 (menginap minimal 1 malam) walau
      akhirnya dirujuk -- itu beda kasus (rujukan setelah rawat inap sungguhan, bukan salah kategori
      tagihan). JANGAN laporkan kalau alasan keluarnya BUKAN rujukan. Field "basis" kutip PERSIS kalimat
      yang menyatakan rujukan/perpindahan ke faskes lain (mis. "pasien dirujuk", "advice DPJP rujuk").
      Field "note" sebutkan LOS terhitung (0 hari, tanggal masuk = tanggal keluar), bahwa pasien dirujuk
      pada hari yang sama, dan sebutkan bahwa BPJS verifikator RS ini historically sering meminta klaim
      semacam ini ditagihkan rawat jalan bukan rawat inap -- SARAN untuk dicek verifikator/koder, BUKAN
      keputusan final.
   m. [kombinasi_kode_ht_gagal_jantung] Perluasan pola kombinasi-kode RV-18 (I10+I25.9->I11.9, sudah
      rule engine, DILUAR cakupanmu) ke pasangan kombinasi LAIN -- CATATAN PENTING: pola ini baru
      berdasar SATU kasus historis terverifikasi (bukti jauh lebih terbatas dari pola lain di atas), dan
      kemungkinan mencerminkan konvensi BA Kesepakatan RS ini SECARA SPESIFIK, BUKAN aturan ICD-10 baku
      universal -- jadi WAJIB EKSTRA KONSERVATIF, laporkan HANYA kalau bukti benar-benar eksplisit dan
      kuat, jangan menduga-duga. DIAGLIST memuat kode hipertensi (I10, I11.x, I15.x) DAN kode gagal
      jantung (I50.x) SEBAGAI KODE TERPISAH (bukan kombo I13.x manapun), DAN dokumen menunjukkan KEDUA
      kondisi itu SECARA AKTIF relevan untuk kunjungan/episode perawatan INI (bukan cuma riwayat masa
      lalu yang tidak ditatalaksana saat ini) -- mis. tercantum bersama sebagai diagnosis sekunder aktif
      pada resume medis kunjungan ini, dengan tatalaksana terkait (obat jantung/diuretik dst), BUKAN cuma
      disebut sepintas di bagian "Riwayat Penyakit"/riwayat kunjungan sebelumnya. Laporkan HANYA kalau
      ADA kutipan eksplisit yang menunjukkan KEDUA kondisi (HT dan gagal jantung/CHF) tercantum bersama
      sebagai diagnosis AKTIF kunjungan ini (mis. baris "Diagnosis Sekunder" yang mencantumkan keduanya
      berdekatan). Kalau dokumen JUGA menunjukkan bukti insufisiensi renal aktif (kreatinin tinggi, atau
      baris diagnosis "Insufisiensi renal"), sebutkan itu di "note" sebagai pertimbangan tambahan --
      TAPI JANGAN mengusulkan kode ICD-10 spesifik pengganti (I13.0 vs I13.1 vs I13.2) -- itu keputusan
      koder berdasarkan detail klinis lengkap, cukup sebutkan bahwa kombinasi kode keluarga I13.x relevan
      dicek. Field "basis" kutip PERSIS baris "Diagnosis Sekunder" (atau setara) yang mencantumkan HT dan
      gagal jantung/CHF bersama. Field "note" sebutkan kode HT dan gagal jantung yang ditemukan terpisah
      di DIAGLIST, jelaskan bahwa BPJS/TKMKB RS ini PERNAH (sekali, data terbatas) meminta kombinasi kode
      keluarga I13.x untuk kasus HT+gagal jantung aktif semacam ini -- WAJIB sebutkan eksplisit di note
      bahwa ini kemungkinan konvensi lokal BA Kesepakatan (bukan pasti berlaku umum) dan baru berdasar
      1 kasus historis -- SARAN untuk dicek verifikator/koder, BUKAN keputusan final.
   n. [resume_medis_tidak_ada] Klaim RAWAT_INAP di mana SELURUH BUKTI_DOKUMEN yang diberikan TIDAK
      memuat satu halaman pun berjudul/berlabel "RESUME MEDIS" (RAWAT INAP atau variasinya) -- dokumen
      inti yang merangkum diagnosis akhir, tindakan, dan riwayat pelayanan rawat inap. Laporkan HANYA
      kalau kamu benar-benar TIDAK menemukan halaman berlabel itu di MANAPUN dalam BUKTI_DOKUMEN yang
      diberikan (baca ULANG semua halaman, jangan cuma berhenti di halaman pertama). JANGAN laporkan
      kalau ada halaman berlabel "RESUME MEDIS" di mana pun, walau isinya minim/singkat -- ketiadaan
      LABEL halaman itu yang jadi target, bukan penilaian kelengkapan isinya. Field "basis" untuk pola
      INI KHUSUS TIDAK memerlukan kutipan dokumen (karena membuktikan KETIADAAN, bukan keberadaan) --
      isi field "basis" dengan kutipan baris "Diagnosis Utama"/DIAGLIST record ini sebagai konteks saja
      (bukan bukti ketiadaan, cuma penanda record mana). Field "note" jelaskan bahwa halaman Resume
      Medis Rawat Inap tidak ditemukan di berkas yang diunggah, dan sebutkan bahwa BPJS verifikator RS
      ini pernah meminta dokumen ini dilampirkan secara eksplisit untuk klaim rawat inap -- SARAN untuk
      dicek apakah halaman itu sudah ikut diunggah/terekstrak, BUKAN tuduhan bahwa dokumennya pasti
      tidak lengkap secara keseluruhan.
   o. [dnr_cardiac_arrest_kontradiksi] DIAGLIST memuat kode cardiac arrest (I46.x) SEMENTARA dokumen
      SECARA EKSPLISIT menyatakan status DNR (Do Not Resuscitate/"Pasien DNR"/"tidak resusitasi") untuk
      pasien ini -- kombinasi ini kontradiktif: kalau status DNR aktif, tindakan resusitasi (yang jadi
      dasar kode cardiac arrest/RJP) seharusnya TIDAK dilakukan, jadi kode cardiac arrest patut dicek
      ulang. Laporkan HANYA kalau ADA kutipan eksplisit yang menyatakan status DNR pasien DI DOKUMEN INI
      (bukan cuma daftar kriteria umum risiko tinggi di formulir skrining -- harus benar-benar merujuk
      status pasien ini secara spesifik, mis. "CARDIAC ARREST---&gt;PASIEN DNR", "Pasien dengan status
      DNR"). JANGAN laporkan kalau TIDAK ada penyebutan status DNR spesifik untuk pasien ini, atau kalau
      dokumen justru menunjukkan tindakan resusitasi (RJP/CPR) TETAP dilakukan meski ada status DNR
      (situasi klinis kompleks yang butuh penilaian koder, bukan kontradiksi otomatis). Field "basis"
      kutip PERSIS kalimat yang menyatakan status DNR pasien. Field "note" sebutkan bahwa DIAGLIST
      memuat kode cardiac arrest (I46.x) bersamaan dengan status DNR yang terdokumentasi, jelaskan
      potensi kontradiksinya, dan sebutkan bahwa BPJS verifikator RS ini pernah meminta kode cardiac
      arrest dihapus/direvisi untuk kasus dengan status DNR terdokumentasi semacam ini -- SARAN untuk
      dicek verifikator/koder, BUKAN keputusan final.
   p. [pneumonia_tanpa_temuan_klinis] Diagnosis pneumonia/bronkopneumonia (DIAGLIST memuat kode J12-J18
      subkode manapun, atau kombinasi U07.1+J12.89 untuk pneumonia COVID-19) TANPA satupun temuan
      pemeriksaan fisik/penunjang paru yang mendukung diagnosis itu di SELURUH dokumen -- BEDA dari pola
      [diagnosis_evidence_mismatch] (j) yang cek kultur/gram/antibiotik; pola INI cek jenis bukti LAIN:
      temuan AUSKULTASI paru (ronkhi/rhonki, crackles/krepitasi -- ini temuan KHAS pneumonia) ATAU temuan
      RADIOLOGIS (foto toraks/rontgen dada/CT scan thorax yang mendukung, mis. "infiltrat", "konsolidasi",
      "bercak"). Laporkan HANYA kalau dokumen SAMA SEKALI TIDAK menyebut satupun dari KEDUA jenis bukti itu
      di halaman manapun (baca ulang semua halaman). Kalau SALAH SATU ada (walau cuma auskultasi TANPA
      radiologis, atau sebaliknya), JANGAN laporkan -- ketiadaan SEBAGIAN bukan target pola ini, HANYA
      ketiadaan TOTAL kedua jenis bukti klinis ini. JANGAN menilai apakah temuan yang ada "cukup kuat" atau
      "khas" -- itu bukan kompetensimu, cukup cek ADA/TIDAK ADA sebutan temuannya. Field "basis" kutip
      PERSIS baris diagnosis utama/DIAGLIST record ini sebagai konteks (bukan bukti ketiadaan, cuma
      penanda record mana -- pola serupa [resume_medis_tidak_ada] (n) yang membuktikan ketiadaan). Field
      "note" sebutkan diagnosis pneumonia+kode yang diklaim, jelaskan bahwa tidak ditemukan temuan
      auskultasi maupun radiologis paru yang mendukung di dokumen yang tersedia, dan sebutkan bahwa BPJS
      verifikator RS ini pernah mempending klaim pneumonia dengan alasan serupa ("tidak ditemukan kondisi
      klinis pada resume/berkas pasien") -- SARAN untuk dicek apakah temuannya ada tapi belum ikut
      terunggah/terekstrak, BUKAN tuduhan bahwa diagnosisnya pasti salah.
   Field "basis" WAJIB kutipan verbatim dari BUKTI_DOKUMEN — tanpa kutipan valid, jangan laporkan pola
   itu sama sekali. Field "note" WAJIB format BULLET POINT PENDEK (bukan paragraf naratif) -- setiap
   baris diawali "- ", pisahkan antar baris dengan newline (\n), MAKSIMAL 3 baris, tiap baris idealnya
   <15 kata (JANGAN gabungkan beberapa ide jadi satu baris panjang -- itu sama saja paragraf yang cuma
   dipotong-potong buatan). Struktur yang disarankan (sesuaikan isi per pola, TIDAK WAJIB label persis
   ini): baris 1 = temuan/bukti singkat, baris 2 (kalau perlu) = kenapa ini pola risiko, baris terakhir
   = SARAN untuk dicek verifikator/koder, BUKAN keputusan final (rule engine tidak menolak klaim karena
   ini). DILARANG KERAS menyebut nominal rupiah/dampak biaya. Catatan lengkap tentang pola kunjungan
   berulang lintas-episode (konsul internal, PRB/iterasi obat kronis, irisan RS lain) TIDAK termasuk di
   sini — itu butuh riwayat kunjungan lain yang tidak ada di satu dokumen ini, sudah ditangani terpisah
   lewat RV-13 s.d. RV-16.

Output HANYA JSON, tanpa markdown/penjelasan:
{"pending_risk_notes":[
  {"pattern":"kegawatan_lemah|manifestasi_ikut_du|tb_level_fktp|usg_berulang_tanpa_indikasi|rujuk_saja_tanpa_tindakan|diagnosis_vitals_mismatch|los_diagnosis_mismatch|komorbid_sekunder_tanpa_evaluasi|massa_jinak_tanpa_infiltrasi|diagnosis_evidence_mismatch|observasi_igd_tidak_terdokumentasi|rawat_inap_rujuk_hari_sama|kombinasi_kode_ht_gagal_jantung|resume_medis_tidak_ada|dnr_cardiac_arrest_kontradiksi|pneumonia_tanpa_temuan_klinis","page_number":N,"basis":"kutipan verbatim dari dokumen (untuk diagnosis_vitals_mismatch: 2 kutipan dipisah ' || ')","note":"penjelasan singkat Indonesia"}
]}`;

function buildPendingRiskPrompt(record, evidencePool) {
  const jenisKlaim = record.JENIS_KLAIM || record.jenis_klaim || '(tidak diketahui)';
  const codes = pickCodes(record);
  let prompt = `JENIS_KLAIM: ${jenisKlaim} — WAJIB dipatuhi, lihat instruksi di atas.\n\n`;
  prompt += `DATA REKAM KLAIM (hasil ekstraksi):\n${JSON.stringify(record, null, 0)}\n\n`;
  if (codes.diagnosis.length > 0) prompt += `Kode diagnosis diklaim (ICD-10): ${codes.diagnosis.join(', ')}\n`;
  else prompt += `Kode diagnosis diklaim (ICD-10): (KOSONG)\n`;
  if (codes.procedure.length > 0) prompt += `Kode prosedur diklaim (ICD-9-CM): ${codes.procedure.join(', ')}\n`;

  prompt += `\nBUKTI_DOKUMEN (teks per halaman):\n================================\n`;
  const sorted = [...evidencePool].sort((a, b) => a.page_number - b.page_number);
  for (const ev of sorted) {
    prompt += `=== Halaman ${ev.page_number} ===\n${ev.ocr_text}\n\n`;
  }
  return prompt;
}

/**
 * Panggilan AI TERPISAH & FOKUS untuk menilai POLA_RISIKO_PENDING (pola a-j)
 * — sebelumnya task ke-6 di dalam AI_REVIEW_SYSTEM_PROMPT gabungan, dipisah
 * 10 Sep 2026 dengan alasan yang SAMA PERSIS dengan assessKegawatdaruratan:
 * pada dokumen kompleks (banyak diagnosis/halaman), task ini terbukti
 * kembali kosong total walau ada bukti kuat, termasuk untuk pola lama yang
 * sudah stabil (bukan cuma pola baru) — root cause "tenggelam" bersaing
 * perhatian dengan 5 task lain dalam SATU respons gabungan.
 * @param {Object} record - Field values rekam klaim (format vClaim/DB).
 * @param {Array} evidencePool - [{page_number, ocr_text}] — SELURUH dokumen (bukan cuma triase).
 * @returns {Promise<Array>} pending_risk_notes — sudah divalidasi (kutipan wajib match evidencePool,
 *   anti-halusinasi), siap pakai. Best-effort: array kosong kalau gagal/timeout.
 */
async function assessPendingRiskPatterns(record, evidencePool) {
  const KNOWN_PENDING_PATTERNS = new Set([
    'kegawatan_lemah', 'manifestasi_ikut_du', 'tb_level_fktp',
    'usg_berulang_tanpa_indikasi', 'rujuk_saja_tanpa_tindakan',
    'diagnosis_vitals_mismatch', 'los_diagnosis_mismatch',
    'komorbid_sekunder_tanpa_evaluasi', 'massa_jinak_tanpa_infiltrasi',
    'diagnosis_evidence_mismatch', 'observasi_igd_tidak_terdokumentasi',
    'rawat_inap_rujuk_hari_sama', 'kombinasi_kode_ht_gagal_jantung',
    'resume_medis_tidak_ada', 'dnr_cardiac_arrest_kontradiksi',
    'pneumonia_tanpa_temuan_klinis',
  ]);

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey || evidencePool.length === 0) return [];

  const jenisKlaimRecord = record.JENIS_KLAIM || record.jenis_klaim;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);
  const userPrompt = buildPendingRiskPrompt(record, evidencePool);

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let respText;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: PENDING_RISK_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_completion_tokens: 3000,
          response_format: { type: 'json_object' },
        }),
      });
      respText = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }

    const data = JSON.parse(respText);
    // Logging token usage — sama seperti assessKegawatdaruratan, supaya biaya
    // panggilan terpisah ini terlihat terpisah dari result.tokens_used (yang
    // cuma menghitung panggilan gabungan utama).
    console.warn(`[AI-REVIEW] assessPendingRiskPatterns tokens: prompt=${data.usage?.prompt_tokens ?? '?'} completion=${data.usage?.completion_tokens ?? '?'} total=${data.usage?.total_tokens ?? '?'}`);
    const content = data.choices?.[0]?.message?.content || '';
    if (!content) return [];

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return [];
      parsed = JSON.parse(m[0]);
    }

    const raw = Array.isArray(parsed.pending_risk_notes) ? parsed.pending_risk_notes : [];
    const out = [];
    for (const entry of raw.slice(0, 10)) {
      const { pattern, page_number: pageNum, basis, note } = entry || {};
      if (!KNOWN_PENDING_PATTERNS.has(pattern)) continue;
      if (pattern === 'kegawatan_lemah' && jenisKlaimRecord !== 'GAWAT_DARURAT') continue;
      if (typeof note !== 'string' || !note.trim()) continue;
      if (!basis) continue;
      // diagnosis_vitals_mismatch: basis = "kutipan diagnosis || kutipan vital
      // sign", 2 kutipan yang boleh dari halaman berbeda — validasi masing-
      // masing terhadap SELURUH evidencePool, BEDA dari pola lain.
      if (pattern === 'diagnosis_vitals_mismatch') {
        const parts = basis.split('||').map(s => s.trim()).filter(Boolean);
        if (parts.length !== 2) continue;
        if (!parts.every(p => validateQuotationAnyPage(p, evidencePool))) continue;
      } else {
        if (!pageNum || !validateQuotation(basis, pageNum, evidencePool)) continue;
      }
      if (hasFinancialTerms(basis) || hasFinancialTerms(note)) continue;
      if (jenisKlaimRecord === 'RAWAT_JALAN' && hasInpatientOnlyTerms(note)) continue;
      out.push({
        pattern,
        page_number: pageNum || null,
        basis: basis.substring(0, 300),
        note: note.trim().substring(0, 300),
      });
    }
    return out;
  } catch (error) {
    console.warn(`[AI-REVIEW] assessPendingRiskPatterns gagal: ${error.message}`);
    return [];
  }
}

/**
 * @param {Object} record - Field values rekam klaim saat ini (memory) — bisa
 *   format vClaim (DIAGLIST, SEP, ...) atau format DB (diagnosa_list, sep, ...).
 * @param {Array} evidencePool - [{page_number, ocr_text, confidence}] — OCR + teks native, boleh kosong.
 * @param {Array} knowledgeEntries - [{rule_id, field_name, pattern_summary, solution}] dari
 *   error_knowledge_base untuk rule_id yang relevan — referensi ringkas, bukan histori penuh.
 * @returns {Promise<{field_notes: object, code_evidence: Array, suggested_codes: Array, knowledge_updates: Array, tokens_used: number}|null>}
 *   null kalau tidak ada apapun untuk direview, atau AI tidak dikonfigurasi/gagal total.
 */
async function generateAiReview(record, validationErrors = [], evidencePool = [], knowledgeEntries = [], bpjsExamples = []) {
  const codes = pickCodes(record);
  const hasCodesToCheck = evidencePool.length > 0 && (codes.diagnosis.length > 0 || codes.procedure.length > 0);
  // Ada halaman Triase IGD: selalu jalankan review kalau ada bukti dokumen,
  // walau rule engine bersih & tidak ada kode diklaim — penilaian
  // kegawatdaruratan (task 7 di system prompt) menilai KEPATUHAN DOKUMENTASI
  // KLINIS terhadap Permenkes 47/2018, independen dari validasi format
  // 60-kolom vClaim. Gating berbasis ADA/TIDAKNYA halaman Triase IGD (lihat
  // hasIgdTriagePage), BUKAN jenis_klaim — lihat catatan di hasIgdTriagePage.
  const shouldReviewForGadar = hasIgdTriagePage(evidencePool);

  if (validationErrors.length === 0 && !hasCodesToCheck && !shouldReviewForGadar) {
    return null; // tidak ada yang perlu direview
  }

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey) return null; // fallback ke rule-engine saja, seperti sebelumnya

  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const maxAttempts = Number(process.env.AI_MAX_ATTEMPTS || 3);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  const userPrompt = buildPrompt(record, validationErrors, evidencePool, codes, knowledgeEntries, bpjsExamples);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let respText;
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: AI_REVIEW_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            // max_completion_tokens (bukan max_tokens) & tanpa temperature custom
            // — sebagian model (mis. GPT-5.6 Luna) menolak keduanya dengan HTTP 400
            // "Unsupported parameter: 'max_tokens'". max_completion_tokens aman
            // dipakai untuk model lama (gpt-4o-mini dkk) juga, jadi tidak perlu
            // deteksi model.
            max_completion_tokens: 4000,
            response_format: { type: 'json_object' },
          }),
        });
        respText = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
      } finally {
        clearTimeout(timer);
      }

      const data = JSON.parse(respText);
      const content = data.choices?.[0]?.message?.content || '';
      const tokensUsed = data.usage?.total_tokens || 0;
      if (!content) throw new Error('Model membalas kosong');

      let aiResult;
      try {
        aiResult = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Model tidak mengembalikan JSON');
        aiResult = JSON.parse(m[0]);
      }

      const result = {
        field_notes: {},
        code_evidence: [],
        suggested_codes: [],
        knowledge_updates: [],
        pending_risk_notes: [],
        kegawatdaruratan_assessment: null,
        diagnosis_consistency_flags: [],
        tokens_used: tokensUsed,
        suggested_inacbg: null,
        suggested_tarif: null
      };
      const jenisKlaimRecord = record.JENIS_KLAIM || record.jenis_klaim;

      // field_notes: hanya field yang benar-benar ada di validationErrors yang dipertahankan.
      // Untuk RAWAT_JALAN, catatan yang masih menyinggung konsep rawat inap
      // (walau sudah dilarang di system prompt) dibuang di sini — lihat
      // hasInpatientOnlyTerms.
      const errorFieldNames = new Set(validationErrors.map(e => e.field_name));
      const errorRuleIds = new Set(validationErrors.map(e => e.rule_id));
      if (aiResult.field_notes && typeof aiResult.field_notes === 'object') {
        for (const [field, note] of Object.entries(aiResult.field_notes)) {
          if (!errorFieldNames.has(field) || typeof note !== 'string' || !note.trim()) continue;
          if (jenisKlaimRecord === 'RAWAT_JALAN' && hasInpatientOnlyTerms(note)) {
            console.warn(`[AI-REVIEW] Catatan field "${field}" dibuang (menyinggung rawat inap untuk klaim RAWAT_JALAN).`);
            continue;
          }
          result.field_notes[field] = note.trim();
        }
      }

      // code_evidence — validasi server-side setiap kutipan (anti-halusinasi AI).
      // Setiap kali AI menyimpulkan "tidak ada bukti" (langsung, atau kutipannya
      // gagal validasi), coba dulu findCodeInEvidencePool sebelum benar-benar
      // dicatat found:false — kutipan AI dari tabel kompleks (PDF/OCR) sering
      // gagal cocok persis walau kodenya benar-benar ada di halaman itu.
      if (Array.isArray(aiResult.code_evidence)) {
        for (const entry of aiResult.code_evidence) {
          if (!entry.found) {
            const fallback = findCodeInEvidencePool(entry.code, evidencePool);
            result.code_evidence.push(fallback
              ? { code: entry.code, type: entry.type, found: true, page_number: fallback.page_number, quotation: fallback.quotation }
              : { code: entry.code, type: entry.type, found: false, page_number: null, quotation: null });
            continue;
          }
          const { page_number: pageNum, quotation } = entry;
          const quotationValid = quotation && pageNum
            && validateQuotation(quotation, pageNum, evidencePool) && !hasFinancialTerms(quotation);
          if (!quotationValid) {
            if (quotation && pageNum) {
              console.warn(`[AI-REVIEW] Kutipan tidak cocok (AI halusinasi?): code=${entry.code}, page=${pageNum}`);
            }
            const fallback = findCodeInEvidencePool(entry.code, evidencePool);
            if (fallback) {
              result.code_evidence.push({ code: entry.code, type: entry.type, found: true, page_number: fallback.page_number, quotation: fallback.quotation });
            }
            continue;
          }
          result.code_evidence.push({
            code: entry.code, type: entry.type, found: true,
            page_number: pageNum, quotation: quotation.substring(0, 200),
          });
        }
      }

      // Pengaman: pastikan SEMUA kode yang diklaim tercatat — coba fallback
      // deterministik dulu sebelum dicatat found:false (kalau AI diam total).
      if (hasCodesToCheck) {
        const covered = new Set(result.code_evidence.map(e => e.code));
        const pushWithFallback = (code, type) => {
          if (covered.has(code)) return;
          const fallback = findCodeInEvidencePool(code, evidencePool);
          result.code_evidence.push(fallback
            ? { code, type, found: true, page_number: fallback.page_number, quotation: fallback.quotation }
            : { code, type, found: false, page_number: null, quotation: null });
        };
        codes.diagnosis.forEach(code => pushWithFallback(code, 'diagnosis'));
        codes.procedure.forEach(code => pushWithFallback(code, 'procedure'));
      }

      // --- Provenance & status review per code_evidence (fix item 7/8/9, 19 Sep 2026) ---
      // (a) document_type: dihitung DARI METADATA HALAMAN (page_number ->
      //     classifyPageDocumentType, deterministik/regex), BUKAN dari teks
      //     bebas LLM -- sebelumnya frontend HARDCODE label "Dari Resume
      //     Medis" untuk semua evidence apapun sumber aslinya (bug provenance
      //     salah, mis. kutipan Rincian Biaya dilabeli Resume Medis).
      // (b) review_status ('valid'|'perlu_review'|'evidence_tidak_terverifikasi'):
      //     found:false -> evidence_tidak_terverifikasi (tidak ada bukti
      //     terverifikasi sama sekali, termasuk kutipan palsu yang gagal
      //     validateQuotation); found:true PROCEDURE yang match
      //     procedure_rules.json (mis. lab rutin) -> perlu_review; sisanya valid.
      //     Diagnosis TIDAK dicek codability (rules ini utk PROCLIST saja) --
      //     diagnosis diperiksa terpisah oleh diagnosisConsistencyService
      //     (severity-consistency, bukan codability) di bawah.
      for (const entry of result.code_evidence) {
        const page = entry.found && entry.page_number ? evidencePool.find(p => p.page_number === entry.page_number) : null;
        entry.document_type = page ? classifyPageDocumentType(page.ocr_text) : null;
        if (!entry.found) {
          entry.review_status = 'evidence_tidak_terverifikasi';
          entry.review_flags = [{ reason: 'Tidak ditemukan kutipan yang terverifikasi (cocok persis) di halaman dokumen manapun untuk kode ini.' }];
          continue;
        }
        if (entry.type === 'procedure') {
          const codability = checkProcedureCodability(entry.code);
          if (codability.review) {
            entry.review_status = 'perlu_review';
            entry.review_flags = [{ reason: codability.reason }];
            continue;
          }
        }
        entry.review_status = 'valid';
        entry.review_flags = [];
      }

      // Konsistensi klinis diagnosis (item 9) -- MURNI deterministik (regex ke
      // evidencePool), TIDAK PERNAH mengubah DIAGLIST. Hasilnya ditempel juga
      // ke code_evidence entry yang cocok (review_status -> perlu_review) supaya
      // badge per-kode di frontend konsisten dengan flag detailnya di
      // diagnosis_consistency_flags.
      try {
        result.diagnosis_consistency_flags = evaluateDiagnosisConsistency(codes.diagnosis, evidencePool);
        for (const flag of result.diagnosis_consistency_flags) {
          const evEntry = result.code_evidence.find(e => e.code === flag.code && e.type === 'diagnosis');
          if (evEntry && evEntry.review_status !== 'evidence_tidak_terverifikasi') {
            evEntry.review_status = 'perlu_review';
            evEntry.review_flags = [...(evEntry.review_flags || []), { reason: flag.reason, alternative_code: flag.alternative_code, action: flag.action }];
          }
        }
      } catch (consistencyErr) {
        console.warn(`[AI-REVIEW] evaluateDiagnosisConsistency gagal: ${consistencyErr.message}`);
      }

      // suggested_codes — quotation adalah kutipan VERBATIM dari dokumen (tidak
      // difilter istilah rawat inap, itu fakta dokumen bukan opini AI); reasoning
      // adalah opini AI, difilter sama seperti field_notes untuk RAWAT_JALAN.
      if (Array.isArray(aiResult.suggested_codes)) {
        for (const entry of aiResult.suggested_codes) {
          const { page_number: pageNum, quotation } = entry;
          if (!quotation || !pageNum) continue;
          if (!validateQuotation(quotation, pageNum, evidencePool)) {
            console.warn(`[AI-REVIEW] suggested_code "${entry.code}" dibuang: kutipan tidak cocok di halaman ${pageNum} (AI halusinasi?).`);
            continue;
          }
          if (hasFinancialTerms(quotation) || hasFinancialTerms(entry.reasoning)) continue;
          if (jenisKlaimRecord === 'RAWAT_JALAN' && hasInpatientOnlyTerms(entry.reasoning)) {
            console.warn(`[AI-REVIEW] Saran kode "${entry.code}" dibuang (reasoning menyinggung rawat inap untuk klaim RAWAT_JALAN).`);
            continue;
          }
          result.suggested_codes.push({
            code: entry.code, type: entry.type, page_number: pageNum,
            quotation: quotation.substring(0, 200),
            reasoning: (entry.reasoning || '').substring(0, 200),
          });
        }
      }

      // knowledge_updates — anti-halusinasi: rule_id wajib salah satu dari
      // validationErrors record ini (bukan rule_id yang dikarang AI), dan
      // dilarang keras memuat data finansial/identitas (heuristik sederhana).
      // Untuk RAWAT_JALAN, pola yang menyinggung rawat inap TIDAK boleh masuk
      // basis pengetahuan — kalau lolos tersimpan, bisa "mencemari" referensi
      // PENGETAHUAN_TERDAHULU untuk record RAWAT_JALAN lain di masa depan
      // (rule_id sama dipakai lintas kategori, tidak ada pemisahan per kategori).
      if (Array.isArray(aiResult.knowledge_updates)) {
        for (const entry of aiResult.knowledge_updates.slice(0, 10)) {
          const { rule_id: ruleId, field_name: fieldName, pattern_summary: pattern, solution } = entry || {};
          if (!ruleId || !errorRuleIds.has(ruleId)) continue;
          if (typeof pattern !== 'string' || typeof solution !== 'string') continue;
          if (!pattern.trim() || !solution.trim()) continue;
          if (hasFinancialTerms(pattern) || hasFinancialTerms(solution)) continue;
          if (jenisKlaimRecord === 'RAWAT_JALAN' && (hasInpatientOnlyTerms(pattern) || hasInpatientOnlyTerms(solution))) continue;
          result.knowledge_updates.push({
            rule_id: ruleId,
            field_name: typeof fieldName === 'string' ? fieldName.trim() || null : null,
            pattern_summary: pattern.trim().substring(0, 500),
            solution: solution.trim().substring(0, 500),
          });
        }
      }

      // pending_risk_notes DAN kegawatdaruratan_assessment — DUA panggilan AI
      // TERPISAH & FOKUS, dijalankan PARALEL via Promise.all (bukan sekuensial)
      // supaya tidak menggandakan latensi total. pending_risk_notes dipisah
      // 10 Sep 2026 (lihat assessPendingRiskPatterns) dengan alasan yang SAMA
      // PERSIS dengan kegawatdaruratan yang sudah dipisah 9 Sep 2026: pada
      // dokumen kompleks (banyak diagnosis/halaman), task yang digabung di
      // AI_REVIEW_SYSTEM_PROMPT terbukti kembali kosong total walau ada bukti
      // kuat di dokumen — root cause "tenggelam" bersaing perhatian dengan
      // task lain dalam SATU respons gabungan. Best-effort untuk keduanya —
      // gagal/timeout TIDAK menggagalkan hasil utama (masing-masing fungsi
      // sudah punya fallback kosong internal kalau panggilannya gagal total).
      const triagePageNumbers = getIgdTriagePageNumbers(evidencePool);
      const resumeMedisPageNumbers = getResumeMedisPageNumbers(evidencePool);
      const [pendingRiskNotes, kegawatdaruratanAssessment] = await Promise.all([
        assessPendingRiskPatterns(record, evidencePool).catch(riskErr => {
          console.warn(`[AI-REVIEW] assessPendingRiskPatterns error: ${riskErr.message}`);
          return [];
        }),
        hasIgdTriagePage(evidencePool)
          ? assessKegawatdaruratan(
              evidencePool, triagePageNumbers,
              record.UMUR_TAHUN || record.umur_tahun, record.UMUR_HARI || record.umur_hari,
              codes.procedure, resumeMedisPageNumbers
            ).catch(kegawatErr => {
              console.warn(`[AI-REVIEW] assessKegawatdaruratan error: ${kegawatErr.message}`);
              return null;
            })
          : Promise.resolve(null),
      ]);
      result.pending_risk_notes = pendingRiskNotes;
      result.kegawatdaruratan_assessment = kegawatdaruratanAssessment;

      // Modul Pneumonia (Fase 2, 12-13 Sep 2026) -- MURNI kode deterministik,
      // dijalankan SETELAH kegawatdaruratanAssessment tersedia (piggyback pada
      // Tabel 1/2 yang sudah diekstrak & divalidasi), TIDAK ada panggilan AI
      // tambahan. Lihat pneumoniaSeverityAssessment.js utk scope & batasan.
      const pneumoniaFinding = assessPneumoniaSeverityMismatch(
        record.DIAGLIST || record.diagnosa_list, kegawatdaruratanAssessment, jenisKlaimRecord
      );
      if (pneumoniaFinding) result.pending_risk_notes = [...result.pending_risk_notes, pneumoniaFinding];

      // Fallback panggilan terpisah: kalau DIAGLIST kosong total DAN panggilan
      // utama di atas tidak menghasilkan suggested_codes apapun, coba sekali
      // lagi dengan prompt fokus tunggal (lihat suggestDiagnosisCodesFallback)
      // — terbukti lebih andal daripada instruksi yang sama di prompt gabungan.
      // Best-effort: gagal/timeout di sini TIDAK menggagalkan hasil utama.
      // 17 Sep 2026: evidencePool DIPERSEMPIT ke halaman Resume Medis SAJA
      // sebelum dikirim (lihat getAnyResumeMedisPageNumbers) -- permintaan
      // klien, kolom diagnosis tidak boleh lagi mencari di SEP/SPRI/Triage
      // IGD/dst. Kalau tidak ada satupun halaman Resume Medis di berkas ini,
      // fallback DILEWATI SAMA SEKALI (bukan jalan dgn evidencePool penuh)
      // -- tidak ada dasar utk mengusulkan apa pun kalau memang tidak ada
      // Resume Medis di berkas ini.
      const resumeMedisOnlyPageNumbers = getAnyResumeMedisPageNumbers(evidencePool);
      const resumeMedisOnlyPool = evidencePool.filter(p => resumeMedisOnlyPageNumbers.includes(p.page_number));
      if (codes.diagnosis.length === 0 && result.suggested_codes.length === 0 && resumeMedisOnlyPool.length > 0) {
        try {
          const fallbackSuggestions = await Promise.race([
            suggestDiagnosisCodesFallback(resumeMedisOnlyPool),
            new Promise((_, reject) => setTimeout(() => reject(new Error('fallback hard-timeout 70s')), 70000)),
          ]);
          if (fallbackSuggestions.length > 0) {
            console.warn(`[AI-REVIEW] Fallback saran diagnosis menghasilkan ${fallbackSuggestions.length} kandidat tambahan.`);
            result.suggested_codes.push(...fallbackSuggestions);
          }
        } catch (fallbackErr) {
          console.warn(`[AI-REVIEW] Fallback saran diagnosis error: ${fallbackErr.message}`);
        }
      }

      // Kamus ICD-10 WHO -- lapisan validasi tambahan (additive, lihat
      // annotateKamusValid), dipanggil SETELAH suggested_codes final (termasuk
      // hasil fallback di atas) supaya semua entry tertandai, bukan cuma yang
      // dari alur utama. Best-effort: gagal di sini tidak menggagalkan hasil.
      try {
        result.suggested_codes = await annotateKamusValid(result.suggested_codes);
      } catch (kamusErr) {
        console.warn(`[AI-REVIEW] annotateKamusValid gagal total: ${kamusErr.message}`);
      }

      // Proses Estimasi INA-CBG dari AI ke dictionary
      if (aiResult.suggested_inacbg && typeof aiResult.suggested_inacbg === 'string') {
        const estimasi = getInacbgEstimasi(aiResult.suggested_inacbg);
        if (estimasi) {
          result.suggested_inacbg = aiResult.suggested_inacbg;
          result.suggested_tarif = estimasi.tarif;
        }
      }

      result.generated_at = new Date().toISOString();
      return result;
    } catch (error) {
      const msg = error.name === 'AbortError' ? `timeout ${timeoutMs}ms` : error.message;
      console.warn(`[AI-REVIEW] percobaan ${attempt} gagal: ${msg}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }

  return null; // gagal total setelah semua percobaan — biarkan rule-engine saja
}

module.exports = {
  generateAiReview,
  validateQuotation,
  normalizeText,
  hasFinancialTerms,
  AI_REVIEW_SYSTEM_PROMPT,
  // Diekspor tambahan 19 Sep 2026 untuk testability langsung (fix item 4-9) --
  // supaya test regresi bisa memanggil assessKegawatdaruratan tanpa harus
  // mock seluruh alur generateAiReview (yang juga memanggil pending-risk &
  // suggested_codes secara paralel).
  assessKegawatdaruratan,
  getIgdTriagePageNumbers,
  getResumeMedisPageNumbers,
};
