/**
 * Putusan pending — satu jawaban untuk pertanyaan yang sebenarnya ditanyakan
 * koder: "klaim ini akan dipending atau tidak, dan kalau iya karena apa?"
 *
 * Koder tidak ingin membetulkan data di tabel. Ia ingin tahu keputusannya.
 * Seluruh pemeriksaan yang sudah ada — validasi aturan, kegawatdaruratan,
 * syarat penunjang, ketentuan kombinasi kode, konsistensi antar data — selama
 * ini tersebar di beberapa kartu dan harus dibaca satu per satu. Modul ini
 * merangkumnya jadi satu putusan beserta alasannya, diurutkan dari yang paling
 * berisiko.
 *
 * YANG SENGAJA TIDAK DILAKUKAN: memberi angka persentase.
 *
 * Belum ada satu pun klaim di sistem ini yang hasil akhirnya dari BPJS sudah
 * diketahui — rekap pending yang ada memuat periode Januari–Mei 2026,
 * sedangkan klaim yang tersimpan periode Juli–September. Irisannya nol. Jadi
 * ketepatan putusan ini BELUM PERNAH TERUKUR sama sekali, dan angka seperti
 * "85% kemungkinan pending" akan jadi angka karangan yang terdengar
 * meyakinkan. Yang bisa dipertanggungjawabkan hanyalah: alasan apa yang
 * ditemukan, dari aturan mana, dan atas bukti apa.
 *
 * Deterministik: tidak memanggil AI dan tidak memakai token.
 */

/** Urutan keparahan, dari yang paling berisiko. */
const BOBOT = { tinggi: 0, critical: 0, major: 1, sedang: 1, minor: 2, rendah: 2, info: 3 };

const STATUS = {
  BERISIKO: 'berisiko_pending',
  PERLU_DICEK: 'perlu_dicek',
  BERSIH: 'tidak_ditemukan_alasan',
};

function bobot(keparahan) {
  const b = BOBOT[String(keparahan || '').toLowerCase()];
  return b === undefined ? 2 : b;
}

/**
 * Alasan yang berasal dari rekap pending BPJS RS ini sendiri diberi tanda
 * terpisah. Bedanya nyata: aturan itu lahir dari klaim yang BENAR-BENAR pernah
 * ditolak di sini, bukan dari dugaan atas kelengkapan berkas.
 */
function dariRekapPending(sumber) {
  return /rekap pending/i.test(String(sumber || ''));
}

function tambah(daftar, alasan) {
  if (!alasan || !alasan.ringkas) return;
  daftar.push(alasan);
}

/**
 * Rangkum seluruh temuan jadi satu putusan.
 *
 * @param {Object} aiReview isi ai_review
 * @param {Array} validationErrors baris validation_errors
 * @returns {{status, ringkasan, alasan: Array, jumlah: Object}}
 */
function susunPutusan(aiReviewMasuk = {}, validationErrorsMasuk = []) {
  // Nilai bawaan parameter hanya berlaku untuk undefined, bukan null — dan
  // ai_review yang belum pernah diisi memang tersimpan sebagai null.
  const aiReview = aiReviewMasuk || {};
  const validationErrors = validationErrorsMasuk || [];
  const alasan = [];

  // 1. Aturan validasi yang sudah lama ada.
  for (const e of validationErrors || []) {
    tambah(alasan, {
      sumber_pemeriksaan: 'Aturan validasi',
      kode: e.rule_id || null,
      ringkas: e.error_message || e.field_name,
      keparahan: e.severity === 'critical' ? 'tinggi' : e.severity === 'major' ? 'tinggi' : 'sedang',
      bukti: e.actual_value || null,
      tindakan: e.expected_value || null,
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  // Kode di luar kamus resmi. Ditaruh lebih dulu karena ini bukan dugaan
  // melainkan fakta yang bisa diperiksa: kodenya ada atau tidak ada di kamus.
  for (const k of aiReview.kode_luar_kamus || []) {
    tambah(alasan, {
      sumber_pemeriksaan: 'Kamus kode resmi',
      kode: k.kode,
      ringkas: `Kode ${k.jenis} "${k.kode}" tidak ada di kamus resmi`,
      penjelasan: k.pesan,
      keparahan: 'tinggi',
      bukti: null,
      tindakan: 'Ganti dengan kode yang ada di kamus, atau hapus kalau keliru',
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  // 2. Konsistensi antar data — data yang diklaim tanpa pendukungnya.
  for (const k of aiReview.konsistensi_data || []) {
    tambah(alasan, {
      sumber_pemeriksaan: 'Konsistensi antar data',
      kode: k.id,
      ringkas: k.nama,
      penjelasan: k.pesan,
      keparahan: k.keparahan,
      bukti: k.yang_ditemukan && k.yang_ditemukan.kutipan
        ? `"${k.yang_ditemukan.kutipan}"${k.yang_ditemukan.page_number ? ` (hal. ${k.yang_ditemukan.page_number})` : ''}`
        : null,
      tindakan: k.yang_dicari ? `Pastikan ada: ${k.yang_dicari}` : null,
      diverifikasi: k.diverifikasi === true,
      dari_rekap_pending: dariRekapPending(k.sumber_aturan),
    });
  }

  // 3. Syarat penunjang diagnosis. Yang berstatus "perlu dicek manual" TIDAK
  //    ikut jadi alasan — itu keterbatasan pembacaan kami, bukan kekurangan
  //    berkasnya, dan menyebutnya sebagai alasan pending akan menyalahkan
  //    rumah sakit atas kegagalan sistem membaca.
  for (const s of aiReview.syarat_penunjang || []) {
    for (const syarat of s.syarat || []) {
      if (syarat.status === 'terpenuhi' || syarat.status === 'perlu_cek_manual') continue;
      tambah(alasan, {
        sumber_pemeriksaan: 'Syarat penunjang diagnosis',
        kode: s.id,
        ringkas: `${s.kode_diagnosis} — ${syarat.nama} ${syarat.status === 'tidak_ada' ? 'tidak ada' : 'hasilnya belum terbaca'}`,
        penjelasan: s.sumber_aturan,
        keparahan: syarat.status === 'tidak_ada' ? 'tinggi' : 'sedang',
        bukti: syarat.kutipan ? `"${syarat.kutipan}"${syarat.page_number ? ` (hal. ${syarat.page_number})` : ''}` : null,
        tindakan: `Lengkapi bukti ${syarat.nama.toLowerCase()} sebelum submit`,
        diverifikasi: s.diverifikasi === true,
        dari_rekap_pending: dariRekapPending(s.sumber_aturan),
      });
    }
  }

  // 4. Ketentuan kombinasi kode.
  for (const k of aiReview.kombinasi_kode || []) {
    tambah(alasan, {
      sumber_pemeriksaan: 'Ketentuan kombinasi kode',
      kode: k.kode || null,
      ringkas: k.nama || k.pesan,
      penjelasan: k.pesan,
      keparahan: 'tinggi',
      bukti: k.kutipan_sumber || null,
      tindakan: k.pesan || null,
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  // 5. Identitas lintas halaman — hanya yang berat. Selisih ringan hampir
  //    selalu salah baca OCR, bukan alasan pending.
  for (const i of aiReview.identitas_halaman || []) {
    if (i.keparahan !== 'tinggi') continue;
    tambah(alasan, {
      sumber_pemeriksaan: 'Identitas antar halaman',
      kode: i.jenis,
      ringkas: `Halaman ${i.page_number} kemungkinan milik pasien lain`,
      penjelasan: i.pesan,
      keparahan: 'tinggi',
      bukti: i.ditemukan ? `Di halaman: ${i.ditemukan}` : null,
      tindakan: 'Periksa berkas fisiknya',
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  alasan.sort((a, b) => {
    // Alasan yang lahir dari klaim yang benar-benar pernah ditolak di RS ini
    // naik ke atas: bobotnya berbeda dari dugaan kelengkapan berkas.
    if (a.dari_rekap_pending !== b.dari_rekap_pending) return a.dari_rekap_pending ? -1 : 1;
    if (a.diverifikasi !== b.diverifikasi) return a.diverifikasi ? -1 : 1;
    return bobot(a.keparahan) - bobot(b.keparahan);
  });

  // SELURUH alasan menentukan status, termasuk yang aturannya belum ditelaah
  // koder. Sebelumnya yang belum disahkan hanya ditampilkan tanpa memengaruhi
  // putusan — tapi itu berarti koder tetap harus membaca dan menilainya
  // sendiri, yaitu memeriksa ulang apa yang sudah diperiksa sistem. Kerja dua
  // kali, dan gunanya hilang.
  //
  // Aturan yang ternyata keliru diperbaiki atau dimatikan di berkas aturannya,
  // bukan dengan menahan seluruh temuan di belakang gerbang persetujuan.
  const berat = alasan.filter(a => bobot(a.keparahan) === 0);

  let status = STATUS.BERSIH;
  let ringkasan = 'Tidak ditemukan alasan yang biasa membuat klaim dipending.';
  if (berat.length > 0) {
    status = STATUS.BERISIKO;
    ringkasan = berat.length === 1
      ? 'Ada 1 hal yang berisiko membuat klaim ini dipending.'
      : `Ada ${berat.length} hal yang berisiko membuat klaim ini dipending.`;
  } else if (alasan.length > 0) {
    status = STATUS.PERLU_DICEK;
    ringkasan = `Ada ${alasan.length} hal yang sebaiknya dicek sebelum submit.`;
  }


  return {
    status,
    ringkasan,
    // Dinyatakan terbuka supaya putusan ini tidak dibaca sebagai keputusan BPJS.
    catatan_keandalan:
      'Catatan: ini perkiraan aplikasi, bukan keputusan BPJS. Ketepatannya belum pernah terukur karena belum ada klaim di sistem ini yang hasil BPJS-nya sudah diketahui.',
    alasan,
    jumlah: {
      total: alasan.length,
      berat: berat.length,
      dari_rekap_pending: alasan.filter(a => a.dari_rekap_pending).length,
    },
  };
}

module.exports = { susunPutusan, STATUS };
