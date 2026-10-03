/**
 * Pencatat pola beda hasil aplikasi vs hasil casemix (lembar grouper E-Klaim).
 *
 * Setiap berkas yang membawa lembar grouper adalah "kunci jawaban" gratis:
 * perbedaannya menunjukkan aturan yang belum dimiliki aplikasi (dari situlah
 * aturan PA -> D21.3, SC -> 74.1, kelompok bedah dibuat). Pola dicatat per
 * berkas TANPA identitas pasien (hanya kode, jenis klaim, kategori beda),
 * lalu diringkas supaya tim tahu aturan mana yang paling perlu ditambah.
 */
const { createHash } = require('crypto');

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pola_beda_casemix (
      kunci CHAR(64) PRIMARY KEY,
      record_id TEXT NOT NULL,
      jenis_klaim VARCHAR(20),
      kategori TEXT NOT NULL,
      dx_aplikasi TEXT, dx_casemix TEXT,
      px_aplikasi TEXT, px_casemix TEXT,
      inacbg_aplikasi VARCHAR(20), inacbg_casemix VARCHAR(20),
      selisih_tarif NUMERIC,
      dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

let skemaSiap = null;
function pastikanSkema(db) {
  if (!skemaSiap) skemaSiap = Promise.resolve().then(() => ensureSchema(db)).catch(() => { skemaSiap = null; });
  return skemaSiap;
}

/**
 * Golongkan perbedaan. Urutan = dampak: diagnosis utama & INA-CBG paling
 * menentukan tarif; prosedur yang hanya ada di casemix berarti aturan
 * pembacaan tindakan kurang.
 * @param {object} cm hasil saranKodingService.bandingkanCasemix
 * @returns {string[]}
 */
function golongkanBeda(cm) {
  if (!cm) return [];
  const k = [];
  if (cm.diagnosis_utama && !cm.diagnosis_utama.cocok) k.push(cm.diagnosis_utama.sekategori ? 'subkode_diagnosis_utama' : 'diagnosis_utama');
  if (cm.diagnosis && cm.diagnosis.hanya_casemix && cm.diagnosis.hanya_casemix.length) k.push('diagnosis_sekunder_terlewat');
  if (cm.diagnosis && cm.diagnosis.hanya_ai && cm.diagnosis.hanya_ai.length) k.push('diagnosis_sekunder_berlebih');
  if (cm.prosedur && cm.prosedur.hanya_casemix && cm.prosedur.hanya_casemix.length) k.push('prosedur_terlewat');
  if (cm.inacbg && !cm.inacbg.cocok) {
    const dasar = kode => String(kode || '').replace(/-(?:I{1,3}|IV|0)$/, '');
    const ai = String(cm.inacbg.ai || '');
    k.push(!ai ? 'inacbg_kosong' : dasar(ai) === dasar(cm.inacbg.casemix) ? 'severity_beda' : 'kelompok_inacbg_beda');
  }
  return k;
}

/**
 * Catat (atau perbarui) pola beda satu berkas. Berkas yang sudah cocok
 * menghapus catatan lamanya -- pola itu sudah teratasi.
 */
async function catatPolaBeda(db, recordId, jenisKlaim, casemix) {
  if (!db || !recordId || !casemix) return null;
  await pastikanSkema(db);
  const kunci = createHash('sha256').update(String(recordId)).digest('hex');
  // Berkas yang cocok tetap dicatat (kategori 'cocok') sebagai penyebut akurasi.
  const beda = golongkanBeda(casemix);
  const kategori = beda.length ? beda : ['cocok'];
  const gabung = a => (Array.isArray(a) ? a.join(';') : null);
  const sekarang = casemix.casemix || {};
  await db.run(`INSERT INTO pola_beda_casemix (kunci, record_id, jenis_klaim, kategori, dx_aplikasi, dx_casemix, px_aplikasi, px_casemix, inacbg_aplikasi, inacbg_casemix, selisih_tarif)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (kunci) DO UPDATE SET kategori = EXCLUDED.kategori, dx_aplikasi = EXCLUDED.dx_aplikasi, dx_casemix = EXCLUDED.dx_casemix,
      px_aplikasi = EXCLUDED.px_aplikasi, px_casemix = EXCLUDED.px_casemix, inacbg_aplikasi = EXCLUDED.inacbg_aplikasi,
      inacbg_casemix = EXCLUDED.inacbg_casemix, selisih_tarif = EXCLUDED.selisih_tarif, dibuat = CURRENT_TIMESTAMP`, [
    kunci, String(recordId), jenisKlaim || null, kategori.join(';'),
    gabung([...(casemix.diagnosis?.sama || []), ...(casemix.diagnosis?.hanya_ai || [])]),
    gabung((sekarang.diagnosis || []).map(d => d.kode)),
    gabung([...(casemix.prosedur?.sama || []), ...(casemix.prosedur?.hanya_ai || [])]),
    gabung((sekarang.prosedur || []).map(p => p.kode)),
    casemix.inacbg?.ai || null, casemix.inacbg?.casemix || null,
    casemix.tarif?.selisih ?? null,
  ]);
  return { kategori: beda };
}

/** Ringkasan untuk tim: kategori beda terbanyak beserta contoh pasangan kode. */
async function ringkasPola(db, { batas = 20 } = {}) {
  await pastikanSkema(db);
  const semua = await db.all('SELECT * FROM pola_beda_casemix ORDER BY dibuat DESC LIMIT 1000', []);
  const baris = semua.filter(b => b.kategori !== 'cocok');
  const persen = n => (semua.length ? Math.round((n / semua.length) * 1000) / 10 : null);
  const ada = k => baris.filter(b => String(b.kategori).split(';').includes(k)).length;
  const akurasi = {
    berkas_dinilai: semua.length,
    semua_cocok_persen: persen(semua.length - baris.length),
    diagnosis_utama_cocok_persen: persen(semua.length - ada('diagnosis_utama') - ada('subkode_diagnosis_utama')),
    inacbg_cocok_persen: persen(semua.length - ada('severity_beda') - ada('kelompok_inacbg_beda') - ada('inacbg_kosong')),
    total_selisih_tarif: baris.reduce((n, b) => n + (Number(b.selisih_tarif) || 0), 0),
  };
  const perKategori = new Map();
  for (const b of baris) {
    for (const k of String(b.kategori).split(';').filter(Boolean)) {
      const isi = perKategori.get(k) || { kategori: k, jumlah: 0, contoh: [] };
      isi.jumlah += 1;
      if (isi.contoh.length < 5) {
        isi.contoh.push({ jenis_klaim: b.jenis_klaim, aplikasi: { dx: b.dx_aplikasi, px: b.px_aplikasi, inacbg: b.inacbg_aplikasi },
          casemix: { dx: b.dx_casemix, px: b.px_casemix, inacbg: b.inacbg_casemix }, selisih_tarif: b.selisih_tarif == null ? null : Number(b.selisih_tarif) });
      }
      perKategori.set(k, isi);
    }
  }
  let pola = [];
  try {
    pola = await db.all(`SELECT jenis, kunci, kode, COUNT(*) AS jumlah, MAX(teks) AS contoh FROM pola_casemix_contoh
      GROUP BY jenis, kunci, kode ORDER BY COUNT(*) DESC LIMIT 50`, []);
  } catch (_) { pola = []; }
  return { akurasi, total_berkas_beda: baris.length, kategori: [...perKategori.values()].sort((a, b) => b.jumlah - a.jumlah).slice(0, batas),
    pola_dipelajari: pola.map(p => ({ jenis: p.jenis, istilah: p.contoh, kode: p.kode, jumlah: Number(p.jumlah) })) };
}

module.exports = { ensureSchema, catatPolaBeda, ringkasPola, golongkanBeda };
