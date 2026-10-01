/**
 * Aturan koding per RS — tahap KODING, terpisah dari tahap BACA.
 *
 *   BACA   (temuanTindakanService)  : apa yang tertulis dikerjakan ke pasien.
 *                                     SELALU tercatat sebagai temuan, lengkap
 *                                     dengan kutipan tiap halaman, apa pun
 *                                     nasibnya di daftar prosedur.
 *   KODING (modul ini)              : temuan + aturan RS -> usulan daftar
 *                                     prosedur (PROCLIST).
 *
 * Kode kamus masih berstatus USULAN. Sampai pemilik produk mengizinkan
 * pengisian otomatis, usulan tidak boleh mengisi PROCLIST, termasuk bila ada
 * aturan RS lama yang menyatakan masuk. Temuan dan kandidat tetap disimpan.
 *
 * Yang TIDAK bisa dilakukan aturan, karena itu bukan wewenangnya:
 *   - mengarang kode: kode hanya dari `kode_usulan` kamus (USULAN, tidak
 *     terverifikasi). Tindakan tanpa kode pasti tidak pernah masuk.
 *   - memasukkan tindakan yang hanya tertulis di resep: resep = rencana.
 *
 * Kalau tabel belum ada / basis data gagal dibaca, usulan tetap tidak masuk.
 */

const KONDISI_SAH = ['selalu', 'rawat_jalan', 'rawat_inap', 'igd'];
const SUMBER_BOLEH_DIKODE = ['resume_medis', 'triase_igd'];

// id temuan yang tidak sama dengan id kamus_penunjang.
const ALIAS_ISTILAH = {
  injeksi_antibiotik: 'injeksi',
  injeksi_obat: 'injeksi',
};

/**
 * DDL. Dipanggil dari init.js SETELAH tabel kamus_penunjang dibuat.
 * kamus_penunjang.id bertipe TEXT (bukan UUID), jadi istilah_id juga TEXT.
 * rs_id berisi hospital_code (mis. '3371084').
 */
async function ensureSchema(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS aturan_koding_rs (
      id               SERIAL PRIMARY KEY,
      rs_id            TEXT NOT NULL,
      istilah_id       TEXT NOT NULL REFERENCES kamus_penunjang(id),
      masuk_proclist   BOOLEAN NOT NULL,
      kondisi          TEXT NOT NULL DEFAULT 'selalu'
                       CHECK (kondisi IN ('selalu','rawat_jalan','rawat_inap','igd')),
      diputuskan_oleh  TEXT,
      diputuskan_pada  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      catatan          TEXT,
      UNIQUE (rs_id, istilah_id, kondisi)
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_aturan_koding_rs ON aturan_koding_rs(rs_id, istilah_id)`);
}

/** Muat seluruh aturan sebuah RS: Map istilah_id -> [aturan]. Kosong bila gagal. */
async function muatAturan(db, rsId) {
  const peta = new Map();
  if (!db || !rsId) return peta;
  try {
    const baris = await db.all(
      `SELECT istilah_id, masuk_proclist, kondisi, diputuskan_oleh, diputuskan_pada, catatan
       FROM aturan_koding_rs WHERE rs_id = ?`,
      [String(rsId)],
    );
    for (const b of baris || []) {
      const daftar = peta.get(b.istilah_id) || [];
      daftar.push({
        istilah_id: b.istilah_id,
        masuk_proclist: b.masuk_proclist === true || b.masuk_proclist === 1 || b.masuk_proclist === 't',
        kondisi: b.kondisi || 'selalu',
        diputuskan_oleh: b.diputuskan_oleh || null,
        diputuskan_pada: b.diputuskan_pada || null,
        catatan: b.catatan || null,
      });
      peta.set(b.istilah_id, daftar);
    }
  } catch (err) {
    // Tabel belum dibuat atau basis data bermasalah: perilaku bawaan, bukan galat.
    console.warn(`[AturanKodingRs] aturan tidak terbaca, memakai perilaku bawaan: ${err.message}`);
    return new Map();
  }
  return peta;
}

/** Simpan/ubah satu aturan (upsert per rs_id + istilah_id + kondisi). */
async function simpanAturan(db, { rsId, istilahId, masukProclist, kondisi = 'selalu', diputuskanOleh = null, catatan = null }) {
  if (!rsId || !istilahId) throw new Error('rsId dan istilahId wajib diisi');
  if (!KONDISI_SAH.includes(kondisi)) throw new Error(`kondisi tidak sah: ${kondisi}`);
  if (typeof masukProclist !== 'boolean') throw new Error('masukProclist harus boolean');
  await db.run(
    `INSERT INTO aturan_koding_rs (rs_id, istilah_id, masuk_proclist, kondisi, diputuskan_oleh, diputuskan_pada, catatan)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT (rs_id, istilah_id, kondisi) DO UPDATE
       SET masuk_proclist = EXCLUDED.masuk_proclist,
           diputuskan_oleh = EXCLUDED.diputuskan_oleh,
           diputuskan_pada = CURRENT_TIMESTAMP,
           catatan = EXCLUDED.catatan`,
    [String(rsId), istilahId, masukProclist, kondisi, diputuskanOleh, catatan],
  );
}

/**
 * Pilih aturan yang berlaku untuk konteks klaim. Yang lebih khusus menang:
 * igd > rawat_jalan/rawat_inap > selalu. Kunjungan IGD dihitung RAWAT_JALAN
 * oleh aplikasi, jadi aturan 'rawat_jalan' juga berlaku untuknya.
 *
 * @param {Array} daftar aturan untuk satu istilah
 * @param {{jenisKlaim?: string, igd?: boolean}} konteks
 */
function pilihAturan(daftar, konteks = {}) {
  const jenis = String(konteks.jenisKlaim || '').toUpperCase();
  const berlaku = (daftar || []).filter(a => {
    if (a.kondisi === 'selalu') return true;
    if (a.kondisi === 'igd') return konteks.igd === true;
    if (a.kondisi === 'rawat_jalan') return jenis === 'RAWAT_JALAN';
    if (a.kondisi === 'rawat_inap') return jenis === 'RAWAT_INAP';
    return false;
  });
  const bobot = { igd: 3, rawat_jalan: 2, rawat_inap: 2, selalu: 1 };
  berlaku.sort((a, b) => bobot[b.kondisi] - bobot[a.kondisi]);
  return berlaku[0] || null;
}

/**
 * Tahap koding — fungsi murni. Setiap temuan menghasilkan SATU entri usulan,
 * termasuk yang tidak masuk PROCLIST (alasannya dicatat).
 *
 * @param {Array} temuan hasil bacaTemuanTindakan()
 * @param {Map<string, Array>} aturan hasil muatAturan(); Map kosong = tanpa aturan
 * @param {{jenisKlaim?: string, igd?: boolean}} [konteks]
 */
function susunUsulanProsedur(temuan, aturan, konteks = {}) {
  const peta = aturan instanceof Map ? aturan : new Map();
  return (temuan || []).filter(Boolean).map(t => {
    const bukti = t.bukti || [];
    const sumber = [...new Set(bukti.map(b => b.sumber))];
    const dasarTertulis = sumber.some(s => SUMBER_BOLEH_DIKODE.includes(s));
    const aturanRs = pilihAturan(peta.get(ALIAS_ISTILAH[t.id] || t.id), konteks);

    const entri = {
      id: t.id,
      nama: t.nama,
      kode_usulan: t.kode_usulan || null,
      kode_terverifikasi: false,
      sumber_bukti: sumber,
      halaman_bukti: [...new Set(bukti.map(b => b.page_number).filter(n => n !== null && n !== undefined))],
      aturan_rs: aturanRs
        ? { kondisi: aturanRs.kondisi, masuk_proclist: aturanRs.masuk_proclist, diputuskan_oleh: aturanRs.diputuskan_oleh, catatan: aturanRs.catatan }
        : null,
      belum_ada_aturan_rs: !aturanRs,
      masuk_proclist: false,
      alasan: '',
    };

    // Batas yang tidak bisa dilewati aturan apa pun.
    if (!t.kode_usulan) {
      entri.alasan = 'Kode belum pasti — tidak pernah ditebak, jadi tidak masuk daftar prosedur.';
    } else if (!dasarTertulis) {
      entri.alasan = 'Hanya tertulis di resep. Resep adalah rencana, bukan catatan tindakan dikerjakan.';
    } else if (aturanRs && aturanRs.masuk_proclist === false) {
      entri.alasan = `Kebijakan RS: tidak dikodekan (${aturanRs.kondisi}).${aturanRs.catatan ? ' ' + aturanRs.catatan : ''}`;
    } else {
      entri.masuk_proclist = false;
      entri.alasan = 'Kode ICD-9-CM masih berstatus usulan dan belum diizinkan untuk pengisian otomatis ke PROCLIST.';
    }
    return entri;
  });
}

/** Kode unik dari usulan yang masuk PROCLIST. */
function kodeProclistDariUsulan(usulan) {
  return [...new Set((usulan || []).filter(u => u.masuk_proclist && u.kode_usulan).map(u => String(u.kode_usulan).trim()))];
}

/**
 * hospital_code + jenis_klaim sebuah record. Kosong bila gagal dibaca.
 * IGD = ada halaman triase pada bukti temuan (kunjungan IGD selalu punya triase).
 */
async function ambilKonteksKlaim(db, recordId, temuan) {
  const konteks = { rsId: null, jenisKlaim: null, igd: false };
  konteks.igd = (temuan || []).some(t => (t.bukti || []).some(b => b.sumber === 'triase_igd'));
  try {
    const baris = await db.prepare(
      `SELECT cf.hospital_code AS hospital_code, cr.jenis_klaim AS jenis_klaim
       FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id WHERE cr.id = ?`,
    ).get(recordId);
    if (baris) {
      konteks.rsId = baris.hospital_code || null;
      konteks.jenisKlaim = baris.jenis_klaim || null;
    }
  } catch (err) {
    console.warn(`[AturanKodingRs] konteks klaim tidak terbaca: ${err.message}`);
  }
  return konteks;
}

/**
 * Satu pintu untuk claimFiles: temuan -> usulan + kode PROCLIST.
 * Tidak pernah melempar; tanpa aturan hasilnya sama dengan perilaku bawaan.
 */
async function tentukanProsedurDariTemuan(db, recordId, temuan) {
  const konteks = await ambilKonteksKlaim(db, recordId, temuan);
  const aturan = konteks.rsId ? await muatAturan(db, konteks.rsId) : new Map();
  const usulan = susunUsulanProsedur(temuan, aturan, konteks);
  return { usulan, kode: kodeProclistDariUsulan(usulan), konteks };
}

module.exports = {
  ensureSchema,
  muatAturan,
  simpanAturan,
  pilihAturan,
  susunUsulanProsedur,
  kodeProclistDariUsulan,
  ambilKonteksKlaim,
  tentukanProsedurDariTemuan,
  KONDISI_SAH,
};
