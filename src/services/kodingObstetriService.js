/**
 * Koding obstetri yang baku (ICD-10 WHO + ICD-9-CM), tanpa AI.
 *
 * Episode persalinan dikode lengkap: kondisi ibu (O00-O75), cara persalinan
 * (O80-O84) dan hasil persalinan (Z37). AI sering berhenti di kondisi ibu dan
 * memakai kode "unspecified": berkas YETY NOVIATI (0170R0111225V003427) diberi
 * O42.9 + 74.99, padahal casemix O42.1 + Z37.0 + O82.1 + 74.1.
 *
 * Setiap kode yang ditambah/diganti membawa kutipan dari berkas -- tanpa
 * kutipan tidak ada perubahan.
 */
const { deskripsiDiagnosis, deskripsiProsedur } = require('./kamusKodeService');

const SESAR = /\b(?:sectio\s*(?:caesar(?:ea)?|sesar(?:ea)?)?|seksio\s*sesar(?:ea)?|s\.?c\.?t\.?p\b|caesar|sesar)\b|kelahiran\s+dengan\s+cara\s*:?\s*sc\b/i;
const SESAR_KLASIK = /\b(?:klasik|classical|korporal|corporeal)\b/i;
const SESAR_EKSTRA = /ekstra\s*peritoneal|extraperitoneal/i;
const DARURAT = /\b(?:emergen(?:cy|si)|cito|darurat)\b/i;
const ELEKTIF = /\b(?:elekti[fv]e?|elective|terencana)\b/i;
// Formulir neonatus memuat pilihan cetak "lahir hidup/meninggal" -- bukan
// bukti; yang dipakai surat kelahiran ("Telah Lahir Pada ...") atau berat lahir.
const LAHIR_HIDUP = /\btelah\s+lahir\b|surat\s+(?:keterangan\s+)?kelahiran|berat\s+(?:badan|lahir)\s*:?\s*\d{3,4}\s*(?:gram|gr|g)\b/i;
const KEMBAR = /\b(?:gemell?[iy]|kembar|twin)\b/i;
const KPD = /\b(?:kpd|ketuban\s+pecah(?:\s+dini)?|prom)\b\s*(?:sejak\s*)?(?:±|\+|>|<)?\s*(\d+)\s*(hari|jam)/i;

function cariKutipan(halaman, pola) {
  for (const p of halaman) {
    const teks = String(p.ocr_text || p.text || '');
    const baris = teks.split(/\r?\n/).find(b => pola.test(b));
    if (baris) return { page_number: p.page_number || null, quotation: baris.trim().slice(0, 200) };
  }
  return null;
}

const NAMA_TINDAKAN = { '74.0': 'Seksio sesarea klasik', '74.1': 'Seksio sesarea segmen bawah rahim', '74.2': 'Seksio sesarea ekstraperitoneal' };

function entri(code, type, bukti, catatan) {
  return {
    nama_tindakan: NAMA_TINDAKAN[code] || null,
    code, type, kamus_valid: true,
    page_number: bukti ? bukti.page_number : null,
    quotation: bukti ? bukti.quotation : null,
    sumber_aturan: 'koding_obstetri',
    catatan_aturan: catatan,
  };
}

/**
 * @param {Array} saran suggested_codes (sudah lolos kamus & pagar)
 * @param {Array} halaman evidencePool [{page_number, ocr_text}]
 * @returns {{ saran: Array, perubahan: Array }}
 */
function lengkapiKodeObstetri(saran, halaman) {
  const daftar = Array.isArray(saran) ? saran.map(s => ({ ...s })) : [];
  const pool = Array.isArray(halaman) ? halaman : [];
  const perubahan = [];
  const aktif = (s, type) => s && !s._diganti && s.type === type && s.code && s.disangkal !== true && s.boleh_isi_otomatis !== false;
  const diag = () => daftar.filter(s => aktif(s, 'diagnosis')).map(s => String(s.code).toUpperCase());
  const pros = () => daftar.filter(s => aktif(s, 'procedure')).map(s => String(s.code));

  const adaSesarKode = pros().some(k => /^74\./.test(k));
  const buktiSesar = cariKutipan(pool, SESAR);
  const kasusObstetri = diag().some(k => /^O/.test(k)) || adaSesarKode;
  if (!kasusObstetri) return { saran: daftar, perubahan };
  const sesar = adaSesarKode || Boolean(buktiSesar);

  // 1. Jenis seksio: tanpa keterangan klasik/ekstraperitoneal = SC transperitoneal
  //    profunda (segmen bawah) 74.1, bukan 74.99 "unspecified type".
  if (sesar && buktiSesar) {
    const spesifik = cariKutipan(pool, SESAR_KLASIK) ? '74.0' : cariKutipan(pool, SESAR_EKSTRA) ? '74.2' : '74.1';
    const umum = daftar.filter(s => aktif(s, 'procedure') && /^74\.(?:9|99)$/.test(String(s.code)));
    const sudahSpesifik = pros().some(k => /^74\.[0-4]/.test(k));
    if (!sudahSpesifik) {
      for (const s of umum) s._diganti = true;
      daftar.push(entri(spesifik, 'procedure', buktiSesar,
        `Seksio sesarea tanpa keterangan jenis dikode ${spesifik} (${deskripsiProsedur(spesifik)})${umum.length ? `, menggantikan ${umum.map(s => s.code).join(', ')}` : ''}.`));
      perubahan.push({ aksi: umum.length ? 'ganti' : 'tambah', dari: umum.map(s => s.code), kode: spesifik });
    }
  }

  // 2. KPD: lama ketuban pecah menentukan O42.0 (<=24 jam) / O42.1 (>24 jam).
  const kpdUmum = daftar.filter(s => aktif(s, 'diagnosis') && /^O42(?:\.9)?$/i.test(String(s.code)));
  if (kpdUmum.length > 0) {
    const bukti = cariKutipan(pool, KPD);
    const m = bukti && KPD.exec(bukti.quotation);
    if (m) {
      const jam = Number(m[1]) * (/hari/i.test(m[2]) ? 24 : 1);
      const kode = jam > 24 ? 'O42.1' : 'O42.0';
      const posisi = daftar.indexOf(kpdUmum[0]);
      for (const s of kpdUmum) s._diganti = true;
      daftar.splice(posisi, 0, entri(kode, 'diagnosis', bukti,
        `Ketuban pecah ${m[1]} ${m[2]} -> ${kode} (${deskripsiDiagnosis(kode)}), menggantikan ${kpdUmum.map(s => s.code).join(', ')}.`));
      perubahan.push({ aksi: 'ganti', dari: kpdUmum.map(s => s.code), kode });
    }
  }

  // 3. Cara persalinan (O80-O84) dan hasil persalinan (Z37) sebagai sekunder.
  const bersalin = sesar || pros().some(k => /^(?:72\.|73\.[0-9])/.test(k));
  if (bersalin && sesar && !diag().some(k => /^O8[0-4]/.test(k))) {
    // Kepala formulir "CITO  ELEKTIF" (pilihan cetak) bukan keterangan.
    const pilihanCetak = b => DARURAT.test(b) && ELEKTIF.test(b);
    const dariBaris = (pola) => (buktiSesar && pola.test(buktiSesar.quotation) && !pilihanCetak(buktiSesar.quotation)
      ? buktiSesar : cariKutipan(pool, new RegExp(`^(?!.*(?:cito|emergen).*elekti|.*elekti.*(?:cito|emergen)).*${pola.source}`, 'i')));
    const darurat = dariBaris(DARURAT);
    const elektif = !darurat && dariBaris(ELEKTIF);
    const kode = darurat ? 'O82.1' : elektif ? 'O82.0' : 'O82.9';
    daftar.push(entri(kode, 'diagnosis', darurat || elektif || buktiSesar,
      `Episode persalinan dengan seksio sesarea: cara persalinan ${kode} (${deskripsiDiagnosis(kode)}).`));
    perubahan.push({ aksi: 'tambah', dari: [], kode });
  }
  if (bersalin && !diag().some(k => /^Z37/.test(k))) {
    const hidup = cariKutipan(pool, LAHIR_HIDUP);
    if (hidup) {
      const kode = cariKutipan(pool, KEMBAR) ? 'Z37.2' : 'Z37.0';
      daftar.push(entri(kode, 'diagnosis', hidup, `Hasil persalinan ${kode} (${deskripsiDiagnosis(kode)}).`));
      perubahan.push({ aksi: 'tambah', dari: [], kode });
    }
  }

  return { saran: daftar.filter(s => !s._diganti), perubahan };
}

module.exports = { lengkapiKodeObstetri };
