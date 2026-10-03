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
 * TIDAK terikat koneksi HTTP. Bila server dimulai ulang di tengah proses,
 * proses itu ditandai "terputus" agar petugas tahu harus mengunggah ulang.
 * Tabel dibuat lazy; bila DB tidak mengizinkan, status disimpan di memori.
 */
const { v4: uuidv4 } = require('uuid');

const SERVER_MULAI = new Date();
const DEFAULT_DETIK_PER_HALAMAN = 4;
const DEFAULT_DETIK_REVIEW = 150;
const DEFAULT_DETIK_SIMPAN = 10;
const BATAS_TERPUTUS_MENIT = 30;

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
        // Proses yang tertinggal dari server sebelumnya tidak akan pernah selesai.
        await db.run(`UPDATE proses_unggah SET status = 'terputus', pesan = ?, diperbarui = CURRENT_TIMESTAMP
          WHERE status IN ('antre', 'berjalan') AND dibuat < ?`,
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

async function buat(db, { batchId, hospitalCode, userId, fileName }) {
  const baris = { id: uuidv4(), batch_id: batchId || null, hospital_code: hospitalCode || null, user_id: userId || null,
    file_name: fileName, status: 'antre', tahap: 'antre', dibuat: new Date(), ditutup: false };
  if (await pastikanSkema(db)) {
    await db.run(`INSERT INTO proses_unggah (id, batch_id, hospital_code, user_id, file_name, status, tahap) VALUES (?, ?, ?, ?, ?, 'antre', 'antre')`,
      [baris.id, baris.batch_id, baris.hospital_code, baris.user_id, baris.file_name]);
  } else memori.set(baris.id, baris);
  return baris.id;
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
  let mulaiBaca = null; let mulaiReview = null;
  return async (tahap, info = {}) => {
    const sekarang = Date.now();
    const kolom = { tahap, tahap_mulai: new Date(sekarang) };
    if (tahap === 'membaca_berkas') { mulaiBaca = sekarang; kolom.status = 'berjalan'; kolom.mulai = new Date(sekarang); }
    if (tahap === 'menyimpan' && mulaiBaca) kolom.detik_baca = Math.round((sekarang - mulaiBaca) / 1000);
    if (tahap === 'review_ai') mulaiReview = sekarang;
    if (tahap === 'mengisi_kode' && mulaiReview) kolom.detik_review = Math.round((sekarang - mulaiReview) / 1000);
    if (info.jumlah_halaman) kolom.jumlah_halaman = info.jumlah_halaman;
    if (info.file_id) kolom.file_id = info.file_id;
    if (info.record_id) kolom.record_id = info.record_id;
    mulaiTahap = sekarang;
    await perbarui(db, id, kolom);
    return mulaiTahap;
  };
}

async function selesai(db, id, hasil) {
  const b = await ambil(db, id).catch(() => null);
  const kolom = { selesai: new Date() };
  if (hasil && hasil.success) Object.assign(kolom, { status: 'selesai', tahap: 'selesai', pesan: null, file_id: hasil.file_id || null, record_id: hasil.record_id || null });
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

/** Perkiraan sisa detik satu proses (berdasarkan tahap & waktu berjalan). */
function sisaDetik(b, kal, halamanDefault = 15) {
  const halaman = Number(b.jumlah_halaman) || halamanDefault;
  const baca = kal.detik_per_halaman * halaman;
  const lewatTahap = b.tahap_mulai ? (Date.now() - new Date(b.tahap_mulai).getTime()) / 1000 : 0;
  const sisa = {
    antre: baca + DEFAULT_DETIK_SIMPAN + kal.detik_review,
    membaca_berkas: Math.max(baca - lewatTahap, 5) + DEFAULT_DETIK_SIMPAN + kal.detik_review,
    menyimpan: DEFAULT_DETIK_SIMPAN + kal.detik_review,
    review_ai: Math.max(kal.detik_review - lewatTahap, 10),
    mengisi_kode: 5,
  }[b.tahap];
  return sisa == null ? 0 : Math.round(sisa);
}

/**
 * Proses aktif + yang baru selesai (belum ditutup, 24 jam terakhir) untuk RS
 * ini, lengkap dengan perkiraan sisa waktu. Proses "berjalan" tanpa kabar
 * > 30 menit dianggap terputus.
 */
async function daftar(db, { hospitalCode, batasParalel = 1 }) {
  let baris;
  if (await pastikanSkema(db)) {
    baris = await db.all(`SELECT * FROM proses_unggah WHERE (hospital_code = ?::text OR (?::text IS NULL AND hospital_code IS NULL))
      AND ditutup = FALSE AND dibuat > NOW() - INTERVAL '24 hours' ORDER BY dibuat ASC LIMIT 400`, [hospitalCode || null, hospitalCode || null]);
  } else {
    baris = [...memori.values()].filter(b => b.hospital_code === (hospitalCode || null) && !b.ditutup);
  }
  const kal = await kalibrasi(db);
  const basi = Date.now() - BATAS_TERPUTUS_MENIT * 60000;
  const aktif = baris.filter(b => ['antre', 'berjalan'].includes(b.status));
  const antre = aktif.filter(b => b.status === 'antre');
  const berjalan = aktif.filter(b => b.status === 'berjalan');
  const rataTotal = kal.detik_per_halaman * 15 + DEFAULT_DETIK_SIMPAN + kal.detik_review;
  const hasil = baris.map(b => {
    let status = b.status; let pesan = b.pesan;
    if (status === 'berjalan' && new Date(b.diperbarui).getTime() < basi) {
      status = 'terputus'; pesan = 'Tidak ada kabar dari proses lebih dari 30 menit. Periksa Riwayat Upload sebelum mengunggah ulang.';
    }
    let sisa = ['antre', 'berjalan'].includes(status) ? sisaDetik(b, kal) : 0;
    if (status === 'antre') {
      // Menunggu giliran: berkas di depannya diproses paralel sebanyak batasParalel.
      const posisi = antre.indexOf(b);
      const sisaBerjalan = berjalan.length ? Math.min(...berjalan.map(x => sisaDetik(x, kal))) : 0;
      const slotKosong = Math.max(0, batasParalel - berjalan.length);
      if (posisi >= slotKosong) sisa += sisaBerjalan + Math.floor((posisi - slotKosong) / Math.max(1, batasParalel)) * rataTotal;
    }
    const lewat = b.mulai ? Math.round((Date.now() - new Date(b.mulai).getTime()) / 1000) : 0;
    return {
      id: b.id, batch_id: b.batch_id, file_name: b.file_name, status, tahap: b.tahap, tahap_label: TAHAP[b.tahap] || b.tahap,
      jumlah_halaman: b.jumlah_halaman == null ? null : Number(b.jumlah_halaman), detik_berjalan: lewat, sisa_detik: sisa,
      persen: status === 'selesai' ? 100 : ['antre'].includes(status) ? 0 : Math.min(95, Math.round((lewat / Math.max(1, lewat + sisa)) * 100)),
      file_id: b.file_id || null, record_id: b.record_id || null, pesan: pesan || null, dibuat: b.dibuat, selesai: b.selesai || null,
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
  for (const id of ids) { const b = memori.get(id); if (b && !['antre', 'berjalan'].includes(b.status)) { b.ditutup = true; n++; } }
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

module.exports = { buat, perbarui, pencatat, selesai, daftar, tutup, kalibrasi, sisaDetik, buatAntrean, pastikanSkema, TAHAP, _memori: memori };
