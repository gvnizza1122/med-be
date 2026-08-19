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
   kasus DIAGLIST kosong TOTAL (lihat FIELD_ERRORS rule RV-05): kalau DIAGLIST kosong tapi
   BUKTI_DOKUMEN memuat istilah diagnosis eksplisit (mis. label "Diag Awal", "Diagnosa",
   "Assessment"/"A:", "Diagnosa Kerja"),
   WAJIB usulkan minimal 1 kode ICD-10 di suggested_codes berdasarkan istilah itu — jangan biarkan
   suggested_codes kosong hanya karena belum ada kode yang diklaim sama sekali. quotation WAJIB kutipan
   VERBATIM istilah diagnosis dari dokumen (bukan kode ICD-10 itu sendiri, karena kodenya memang tidak
   tercetak di dokumen — itulah sebabnya diusulkan); reasoning jelaskan pemetaan istilah -> kode secara
   singkat. Kalau istilah diagnosisnya ambigu/terlalu umum untuk dipetakan ke 1 kode pasti, boleh usulkan
   lebih dari 1 kandidat kode dengan reasoning masing-masing, atau lewati kalau benar-benar tidak yakin —
   jangan mengarang kode hanya supaya field ini terisi.
4. Kalau ada PENGETAHUAN_TERDAHULU (pola error serupa yang pernah ditemukan): jadikan referensi
   supaya konsisten dengan penilaian sebelumnya, TAPI jangan disalin mentah — selalu sesuaikan
   dengan data record ini.
5. Untuk field yang gagal validasi (FIELD_ERRORS), samping catatan di field_notes, buat JUGA versi
   GENERALISASI-nya (tanpa nama pasien/nomor SEP/nomor kartu/data identitas apapun — cuma pola
   penyebab & solusi umum yang berlaku untuk kasus serupa) di "knowledge_updates", supaya bisa
   dipakai sebagai referensi untuk record lain dengan rule_id sama di masa depan. Kalau catatan
   di field_notes SUDAH sama persis dengan salah satu PENGETAHUAN_TERDAHULU yang diberikan (tidak
   ada hal baru), JANGAN buat entri knowledge_updates duplikat untuk rule_id itu.

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

function buildPrompt(record, validationErrors, evidencePool, codes, knowledgeEntries = []) {
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
async function generateAiReview(record, validationErrors = [], evidencePool = [], knowledgeEntries = []) {
  const codes = pickCodes(record);
  const hasCodesToCheck = evidencePool.length > 0 && (codes.diagnosis.length > 0 || codes.procedure.length > 0);

  if (validationErrors.length === 0 && !hasCodesToCheck) {
    return null; // tidak ada yang perlu direview
  }

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  if (!apiKey) return null; // fallback ke rule-engine saja, seperti sebelumnya

  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const maxAttempts = Number(process.env.AI_MAX_ATTEMPTS || 3);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

  const userPrompt = buildPrompt(record, validationErrors, evidencePool, codes, knowledgeEntries);

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

      const result = { field_notes: {}, code_evidence: [], suggested_codes: [], knowledge_updates: [], tokens_used: tokensUsed };
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
        for (const entry of aiResult.suggested_codes) {
          const { page_number: pageNum, quotation } = entry;
          if (!quotation || !pageNum) continue;
          if (!validateQuotation(quotation, pageNum, evidencePool)) continue;
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
  AI_REVIEW_SYSTEM_PROMPT,
};
