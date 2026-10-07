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
const { bagianKutipan, BAGIAN } = require('./bagianTemuanService');

/** Nama obat/alat pada daftar terapi tetap petunjuk; perlu catatan pelaksanaan untuk kode tindakan. */
function alasanTahanTindakan(bukti, halaman) {
  const hal = (halaman || []).find(p => Number(p.page_number) === Number(bukti.page_number));
  if (!hal) return 'Kutipan tindakan belum mempunyai halaman sumber yang dapat diperiksa; perlu klarifikasi sebelum mengisi kode.';
  const teks = hal.ocr_text || hal.text || '';
  const q = String(bukti.kutipan || bukti.quotation || '');
  if (!q.trim()) return 'Kutipan pelaksanaan tindakan belum tersedia; perlu klarifikasi sebelum mengisi kode.';
  if (!require('./pagarTemuanService').verifikasiKutipan(q, bukti.page_number, halaman).valid)
    return 'Kutipan pelaksanaan tindakan tidak ditemukan pada halaman sumber; kandidat ditahan agar tidak menjadi kode klaim.';
  const jenis = classifyPageDocumentType(teks);
  const resepMurni = jenis === 'resep' && !/discharge\s+planning|perencanaan\s+pemulangan/i.test(teks);
  const dariDaftar = resepMurni || bagianKutipan(teks, q) === BAGIAN.TERAPI;
  const pelaksanaan = /\b(?:dilakukan|melakukan|diberikan|memberikan|menjalani|terpasang|dinebulisasi|dienema|diklisma)\b/i.test(q);
  const rencana = /\b(?:rencana|akan|belum|ditunda|dibatalkan|riwayat)\b|\btidak\s+(?:dilakukan|diberikan|dinebulisasi|dienema|diklisma)\b/i.test(q);
  if (rencana) return 'Kutipan menyebut rencana, riwayat, atau tindakan yang belum/tidak dilakukan; tidak menjadi bukti pelaksanaan pada episode ini.';
  if (dariDaftar && (resepMurni || !pelaksanaan || rencana)) {
    return 'Kutipan hanya menyebut obat, alat, atau rencana pada daftar terapi/resep; pelaksanaan tindakan belum terbukti. Periksa catatan tindakan sebelum mengisi kode.';
  }
  return null;
}

function alasanKodeTindakan(kode, kutipan) {
  if (String(kode) === '75.32' && /\bCTG\b|kardiotokogra|cardiotocogra|\bNST\b|non\s*stress\s*test/i.test(kutipan || '')
    && !/\bscalp\b|elektroda\s+(?:kepala|kulit)|fetal\s+(?:EKG|ECG)/i.test(kutipan || ''))
    return 'CTG/NST tidak sendiri membuktikan EKG janin dengan elektroda kulit kepala (75.32). Pemantauan janin lain dinilai sebagai 75.34 dengan bukti pelaksanaan.';
  if (String(kode) === '54.11' && !/laparotomi\s+eksplor\w*|explor(?:ative|atory)\s+laparotomy|eksplorasi\s+laparotomi/i.test(kutipan || ''))
    return 'Laparotomi sebagai akses operasi tidak membuktikan laparotomi eksplorasi tersendiri (54.11). Gunakan tindakan definitif yang tercatat.';
  if (['89.29', '89.39'].includes(String(kode)) && /\bgds\b|gula\s+darah|gluko[sz]/i.test(kutipan || ''))
    return 'Pemeriksaan gula darah bukan pemeriksaan fisik 89.29/89.39; kode penunjang darah dinilai dari hasil pemeriksaan.';
  return null;
}

function jagaSumberTindakan(saran, tindakan, halaman) {
  const suggestions = (saran || []).map(s => {
    if (!s || s.type !== 'procedure' || s.boleh_isi_otomatis === false) return s;
    const alasan = alasanKodeTindakan(s.code, s.quotation)
      || alasanTahanTindakan({ page_number: s.page_number, kutipan: s.quotation }, halaman);
    return alasan ? { ...s, boleh_isi_otomatis: false, alasan_tahan: alasan } : s;
  });
  const findings = (tindakan || []).map(t => {
    if (!t?.kode_usulan || !(t.bukti || []).length) return t;
    // Gerbang yang sama berlaku untuk temuan; kode tertahan tidak boleh
    // dimasukkan kembali lewat tindakanTerverifikasi pada tahap berikutnya.
    const alasan = t.bukti.map(b => alasanKodeTindakan(t.kode_usulan, b.kutipan || b.quotation) || alasanTahanTindakan(b, halaman));
    if (alasan.some(a => !a)) return { ...t, bukti_kode: t.bukti.filter((_, i) => !alasan[i]) }; // Petunjuk resep tetap terlihat; kode memakai catatan pelaksanaan yang sah.
    return { ...t, kode_perlu_klarifikasi: t.kode_usulan, kode_usulan: null,
      perlu_klarifikasi: true, alasan_tahan: alasan[0], catatan_kode: `Kandidat ${t.kode_usulan}. ${alasan[0]}` };
  });
  return { saran: suggestions, tindakan: findings };
}

/**
 * Kamus tindakan. `kode_usulan` adalah USULAN, bukan keputusan — apakah ia
 * masuk daftar prosedur tetap wewenang koder casemix.
 *
 * Kode yang belum pasti sengaja dibiarkan null daripada ditebak; kode karangan
 * jauh lebih berbahaya daripada kolom kosong.
 */
const KAMUS_TINDAKAN = [
  { id: 'kateter_urin', nama: 'Kateterisasi urin', kode_usulan: '57.94',
    pola: /\b(?:pasang|pemasangan|terpasang)\s+(?:dc|dower\s+catheter|kateter\s+(?:urin|urine)|foley)\b|\bkateterisasi\s+(?:urin|urine)\b/i },
  {
    id: 'nebulisasi',
    nama: 'Nebulisasi',
    kode_usulan: '93.94',
    // "Nebulizer"/"Nebuliser" ditulis dokter di kolom Tindakan resume IGD
    // (berkas 0170R0110826V000083: "Nebulizer Ventasal : Budesma = 1 : 1").
    pola: /\b(?:di)?nebu(?:l(?:isasi|i[sz]er|i[sz]ation|es)?)?\b/i,
    // Petunjuk di RESEP bahwa tindakannya dilakukan. Yang dihitung alat, atau
    // obat dalam bentuk nebul; salbutamol tablet bukan nebulisasi, jadi obat
    // selalu dipasangkan dengan bentuk sediaannya.
    sinyal_resep: [
      /\bmasker\s*nebul|\bnebuli[sz]er\b|\bnebul\s*chamber\b/i,
      /\b(ventasal|salbutamol|combivent|ipratropium|ventolin|budesonide|pulmicort)\b[^\n]{0,40}\b(nebul\w*|respul|inhalasi)\b/i,
    ],
  },
  {
    id: 'ligasi_hemoroid', nama: 'Ligasi hemoroid', kode_usulan: '49.45',
    pola: /\b(?:ligasi|ligation|banding)\s+(?:hemoroid|hemorroid|hemorrhoid)s?\b/i,
  },
  {
    id: 'eksisi_hemoroid', nama: 'Eksisi hemoroid', kode_usulan: '49.46',
    pola: /\b(?:eksisi|excision|excisi\w*)\s+(?:hemoroid|hemorroid|hemorrhoid)s?\b|\b(?:hemoroidektomi|hemorrhoidectomy)\b/i,
  },
  {
    id: 'terapi_oksigen',
    nama: 'Terapi oksigen',
    kode_usulan: '93.96',
    pola: /\boksigen(asi)?\b|\bo2\s*(nasal|kanul|masker|nrm)\b/i,
    // Alat oksigen di resep. Saturasi rendah SAJA tidak pernah menjadi dasar
    // tindakan: yang tidak tertulis diberikan tidak boleh dikodekan.
    sinyal_resep: [/\bnasal\s*(kanul|canul|cannula)\b|\bmasker\s*(oksigen|o2|nrm)\b|\bnon[\s-]?rebreathing\b|\bselang\s*oksigen\b/i],
  },
  {
    id: 'pemasangan_infus',
    nama: 'Pemasangan infus',
    kode_usulan: null,
    catatan_kode: 'Kode belum dipastikan koder — sengaja tidak ditebak.',
    pola: /\b(pasang|memasang|terpasang)\s*(inf|infus|ivfd)\b|\binfus\s*(asering|rl|nacl)/i,
    sinyal_resep: [/\b(abocath|iv\s*cath(eter)?|infus\s*set|venflon|wing\s*needle)\b/i],
  },
  {
    id: 'rontgen_toraks',
    nama: 'Rontgen toraks',
    kode_usulan: '87.44',
    pola: /\b(ro|rontgen|foto|x[\s-]?ray)\s*(thorax|thoraks|toraks|dada)\b/i,
  },
  // Indeks alfabetis ICD-9-CM: "Removal, cerumen, ear 96.52". Ditemukan pada
  // berkas 0170R0110826V000019 (H61.2): "ekstraksi serumen" di kolom Tindakan
  // resume poli THT tidak terbaca sama sekali, PROCLIST tetap kosong.
  // Diagnosis "impacted serumen" sengaja tidak cocok — itu bukan tindakan.
  {
    id: 'ekstraksi_serumen',
    nama: 'Ekstraksi serumen',
    kode_usulan: '96.52',
    pola: /\b(ekstraksi|ekstrasi|evakuasi|pengambilan|pembersihan|irigasi|spoe?ling|spooling)\s*(serumen|cerumen)\b|\birigasi\s*telinga\b/i,
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
  resume_medis: [/\bTindakan(?:\s*\/\s*Prosedur)?\b/i, /^\s*(?:Prosedur|Terapi\/pengobatan selama di rumah sakit)\s*:/i],
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
const BATAS_BAGIAN = /^(evaluasi|discharge|planning|edukasi|tanda\s*tangan|catatan\s*perkembangan|pemeriksaan\s*penunjang|diagnosa\s*keperawatan|rencana|anjuran|kelanjutan|diagnos[ai]s?|penyebab|terapi|reaksi|diet|instruksi|keadaan\s+keluar|cara\s+keluar|magelang,)/i;

/**
 * Isi kolom Tindakan resume menurut POSISI kata, bila halaman membawanya.
 * `nilai_label` diisi di claimFiles.gatherEvidencePool dari kotak kata PDF
 * digital; halaman scan/OCR tidak memilikinya dan hasilnya string kosong.
 */
function nilaiTindakanDariPosisi(hal) {
  const nilai = hal && hal.nilai_label && hal.nilai_label.Tindakan;
  const teks = typeof nilai === 'string' ? nilai.replace(/\s+/g, ' ').trim() : '';
  return /^[-\s.:]*$/.test(teks) ? '' : teks;
}

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

/**
 * Apakah kemunculan di indeks itu dinegasikan ("tanpa oksigen", "belum
 * dinebulisasi"). Tindakan yang disangkal tidak boleh terbaca sebagai
 * dilakukan — yang tidak tertulis dikerjakan tidak boleh dikodekan.
 */
function dinegasi(teks, indeks) {
  const sebelum = String(teks).slice(Math.max(0, indeks - 24), indeks);
  return /\b(tanpa|tidak|tdk|tak|belum|bukan)\s+(perlu\s+|ada\s+|di\s*beri(?:kan)?\s+|diberi(?:kan)?\s+|pakai\s+|dilakukan\s+|di\s*lakukan\s+)?$/i.test(sebelum);
}

function cocokPola(pola, teks) {
  const m = pola.exec(teks);
  if (!m || dinegasi(teks, m.index)) return false;
  const sebelum = String(teks).slice(0, m.index);
  const sesudah = String(teks).slice(m.index + m[0].length);
  return !/\b(?:rencana|direncanakan|anjuran|anjurkan|bila\s+perlu|jika|riwayat|pro|jadwal|akan)\b/i.test(sebelum)
    && !/^\s*(?:belum|tidak|ditunda|dibatalkan|batal|\(-\))/i.test(sesudah);
}

function cocokkanKamus(teks) {
  const cocok = KAMUS_TINDAKAN.filter(t => cocokPola(t.pola, teks));

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

    // 0. Isi label dari POSISI kata (pasanganLabelPosisiService). Pada resume
    //    SIMRS label sel terpusat vertikal sedangkan isinya di atas sel, jadi
    //    urutan baca memberi "Tindakan" kosong. Bila posisi memberi isi, itu
    //    yang dipakai dan jalur teks di bawah dilewati untuk halaman ini;
    //    bila kosong/tidak ada koordinat, jalur teks lama berjalan seperti biasa.
    const nilaiPosisi = jenis === 'resume_medis' ? nilaiTindakanDariPosisi(hal) : '';
    if (nilaiPosisi) {
      for (const t of cocokkanKamus(nilaiPosisi)) {
        catat(t, {
          page_number: hal.page_number || null,
          sumber: jenis,
          kutipan: ('Tindakan: ' + nilaiPosisi).slice(0, 160),
          cara_baca: 'posisi',
        });
      }
    }

    // 1. Dari label tindakan, hanya pada jenis halaman yang memang memuatnya.
    for (const pola of (nilaiPosisi ? [] : (LABEL_PER_JENIS[jenis] || []))) {
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
        let { teks: nilai, baris: kutipan } = ambilNilaiLabel(baris, i, pola);

        // Resume SIMRS: label sel terpusat vertikal, sehingga pada teks OCR
        // (tanpa koordinat kata) isinya muncul SATU BARIS DI ATAS label --
        // "Nebulizer Ventasal : Budesma = 1 : 1" lalu "Tindakan". Dipakai
        // hanya bila label berdiri sendiri, dan tidak pernah baris kode
        // diagnosis ("J45.3 - ...") supaya isi kolom Diagnosa tidak terbaca
        // sebagai tindakan.
        if (!nilai && jenis === 'resume_medis' && hanyaLabel(String(baris[i]), pola) && i > 0) {
          const atas = String(baris[i - 1]).trim();
          if (atas && !/^[A-Z]\d{2}(\.\d+)?\s*-/.test(atas) && !BATAS_BAGIAN.test(atas)) {
            nilai = atas;
            kutipan = `${atas} / ${String(baris[i]).trim()}`;
          }
        }
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

    // Discharge planning/intervensi di halaman lanjutan triase: hanya catatan
    // pelaksanaan eksplisit, bukan rencana obat pulang atau edukasi.
    if (/discharge\s+planning|perencanaan\s+pemulangan/i.test(teks)) {
      for (const b of baris) {
        if (!/memberikan|diberikan|dilakukan|melakukan|telah|terpasang/i.test(b)) continue;
        for (const t of cocokkanKamus(b)) catat(t, { page_number: hal.page_number || null, sumber: 'triase_igd', kutipan: b.trim().slice(0, 160) });
      }
    }

    // 2. Dari resep. Resep tidak pernah menambah tindakan sendiri — ia hanya
    //    menguatkan atau memunculkan pertanyaan. Karena itu sumbernya ditandai
    //    supaya bisa dibedakan saat dinilai.
    if (jenis === 'resep') {
      for (const b of baris) {
        const kandidat = new Map();
        if (/R\s*\/|\bnebul/i.test(b)) {
          for (const t of cocokkanKamus(b)) kandidat.set(t.id, t);
        }
        // Alat/obat khas sebuah tindakan (Masker Nebul, nasal kanul, abocath...)
        // dikenali walau barisnya tidak memakai penanda R/.
        for (const t of KAMUS_TINDAKAN) {
          if ((t.sinyal_resep || []).some(p => cocokPola(p, b))) kandidat.set(t.id, t);
        }
        for (const t of kandidat.values()) {
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
 * Kumpulkan kalimat di kolom Tindakan yang TIDAK dikenali kamus bawaan.
 *
 * Dipakai untuk meminta kode pada tindakan baru. Hanya diambil dari resume
 * dan triase — resep tidak pernah dipakai, karena obat yang diresepkan belum
 * tentu diberikan.
 */
function kalimatTindakanTakDikenal(halaman) {
  const keluar = [];
  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text || hal.text);
    if (!teks) continue;
    const jenis = classifyPageDocumentType(teks);
    const baris = teks.split(/\r?\n/);
    const nilaiPosisi = jenis === 'resume_medis' ? nilaiTindakanDariPosisi(hal) : '';
    if (nilaiPosisi) {
      if (nilaiPosisi.length >= 4 && cocokkanKamus(nilaiPosisi).length === 0) keluar.push(nilaiPosisi.slice(0, 120));
      continue; // isi kolom sudah diketahui dari posisi; jalur teks tidak perlu menebak
    }
    for (const pola of LABEL_PER_JENIS[jenis] || []) {
      for (let i = 0; i < baris.length; i++) {
        if (!pola.test(baris[i])) continue;
        for (let j = i; j < baris.length; j++) {
          const b = String(baris[j]).replace(pola, ' ').trim();
          if (j > i && BATAS_BAGIAN.test(String(baris[j]).trim())) break;
          // Baris terlalu pendek hampir selalu sisa tata letak, bukan tindakan.
          if (b.length < 4) continue;
          if (cocokkanKamus(b).length > 0) continue; // sudah dikenali kamus bawaan
          keluar.push(b.slice(0, 120));
        }
      }
    }
  }
  return [...new Set(keluar)];
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
      kemungkinan_belum_terbaca: true,
      pesan: `Kemungkinan tindakan ${t.nama.toLowerCase()} belum terbaca. ${t.nama} tercatat di ${sumberLain.join(' dan ')}, tetapi tidak terbaca pada kolom Tindakan di resume medis. Periksa apakah tindakan ini memang dilakukan tetapi belum tercatat di resume.`,
      bukti: t.bukti,
    });
  }
  return catatan;
}

module.exports = {
  jagaSumberTindakan,
  kalimatTindakanTakDikenal,
  bacaTemuanTindakan,
  periksaSilangTindakan,
  KAMUS_TINDAKAN,
};
