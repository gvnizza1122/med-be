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
1. Untuk setiap field yang gagal validasi (daftar "FIELD_ERRORS"): beri catatan singkat dalam Bahasa
   Indonesia yang menjelaskan MENGAPA field itu gagal dan LANGKAH konkret memperbaikinya, dengan
   mempertimbangkan seluruh data rekam klaim (termasuk JENIS_KLAIM di atas) sebagai konteks (bukan
   field itu saja).
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
   - DILARANG KERAS menyebut nominal rupiah/biaya/tarif dalam kutipan atau alasan apapun.
   - DILARANG mengarang/menyimpulkan kode dari konteks umum — hanya dari bukti eksplisit di teks.
   - Kalau ragu, tandai found:false — lebih baik tidak menyarankan daripada salah.
3. suggested_codes HANYA diisi kalau ada bukti KUAT kode itu relevan tapi belum diklaim. Ini termasuk
   kasus DIAGLIST kosong TOTAL (lihat FIELD_ERRORS rule RV-05) — PALING SERING terjadi saat dokumen
   TIDAK PUNYA halaman resmi "Berkas Klaim Individual" (E-Klaim), cuma kumpulan dokumen naratif RS
   (Resume Medis, SPRI, Triage IGD, dst). Untuk kasus ini WAJIB HUKUMNYA: baca ULANG SELURUH halaman
   di BUKTI_DOKUMEN satu per satu (bukan cuma halaman pertama yang ketemu) — istilah diagnosis sering
   tersebar di halaman berbeda dengan label berbeda-beda, semua ini valid sumber:
   "Diagnosis Utama", "Diagnosa Kerja", "Diagnosa" (di SPRI/Surat Perintah Rawat Inap), "Assessment"/"A:"
   (format S-O-A-P), "Diag Awal". WAJIB usulkan minimal 1 kode ICD-10 di suggested_codes kalau SATU SAJA
   dari label-label itu ditemukan di mana pun di BUKTI_DOKUMEN — jangan biarkan suggested_codes kosong
   hanya karena tidak ada halaman "Berkas Klaim Individual", dan jangan berhenti mencari cuma karena
   halaman pertama yang dibaca tidak mengandungnya.
   PRIORITAS kalau ada BEBERAPA pernyataan diagnosis yang beda-beda untuk pasien yang sama (mis. "Alasan
   Masuk Rawat Inap" di SPRI menyebut satu hal, tapi "Diagnosis Utama" di Resume Medis Rawat Inap
   menyebut hal lain) — SEMUA WAJIB diusulkan sebagai kandidat terpisah (jangan cuma pilih satu),
   supaya koder manusia yang memutuskan mana yang final; jangan diam-diam abaikan salah satunya. Yang
   BUKAN diagnosis (jangan dipetakan ke ICD-10 dari sini): "Keluhan" (gejala subjektif pasien, mis.
   "nyeri perut" — beda dari diagnosis dokter), "Diagnosis Keperawatan" (istilah asuhan keperawatan,
   bukan diagnosis medis, mis. "nyeri akut", "ketidakefektifan bersihan jalan nafas").
   quotation WAJIB kutipan VERBATIM istilah diagnosis dari dokumen (bukan kode ICD-10 itu sendiri, karena
   kodenya memang tidak tercetak di dokumen — itulah sebabnya diusulkan); reasoning jelaskan pemetaan
   istilah -> kode secara singkat, DAN sebutkan label sumbernya (mis. "dari Diagnosis Utama" vs "dari
   Alasan Masuk Rawat Inap") supaya koder tahu mana yang lebih otoritatif. Kalau istilah diagnosisnya
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
6. POLA_RISIKO_PENDING — di luar validasi format (rule engine), berikut pola yang PALING SERING
   bikin klaim RS ini di-pending verifikator BPJS (diambil dari data pending riil Juni 2026, sudah
   diurutkan dari yang paling sering). Rule engine TIDAK bisa mendeteksi pola ini secara otomatis
   (butuh penilaian klinis atas isi dokumen), jadi tugasmu: periksa BUKTI_DOKUMEN apakah rekam ini
   menunjukkan indikasi salah satu pola berikut. Kalau YA dan kamu bisa kutip kalimat PERSIS dari
   dokumen sebagai dasarnya, laporkan di "pending_risk_notes" (bukan field_notes — field_notes HANYA
   untuk field yang gagal validasi format). Kalau TIDAK ada indikasi, atau tidak ada kutipan pasti,
   JANGAN laporkan apa pun untuk pola itu — lebih baik diam daripada menuduh salah.
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
   Field "basis" WAJIB kutipan verbatim dari BUKTI_DOKUMEN (sama seperti aturan quotation code_evidence
   di atas) — tanpa kutipan valid, jangan laporkan pola itu sama sekali. Field "note" tulis dalam Bahasa
   Indonesia, singkat, jelaskan kaitan bukti -> pola risiko, dan sebutkan bahwa ini SARAN untuk dicek
   verifikator/koder, BUKAN keputusan final (rule engine tidak menolak klaim karena ini). DILARANG KERAS
   menyebut nominal rupiah/dampak biaya. Catatan lengkap tentang pola kunjungan berulang lintas-episode
   (konsul internal, PRB/iterasi obat kronis, irisan RS lain) TIDAK termasuk di sini — itu butuh riwayat
   kunjungan lain yang tidak ada di satu dokumen ini, sudah ditangani terpisah lewat RV-13 s.d. RV-16.
7. KEGAWATDARURATAN (HANYA kalau JENIS_KLAIM = GAWAT_DARURAT, kalau bukan lewati task ini total, JANGAN
   isi "kegawatdaruratan_assessment"): nilai BUKTI_DOKUMEN terhadap 5 kriteria kegawatdaruratan resmi
   Pasal 3 ayat (2) Permenkes RI No. 47 Tahun 2018 — TUJUANNYA MENILAI APA ADANYA, BUKAN mencari cara
   supaya lolos. Untuk SETIAP dari 5 kriteria (a-e), tentukan "terpenuhi" HANYA true kalau BUKTI_DOKUMEN
   secara eksplisit mendukungnya (kutip kalimat PERSIS, sama seperti aturan quotation code_evidence di
   atas — DILARANG mengarang/menyimpulkan dari kesan umum). Kalau dokumen TIDAK menyebutkan indikasi
   kriteria itu (mis. TTV normal semua, atau kolom kesadaran/hemodinamik tidak diisi/dicatat "dalam
   batas normal"), "terpenuhi" WAJIB false — TIDAK BOLEH true tanpa kutipan eksplisit yang mendukung,
   walau nama diagnosisnya terdengar berat. Kriteria:
   a. Mengancam nyawa, membahayakan diri sendiri/orang lain/lingkungan
   b. Ada gangguan jalan napas, pernapasan, dan/atau sirkulasi (mis. RR di luar normal, SpO2 rendah,
      suara napas abnormal, akral dingin, nadi tidak teraba/lemah, perdarahan aktif)
   c. Ada penurunan kesadaran (GCS < 15 / somnolen / delirium / koma — bukan sekadar "compos mentis")
   d. Ada gangguan hemodinamik (mis. TD sistolik <90 atau >180, nadi <60 atau >100 disertai tanda syok,
      CRT memanjang, akral dingin/pucat)
   e. Memerlukan tindakan/intervensi segera (mis. resusitasi, pemberian obat emergensi, tindakan
      life-saving — bukan sekadar pemberian obat oral/analgesik rutin)
   Field "catatan" (Indonesia, 1 kalimat singkat) jelaskan alasan terpenuhi/tidaknya berdasarkan bukti
   (atau ketiadaan bukti). DILARANG KERAS menyebut nominal rupiah/biaya. Ini murni penilaian dokumentasi
   klinis untuk kepatuhan Permenkes — BUKAN rekomendasi mengubah/menambah data klaim apapun.

Output HANYA JSON, tanpa markdown/penjelasan, format:
{
  "field_notes": { "<field_name>": "catatan & saran Indonesia" },
  "code_evidence": [
    { "code": "...", "type": "diagnosis|procedure", "found": true/false, "page_number": N, "quotation": "..." }
  ],
  "suggested_codes": [
    { "code": "...", "type": "diagnosis|procedure", "page_number": N, "quotation": "...", "reasoning": "..." }
  ],
  "knowledge_updates": [
    { "rule_id": "...", "field_name": "...", "pattern_summary": "pola penyebab, tanpa data pasien", "solution": "langkah perbaikan umum" }
  ],
  "pending_risk_notes": [
    { "pattern": "kegawatan_lemah|manifestasi_ikut_du|tb_level_fktp|usg_berulang_tanpa_indikasi|rujuk_saja_tanpa_tindakan", "page_number": N, "basis": "kutipan verbatim dari dokumen", "note": "penjelasan singkat Indonesia" }
  ],
  "kegawatdaruratan_assessment": [
    { "kriteria": "a|b|c|d|e", "terpenuhi": true/false, "page_number": N atau null, "bukti": "kutipan verbatim atau null", "catatan": "..." }
  ]
}`;

const KEGAWATDARURATAN_LABELS = {
  a: 'Mengancam nyawa / membahayakan diri, orang lain, atau lingkungan',
  b: 'Gangguan jalan napas, pernapasan, dan/atau sirkulasi',
  c: 'Penurunan kesadaran',
  d: 'Gangguan hemodinamik',
  e: 'Memerlukan tindakan/intervensi segera',
};

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

  if (codes.diagnosis.length === 0 && evidencePool.length > 0) {
    prompt += `\n================================\nINGATKAN DIRIMU SENDIRI SEBELUM MENJAWAB: DIAGLIST kosong (lihat di atas). ` +
      `Baca ULANG semua halaman BUKTI_DOKUMEN yang barusan kamu terima di atas, cari SATU PER SATU label ` +
      `"Diagnosis Utama", "Diagnosa Kerja", "Diagnosa" (di SPRI), "Assessment"/"A:". Kalau ketemu SATU SAJA ` +
      `di halaman mana pun, WAJIB isi minimal 1 entri di suggested_codes (lihat instruksi task 3) — kosongkan ` +
      `suggested_codes HANYA kalau kamu benar-benar sudah baca semua halaman dan tidak ada satu pun label itu.\n`;
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
 * @param {Object} record - Field values rekam klaim saat ini (memory) — bisa
 *   format vClaim (DIAGLIST, SEP, ...) atau format DB (diagnosa_list, sep, ...).
 * @param {Array} validationErrors - Error dari rule engine (field_name, error_message, dst).
 * @param {Array} evidencePool - [{page_number, ocr_text, confidence}] — OCR + teks native, boleh kosong.
 * @param {Array} knowledgeEntries - [{rule_id, field_name, pattern_summary, solution}] dari
 *   error_knowledge_base untuk rule_id yang relevan — referensi ringkas, bukan histori penuh.
 * @returns {Promise<{field_notes: object, code_evidence: Array, suggested_codes: Array, knowledge_updates: Array, tokens_used: number}|null>}
 *   null kalau tidak ada apapun untuk direview, atau AI tidak dikonfigurasi/gagal total.
 */
async function generateAiReview(record, validationErrors = [], evidencePool = [], knowledgeEntries = [], bpjsExamples = []) {
  const codes = pickCodes(record);
  const hasCodesToCheck = evidencePool.length > 0 && (codes.diagnosis.length > 0 || codes.procedure.length > 0);
  const jenisKlaimRecordEarly = record.JENIS_KLAIM || record.jenis_klaim;
  // GAWAT_DARURAT: selalu jalankan review kalau ada bukti dokumen, walau rule
  // engine bersih & tidak ada kode diklaim — penilaian kegawatdaruratan
  // (task 7 di system prompt) menilai KEPATUHAN DOKUMENTASI KLINIS terhadap
  // Permenkes 47/2018, independen dari validasi format 60-kolom vClaim.
  const shouldReviewForGadar = jenisKlaimRecordEarly === 'GAWAT_DARURAT' && evidencePool.length > 0;

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

      const result = { field_notes: {}, code_evidence: [], suggested_codes: [], knowledge_updates: [], pending_risk_notes: [], kegawatdaruratan_assessment: [], tokens_used: tokensUsed };
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

      // suggested_codes — quotation adalah kutipan VERBATIM dari dokumen (tidak
      // difilter istilah rawat inap, itu fakta dokumen bukan opini AI); reasoning
      // adalah opini AI, difilter sama seperti field_notes untuk RAWAT_JALAN.
      if (Array.isArray(aiResult.suggested_codes)) {
        console.warn(`[AI-REVIEW] AI mengembalikan ${aiResult.suggested_codes.length} suggested_codes mentah.`);
        for (const entry of aiResult.suggested_codes) {
          const { page_number: pageNum, quotation } = entry;
          if (!quotation || !pageNum) {
            console.warn(`[AI-REVIEW] suggested_code "${entry.code}" dibuang: quotation/page_number kosong.`);
            continue;
          }
          if (!validateQuotation(quotation, pageNum, evidencePool)) {
            console.warn(`[AI-REVIEW] suggested_code "${entry.code}" dibuang: kutipan tidak cocok di halaman ${pageNum}. quotation="${quotation.slice(0,120)}"`);
            continue;
          }
          if (hasFinancialTerms(quotation) || hasFinancialTerms(entry.reasoning)) {
            console.warn(`[AI-REVIEW] suggested_code "${entry.code}" dibuang: mengandung istilah finansial.`);
            continue;
          }
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

      // pending_risk_notes — sama seperti code_evidence: kutipan wajib ada
      // verbatim di evidencePool (anti-halusinasi), tanpa istilah finansial.
      // "kegawatan_lemah" cuma masuk akal untuk GAWAT_DARURAT — dibuang untuk
      // kategori lain kalau AI salah tempatkan.
      const KNOWN_PENDING_PATTERNS = new Set([
        'kegawatan_lemah', 'manifestasi_ikut_du', 'tb_level_fktp',
        'usg_berulang_tanpa_indikasi', 'rujuk_saja_tanpa_tindakan',
      ]);
      if (Array.isArray(aiResult.pending_risk_notes)) {
        for (const entry of aiResult.pending_risk_notes.slice(0, 10)) {
          const { pattern, page_number: pageNum, basis, note } = entry || {};
          if (!KNOWN_PENDING_PATTERNS.has(pattern)) continue;
          if (pattern === 'kegawatan_lemah' && jenisKlaimRecord !== 'GAWAT_DARURAT') continue;
          if (typeof note !== 'string' || !note.trim()) continue;
          if (!basis || !pageNum || !validateQuotation(basis, pageNum, evidencePool)) continue;
          if (hasFinancialTerms(basis) || hasFinancialTerms(note)) continue;
          if (jenisKlaimRecord === 'RAWAT_JALAN' && hasInpatientOnlyTerms(note)) continue;
          result.pending_risk_notes.push({
            pattern,
            page_number: pageNum,
            basis: basis.substring(0, 200),
            note: note.trim().substring(0, 300),
          });
        }
      }

      // kegawatdaruratan_assessment — HANYA untuk GAWAT_DARURAT. Sama seperti
      // pending_risk_notes: klaim "terpenuhi:true" WAJIB kutipan verbatim yang
      // tervalidasi di evidencePool, kalau tidak DITURUNKAN paksa jadi false
      // (bukan dibuang barisnya) — supaya tabel di FE selalu tampil lengkap 5
      // kriteria, tapi tidak pernah menampilkan "terpenuhi" tanpa bukti nyata.
      if (jenisKlaimRecord === 'GAWAT_DARURAT' && Array.isArray(aiResult.kegawatdaruratan_assessment)) {
        const seen = new Set();
        for (const entry of aiResult.kegawatdaruratan_assessment.slice(0, 5)) {
          const { kriteria, page_number: pageNum, bukti, catatan } = entry || {};
          if (!KEGAWATDARURATAN_LABELS[kriteria] || seen.has(kriteria)) continue;
          seen.add(kriteria);
          let terpenuhi = entry?.terpenuhi === true;
          let quotationOut = null;
          let pageOut = null;
          if (terpenuhi) {
            const validQuote = bukti && pageNum
              && validateQuotation(bukti, pageNum, evidencePool) && !hasFinancialTerms(bukti);
            if (validQuote) {
              quotationOut = bukti.substring(0, 200);
              pageOut = pageNum;
            } else {
              terpenuhi = false; // turun paksa, anti-halusinasi
            }
          }
          const catatanOut = typeof catatan === 'string' && !hasFinancialTerms(catatan)
            ? catatan.trim().substring(0, 300) : '';
          result.kegawatdaruratan_assessment.push({
            kriteria, label: KEGAWATDARURATAN_LABELS[kriteria],
            terpenuhi, page_number: pageOut, bukti: quotationOut, catatan: catatanOut,
          });
        }
        // Lengkapi kriteria yang tidak disebut AI sama sekali — tetap tampil
        // di tabel sebagai "tidak terpenuhi" (default aman, bukan diam-diam
        // hilang dari daftar).
        for (const k of Object.keys(KEGAWATDARURATAN_LABELS)) {
          if (seen.has(k)) continue;
          result.kegawatdaruratan_assessment.push({
            kriteria: k, label: KEGAWATDARURATAN_LABELS[k],
            terpenuhi: false, page_number: null, bukti: null,
            catatan: 'Tidak ada bukti terdokumentasi untuk kriteria ini.',
          });
        }
        result.kegawatdaruratan_assessment.sort((a, b) => a.kriteria.localeCompare(b.kriteria));
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
};
