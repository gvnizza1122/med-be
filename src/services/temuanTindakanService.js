/**
 * Temuan tindakan — membaca APA YANG DILAKUKAN ke pasien, terpisah dari
 * keputusan mengkodekannya.
 *
 * Dua hal yang berbeda, dan memisahkannya adalah inti modul ini:
 *
 *   TERBACA        — aplikasi tahu pasien dinebulisasi. Ini harus SELALU terjadi.
 *   MASUK PROCLIST — nebulisasi dikodekan di klaim. Ini kebiasaan koding RS dan
 *                    ditentukan koder casemix, bukan oleh aplikasi.
 *
 * PROCLIST hanya memuat kode ICD-9-CM final dari koder; ia tidak pernah
 * mencatat apa yang sebenarnya tertulis di berkas. Karena itu sebelum ini,
 * tindakan yang jelas tertulis bisa sama sekali tidak terlihat sistem.
 *
 * Kenapa tindakan tetap harus terbaca walau tidak dikodekan: 84% pending Mei
 * 2026 beralasan "harap cek kembali penagihan kondisi kegawatan". Untuk pasien
 * IGD yang dipulangkan, tindakan seperti nebulisasi adalah bukti pasien
 * ditangani sebagai kasus gawat. Tanpa itu, penilaian kegawatan bisa menyimpulkan
 * klaim ini lemah padahal kuat.
 *
 * DIRANCANG DARI BERKAS SUNGGUHAN (0170R0110926V001943, MUNAWIR). Nebulisasi
 * tertulis TIGA kali di berkas itu — resume, resep, dan triase — sementara
 * daftar prosedurnya kosong.
 *
 * Deterministik: tidak memanggil AI dan tidak memakai token.
 */

const { classifyPageDocumentType } = require('./pdfPageClassifier');

/**
 * Kamus tindakan. `kode_usulan` adalah USULAN, bukan keputusan — apakah ia
 * masuk daftar prosedur tetap wewenang koder casemix.
 *
 * Kode yang belum pasti sengaja dibiarkan null daripada ditebak; kode karangan
 * jauh lebih berbahaya daripada kolom kosong.
 */
const KAMUS_TINDAKAN = [
  {
    id: 'nebulisasi',
    nama: 'Nebulisasi',
    kode_usulan: '93.94',
    pola: /\bnebu?l(isasi)?\b|\bnebules\b/i,
  },
  {
    id: 'terapi_oksigen',
    nama: 'Terapi oksigen',
    kode_usulan: '93.96',
    pola: /\boksigen(asi)?\b|\bo2\s*(nasal|kanul|masker|nrm)\b/i,
  },
  {
    id: 'pemasangan_infus',
    nama: 'Pemasangan infus',
    kode_usulan: null,
    catatan_kode: 'Kode belum dipastikan koder — sengaja tidak ditebak.',
    pola: /\b(pasang|memasang|terpasang)\s*(inf|infus|ivfd)\b|\binfus\s*(asering|rl|nacl)/i,
  },
  {
    id: 'rontgen_toraks',
    nama: 'Rontgen toraks',
    kode_usulan: '87.44',
    pola: /\b(ro|rontgen|foto|x[\s-]?ray)\s*(thorax|thoraks|toraks|dada)\b/i,
  },
  {
    id: 'pemeriksaan_darah',
    nama: 'Pemeriksaan darah',
    kode_usulan: '90.59',
    pola: /\b(darah\s*(lengkap|rutin)|hematologi|dl\b)/i,
  },
  // Injeksi obat. ICD-9-CM membedakan antibiotik (99.21) dari zat terapeutik
  // lain (99.29), jadi keduanya dipisah — bukan disatukan demi kemudahan.
  //
  // hanya_dari_tindakan: obat yang TERTULIS DI RESEP belum tentu disuntikkan.
  // Resep adalah rencana; kolom Tindakan adalah catatan bahwa itu benar
  // dilakukan. Mengambil dari resep berarti mengklaim tindakan atas dasar
  // niat, bukan atas dasar yang tercatat dikerjakan.
  {
    id: 'injeksi_antibiotik',
    nama: 'Injeksi antibiotik',
    kode_usulan: '99.21',
    hanya_dari_tindakan: true,
    pola: /\binj(eksi)?\b[^\n]{0,30}\b(ceftriaxon|cefotaxim|ceftazidim|cefazolin|ampicillin|amoxicillin|gentamicin|metronidazol|levofloxacin|ciprofloxacin|meropenem|azithromycin)/i,
  },
  {
    id: 'injeksi_obat',
    nama: 'Injeksi obat',
    kode_usulan: '99.29',
    hanya_dari_tindakan: true,
    pola: /\binj(eksi)?\b\s*[a-z]/i,
    catatan_kode: 'ICD-9-CM 99.29 untuk zat terapeutik selain antibiotik. Injeksi antibiotik dikode terpisah sebagai 99.21.',
  },
];

/**
 * Label yang isinya adalah tindakan, dipisah menurut jenis halaman.
 *
 * Kata "Tindakan" muncul di beberapa tempat dengan arti berbeda — di resume
 * (isinya tindakan), di Risiko Jatuh (isinya kosong), dan di "Tindakan
 * Keperawatan" pada triase. Mencari kata itu ke seluruh berkas akan mengambil
 * yang salah, terutama yang kosong.
 */
const LABEL_PER_JENIS = {
  resume_medis: [/\bTindakan\b/i],
  triase_igd: [/\bTindakan\s+Keperawatan\b/i, /\bIntervensi\s+Keperawatan\b/i],
};

/**
 * Awal bagian baru pada formulir triase — dipakai membatasi sampai mana daftar
 * "Tindakan Keperawatan" dibaca. Tanpa batas, pemindaian akan menelan isi tabel
 * berikutnya dan menautkan tindakan ke bagian yang salah.
 */
// Awal bagian berikutnya — dipakai membatasi sampai mana daftar tindakan
// dibaca, baik pada triase maupun resume. Tanpa batas, pemindaian menelan
// isi bagian berikutnya dan menautkan tindakan ke tempat yang salah.
const BATAS_BAGIAN = /^(evaluasi|discharge|planning|edukasi|tanda\s*tangan|catatan\s*perkembangan|pemeriksaan\s*penunjang|diagnosa\s*keperawatan|rencana|anjuran|kelanjutan|diagnosa|penyebab|magelang,)/i;

/** Baris yang isinya hanya label tanpa nilai — jebakan "Tindakan" kosong. */
function hanyaLabel(baris, pola) {
  const sisa = String(baris).replace(pola, '').replace(/[:\s.-]/g, '');
  return sisa.length === 0;
}

/**
 * Ambil teks nilai dari sebuah label. Kalau nilainya tidak berada di baris yang
 * sama, baris berikutnya ikut dilihat — sebagian formulir memecahnya ke bawah.
 */
function ambilNilaiLabel(baris, indeks, pola) {
  const sekarang = String(baris[indeks] || '');
  if (!hanyaLabel(sekarang, pola)) {
    return { teks: sekarang.replace(pola, '').replace(/^[:\s.-]+/, '').trim(), baris: sekarang };
  }
  const berikut = String(baris[indeks + 1] || '').trim();
  // Baris berikutnya dipakai hanya kalau ia bukan label lain.
  if (berikut && !/^[A-Z][A-Za-z\s]{0,24}:?$/.test(berikut)) {
    return { teks: berikut, baris: sekarang + ' ' + berikut };
  }
  return { teks: '', baris: sekarang };
}

function cocokkanKamus(teks) {
  const cocok = KAMUS_TINDAKAN.filter(t => t.pola.test(teks));

  // Injeksi antibiotik juga cocok dengan pola injeksi umum, dan kalau keduanya
  // dibiarkan lolos satu suntikan menghasilkan DUA kode (99.21 dan 99.29).
  // Itu koding ganda, dan justru jenis kesalahan yang dicari verifikator.
  // Yang lebih khusus menang.
  if (cocok.some(t => t.id === 'injeksi_antibiotik')) {
    return cocok.filter(t => t.id !== 'injeksi_obat');
  }
  return cocok;
}

/**
 * Baca seluruh tindakan yang tertulis di berkas, lengkap dengan kutipan dan
 * nomor halaman.
 *
 * @param {Array<{page_number:number, ocr_text:string}>} halaman
 * @returns {Array} satu entri per jenis tindakan, dengan semua buktinya
 */
function bacaTemuanTindakan(halaman) {
  const perTindakan = new Map();

  const catat = (tindakan, bukti) => {
    if (!perTindakan.has(tindakan.id)) {
      perTindakan.set(tindakan.id, {
        id: tindakan.id,
        nama: tindakan.nama,
        kode_usulan: tindakan.kode_usulan,
        ...(tindakan.catatan_kode ? { catatan_kode: tindakan.catatan_kode } : {}),
        bukti: [],
      });
    }
    const entri = perTindakan.get(tindakan.id);
    // Satu halaman cukup diwakili satu kutipan.
    if (entri.bukti.some(b => b.page_number === bukti.page_number)) return;
    entri.bukti.push(bukti);
  };

  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text || hal.text);
    if (!teks) continue;
    const jenis = classifyPageDocumentType(teks);
    const baris = teks.split(/\r?\n/);

    // 1. Dari label tindakan, hanya pada jenis halaman yang memang memuatnya.
    for (const pola of LABEL_PER_JENIS[jenis] || []) {
      for (let i = 0; i < baris.length; i++) {
        if (!pola.test(baris[i])) continue;

        // Tindakan bisa berada di DUA tempat, dan keduanya harus dibaca:
        //
        //   pada baris labelnya     "Tindakan Nebulisasi Ventasal"
        //   sebagai daftar di bawah "Tindakan" / "inj omeprazole 1A" / dst
        //
        // Membaca satu saja membuat separuh berkas terlewat: berkas MUNAWIR
        // memakai bentuk pertama, SUMIDAH bentuk kedua dengan tiga injeksi
        // berurutan. Pemindaian berhenti di bagian berikutnya supaya tidak
        // menelan isi bagian lain.
        const { teks: nilai, baris: kutipan } = ambilNilaiLabel(baris, i, pola);
        if (nilai) {
          for (const t of cocokkanKamus(nilai)) {
            catat(t, {
              page_number: hal.page_number || null,
              sumber: jenis,
              kutipan: kutipan.trim().slice(0, 160),
            });
          }
        }

        for (let j = i + 1; j < baris.length; j++) {
          const b = String(baris[j]).trim();
          if (BATAS_BAGIAN.test(b)) break;
          for (const t of cocokkanKamus(b)) {
            catat(t, {
              page_number: hal.page_number || null,
              sumber: jenis,
              kutipan: b.slice(0, 160),
            });
          }
        }
      }
    }

    // 2. Dari resep. Resep tidak pernah menambah tindakan sendiri — ia hanya
    //    menguatkan atau memunculkan pertanyaan. Karena itu sumbernya ditandai
    //    supaya bisa dibedakan saat dinilai.
    if (jenis === 'resep') {
      for (const b of baris) {
        if (!/R\s*\/|\bnebul/i.test(b)) continue;
        for (const t of cocokkanKamus(b)) {
          // Injeksi obat sengaja tidak diambil dari resep: obat yang
          // diresepkan belum tentu disuntikkan.
          if (t.hanya_dari_tindakan) continue;
          catat(t, {
            page_number: hal.page_number || null,
            sumber: 'resep',
            kutipan: b.trim().slice(0, 160),
          });
        }
      }
    }
  }

  return [...perTindakan.values()];
}

/**
 * Pengecekan silang: resep atau triase menyebut sebuah tindakan, tapi kolom
 * tindakan di resume tidak memuatnya.
 *
 * Ini yang paling cepat menangkap kasus seperti nebulisasi MUNAWIR, dan ia
 * bekerja bahkan ketika pembacaan kolom resume gagal karena tata letak.
 *
 * Yang dihasilkan PERINGATAN, bukan kesimpulan: tidak ada tindakan yang
 * ditambahkan sendiri oleh sistem. Yang tidak tertulis tidak boleh dikodekan.
 */
function periksaSilangTindakan(temuan) {
  const catatan = [];
  for (const t of temuan || []) {
    const dariResume = t.bukti.some(b => b.sumber === 'resume_medis');
    if (dariResume) continue;

    const sumberLain = [...new Set(t.bukti.map(b => b.sumber))];
    if (!sumberLain.length) continue;

    catatan.push({
      id: t.id,
      nama: t.nama,
      jenis: 'tindakan_tidak_ada_di_resume',
      keparahan: 'sedang',
      pesan: `${t.nama} tercatat di ${sumberLain.join(' dan ')}, tetapi tidak terbaca pada kolom Tindakan di resume medis. Periksa apakah tindakan ini memang dilakukan tetapi belum tercatat di resume.`,
      bukti: t.bukti,
    });
  }
  return catatan;
}

module.exports = {
  bacaTemuanTindakan,
  periksaSilangTindakan,
  KAMUS_TINDAKAN,
};
