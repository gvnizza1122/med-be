/**
 * Ketentuan Klaim per Diagnosis — Tipe 3: aturan kombinasi kode.
 *
 * Sumber: catatan revisi dokter (gabungan catatan casemix RS Lestari Raharja
 * + Berita Acara Kesepakatan Kemenkes-BPJS No. JP.02.03/3/2411/2018 &
 * 620/BA/1118). Data aturannya di src/data/ketentuanKlaimKombinasi.json.
 *
 * Tipe 3 dikerjakan lebih dulu karena evaluasinya HANYA membaca DIAGLIST yang
 * sudah ada -- tidak perlu membaca dokumen, nilai lab, atau kamus. Tipe 1
 * (syarat nilai penunjang) dan Tipe 2 (syarat tindakan) menyusul.
 *
 * Service ini MELAPORKAN, tidak memutuskan: penetapan kode tetap wewenang
 * koder. Aturan yang kodenya belum dipastikan koder (diverifikasi:false)
 * TIDAK dievaluasi sama sekali.
 */

const ketentuan = require('../data/ketentuanKlaimKombinasi.json');

/** Kode ICD dinormalisasi: huruf besar, tanpa spasi. Titik DIPERTAHANKAN karena membedakan J18 dari J18.0. */
function normalisasiKode(kode) {
  return String(kode || '').trim().toUpperCase().replace(/\s+/g, '');
}

function pecahDaftarKode(daftar) {
  if (Array.isArray(daftar)) return daftar.map(normalisasiKode).filter(Boolean);
  return String(daftar || '')
    .split(/[;,]/)
    .map(normalisasiKode)
    .filter(Boolean);
}

/**
 * Cari kode di daftar yang diawali salah satu pola.
 * Pencocokan prefiks: pola 'I63' kena 'I63' dan 'I63.0', tapi pola 'J18.0'
 * TIDAK kena 'J18' -- yang lebih spesifik tidak boleh tertarik oleh yang umum.
 */
function cariCocok(daftarKode, polaList) {
  const pola = (polaList || []).map(normalisasiKode);
  return daftarKode.filter(k => pola.some(p => p && k.startsWith(p)));
}

/**
 * Evaluasi seluruh aturan kombinasi terhadap satu DIAGLIST.
 * @param {string|string[]} diaglist - isi DIAGLIST (dipisah ';' atau ',')
 * @returns {{kode:string,nama:string,aksi:string,pesan:string,kode_terdampak:string[],kode_utama:string[],kode_gabungan:string|null,sumber:string,kutipan_sumber:string}[]}
 */
function evaluasiKombinasiKode(diaglist) {
  const kodeList = pecahDaftarKode(diaglist);
  if (kodeList.length < 2) return []; // aturan kombinasi butuh minimal dua kode

  const temuan = [];
  for (const aturan of ketentuan.aturan) {
    if (!aturan.diverifikasi) continue; // belum ditelaah koder -- jangan dipakai

    const utama = cariCocok(kodeList, aturan.kode_diagnosis);
    const pasangan = cariCocok(kodeList, aturan.kode_pasangan);
    if (utama.length === 0 || pasangan.length === 0) continue;

    // Kode yang sama tidak boleh dihitung sebagai utama sekaligus pasangan
    // (mis. aturan yang kode_diagnosis & kode_pasangan-nya beririsan).
    const pasanganBersih = pasangan.filter(k => !utama.includes(k));
    if (pasanganBersih.length === 0) continue;

    temuan.push({
      kode: aturan.kode,
      nama: aturan.nama,
      aksi: aturan.aksi,
      pesan: aturan.pesan,
      kode_utama: utama,
      kode_terdampak: pasanganBersih,
      kode_gabungan: aturan.kode_gabungan || null,
      sumber: aturan.sumber,
      kutipan_sumber: aturan.kutipan_sumber,
    });
  }
  return temuan;
}

/** Aturan yang sengaja belum aktif — dipakai halaman Aturan Validasi agar telaah koder tidak terlupakan. */
function aturanBelumTerverifikasi() {
  return ketentuan.aturan
    .filter(a => !a.diverifikasi)
    .map(a => ({ kode: a.kode, nama: a.nama, alasan: a.alasan_belum || 'Belum ditelaah koder.' }));
}

function ringkasKetentuan() {
  return {
    total: ketentuan.aturan.length,
    aktif: ketentuan.aturan.filter(a => a.diverifikasi).length,
    belum_terverifikasi: ketentuan.aturan.filter(a => !a.diverifikasi).length,
    ditunda: (ketentuan._belum_dimasukkan || []).length,
  };
}

module.exports = {
  evaluasiKombinasiKode,
  aturanBelumTerverifikasi,
  ringkasKetentuan,
  normalisasiKode,
  pecahDaftarKode,
};
