/**
 * Mesin pemilihan kode (rule engine a-g) + model 5-status + lapisan AI
 * "pilih dari kandidat, tidak boleh mengarang".
 *
 * SISTEM BARU, PARALEL — belum disambung ke pipeline hidup
 * (kodeDiagnosisWhoService.js / kodeTindakanBaruService.js / aiReviewService.js
 * TIDAK disentuh). Modul ini dibangun sejalan dengan skema+mesin pencarian
 * yang dikerjakan agen lain; integrasi penuh menyusul setelah branch digabung.
 *
 * KONTRAK YANG DIASUMSIKAN (lihat laporan commit untuk rekonsiliasi):
 *   - Kandidat hasil pencarian: {kode, sistem, judul, lapis, skor}
 *     lapis: 1 = kamus lokal (persis), 2 = cocok judul, 3 = trigram/lemah.
 *   - Tabel referensi `ref_kode` (dibuat agen lain), kolom yang dipakai di sini:
 *     kode, punya_turunan (bool), kode_gejala (bool, bab R),
 *     jenis_kelamin ('L'|'P'|null), umur_min/umur_maks (tahun, boleh null),
 *     asterisk (bool), sebab_luar (bool, V01-Y98).
 *   - `cariKandidatKode(db, {teks, sistem, rsId}) -> Promise<Array<kandidat>>`
 *     adalah INTERFACE EKSTERNAL — tidak diimplementasikan di sini, WAJIB
 *     disuntikkan pemanggil (lihat `deps.cariKandidatKode` di prosesDaftarKode).
 *     Di tes dipakai mock; implementasi nyata menyusul setelah branch digabung.
 *
 * ATURAN KERAS: kode tidak pernah diterima tanpa ada di ref_kode (aturan a),
 * dan tidak pernah diterima tanpa kutipan yang benar-benar ada di teks halaman
 * (aturan g, lewat pagarTemuanService.verifikasiKutipan). AI (bila dipakai)
 * HANYA boleh memilih dari daftar kandidat yang sudah lolos aturan a-f;
 * jawaban di luar daftar atau tanpa kutipan terverifikasi DITOLAK, bukan
 * ditebak ulang.
 */

const pagarTemuan = require('./pagarTemuanService');
const gatewayModel = require('./gatewayModelService');

// Nama tugas BARU untuk gatewayModelService.panggilModel. BELUM terdaftar di
// routerModelService.TUGAS (lihat laporan commit) — tanpa pendaftaran, router
// otomatis jatuh ke konfigurasi env (perilaku aman, lihat routerModelService.js
// resolve(): tugas tak dikenal hanya menghasilkan peringatan, tidak melempar).
const TUGAS_PILIH_KODE = 'pilih_kode_dari_kandidat';

const ALASAN_TOLAK = Object.freeze({
  TIDAK_DI_REF_KODE: 'a_tidak_ada_di_ref_kode',
  PUNYA_TURUNAN: 'b_punya_turunan_butuh_lebih_spesifik',
  GEJALA_TERGANTIKAN: 'c_gejala_tergantikan_diagnosis_penyebab',
  JENIS_KELAMIN_TIDAK_COCOK: 'd_jenis_kelamin_tidak_cocok',
  UMUR_TIDAK_COCOK: 'd_umur_tidak_cocok',
  ASTERISK_TANPA_DAGGER: 'e_asterisk_tanpa_dagger_sebagai_primer',
  SEBAB_LUAR_SEBAGAI_PRIMER: 'f_sebab_luar_tidak_boleh_primer',
  KUTIPAN_TIDAK_TERVERIFIKASI: 'g_kutipan_tidak_terverifikasi',
});

// Penanda "belum dilakukan" (bagian 6 spek) — prosedur dengan kata ini TIDAK
// boleh dikodekan, dikeluarkan dari daftar dengan flag `rencana: true`.
const PENANDA_RENCANA = [
  'rencana', 'pro', 'advis', 'usul', 'planning', 'konsul',
  'cek tanpa hasil', 'cek-tanpa-hasil', 'jika perlu', 'k/p',
];

function normalisasiKode(kode) {
  return String(kode == null ? '' : kode).trim().toUpperCase();
}

/** '1'/'2'/'L'/'P'/'Laki-laki'/'Perempuan' (lihat claimFiles.js SEX validator) -> 'L'|'P'|null. */
function normalisasiJenisKelamin(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (s === 'L' || s === '1' || s === 'LAKI-LAKI') return 'L';
  if (s === 'P' || s === '2' || s === 'PEREMPUAN') return 'P';
  return null;
}

/**
 * Normalisasi untuk cek frasa penanda "belum dilakukan": huruf kecil, semua
 * tanda baca (hyphen, slash, titik dua, titik, dll — bukan cuma hyphen/slash)
 * jadi spasi, supaya batas kata tidak gagal gara-gara tanda baca menempel
 * (mis. "cek tanpa hasil:" tetap kena marker "cek tanpa hasil").
 */
function normalisasiKataUntukPenanda(teks) {
  return String(teks == null ? '' : teks)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Apakah teks prosedur memuat penanda "belum dilakukan" (rencana/pro/advis/dst).
 * Dicocokkan sebagai frasa utuh (batas kata), bukan substring longgar, supaya
 * "pro" tidak mengenai "problem" dkk.
 */
function deteksiRencana(teks) {
  const kata = normalisasiKataUntukPenanda(teks);
  if (!kata) return false;
  return PENANDA_RENCANA.some((p) => {
    const pNorm = normalisasiKataUntukPenanda(p);
    const re = new RegExp(`(^|\\s)${pNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
    return re.test(` ${kata} `.replace(/\s+/g, ' '));
  });
}

/**
 * verifikasiKutipan + NFKC (ligatur PDF seperti "ﬁ" -> "fi"). pagarTemuanService
 * ternyata hanya NFC (lihat normalisasiTeks di sana): tidak memecah ligatur.
 * Spek secara eksplisit memperingatkan kutipan yang benar bisa salah ditolak
 * tanpa NFKC. Supaya logika pencocokan TIDAK diimplementasikan ulang (aturan
 * keras tugas ini), fungsi ini hanya menambahkan satu langkah normalisasi NFKC
 * di depan sebelum mendelegasikan sepenuhnya ke verifikasiKutipan asli.
 */
function verifikasiKutipanDenganNfkc(kutipan, nomorHalaman, halaman) {
  const kutipanNfkc = typeof kutipan === 'string' ? kutipan.normalize('NFKC') : kutipan;
  const halamanNfkc = (halaman || []).map((h) => {
    if (!h) return h;
    const salinan = { ...h };
    if (typeof salinan.ocr_text === 'string') salinan.ocr_text = salinan.ocr_text.normalize('NFKC');
    if (typeof salinan.text === 'string') salinan.text = salinan.text.normalize('NFKC');
    return salinan;
  });
  return pagarTemuan.verifikasiKutipan(kutipanNfkc, nomorHalaman, halamanNfkc);
}

/**
 * Aturan a-g, PURE & SINKRON. Tidak menyentuh DB/model — pemanggil (orkestrator
 * di bawah) yang mengisi atribut ref_kode dan kutipan sebelum memanggil ini.
 *
 * @param {Array<object>} kandidat tiap elemen: {kode, sistem, judul, lapis, skor, ref}
 *   ref: {ditemukan, punya_turunan, kode_gejala, jenis_kelamin, umur_min, umur_maks,
 *         asterisk, sebab_luar} — field selain `ditemukan` boleh null/undefined
 *         (dianggap "tidak diketahui" -> aturan terkait dilewati, bukan menolak).
 * @param {object} konteks
 *   jenisKelamin: 'L'|'P'|null (pasien, sudah dinormalkan)
 *   umurTahun: number|null
 *   posisi: 'primer'|'sekunder' (default 'primer')
 *   daggerHadir: boolean (aturan e; default false — deteksi otomatis dagger
 *     TIDAK diimplementasikan, lihat catatan di bawah)
 *   adaDiagnosisPenyebabLain: boolean (aturan c; dihitung lintas-daftar oleh
 *     orkestrator, lihat prosesDaftarKode)
 *   kutipan: {teks, halaman, halamanBerkas} (aturan g; kalau tidak diberikan,
 *     aturan g DILEWATI — orkestrator produksi WAJIB selalu mengisi ini)
 * @returns {{diterima:Array, ditolak:Array<{kandidat, alasan}>}}
 *
 * CATATAN KETERBATASAN (didokumentasikan sesuai permintaan tugas):
 *  - Deteksi pasangan asterisk/dagger OTOMATIS tidak diimplementasikan (data
 *    sumber untuk itu disebut tidak reliabel oleh agen lain). `daggerHadir`
 *    harus disuplai eksplisit oleh pemanggil kalau sudah diketahui ada kode
 *    dagger lain di daftar yang sama; default aman adalah false (anggap tidak
 *    ada dagger -> aturan e tetap menolak asterisk sebagai primer, sikap
 *    konservatif yang sesuai niat aturan).
 */
function terapkanAturanKode(kandidat, konteks = {}) {
  const posisi = konteks.posisi === 'sekunder' ? 'sekunder' : 'primer';
  const daggerHadir = konteks.daggerHadir === true;
  const diterima = [];
  const ditolak = [];

  for (const k of kandidat || []) {
    const ref = (k && k.ref) || {};
    const tolak = (alasan) => ditolak.push({ kandidat: k, alasan });

    // a. harus ada di ref_kode.
    if (ref.ditemukan !== true) { tolak(ALASAN_TOLAK.TIDAK_DI_REF_KODE); continue; }

    // b. harus level paling spesifik (punya_turunan=true -> ada anak yang lebih spesifik).
    if (ref.punya_turunan === true) { tolak(ALASAN_TOLAK.PUNYA_TURUNAN); continue; }

    // c. kode gejala dibuang kalau ada diagnosis penyebab terkonfirmasi di daftar yang sama.
    if (ref.kode_gejala === true && konteks.adaDiagnosisPenyebabLain === true) {
      tolak(ALASAN_TOLAK.GEJALA_TERGANTIKAN); continue;
    }

    // d. kecocokan jenis kelamin & umur.
    if (ref.jenis_kelamin && konteks.jenisKelamin && ref.jenis_kelamin !== konteks.jenisKelamin) {
      tolak(ALASAN_TOLAK.JENIS_KELAMIN_TIDAK_COCOK); continue;
    }
    if (konteks.umurTahun != null) {
      if (ref.umur_min != null && Number(konteks.umurTahun) < Number(ref.umur_min)) {
        tolak(ALASAN_TOLAK.UMUR_TIDAK_COCOK); continue;
      }
      if (ref.umur_maks != null && Number(konteks.umurTahun) > Number(ref.umur_maks)) {
        tolak(ALASAN_TOLAK.UMUR_TIDAK_COCOK); continue;
      }
    }

    // e. kode asterisk tidak boleh jadi primer/satu-satunya tanpa dagger pendamping.
    if (ref.asterisk === true && posisi === 'primer' && !daggerHadir) {
      tolak(ALASAN_TOLAK.ASTERISK_TANPA_DAGGER); continue;
    }

    // f. kode sebab luar (V01-Y98) tidak boleh jadi primer/satu-satunya.
    if (ref.sebab_luar === true && posisi === 'primer') {
      tolak(ALASAN_TOLAK.SEBAB_LUAR_SEBAGAI_PRIMER); continue;
    }

    // g. kutipan wajib terverifikasi di teks halaman (kalau diberikan).
    if (konteks.kutipan) {
      const cek = verifikasiKutipanDenganNfkc(
        konteks.kutipan.teks, konteks.kutipan.halaman, konteks.kutipan.halamanBerkas,
      );
      if (!cek.valid) { tolak(ALASAN_TOLAK.KUTIPAN_TIDAK_TERVERIFIKASI); continue; }
    }

    diterima.push(k);
  }

  return { diterima, ditolak };
}

// --------------------------------------------------------------------------
// Lapisan AI: "pilih dari kandidat, jangan mengarang" (bagian 8 spek).
// --------------------------------------------------------------------------

const INSTRUKSI_PILIH_KODE =
  'Anda hanya boleh memilih kode dari DAFTAR KANDIDAT di bawah.\n' +
  'Jangan menulis kode di luar daftar. Jangan gunakan ICD-10-CM.\n' +
  'Untuk setiap pilihan, sertakan kutipan persis dari berkas yang mendukungnya.\n' +
  'Kalau tidak ada kandidat yang cocok, jawab status "tidak_ada_padanan" beserta alasannya. Jangan menebak.';

function buatPromptPilihKode({ teks, kandidat, konteksTambahan }) {
  const daftar = (kandidat || [])
    .map((k) => `${k.kode} — ${k.judul || '(tanpa judul)'}`)
    .join('\n');
  let prompt = `Istilah/diagnosis di dokumen: "${teks}"\n\nDAFTAR KANDIDAT:\n${daftar}\n`;
  if (konteksTambahan) prompt += `\nKonteks tambahan:\n${konteksTambahan}\n`;
  prompt +=
    '\nJawab JSON: {"status":"terpilih","kode":"...","kutipan":"...","halaman":N} ' +
    'atau {"status":"tidak_ada_padanan","alasan":"..."}.';
  return prompt;
}

/**
 * Validasi pasca-respons model, sesuai bagian 8 spek:
 *   if (!kandidat.includes(jawaban.kode)) tolak('kode di luar daftar kandidat');
 *   if (!teksHalaman.includes(rapikan(jawaban.kutipan))) tolak('kutipan tidak ditemukan');
 * Tidak pernah melempar — pelanggaran apa pun menghasilkan {diterima:false, alasan}.
 */
function validasiJawabanAi(jawaban, kandidatList, halamanBerkas) {
  const kandidatKodeSet = new Set((kandidatList || []).map((k) => normalisasiKode(k.kode)));

  if (!jawaban || typeof jawaban !== 'object') {
    return { diterima: false, alasan: 'jawaban_bukan_objek' };
  }
  if (jawaban.status === 'tidak_ada_padanan') {
    return { diterima: true, hasil: { status: 'tidak_ada_padanan', alasan: jawaban.alasan || null } };
  }
  const kodeDijawab = normalisasiKode(jawaban.kode);
  if (!kodeDijawab || !kandidatKodeSet.has(kodeDijawab)) {
    return { diterima: false, alasan: 'kode_di_luar_daftar_kandidat' };
  }
  const cekKutipan = verifikasiKutipanDenganNfkc(jawaban.kutipan, jawaban.halaman, halamanBerkas);
  if (!cekKutipan.valid) {
    return { diterima: false, alasan: `kutipan_tidak_ditemukan:${cekKutipan.alasan}` };
  }
  const dipilih = kandidatList.find((k) => normalisasiKode(k.kode) === kodeDijawab);
  return {
    diterima: true,
    hasil: {
      status: 'terpilih', kode: kodeDijawab, judul: dipilih ? dipilih.judul : null,
      kutipan: jawaban.kutipan, halaman: jawaban.halaman,
    },
  };
}

/**
 * Panggil model untuk memilih SATU kode dari kandidat yang sudah lolos aturan
 * a-f. Dipakai sebagai saran tambahan (`saran_ai`) saat orkestrator menemukan
 * 2+ kandidat tersisa — status akhir tetap `pilih_kandidat` per spek (lihat
 * catatan desain di prosesDaftarKode), saran ini hanya metadata tambahan yang
 * SUDAH divalidasi (dalam daftar + kutipan terverifikasi), tidak pernah
 * dipakai untuk diam-diam menaikkan status jadi `terpilih`.
 *
 * @param {object} opsi {teks, kandidat, halamanBerkas, dikenal, db, panggilModelFn}
 * @returns {Promise<{diterima:boolean, hasil?:object, alasan?:string}>}
 */
async function pilihDenganAiDariKandidat(opsi = {}) {
  const { teks, kandidat, halamanBerkas, dikenal, db, panggilModelFn } = opsi;
  if (!kandidat || kandidat.length === 0) return { diterima: false, alasan: 'tidak_ada_kandidat' };
  const panggil = panggilModelFn || gatewayModel.panggilModel;
  const prompt = buatPromptPilihKode({ teks, kandidat });
  let resp;
  try {
    resp = await panggil(TUGAS_PILIH_KODE, { prompt, system: INSTRUKSI_PILIH_KODE, json: true, dikenal }, { db });
  } catch (err) {
    return { diterima: false, alasan: `model_error:${String(err.message || err).slice(0, 160)}` };
  }
  if (!resp || !resp.ok) return { diterima: false, alasan: `model_gagal:${(resp && resp.error) || 'tidak diketahui'}` };
  return validasiJawabanAi(resp.hasil, kandidat, halamanBerkas);
}

// --------------------------------------------------------------------------
// Pengambilan atribut ref_kode (query nyata, bukan interface eksternal —
// tabelnya dijanjikan agen lain dengan kolom-kolom di atas). Kalau tabel
// belum ada / query gagal, SEMUA kode dianggap "tidak ditemukan" (aman:
// aturan a akan menolaknya, selaras dengan "jangan pernah mengarang kode").
// --------------------------------------------------------------------------
async function ambilAtributKode(db, kodeList) {
  const unik = [...new Set((kodeList || []).map(normalisasiKode).filter(Boolean))];
  const peta = new Map();
  if (unik.length === 0) return peta;
  try {
    const placeholders = unik.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT kode, punya_turunan, kode_gejala, jenis_kelamin, umur_min, umur_maks, asterisk, sebab_luar
       FROM ref_kode WHERE kode IN (${placeholders})`,
      unik,
    );
    for (const r of rows || []) {
      peta.set(normalisasiKode(r.kode), {
        ditemukan: true,
        punya_turunan: r.punya_turunan === true,
        kode_gejala: r.kode_gejala === true,
        jenis_kelamin: r.jenis_kelamin || null,
        umur_min: r.umur_min == null ? null : Number(r.umur_min),
        umur_maks: r.umur_maks == null ? null : Number(r.umur_maks),
        asterisk: r.asterisk === true,
        sebab_luar: r.sebab_luar === true,
      });
    }
  } catch (err) {
    console.warn(`[PemilihKode] ref_kode tidak terbaca (${err.message}); semua kode dianggap tidak ditemukan.`);
  }
  return peta;
}

// --------------------------------------------------------------------------
// Orkestrator: satu item (diagnosis/prosedur) -> salah satu dari 5 status.
// --------------------------------------------------------------------------

const STRONG_LAPIS = new Set([1, 2]);

/**
 * Proses satu item teks (sudah punya kandidat + atribut ref_kode terpasang)
 * menjadi salah satu dari 5 status. Dipanggil oleh prosesDaftarKode untuk
 * tiap item, setelah aturan c (lintas-daftar) dihitung.
 */
async function putuskanStatusItem({ item, kandidatTerisi, konteksAturan, deps }) {
  const { diterima, ditolak } = terapkanAturanKode(kandidatTerisi, konteksAturan);

  if (diterima.length === 0) {
    const alasanUtama = ditolak.length ? ditolak[0].alasan : 'tidak_diketahui';
    const hasil = { status: 'tidak_ada_padanan', alasan: alasanUtama, teks_asli: item.teks };
    const kodeDitolakTakAdaRef = ditolak
      .filter((d) => d.alasan === ALASAN_TOLAK.TIDAK_DI_REF_KODE)
      .map((d) => d.kandidat.kode);
    if (kodeDitolakTakAdaRef.length > 0 && deps && deps.db) {
      const cari = (deps && deps.ambilKodeTerdekat) || ambilKodeTerdekat;
      const kodeTerdekat = await cari(deps.db, kodeDitolakTakAdaRef);
      if (kodeTerdekat) hasil.kode_terdekat = kodeTerdekat;
    }
    return hasil;
  }

  const kuat = diterima.filter((k) => STRONG_LAPIS.has(Number(k.lapis)));
  if (diterima.length === 1 && kuat.length === 1) {
    const k = diterima[0];
    return {
      status: 'terpilih',
      kode: k.kode,
      judul: k.judul,
      kutipan: konteksAturan.kutipan ? konteksAturan.kutipan.teks : item.kutipan,
      halaman: konteksAturan.kutipan ? konteksAturan.kutipan.halaman : item.halaman,
    };
  }

  // 2+ kandidat tersisa, ATAU satu-satunya yang tersisa berasal dari lapis 3
  // (lemah) -> pilih_kandidat, sesuai spek. AI boleh dipanggil sebagai saran
  // tambahan (lihat catatan desain di pilihDenganAiDariKandidat), tapi tidak
  // mengubah status ini.
  const kandidatRingkas = diterima.slice(0, 5).map((k) => ({ kode: k.kode, judul: k.judul, lapis: k.lapis }));
  const hasil = { status: 'pilih_kandidat', kandidat: kandidatRingkas };
  if (deps && deps.panggilAi) {
    try {
      const saran = await pilihDenganAiDariKandidat({
        teks: item.teks,
        kandidat: diterima,
        halamanBerkas: deps.halamanBerkas,
        dikenal: deps.dikenal,
        db: deps.db,
        panggilModelFn: deps.panggilModelFn,
      });
      if (saran.diterima) hasil.saran_ai = saran.hasil;
      else hasil.saran_ai_ditolak = saran.alasan;
    } catch (err) {
      hasil.saran_ai_ditolak = `error:${String(err.message || err).slice(0, 160)}`;
    }
  }
  return hasil;
}

/**
 * Best-effort, MEKANIS SAJA: kalau sebuah kode ditolak aturan a (tidak ada di
 * ref_kode — biasanya karena ICD-10-CM, mis. "R10.84"), coba cari kode LAIN
 * pada kategori 3-karakter yang SAMA (mis. "R10") yang valid & tidak punya
 * turunan (pola dipakai juga di kodeDiagnosisWhoService.js untuk kasus
 * serupa: R10.84 -> R10.4). Hanya disarankan kalau PERSIS SATU kandidat yang
 * cocok ditemukan — kalau ambigu (0 atau >1), tidak dipaksakan (null).
 *
 * KETERBATASAN YANG DIDOKUMENTASIKAN SESUAI PERMINTAAN TUGAS: pendekatan ini
 * TIDAK bisa menjangkau kesamaan lintas-kategori yang sifatnya klinis, bukan
 * struktur kode — contoh di spek "HT urgensi/emergensi" (I16.0/I16.1 ditolak)
 * -> I10 TIDAK bisa diturunkan dari sini karena I16 dan I10 adalah kategori
 * ICD yang berbeda sama sekali (hubungan klinis "sama-sama tentang hipertensi"
 * bukan hubungan "induk-anak kode"). Untuk celah yang sudah diketahui seperti
 * itu, kode_terdekat sengaja TIDAK diisi oleh mekanisme umum ini; pemilik
 * produk perlu tabel celah-dikenal terpisah atau penilaian AI/manusia kalau
 * mau mengisi kasus itu — jangan dipaksakan di sini supaya tidak mengarang
 * asosiasi yang sebenarnya tidak berdasar struktur data.
 */
async function ambilKodeTerdekat(db, kodeDitolakList) {
  for (const kodeAsal of kodeDitolakList || []) {
    const m = normalisasiKode(kodeAsal).match(/^[A-Z]\d{2}/);
    if (!m) continue;
    const kategori = m[0];
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.all(
        'SELECT kode FROM ref_kode WHERE kode LIKE ? AND punya_turunan = false',
        [`${kategori}%`],
      );
      if (rows && rows.length === 1) return rows[0].kode;
    } catch (err) {
      console.warn(`[PemilihKode] Gagal mencari kode_terdekat: ${err.message}`);
    }
  }
  return null;
}

/**
 * Titik masuk utama: proses SELURUH daftar diagnosis/prosedur sekaligus
 * (wajib, bukan satu per satu — lihat aturan c yang beroperasi lintas-daftar).
 *
 * @param {object} opsi
 *   db: koneksi DB (diteruskan ke deps.cariKandidatKode / ambilAtributKode / model)
 *   items: Array<{teks, halaman, kutipan?, posisi?, daggerHadir?}>
 *     teks kosong/'-' -> status tidak_tertulis otomatis, tanpa pencarian.
 *   jenisDaftar: 'diagnosis'|'prosedur' (default 'diagnosis')
 *     'prosedur' mengaktifkan deteksi "belum dilakukan" (rencana/pro/dkk).
 *   sistem: 'icd10'|'icd9' (diteruskan ke cariKandidatKode)
 *   rsId: id rumah sakit (diteruskan ke cariKandidatKode)
 *   pasien: {jenisKelamin, umurTahun} — jenisKelamin boleh mentah ('1'/'2'/'L'/'P'),
 *     dinormalkan di sini.
 *   halamanBerkas: Array<{page_number, ocr_text|text}> teks semua halaman klaim,
 *     dipakai aturan g.
 *   deps: {
 *     cariKandidatKode: WAJIB, async (db,{teks,sistem,rsId}) -> kandidat[]
 *       (INTERFACE EKSTERNAL — lihat header modul; belum diimplementasikan di sini)
 *     ambilAtributKode: opsional, default ambilAtributKode asli di modul ini
 *     panggilAi: boolean, default false — kalau true, hasil pilih_kandidat
 *       dilengkapi `saran_ai` (lihat putuskanStatusItem)
 *     panggilModelFn, dikenal: diteruskan ke pilihDenganAiDariKandidat
 *   }
 * @returns {Promise<Array>} satu hasil per item, urutan sama dengan `items`.
 */
async function prosesDaftarKode(opsi = {}) {
  const {
    db, items = [], jenisDaftar = 'diagnosis', sistem = 'icd10', rsId, pasien = {}, halamanBerkas = [],
    deps = {},
  } = opsi;
  if (!deps.cariKandidatKode) {
    throw new Error(
      'deps.cariKandidatKode wajib disuntikkan (interface eksternal — lihat header pemilihKodeService.js). '
      + 'Belum ada implementasi nyata di cabang ini; di produksi isi dengan mesin pencarian hasil gabungan branch.',
    );
  }
  const ambilAtribut = deps.ambilAtributKode || ambilAtributKode;
  const jenisKelamin = normalisasiJenisKelamin(pasien.jenisKelamin);
  const umurTahun = pasien.umurTahun == null ? null : Number(pasien.umurTahun);

  // Tahap 0: pisahkan item kosong/"-" (tidak_tertulis) dan, untuk prosedur,
  // item dengan penanda "belum dilakukan" (rencana:true).
  const indeksAktif = [];
  const hasilAwal = new Array(items.length).fill(null);
  items.forEach((item, i) => {
    const teks = typeof item.teks === 'string' ? item.teks.trim() : '';
    if (!teks || teks === '-') {
      hasilAwal[i] = { status: 'tidak_tertulis', halaman: item.halaman != null ? item.halaman : null };
      return;
    }
    if (jenisDaftar === 'prosedur' && deteksiRencana(teks)) {
      hasilAwal[i] = {
        status: 'tidak_tertulis', rencana: true, halaman: item.halaman != null ? item.halaman : null,
        teks_asli: teks,
      };
      return;
    }
    indeksAktif.push(i);
  });

  // Tahap 1: cari kandidat mentah untuk tiap item aktif.
  const kandidatMentah = new Array(items.length).fill(null);
  for (const i of indeksAktif) {
    const item = items[i];
    const ditemukan = await deps.cariKandidatKode(db, { teks: item.teks.trim(), sistem, rsId });
    if (!ditemukan || ditemukan.length === 0) {
      hasilAwal[i] = { status: 'tidak_dikenali', teks_asli: item.teks.trim() };
      kandidatMentah[i] = [];
      continue;
    }
    kandidatMentah[i] = ditemukan;
  }

  // Tahap 2: ambil atribut ref_kode untuk SEMUA kode kandidat sekaligus.
  const semuaKode = indeksAktif.flatMap((i) => (kandidatMentah[i] || []).map((k) => k.kode));
  const petaAtribut = await ambilAtribut(db, semuaKode);
  const isiKandidat = (list) => (list || []).map((k) => ({
    ...k, ref: petaAtribut.get(normalisasiKode(k.kode)) || { ditemukan: false },
  }));

  // Tahap 3 (lintas-daftar, HANYA diagnosis): tentukan item mana yang punya
  // kandidat "penyebab terkonfirmasi" (bukan kode gejala) setelah aturan
  // a,b,d,e,f (TANPA c dulu) — dipakai untuk menggugurkan kode gejala di item
  // lain pada daftar yang sama (aturan c).
  let adaPenyebabTerkonfirmasi = false;
  if (jenisDaftar === 'diagnosis') {
    for (const i of indeksAktif) {
      if (hasilAwal[i]) continue; // sudah tidak_dikenali
      const terisi = isiKandidat(kandidatMentah[i]);
      const posisi = items[i].posisi || (i === indeksAktif[0] ? 'primer' : 'sekunder');
      const { diterima } = terapkanAturanKode(terisi, {
        jenisKelamin, umurTahun, posisi, daggerHadir: items[i].daggerHadir === true,
      });
      if (diterima.some((k) => k.ref && k.ref.kode_gejala === false)) {
        adaPenyebabTerkonfirmasi = true;
        break;
      }
    }
  }

  // Tahap 4: putuskan status final tiap item (aturan a-g lengkap).
  for (const i of indeksAktif) {
    if (hasilAwal[i]) continue; // sudah tidak_dikenali
    const item = items[i];
    const terisi = isiKandidat(kandidatMentah[i]);
    const posisi = item.posisi || (i === indeksAktif[0] ? 'primer' : 'sekunder');
    const konteksAturan = {
      jenisKelamin,
      umurTahun,
      posisi,
      daggerHadir: item.daggerHadir === true,
      adaDiagnosisPenyebabLain: jenisDaftar === 'diagnosis' ? adaPenyebabTerkonfirmasi : false,
      kutipan: item.kutipan !== false
        ? { teks: item.kutipan || item.teks, halaman: item.halaman, halamanBerkas }
        : null,
    };
    // eslint-disable-next-line no-await-in-loop
    hasilAwal[i] = await putuskanStatusItem({
      item, kandidatTerisi: terisi, konteksAturan,
      deps: { panggilAi: deps.panggilAi, halamanBerkas, dikenal: deps.dikenal, db, panggilModelFn: deps.panggilModelFn },
    });
  }

  return hasilAwal;
}

module.exports = {
  TUGAS_PILIH_KODE,
  ALASAN_TOLAK,
  PENANDA_RENCANA,
  normalisasiKode,
  normalisasiJenisKelamin,
  deteksiRencana,
  verifikasiKutipanDenganNfkc,
  terapkanAturanKode,
  INSTRUKSI_PILIH_KODE,
  buatPromptPilihKode,
  validasiJawabanAi,
  pilihDenganAiDariKandidat,
  ambilAtributKode,
  ambilKodeTerdekat,
  prosesDaftarKode,
};
