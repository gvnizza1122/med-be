/**
 * Syarat penunjang diagnosis — Tipe 2 (tindakan ada) & Tipe 1 (hasil mendukung).
 *
 * Sebagian diagnosis hanya boleh dikoding bila pemeriksaan penunjangnya ada DAN
 * hasilnya mendukung. Yang diperiksa verifikator BPJS adalah HASILNYA, bukan
 * ada-tidaknya tindakan — kalimat penolakan di rekap pending RS ini berbunyi
 * "tidak didukung dengan adanya pemeriksaan gram", "tidak ada bukti adanya
 * pemeriksaan CT Scan", "tidak didukung adanya bukti kenaikan creatinin".
 * Semuanya soal bukti hasil.
 *
 * Karena itu dibedakan DUA tingkat, dan keduanya dilaporkan terpisah:
 *
 *   Tingkat 1 (Tipe 2) — kode penunjang ada di PROCLIST. Mudah dan pasti.
 *   Tingkat 2 (Tipe 1) — nilai atau temuannya tertulis dan memenuhi ambang.
 *
 * Kalau berhenti di Tingkat 1, sistem akan menyatakan "aman" untuk klaim yang
 * tindakannya dilakukan tapi hasilnya tidak pernah terbaca di berkas — persis
 * keadaan yang ditolak BPJS. Karena itu keadaan itu punya status tersendiri
 * dan tidak pernah ditampilkan sebagai centang hijau.
 *
 * Deterministik: tidak memanggil AI dan tidak memakai token.
 */

const REFERENSI = require('../data/syaratPenunjangDiagnosis.json');

// Empat keadaan, bukan dua. "Tindakan ada tapi hasil belum terbaca" bukan
// kesalahan — tapi juga bukan aman, dan menyamakannya dengan salah satu dari
// keduanya sama-sama menyesatkan.
const STATUS = {
  TERPENUHI: 'terpenuhi',
  HASIL_BELUM_TERBACA: 'tindakan_ada_hasil_belum_terbaca',
  TIDAK_ADA: 'tidak_ada',
  // Sebagian syarat memang tidak bisa dinilai dari berkas. Daftar obat di
  // berkas RS ini berbentuk tabel berkolom yang nyaris tidak terbaca OCR,
  // sehingga "antibiotik IV 72 jam" mustahil diperiksa mesin. Melaporkannya
  // "tidak ada" berarti menuduh pasien pneumonia tidak diberi antibiotik,
  // padahal yang gagal adalah pembacaannya. Mengaku tidak tahu lebih berguna
  // daripada menebak ke arah mana pun.
  PERLU_CEK_MANUAL: 'perlu_cek_manual',
};

// Nama lain yang dipakai di berkas RS untuk parameter yang sama. Tanpa ini,
// "Hb" tidak akan pernah dikenali sebagai hemoglobin.
const SINONIM_LAB = {
  hemoglobin: ['hemoglobin', 'haemoglobin', 'hb'],
  kreatinin: ['kreatinin', 'creatinin', 'creatinine', 'serum creatinin'],
};

function normalisasi(teks) {
  return String(teks || '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Cocokkan kode diagnosis dengan aturan, menghormati kekhususan kode.
 *
 * Aturan "J18" berlaku untuk J18, J18.0, J18.9 — tapi aturan "I67.8" TIDAK
 * boleh terpicu oleh I67 atau I67.9. Karena itu yang dibandingkan adalah
 * awalan kode klaim terhadap kode aturan, bukan sebaliknya.
 */
function kodeCocok(kodeKlaim, kodeAturan) {
  const a = normalisasi(kodeKlaim).replace(/\s/g, '');
  const b = normalisasi(kodeAturan).replace(/\s/g, '');
  if (!a || !b) return false;
  if (a === b) return true;
  // Kode klaim lebih khusus daripada aturan: J18.9 cocok dengan aturan J18.
  // Pembatas '.' wajib supaya J180 (kode lain) tidak ikut tertangkap.
  return a.startsWith(b) && a[b.length] === '.';
}

/**
 * Baca nilai lab berupa angka dari teks halaman.
 *
 * Mengembalikan nilai TERKECIL yang ditemukan untuk parameter itu, bukan yang
 * pertama: berkas sering memuat beberapa pemeriksaan dari hari berbeda, dan
 * untuk ambang seperti "Hb di bawah 8" yang menentukan adalah nilai terendah
 * yang pernah tercatat.
 *
 * @returns {{nilai: number, kutipan: string, page_number: number}|null}
 */
function bacaNilaiLab(halaman, parameter) {
  const sinonim = SINONIM_LAB[parameter] || [parameter];
  let terbaik = null;

  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text || hal.text);
    if (!teks) continue;

    for (const nama of sinonim) {
      // Nama parameter, lalu pemisah/satuan seadanya, lalu angka. Koma
      // diterima sebagai desimal karena berkas RS menulis "7,2".
      const pola = new RegExp(
        '\\b' + nama.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '\\b[^0-9\\n]{0,20}(\\d{1,3}(?:[.,]\\d{1,2})?)',
        'gi'
      );
      let m;
      while ((m = pola.exec(teks)) !== null) {
        const nilai = Number(String(m[1]).replace(',', '.'));
        if (!Number.isFinite(nilai)) continue;
        if (terbaik === null || nilai < terbaik.nilai) {
          terbaik = {
            nilai,
            kutipan: m[0].trim().substring(0, 120),
            page_number: hal.page_number || null,
          };
        }
      }
    }
  }
  return terbaik;
}

/** Cari kata kunci hasil (mis. "infiltrat") di halaman mana pun. */
function cariKataKunci(halaman, kataKunci) {
  for (const hal of halaman || []) {
    const teks = normalisasi(hal && (hal.ocr_text || hal.text));
    if (!teks) continue;
    for (const kata of kataKunci || []) {
      const idx = teks.indexOf(normalisasi(kata));
      if (idx === -1) continue;
      const sebelum = teks.slice(Math.max(0, idx - 65), idx);
      const sesudah = teks.slice(idx + normalisasi(kata).length, idx + normalisasi(kata).length + 20);
      if (/\b(?:tidak|tak|tanpa|belum)\s+(?:(?:tampak|ada|ditemukan|didapatkan|terlihat)\s+)*(?:adanya\s+)?$/i.test(sebelum)
        || /^\s*(?:\(-\)|negatif|tidak\s+ada)/i.test(sesudah)) continue;
      return {
        kata,
        kutipan: teks.substring(Math.max(0, idx - 40), idx + 80).trim(),
        page_number: hal.page_number || null,
      };
    }
  }
  return null;
}

function bandingkan(nilai, operator, ambang) {
  switch (operator) {
    case '<': return nilai < ambang;
    case '<=': return nilai <= ambang;
    case '>': return nilai > ambang;
    case '>=': return nilai >= ambang;
    default: return true; // 'ada' — cukup tercatat
  }
}

/** Satu syarat dinilai terhadap PROCLIST dan isi dokumen. */
function nilaiSyarat(syarat, kodeProsedur, halaman, opsi = {}) {
  const kodeAda = (syarat.kode_prosedur || []).filter(
    k => (kodeProsedur || []).some(p => normalisasi(p).replace(/\s/g, '') === normalisasi(k).replace(/\s/g, ''))
  );
  const tindakanAda = kodeAda.length > 0;

  const hasil = {
    nama: syarat.nama,
    tingkat_risiko: syarat.tingkat_risiko || 'disarankan',
    tindakan_ada: tindakanAda,
    kode_prosedur_ditemukan: kodeAda,
    nilai: null,
    kutipan: null,
    page_number: null,
    status: tindakanAda ? STATUS.HASIL_BELUM_TERBACA : STATUS.TIDAK_ADA,
    ...(syarat.catatan_batasan ? { catatan_batasan: syarat.catatan_batasan } : {}),
  };

  // Syarat yang memang tidak bisa dinilai dari berkas berhenti di sini, apa
  // pun isi dokumennya. Tanpa ini ia akan dilaporkan "tidak ada" — tuduhan
  // yang bersumber dari kegagalan membaca, bukan dari isi berkasnya.
  if (syarat.jenis_pemeriksaan === 'antibiotik_iv_72_jam') {
    const pemberian = require('./pemberianAntibiotikService').bacaPemberianAntibiotik(halaman);
    hasil.status = STATUS.PERLU_CEK_MANUAL;
    if (pemberian) {
      hasil.kutipan = pemberian.kutipan;
      hasil.page_number = pemberian.page_number;
      hasil.tindakan_ada = true;
      if (pemberian.durasi_jam != null) {
        hasil.nilai = pemberian.durasi_jam;
        hasil.ambang = '≥ 72 jam';
        hasil.memenuhi_ambang = pemberian.durasi_jam >= 72;
        hasil.status = hasil.memenuhi_ambang ? STATUS.TERPENUHI : STATUS.TIDAK_ADA;
        hasil.catatan_batasan = 'Durasi dihitung dari periode pemberian antibiotik IV yang tercatat. Penilaian terapi keseluruhan tetap mengikuti diagnosis dan catatan dokter.';
      }
    }
    return hasil;
  }
  if (syarat.dapat_diperiksa_sistem === false) {
    hasil.status = STATUS.PERLU_CEK_MANUAL;
    hasil.dapat_diperiksa_sistem = false;
    return hasil;
  }
  if (syarat.memerlukan_baseline) {
    const lab = opsi.pakaiBacaLab || process.env.SYARAT_PAKAI_BACA_LAB === 'true'
      ? require('./bacaLabService').nilaiLabDariBaris(halaman, syarat.parameter_lab)
      : bacaNilaiLab(halaman, syarat.parameter_lab);
    hasil.status = STATUS.PERLU_CEK_MANUAL;
    if (lab) {
      hasil.nilai = lab.tidak_dapat_dipakai ? null : lab.nilai;
      hasil.kutipan = lab.kutipan;
      hasil.page_number = lab.page_number;
    }
    hasil.memenuhi_ambang = null;
    hasil.catatan_batasan = lab && !lab.tidak_dapat_dipakai
      ? 'Nilai kreatinin ditemukan. Kenaikan terhadap baseline dan waktu perubahan belum terkonfirmasi; satu nilai tidak cukup menilai syarat AKI.'
      : 'Perbandingan kreatinin dengan baseline dan waktu perubahan belum dapat dinilai dari bukti yang terbaca.';
    return hasil;
  }
  if ((syarat.kode_prosedur || []).includes('90.41')) {
    const gram = require('./pemeriksaanSputumService').bacaGramSputum(halaman)[0];
    if (gram) {
      hasil.status = STATUS.TERPENUHI;
      hasil.tindakan_ada = true;
      hasil.kutipan = gram.kutipan;
      hasil.page_number = gram.page_number;
      hasil.catatan_batasan = 'Hasil Gram sputum terbaca. Hasil ini tidak sendiri menetapkan spesies kuman, diagnosis pneumonia, atau kecukupan lama antibiotik.';
    }
    return hasil;
  }

  // Tingkat 2a — nilai lab berupa angka.
  if (syarat.parameter_lab) {
    // Jalur baris (opsional, default mati): nilai dibaca per baris tabel dan
    // diperiksa kewajarannya. Nilai yang terbaca tetapi tidak masuk akal
    // (mis. Hb 120) tidak dipakai memutuskan; syaratnya jadi cek manual.
    if (opsi.pakaiBacaLab || process.env.SYARAT_PAKAI_BACA_LAB === 'true') {
      const baris = require('./bacaLabService').nilaiLabDariBaris(halaman, syarat.parameter_lab);
      if (baris && baris.tidak_dapat_dipakai) {
        hasil.status = STATUS.PERLU_CEK_MANUAL;
        hasil.kutipan = baris.kutipan;
        hasil.page_number = baris.page_number;
        hasil.catatan_batasan = baris.alasan;
        return hasil;
      }
      if (baris) {
        hasil.nilai = baris.nilai;
        hasil.kutipan = baris.kutipan;
        hasil.page_number = baris.page_number;
        const memenuhi = syarat.operator ? bandingkan(baris.nilai, syarat.operator, syarat.nilai_ambang) : true;
        hasil.status = memenuhi ? STATUS.TERPENUHI : STATUS.TIDAK_ADA;
        hasil.memenuhi_ambang = memenuhi;
        if (syarat.operator) {
          hasil.ambang = `${syarat.operator} ${syarat.nilai_ambang}${syarat.satuan ? ' ' + syarat.satuan : ''}`;
        }
        return hasil;
      }
      // Saklar line-based dimaksudkan sebagai jalur aman. Bila tabel tidak
      // berhasil dibaca sebagai satu baris, jangan jatuh ke regex lama yang
      // bisa mengambil angka dari baris tetangga/kutipan bebas.
      hasil.status = STATUS.PERLU_CEK_MANUAL;
      hasil.catatan_batasan = 'Nilai lab tidak terbaca sebagai satu baris parameter-nilai-satuan; verifikasi berkas asli secara manual.';
      return hasil;
    }
    const temuan = bacaNilaiLab(halaman, syarat.parameter_lab);
    if (temuan) {
      hasil.nilai = temuan.nilai;
      hasil.kutipan = temuan.kutipan;
      hasil.page_number = temuan.page_number;
      const memenuhi = syarat.operator
        ? bandingkan(temuan.nilai, syarat.operator, syarat.nilai_ambang)
        : true;
      // Nilai yang terbaca tapi TIDAK memenuhi ambang bukan "belum terbaca" —
      // itu justru bukti bahwa syaratnya tidak terpenuhi, dan itulah yang
      // membuat BPJS meminta kodenya dihapus.
      hasil.status = memenuhi ? STATUS.TERPENUHI : STATUS.TIDAK_ADA;
      hasil.memenuhi_ambang = memenuhi;
      if (syarat.operator) {
        hasil.ambang = `${syarat.operator} ${syarat.nilai_ambang}${syarat.satuan ? ' ' + syarat.satuan : ''}`;
      }
    }
    return hasil;
  }

  // Tingkat 2b — temuan berupa kata pada hasil pemeriksaan.
  if (syarat.kata_kunci_hasil && syarat.kata_kunci_hasil.length) {
    const sumber = (syarat.kode_prosedur || []).includes('87.44')
      ? halaman.filter(p => /(?:hasil|kesan|pemeriksaan|rontgen|thorax|thoraks|toraks|paru|pulmo)/i.test(p.ocr_text || p.text || '')) : halaman;
    const temuan = cariKataKunci(sumber, syarat.kata_kunci_hasil);
    if (temuan) {
      hasil.kutipan = temuan.kutipan;
      hasil.page_number = temuan.page_number;
      hasil.kata_kunci_cocok = temuan.kata;
      hasil.status = STATUS.TERPENUHI;
    }
  }

  return hasil;
}

/**
 * Evaluasi seluruh diagnosis klaim terhadap tabel syarat penunjang.
 *
 * Diagnosis yang tidak punya syarat TIDAK dikembalikan sama sekali — panel di
 * layar hanya muncul kalau memang ada yang perlu dilihat, bukan menampilkan
 * "tidak ada syarat" di setiap klaim.
 *
 * @param {string|string[]} diagnosisList DIAGLIST, dipisah ';'
 * @param {string|string[]} prosedurList PROCLIST, dipisah ';'
 * @param {Array<{page_number:number, ocr_text:string}>} halaman
 * @param {{pakaiBacaLab?: boolean}} [opsi] pakaiBacaLab: baca nilai lab per baris + kewajaran (bacaLabService)
 * @returns {Array}
 */
function evaluasiSyaratPenunjang(diagnosisList, prosedurList, halaman = [], opsi = {}) {
  halaman = Array.isArray(halaman) ? halaman : [];
  const konteks = require('./konteksPenggunaanAiService').saatIni();
  const profil = opsi.profil || konteks.profil_klaim_rs || require('./profilKlaimRsService').profilBawaan(opsi.hospitalCode || konteks.hospital_code);
  const tanggal = opsi.tanggalPelayanan || null;
  const pisah = v => (Array.isArray(v) ? v : String(v || '').split(/[;,]/))
    .map(s => String(s).trim()).filter(Boolean);

  const diagnosis = pisah(diagnosisList);
  const prosedur = pisah(prosedurList);
  if (!diagnosis.length) return [];

  const temuan = [];
  for (const aturan of REFERENSI.aturan || []) {
    if (!aturan.diverifikasi) continue;
    const cakupan = (profil.ketentuan_lokal || []).find(a => a.id === aturan.id);
    if (!cakupan) continue;
    if (tanggal && ((cakupan.berlaku_mulai && tanggal < cakupan.berlaku_mulai) || (cakupan.berlaku_sampai && tanggal > cakupan.berlaku_sampai))) continue;
    const kodeKena = diagnosis.filter(d => kodeCocok(d, aturan.kode_diagnosis));
    if (!kodeKena.length) continue;

    // Syarat khusus usia hanya dinilai setelah usia terkonfirmasi.
    const usia = Number.isFinite(opsi.usia) ? opsi.usia : null;
    const diluarUsia = s => usia !== null && ((s.usia_min !== undefined && usia < s.usia_min) || (s.usia_max !== undefined && usia > s.usia_max));
    const syaratDilewati = (aturan.syarat || []).filter(diluarUsia)
      .map(s => ({ nama: s.nama, alasan: s.catatan_usia || `Tidak berlaku untuk usia ${usia} tahun.` }));
    const syarat = (aturan.syarat || []).filter(s => !diluarUsia(s)).map(s => {
      if(usia===null && (s.usia_min!==undefined || s.usia_max!==undefined)) return {nama:s.nama,tingkat_risiko:s.tingkat_risiko,status:STATUS.PERLU_CEK_MANUAL,tindakan_ada:false,kode_prosedur_ditemukan:[],nilai:null,kutipan:null,page_number:null,catatan_batasan:'Usia belum terkonfirmasi; syarat khusus anak/dewasa belum dinilai.'};
      const hasil=nilaiSyarat(s, prosedur, halaman, opsi);
      if(s.konfirmasi_cakupan_anak && (usia===null || usia<18)) {
        hasil.status_bukti=hasil.status;
        hasil.status=STATUS.PERLU_CEK_MANUAL;
        hasil.catatan_batasan=[hasil.catatan_batasan, 'Syarat dari rekap pending RS perlu konfirmasi cakupan pada anak. PNPK anak tidak menjadikan foto toraks rutin atau antibiotik IV 72 jam sebagai syarat universal klaim.'].filter(Boolean).join(' ');
      }
      return hasil;
    });
    if (aturan.id === 'SP-05') {
      const protein = require('./referensiKlaimService').nilaiPreeklampsia(require('./referensiKlaimService').halamanKlinis(halaman));
      const s = syarat[0];
      s.status = protein.status === 'bukti_ditemukan' ? STATUS.TERPENUHI : STATUS.PERLU_CEK_MANUAL;
      s.kutipan = protein.bukti[0]?.kutipan || null;
      s.page_number = protein.bukti[0]?.page_number || null;
      s.catatan_batasan = protein.catatan;
    }

    temuan.push({
      id: aturan.id,
      kode_diagnosis: kodeKena[0],
      kode_aturan: aturan.kode_diagnosis,
      nama_diagnosis: aturan.nama_diagnosis,
      // Persyaratan klaim berasal dari rujukan verifikasi BPJS, bukan
      // kebijakan layanan RS. Verifikasi penggunaan rujukan tidak mengubah
      // asal ketentuan atau membuktikan cakupannya berlaku nasional.
      diverifikasi: aturan.diverifikasi === true,
      jenis_ketentuan: 'persyaratan_klaim_bpjs',
      rujukan_id: 'REKAP-PENDING-RS',
      hospital_code: profil.hospital_code,
      cakupan: 'rs',
      berlaku_mulai: cakupan.berlaku_mulai,
      berlaku_sampai: cakupan.berlaku_sampai,
      perlu_konfirmasi_cakupan: aturan.id==='SP-01' && (usia===null || usia<18),
      perlu_konfirmasi_tanggal: !tanggal && !!(cakupan.berlaku_mulai || cakupan.berlaku_sampai),
      sumber_ketentuan: cakupan.sumber_aturan,
      // Nama lama dipertahankan untuk hasil analisis dan klien sebelumnya.
      sumber_aturan: cakupan.sumber_aturan,
      syarat,
      ...(syaratDilewati.length ? { syarat_dilewati_usia: syaratDilewati, usia_pasien: usia } : {}),
      ringkasan: {
        terpenuhi: syarat.filter(s => s.status === STATUS.TERPENUHI).length,
        hasil_belum_terbaca: syarat.filter(s => s.status === STATUS.HASIL_BELUM_TERBACA).length,
        tidak_ada: syarat.filter(s => s.status === STATUS.TIDAK_ADA).length,
        perlu_cek_manual: syarat.filter(s => s.status === STATUS.PERLU_CEK_MANUAL).length,
      },
    });
  }

  return temuan;
}

module.exports = {
  evaluasiSyaratPenunjang,
  bacaNilaiLab,
  cariKataKunci,
  kodeCocok,
  STATUS,
};
