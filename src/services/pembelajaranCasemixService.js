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
async function cariPola(db, pages, recordId) {
  if (!db) return [];
  await pastikanSkema(db);
  const istilah = [];
  const dx = nilaiLabel(pages, /diagnos[ai]s?\s+utama\s*:?/i);
  if (dx) istilah.push({ jenis: 'diagnosis', teks: dx, kunci: kunciIstilah(dx) });
  for (const t of butirTindakan(pages)) istilah.push({ jenis: 'prosedur', teks: t, kunci: kunciIstilah(t) });
  const hasil = [];
  for (const i of istilah.filter(x => x.kunci)) {
    try {
      const baris = await db.all(`SELECT kode, COUNT(*) AS jumlah FROM pola_casemix_contoh
        WHERE jenis = ? AND kunci = ? AND record_id <> ? GROUP BY kode ORDER BY COUNT(*) DESC LIMIT 3`, [i.jenis, i.kunci, String(recordId || '')]);
      for (const b of baris) hasil.push({ jenis: i.jenis, istilah: i.teks, kode: b.kode, jumlah: Number(b.jumlah) });
    } catch (_) { /* tabel belum ada / DB bermasalah: tanpa petunjuk */ }
  }
  return hasil;
}

module.exports = { ensureSchema, pelajari, cariPola, ekstrakPasangan, kunciIstilah, butirTindakan };
