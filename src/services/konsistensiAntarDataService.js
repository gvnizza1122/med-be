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
        kutipan: hal.teks.substring(Math.max(0, idx - 40), idx + 70).replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return null;
}

/**
 * Nilai satu kondisi. Mengembalikan {benar, bukti} — buktinya dipakai untuk
 * menjelaskan temuan, bukan cuma menyimpulkannya.
 */
function cekKondisi(kond, konteks) {
  if (!kond) return { benar: true, bukti: null };
  const { record, petaHalaman, tindakan } = konteks;
  let bukti = null;

  if (Array.isArray(kond.field_terisi)) {
    for (const f of kond.field_terisi) if (!terisi(record[f])) return { benar: false, bukti };
  }
  if (Array.isArray(kond.field_kosong)) {
    for (const f of kond.field_kosong) if (terisi(record[f])) return { benar: false, bukti };
  }
  if (kond.field_cocok) {
    const { field, pola } = kond.field_cocok;
    if (!new RegExp(pola, 'i').test(String(record[field] ?? ''))) return { benar: false, bukti };
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
    const { jenis, salah_satu } = kond.kata_di_halaman;
    const temuan = cariKata(petaHalaman, jenis, salah_satu);
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

module.exports = {
  evaluasiKonsistensi,
  cekKondisi,
  kelompokkanHalaman,
  diagnosisCocok,
  terisi,
};
