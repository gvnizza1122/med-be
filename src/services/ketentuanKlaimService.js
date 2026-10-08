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
function evaluasiKombinasiKode(diaglist, opsi = {}) {
  const kodeList = pecahDaftarKode(diaglist);
  if (kodeList.length === 0) return [];
  // Prosedur hanya dinilai bila pemanggil memberikannya; aturan bersyarat
  // prosedur dilewati (bukan dianggap terpenuhi) bila daftar prosedur tidak ada.
  const pxList = opsi.px === undefined || opsi.px === null ? null : pecahDaftarKode(opsi.px);

  const temuan = [];
  for (const aturan of ketentuan.aturan) {
    if (!aturan.diverifikasi) continue; // belum ditelaah koder -- jangan dipakai
    if ((aturan.px_ada || aturan.px_tidak_ada) && !pxList) continue;
    if (aturan.px_ada && cariCocok(pxList, aturan.px_ada).length === 0) continue;
    if (aturan.px_tidak_ada && cariCocok(pxList, aturan.px_tidak_ada).length > 0) continue;

    // utama_saja: kode_diagnosis harus menjadi diagnosis utama (urutan pertama).
    const utama = cariCocok(aturan.utama_saja ? kodeList.slice(0, 1) : kodeList, aturan.kode_diagnosis);
    // pasangan '*' = diagnosis lain apa pun.
    if (utama.length === 0) continue;
    // kode_tidak_ada: kode pelengkap yang wajib ada (mis. Z37 pada persalinan) belum dikode.
    if (aturan.kode_tidak_ada && cariCocok(kodeList, aturan.kode_tidak_ada).length) continue;
    // minimal_dua_kode: dua subkode berbeda dari kelompok yang sama (mis. B20.0 + B20.1 -> B20.7).
    if (aturan.minimal_dua_kode) {
      const beda = [...new Set(utama)];
      if (beda.length < 2) continue;
      temuan.push(buatTemuan(aturan, beda.slice(0, 1), beda.slice(1)));
      continue;
    }
    if (!aturan.kode_pasangan && aturan.kode_tidak_ada) { temuan.push(buatTemuan(aturan, utama, [])); continue; }
    const pasangan = (aturan.kode_pasangan || []).includes('*') ? kodeList.filter(k => !utama.includes(k))
      : cariCocok(aturan.pasangan_sekunder_saja ? kodeList.slice(1) : kodeList, aturan.kode_pasangan)
        .filter(k => !cariCocok([k], aturan.kode_pasangan_kecuali).length);
    if (pasangan.length === 0) continue;

    // Kode yang sama tidak boleh dihitung sebagai utama sekaligus pasangan
    // (mis. aturan yang kode_diagnosis & kode_pasangan-nya beririsan).
    const pasanganBersih = pasangan.filter(k => !utama.includes(k));
    if (pasanganBersih.length === 0) continue;

    temuan.push(buatTemuan(aturan, utama, pasanganBersih));
  }
  return temuan;
}

function buatTemuan(aturan, utama, pasanganBersih) {
    return {
      kode: aturan.kode,
      nama: aturan.nama,
      aksi: aturan.aksi,
      pesan: aturan.pesan,
      kode_utama: utama,
      kode_terdampak: pasanganBersih,
      kode_gabungan: aturan.kode_gabungan || null,
      ...(aturan.kode_saran ? { kode_saran: aturan.kode_saran } : {}),
      // 'telaah' = perlu konteks klinis/dokumen; tidak diterapkan otomatis ke saran kode.
      keparahan: aturan.keparahan || (aturan.aksi === 'telaah' ? 'sedang' : 'tinggi'),
      sumber: aturan.sumber,
      kutipan_sumber: aturan.kutipan_sumber,
    };
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
