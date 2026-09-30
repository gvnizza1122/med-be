/**
 * Pasangan label <-> isi berdasarkan POSISI kata, bukan urutan baca.
 *
 * MASALAH YANG DISELESAIKAN
 * Pada resume medis IGD dari SIMRS (TCPDF), label sel diletakkan di TENGAH sel
 * secara vertikal, sedangkan isinya menempel di ATAS sel. Berkas
 * 0170R0110926V001943, halaman 2 (`pdftotext -bbox`, y = tepi atas kata):
 *
 *     Diagnosa    y=441.3
 *     Nebulisasi Ventasal (isi)   y=481.5   <- 8 pt DI ATAS labelnya
 *     Tindakan    y=489.6
 *     Rencana     y=513.6
 *
 * Urutan baca murni menghasilkan "Tindakan" tanpa isi, dan "Nebulisasi
 * Ventasal" menempel ke label "Penyebab Cedera". Di sini isi sebuah label
 * adalah kata-kata di KANAN label itu yang posisi vertikalnya berada antara
 * (atas label - toleransi) dan (atas label berikutnya). Isi boleh sedikit di
 * atas labelnya.
 *
 * Batasan yang disengaja:
 *   - Fungsi murni: tidak membaca berkas, tidak memanggil apa pun.
 *   - Hanya dipakai pada halaman resume (lihat bacaLabelHalaman). "Tindakan"
 *     kosong pada Risiko Jatuh dan "Tindakan Keperawatan" pada triase adalah
 *     hal lain dan tidak boleh ikut terbaca sebagai daftar tindakan.
 *   - Sumbu Y saja yang diandalkan untuk memisahkan baris; tata letak dua
 *     kolom label berdampingan pada satu baris TIDAK ditangani.
 */

const TOLERANSI_ATAS = 12; // isi boleh berada sekian pt di atas label
const TOLERANSI_X = 2; // isi harus mulai di kanan tepi label, sekian pt longgar
const TOLERANSI_BARIS = 3; // beda `top` di bawah ini = masih satu baris
const JARAK_MAKS_TANPA_BERIKUTNYA = 100; // label terakhir: batas bawah bila tak ada label berikutnya

const norm = (s) => String(s || '').toLowerCase().replace(/[:.,;]+$/g, '').trim();

/** Label yang dipakai pada halaman resume. Label lain hanya jadi jangkar batas. */
const LABEL_RESUME = [
  { label: 'Diagnosa' },
  { label: 'Penyebab Cedera' },
  // "Tindakan Keperawatan" adalah label lain (bagian triase), bukan daftar tindakan.
  { label: 'Tindakan', hindariDiikuti: ['keperawatan'] },
  { label: 'Rencana' },
];

/**
 * Semua kemunculan sebuah label (bisa lebih dari satu kata) sebagai kotak.
 * @returns {Array<{label:string,x0:number,x1:number,top:number,bottom:number,kata:Array}>}
 */
function cariLabel(words, label, { hindariDiikuti = [] } = {}) {
  const token = String(label).split(/\s+/).map(norm).filter(Boolean);
  if (!token.length || !Array.isArray(words)) return [];
  const hasil = [];
  for (const awal of words) {
    if (norm(awal.text) !== token[0]) continue;
    const rangkaian = [awal];
    let ok = true;
    for (let i = 1; i < token.length; i++) {
      const terakhir = rangkaian[rangkaian.length - 1];
      const calon = words
        .filter(w => Math.abs(w.top - awal.top) <= TOLERANSI_BARIS && w.x0 >= terakhir.x1 - 1 && norm(w.text) === token[i])
        .sort((a, b) => a.x0 - b.x0)[0];
      if (!calon) { ok = false; break; }
      rangkaian.push(calon);
    }
    if (!ok) continue;
    const akhir = rangkaian[rangkaian.length - 1];
    if (hindariDiikuti.length) {
      const lanjutan = words
        .filter(w => Math.abs(w.top - awal.top) <= TOLERANSI_BARIS && w.x0 >= akhir.x1 - 1)
        .sort((a, b) => a.x0 - b.x0)[0];
      // Hanya lanjutan yang menempel (jarak wajar) yang membuatnya label lain.
      if (lanjutan && lanjutan.x0 - akhir.x1 < 12 && hindariDiikuti.includes(norm(lanjutan.text))) continue;
    }
    hasil.push({
      label: String(label),
      x0: Math.min(...rangkaian.map(w => w.x0)),
      x1: akhir.x1,
      top: Math.min(...rangkaian.map(w => w.top)),
      bottom: Math.max(...rangkaian.map(w => w.bottom)),
      kata: rangkaian,
    });
  }
  return hasil;
}

/** Susun kata menjadi teks: baris dari atas ke bawah, kiri ke kanan dalam baris. */
function rakitTeks(kata) {
  const urut = [...kata].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const baris = [];
  for (const w of urut) {
    const b = baris[baris.length - 1];
    if (b && Math.abs(w.top - b.top) <= TOLERANSI_BARIS) b.kata.push(w);
    else baris.push({ top: w.top, kata: [w] });
  }
  return baris
    .map(b => b.kata.sort((a, c) => a.x0 - c.x0).map(w => w.text).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Batas bawah pita (band) vertikal sebuah label = atas label berikutnya. */
function batasBawah(kotak, semua) {
  const berikut = semua
    .filter(o => o.top > kotak.top + TOLERANSI_BARIS)
    .sort((a, b) => a.top - b.top)[0];
  return berikut ? berikut.top : kotak.top + JARAK_MAKS_TANPA_BERIKUTNYA;
}

/**
 * Inti pemasangan: kata mana yang menjadi isi `sasaran`.
 *
 * Pita label O = [O.top - toleransiAtas, atas label berikutnya). Isi sel
 * bawah yang menempel di atas labelnya jatuh di pita DUA label sekaligus; kata
 * itu diserahkan ke label yang `top`-nya paling dekat, dan bila sama jauh ke
 * label yang lebih BAWAH (isi memang cenderung di atas label yang terpusat).
 */
function isiUntukLabel(words, sasaran, semua, opsi = {}) {
  const tolAtas = opsi.toleransiAtas ?? TOLERANSI_ATAS;
  const tolX = opsi.toleransiX ?? TOLERANSI_X;
  const punyaLabel = new Set();
  for (const o of semua) for (const k of o.kata || []) punyaLabel.add(k);

  const pita = semua.map(o => ({ o, bawah: batasBawah(o, semua) }));
  const hasil = [];
  for (const w of words) {
    if (punyaLabel.has(w)) continue;
    let pemilik = null;
    for (const { o, bawah } of pita) {
      if (!(w.x0 > o.x1 + tolX)) continue;
      if (!(w.top >= o.top - tolAtas && w.top < bawah)) continue;
      if (!pemilik) { pemilik = o; continue; }
      const dNow = Math.abs(w.top - o.top);
      const dPrev = Math.abs(w.top - pemilik.top);
      if (dNow < dPrev || (dNow === dPrev && o.top > pemilik.top)) pemilik = o;
    }
    if (pemilik === sasaran) hasil.push(w);
  }
  return hasil;
}

/**
 * Isi sebuah label, dengan label berikutnya sebagai batas bawah.
 *
 * @param {Array<{text,x0,x1,top,bottom}>} words kata satu halaman
 * @param {string|Object} label teks label atau kotaknya
 * @param {string|Object|null} labelBerikut teks/kotak label di bawahnya (batas bawah)
 * @param {{labelSebelum?: string|Object, toleransiAtas?:number, toleransiX?:number}} [opsi]
 *   labelSebelum: label di atasnya, supaya isi sel bawah yang menempel di atas
 *   labelnya tidak salah diambil.
 * @returns {{ditemukan:boolean, kata:string[], teks:string}}
 */
function ambilIsiLabel(words, label, labelBerikut, opsi = {}) {
  const kotak = (x) => {
    if (!x) return null;
    if (typeof x === 'object') return { ...x, kata: x.kata || [] };
    return cariLabel(words, x)[0] || null;
  };
  const sasaran = kotak(label);
  if (!sasaran) return { ditemukan: false, kata: [], teks: '' };
  const berikut = kotak(labelBerikut);
  const sebelum = kotak(opsi.labelSebelum);
  const semua = [sasaran, berikut, sebelum].filter(Boolean);
  const kata = isiUntukLabel(words, sasaran, semua, opsi);
  const urut = [...kata].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const teks = rakitTeks(urut);
  return { ditemukan: true, kata: teks ? teks.split(' ') : [], teks };
}

/**
 * Pasangkan banyak label sekaligus pada satu halaman.
 * @param {Array} words
 * @param {Array<{label:string, hindariDiikuti?:string[]}>} daftarLabel
 * @returns {Object<string,string>} label -> isi (label yang ada tapi kosong = '')
 */
function pasangkanSemuaLabel(words, daftarLabel, opsi = {}) {
  const semua = [];
  for (const d of daftarLabel) semua.push(...cariLabel(words, d.label, d));
  const keluar = {};
  for (const kotak of semua) {
    const kata = isiUntukLabel(words, kotak, semua, opsi);
    const teks = rakitTeks(kata);
    const lama = keluar[kotak.label];
    keluar[kotak.label] = lama !== undefined ? [lama, teks].filter(Boolean).join('; ') : teks;
  }
  return keluar;
}

/**
 * Pasangan label resume, HANYA untuk halaman resume medis.
 * @param {Array} words
 * @param {string} jenisHalaman hasil classifyPageDocumentType
 * @returns {Object<string,string>} {} bila bukan halaman resume atau kata kosong
 */
function bacaLabelHalaman(words, jenisHalaman) {
  if (jenisHalaman !== 'resume_medis') return {};
  if (!Array.isArray(words) || words.length === 0) return {};
  return pasangkanSemuaLabel(words, LABEL_RESUME);
}

module.exports = {
  ambilIsiLabel,
  pasangkanSemuaLabel,
  bacaLabelHalaman,
  cariLabel,
  rakitTeks,
  LABEL_RESUME,
  TOLERANSI_ATAS,
};
