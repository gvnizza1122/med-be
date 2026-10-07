/**
 * Status proses unggah PDF yang TERSIMPAN di server -- refresh halaman, pindah
 * halaman, atau menutup tab tidak memengaruhi pembacaan berkas.
 *
 * Alur: berkas diterima -> antre -> membaca berkas (OCR & ekstraksi) ->
 * menyimpan -> review AI (Agen Casemix, Luna, Sol) -> mengisi kode -> selesai.
 * Setiap perubahan tahap dicatat (tabel proses_unggah) bersama perkiraan
 * waktunya. Perkiraan dihitung dari unggahan yang sudah selesai: detik per
 * halaman untuk membaca berkas + lama review AI (median), dengan nilai awal
 * bila riwayat belum cukup.
 *
 * Proses berjalan di latar belakang server (antrean dengan batas paralel),
 * TIDAK terikat koneksi HTTP. Setelah server dimulai ulang, proses bermuatan
 * dilanjutkan; proses versi lama tanpa muatan ditandai "terputus".
 * Tabel dibuat lazy; bila DB tidak mengizinkan, status disimpan di memori.
 */
const { v4: uuidv4 } = require('uuid');

const SERVER_MULAI = new Date();
const DEFAULT_DETIK_PER_HALAMAN = 4;
const DEFAULT_DETIK_REVIEW = 150;
const DEFAULT_DETIK_SIMPAN = 10;

const TAHAP = {
  antre: 'Menunggu giliran',
  membaca_berkas: 'Membaca berkas (OCR & ekstraksi)',
  menyimpan: 'Menyimpan data klaim',
  review_ai: 'Review AI & Agen Casemix',
  mengisi_kode: 'Mengisi kode & INA-CBG',
  selesai: 'Selesai',
};

const memori = new Map(); // fallback bila tabel tidak tersedia
let skema = null; // Promise<boolean>

async function pastikanSkema(db) {
  if (!skema) {
    skema = (async () => {
      try {
        await db.query(`
          CREATE TABLE IF NOT EXISTS proses_unggah (
            id TEXT PRIMARY KEY,
            batch_id TEXT,
            hospital_code TEXT,
            user_id TEXT,
            file_name TEXT NOT NULL,
            status TEXT NOT NULL,
            tahap TEXT NOT NULL,
            jumlah_halaman INTEGER,
            urutan_file INTEGER,
            dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            mulai TIMESTAMP,
            tahap_mulai TIMESTAMP,
            selesai TIMESTAMP,
            detik_baca NUMERIC,
            detik_review NUMERIC,
            file_id TEXT,
            record_id TEXT,
            pesan TEXT,
            ditutup BOOLEAN NOT NULL DEFAULT FALSE,
            diperbarui TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_proses_unggah_rs ON proses_unggah(hospital_code, dibuat DESC);`);
        // Muatan (lokasi berkas & parameter) supaya proses bisa dilanjutkan
        // otomatis setelah server dimulai ulang.
        try { await db.query('ALTER TABLE proses_unggah ADD COLUMN IF NOT EXISTS muatan TEXT'); } catch (_) { /* tanpa lanjut otomatis */ }
        await db.query('ALTER TABLE proses_unggah ADD COLUMN IF NOT EXISTS urutan_file INTEGER');
        // Proses tertinggal TANPA muatan (dibuat versi lama) tidak bisa
        // dilanjutkan; yang bermuatan dilanjutkan oleh lanjutkanTerputus().
        await db.run(`UPDATE proses_unggah SET status = 'terputus', pesan = ?, diperbarui = CURRENT_TIMESTAMP
          WHERE status IN ('antre', 'berjalan') AND dibuat < ? AND muatan IS NULL`,
        ['Server dimulai ulang saat berkas diproses. Periksa Riwayat Upload; bila berkas belum lengkap, unggah ulang.', SERVER_MULAI]);
        return true;
      } catch (e) {
        console.warn('[ProsesUnggah] tabel tidak tersedia, status disimpan di memori:', e.message);
        return false;
      }
    })();
  }
  return skema;
}

async function buat(db, { batchId, hospitalCode, userId, fileName, urutanFile = null }) {
  const baris = { id: uuidv4(), batch_id: batchId || null, hospital_code: hospitalCode || null, user_id: userId || null,
    file_name: fileName, urutan_file: urutanFile, status: 'antre', tahap: 'antre', dibuat: new Date(), ditutup: false };
  if (await pastikanSkema(db)) {
    await db.run(`INSERT INTO proses_unggah (id, batch_id, hospital_code, user_id, file_name, urutan_file, status, tahap) VALUES (?, ?, ?, ?, ?, ?, 'antre', 'antre')`,
      [baris.id, baris.batch_id, baris.hospital_code, baris.user_id, baris.file_name, baris.urutan_file]);
  } else memori.set(baris.id, baris);
  return baris.id;
}

/** Semua berkas dan muatan pemulihannya harus tersimpan sebelum antrean dimulai. */
async function buatBatch(db, { batchId, hospitalCode, userId, files, allowedJenisKlaim }) {
  if (!(await pastikanSkema(db))) {
    const error = new Error('Status antrean belum dapat disimpan. Berkas belum diterima; silakan coba lagi.');
    error.code = 'ANTREAN_TIDAK_TERSEDIA';
    throw error;
  }
  const baris = files.map((file, urutanFile) => ({
    id: uuidv4(), batch_id: batchId, hospital_code: hospitalCode || null, user_id: userId || null,
    file_name: file.originalname, urutan_file: urutanFile, status: 'antre', tahap: 'antre',
    tahap_label: TAHAP.antre, jumlah_halaman: null, persen: 0, sisa_detik: null,
    file_id: null, record_id: null, pesan: null,
    muatan: { filePath: file.path, originalName: file.originalname, allowedJenisKlaim, userId, hospitalCode,
      fileId:uuidv4(),recordId:uuidv4() },
  }));
  await db.transaction(async tx => {
    for (const b of baris) {
      await tx.run(`INSERT INTO proses_unggah
        (id, batch_id, hospital_code, user_id, file_name, urutan_file, status, tahap, muatan)
        VALUES (?, ?, ?, ?, ?, ?, 'antre', 'antre', ?)`,
      [b.id, b.batch_id, b.hospital_code, b.user_id, b.file_name, b.urutan_file, JSON.stringify(b.muatan)]);
    }
  });
  return baris;
}

/** Perbarui kolom proses. Tidak pernah melempar (status hanya pelengkap). */
async function perbarui(db, id, kolom) {
  try {
    if (await pastikanSkema(db)) {
      const kunci = Object.keys(kolom);
      if (!kunci.length) return;
      await db.run(`UPDATE proses_unggah SET ${kunci.map(k => `${k} = ?`).join(', ')}, diperbarui = CURRENT_TIMESTAMP WHERE id = ?`,
        [...kunci.map(k => kolom[k]), id]);
    } else {
      const b = memori.get(id);
      if (b) Object.assign(b, kolom, { diperbarui: new Date() });
    }
  } catch (e) {
    console.warn('[ProsesUnggah] gagal memperbarui status:', e.message);
  }
}

async function ambil(db, id) {
  if (await pastikanSkema(db)) return db.get('SELECT * FROM proses_unggah WHERE id = ?', [id]);
  return memori.get(id) || null;
}

/**
 * Pencatat tahap untuk satu proses -- diteruskan ke pipeline unggah sebagai
 * onTahap(tahap, info). Menghitung durasi baca & review untuk kalibrasi.
 */
function pencatat(db, id) {
  let mulaiTahap = Date.now();
  let tahapSebelumnya = null; let mulaiProses = null;
  let mulaiBaca = null; let mulaiReview = null;
  return async (tahap, info = {}) => {
    const sekarang = Date.now();
    const berubah = tahap !== tahapSebelumnya;
    const kolom = { tahap };
    if (berubah) kolom.tahap_mulai = new Date(sekarang);
    if (tahap === 'membaca_berkas' && berubah) {
      mulaiBaca = sekarang; kolom.status = 'berjalan';
      if (!mulaiProses) { mulaiProses = sekarang; kolom.mulai = new Date(sekarang); }
      kolom.pesan = null; kolom.detik_baca = null; kolom.detik_review = null;
    }
    if (tahap === 'menyimpan' && mulaiBaca) kolom.detik_baca = Math.round((sekarang - mulaiBaca) / 1000);
    if (tahap === 'review_ai' && berubah) mulaiReview = sekarang;
    if (tahap === 'mengisi_kode' && mulaiReview) kolom.detik_review = Math.round((sekarang - mulaiReview) / 1000);
    if (info.jumlah_halaman) kolom.jumlah_halaman = info.jumlah_halaman;
    if (info.file_id) kolom.file_id = info.file_id;
    if (info.record_id) kolom.record_id = info.record_id;
    if (info.pesan) kolom.pesan = info.pesan;
    if (berubah) mulaiTahap = sekarang;
    tahapSebelumnya = tahap;
    await perbarui(db, id, kolom);
    return mulaiTahap;
  };
}

function statusHasil(hasil) {
  if (!hasil?.success) return 'gagal';
  return hasil.analysis_status && hasil.analysis_status !== 'lengkap' ? 'perlu_dicek' : 'selesai';
}

async function selesai(db, id, hasil) {
  const b = await ambil(db, id).catch(() => null);
  const kolom = { selesai: new Date() };
  if (hasil && hasil.success) Object.assign(kolom, { status: statusHasil(hasil), tahap: 'selesai',
    pesan: statusHasil(hasil) === 'perlu_dicek' ? hasil.analysis_warning || 'Berkas tersimpan; lihat tahap dan bukti yang perlu ditinjau pada hasil analisis.' : null,
    file_id: hasil.file_id || null, record_id: hasil.record_id || null });
  else Object.assign(kolom, { status: 'gagal', pesan: String((hasil && hasil.error) || 'Berkas gagal diproses.').slice(0, 500) });
  // Review yang belum tercatat (mis. tanpa tahap mengisi_kode) dihitung sampai selesai.
  if (b && b.tahap === 'review_ai' && b.tahap_mulai && b.detik_review == null) kolom.detik_review = Math.round((Date.now() - new Date(b.tahap_mulai).getTime()) / 1000);
  await perbarui(db, id, kolom);
}

function median(arr) {
  const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Kalibrasi dari 50 unggahan selesai terakhir. */
async function kalibrasi(db) {
  let baris = [];
  if (await pastikanSkema(db)) {
    baris = await db.all(`SELECT jumlah_halaman, detik_baca, detik_review FROM proses_unggah
      WHERE status = 'selesai' AND detik_baca IS NOT NULL ORDER BY selesai DESC LIMIT 50`, []).catch(() => []);
  } else baris = [...memori.values()].filter(b => b.status === 'selesai' && b.detik_baca != null);
  const perHalaman = median(baris.filter(b => Number(b.jumlah_halaman) > 0).map(b => Number(b.detik_baca) / Number(b.jumlah_halaman)));
  const review = median(baris.map(b => Number(b.detik_review)).filter(x => x > 0));
  return {
    detik_per_halaman: perHalaman != null ? Math.max(1, perHalaman) : DEFAULT_DETIK_PER_HALAMAN,
    detik_review: review != null ? review : DEFAULT_DETIK_REVIEW,
    sampel: baris.length,
  };
}

/** Waktu estimasi per tahap; bukan persentase halaman yang benar-benar terbaca. */
function durasiTahap(b, kal, halamanDefault = 15) {
  const halaman = Math.max(1, Number(b.jumlah_halaman) || halamanDefault);
  return { membaca_berkas: kal.detik_per_halaman * halaman, menyimpan: DEFAULT_DETIK_SIMPAN,
    review_ai: kal.detik_review, mengisi_kode: 5 };
}

function lewatDetik(tanggal, sekarang = Date.now()) {
  const waktu = tanggal ? new Date(tanggal).getTime() : NaN;
  return Number.isFinite(waktu) ? Math.max(0, (sekarang - waktu) / 1000) : 0;
}

/** null = durasi tahap terlewati; jangan menjanjikan sisa 5/10 detik terus-menerus. */
function sisaDetik(b, kal, halamanDefault = 15, sekarang = Date.now()) {
  if (['selesai', 'perlu_dicek', 'gagal', 'terputus'].includes(b.status)) return 0;
  const durasi = durasiTahap(b, kal, halamanDefault);
  const urutan = Object.keys(durasi);
  const index = urutan.indexOf(b.tahap);
  if (b.tahap === 'antre') return Math.ceil(Object.values(durasi).reduce((a, x) => a + x, 0));
  if (index < 0) return null;
  const lewat = lewatDetik(b.tahap_mulai, sekarang);
  if (lewat >= durasi[b.tahap]) return null;
  return Math.ceil(durasi[b.tahap] - lewat + urutan.slice(index + 1).reduce((n, t) => n + durasi[t], 0));
}

/** Progres estimasi memakai batas tahap agar perpindahan tahap tidak membuatnya mundur. */
function persenTahap(b, kal, sekarang = Date.now()) {
  if (['selesai', 'perlu_dicek', 'gagal', 'terputus'].includes(b.status)) return 100;
  if (b.status === 'antre' || b.tahap === 'antre') return 0;
  const rentang = { membaca_berkas: [1, 55], menyimpan: [55, 60], review_ai: [60, 95], mengisi_kode: [95, 99] };
  const batas = rentang[b.tahap];
  if (!batas) return 0;
  const lama = durasiTahap(b, kal)[b.tahap];
  const bagian = Math.min(0.95, lewatDetik(b.tahap_mulai, sekarang) / Math.max(1, lama));
  return Math.min(99, Math.floor(batas[0] + (batas[1] - batas[0]) * bagian));
}

/** Simulasi waktu selesai di setiap slot, termasuk antrean RS lain pada worker bersama. */
function estimasiAntrean(baris, kal, batasParalel = 1, sekarang = Date.now()) {
  const aktif = baris.filter(b => ['antre', 'berjalan'].includes(b.status));
  const jalan = aktif.filter(b => b.status === 'berjalan');
  const slot = Array.from({ length: Math.max(1, Number(batasParalel) || 1, jalan.length) }, () => 0);
  const hasil = new Map();
  jalan.forEach((b, i) => {
    const sisa = sisaDetik(b, kal, 15, sekarang);
    slot[i] = sisa == null ? Infinity : sisa;
    hasil.set(b.id, sisa);
  });
  for (const b of aktif.filter(x => x.status === 'antre')) {
    const tercepat = Math.min(...slot);
    const index = slot.indexOf(tercepat);
    const lama = sisaDetik(b, kal, 15, sekarang);
    slot[index] = tercepat + (lama == null ? Infinity : lama);
    hasil.set(b.id, Number.isFinite(slot[index]) ? Math.ceil(slot[index]) : null);
  }
  return hasil;
}

/** Semua proses aktif dipertahankan, termasuk yang dibuat >24 jam lalu. */
async function daftar(db, { hospitalCode, batasParalel = 1 }) {
  let baris;
  if (await pastikanSkema(db)) {
    // Ambil antrean global untuk ETA; respons tetap dibatasi RS peminta.
    baris = await db.all(`SELECT * FROM proses_unggah WHERE ditutup = FALSE
      AND (status IN ('antre', 'berjalan') OR dibuat > NOW() - INTERVAL '24 hours')
      ORDER BY dibuat ASC, batch_id ASC, urutan_file ASC NULLS LAST, id ASC`, []);
  } else {
    baris = [...memori.values()].filter(b => !b.ditutup &&
      (['antre', 'berjalan'].includes(b.status) || lewatDetik(b.dibuat) < 86400));
  }
  const sekarang = Date.now();
  const kal = await kalibrasi(db);
  const estimasi = estimasiAntrean(baris, kal, batasParalel, sekarang);
  const hasil = baris.filter(b => b.hospital_code === (hospitalCode || null)).map(b => {
    const aktif = ['antre', 'berjalan'].includes(b.status);
    const sisa = aktif ? estimasi.get(b.id) ?? null : 0;
    return {
      id: b.id, batch_id: b.batch_id, urutan_file: b.urutan_file == null ? null : Number(b.urutan_file),
      file_name: b.file_name, status: b.status, tahap: b.tahap, tahap_label: TAHAP[b.tahap] || b.tahap,
      jumlah_halaman: b.jumlah_halaman == null ? null : Number(b.jumlah_halaman),
      detik_berjalan: Math.round(lewatDetik(b.mulai, sekarang)), sisa_detik: sisa,
      estimasi_status: !aktif ? 'selesai' : sisa == null ? 'melampaui_perkiraan' : kal.sampel < 5 ? 'awal' : 'berdasarkan_riwayat',
      persen: persenTahap(b, kal, sekarang), persen_estimasi: aktif,
      file_id: b.file_id || null, record_id: b.record_id || null, pesan: b.pesan || null,
      dibuat: b.dibuat, selesai: b.selesai || null,
    };
  });
  return { proses: hasil, kalibrasi: kal };
}

async function tutup(db, { ids, hospitalCode }) {
  if (!ids || !ids.length) return 0;
  if (await pastikanSkema(db)) {
    const r = await db.run(`UPDATE proses_unggah SET ditutup = TRUE WHERE id IN (${ids.map(() => '?').join(',')})
      AND status NOT IN ('antre', 'berjalan') AND (hospital_code = ?::text OR (?::text IS NULL AND hospital_code IS NULL))`, [...ids, hospitalCode || null, hospitalCode || null]);
    return r && r.changes;
  }
  let n = 0;
  for (const id of ids) { const b = memori.get(id); if (b && b.hospital_code === (hospitalCode || null) && !['antre', 'berjalan'].includes(b.status)) { b.ditutup = true; n++; } }
  return n;
}

/** Antrean latar belakang dengan batas paralel; tidak terikat request HTTP. */
function buatAntrean(batasParalel) {
  const tunggu = [];
  let jalan = 0;
  const lanjut = () => {
    while (jalan < batasParalel && tunggu.length) {
      const { tugas, resolve } = tunggu.shift();
      jalan++;
      Promise.resolve().then(tugas).catch(e => console.error('[ProsesUnggah] tugas gagal:', e && e.message))
        .finally(() => { jalan--; resolve(); lanjut(); });
    }
  };
  return { tambah: tugas => new Promise(resolve => { tunggu.push({ tugas, resolve }); lanjut(); }), get berjalan() { return jalan; }, get menunggu() { return tunggu.length; } };
}

/**
 * Proses yang terhenti karena server dimulai ulang (status antre/berjalan,
 * dibuat sebelum server ini menyala) dan masih punya muatan. Statusnya
 * dikembalikan ke 'antre' dan file_id setengah jadi dicatat untuk dibersihkan.
 * @returns {Promise<Array<{id, file_id, muatan}>>}
 */
async function ambilUntukDilanjutkan(db) {
  if (!(await pastikanSkema(db))) return [];
  try {
    const baris = await db.all(`SELECT id, file_id, record_id, muatan FROM proses_unggah
      WHERE status IN ('antre', 'berjalan') AND dibuat < ? AND muatan IS NOT NULL ORDER BY dibuat`, [SERVER_MULAI]);
    const hasil = [];
    for (const b of baris) {
      let muatan = null;
      try { muatan = JSON.parse(b.muatan); } catch (_) { /* rusak */ }
      if (!muatan || !muatan.filePath) continue;
      await db.run(`UPDATE proses_unggah SET status = 'antre', tahap = 'antre',
        mulai = NULL, tahap_mulai = NULL, detik_baca = NULL, detik_review = NULL,
        pesan = 'Dilanjutkan otomatis setelah server dimulai ulang.', diperbarui = CURRENT_TIMESTAMP WHERE id = ?`, [b.id]);
      hasil.push({ id: b.id, file_id: b.file_id, record_id:b.record_id, muatan });
    }
    return hasil;
  } catch (e) {
    console.warn('[ProsesUnggah] gagal membaca proses untuk dilanjutkan:', e.message);
    return [];
  }
}

module.exports = { buat, buatBatch, perbarui, pencatat, selesai, statusHasil, daftar, tutup, kalibrasi, sisaDetik, persenTahap, estimasiAntrean, buatAntrean, pastikanSkema, ambilUntukDilanjutkan, TAHAP, _memori: memori };
