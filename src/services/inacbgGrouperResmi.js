/**
 * Grouper INA-CBG berbasis TABEL RESMI E-Klaim (bukan heuristik rentang).
 *
 * Sumber data: patch resmi E-Klaim INA-CBG 5.10.9 (inacbg.kemkes.go.id),
 * tabel MyISAM terbuka yang dibawa installer -- lihat src/data/inacbg/meta.json.
 * TIDAK ada berkas terenkripsi (.iccdb iDRG / grouper ber-ionCube) yang dibuka
 * untuk membangun ini; hanya tabel referensi yang memang terbuka.
 *
 * Yang RESMI & PASTI di sini:
 *   - Base CBG dari diagnosis utama  (src/data/inacbg/grouperDiagnosis.json:
 *     kolom Inpatient/Outpatient tabel alt_diagnosis).
 *   - Kandidat base dari prosedur (alt_procedures) dan urutan hierarki
 *     alt_hierarchy1 (IP), alt_hierarchy2/3 (OP). Tabel kandidat belum mencakup
 *     seluruh pengecualian dan kondisi mesin grouper.
 *   - Tarif per kelas & rawat jalan  (tarif.json: tabel tariff_20230124, irisan
 *     profil RS di meta.json, default Regional 1 x Kelas D Swasta).
 *
 * Yang BELUM resmi (estimasi):
 *   - Severity I/II/III. Patch juga membawa c51cclm terbuka, tetapi c51dc
 *     (pemetaan dccol) hanya mencakup 6 kelompok COVID-19. Data tambahan
 *     tersimpan di referensiTambahan.json; belum cukup untuk severity umum.
 *     Severity default = I (paling konservatif, tidak pernah menaikkan
 *     tarif tanpa dasar). `severity_estimasi: true` menandai ini. Perhitungan
 *     aplikasi berdiri sendiri; hasil mesin E-Klaim dipakai untuk verifikasi.
 */

const dxTable = require('../data/inacbg/grouperDiagnosis.json');
const pxTable = require('../data/inacbg/grouperProsedur.json');
const hierarki = require('../data/inacbg/grouperHierarki.json');
const tarifTable = require('../data/inacbg/tarif.json');
const META = require('../data/inacbg/meta.json');
const tambahan = require('../data/inacbg/referensiTambahan.json');
const VERSI_PERKIRAAN = '2026-10-07.1';
// Dua tingkat prioritas prosedur OP terpisah. ID di hierarchy3 dimulai ulang
// dari 1; tidak boleh dibandingkan langsung dengan ID hierarchy2.
const hierarkiOp = Object.fromEntries([2, 3].flatMap((n) =>
  (tambahan.tabel[`casemix.alt_hierarchy${n}`] || [])
    .filter(r => r.InOut === 'OP')
    .map(r => [r.DRG.trim(), (n - 2) * 10000 + Number(r.ID)])));

const norm = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Base CBG resmi untuk satu kode (rawat inap / rawat jalan). */
function baseDiagnosis(kode, rawatInap) {
  const r = dxTable[norm(kode)];
  if (!r) return [];
  return rawatInap ? (r.ip || []) : (r.op || []);
}
function baseProsedur(kode, rawatInap) {
  const r = pxTable[norm(kode)];
  if (!r) return [];
  return rawatInap ? (r.ip || []) : (r.op || []);
}

/** Tabel mengenali prosedur ini, tetapi tidak memetakannya sebagai pemicu base rawat inap. */
function tanpaBaseRawatInap(kode) {
  const r = pxTable[norm(kode)];
  return Boolean(r && Array.isArray(r.ip) && r.ip.length === 0);
}

/** Tarif resmi untuk kode CBG penuh (mis. "A-4-13-II"). */
function tarifResmi(kodeInacbg, kelasRawat, jenisKlaim) {
  const row = tarifTable[String(kodeInacbg || '').trim().toUpperCase()];
  if (!row) return { tarif: null, status: 'KODE_TIDAK_ADA' };
  const rawatInap = !/JALAN/i.test(String(jenisKlaim || '')) && String(jenisKlaim || '') !== 'RAWAT_JALAN';
  // Rawat jalan di tabel resmi = KELAS_RAWAT '0'. Rawat inap = '1'/'2'/'3'.
  if (!rawatInap) {
    const t = row['0'];
    return t != null ? { tarif: t, kelas: '0', status: 'OK' } : { tarif: null, status: 'TIDAK_BERLAKU_RJ' };
  }
  const kelas = String(Number(kelasRawat));
  if (['1', '2', '3'].includes(kelas) && row[kelas] != null) return { tarif: row[kelas], kelas, status: 'OK' };
  // kelas tak diketahui tetapi kode day-care hanya punya '0'
  if (row['0'] != null && row['1'] == null) return { tarif: row['0'], kelas: '0', status: 'OK' };
  return { tarif: null, status: 'KELAS_TIDAK_DIKETAHUI' };
}

/**
 * Menentukan base CBG (tanpa severity) dari diagnosis + prosedur.
 * @returns {{base, via, prosedur}|null}
 */
function tentukanBase(dxs, pxs, rawatInap) {
  const diags = (dxs || []).map(norm).filter(Boolean);
  const procs = (pxs || []).map(p => String(p || '').trim()).filter(Boolean);
  if (!diags.length) return null;

  const opsi = baseDiagnosis(diags[0], rawatInap);
  // Kolom IP/OP menentukan apakah prosedur memicu kelompok. Nomor >=87
  // bukan alasan membuang prosedur: nebulisasi/perawatan luka/USG memiliki
  // base OP; angiografi/intubasi tertentu juga mempunyai base IP.
  // OP memakai hierarki 2/3. Layanan medis umum dari prosedur (mis. interview
  // 89.xx -> kelompok jiwa) hanya dipakai bila sesuai kandidat diagnosis;
  // sebutan pemeriksaan rutin tidak otomatis mengubah pelayanan utamanya.
  const prioritas = rawatInap ? hierarki : hierarkiOp;
  const kandidat = [];
  for (const p of procs) {
    for (const g of baseProsedur(p, rawatInap)) {
      if (!rawatInap && prioritas[g] == null && !opsi.includes(g)) continue;
      kandidat.push({ grup: g, prosedur: p });
    }
  }
  if (kandidat.length) {
    kandidat.sort((a, b) => (prioritas[a.grup] ?? 99999) - (prioritas[b.grup] ?? 99999)
      || a.grup.localeCompare(b.grup) || norm(a.prosedur).localeCompare(norm(b.prosedur)));
    const unik = kandidat.filter((c, i) => kandidat.findIndex(k => k.grup === c.grup) === i);
    return { base: kandidat[0].grup, via: 'prosedur', prosedur: kandidat[0].prosedur,
      sumber_hierarki: rawatInap ? 'alt_hierarchy1' : 'alt_hierarchy2/3',
      kandidat_base: unik.map(c => ({ base: c.grup, prosedur: c.prosedur })),
      base_perlu_verifikasi: unik.length > 1 };
  }

  // 2. Diagnosis utama. Bila ada beberapa opsi, buang dulu kelompok BEDAH
  //    (casemix 1/2/3) -- itu hanya berlaku kalau ada prosedurnya (yang sudah
  //    ditangani di langkah 1). Dari sisanya ambil opsi PERTAMA (urutan tabel
  //    resmi = prioritas). Contoh: T31 "L-1-20,S-4-16" -> S-4-16 (L-1-20 bedah,
  //    tak ada prosedur); P07.3 "P-8-17,Z-4-12" -> P-8-17 (opsi pertama).
  if (!opsi.length) return null;
  const nonBedah = opsi.filter(g => !(rawatInap ? /^[A-Z]-[123]-/ : /^[A-Z]-[1237]-|^X-0-/).test(g));
  // Diagnosis antepartum tidak membuktikan tindakan persalinan OP (-7-).
  // Konseling tanpa prosedur tidak membuktikan MCU/ECG/vaksinasi/pasang infus.
  // Bila tabel menyediakan konsultasi umum, gunakan sebagai acuan dan tandai
  // kebutuhan verifikasi layanan khusus yang belum tercatat.
  const konsultasi = !rawatInap && nonBedah.includes('Q-5-18');
  const base = konsultasi ? 'Q-5-18' : nonBedah[0];
  if (!base) return null;
  return { base, via: 'diagnosis', prosedur: null,
    kandidat_base: (konsultasi ? nonBedah : [base]).map(g => ({ base: g, prosedur: null })),
    base_perlu_verifikasi: !!konsultasi && nonBedah.length > 1,
    catatan_base: konsultasi && nonBedah.length > 1
      ? 'Konseling/konsultasi menjadi acuan sementara. Jenis pemeriksaan khusus belum dibuktikan oleh daftar prosedur.' : null };
}

/**
 * Grouper resmi. Mengembalikan kode CBG penuh + tarif, atau null bila kode
 * primer tidak ada di tabel resmi.
 * @param {string[]} diagnosisCodes - urutan pertama = diagnosis utama
 * @param {string[]} procedureCodes
 * @param {string} jenisKlaim - 'RAWAT_INAP' | 'RAWAT_JALAN'
 * @param {number|string} kelasRawat
 */
function grouperResmi(diagnosisCodes, procedureCodes = [], jenisKlaim = 'RAWAT_INAP', kelasRawat = 3) {
  const rawatInap = jenisKlaim !== 'RAWAT_JALAN';
  const b = tentukanBase(diagnosisCodes, procedureCodes, rawatInap);
  if (!b) return null;

  // Severity: estimasi konservatif = I. Rawat jalan memakai akhiran '0'.
  const severity = rawatInap ? 'I' : '0';
  const code = /-\d-\d+-[0IVX]+$/i.test(b.base) ? b.base : `${b.base}-${severity}`;
  const t = tarifResmi(code, kelasRawat, jenisKlaim);

  return {
    code,
    base: b.base,
    via: b.via,
    prosedur: b.prosedur,
    severity_estimasi: rawatInap, // severity I belum dari matriks CC resmi
    tarif: t.tarif,
    tarif_status: t.status,
    sumber: 'grouper_resmi_tabel_eklaim',
    confidence: b.via === 'prosedur' ? 0.75 : 0.65,
    versi_perkiraan: VERSI_PERKIRAAN,
    kandidat_base: b.kandidat_base,
    base_perlu_verifikasi: !!b.base_perlu_verifikasi,
    reasoning: (b.via === 'prosedur'
      ? `Base CBG ${b.base} dari prosedur ${b.prosedur} (alt_procedures, urutan ${b.sumber_hierarki}), diagnosis utama ${norm(diagnosisCodes[0])}.`
      : `Base CBG ${b.base} dari diagnosis utama ${norm(diagnosisCodes[0])} (alt_diagnosis).`)
      + (rawatInap ? ' Severity I = estimasi (matriks CC umum belum lengkap).' : ' Rawat jalan menggunakan tarif tunggal dengan akhiran 0.')
      + (b.catatan_base ? ` ${b.catatan_base}` : ''),
  };
}

module.exports = {
  grouperResmi, tarifResmi, tentukanBase, baseDiagnosis, baseProsedur, tanpaBaseRawatInap,
  PROFIL: META.profil, META, VERSI_PERKIRAAN,
};
