/**
 * Triase empat kotak untuk setiap pending BPJS.
 *
 *   A  bisa_dijawab         bukti untuk menjawab sudah ada di berkas
 *   B  butuh_dokumen        ada dokumen yang diminta/perlu tetapi tidak ada di berkas
 *   C  revisi_koding        koding perlu ditinjau (kode dipersoalkan, tak ada dukungan di berkas)
 *   D  tidak_dipertahankan  berkas justru menguatkan alasan pending; RS mengalah
 *   (null)                  belum terklasifikasi: kategori belum punya kriteria otomatis
 *
 * PRINSIP
 *  - Deterministik, tanpa AI, tanpa token. Keputusan ditulis dalam daftar
 *    `kriteria` (id, uraian, terpenuhi, bukti) yang disimpan bersama kotaknya,
 *    supaya koder bisa melihat KENAPA sebuah pending masuk kotak itu dan
 *    mengoreksinya (kotak_manual).
 *  - TIDAK ADA persentase keyakinan. Yang ada hanya: kriteria mana yang
 *    terpenuhi dan kutipan halaman mana yang mendukung.
 *  - Bukti = kutipan yang diverifikasi terhadap teks halaman
 *    (buktiBerkasPendingService). Tidak ada kutipan -> kriteria tidak terpenuhi.
 *  - Kriteria di sini adalah aturan kerja awal yang masuk akal, BELUM
 *    dikalibrasi terhadap rekap nyata dengan hasil akhir BPJS. Koder yang
 *    bertanggung jawab atas kotak akhir.
 */

const { cariKutipan, ambilKode, polaKode } = require('./buktiBerkasPendingService');

const KOTAK = Object.freeze({
  A: { kode: 'A', nama: 'bisa_dijawab', label: 'Bisa dijawab' },
  B: { kode: 'B', nama: 'butuh_dokumen', label: 'Butuh dokumen' },
  C: { kode: 'C', nama: 'revisi_koding', label: 'Revisi koding' },
  D: { kode: 'D', nama: 'tidak_dipertahankan', label: 'Tidak dipertahankan' },
});

const TANPA_KRITERIA = 'Kategori ini belum punya kriteria triase otomatis; perlu penilaian koder.';

// ---- pola bukti -----------------------------------------------------------

const POLA = {
  triase: /triase|triage|instalasi\s*gawat\s*darurat|\bigd\b|\bugd\b/i,
  indikatorGawat: /penurunan\s*kesadaran|sesak(\s*napas)?|nyeri\s*dada|\bsyok\b|kejang|perdarahan|henti\s*(jantung|napas)|(triase|triage|kategori|level|prioritas)[^\n]{0,25}(merah|kuning|p\s*[12]\b|emergency|gawat)/i,
  nonGawat: /(triase|triage|kategori|level|prioritas)[^\n]{0,25}(hijau|biru|hitam|non[\s-]*(urgent|emergency|gawat)|p\s*[34]\b)/i,
  indikasiRanap: /\bspri\b|surat\s*perintah\s*rawat\s*inap|instruksi\s*rawat\s*inap|indikasi\s*(rawat\s*inap|ranap)|advis\s*(rawat|ranap)|dirawat\s*inap|observasi/i,
  icu: /\bicu\b|\biccu\b|\bnicu\b|\bpicu\b|ventilator|intubasi|\bvent\b/i,
  prb: /\bprb\b|rujuk\s*balik|obat\s*kronis|kondisi\s*stabil/i,
};

/**
 * Dokumen yang bisa disebut dalam alasan pending -> (pola di alasan, pola di berkas).
 * Dokumen yang tidak bisa dibuktikan lewat teks (mis. tanda tangan) tidak ada di sini.
 */
const DOKUMEN = [
  { id: 'resume_medis', nama: 'Resume medis', alasan: /resume|ringkasan\s*(pasien\s*)?pulang/i, berkas: /resume\s*medis|ringkasan\s*(pasien\s*)?pulang/i },
  { id: 'laporan_operasi', nama: 'Laporan operasi', alasan: /laporan\s*operasi|operative\s*report/i, berkas: /laporan\s*operasi|operative\s*report/i },
  { id: 'laboratorium', nama: 'Hasil laboratorium', alasan: /\blab\b|laboratorium/i, berkas: /hasil\s*(pemeriksaan\s*)?laboratorium|hasil\s*lab\b|hematologi|hemoglobin|leukosit/i },
  { id: 'radiologi', nama: 'Hasil radiologi', alasan: /radiologi|rontgen|x-?ray|\bct\b|\bmri\b|\busg\b/i, berkas: /radiologi|rontgen|foto\s*thorax|\bct[\s-]*scan\b|\bmri\b|\busg\b/i },
  { id: 'ekg', nama: 'Hasil EKG', alasan: /\bekg\b|\becg\b/i, berkas: /\bekg\b|\becg\b|elektrokardiogra/i },
  { id: 'triase', nama: 'Triase IGD', alasan: /triase|triage/i, berkas: /triase|triage/i },
  { id: 'informed_consent', nama: 'Persetujuan tindakan (informed consent)', alasan: /inform|persetujuan/i, berkas: /informed?\s*consent|persetujuan\s*tindakan/i },
  { id: 'resep', nama: 'Resep/obat', alasan: /\bresep\b|\bobat\b/i, berkas: /\bresep\b|\bobat\b/i },
  { id: 'spri', nama: 'Surat perintah rawat inap (SPRI)', alasan: /\bspri\b|surat\s*perintah/i, berkas: /\bspri\b|surat\s*perintah\s*rawat\s*inap/i },
  { id: 'surat_rujukan', nama: 'Surat rujukan', alasan: /rujukan/i, berkas: /surat\s*rujukan|\brujukan\b/i },
  { id: 'surat_kontrol', nama: 'Surat kontrol', alasan: /surat\s*kontrol|rencana\s*kontrol/i, berkas: /surat\s*(kontrol|rencana\s*kontrol)/i },
];

// ---- pembantu --------------------------------------------------------------

function k(id, uraian, terpenuhi, bukti) {
  return { id, uraian, terpenuhi: !!terpenuhi, bukti: bukti || [] };
}

function hasil(kotak, alasan_kotak, kriteria, tambahan = {}) {
  return {
    kotak, alasan_kotak, kriteria,
    dokumen_dibutuhkan: [], topik_bukti: [], kode_dipersoalkan: [],
    ...tambahan,
  };
}

// ---- penilai per kategori --------------------------------------------------

function nilaiKegawatan(halaman) {
  const triase = cariKutipan(halaman, POLA.triase);
  const gawat = cariKutipan(halaman, POLA.indikatorGawat);
  const nonGawat = cariKutipan(halaman, POLA.nonGawat);
  const kriteria = [
    k('gawat_halaman_triase', 'Ada halaman/teks triase atau IGD di berkas', triase.length > 0, triase),
    k('gawat_indikator', 'Ada indikator kegawatan tertulis (kesadaran menurun, sesak, nyeri dada, syok, kejang, perdarahan, atau triase merah/kuning)', gawat.length > 0, gawat),
    k('gawat_nongawat', 'Triase justru tertulis non-gawat (hijau/biru/P3/P4)', nonGawat.length > 0, nonGawat),
  ];
  const topik = [
    { topik: 'Triase / IGD', kutipan: triase },
    { topik: 'Indikator kegawatan', kutipan: gawat },
  ];
  if (nonGawat.length > 0 && gawat.length === 0) {
    return hasil('D', 'Triase tertulis non-gawat dan tidak ada indikator kegawatan di berkas.', kriteria,
      { topik_bukti: [{ topik: 'Triase non-gawat', kutipan: nonGawat }] });
  }
  if (triase.length > 0 && gawat.length > 0) {
    return hasil('A', 'Ada triase/IGD dan indikator kegawatan tertulis di berkas.', kriteria, { topik_bukti: topik });
  }
  const perlu = triase.length === 0 ? ['Triase IGD'] : ['Catatan indikator kegawatan (resume/triase)'];
  return hasil('B', triase.length === 0
    ? 'Tidak ada triase/IGD di berkas.'
    : 'Ada triase tetapi indikator kegawatan tidak tertulis di berkas.', kriteria,
  { dokumen_dibutuhkan: perlu, topik_bukti: topik });
}

function nilaiKoding(jenis, alasanRaw, klaim, halaman) {
  const label = jenis === 'prosedur' ? 'kode tindakan' : 'kode diagnosis';
  const dikutipBpjs = ambilKode(alasanRaw, jenis);
  const kodeKlaim = ambilKode(jenis === 'prosedur' ? klaim && klaim.prosedur_list : klaim && klaim.diagnosa_list, jenis);
  const periksa = dikutipBpjs.length > 0 ? dikutipBpjs : kodeKlaim;
  const asal = dikutipBpjs.length > 0 ? 'kode yang disebut BPJS' : `${label} pada klaim`;

  const kriteria = [];
  if (periksa.length === 0) {
    return hasil(null, `Tidak ada ${label} yang bisa diperiksa (tidak disebut BPJS dan tidak ada di klaim).`,
      [k('koding_ada_kode', `Ada ${label} yang bisa diperiksa`, false)]);
  }
  const ditemukan = [];
  const hilang = [];
  for (const kode of periksa) {
    const b = cariKutipan(halaman, polaKode(kode), { maks: 2 });
    kriteria.push(k(`koding_${kode}`, `${kode} (${asal}) tertulis literal di halaman berkas`, b.length > 0, b));
    (b.length ? ditemukan : hilang).push({ kode, kutipan: b });
  }
  const topik = ditemukan.map((d) => ({ topik: `Kode ${d.kode} tertulis di berkas`, kutipan: d.kutipan }));
  if (hilang.length === 0) {
    return hasil('A', `Semua ${asal} tertulis di halaman berkas.`, kriteria, { topik_bukti: topik });
  }
  return hasil('C', `${label} ${hilang.map((h) => h.kode).join(', ')} tidak tertulis di halaman berkas; koding perlu ditinjau.`, kriteria, {
    topik_bukti: [...topik, ...hilang.map((h) => ({ topik: `Kode ${h.kode} tertulis di berkas`, kutipan: [] }))],
    kode_dipersoalkan: hilang.map((h) => h.kode),
  });
}

function nilaiDokumen(alasanRaw, halaman) {
  const diminta = DOKUMEN.filter((d) => d.alasan.test(alasanRaw || ''));
  if (diminta.length === 0) {
    return hasil(null, TANPA_KRITERIA, [k('dok_disebut', 'Alasan menyebut dokumen tertentu yang dikenali', false)]);
  }
  const kriteria = [];
  const topik = [];
  const kurang = [];
  for (const d of diminta) {
    const b = cariKutipan(halaman, d.berkas, { maks: 2 });
    kriteria.push(k(`dok_${d.id}`, `${d.nama} ada di berkas`, b.length > 0, b));
    topik.push({ topik: d.nama, kutipan: b });
    if (b.length === 0) kurang.push(d.nama);
  }
  if (kurang.length === 0) return hasil('A', 'Semua dokumen yang disebut BPJS terdeteksi di berkas.', kriteria, { topik_bukti: topik });
  return hasil('B', `Dokumen tidak terdeteksi di berkas: ${kurang.join(', ')}.`, kriteria, { dokumen_dibutuhkan: kurang, topik_bukti: topik });
}

function nilaiPolaTunggal(idKriteria, uraian, pola, namaDokumen, halaman) {
  const b = cariKutipan(halaman, pola, { maks: 3 });
  const kriteria = [k(idKriteria, uraian, b.length > 0, b)];
  if (b.length > 0) return hasil('A', `${uraian}: ditemukan di berkas.`, kriteria, { topik_bukti: [{ topik: uraian, kutipan: b }] });
  return hasil('B', `${uraian}: tidak ditemukan di berkas.`, kriteria, { dokumen_dibutuhkan: [namaDokumen], topik_bukti: [{ topik: uraian, kutipan: [] }] });
}

/**
 * Nilai satu pending.
 * @param {{alasan_raw:string, kategori:string, klaim?:object|null, halaman:Array}} masuk
 */
function nilaiTriase(masuk) {
  const { alasan_raw: alasanRaw, kategori, klaim, halaman = [] } = masuk;
  const dasar = { jumlah_halaman: halaman.length };

  if (!klaim) {
    return {
      ...dasar,
      ...hasil('B', 'Klaim tidak ada di sistem (belum diupload atau sudah dihapus), jadi tidak ada berkas yang bisa dikutip.',
        [k('klaim_ada', 'Klaim untuk SEP ini ada di sistem', false)],
        { dokumen_dibutuhkan: ['Berkas klaim (upload PDF klaim untuk SEP ini)'] }),
    };
  }
  if (halaman.length === 0) {
    return {
      ...dasar,
      ...hasil('B', 'Klaim ada, tetapi belum ada teks halaman tersimpan (OCR/teks asli), jadi tidak ada bukti yang bisa dikutip.',
        [k('klaim_ada', 'Klaim untuk SEP ini ada di sistem', true), k('halaman_ada', 'Ada teks halaman tersimpan untuk klaim ini', false)],
        { dokumen_dibutuhkan: ['Teks halaman berkas (jalankan OCR/ekstraksi ulang)'] }),
    };
  }

  let h;
  switch (kategori) {
    case 'kegawatdaruratan': h = nilaiKegawatan(halaman); break;
    case 'kode_diagnosis': h = nilaiKoding('diagnosis', alasanRaw, klaim, halaman); break;
    case 'kode_tindakan': h = nilaiKoding('prosedur', alasanRaw, klaim, halaman); break;
    case 'dokumen_tidak_lengkap':
    case 'hasil_penunjang':
    case 'administrasi_sep_rujukan': h = nilaiDokumen(alasanRaw, halaman); break;
    case 'indikasi_rawat_inap':
      h = nilaiPolaTunggal('ranap_indikasi', 'Ada surat/instruksi/indikasi rawat inap', POLA.indikasiRanap, 'SPRI / instruksi rawat inap', halaman); break;
    case 'icu_ventilator':
      h = nilaiPolaTunggal('icu_bukti', 'Ada catatan perawatan ICU/ventilator', POLA.icu, 'Catatan perawatan ICU / ventilator', halaman); break;
    case 'prb_obat_kronis':
      h = nilaiPolaTunggal('prb_bukti', 'Ada catatan PRB/obat kronis/kondisi stabil', POLA.prb, 'Catatan PRB / obat kronis', halaman); break;
    default:
      h = hasil(null, TANPA_KRITERIA, [k('kriteria_ada', 'Kategori punya kriteria triase otomatis', false)]);
  }
  return { ...dasar, ...h };
}

/** Kotak yang berlaku: putusan koder bila ada, kalau tidak hasil hitung. */
function kotakBerlaku(baris) {
  return (baris && (baris.kotak_manual || baris.kotak)) || null;
}

// ---- DB -------------------------------------------------------------------

/**
 * Hitung triase untuk baris rekap. Putusan manual (kotak_manual) tidak
 * ditimpa; hanya kolom hasil hitung yang diperbarui.
 */
async function hitungTriase(db, { pendingFileId, pendingId, ulang = false } = {}) {
  const { muatHalaman } = require('./buktiBerkasPendingService');
  let sql = `
    SELECT bpr.id, bpr.alasan_raw, bpr.claim_record_id, m.kategori, t.kriteria AS sudah
    FROM bpjs_pending_responses bpr
    LEFT JOIN pending_alasan_peta m ON m.pending_id = bpr.id
    LEFT JOIN pending_triase t ON t.pending_id = bpr.id
    WHERE 1=1`;
  const params = [];
  if (pendingId) { sql += ' AND bpr.id = ?'; params.push(pendingId); }
  if (pendingFileId) { sql += ' AND bpr.pending_file_id = ?'; params.push(pendingFileId); }
  const baris = await db.prepare(sql).all(...params);

  const rekap = { diperiksa: baris.length, dihitung: 0, dilewati: 0, tanpa_kategori: 0, per_kotak: { A: 0, B: 0, C: 0, D: 0, belum: 0 } };
  for (const b of baris) {
    if (!b.kategori) { rekap.tanpa_kategori++; continue; }
    if (b.sudah && !ulang) { rekap.dilewati++; continue; }
    let klaim = null;
    if (b.claim_record_id) {
      klaim = await db.prepare(`
        SELECT id, sep, jenis_klaim, diagnosa_list, prosedur_list FROM claim_records WHERE id = ?
      `).get(b.claim_record_id);
    }
    const halaman = klaim ? await muatHalaman(db, klaim.id) : [];
    const n = nilaiTriase({ alasan_raw: b.alasan_raw, kategori: b.kategori, klaim: klaim || null, halaman });
    await db.prepare(`
      INSERT INTO pending_triase (pending_id, kotak, alasan_kotak, kriteria, dokumen_dibutuhkan, jumlah_halaman, dihitung_pada)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (pending_id) DO UPDATE SET
        kotak = EXCLUDED.kotak, alasan_kotak = EXCLUDED.alasan_kotak, kriteria = EXCLUDED.kriteria,
        dokumen_dibutuhkan = EXCLUDED.dokumen_dibutuhkan, jumlah_halaman = EXCLUDED.jumlah_halaman,
        dihitung_pada = CURRENT_TIMESTAMP
    `).run(b.id, n.kotak, n.alasan_kotak, JSON.stringify(n.kriteria), JSON.stringify(n.dokumen_dibutuhkan), n.jumlah_halaman);
    rekap.dihitung++;
    rekap.per_kotak[n.kotak || 'belum']++;
  }
  return rekap;
}

/** Putusan koder atas kotak. kotak=null menghapus putusan manual. */
async function koreksiKotak(db, pendingId, kotak, catatan, userId) {
  if (kotak !== null && !KOTAK[kotak]) {
    const e = new Error('Kotak harus A, B, C, atau D.'); e.kode = 'kotak_tidak_valid'; throw e;
  }
  const ada = await db.prepare('SELECT id FROM bpjs_pending_responses WHERE id = ?').get(pendingId);
  if (!ada) { const e = new Error('Data pending tidak ditemukan.'); e.kode = 'tidak_ada'; throw e; }
  await db.prepare(`
    INSERT INTO pending_triase (pending_id, kotak_manual, catatan_manual, diubah_oleh)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (pending_id) DO UPDATE SET
      kotak_manual = EXCLUDED.kotak_manual, catatan_manual = EXCLUDED.catatan_manual, diubah_oleh = EXCLUDED.diubah_oleh
  `).run(pendingId, kotak, catatan || null, userId || null);
  return { pending_id: pendingId, kotak_manual: kotak };
}

async function ringkasanTriase(db, { pendingFileId } = {}) {
  let sql = `
    SELECT t.kotak, t.kotak_manual, m.jenis_rawat, m.kategori
    FROM bpjs_pending_responses bpr
    LEFT JOIN pending_triase t ON t.pending_id = bpr.id
    LEFT JOIN pending_alasan_peta m ON m.pending_id = bpr.id
    WHERE 1=1`;
  const params = [];
  if (pendingFileId) { sql += ' AND bpr.pending_file_id = ?'; params.push(pendingFileId); }
  const baris = await db.prepare(sql).all(...params);
  const kosong = () => ({ A: 0, B: 0, C: 0, D: 0, belum: 0 });
  const total = kosong();
  const perJenis = {};
  const perKategori = {};
  for (const b of baris) {
    const kk = kotakBerlaku(b) || 'belum';
    total[kk]++;
    const j = b.jenis_rawat || 'tidak_diketahui';
    (perJenis[j] || (perJenis[j] = kosong()))[kk]++;
    const kat = b.kategori || 'belum_dipetakan';
    (perKategori[kat] || (perKategori[kat] = kosong()))[kk]++;
  }
  return {
    total: baris.length,
    kotak: Object.values(KOTAK).map((x) => ({ ...x, jumlah: total[x.kode] })),
    belum_diklasifikasi: total.belum,
    per_jenis: perJenis,
    per_kategori: perKategori,
  };
}

module.exports = {
  KOTAK, DOKUMEN, POLA,
  nilaiTriase, kotakBerlaku, hitungTriase, koreksiKotak, ringkasanTriase,
};
