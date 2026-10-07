/**
 * Belajar dari berkas yang SUDAH diklaim (membawa lembar grouper casemix).
 *
 * Berkas yang dikirim sungguhan tidak membawa lembar grouper; yang membawanya
 * hanya berkas lama yang sudah selesai diklaim -- itulah "kunci jawaban".
 * Dari situ disimpan pasangan ISTILAH DI RESUME -> KODE YANG DIPILIH CASEMIX
 * (diagnosis utama; tindakan operasi bila resume hanya menulis satu tindakan),
 * per berkas, tanpa identitas pasien.
 *
 * Saat berkas BARU dinilai, pasangan dari berkas LAIN dipakai sebagai petunjuk
 * (agen tinjau) dan pembanding (pemeriksa kritis). Pasangan dari berkas itu
 * sendiri tidak pernah dipakai saat menilai berkas itu.
 */
const { classifyPageDocumentType } = require('./pdfPageClassifier');

function kunciIstilah(teks) {
  return String(teks || '').toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:hari|jam|minggu|bulan|tahun|th|cm|mm)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pola_casemix_contoh (
      record_id TEXT NOT NULL,
      jenis VARCHAR(12) NOT NULL,
      kunci VARCHAR(120) NOT NULL,
      kode VARCHAR(12) NOT NULL,
      teks VARCHAR(200),
      jenis_klaim VARCHAR(20),
      dibuat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (record_id, jenis, kunci)
    )
  `);
}
let skemaSiap = null;
function pastikanSkema(db) {
  if (!skemaSiap) skemaSiap = Promise.resolve().then(() => ensureSchema(db)).catch(() => { skemaSiap = null; });
  return skemaSiap;
}

function halamanResume(pages) {
  return (pages || []).filter(p => classifyPageDocumentType(String(p.ocr_text || '')) === 'resume_medis');
}

/** Nilai satu label resume ("Diagnosis Utama :" -> baris nilainya). */
function nilaiLabel(pages, pola) {
  for (const p of halamanResume(pages)) {
    const baris = String(p.ocr_text || '').split(/\r?\n/);
    const i = baris.findIndex(b => pola.test(b));
    if (i === -1) continue;
    const di = baris[i].replace(pola, '').replace(/^[\s:]+/, '').trim();
    const v = di || (baris.slice(i + 1).find(b => b.trim()) || '').trim();
    if (v && !/^[-.\s]*$/.test(v)) return v;
  }
  return null;
}

/** Butir "Tindakan/Prosedur" pada resume (berhenti di label berikutnya). */
function butirTindakan(pages) {
  for (const p of halamanResume(pages)) {
    const baris = String(p.ocr_text || '').split(/\r?\n/);
    const i = baris.findIndex(b => /tindakan\s*\/?\s*prosedur/i.test(b));
    if (i === -1) continue;
    const hasil = [];
    for (let j = i + 1; j < baris.length && j < i + 8; j++) {
      const b = baris[j].trim();
      if (/^[A-Z][A-Za-z /]{2,40}:/.test(b) || /^terapi|^reaksi|^diet|^instruksi/i.test(b)) break;
      const isi = b.replace(/^\d+[.)]\s*/, '').trim();
      if (isi && !/^[-.]+$/.test(isi)) hasil.push(isi);
    }
    return hasil;
  }
  return [];
}

/**
 * Judul pemeriksaan pada halaman HASIL (bukan resume/triase/tagihan/lembar
 * grouper): "PEMERIKSAAN : CT-Head tanpa kontras", "Jenis Foto : Thorax PA".
 */
function judulPemeriksaanHasil(pages) {
  const hasil = [];
  for (const p of pages || []) {
    const teks = String(p.ocr_text || '');
    const jenis = classifyPageDocumentType(teks);
    if (['resume_medis', 'triase_igd', 'rincian_biaya', 'berkas_eklaim', 'sep', 'spri'].includes(jenis)) continue;
    for (const b of teks.split(/\r?\n/)) {
      const m = /^\s*(?:jenis\s+)?(?:pemeriksaan|foto|exam(?:ination)?)\s*:\s*(.{3,80})$/i.exec(b);
      if (!m) continue;
      const judul = m[1].replace(/\s{2,}.*/, '').trim(); // potong kolom kanan ("KLINIS : ...")
      if (kunciIstilah(judul).length >= 3) hasil.push({ judul, kunci: kunciIstilah(judul), page_number: p.page_number || null });
    }
  }
  return hasil;
}

/** Kode penunjang (ICD-9-CM >= 87) yang dikenali kamus/pola umum dari teks. */
function kodePenunjangDikenali(teks) {
  const kode = new Set();
  try {
    const { temukanDalamTeks } = require('./kamusPenunjangService');
    for (const t of temukanDalamTeks(teks, { bagian: 'radiologi' })) if (t.kode_usulan) kode.add(t.kode_usulan);
  } catch (_) { /* kamus tak tersedia */ }
  const { kenaliPemeriksaanRadiologi } = require('./pengenalPemeriksaanUmum');
  const r = kenaliPemeriksaanRadiologi(teks);
  if (r) kode.add(r.kode);
  return kode;
}

/** Pasangan istilah -> kode dari satu berkas berlembar grouper. */
function ekstrakPasangan(pages, lembar) {
  const pasangan = [];
  if (!lembar) return pasangan;
  const utama = (lembar.diagnosis || []).find(d => d.peran === 'utama') || (lembar.diagnosis || [])[0];
  const dx = nilaiLabel(pages, /diagnos[ai]s?\s+utama\s*:?/i);
  if (utama && dx && kunciIstilah(dx)) pasangan.push({ jenis: 'diagnosis', kunci: kunciIstilah(dx), kode: utama.kode, teks: dx.slice(0, 200) });
  const { adalahProsedurBedah } = require('./inacbgGroupingService');
  const bedah = (lembar.prosedur || []).map(p => p.kode).filter(adalahProsedurBedah);
  const tindakan = butirTindakan(pages);
  if (bedah.length === 1 && tindakan.length === 1 && kunciIstilah(tindakan[0])) {
    pasangan.push({ jenis: 'prosedur', kunci: kunciIstilah(tindakan[0]), kode: bedah[0], teks: tindakan[0].slice(0, 200) });
  }
  // Penunjang format baru: judul pemeriksaan di halaman hasil yang BELUM
  // dikenali kamus/pola umum, dipasangkan dengan kode penunjang casemix yang
  // belum terjelaskan -- hanya bila masing-masing tinggal tepat satu, supaya
  // pasangan tidak ditebak.
  const judul = judulPemeriksaanHasil(pages);
  const terjelaskan = new Set();
  const belumDikenal = [];
  for (const j of judul) {
    const k = kodePenunjangDikenali(j.judul);
    if (k.size) k.forEach(x => terjelaskan.add(x)); else belumDikenal.push(j);
  }
  const penunjangCasemix = (lembar.prosedur || []).map(p => String(p.kode))
    .filter(k => Number(k.split('.')[0]) >= 87 && !terjelaskan.has(k));
  const unik = [...new Map(belumDikenal.map(j => [j.kunci, j])).values()];
  if (unik.length === 1 && penunjangCasemix.length === 1) {
    pasangan.push({ jenis: 'penunjang', kunci: unik[0].kunci, kode: penunjangCasemix[0], teks: unik[0].judul.slice(0, 200) });
  }
  return pasangan;
}

async function pelajari(db, recordId, jenisKlaim, pages, lembar) {
  if (!db || !recordId || !lembar) return [];
  await pastikanSkema(db);
  const pasangan = ekstrakPasangan(pages, lembar);
  await db.run('DELETE FROM pola_casemix_contoh WHERE record_id = ?', [String(recordId)]);
  for (const p of pasangan) {
    await db.run(`INSERT INTO pola_casemix_contoh (record_id, jenis, kunci, kode, teks, jenis_klaim) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (record_id, jenis, kunci) DO UPDATE SET kode = EXCLUDED.kode, teks = EXCLUDED.teks, dibuat = CURRENT_TIMESTAMP`,
    [String(recordId), p.jenis, p.kunci, p.kode, p.teks, jenisKlaim || null]);
  }
  return pasangan;
}

/**
 * Petunjuk untuk berkas yang sedang dinilai: pola dari berkas LAIN dengan
 * istilah resume yang sama persis.
 * @returns {Promise<Array<{jenis, istilah, kode, jumlah}>>}
 */
async function cariPola(db, pages, recordId, { untukPerbandingan = false } = {}) {
  // Riwayat keputusan casemix hanya pembanding, bukan jawaban untuk kasus baru.
  if (!untukPerbandingan) return [];
  if (!db) return [];
  await pastikanSkema(db);
  const istilah = [];
  const dx = nilaiLabel(pages, /diagnos[ai]s?\s+utama\s*:?/i);
  if (dx) istilah.push({ jenis: 'diagnosis', teks: dx, kunci: kunciIstilah(dx) });
  for (const t of butirTindakan(pages)) istilah.push({ jenis: 'prosedur', teks: t, kunci: kunciIstilah(t) });
  const hasil = [];
  for (const i of istilah.filter(x => x.kunci)) {
    try {
      // Berkas yang sama yang diunggah ulang (SEP sama) bukan "kasus lain".
      const baris = await db.all(`SELECT kode, COUNT(*) AS jumlah FROM pola_casemix_contoh
        WHERE jenis = ? AND kunci = ? AND record_id <> ?
          AND record_id NOT IN (SELECT c2.id FROM claim_records c1 JOIN claim_records c2 ON c2.sep = c1.sep
            WHERE c1.id = ? AND COALESCE(c1.sep, '') <> '')
        GROUP BY kode ORDER BY COUNT(*) DESC LIMIT 3`, [i.jenis, i.kunci, String(recordId || ''), String(recordId || '')]);
      for (const b of baris) hasil.push({ jenis: i.jenis, istilah: i.teks, kode: b.kode, jumlah: Number(b.jumlah) });
    } catch (_) { /* tabel belum ada / DB bermasalah: tanpa petunjuk */ }
  }
  return hasil;
}

/**
 * Penunjang yang dipelajari dari casemix: judul pemeriksaan di halaman hasil
 * berkas ini yang tidak dikenali kamus, tetapi pada >= 2 berkas LAIN (SEP
 * berbeda) dikode casemix dengan kode yang sama. Dikembalikan sebagai temuan
 * penunjang bersumber 'dipelajari_casemix'.
 */
const MIN_BERKAS_PELAJARAN = 2;
async function cariPenunjangDipelajari(db, pages, recordId, { untukPerbandingan = false } = {}) {
  if (!untukPerbandingan) return [];
  if (!db) return [];
  await pastikanSkema(db);
  const hasil = [];
  for (const j of judulPemeriksaanHasil(pages)) {
    if (kodePenunjangDikenali(j.judul).size) continue;
    try {
      const baris = await db.all(`SELECT kode, COUNT(DISTINCT record_id) AS jumlah FROM pola_casemix_contoh
        WHERE jenis = 'penunjang' AND kunci = ? AND record_id <> ?
          AND record_id NOT IN (SELECT c2.id FROM claim_records c1 JOIN claim_records c2 ON c2.sep = c1.sep
            WHERE c1.id = ? AND COALESCE(c1.sep, '') <> '')
        GROUP BY kode ORDER BY COUNT(DISTINCT record_id) DESC LIMIT 2`, [j.kunci, String(recordId || ''), String(recordId || '')]);
      const [utama, kedua] = baris;
      // Wajib konsisten: kode teratas >= 2 berkas dan tidak bersaing seimbang.
      if (!utama || Number(utama.jumlah) < MIN_BERKAS_PELAJARAN || (kedua && Number(kedua.jumlah) >= Number(utama.jumlah))) continue;
      hasil.push({
        status: 'dikenali', sumber_pengenal: 'dipelajari_casemix', istilah_id: `dipelajari_${j.kunci.replace(/\s+/g, '_').slice(0, 40)}`,
        istilah_baku: j.judul, kategori: 'radiologi', kode_usulan: utama.kode, ditulis: j.judul,
        page_number: j.page_number, kutipan: j.judul, jenis_halaman: 'radiology',
        menjadi_syarat: false, kode_terverifikasi: false, satuan: null,
        catatan: `Dipelajari dari ${utama.jumlah} berkas lain yang dikode casemix ${utama.kode}.`,
      });
    } catch (_) { /* DB bermasalah: tanpa pelajaran */ }
  }
  return hasil;
}

module.exports = { ensureSchema, pelajari, cariPola, ekstrakPasangan, kunciIstilah, butirTindakan, cariPenunjangDipelajari, judulPemeriksaanHasil };
