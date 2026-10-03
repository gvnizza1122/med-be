/**
 * Lembar "Berkas Klaim Individual Pasien" -- hasil grouper E-Klaim yang
 * dikerjakan casemix. Permintaan klien 2 Okt 2026: lembar ini BUKAN bahan
 * bacaan AI. Ia dikeluarkan dari ekstraksi, OCR enhancement, dan bukti audit,
 * lalu isinya dibaca tanpa AI dan disimpan sebagai PEMBANDING hasil casemix
 * terhadap diagnosis/prosedur/INA-CBG yang disusun aplikasi sendiri.
 *
 * Sebelumnya lembar ini justru ditaruh paling depan di teks ekstraksi, sehingga
 * DIAGLIST/PROCLIST/INA-CBG/tarif klaim hanyalah salinan kerja koder (kasus
 * KHOIRIYAH, SEP 0170R0111225V003293).
 *
 * Deterministik, tanpa AI. Bekerja untuk teks pdf-parse (satu baris per baris
 * cetak) maupun mupdf/OCR (label dan nilai di baris terpisah) karena seluruh
 * spasi dirapatkan lebih dulu.
 */

function isLembarGrouper(teks) {
  const t = String(teks || '');
  return /berkas\s+klaim\s+individual/i.test(t) && /(hasil\s+grouping|ina-?\s?cbg)/i.test(t);
}

function rapat(teks) {
  return String(teks || '').replace(/\s+/g, ' ').trim();
}

/** Potongan teks di antara dua label (label akhir pertama yang ditemukan). */
function potong(t, awal, akhirList) {
  const m = new RegExp(`${awal}\\s*:?`, 'i').exec(t);
  if (!m) return '';
  const sisa = t.slice(m.index + m[0].length);
  let akhir = sisa.length;
  for (const a of akhirList) {
    const n = new RegExp(a, 'i').exec(sisa);
    if (n && n.index < akhir) akhir = n.index;
  }
  return sisa.slice(0, akhir).trim();
}

/** Daftar {kode, deskripsi} dari potongan teks, memakai pola kode tertentu. */
function daftarKode(potongan, pola) {
  if (!potongan || /^[-\s]*$/.test(potongan)) return [];
  const temuan = [...potongan.matchAll(pola)];
  return temuan.map((m, i) => {
    const mulai = m.index + m[0].length;
    const selesai = i + 1 < temuan.length ? temuan[i + 1].index : potongan.length;
    return { kode: m[1].toUpperCase(), deskripsi: potongan.slice(mulai, selesai).replace(/^[\s:-]+|[\s,;]+$/g, '') || null };
  });
}

function angkaRupiah(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Label lembar E-Klaim; nilai sebuah label berakhir tepat sebelum label berikutnya.
const LABEL = ['Kode Rumah Sakit', 'Kelas Rumah Sakit', 'Nama RS', 'Jenis Tarif', 'Nomor Peserta', 'Nomor SEP',
  'Nomor Rekam Medis', 'Tanggal Masuk', 'Umur Tahun', 'Tanggal Keluar', 'Umur Hari', 'Jenis Perawatan',
  'Tanggal Lahir', 'Cara Pulang', 'Jenis Kelamin', 'LOS', 'Kelas Perawatan', 'Berat Lahir', 'Diagnosa Utama'];
function nilai(t, label) {
  const lain = LABEL.filter(l => l !== label).map(l => l.replace(/ /g, '\\s+')).join('|');
  const m = new RegExp(`${label.replace(/ /g, '\\s+')}\\s*:\\s*(.*?)\\s*(?=(?:${lain})\\s*:|$)`, 'i').exec(t);
  return m && m[1] && m[1] !== '-' ? m[1].trim() : null;
}

/**
 * Baca isi lembar grouper. Mengembalikan null bila teks bukan lembar grouper
 * atau kode INA-CBG-nya tidak terbaca.
 */
function bacaLembarGrouper(teks, halaman = null) {
  if (!isLembarGrouper(teks)) return null;
  const t = rapat(teks);

  const ICD10 = /\b([A-Z]\d{2}(?:\.\d{1,2})?)\b/g;
  const ICD9 = /\b(\d{2}\.\d{1,2})\b/g;
  const diagnosisUtama = daftarKode(potong(t, 'Diagnosa Utama', ['Diagnosa Sekunder', 'Prosedur\\s*:']), ICD10);
  const diagnosisSekunder = daftarKode(potong(t, 'Diagnosa Sekunder', ['Prosedur\\s*:', 'ADL Sub Acute', 'Hasil Grouping']), ICD10);
  const prosedur = daftarKode(potong(t, 'Prosedur', ['ADL Sub Acute', 'ADL Chronic', 'Hasil Grouping']), ICD9);

  const ina = /INA-?\s?CBG\s*:\s*([A-Z]-\d-\d{2}-(?:0|I{1,3}|IV))\s+(.*?)\s+Rp\s*([\d.,]+)/i.exec(t);
  if (!ina) return null;
  // Hanya bagian "Hasil Grouping" -- di atasnya ada "ADL Sub Acute"/"ADL Chronic"
  // yang labelnya mirip tetapi bukan komponen tarif.
  const grouping = t.slice(Math.max(0, t.search(/Hasil Grouping/i)));
  const tarifGrup = (label) => {
    const m = new RegExp(`(?:^|\\s)${label}\\s*:\\s*(\\S+)\\s+(.*?)\\s*Rp\\s*([\\d.,]+)`, 'i').exec(grouping);
    if (!m) return null;
    const kode = m[1] === '-' ? null : m[1];
    const jumlah = angkaRupiah(m[3]);
    return kode || jumlah ? { kode, deskripsi: m[2] && m[2] !== '-' ? m[2].trim() : null, tarif: jumlah } : null;
  };
  const total = /Total Tarif\s*:\s*Rp\s*([\d.,]+)/i.exec(t);
  const versi = /E-Klaim\s+([\d.]+)/i.exec(t);

  return {
    sumber: 'lembar_grouper_eklaim',
    halaman,
    sep: (/Nomor SEP\s*:\s*(\S+)/i.exec(t) || [])[1] || null,
    jenis_perawatan: nilai(t, 'Jenis Perawatan'),
    kelas_perawatan: nilai(t, 'Kelas Perawatan'),
    tanggal_masuk: (/Tanggal Masuk\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(t) || [])[1] || null,
    tanggal_keluar: (/Tanggal Keluar\s*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(t) || [])[1] || null,
    los: (/LOS\s*:\s*(\d+)/i.exec(t) || [])[1] ? Number(/LOS\s*:\s*(\d+)/i.exec(t)[1]) : null,
    diagnosis: [
      ...diagnosisUtama.slice(0, 1).map(d => ({ ...d, peran: 'utama' })),
      ...diagnosisUtama.slice(1).concat(diagnosisSekunder).map(d => ({ ...d, peran: 'sekunder' })),
    ],
    prosedur,
    inacbg: { kode: ina[1].toUpperCase(), deskripsi: ina[2].trim() || null, tarif: angkaRupiah(ina[3]) },
    sub_acute: tarifGrup('Sub Acute'),
    chronic: tarifGrup('Chronic'),
    special_cmg: tarifGrup('Special CMG'),
    total_tarif: total ? angkaRupiah(total[1]) : null,
    versi_eklaim: versi ? versi[1] : null,
  };
}

/** Dari daftar halaman {page_num|page_number, text|ocr_text}, baca lembar grouper pertama. */
function cariLembarGrouper(halaman) {
  for (const h of halaman || []) {
    const teks = h && (h.text || h.ocr_text || h.text_full);
    if (!isLembarGrouper(teks)) continue;
    const hasil = bacaLembarGrouper(teks, h.page_num || h.page_number || null);
    if (hasil) return hasil;
  }
  return null;
}

module.exports = { isLembarGrouper, bacaLembarGrouper, cariLembarGrouper };
