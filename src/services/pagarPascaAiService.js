/**
 * Pagar pasca-AI: menyambungkan modul murni pagarTemuanService,
 * negasiTemuanService, bagianTemuanService, kamusPenunjangService dan
 * resepPetunjukService ke alur AI review LIVE tanpa mengubah prompt maupun
 * skema keluaran model.
 *
 * Cara kerja: POST-PROCESSING atas `suggested_codes` (saran kode diagnosis /
 * prosedur dari AI) setelah semua tahap lama selesai (validateQuotation,
 * fallback saran, annotateKamusValid). Tahap ini hanya
 *   - MENGURANGI klaim yang tidak didukung berkas (kutipan tak ada, hanya
 *     riwayat anamnesis, diagnosis banding), dan
 *   - MENAMBAH penanda informasi (disangkal, perlu_cek_manusia, peran).
 * Tidak ada jalur di sini yang menambah kode, mengubah kode, atau mengisi
 * kolom klaim. Penanda ini bersifat informasi; tidak ada gerbang "menunggu
 * review koder" pada pembacaan.
 *
 * Tidak ada yang dibuang diam-diam: setiap saran yang gugur, disangkal, atau
 * perlu dicek manusia tercatat di `pagar_temuan` beserta alasannya. Itu juga
 * mencakup saran yang sudah gugur pada tahap lama di aiReviewService (dulu
 * hanya console.warn); pemanggil menyuplai catatannya lewat `ditolakAwal`.
 *
 * Saklar lingkungan (nilai "0/false/off/no" mematikan, selain itu hidup):
 *   PAGAR_TEMUAN_AKTIF          induk; mati = tahap ini dilewati total (default ON)
 *   PAGAR_KUTIPAN_AKTIF         periksa ulang kutipan dengan verifikasiKutipan (ON)
 *   PAGAR_NEGASI_AKTIF          tandai temuan yang disangkal (ON)
 *   PAGAR_PERAN_AKTIF           peran menurut bagian dokumen: anamnesis/banding (ON)
 *   PAGAR_TULISAN_TANGAN_AKTIF  tandai perlu cek manusia untuk sumber tulisan tangan (ON)
 *   PAGAR_KAMUS_PENUNJANG_AKTIF tandai singkatan ambigu pada saran prosedur (ON)
 *   PETUNJUK_RESEP_AKTIF        isi ai_review.petunjuk_resep dari bagian terapi (ON)
 *   PAGAR_OCR_AMBANG_CEK        ambang confidence OCR di bawahnya halaman dianggap
 *                               tulisan tangan/tidak terbaca pasti (default 70)
 *
 * Kegagalan di tahap ini tidak pernah menggagalkan review: pemanggil
 * membungkusnya dengan try/catch dan memakai hasil lama.
 */

const {
  verifikasiKutipan, normalisasiTeks, ALASAN,
} = require('./pagarTemuanService');
const { deteksiNegasi } = require('./negasiTemuanService');
const {
  BAGIAN, petakanBagian, bagianPadaPosisi, tentukanPeranTemuan,
} = require('./bagianTemuanService');
const { cocokkan, rapikan, SINGKATAN_BERTABRAKAN } = require('./kamusPenunjangService');
const { petunjukDariResep, KATA_DIAGNOSIS } = require('./resepPetunjukService');

const ALASAN_PAGAR = {
  ...ALASAN,
  ISTILAH_FINANSIAL: 'istilah_finansial_di_kutipan_atau_alasan',
  ISTILAH_RAWAT_INAP: 'istilah_rawat_inap_pada_klaim_rawat_jalan',
  RIWAYAT: 'hanya_riwayat_anamnesis_bukan_diagnosis',
  BANDING: 'diagnosis_banding_belum_ditegakkan',
  DI_TERAPI: 'kondisi_hanya_disebut_di_bagian_terapi',
  TULISAN_TANGAN: 'sumber_tulisan_tangan_atau_ocr_tidak_pasti',
  SINGKATAN_AMBIGU: 'singkatan_ambigu_perlu_konfirmasi',
  NEGASI_LEMAH: 'penanda_negasi_lemah_di_blok_diagnosis',
  GALAT_ENTRI: 'pagar_gagal_memproses_entri_ini',
};

function saklar(nama, bawaan = true) {
  const v = process.env[nama];
  if (v == null || String(v).trim() === '') return bawaan;
  return !/^(0|false|off|no|tidak)$/i.test(String(v).trim());
}

function bacaSaklar() {
  const ambang = Number(process.env.PAGAR_OCR_AMBANG_CEK);
  return {
    aktif: saklar('PAGAR_TEMUAN_AKTIF'),
    kutipan: saklar('PAGAR_KUTIPAN_AKTIF'),
    negasi: saklar('PAGAR_NEGASI_AKTIF'),
    peran: saklar('PAGAR_PERAN_AKTIF'),
    tulisan_tangan: saklar('PAGAR_TULISAN_TANGAN_AKTIF'),
    kamus_penunjang: saklar('PAGAR_KAMUS_PENUNJANG_AKTIF'),
    petunjuk_resep: saklar('PETUNJUK_RESEP_AKTIF'),
    ambang_ocr: Number.isFinite(ambang) && ambang > 0 ? ambang : 70,
  };
}

// ── bantu teks halaman ─────────────────────────────────────────────────────
const teksDariHalaman = (h) => (h ? (h.ocr_text != null ? h.ocr_text : h.text) : null);

function cariHalaman(evidencePool, nomor) {
  return (evidencePool || []).find(h => Number(h.page_number) === Number(nomor)) || null;
}

/** Posisi kutipan di teks halaman (toleran spasi/baris baru & huruf besar-kecil). */
function cariPosisi(teks, kutipan) {
  const kata = String(kutipan || '').trim().split(/\s+/).filter(Boolean)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!kata.length) return null;
  try {
    const m = new RegExp(kata.join('\\s+'), 'i').exec(String(teks || ''));
    return m ? { mulai: m.index, akhir: m.index + m[0].length } : null;
  } catch {
    return null;
  }
}

/** Klausa (dibatasi , ; . dan baris baru) yang memuat kutipan, diperluas ke kiri-kanan. */
function klausaSekitar(teks, kutipan) {
  const pos = cariPosisi(teks, kutipan);
  if (!pos) return String(kutipan || '');
  const s = String(teks);
  const batas = /[,;.\n]/;
  let a = pos.mulai;
  while (a > 0 && !batas.test(s[a - 1])) a--;
  let b = pos.akhir;
  while (b < s.length && !batas.test(s[b])) b++;
  return s.slice(a, b);
}

/**
 * Frasa diagnosis sah yang memuat kata negasi ("DM tanpa komplikasi",
 * "TB paru BTA negatif", "gram negatif") dinetralkan dulu; jika tidak,
 * diagnosis yang benar ikut terbaca "disangkal".
 */
function netralkanFrasaSah(klausa) {
  return String(klausa)
    .replace(/\b(tanpa|tidak\s+ada|tdk\s+ada|tak\s+ada)\s+(komplikasi|kompl|penyulit|dehidrasi)\b/gi, ' ')
    .replace(/\bbta\s*(\(?\s*[-+]\s*\)?|negatif|positif|neg|pos)/gi, ' bta ')
    .replace(/\bgram\s*(negatif|positif|neg|pos|\(?\s*[-+]\s*\)?)/gi, ' gram ');
}

const RE_PENANDA_KUAT = /^(?:[-−–—(]|disangkal|menyangkal|denies|deny|tidak\s+ditemukan|tdk\s+ditemukan)/i;

function halamanTulisanTangan(halaman, ambang) {
  if (!halaman) return false;
  if (halaman.sumber === 'tulisan_tangan' || halaman.tulisan_tangan === true) return true;
  // Tanpa penanda tulisan tangan dari OCR, confidence rendah adalah satu-satunya
  // sinyal yang ada; halaman teks asli PDF selalu confidence 100.
  return typeof halaman.confidence === 'number' && halaman.confidence < ambang;
}

// ── petunjuk resep (hanya bagian terapi/resep) ─────────────────────────────
function teksBagian(evidencePool, bagianDicari) {
  const potongan = [];
  for (const h of evidencePool || []) {
    const teks = teksDariHalaman(h);
    if (!teks) continue;
    for (const b of petakanBagian(teks)) {
      if (b.bagian === bagianDicari && b.teks.trim()) potongan.push({ halaman: h.page_number, teks: b.teks });
    }
  }
  return potongan;
}

/**
 * Petunjuk dari resep. Hanya baris di bagian terapi/resep yang dibaca, supaya
 * "riwayat minum amlodipin" di anamnesis tidak dianggap resep aktif. Tidak
 * pernah menambah diagnosis: setiap petunjuk membawa menambah_diagnosis:false.
 */
function susunPetunjukResep(evidencePool, teksDiagnosis) {
  const petunjuk = [];
  const tidakDikenali = [];
  const kelompokSudah = new Set();
  for (const { halaman, teks } of teksBagian(evidencePool, BAGIAN.TERAPI)) {
    const r = petunjukDariResep(teks, { teksDiagnosis });
    for (const p of r.petunjuk) {
      if (kelompokSudah.has(p.kelompok)) continue;
      kelompokSudah.add(p.kelompok);
      petunjuk.push({ ...p, halaman });
    }
    for (const o of r.obat_tidak_dikenali) tidakDikenali.push({ teks: o, halaman });
  }
  return { petunjuk, obat_tidak_dikenali: tidakDikenali };
}

// ── inti ────────────────────────────────────────────────────────────────────
/**
 * @param {object} p
 * @param {Array}  p.saran         suggested_codes (sudah lewat annotateKamusValid)
 * @param {Array}  [p.ditolakAwal] saran yang sudah gugur di tahap lama
 *                                 [{teks, alasan, kode, jenis, halaman}]
 * @param {Array}  p.evidencePool  [{page_number, ocr_text, confidence}]
 * @param {object} [p.saklar]      override saklar (untuk uji)
 * @returns {{suggested_codes: Array, pagar_temuan: object, petunjuk_resep: object|null}}
 */
function terapkanPagarSaran({ saran, ditolakAwal = [], evidencePool = [], saklar: sk } = {}) {
  const s = { ...bacaSaklar(), ...(sk || {}) };
  const masuk = Array.isArray(saran) ? saran : [];

  const ditolak = ditolakAwal.map(d => ({ ...d, tahap: 'awal' }));
  const disangkal = [];
  const perluCek = [];

  // Petunjuk resep dihitung dulu: buktinya dipakai juga untuk peran saran_diagnosis.
  let resep = { petunjuk: [], obat_tidak_dikenali: [] };
  try {
    const teksDiagnosis = [
      ...teksBagian(evidencePool, BAGIAN.DIAGNOSIS).map(x => x.teks),
      ...masuk.filter(e => e && e.type === 'diagnosis' && e.quotation).map(e => e.quotation),
    ].join('\n');
    resep = susunPetunjukResep(evidencePool, teksDiagnosis);
  } catch (err) {
    console.warn(`[PAGAR] petunjuk resep gagal: ${err.message}`);
  }
  const adaBuktiTerapi = (kutipan) => resep.petunjuk.some(
    p => KATA_DIAGNOSIS[p.kelompok] && KATA_DIAGNOSIS[p.kelompok].test(String(kutipan || ''))
  );

  const catat = (daftar, e, alasan, ekstra = {}) => daftar.push({
    teks: e.quotation || e.code || '',
    kode: e.code || null,
    jenis: e.type === 'procedure' ? 'prosedur' : 'diagnosis',
    halaman: e.page_number != null ? Number(e.page_number) : null,
    alasan,
    ...ekstra,
  });

  const lolos = [];
  for (const asli of masuk) {
    if (!asli || typeof asli !== 'object') continue;
    let e = { ...asli };
    try {
      const halaman = cariHalaman(evidencePool, e.page_number);
      const teksHal = teksDariHalaman(halaman);

      // (a) kutipan harus benar-benar ada di halaman itu.
      if (s.kutipan) {
        const cek = verifikasiKutipan(e.quotation, e.page_number, evidencePool);
        if (!cek.valid) { catat(ditolak, e, cek.alasan, { tahap: 'pagar' }); continue; }
      }

      // (b) kode di tabel referensi: memakai penanda kamus_valid dari
      // annotateKamusValid, tidak menanya DB dua kali. Saran tetap tampil
      // (kamus bisa belum lengkap) tetapi tidak pernah terisi otomatis.
      if (e.kamus_valid === false) {
        catat(perluCek, e, ALASAN.KODE_TAK_ADA, { catatan: 'Tidak diisikan otomatis ke klaim.' });
      }

      // (c) negasi: temuan yang disangkal tidak dibaca positif, tapi dipertahankan.
      let bagian = null;
      if (teksHal && e.quotation) {
        const pos = cariPosisi(teksHal, e.quotation);
        if (pos) {
          bagian = bagianPadaPosisi(teksHal, pos.mulai);
          // Label diagnosis di baris yang sama mengalahkan judul bagian sebelumnya.
          const awalBaris = teksHal.lastIndexOf('\n', pos.mulai - 1) + 1;
          if (/(diagnos[ai]s?|\bdx\b|assessment|asesmen|kesan)\b/i.test(teksHal.slice(awalBaris, pos.mulai))) {
            bagian = BAGIAN.DIAGNOSIS;
          }
        }
      }
      if (s.negasi && teksHal && e.quotation) {
        const klausa = netralkanFrasaSah(klausaSekitar(teksHal, e.quotation));
        const neg = deteksiNegasi(klausa);
        if (neg.disangkal) {
          const kuat = RE_PENANDA_KUAT.test(String(neg.penanda || '').trim());
          if (bagian === BAGIAN.DIAGNOSIS && !kuat) {
            // "tanpa/negatif" di blok diagnosis lebih sering bagian dari nama
            // diagnosis daripada penyangkalan: tandai saja, jangan blokir.
            catat(perluCek, e, ALASAN_PAGAR.NEGASI_LEMAH, { penanda: neg.penanda });
          } else {
            e = {
              ...e,
              disangkal: true,
              polaritas: 'negatif',
              perlu_cek_manusia: true,
              boleh_isi_otomatis: false,
              peran: 'disangkal',
              catatan_negasi: `Berkas menyangkal temuan ini${neg.penanda ? ` (penanda "${neg.penanda}")` : ''}; tidak boleh dibaca sebagai ada.`,
            };
            catat(disangkal, e, 'disangkal_di_berkas', { penanda: neg.penanda, catatan: e.catatan_negasi });
          }
        }
      }

      // (d) anamnesis-only bukan diagnosis. Hanya bagian yang JELAS dikenali
      // yang bertindak; teks tanpa judul (bagian "lainnya") dibiarkan apa
      // adanya karena OCR sering menghilangkan judul.
      if (s.peran && e.type === 'diagnosis' && e.disangkal !== true && bagian) {
        e.bagian = bagian;
        if (bagian === BAGIAN.DIAGNOSIS) {
          e.peran = 'diagnosis';
        } else if (bagian !== BAGIAN.LAINNYA) {
          const peran = tentukanPeranTemuan({ bagian, adaBuktiTerapi: adaBuktiTerapi(e.quotation) });
          if (peran.peran === 'saran_diagnosis') {
            e = { ...e, peran: 'saran_diagnosis', boleh_isi_otomatis: false, label_peran: peran.label };
            catat(perluCek, e, 'saran_diagnosis_dari_anamnesis_dengan_bukti_terapi', { catatan: peran.label });
          } else {
            const alasan = peran.peran === 'riwayat' ? ALASAN_PAGAR.RIWAYAT
              : bagian === BAGIAN.DIAGNOSIS_BANDING ? ALASAN_PAGAR.BANDING
                : bagian === BAGIAN.TERAPI ? ALASAN_PAGAR.DI_TERAPI
                  : peran.peran;
            catat(ditolak, e, alasan, { tahap: 'pagar', bagian, catatan: peran.label });
            continue;
          }
        }
      } else if (bagian) {
        e.bagian = bagian;
      }

      // (e) tulisan tangan / OCR tidak pasti: tanda informasi saja.
      if (s.tulisan_tangan && halamanTulisanTangan(halaman, s.ambang_ocr)) {
        e = { ...e, perlu_cek_manusia: true, alasan_cek: 'tulisan tangan atau OCR tidak pasti; periksa manusia' };
        catat(perluCek, e, ALASAN_PAGAR.TULISAN_TANGAN, { confidence_ocr: halaman.confidence ?? null });
      }

      // (4) kamus penunjang: singkatan pendek bertabrakan tidak pernah diputuskan sendiri.
      // Dicek per kata pada kutipan ("Tindakan: DC"), tanpa konteks apa pun
      // sehingga tidak ada arti yang dipilih sendiri: salah tafsir DC menjadi
      // kateter berarti prosedur yang tidak pernah dilakukan.
      if (s.kamus_penunjang && e.type === 'procedure' && e.quotation) {
        const kata = [...new Set(String(e.quotation).split(/[^A-Za-z0-9/]+/).filter(Boolean))];
        const ambigu = kata
          .filter(k => SINGKATAN_BERTABRAKAN.includes(rapikan(k)))
          .map(k => cocokkan(k))
          .filter(k => k.status === 'perlu_konfirmasi');
        if (ambigu.length > 0) {
          const kandidat = ambigu.map(k => ({ ditulis: k.ditulis, kandidat: k.kandidat }));
          e = { ...e, perlu_cek_manusia: true, singkatan_ambigu: kandidat };
          catat(perluCek, e, ALASAN_PAGAR.SINGKATAN_AMBIGU, { kandidat });
        }
      }

      lolos.push(e);
    } catch (err) {
      // Gagal memproses SATU entri: entri lama lolos apa adanya, dengan catatan.
      console.warn(`[PAGAR] entri ${asli.code} gagal diproses: ${err.message}`);
      catat(perluCek, asli, ALASAN_PAGAR.GALAT_ENTRI, { galat: String(err.message).slice(0, 120) });
      lolos.push(asli);
    }
  }

  const perAlasan = {};
  for (const d of ditolak) perAlasan[d.alasan] = (perAlasan[d.alasan] || 0) + 1;

  return {
    suggested_codes: lolos,
    petunjuk_resep: s.petunjuk_resep ? resep : null,
    pagar_temuan: {
      versi: 1,
      ditolak,
      disangkal,
      perlu_cek_manusia: perluCek,
      ringkasan: {
        saran_masuk_tahap_pagar: masuk.length,
        lolos: lolos.length,
        ditolak: ditolak.length,
        disangkal: disangkal.length,
        perlu_cek_manusia: perluCek.length,
        alasan_ditolak: perAlasan,
      },
      saklar: {
        kutipan: s.kutipan, negasi: s.negasi, peran: s.peran,
        tulisan_tangan: s.tulisan_tangan, kamus_penunjang: s.kamus_penunjang,
        petunjuk_resep: s.petunjuk_resep, ambang_ocr: s.ambang_ocr,
      },
      galat: null,
    },
  };
}

/**
 * Pembungkus aman untuk aiReviewService: tidak pernah melempar. Saklar induk
 * mati -> hasil lama utuh (mengembalikan null). Galat -> hasil lama utuh,
 * dan hanya catatan gugur tahap awal + galatnya yang ditampilkan.
 * @returns {{suggested_codes:Array|null, pagar_temuan:object|null, petunjuk_resep:object|null}}
 */
function jalankanPagarAman({ saran, ditolakAwal = [], evidencePool = [] }) {
  const s = bacaSaklar();
  if (!s.aktif) return { suggested_codes: null, pagar_temuan: null, petunjuk_resep: null };
  try {
    return terapkanPagarSaran({ saran, ditolakAwal, evidencePool });
  } catch (err) {
    console.warn(`[PAGAR] tahap pagar gagal, memakai hasil lama: ${err.message}`);
    return {
      suggested_codes: null,
      petunjuk_resep: null,
      pagar_temuan: {
        versi: 1,
        ditolak: (Array.isArray(ditolakAwal) ? ditolakAwal : []).map(d => ({ ...d, tahap: 'awal' })),
        disangkal: [],
        perlu_cek_manusia: [],
        ringkasan: null,
        galat: String(err.message).slice(0, 200),
      },
    };
  }
}

/** Catat saran yang gugur di tahap lama (dulu hanya console.warn). */
function catatDitolakAwal(daftar, entry, alasan) {
  try {
    const e = entry || {};
    daftar.push({
      teks: e.quotation || e.code || '',
      kode: e.code || null,
      jenis: e.type === 'procedure' ? 'prosedur' : 'diagnosis',
      halaman: e.page_number != null ? Number(e.page_number) : null,
      alasan,
    });
  } catch { /* pencatatan tidak boleh mengganggu alur */ }
}

module.exports = {
  ALASAN_PAGAR,
  bacaSaklar,
  terapkanPagarSaran,
  jalankanPagarAman,
  catatDitolakAwal,
  susunPetunjukResep,
  klausaSekitar,
  netralkanFrasaSah,
  normalisasiTeks,
};
