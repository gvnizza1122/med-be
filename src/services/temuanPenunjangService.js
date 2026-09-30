/**
 * Temuan penunjang — membaca istilah pemeriksaan penunjang (lab, radiologi,
 * pemeriksaan lain) yang TERTULIS di berkas dan menormalkannya lewat
 * kamusPenunjangService, murni sebagai ANOTASI INFORMASI.
 *
 * TIDAK PERNAH mengisi kode ke klaim. Kode yang menyertai hasil dikenali
 * (`kode_usulan`) SELALU `kode_terverifikasi:false` — persis aturan
 * kamusPenunjangService.js, modul ini tidak menambah atau melonggarkan itu.
 *
 * Tiga sumber baris yang dipindai, sengaja dibedakan caranya:
 *
 *   1. Halaman berjenis lab_results (pdfPageClassifier): baris tabel dibaca
 *      dulu dengan bacaLabService.bacaBarisLab (pemisah nama/nilai/satuan
 *      yang sudah teruji), lalu NAMA parameter tiap baris dicocokkan satu-
 *      satu dengan `cocokkan(nama, {bagian:'lab'})`. Ini WAJIB dipakai alih-
 *      alih temukanDalamTeks: banyak parameter lab ditulis 2 huruf ("Hb",
 *      "Na", "K") dan temukanDalamTeks sengaja menolak memindai singkatan
 *      sependek itu dari kalimat bebas (lihat kamusPenunjangService.js) —
 *      padahal pada baris tabel, sel nama itu SUDAH terisolasi oleh parser
 *      baris, sama seperti sel tabel yang dimaksud aturan itu sendiri.
 *
 *   2. Halaman berjenis radiology: tiap baris dipindai BEBAS dengan
 *      temukanDalamTeks (bagian:'radiologi') — istilah radiologi pada
 *      umumnya >=3 huruf ("USG", "MRI", "CT Scan kepala") sehingga batas
 *      panjang pindai tidak jadi masalah di sini.
 *
 *   3. Daftar eksplisit di bawah label "Pemeriksaan Penunjang" pada resume
 *      medis / triase IGD: setiap ITEM (dipisah koma/"dan") dicocokkan
 *      SATU-SATU dengan `cocokkan` — ini daftar pasti tentang apa yang
 *      dilakukan, jadi presisi diutamakan, dan "kata sekitar" (seluruh
 *      baris) dipakai untuk membantu memutuskan singkatan bertabrakan bila
 *      memang bisa, tanpa pernah menebak bila tidak bisa.
 *
 * Istilah yang TIDAK dikenali kamus manapun dari sumber 3 (daftar eksplisit)
 * dikembalikan di `tidak_dikenali` supaya PEMANGGIL (aiReviewService, yang
 * punya akses DB + klaim_id) bisa mencatatnya ke varian_belum_dikenali.
 * Nama parameter lab yang tidak dikenali (sumber 1) SENGAJA TIDAK diduplikasi
 * di sini — sudah tercatat lewat ai_review.temuan_lab
 * (bacaLabService.bacaLabDariHalaman().tidak_dikenali), lihat aiReviewService.js.
 * Modul ini sendiri tidak menyentuh database, supaya tetap murni dan mudah diuji.
 *
 * Gate: env KAMUS_PENUNJANG_PEMBACAAN_AKTIF (default ON — beda dengan
 * SYARAT_PAKAI_BACA_LAB di syaratPenunjangService.js yang mengendalikan
 * KEPUTUSAN syarat klaim dan defaultnya MATI). Modul ini hanya menambah
 * anotasi; mematikannya lewat env membuat bacaTemuanPenunjang selalu
 * mengembalikan hasil kosong tanpa memindai apa pun.
 */

const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { cocokkan, temukanDalamTeks } = require('./kamusPenunjangService');
const { bacaBarisLab } = require('./bacaLabService');

const LABEL_PENUNJANG = /\bPemeriksaan\s+Penunjang\b/i;

// Awal bagian berikutnya pada resume/triase — dipakai membatasi sampai mana
// daftar "Pemeriksaan Penunjang" dibaca, supaya pemindaian tidak menelan isi
// bagian sesudahnya (mis. "Tindakan", "Terapi") dan menautkan istilah ke
// bagian yang salah.
const BATAS_BAGIAN = /^(evaluasi|discharge|planning|edukasi|tanda\s*tangan|catatan\s*perkembangan|diagnosa\s*keperawatan|rencana|anjuran|kelanjutan|diagnosa|penyebab|tindakan|terapi|magelang,)/i;

function aktif() {
  return process.env.KAMUS_PENUNJANG_PEMBACAAN_AKTIF !== 'false';
}

/** Baris yang isinya hanya label tanpa nilai. */
function hanyaLabel(baris) {
  const sisa = String(baris).replace(LABEL_PENUNJANG, '').replace(/[:\s.-]/g, '');
  return sisa.length === 0;
}

/** Pisah satu baris jadi item-item pemeriksaan ("Darah lengkap, Ro Thorax dan EKG"). */
function bagiItem(teks) {
  return String(teks || '')
    .split(/[,;]|\bdan\b/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Kumpulkan baris-baris di bawah label "Pemeriksaan Penunjang" pada satu
 * halaman (baik nilainya di baris label sendiri maupun baris-baris sesudahnya
 * sampai bagian berikutnya dimulai).
 */
function kumpulkanBarisPenunjang(barisHalaman) {
  const keluar = [];
  for (let i = 0; i < barisHalaman.length; i++) {
    if (!LABEL_PENUNJANG.test(barisHalaman[i])) continue;
    if (!hanyaLabel(barisHalaman[i])) {
      const nilai = barisHalaman[i].replace(LABEL_PENUNJANG, '').replace(/^[:\s.-]+/, '').trim();
      if (nilai) keluar.push(nilai);
    }
    for (let j = i + 1; j < barisHalaman.length; j++) {
      const b = String(barisHalaman[j]).trim();
      if (!b) continue;
      if (BATAS_BAGIAN.test(b)) break;
      keluar.push(b);
    }
  }
  return keluar;
}

function kunciTemuan(t, pageNumber) {
  return `${t.status}:${t.istilah_id || t.ditulis}:${pageNumber}`;
}

/**
 * Pindai seluruh evidence pool dan kembalikan temuan penunjang (istilah
 * dikenali + perlu_konfirmasi, masing-masing dengan kutipan & halaman) dan
 * daftar istilah yang sama sekali tidak dikenali kamus.
 *
 * @param {Array<{page_number:number, ocr_text?:string, text?:string}>} halaman
 * @returns {{temuan: Array, tidak_dikenali: Array<{ditulis:string, halaman:number|null}>}}
 */
function bacaTemuanPenunjang(halaman) {
  const temuan = [];
  const tidakDikenali = [];
  const dipakai = new Set();
  if (!aktif()) return { temuan, tidak_dikenali: tidakDikenali };

  const dorong = (hasilCocok, pageNumber, kutipan) => {
    const kunci = kunciTemuan(hasilCocok, pageNumber);
    if (dipakai.has(kunci)) return;
    dipakai.add(kunci);
    temuan.push({ ...hasilCocok, page_number: pageNumber, kutipan });
  };

  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text != null ? hal.ocr_text : hal.text);
    if (!teks) continue;
    const jenis = classifyPageDocumentType(teks);
    const pageNumber = hal.page_number || null;

    // 1. Halaman lab_results: baris tabel dibaca dulu oleh bacaBarisLab
    //    (parser nama/nilai/satuan yang sudah teruji), baru NAMA tiap baris
    //    dicocokkan satu-satu. Nama yang tidak dikenali TIDAK didorong ke
    //    tidak_dikenali di sini — sudah tercatat via ai_review.temuan_lab.
    if (jenis === 'lab_results') {
      for (const baris of bacaBarisLab(teks, { halaman: pageNumber })) {
        if (!baris.parameter_ditulis) continue;
        const hasilCocok = cocokkan(baris.parameter_ditulis, { bagian: 'lab' });
        if (hasilCocok.status === 'dikenali' || hasilCocok.status === 'perlu_konfirmasi') {
          dorong(hasilCocok, pageNumber, baris.kutipan);
        }
      }
    }

    // 1b. Halaman radiology: istilah radiologi umumnya >=3 huruf, aman
    //     dipindai bebas per baris dengan temukanDalamTeks.
    if (jenis === 'radiology') {
      for (const b of teks.split(/\r?\n/)) {
        if (!b.trim()) continue;
        for (const t of temukanDalamTeks(b, { bagian: 'radiologi' })) {
          dorong(t, pageNumber, b.trim().slice(0, 160));
        }
      }
    }

    // 2. Label "Pemeriksaan Penunjang" pada resume/triase: daftar eksplisit,
    //    dicocokkan satu-satu untuk presisi.
    if (jenis === 'resume_medis' || jenis === 'triase_igd') {
      for (const baris of kumpulkanBarisPenunjang(teks.split(/\r?\n/))) {
        for (const item of bagiItem(baris)) {
          if (item.length < 2) continue;
          const hasilCocok = cocokkan(item, { sekitar: baris });
          if (hasilCocok.status === 'dikenali' || hasilCocok.status === 'perlu_konfirmasi') {
            dorong(hasilCocok, pageNumber, baris.slice(0, 160));
          } else {
            tidakDikenali.push({ ditulis: item, halaman: pageNumber });
          }
        }
      }
    }
  }

  return { temuan, tidak_dikenali: tidakDikenali };
}

module.exports = { bacaTemuanPenunjang };
