/**
 * Konsistensi antar data — "kalau Data A ada, Data B yang menyertainya harus ada."
 *
 * Verifikator BPJS mencari ketidakcocokan di mana pun: antara resume dan
 * triase, antara prosedur dan resep, antara klaim dan SEP. Satu data yang
 * berdiri sendiri tanpa pendukungnya adalah alasan pending yang gampang
 * ditemukan. Karena itu pemeriksaannya harus menyeluruh, bukan per dokumen.
 *
 * Aturannya disimpan sebagai DATA (konsistensiAntarData.json), bukan ditulis
 * di kode, supaya koder bisa menambah pasangan baru tanpa deploy ulang.
 *
 * Deterministik: tidak memanggil AI dan tidak memakai token.
 *
 * BAHASA ATURAN
 * -------------
 * Sebuah aturan berbunyi: JIKA <kondisi> MAKA <kondisi> — kalau bagian MAKA
 * tidak terpenuhi, muncul temuan. Kosakata kondisinya sengaja kecil supaya
 * aturannya bisa dibaca orang non-teknis:
 *
 *   field_terisi      : ["los"]                 kolom klaim terisi & bukan 0
 *   field_kosong      : ["discharge_date"]
 *   field_cocok       : {field, pola}           regex pada nilai kolom
 *   kode_prosedur     : "87.44"                 ada di PROCLIST
 *   diagnosis_awalan  : "J18"                   ada di DIAGLIST (hormati titik)
 *   tindakan          : "nebulisasi"            terbaca dari berkas
 *   ada_halaman       : "laporan_operasi"
 *   kata_di_halaman   : {jenis?, salah_satu:[]} kata muncul di halaman jenis itu
 *
 * Tiap kondisi boleh digabung: semuanya harus benar (DAN). Untuk "salah satu
 * dari", pakai daftar di dalam kata_di_halaman.
 */

const ATURAN = require('../data/konsistensiAntarData.json');
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { isLembarGrouper } = require('./lembarGrouperService');

function teksNormal(v) {
  return String(v === null || v === undefined ? '' : v).toLowerCase();
}

/** Kolom dianggap terisi kalau bukan kosong, bukan 0, dan bukan penanda kosong. */
function terisi(nilai) {
  const t = String(nilai === null || nilai === undefined ? '' : nilai).trim();
  if (!t) return false;
  if (/^(0|-|n\/a|null|undefined)$/i.test(t)) return false;
  return true;
}

function pisahKode(v) {
  return String(v || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

/**
 * Cocokkan kode diagnosis dengan awalan, menghormati kekhususan kode.
 * Aturan "J18" berlaku untuk J18 dan J18.9, tapi TIDAK untuk J180 (kode lain).
 */
function diagnosisCocok(daftar, awalan) {
  const a = teksNormal(awalan).replace(/\s/g, '');
  return pisahKode(daftar).some(k => {
    const kode = teksNormal(k).replace(/\s/g, '');
    return kode === a || (kode.startsWith(a) && kode[a.length] === '.');
  });
}

/** Halaman menurut jenisnya, dihitung sekali per klaim. */
function kelompokkanHalaman(halaman) {
  const peta = new Map();
  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text || hal.text);
    if (!teks) continue;
    const jenis = classifyPageDocumentType(teks);
    if (!peta.has(jenis)) peta.set(jenis, []);
    peta.get(jenis).push({ page_number: hal.page_number || null, teks });
  }
  return peta;
}

/**
 * Kutipan bukti = BARIS tempat kata itu ditemukan (ditambah baris berikutnya
 * kalau isinya bersambung, mis. "PPOK," lalu "Pneumonia"), dipotong di
 * batas kata. Sebelumnya teks dipotong persis 40 karakter sebelum dan 70
 * sesudah kata kunci, sehingga kata terbelah ("epala: ca -/-" dari "kepala",
 * "Rencana Ra" dari "Rawat jalan") dan kutipan melompati beberapa kolom.
 */
function kutipanBaris(teks, idx, maks = 160) {
  const t = String(teks || '');
  const awal = t.lastIndexOf('\n', Math.max(0, idx - 1)) + 1;
  let akhir = t.indexOf('\n', idx);
  if (akhir === -1) akhir = t.length;
  let baris = t.slice(awal, akhir).replace(/\s+/g, ' ').trim();
  // Digabung hanya kalau isinya jelas bersambung (diakhiri koma, mis. "PPOK,"
  // lalu "Pneumonia") atau barisnya nyaris kosong -- bukan "Cara Bayar : UMUM"
  // yang akan tertempel label kolom berikutnya.
  if ((/,$/.test(baris) || baris.length < 8) && akhir < t.length) {
    let akhir2 = t.indexOf('\n', akhir + 1);
    if (akhir2 === -1) akhir2 = t.length;
    baris = `${baris} ${t.slice(akhir + 1, akhir2).replace(/\s+/g, ' ').trim()}`.trim();
  }
  if (baris.length <= maks) return baris;
  // Baris sangat panjang (teks OCR tanpa pemisah baris): jendela di sekitar
  // kata kunci, dipotong di spasi supaya tidak ada kata terbelah.
  const posisi = Math.max(0, idx - awal);
  let mulai = Math.max(0, posisi - 50);
  let selesai = Math.min(baris.length, mulai + maks);
  if (mulai > 0) { const sp = baris.indexOf(' ', mulai); if (sp !== -1 && sp < posisi) mulai = sp + 1; }
  if (selesai < baris.length) { const sp = baris.lastIndexOf(' ', selesai); if (sp > posisi) selesai = sp; }
  return `${mulai > 0 ? '… ' : ''}${baris.slice(mulai, selesai).trim()}${selesai < baris.length ? ' …' : ''}`;
}

/**
 * Cari kata kunci, kembalikan buktinya (kutipan + halaman) supaya temuan bisa
 * dipertanggungjawabkan — bukan sekadar "ada" atau "tidak ada".
 */
function cariKata(petaHalaman, jenis, daftarKata) {
  const kandidat = jenis
    ? (petaHalaman.get(jenis) || [])
    : [...petaHalaman.values()].flat();

  for (const hal of kandidat) {
    const rendah = teksNormal(hal.teks);
    for (const kata of daftarKata || []) {
      const idx = rendah.indexOf(teksNormal(kata));
      if (idx === -1) continue;
      return {
        kata,
        page_number: hal.page_number,
        kutipan: kutipanBaris(hal.teks, idx),
      };
    }
  }
  return null;
}

// Catatan pemberian obat dapat berada pada lembar pelaksanaan keperawatan,
// bukan halaman resep. Nama obat dalam rencana atau tagihan saja tidak cukup.
// Bukti pemberian nebulisasi selain resep/catatan pelaksanaan:
//  - "Terapi/pengobatan selama di rumah sakit" pada resume (pernyataan DPJP
//    atas terapi yang DIBERIKAN), dan
//  - rincian biaya obat/alat nebulisasi (dispensing farmasi, "Masker Nebul").
// ARBY (BRPN anak): "(10) Lasalcom (ipratropium+salbu) NEBU" di resume dan
// "Nebulaizer 50,000 x7", "Masker Nebul ANAK" di tagihan -- dulu KD-01 tetap
// menyatakan obat belum terbaca dan klaim berisiko pending.
function cariNebulTerapiResumeAtauTagihan(petaHalaman, daftarObat) {
  const obat = (daftarObat || []).map(teksNormal);
  const adaObat = (line) => obat.some(o => o && teksNormal(line).includes(o));
  for (const hal of petaHalaman.get('resume_medis') || []) {
    if (isLembarGrouper(hal.teks)) continue;
    let diTerapi = false;
    for (const line of hal.teks.split(/\n/)) {
      if (/terapi\s*\/?\s*pengobatan\s+selama|terapi\s+selama\s+(?:di\s+)?(?:rumah\s+sakit|dirawat|perawatan)/i.test(line)) { diTerapi = true; continue; }
      if (diTerapi && /^\s*(?:reaksi\s+obat|diet|instruksi|keadaan\s+keluar|terapi\s+pulang|cara\s+keluar|prognosis)\b/i.test(line)) diTerapi = false;
      if (diTerapi && /\bnebu\w*/i.test(line) && adaObat(line)) return { kata: 'terapi_resume', page_number: hal.page_number, kutipan: line.trim() };
    }
  }
  for (const hal of petaHalaman.get('rincian_biaya') || []) {
    for (const line of hal.teks.split(/\n/)) {
      if ((/\bnebu\w*/i.test(line) && adaObat(line)) || /\bmasker\s+nebu\w*|\bnebul(?:izer|aizer|iser|isasi)\b/i.test(line)) {
        return { kata: 'rincian_biaya', page_number: hal.page_number, kutipan: line.trim() };
      }
    }
  }
  return null;
}

function cariObatNebulDilaksanakan(petaHalaman, daftarObat) {
  for (const hal of [...petaHalaman.values()].flat()) {
    if (isLembarGrouper(hal.teks)) continue;
    const lines = hal.teks.split(/\n/);
    let pelaksanaan = false;
    for (const line of lines) {
      if (/tindakan\s+keperawatan|catatan\s+pemberian\s+obat|pelaksanaan\s+(?:terapi|tindakan)/i.test(line)) pelaksanaan = true;
      if (/^\s*(?:rencana|intervensi|instruksi|order|resep)\b/i.test(line)
        && !/tindakan\s+keperawatan/i.test(line)) pelaksanaan = false;
      if (!/\bnebu(?:l\w*)?\b/i.test(line)) continue;
      if (/\b(?:rencana|direncanakan|disarankan|diusulkan|diresepkan|riwayat|akan|belum|tidak|ditunda|batal|stop|dihentikan)\b/i.test(line)) continue;
      const kata = (daftarObat || []).find(o => teksNormal(line).includes(teksNormal(o)));
      if (!kata) continue;
      const sudahDiberikan = /\b(?:diberikan|memberikan|dilakukan|melakukan|telah|sudah)\b/i.test(line);
      const dosisTercatat = /\d\s*(?::\s*\d|(?:mg|ml|cc|amp|respul)\b)/i.test(line);
      if (!sudahDiberikan && !(pelaksanaan && dosisTercatat)) continue;
      return { kata, page_number: hal.page_number, kutipan: line.trim() };
    }
  }
  return null;
}

/**
 * Nilai satu kondisi. Mengembalikan {benar, bukti} — buktinya dipakai untuk
 * menjelaskan temuan, bukan cuma menyimpulkannya.
 */
/**
 * Nilai kolom klaim tanpa peduli huruf besar/kecil. Record dari alur upload
 * dan Baca Ulang memakai nama kolom vClaim huruf besar (JENIS_KLAIM,
 * DISCHARGE_DATE, KELAS_RAWAT, ICU_INDIKATOR), sedangkan aturan ditulis dengan
 * nama kolom basis data huruf kecil. Tanpa ini KD-03, KD-04, dan KD-11 tidak
 * pernah menyala di alur sungguhan (hanya di tes yang memakai huruf kecil).
 */
const KOLOM_VCLAIM = { diagnosa_list: 'DIAGLIST', prosedur_list: 'PROCLIST' };
function nilaiKolom(record, field) {
  if (!record) return undefined;
  for (const k of [field, String(field).toUpperCase(), String(field).toLowerCase(), KOLOM_VCLAIM[field]]) {
    if (k && record[k] !== undefined && record[k] !== null && record[k] !== '') return record[k];
  }
  return record[field];
}

function cekKondisi(kond, konteks) {
  if (!kond) return { benar: true, bukti: null };
  const { record, petaHalaman, tindakan } = konteks;
  let bukti = null;

  if (Array.isArray(kond.field_terisi)) {
    for (const f of kond.field_terisi) if (!terisi(nilaiKolom(record, f))) return { benar: false, bukti };
  }
  if (Array.isArray(kond.field_kosong)) {
    for (const f of kond.field_kosong) if (terisi(nilaiKolom(record, f))) return { benar: false, bukti };
  }
  if (kond.field_cocok) {
    const { field, pola } = kond.field_cocok;
    if (!new RegExp(pola, 'i').test(String(nilaiKolom(record, field) ?? ''))) return { benar: false, bukti };
  }
  if (kond.kode_prosedur) {
    const ada = pisahKode(record.prosedur_list || record.PROCLIST)
      .some(k => teksNormal(k) === teksNormal(kond.kode_prosedur));
    if (!ada) return { benar: false, bukti };
  }
  if (kond.diagnosis_awalan) {
    if (!diagnosisCocok(record.diagnosa_list || record.DIAGLIST, kond.diagnosis_awalan)) {
      return { benar: false, bukti };
    }
  }
  if (kond.tindakan) {
    const t = (tindakan || []).find(x => x.id === kond.tindakan);
    if (!t) return { benar: false, bukti };
    bukti = t.bukti && t.bukti[0] ? { ...t.bukti[0] } : null;
  }
  if (kond.ada_halaman) {
    if (!(petaHalaman.get(kond.ada_halaman) || []).length) return { benar: false, bukti };
  }
  if (kond.kata_di_halaman) {
    const { jenis, salah_satu, atau_obat_nebul_dilaksanakan, atau_terapi_resume_atau_tagihan } = kond.kata_di_halaman;
    const temuan = cariKata(petaHalaman, jenis, salah_satu)
      || (atau_obat_nebul_dilaksanakan && cariObatNebulDilaksanakan(petaHalaman, atau_obat_nebul_dilaksanakan))
      || (atau_terapi_resume_atau_tagihan && cariNebulTerapiResumeAtauTagihan(petaHalaman, atau_obat_nebul_dilaksanakan || salah_satu));
    if (!temuan) return { benar: false, bukti };
    bukti = temuan;
  }

  return { benar: true, bukti };
}

/**
 * Jalankan seluruh aturan terhadap satu klaim.
 *
 * @param {Object} record baris klaim
 * @param {Array<{page_number:number, ocr_text:string}>} halaman
 * @param {Array} tindakan hasil bacaTemuanTindakan()
 * @returns {Array} temuan
 */
function evaluasiKonsistensi(record, halaman = [], tindakan = []) {
  if (!record) return [];
  const konteks = { record, petaHalaman: kelompokkanHalaman(halaman), tindakan };
  const temuan = [];

  for (const aturan of ATURAN.aturan || []) {
    if (aturan.aktif === false) continue;
    if (['KD-09','KD-12','KD-13','KD-15'].includes(aturan.id) && require('./usiaPasienService').resolveUsia(record).kelompok !== 'dewasa') continue;
    const jika = cekKondisi(aturan.jika, konteks);
    if (!jika.benar) continue; // aturan ini tidak berlaku untuk klaim ini

    const maka = cekKondisi(aturan.maka, konteks);
    if (maka.benar) continue; // pendukungnya ada — tidak ada temuan

    temuan.push({
      id: aturan.id,
      nama: aturan.nama,
      keparahan: aturan.keparahan || 'sedang',
      pesan: aturan.pesan,
      yang_ditemukan: jika.bukti,
      yang_dicari: aturan.yang_dicari || null,
      sumber_aturan: aturan.sumber_aturan || null,
      // Aturan yang belum ditelaah koder tampil sebagai catatan dan tidak ikut
      // dihitung sebagai peringatan — sama seperti syarat penunjang. Satu
      // dugaan tidak boleh terlihat seperti temuan yang sudah pasti.
      diverifikasi: aturan.diverifikasi === true,
    });
  }

  return temuan;
}

/** Kategori ICD-10 (3 karakter pertama) untuk perbandingan longgar antar kode. */
function kategoriIcd10(kode) {
  return teksNormal(kode).replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase();
}

/**
 * KD-14 — Diagnosis dari halaman penagihan (DIAGLIST) tidak cocok dengan
 * pembacaan independen atas resume medis.
 *
 * LATAR BELAKANG (ditemukan 2026-10-01, backtest DWI ARIYANI & NUR ASIAH):
 * DIAGLIST diisi dari halaman "Berkas Klaim Individual" (slip grouper
 * e-Klaim) -- halaman itu SENGAJA dikecualikan dari evidence pool
 * (gatherEvidencePool, claimFiles.js) supaya kode tidak "membuktikan dirinya
 * sendiri". Efek sampingnya: DIAGLIST tidak PERNAH dicocokkan silang dengan
 * resume medis sama sekali. Pada klaim NUR ASIAH, DIAGLIST tersimpan
 * "I51.7;I48", padahal resume medis (hal. 3) menulis "susp syok kardiogenik",
 * "dyspneu susp ec ALO", "hemiparese sinistra ec post snh" -- R57.0/J81.0/
 * I69.3, sama sekali kategori berbeda. Alasan pending BPJS sungguhan untuk
 * klaim itu justru soal diagnosis utama, bukan soal yang selama ini
 * ditangkap aplikasi (lab/radiologi tanpa hasil).
 *
 * PERBAIKANNYA BUKAN "percayai resume, timpa DIAGLIST" -- itu berisiko
 * mengubah billing tanpa dasar yang pasti benar juga. Perbaikannya: catat
 * KETIDAKCOCOKANNYA sebagai temuan untuk koder, dengan kutipan dari resume
 * sebagai bukti apa yang sebenarnya ditemukan (bukan dari halaman penagihan
 * itu sendiri -- jadi ini VERIFIKASI SILANG, bukan verifikasi diri sendiri).
 *
 * Longgar sengaja: hanya menyala kalau TIDAK ADA SATU PUN kategori (3
 * karakter) yang beririsan. Diagnosis sekunder yang berbeda itu wajar;
 * kecocokan sebagian (1 dari 3 kode, misalnya) dianggap cukup konsisten.
 * Kode dari suggested_codes yang disangkal (disangkal:true) atau belum
 * tervalidasi kamus (kamus_valid tidak true) tidak dihitung sebagai bukti --
 * kita tidak mau menandai "tidak cocok" berdasarkan bacaan yang sendiri
 * belum pasti benar.
 *
 * @param {Object} record berisi DIAGLIST/diagnosa_list
 * @param {Array} suggestedCodesDiagnosis aiReview.suggested_codes yang type==='diagnosis'
 * @returns {Array} 0 atau 1 temuan, bentuknya sama seperti evaluasiKonsistensi()
 */
function periksaSilangDiagnosisPrimer(record, suggestedCodesDiagnosis = []) {
  if (!record) return [];
  const diaglist = pisahKode(record.DIAGLIST || record.diagnosa_list);
  if (diaglist.length === 0) return []; // DIAGLIST kosong ditangani pemeriksaan lain

  const dariResume = (suggestedCodesDiagnosis || []).filter(
    (s) => s && s.kamus_valid === true && s.disangkal !== true && s.code,
  );
  // Tidak ada yang bisa dibandingkan -- bukan berarti cocok, cuma tidak ada
  // bukti independen sama sekali. Diam, jangan menuduh tanpa bahan.
  if (dariResume.length === 0) return [];

  const kategoriDiaglist = new Set(diaglist.map(kategoriIcd10));
  const kategoriResume = dariResume.map((s) => ({ kategori: kategoriIcd10(s.code), entry: s }));
  const adaIrisan = kategoriResume.some((r) => kategoriDiaglist.has(r.kategori));
  if (adaIrisan) return [];

  const contoh = dariResume.slice(0, 3);
  return [{
    id: 'KD-14',
    nama: 'Diagnosis penagihan tidak cocok dengan resume medis',
    keparahan: 'sedang',
    pesan: `DIAGLIST (${diaglist.join(';')}) tidak sekategori pun dengan diagnosis yang terbaca independen di resume medis (${contoh.map((c) => c.code).join(', ')}). Bukan berarti DIAGLIST salah -- resume bisa saja belum mencerminkan diagnosis final koder -- tapi perlu ditinjau.`,
    yang_ditemukan: contoh[0] && contoh[0].quotation
      ? { kutipan: contoh[0].quotation, page_number: contoh[0].page_number }
      : null,
    yang_dicari: `Konfirmasi DIAGLIST sesuai dengan temuan resume medis, atau catat alasan bila sengaja berbeda`,
    sumber_aturan: null,
    // Belum pernah ditelaah koder -- aturan baru, tampil sebagai catatan dulu.
    diverifikasi: false,
  }];
}

module.exports = {
  evaluasiKonsistensi,
  periksaSilangDiagnosisPrimer,
  cekKondisi,
  kelompokkanHalaman,
  diagnosisCocok,
  kategoriIcd10,
  terisi,
  kutipanBaris,
  nilaiKolom,
};
