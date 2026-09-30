/**
 * Bagian dokumen dan peran temuan (tipe 3: salah tafsir).
 *
 * Prinsip: anamnesis BUKAN diagnosis. "Riwayat hipertensi (+)" di anamnesis
 * tidak boleh menjadi diagnosis sekunder. Diagnosis hanya diambil dari blok
 * diagnosis. Dari bagian lain, sebuah kondisi paling jauh menjadi SARAN yang
 * berlabel jelas, dan itu hanya bila ada bukti terapi. Resep hanya memberi
 * petunjuk (lihat resepPetunjukService), tidak pernah menambah diagnosis.
 *
 * Modul murni. Dipakai alur live lewat pagarPascaAiService (saklar
 * PAGAR_PERAN_AKTIF): hanya bagian yang jelas dikenali yang bertindak.
 */

const BAGIAN = {
  ANAMNESIS: 'anamnesis',
  FISIK: 'pemeriksaan_fisik',
  DIAGNOSIS: 'diagnosis',
  DIAGNOSIS_BANDING: 'diagnosis_banding',
  TERAPI: 'terapi',
  LAINNYA: 'lainnya',
};

// Urutan penting: yang lebih khusus lebih dahulu. Semua dicocokkan di AWAL
// baris dan wajib diakhiri titik dua/tanda hubung atau akhir baris, supaya
// kalimat biasa yang kebetulan berawalan "terapi" tidak dianggap judul.
const JUDUL = [
  [BAGIAN.DIAGNOSIS_BANDING, /^\s*(diagnosa|diagnosis|dx)\s+(banding|diferensial|differential)\b/i],
  [BAGIAN.DIAGNOSIS, /^\s*(diagnosa|diagnosis|dx)(\s+(utama|kerja|sekunder|tambahan|akhir|masuk|keluar|primer))?\b|^\s*(assessment|asesmen|kesan)\b|^\s*a\s*[:/]/i],
  [BAGIAN.FISIK, /^\s*(pemeriksaan\s+fisik|status\s+generalis|status\s+lokalis|objektif|objective|thorax|paru|cor|abdomen)\b|^\s*o\s*[:/]/i],
  [BAGIAN.TERAPI, /^\s*(terapi|therapy|pengobatan|resep|rencana|planning|penatalaksanaan|instruksi)\b|^\s*p\s*[:/]/i],
  [BAGIAN.ANAMNESIS, /^\s*(anamnesa|anamnesis|keluhan(\s+utama|\s+tambahan)?|riwayat(\s+penyakit)?(\s+sekarang|\s+dahulu|\s+dulu|\s+keluarga)?|rpd|rps|rpk|subjektif|subjective)\b|^\s*s\s*[:/]/i],
];

/** Cocokkan satu baris dengan judul bagian; null bila bukan judul. */
function judulBaris(baris) {
  for (const [bagian, re] of JUDUL) {
    const m = baris.match(re);
    if (!m) continue;
    // Judul harus diikuti pemisah atau akhir baris agar kalimat "abdomen
    // supel, nyeri tekan (-)" (isi pemeriksaan fisik) tetap terbaca isi.
    const sisa = baris.slice(m[0].length);
    if (/^\s*([:\-–/]|$)/.test(sisa) || bagian === BAGIAN.DIAGNOSIS || /^\s*[a-z]\s*[:/]/i.test(m[0])) {
      return bagian;
    }
  }
  return null;
}

/**
 * Petakan teks halaman menjadi bagian-bagian berurutan.
 * @returns {Array<{bagian: string, mulai: number, akhir: number, teks: string}>}
 */
function petakanBagian(teks) {
  const sumber = String(teks || '');
  const bagianList = [];
  let saat = { bagian: BAGIAN.LAINNYA, mulai: 0 };
  let offset = 0;
  for (const baris of sumber.split('\n')) {
    const judul = judulBaris(baris);
    if (judul && judul !== saat.bagian) {
      if (offset > saat.mulai) bagianList.push({ ...saat, akhir: offset });
      saat = { bagian: judul, mulai: offset };
    }
    offset += baris.length + 1;
  }
  bagianList.push({ ...saat, akhir: sumber.length });
  return bagianList.map(b => ({ ...b, teks: sumber.slice(b.mulai, b.akhir) }));
}

/** Bagian dokumen yang memuat posisi karakter tertentu. */
function bagianPadaPosisi(teks, posisi) {
  const daftar = petakanBagian(teks);
  const ketemu = daftar.find(b => posisi >= b.mulai && posisi < b.akhir);
  return ketemu ? ketemu.bagian : BAGIAN.LAINNYA;
}

/** Bagian tempat sebuah kutipan berada (pencarian tanpa peduli huruf besar/spasi). */
function bagianKutipan(teksHalaman, kutipan) {
  const sumber = String(teksHalaman || '');
  const kata = String(kutipan || '').trim().split(/\s+/).filter(Boolean)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!kata.length) return null;
  const m = new RegExp(kata.join('\\s+'), 'i').exec(sumber);
  return m ? bagianPadaPosisi(sumber, m.index) : null;
}

/**
 * Tentukan peran sebuah temuan kondisi menurut bagian dokumennya.
 *
 * @param {{bagian: string, adaBuktiTerapi?: boolean, disangkal?: boolean}} p
 * @returns {{peran: string, boleh_jadi_diagnosis: boolean, label: string|null}}
 *   peran: 'diagnosis' | 'saran_diagnosis' | 'riwayat' | 'petunjuk' | 'disangkal' | 'bukan_diagnosis'
 */
function tentukanPeranTemuan({ bagian, adaBuktiTerapi = false, disangkal = false }) {
  if (disangkal) {
    return { peran: 'disangkal', boleh_jadi_diagnosis: false, label: 'Disangkal di berkas; tidak menjadi diagnosis' };
  }
  if (bagian === BAGIAN.DIAGNOSIS) {
    return { peran: 'diagnosis', boleh_jadi_diagnosis: true, label: null };
  }
  if (bagian === BAGIAN.DIAGNOSIS_BANDING) {
    return { peran: 'bukan_diagnosis', boleh_jadi_diagnosis: false, label: 'Diagnosis banding, belum ditegakkan' };
  }
  if (bagian === BAGIAN.TERAPI) {
    return { peran: 'petunjuk', boleh_jadi_diagnosis: false, label: 'Hanya petunjuk dari terapi; bukan diagnosis' };
  }
  if (bagian === BAGIAN.ANAMNESIS || bagian === BAGIAN.FISIK || bagian === BAGIAN.LAINNYA) {
    if (adaBuktiTerapi) {
      return {
        peran: 'saran_diagnosis',
        boleh_jadi_diagnosis: false, // hanya saran; pengesahan tetap oleh dokter/koder
        label: 'Disarankan, belum tercatat di blok diagnosis: kondisi disebut di anamnesis dan ada terapi terkait',
      };
    }
    return {
      peran: 'riwayat',
      boleh_jadi_diagnosis: false,
      label: 'Riwayat/keluhan di anamnesis; bukan diagnosis',
    };
  }
  return { peran: 'bukan_diagnosis', boleh_jadi_diagnosis: false, label: null };
}

/**
 * Terapkan aturan peran pada satu temuan berbentuk {teks, kutipan, halaman}
 * dengan teks halaman diberikan. Mengembalikan salinan dengan `bagian` dan
 * `peran`. Temuan tidak dibuang; hanya perannya yang ditetapkan.
 */
function beriPeran(temuan, teksHalaman, { adaBuktiTerapi = false } = {}) {
  const bagian = bagianKutipan(teksHalaman, temuan.kutipan) || BAGIAN.LAINNYA;
  const peran = tentukanPeranTemuan({ bagian, adaBuktiTerapi, disangkal: temuan.disangkal === true });
  return { ...temuan, bagian, peran: peran.peran, boleh_jadi_diagnosis: peran.boleh_jadi_diagnosis, label_peran: peran.label };
}

module.exports = { BAGIAN, petakanBagian, bagianPadaPosisi, bagianKutipan, tentukanPeranTemuan, beriPeran };
