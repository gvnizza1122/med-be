/**
 * Periode klaim — dipakai untuk mengelompokkan Riwayat Upload, mengarsipkan
 * per periode, dan mencocokkan klaim dengan rekap pending BPJS (rekap datang
 * per bulan, sekitar tiga bulan setelah klaim dikirim).
 *
 * Periode WAJIB berasal dari periode pelayanan, BUKAN tanggal upload. Berkas
 * periode Agustus bisa saja baru diunggah September; kalau dikelompokkan
 * menurut tanggal unggah, kelompok "September" jadi campuran periode dan
 * rekap pending Agustus tidak bisa dicocokkan dengan rapi.
 *
 * Urutan sumber, dari yang paling dapat dipercaya:
 *   1. Nomor SEP   — digit ke-9..12 adalah MMYY, dicetak sistem BPJS sendiri
 *   2. Tanggal masuk — dari resume medis, dipakai kalau SEP tidak terbaca
 *   3. Tanggal unggah — pilihan terakhir, hasilnya ditandai belum pasti
 */

// 0170R011 0826 V003068
//          ^^^^ MMYY
const POSISI_MMYY = 8; // 0-indexed
const PANJANG_MMYY = 4;

/** Batas tahun yang masuk akal untuk klaim BPJS — menolak hasil parsing yang ngawur. */
const TAHUN_MIN = 2014; // JKN mulai berjalan
const TAHUN_MAKS = new Date().getFullYear() + 1;

function rakitPeriode(bulan, tahun) {
  if (!Number.isInteger(bulan) || bulan < 1 || bulan > 12) return null;
  if (!Number.isInteger(tahun) || tahun < TAHUN_MIN || tahun > TAHUN_MAKS) return null;
  return `${tahun}-${String(bulan).padStart(2, '0')}`;
}

/** Periode dari nomor SEP. null kalau SEP tidak berbentuk seperti mestinya. */
function periodeDariSep(sep) {
  const bersih = String(sep || '').trim().toUpperCase();
  if (bersih.length < POSISI_MMYY + PANJANG_MMYY) return null;
  const mmyy = bersih.substr(POSISI_MMYY, PANJANG_MMYY);
  if (!/^\d{4}$/.test(mmyy)) return null;
  const bulan = Number(mmyy.slice(0, 2));
  const tahun = 2000 + Number(mmyy.slice(2, 4));
  return rakitPeriode(bulan, tahun);
}

/** Periode dari tanggal. Menerima Date, ISO, dan dd/mm/yyyy yang dipakai berkas RS. */
function periodeDariTanggal(tanggal) {
  if (!tanggal) return null;
  if (tanggal instanceof Date && !isNaN(tanggal)) {
    return rakitPeriode(tanggal.getMonth() + 1, tanggal.getFullYear());
  }
  const teks = String(tanggal).trim();

  const dmy = teks.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return rakitPeriode(Number(dmy[2]), Number(dmy[3]));

  const iso = teks.match(/^(\d{4})-(\d{2})/);
  if (iso) return rakitPeriode(Number(iso[2]), Number(iso[1]));

  const d = new Date(teks);
  if (!isNaN(d)) return rakitPeriode(d.getMonth() + 1, d.getFullYear());
  return null;
}

/**
 * Tentukan periode sebuah klaim beserta ASAL-USULNYA.
 *
 * Sumbernya ikut dikembalikan, bukan cuma hasilnya: periode yang ditebak dari
 * tanggal unggah perlu bisa ditandai "belum pasti" di layar, alih-alih
 * diam-diam masuk ke bulan yang mungkin salah.
 *
 * @returns {{periode: string|null, sumber: 'sep'|'tgl_masuk'|'tgl_upload'|null}}
 */
function tentukanPeriode({ sep, admissionDate, createdAt } = {}) {
  const dariSep = periodeDariSep(sep);
  if (dariSep) return { periode: dariSep, sumber: 'sep' };

  const dariMasuk = periodeDariTanggal(admissionDate);
  if (dariMasuk) return { periode: dariMasuk, sumber: 'tgl_masuk' };

  const dariUpload = periodeDariTanggal(createdAt);
  if (dariUpload) return { periode: dariUpload, sumber: 'tgl_upload' };

  return { periode: null, sumber: null };
}

/** Label untuk layar: '2026-08' -> 'Agustus 2026'. */
const NAMA_BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
function labelPeriode(periode) {
  const m = String(periode || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return 'Periode belum pasti';
  const bulan = Number(m[2]);
  if (bulan < 1 || bulan > 12) return 'Periode belum pasti';
  return `${NAMA_BULAN[bulan - 1]} ${m[1]}`;
}

/**
 * Isi periode untuk semua record sebuah berkas.
 *
 * Dipanggil sekali setelah record tersimpan, bukan ditempel di tiap INSERT:
 * ada lima jalur yang menulis claim_records (unggah Excel, unggah PDF, worker
 * PDF, bridging SIMRS, ingestion SIMRS), dan menaruh logikanya di satu tempat
 * berarti jalur keenam nanti tidak diam-diam kehilangan periode.
 *
 * Hanya mengisi yang masih kosong, jadi aman dipanggil berulang kali.
 */
async function isiPeriodeUntukFile(db, fileId) {
  const rows = await db.prepare(
    'SELECT id, sep, admission_date, created_at FROM claim_records WHERE file_id = ? AND periode IS NULL'
  ).all(fileId);
  return simpanPeriode(db, rows);
}

/** Inti penulisan, dipakai isiPeriodeUntukFile() maupun skrip backfill. */
async function simpanPeriode(db, rows) {
  const hitung = { sep: 0, tgl_masuk: 0, tgl_upload: 0, gagal: 0 };
  for (const row of rows) {
    const { periode, sumber } = tentukanPeriode({
      sep: row.sep,
      admissionDate: row.admission_date,
      createdAt: row.created_at,
    });
    if (!periode) { hitung.gagal++; continue; }
    await db.prepare(
      'UPDATE claim_records SET periode = ?, sumber_periode = ? WHERE id = ?'
    ).run(periode, sumber, row.id);
    hitung[sumber]++;
  }
  return hitung;
}

module.exports = {
  tentukanPeriode,
  isiPeriodeUntukFile,
  simpanPeriode,
  periodeDariSep,
  periodeDariTanggal,
  labelPeriode,
};
