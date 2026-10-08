// Adaptasi fasilitas dan cakupan ketentuan lokal disimpan per RS, bukan di prompt global.
const referensi = require('../data/referensiKesesuaianKlaim.json');
const lokal = require('../data/syaratPenunjangDiagnosis.json');
const ID_LOKAL = new Set(lokal.aturan.map(a => a.id));
const dokumen = require('../data/baTkmkb2025.json');
const ID_REFERENSI = new Set([...referensi.aturan,...dokumen.aturan].map(a => a.id));

function profilBawaan(hospitalCode) {
  const code = String(hospitalCode || '').trim();
  const lestari = code === '3371084';
  return {
    hospital_code: code || null,
    layanan: { rehabilitasi_medis: lestari ? false : null },
    referensi_dinonaktifkan: [],
    ketentuan_lokal: lestari ? lokal.aturan.map(a => ({
      id: a.id, sumber_aturan: a.sumber_aturan, disahkan_oleh: a.disahkan_oleh,
      // Tanggal pengesahan konfigurasi tidak membuktikan awal berlakunya syarat BPJS.
      berlaku_mulai: null, berlaku_sampai: null,
    })) : [],
  };
}

function tanggalSah(v) {
  if (v === null || v === undefined || v === '') return true;
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
}

function validasiProfil(input, hospitalCode) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Profil klaim harus berupa objek.');
  const keys = ['layanan', 'referensi_dinonaktifkan', 'ketentuan_lokal'];
  if (Object.keys(input).some(k => !keys.includes(k))) throw Error('Kolom profil klaim tidak dikenal.');
  const profil = profilBawaan(hospitalCode);
  if (input.layanan !== undefined) {
    const l = input.layanan;
    if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).some(k => k !== 'rehabilitasi_medis')
      || ![true, false, null].includes(l.rehabilitasi_medis)) throw Error('Ketersediaan rehabilitasi medis harus ya, tidak, atau belum ditentukan.');
    profil.layanan = { rehabilitasi_medis: l.rehabilitasi_medis };
  }
  if (input.referensi_dinonaktifkan !== undefined) {
    if (!Array.isArray(input.referensi_dinonaktifkan) || input.referensi_dinonaktifkan.some(id => !ID_REFERENSI.has(id)))
      throw Error('Referensi yang dinonaktifkan tidak dikenal.');
    profil.referensi_dinonaktifkan = [...new Set(input.referensi_dinonaktifkan)];
  }
  if (input.ketentuan_lokal !== undefined) {
    if (!Array.isArray(input.ketentuan_lokal) || input.ketentuan_lokal.length > ID_LOKAL.size) throw Error('Daftar ketentuan lokal tidak sah.');
    const ids = new Set();
    profil.ketentuan_lokal = input.ketentuan_lokal.map(a => {
      if (!a || !ID_LOKAL.has(a.id) || ids.has(a.id)) throw Error('Ketentuan lokal tidak dikenal atau berulang.');
      ids.add(a.id);
      if (typeof a.sumber_aturan !== 'string' || a.sumber_aturan.trim().length < 15 || a.sumber_aturan.length > 2000
        || typeof a.disahkan_oleh !== 'string' || !a.disahkan_oleh.trim() || a.disahkan_oleh.length > 200)
        throw Error('Ketentuan lokal harus memiliki sumber dan pengesah untuk RS ini.');
      if (!tanggalSah(a.berlaku_mulai) || !tanggalSah(a.berlaku_sampai)
        || (a.berlaku_mulai && a.berlaku_sampai && a.berlaku_mulai > a.berlaku_sampai)) throw Error('Masa berlaku ketentuan lokal tidak sah.');
      const url = a.url || null;
      if (url && (typeof url !== 'string' || !/^https:\/\//.test(url) || url.length > 2000)) throw Error('Tautan sumber harus HTTPS.');
      return { id: a.id, sumber_aturan: a.sumber_aturan.trim(), disahkan_oleh: a.disahkan_oleh.trim(),
        berlaku_mulai: a.berlaku_mulai || null, berlaku_sampai: a.berlaku_sampai || null, url };
    });
  }
  return profil;
}

async function ensureSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS referensi_klaim_catalog (
    versi TEXT PRIMARY KEY, diperiksa_pada DATE NOT NULL, katalog JSONB NOT NULL,
    dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS profil_klaim_rs (
    hospital_code TEXT PRIMARY KEY, profil JSONB NOT NULL,
    updated_by TEXT, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  await db.run(`INSERT INTO referensi_klaim_catalog(versi,diperiksa_pada,katalog)
    VALUES(?,?,?::jsonb) ON CONFLICT(versi) DO NOTHING`,
  [referensi.versi, referensi.diperiksa_pada, JSON.stringify(referensi)]);
  await db.run(`INSERT INTO referensi_klaim_catalog(versi,diperiksa_pada,katalog)
    VALUES(?,?,?::jsonb) ON CONFLICT(versi) DO NOTHING`,
  [dokumen.versi,dokumen.diperiksa_pada,JSON.stringify(dokumen)]);
  await db.run(`UPDATE validation_rules SET rule_name=?,description=?,priority=3,error_message=? WHERE id='RV-17'`,
    ['Telaah Indikasi Odontektomi','BA 2024: rawat jalan/rawat inap sesuai indikasi; telaah bukti melalui RK-17.',
      'Periksa indikasi dan laporan tindakan odontektomi; jenis rawat saja tidak menentukan kelayakan.']);
}

async function muatProfil(db, hospitalCode) {
  const bawaan = profilBawaan(hospitalCode);
  if (!hospitalCode || !db) return bawaan;
  try {
    const row = await db.get('SELECT profil, updated_at FROM profil_klaim_rs WHERE hospital_code = ?', [String(hospitalCode)]);
    if (!row?.profil) return bawaan;
    const payload = typeof row.profil === 'string' ? JSON.parse(row.profil) : row.profil;
    return { ...validasiProfil(payload, hospitalCode), updated_at: row.updated_at || null };
  } catch (e) {
    // Gangguan konfigurasi tidak boleh diam-diam mengaktifkan ambang lokal.
    return { ...bawaan, ketentuan_lokal: [], konfigurasi_belum_terbaca: true };
  }
}

async function simpanProfil(db, hospitalCode, input, userId) {
  if (!hospitalCode) throw Error('Rumah sakit akun belum ditentukan.');
  const profil = validasiProfil(input, hospitalCode);
  const { hospital_code, ...payload } = profil;
  await db.run(`INSERT INTO profil_klaim_rs(hospital_code,profil,updated_by,updated_at)
    VALUES(?,?::jsonb,?,CURRENT_TIMESTAMP) ON CONFLICT(hospital_code) DO UPDATE
    SET profil=EXCLUDED.profil, updated_by=EXCLUDED.updated_by, updated_at=CURRENT_TIMESTAMP`,
  [hospital_code, JSON.stringify(payload), userId || null]);
  return profil;
}

module.exports = { ensureSchema, profilBawaan, validasiProfil, tanggalSah, muatProfil, simpanProfil };
