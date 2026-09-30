/**
 * Rule berversi ("Dua Model, Satu Aturan") — pengetahuan hidup di database,
 * bukan di model. Model hanya mengusulkan; MENGAKTIFKAN rule berubah adalah
 * satu-satunya langkah yang butuh persetujuan koder.
 *
 * SIFAT KEAMANAN
 *  1. Tanpa dasar tidak bisa disimpan: `sumber_kutipan` wajib berisi teks
 *     bermakna (bukan kosong/spasi). Dijaga DUA lapis: validasi kode di
 *     buatUsulan() DAN constraint DB (NOT NULL + CHECK length(btrim()) > 0).
 *  2. Alur status dijaga di kode dengan UPDATE bersyarat status (aman terhadap
 *     dua orang menekan tombol bersamaan):
 *        usulan -> diuji -> (aktif | dipantau) -> pensiun
 *        usulan/diuji -> ditolak
 *     setujui() HANYA dari 'diuji' (artinya sudah ada hasil uji yang bisa
 *     dilihat koder) dan mencatat siapa & kapan.
 *  3. Persetujuan koder hanya berlaku untuk pengaktifan RULE. Modul ini tidak
 *     punya gerbang untuk membaca klaim atau status pending.
 *  4. Klaim dinilai dengan rule yang berlaku pada TANGGAL PELAYANAN, bukan
 *     tanggal pengecekan (ruleBerlakuPada). Rule lama yang sudah pensiun tetap
 *     berlaku untuk rentang tanggalnya sendiri (untuk cek ulang klaim lama).
 *  5. Interval tumpang tindih diputuskan deterministik: berlaku_mulai terbaru
 *     menang, seri -> versi tertinggi. Interval berdekatan (sampai 30 Jun,
 *     mulai 1 Jul) tidak tumpang tindih. Berlaku_sampai INKLUSIF. Inilah cara
 *     INA-CBG dan INA-DRG berdampingan: dua versi dengan rentang tanggal
 *     berbeda pada rule_kode yang sama.
 *  6. setujui() menutup rule lama yang masih terbuka (berlaku_sampai = mulai
 *     baru - 1 hari); kembalikanKeVersiLama() membukanya lagi selama rule baru
 *     masih 'dipantau'. Rule yang di-rollback berstatus 'ditolak' (tidak
 *     berlaku untuk tanggal mana pun) dan alasan rollback dicatat di hasil_uji.
 *  7. ujiKeKlaimLama() murni: evaluator disuntikkan, tidak menyentuh DB/model.
 *
 * Tabel dibuat lewat ensureSchema(db) (belum dipasang di init.js).
 */

const STATUS = Object.freeze(['usulan', 'diuji', 'aktif', 'dipantau', 'pensiun', 'ditolak']);
const SUMBER_JENIS = Object.freeze(['pending_bpjs', 'regulasi', 'casemix_rs', 'ba_kesepakatan']);
const DIUSULKAN_OLEH = Object.freeze(['kimi', 'luna', 'manusia']);
// Status yang ikut menentukan "rule mana yang berlaku pada tanggal X".
const STATUS_BERLAKU = Object.freeze(['aktif', 'dipantau', 'pensiun']);

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rule_versi (
      rule_kode VARCHAR(20) NOT NULL,
      versi INTEGER NOT NULL,
      isi JSONB NOT NULL,
      berlaku_mulai DATE NOT NULL,
      berlaku_sampai DATE,
      status VARCHAR(12) NOT NULL DEFAULT 'usulan'
        CHECK (status IN ('usulan','diuji','aktif','dipantau','pensiun','ditolak')),
      sumber_jenis VARCHAR(20) NOT NULL
        CHECK (sumber_jenis IN ('pending_bpjs','regulasi','casemix_rs','ba_kesepakatan')),
      sumber_kutipan TEXT NOT NULL CHECK (length(btrim(sumber_kutipan)) > 0),
      diusulkan_oleh VARCHAR(10) NOT NULL
        CHECK (diusulkan_oleh IN ('kimi','luna','manusia')),
      hasil_uji JSONB,
      disetujui_oleh VARCHAR(80),
      disetujui_pada TIMESTAMP,
      dibuat_pada TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (rule_kode, versi),
      CHECK (berlaku_sampai IS NULL OR berlaku_sampai >= berlaku_mulai)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS idx_rule_versi_kode_status ON rule_versi(rule_kode, status)');
}

// ---------- tanggal ----------

function normTanggal(v) {
  if (v instanceof Date && !isNaN(v)) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const s = v.slice(0, 10);
    const d = new Date(`${s}T00:00:00Z`);
    if (!isNaN(d) && d.toISOString().slice(0, 10) === s) return s;
  }
  throw new Error(`Tanggal tidak valid: ${v}`);
}

function geserHari(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- validasi & pemilihan (murni) ----------

function kutipanBermakna(k) {
  return typeof k === 'string' && k.trim().length > 0;
}

function validasiUsulan(u) {
  const galat = [];
  if (!u || typeof u !== 'object') return ['Usulan kosong'];
  if (!u.rule_kode || !String(u.rule_kode).trim() || String(u.rule_kode).length > 20) galat.push('rule_kode wajib (maks 20 karakter)');
  if (!u.isi || typeof u.isi !== 'object') galat.push('isi wajib berupa objek');
  try { normTanggal(u.berlaku_mulai); } catch { galat.push('berlaku_mulai wajib tanggal valid (YYYY-MM-DD)'); }
  if (u.berlaku_sampai != null) {
    try {
      const s = normTanggal(u.berlaku_sampai);
      const m = normTanggal(u.berlaku_mulai);
      if (s < m) galat.push('berlaku_sampai tidak boleh sebelum berlaku_mulai');
    } catch { galat.push('berlaku_sampai bukan tanggal valid'); }
  }
  if (!SUMBER_JENIS.includes(u.sumber_jenis)) galat.push(`sumber_jenis harus salah satu dari ${SUMBER_JENIS.join(', ')}`);
  if (!kutipanBermakna(u.sumber_kutipan)) galat.push('sumber_kutipan wajib diisi: usulan tanpa dasar tidak boleh disimpan');
  if (!DIUSULKAN_OLEH.includes(u.diusulkan_oleh)) galat.push(`diusulkan_oleh harus salah satu dari ${DIUSULKAN_OLEH.join(', ')}`);
  return galat;
}

function bacaBaris(r) {
  if (!r) return r;
  const o = { ...r };
  if (typeof o.isi === 'string') { try { o.isi = JSON.parse(o.isi); } catch { /* biarkan */ } }
  if (typeof o.hasil_uji === 'string') { try { o.hasil_uji = JSON.parse(o.hasil_uji); } catch { /* biarkan */ } }
  o.berlaku_mulai = o.berlaku_mulai ? normTanggal(o.berlaku_mulai) : o.berlaku_mulai;
  o.berlaku_sampai = o.berlaku_sampai ? normTanggal(o.berlaku_sampai) : null;
  return o;
}

/**
 * Pilih rule yang berlaku pada tanggal pelayanan dari daftar baris (murni).
 * Sampai INKLUSIF. Tumpang tindih: mulai terbaru menang, seri -> versi terbesar.
 */
function pilihRuleBerlaku(baris, tanggalPelayanan) {
  const t = normTanggal(tanggalPelayanan);
  const kandidat = (baris || []).map(bacaBaris).filter((r) =>
    STATUS_BERLAKU.includes(r.status)
    && r.berlaku_mulai <= t
    && (!r.berlaku_sampai || t <= r.berlaku_sampai));
  kandidat.sort((a, b) => (a.berlaku_mulai === b.berlaku_mulai ? b.versi - a.versi : (a.berlaku_mulai < b.berlaku_mulai ? 1 : -1)));
  return kandidat[0] || null;
}

// ---------- DB ----------

function dalamTransaksi(db, fn) {
  return typeof db.transaction === 'function' ? db.transaction(fn) : fn(db);
}

async function ambil(db, ruleKode, versi) {
  return bacaBaris(await db.get('SELECT * FROM rule_versi WHERE rule_kode = ? AND versi = ?', [ruleKode, versi]));
}

// UPDATE bersyarat status; false bila baris sudah berubah/di luar status.
async function ubah(db, ruleKode, versi, set, statusBoleh) {
  const kolom = Object.keys(set);
  const nilai = kolom.map((k) => (k === 'hasil_uji' && set[k] != null && typeof set[k] !== 'string' ? JSON.stringify(set[k]) : set[k]));
  const marks = statusBoleh.map(() => '?').join(', ');
  const r = await db.run(
    `UPDATE rule_versi SET ${kolom.map((k) => `${k} = ?`).join(', ')} WHERE rule_kode = ? AND versi = ? AND status IN (${marks})`,
    [...nilai, ruleKode, versi, ...statusBoleh],
  );
  return r && r.changes > 0;
}

async function buatUsulan(db, u) {
  const galat = validasiUsulan(u);
  if (galat.length) {
    const e = new Error(`Usulan ditolak: ${galat.join('; ')}`);
    e.galat = galat;
    throw e;
  }
  const mulai = normTanggal(u.berlaku_mulai);
  const sampai = u.berlaku_sampai ? normTanggal(u.berlaku_sampai) : null;
  return dalamTransaksi(db, async (tx) => {
    const m = await tx.get('SELECT COALESCE(MAX(versi), 0) AS maks FROM rule_versi WHERE rule_kode = ?', [u.rule_kode]);
    const versi = Number((m && m.maks) || 0) + 1;
    await tx.run(
      `INSERT INTO rule_versi (rule_kode, versi, isi, berlaku_mulai, berlaku_sampai, status,
         sumber_jenis, sumber_kutipan, diusulkan_oleh)
       VALUES (?, ?, ?, ?, ?, 'usulan', ?, ?, ?)`,
      [u.rule_kode, versi, JSON.stringify(u.isi), mulai, sampai, u.sumber_jenis, u.sumber_kutipan.trim(), u.diusulkan_oleh],
    );
    return { rule_kode: u.rule_kode, versi, status: 'usulan' };
  });
}

/** Simpan hasil uji ke klaim lama; usulan -> diuji (uji ulang dari 'diuji' boleh). */
async function catatHasilUji(db, ruleKode, versi, hasil) {
  if (!hasil || typeof hasil !== 'object') throw new Error('hasil uji wajib berupa objek');
  const ok = await ubah(db, ruleKode, versi, { status: 'diuji', hasil_uji: hasil }, ['usulan', 'diuji']);
  if (!ok) throw new Error(`Hasil uji hanya bisa dicatat untuk usulan/diuji (${ruleKode} v${versi})`);
  return ambil(db, ruleKode, versi);
}

/**
 * Persetujuan koder — SATU-SATUNYA gerbang persetujuan, hanya untuk
 * mengaktifkan rule. Hanya dari 'diuji'. mode: 'dipantau' (default) | 'aktif'.
 */
async function setujui(db, ruleKode, versi, { oleh, mode = 'dipantau' } = {}) {
  if (!oleh || !String(oleh).trim()) throw new Error('Penyetuju (oleh) wajib dicatat');
  if (!['dipantau', 'aktif'].includes(mode)) throw new Error('mode harus dipantau atau aktif');
  return dalamTransaksi(db, async (tx) => {
    const baru = await ambil(tx, ruleKode, versi);
    if (!baru) throw new Error(`Rule ${ruleKode} v${versi} tidak ditemukan`);
    if (baru.status !== 'diuji') throw new Error(`Hanya rule berstatus 'diuji' yang bisa disetujui (sekarang '${baru.status}')`);

    const ok = await ubah(tx, ruleKode, versi, {
      status: mode, disetujui_oleh: String(oleh).trim(), disetujui_pada: new Date(),
    }, ['diuji']);
    if (!ok) throw new Error('Status rule sudah berubah, muat ulang');

    // Tutup rule lama yang masih terbuka pada tanggal mulai rule baru.
    const lama = (await tx.all(
      "SELECT * FROM rule_versi WHERE rule_kode = ? AND status IN ('aktif','dipantau')", [ruleKode],
    )).map(bacaBaris).filter((r) => r.versi !== versi
      && r.berlaku_mulai < baru.berlaku_mulai
      && (!r.berlaku_sampai || r.berlaku_sampai >= baru.berlaku_mulai));
    const ditutup = [];
    for (const r of lama) {
      await ubah(tx, ruleKode, r.versi, { status: 'pensiun', berlaku_sampai: geserHari(baru.berlaku_mulai, -1) }, ['aktif', 'dipantau']);
      ditutup.push(r.versi);
    }
    return { rule_kode: ruleKode, versi, status: mode, disetujui_oleh: String(oleh).trim(), versi_ditutup: ditutup };
  });
}

/** Akhiri masa pantau: dipantau -> aktif. */
async function akhiriPemantauan(db, ruleKode, versi) {
  const ok = await ubah(db, ruleKode, versi, { status: 'aktif' }, ['dipantau']);
  if (!ok) throw new Error('Hanya rule berstatus dipantau yang bisa dinaikkan ke aktif');
  return ambil(db, ruleKode, versi);
}

async function tolak(db, ruleKode, versi, { oleh, alasan } = {}) {
  if (!oleh || !String(oleh).trim()) throw new Error('Penolak (oleh) wajib dicatat');
  const cur = await ambil(db, ruleKode, versi);
  if (!cur) throw new Error(`Rule ${ruleKode} v${versi} tidak ditemukan`);
  const hasil = { ...(cur.hasil_uji || {}), ditolak: { oleh: String(oleh).trim(), alasan: alasan || null, waktu: new Date().toISOString() } };
  const ok = await ubah(db, ruleKode, versi, { status: 'ditolak', hasil_uji: hasil }, ['usulan', 'diuji']);
  if (!ok) throw new Error(`Hanya usulan/diuji yang bisa ditolak (sekarang '${cur.status}')`);
  return ambil(db, ruleKode, versi);
}

/** aktif/dipantau -> pensiun. Tanpa pengganti: rule tetap berlaku sampai `sampai`. */
async function pensiunkan(db, ruleKode, versi, { sampai } = {}) {
  const cur = await ambil(db, ruleKode, versi);
  if (!cur) throw new Error(`Rule ${ruleKode} v${versi} tidak ditemukan`);
  let batas = sampai ? normTanggal(sampai) : normTanggal(new Date());
  if (cur.berlaku_sampai && cur.berlaku_sampai < batas) batas = cur.berlaku_sampai;
  if (batas < cur.berlaku_mulai) batas = cur.berlaku_mulai;
  const ok = await ubah(db, ruleKode, versi, { status: 'pensiun', berlaku_sampai: batas }, ['aktif', 'dipantau']);
  if (!ok) throw new Error(`Hanya rule aktif/dipantau yang bisa dipensiunkan (sekarang '${cur.status}')`);
  return ambil(db, ruleKode, versi);
}

/**
 * Rollback dalam masa pantau: rule baru (status 'dipantau') dibatalkan dan
 * rule pendahulu yang dulu ditutup olehnya dibuka lagi.
 */
async function kembalikanKeVersiLama(db, ruleKode, versiBaru, { oleh, alasan } = {}) {
  if (!oleh || !String(oleh).trim()) throw new Error('Pelaku rollback (oleh) wajib dicatat');
  return dalamTransaksi(db, async (tx) => {
    const baru = await ambil(tx, ruleKode, versiBaru);
    if (!baru) throw new Error(`Rule ${ruleKode} v${versiBaru} tidak ditemukan`);
    if (baru.status !== 'dipantau') throw new Error(`Rollback hanya dalam masa pantau (status sekarang '${baru.status}')`);

    const hasil = { ...(baru.hasil_uji || {}), rollback: { oleh: String(oleh).trim(), alasan: alasan || null, waktu: new Date().toISOString() } };
    const ok = await ubah(tx, ruleKode, versiBaru, { status: 'ditolak', hasil_uji: hasil }, ['dipantau']);
    if (!ok) throw new Error('Status rule sudah berubah, muat ulang');

    const tutup = geserHari(baru.berlaku_mulai, -1);
    const semua = (await tx.all('SELECT * FROM rule_versi WHERE rule_kode = ? ORDER BY versi', [ruleKode])).map(bacaBaris);
    const pendahulu = semua
      .filter((r) => r.versi < versiBaru && r.status === 'pensiun' && r.berlaku_sampai === tutup)
      .sort((a, b) => b.versi - a.versi)[0];
    if (pendahulu) {
      await ubah(tx, ruleKode, pendahulu.versi, { status: 'aktif', berlaku_sampai: null }, ['pensiun']);
    }
    return { rule_kode: ruleKode, dibatalkan: versiBaru, dipulihkan: pendahulu ? pendahulu.versi : null };
  });
}

/** Rule yang berlaku pada TANGGAL PELAYANAN klaim (bukan tanggal cek). */
async function ruleBerlakuPada(db, ruleKode, tanggalPelayanan) {
  normTanggal(tanggalPelayanan); // gagal keras bila tanggal tidak valid
  const baris = await db.all(
    "SELECT * FROM rule_versi WHERE rule_kode = ? AND status IN ('aktif','dipantau','pensiun')", [ruleKode],
  );
  return pilihRuleBerlaku(baris, tanggalPelayanan);
}

async function riwayat(db, ruleKode) {
  return (await db.all('SELECT * FROM rule_versi WHERE rule_kode = ? ORDER BY versi', [ruleKode])).map(bacaBaris);
}

// ---------- layar persetujuan ----------

function ratakan(nilai, awalan, keluar) {
  if (Array.isArray(nilai)) {
    if (nilai.length === 0) keluar[awalan || '(root)'] = [];
    nilai.forEach((v, i) => ratakan(v, `${awalan}[${i}]`, keluar));
  } else if (nilai && typeof nilai === 'object') {
    const kunci = Object.keys(nilai);
    if (kunci.length === 0 && awalan) keluar[awalan] = {};
    kunci.forEach((k) => ratakan(nilai[k], awalan ? `${awalan}.${k}` : k, keluar));
  } else {
    keluar[awalan || '(root)'] = nilai;
  }
}

/**
 * Data diff berdampingan isi rule lama vs baru untuk layar persetujuan.
 * @returns {{baris:{path,lama,baru,jenis:'ditambah'|'dihapus'|'diubah'|'sama'}[],
 *            ringkas:{ditambah:number,dihapus:number,diubah:number,sama:number}}}
 */
function bandingkanIsi(lama, baru, { sertakanSama = true } = {}) {
  const a = {}; const b = {};
  ratakan(lama == null ? {} : lama, '', a);
  ratakan(baru == null ? {} : baru, '', b);
  const jalur = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const baris = [];
  const ringkas = { ditambah: 0, dihapus: 0, diubah: 0, sama: 0 };
  for (const path of jalur) {
    const ada = (o) => Object.prototype.hasOwnProperty.call(o, path);
    let jenis;
    if (!ada(a)) jenis = 'ditambah';
    else if (!ada(b)) jenis = 'dihapus';
    else jenis = JSON.stringify(a[path]) === JSON.stringify(b[path]) ? 'sama' : 'diubah';
    ringkas[jenis]++;
    if (jenis !== 'sama' || sertakanSama) baris.push({ path, lama: ada(a) ? a[path] : undefined, baru: ada(b) ? b[path] : undefined, jenis });
  }
  return { baris, ringkas };
}

/**
 * Uji rule baru ke klaim lama (murni, evaluator disuntikkan).
 *
 * @param {object} ruleBaru
 * @param {{id:any, hasil_lama:'pending'|'lolos'|string}[]} klaimLama
 *   hasil_lama = nasib klaim itu sebenarnya di BPJS.
 * @param {(rule:object, klaim:object)=>boolean|{ditandai:boolean}} evaluator
 *   true bila rule menandai klaim bermasalah.
 * @param {{ruleLama?:object}} [opsi] bila ada, "contoh" = klaim yang hasilnya
 *   BERUBAH antara rule lama dan baru; bila tidak, klaim yang ditandai rule baru.
 * @returns {{tertangkap:number, alarm_palsu:number, tidak_diketahui:number, galat:number,
 *            total:number, contoh:object[]}}
 *   tertangkap  = ditandai & ternyata pending (rule menangkap masalah nyata)
 *   alarm_palsu = ditandai & ternyata lolos (rule mengganggu klaim yang sehat)
 */
function ujiKeKlaimLama(ruleBaru, klaimLama, evaluator, opsi = {}) {
  if (typeof evaluator !== 'function') throw new Error('evaluator wajib fungsi');
  const ditandai = (r, k) => {
    const v = evaluator(r, k);
    return v && typeof v === 'object' ? !!v.ditandai : !!v;
  };
  const out = { tertangkap: 0, alarm_palsu: 0, tidak_diketahui: 0, galat: 0, total: 0, contoh: [] };
  for (const klaim of klaimLama || []) {
    out.total++;
    let baru;
    let lama = null;
    try {
      baru = ditandai(ruleBaru, klaim);
      if (opsi.ruleLama) lama = ditandai(opsi.ruleLama, klaim);
    } catch {
      out.galat++;
      continue;
    }
    let jenis = null;
    if (baru) {
      if (klaim.hasil_lama === 'pending') { out.tertangkap++; jenis = 'tertangkap'; }
      else if (klaim.hasil_lama === 'lolos') { out.alarm_palsu++; jenis = 'alarm_palsu'; }
      else out.tidak_diketahui++;
    }
    const berubah = opsi.ruleLama ? baru !== lama : baru;
    if (berubah && out.contoh.length < 3) {
      out.contoh.push({
        id: klaim.id,
        ditandai_rule_baru: baru,
        ditandai_rule_lama: lama,
        hasil_lama: klaim.hasil_lama === undefined ? null : klaim.hasil_lama,
        jenis,
      });
    }
  }
  return out;
}

module.exports = {
  STATUS, SUMBER_JENIS, DIUSULKAN_OLEH, STATUS_BERLAKU,
  ensureSchema, validasiUsulan, pilihRuleBerlaku, normTanggal,
  buatUsulan, catatHasilUji, setujui, akhiriPemantauan, tolak, pensiunkan,
  kembalikanKeVersiLama, ruleBerlakuPada, riwayat, bandingkanIsi, ujiKeKlaimLama,
};
