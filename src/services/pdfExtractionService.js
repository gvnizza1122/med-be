const { PDF_FIELDS, SYSTEM_FIELDS, buildRecord, toTSV, COLUMNS } = require('./vclaimSchema');

/**
 * Ekstrak teks halaman claim-data → 1 record vClaim (60 kolom, format asli vClaim).
 * Kolom bersumber 'system' (CODER_ID, C1-C4, TARIF_RS, dst) TIDAK diminta ke AI —
 * data itu tidak ada di PDF; mengarang nilainya = data palsu.
 *
 * @param {string} claimDataText - hasil classifyPdfPages().claimDataText
 * @param {string} [jenisKlaim] - kategori pelayanan (RAWAT_JALAN/RAWAT_INAP/GAWAT_DARURAT),
 *   dipilih user saat upload — dipakai untuk instruksi khusus KELAS_RAWAT (lihat prompt).
 * @returns {Promise<{success, record, tokens, missingSystemFields, errors}>}
 */
async function extractClaimData(claimDataText, jenisKlaim) {
  const result = {
    success: false,
    record: {},
    tokens: { prompt: 0, completion: 0, total: 0 },
    attempts: 0,
    missingSystemFields: [...SYSTEM_FIELDS],
    errors: [],
  };

  const apiKey = process.env.AI_PROVIDER_API_KEY;
  const baseUrl = process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  if (!apiKey) { result.errors.push('AI_PROVIDER_API_KEY tidak diisi di .env'); return result; }
  if (!claimDataText || !claimDataText.trim()) { result.errors.push('claimDataText kosong'); return result; }

  // RAWAT_JALAN dan GAWAT_DARURAT (IGD tanpa lanjut rawat inap) sama-sama
  // pasien tidak menginap — diverifikasi dari sampel PDF IGD asli (Resume
  // Medis IGD/Triage IGD, Juni-Juli 2026): sama sekali tidak ada field
  // "Kelas Rawat" atau "Tanggal Masuk"/"Tanggal Keluar" terpisah, cuma
  // "Tgl Periksa" tunggal — persis pola rawat jalan.
  const isOutpatientLike = jenisKlaim === 'RAWAT_JALAN' || jenisKlaim === 'GAWAT_DARURAT';

  const kelasRawatRule = isOutpatientLike
    ? `8. KELAS_RAWAT khusus rawat jalan/IGD (tanpa rawat inap): pasien TIDAK dirawat inap, jadi field "Kelas Rawat"/"Kls Rawat" di dokumen wajar KOSONG atau "-". Untuk kasus ini, isi KELAS_RAWAT dari NOMOR KELAS di field "Kelas Hak"/"Kls Hak" (kelas hak kepesertaan BPJS pasien, BUKAN kelas ruangan rawat inap) — ambil hanya angkanya (contoh: "Kelas 2" -> "2"). Kalau "Kelas Hak" juga tidak ada, baru isi KELAS_RAWAT dengan "".`
    : `8. KELAS_RAWAT: ambil dari field "Kelas Rawat"/"Kls Rawat" (kelas ruangan rawat inap pasien), ambil hanya angkanya (contoh: "Kelas 2" -> "2"). JANGAN pakai "Kelas Hak" untuk field ini.`;

  // Rawat jalan & IGD-tanpa-inap tidak punya konsep "tanggal masuk"/"tanggal
  // keluar" terpisah — dokumennya cuma mencantumkan satu tanggal pelayanan/
  // kunjungan/periksa. Tanpa aturan ini, rule 6 ("jangan menebak, jangan
  // menyalin dari field lain") bikin AI membiarkan ADMISSION_DATE &
  // DISCHARGE_DATE kosong terus meski tanggalnya sebetulnya ada di dokumen,
  // cuma labelnya beda — persis kasus yang sama dengan KELAS_RAWAT di atas.
  const tanggalRawatJalanRule = isOutpatientLike
    ? `\n8b. ADMISSION_DATE & DISCHARGE_DATE khusus rawat jalan/IGD (tanpa rawat inap): dokumen jenis ini biasanya TIDAK punya field "Tanggal Masuk"/"Tanggal Keluar" terpisah (pasien tidak menginap). Kalau field itu tidak ada tapi ada "Tanggal Pelayanan", "Tanggal Kunjungan", "Tgl Periksa", atau tanggal pada SEP yang menunjukkan kapan pasien dilayani, isi ADMISSION_DATE dan DISCHARGE_DATE dengan tanggal yang SAMA itu (satu hari kunjungan = tanggal masuk = tanggal keluar). Kalau memang tidak ada tanggal pelayanan/kunjungan sama sekali di dokumen, baru isi keduanya dengan "".`
    : '';

  const prompt = `Kamu ekstraktor data klaim BPJS dari dokumen scan/print RS. Bentuk dokumennya BUKAN
"Berkas Klaim Individual" (ringkasan E-Klaim terkode rapi) — itu jarang/tidak pernah ada di berkas
asli. Yang SUNGGUHAN ada dan jadi sumber utamamu:
- "RESUME MEDIS RJ" atau "RESUME MEDIS IGD": catatan dokter format S/O/A/P bebas (Subjektif =
  keluhan pasien, Objektif = pemeriksaan fisik & tanda vital, Assessment = diagnosa, Plan =
  tindakan/terapi). Kode ICD-10/ICD-9 KADANG tertulis eksplisit di bagian Assessment/Diagnosa
  (contoh: "G44 - Other headache syndromes", "39.95 - Hemodialysis") — kalau ada, salin persis;
  kalau assessment cuma teks diagnosis tanpa kode (mis. "Cefalgia Berat" tanpa "G44"), JANGAN
  mengarang kodenya sendiri, ikuti aturan 6 di bawah (kosongkan).
- "SURAT ELEGIBILITAS PESERTA" (SEP): halaman administratif BPJS, sumber SEP/NOKARTU/nama/kelas
  hak/jenis kunjungan/flag PRB (lihat aturan 7 & 10 di bawah).
- "RESEP": kadang ikut, berisi daftar obat — bukan sumber utama field klaim, boleh diabaikan
  kecuali diminta eksplisit.
Tugasmu HANYA MENYALIN apa yang benar-benar tertulis, bukan menyimpulkan atau mengarang.

ATURAN KETAT:
1. Output HANYA JSON object. Tanpa markdown, tanpa backtick, tanpa penjelasan.
2. Tanggal WAJIB format DD/MM/YYYY (contoh: 09/06/2026).
3. DIAGLIST & PROCLIST: kode dipisah titik-koma, TANPA spasi (contoh: I13.1;D63.8;L28.2).
4. Angka tarif: digit polos tanpa Rp/titik/koma (contoh: 3287300).
5. SEX: 1=laki-laki, 2=perempuan. KODE_TARIF: kode singkat saja (TARIF RS KELAS D SWASTA -> DS).
6. Kalau sebuah field TIDAK ADA di teks, isi string kosong "". JANGAN menebak, JANGAN menyalin dari field lain.
7. SEP dan NOKARTU boleh diambil dari halaman "Surat Eligibilitas Peserta" kalau ada — di
   halaman itu labelnya sering disingkat "No. SEP" (bukan "Nomor SEP") dan "No. Kartu"
   (bukan "Nomor Kartu"). Tetap SAMA PERSIS field SEP dan NOKARTU, cuma beda halaman sumber.
${kelasRawatRule}${tanggalRawatJalanRule}
8c. DISCHARGE_STATUS wajib kode angka 1-5 (BUKAN kalimat), tapi dokumen aslinya sering cuma menulis
    kata singkat di bagian "Kelanjutan"/"Rencana"/"Cara Keluar" (bukan kode). Petakan kata BAKU yang
    JELAS artinya ke kodenya (ini MEMETAKAN istilah baku, BUKAN menebak dari narasi panjang):
    "Pulang", "Rawat Jalan", "Kontrol", "Sembuh", "Membaik" -> "1" (pulang atas persetujuan dokter).
    "Rujuk", "Dirujuk" -> "2". "APS", "Pulang Paksa", "Menolak" -> "3". "Meninggal" -> "4".
    Kalau kata/frasanya TIDAK cocok jelas ke salah satu di atas (narasi panjang/ambigu), ikuti
    aturan 6 (kosongkan), JANGAN menebak.
8d. UMUR_TAHUN: kalau dokumen mencantumkan field "Umur" eksplisit (contoh: "Umur : 33 tahun"), salin
    angkanya persis. Kalau field "Umur" tidak ada di teks, kosongkan saja (JANGAN menghitung sendiri
    dari tanggal lahir — itu tugas sistem, bukan kamu).
9. Isi HANYA field vClaim berikut: ${PDF_FIELDS.join(', ')}.
10. DUA FIELD TAMBAHAN (bukan kolom vClaim resmi, dipakai internal RS buat cek pola pending
    BPJS — tetap WAJIB diisi kalau ada, ikuti aturan 6 kalau tidak ada di teks):
    a. POTENSI_PRB_SEP: di halaman "Surat Eligibilitas Peserta" (SEP), kadang ada tulisan
       "Potensi PRB" tercetak persis di sebelah/dekat baris "No. SEP" — flag ini dihitung
       sendiri oleh sistem BPJS (bukan RS), artinya pasien berpotensi program rujuk balik.
       Isi "YA" kalau tulisan "Potensi PRB" itu ADA di teks, isi "" kalau tidak ada/tidak yakin.
       JANGAN simpulkan dari diagnosis atau isi resume — HANYA dari tulisan literal di SEP.
    b. JENIS_KUNJUNGAN_SEP: di halaman SEP, ada field berlabel "Jns Kunj" — salin APA ADANYA
       isinya (contoh nilai yang sering muncul: "Konsultasi dokter (pertama)", "Tujuan Kontrol").
       Kalau field itu kosong atau tidak ketemu, isi "".
    c. KLINIK_SEP: di halaman SEP ATAU di header Resume Medis, ada field berlabel "Klinik"
       (contoh nilai: "INSTALASI GAWAT DARURAT", "UGD", "HEMODIALISA", nama poli spesialis).
       Salin APA ADANYA, jangan disingkat/diseragamkan. Dipakai untuk mendeteksi kunjungan
       lintas-poli hari yang sama (bukan kamu yang memutuskan itu, cuma salin nama kliniknya).

TEKS KLAIM:
${claimDataText}

JSON:`;

  // Model kadang balas teks penalaran / kosong alih-alih JSON (terutama model gratis).
  // Retry dengan jeda menaik; sekali sukses langsung berhenti.
  const maxAttempts = Number(process.env.AI_MAX_ATTEMPTS || 3);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 60000);

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
              { role: 'system', content: 'Kamu mengembalikan HANYA satu JSON object. Dilarang menulis penjelasan, penalaran, atau markdown.' },
              { role: 'user', content: prompt },
            ],
            // max_completion_tokens (bukan max_tokens) & tanpa temperature custom
            // — lihat catatan sama di aiReviewService.js.
            max_completion_tokens: 2000,
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
      result.tokens.prompt = data.usage?.prompt_tokens || 0;
      result.tokens.completion = data.usage?.completion_tokens || 0;
      result.tokens.total = result.tokens.prompt + result.tokens.completion;
      result.attempts = attempt;

      // Ambil JSON object dari response (toleran markdown fence / teks pengantar).
      let extracted;
      try {
        extracted = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) throw new Error(content.trim() ? 'model membalas teks, bukan JSON' : 'model membalas kosong');
        extracted = JSON.parse(m[0]);
      }

      // Buang field yang bukan milik PDF (kalau model tetap mengarang system field).
      for (const k of SYSTEM_FIELDS) delete extracted[k];

      result.record = buildRecord(extracted);
      // POTENSI_PRB_SEP, JENIS_KUNJUNGAN_SEP & KLINIK_SEP BUKAN kolom vClaim resmi (tidak ada
      // di VCLAIM_SCHEMA), jadi buildRecord() di atas selalu membuangnya — tempel
      // manual di sini supaya ikut ke raw_data & bisa dipetakan ke kolom DB
      // (flag_rujuk_balik_prb) di claimFiles.js. TIDAK ikut COLUMNS/toTSV, jadi
      // aman, tidak mengubah format ekspor vClaim resmi ke BPJS.
      if (extracted.POTENSI_PRB_SEP) result.record.POTENSI_PRB_SEP = String(extracted.POTENSI_PRB_SEP).trim();
      if (extracted.JENIS_KUNJUNGAN_SEP) result.record.JENIS_KUNJUNGAN_SEP = String(extracted.JENIS_KUNJUNGAN_SEP).trim();
      if (extracted.KLINIK_SEP) result.record.KLINIK_SEP = String(extracted.KLINIK_SEP).trim();
      result.success = true;
      result.errors = [];
      return result;
    } catch (error) {
      const msg = error.name === 'AbortError' ? `timeout ${timeoutMs}ms` : error.message;
      result.errors.push(`percobaan ${attempt}: ${msg}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }

  result.attempts = maxAttempts;
  return result;
}

module.exports = { extractClaimData, toTSV, COLUMNS };
