/**
 * Koding luka bakar baku (deterministik, setiap kode berkutipan) mengikuti
 * casemix RS (lembar grouper MUSTAKIMAH 0170R0111225V003200):
 *   T31.x luas permukaan (diagnosis utama bila dokter menulis luas %)
 *   + T20-T25 per lokasi dengan derajatnya (grade 1 -> .1, 2/2A/2B -> .2, 3 -> .3)
 *   + penyebab luar X00-X19 (api -> X09 bila jenis api tidak dirinci) dengan
 *     karakter ke-4 tempat kejadian; tempat yang tidak tertulis -> .9.
 * Lokasi dan derajat diambil dari status lokalis / anamnesis resume & triase.
 */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { deskripsiDiagnosis } = require('./kamusKodeService');

const LUKA_BAKAR = /combust|luka\s+bakar|\bburn/i;

// Urutan penting: lokasi spesifik dulu (pergelangan/telapak kaki sebelum "kaki").
const LOKASI = [
  ['T20', 'kepala dan leher', /\b(?:wajah|muka|kepala|leher|telinga|kulit\s+kepala|pipi|dahi|bibir|hidung)\b/i],
  ['T21', 'badan', /\b(?:dada|perut|punggung|pinggang|badan|bokong|genital|abdomen|thorax|toraks)\b/i],
  ['T25', 'pergelangan kaki dan kaki', /\b(?:pergelangan\s+kaki|telapak\s+kaki|punggung\s+kaki|jari\s+kaki|tumit)\b/i],
  ['T23', 'pergelangan tangan dan tangan', /\b(?:tangan|jari(?!\s+kaki)|pergelangan\s+tangan|telapak\s+tangan)\b/i],
  ['T22', 'bahu dan lengan', /\b(?:bahu|lengan|siku|ketiak)\b/i],
  ['T24', 'tungkai', /\b(?:tungkai|paha|lutut|betis|kaki)\b/i],
];

// Penyebab luar luka bakar; karakter ke-4 = tempat kejadian.
const PENYEBAB = [
  [/air\s+panas|tersiram|minyak\s+panas|uap\s+panas|kuah\s+panas/i, 'X12', 'cairan panas'],
  [/listrik|tersengat|kesetrum/i, 'W87', 'arus listrik'],
  [/\b(?:api|kebakaran|kompor|terbakar|ledakan\s+gas)\b/i, 'X09', 'api/asap'],
];
const TEMPAT = [
  [/\b(?:warung|berjualan|jualan|berdagang|dagang|toko|kios|restoran|rumah\s+makan|mie\s+ayam|bakso|angkringan)\b/i, '5', 'area dagang/jasa'],
  [/\b(?:pabrik|bengkel|proyek|tempat\s+kerja|saat\s+bekerja)\b/i, '6', 'area industri/konstruksi'],
  [/\b(?:sawah|kebun|ladang|kandang)\b/i, '7', 'pertanian'],
  [/\b(?:jalan\s+raya|di\s+jalan)\b/i, '4', 'jalan'],
  [/\b(?:di\s+rumah|dapur\s+rumah|rumah)\b/i, '0', 'rumah'],
];

function derajat(teks) {
  const m = /(?:grade|gr\.?|derajat|deg(?:ree)?)\s*(I{1,3}|[123])\s*([AB])?/i.exec(teks);
  if (!m) return null;
  const n = { I: 1, II: 2, III: 3 }[m[1].toUpperCase()] || Number(m[1]);
  return n >= 1 && n <= 3 ? n : null;
}

function halamanSumber(pages) {
  return (pages || []).filter(p => ['resume_medis', 'triase_igd'].includes(classifyPageDocumentType(String(p.ocr_text || ''))));
}

/** Baris (dengan baris sambungan) yang menyebut luka bakar. */
function barisLukaBakar(pages) {
  const hasil = [];
  for (const p of halamanSumber(pages)) {
    const baris = String(p.ocr_text || '').split(/\r?\n/);
    for (let i = 0; i < baris.length; i++) {
      if (!LUKA_BAKAR.test(baris[i])) continue;
      const blok = [baris[i], baris[i + 1] || ''].join(' ').replace(/\s+/g, ' ').trim();
      hasil.push({ halaman: p.page_number, kutipan: baris[i].trim().slice(0, 200), blok });
    }
  }
  return hasil;
}

/**
 * @param {Array} saran suggested_codes
 * @param {Array} pages halaman berkas
 * @returns {{saran: Array, perubahan: Array}}
 */
function lengkapiKodeLukaBakar(saran, pages) {
  const daftar = Array.isArray(saran) ? saran.map(s => ({ ...s })) : [];
  const perubahan = [];
  const dx = () => daftar.filter(s => s && s.type === 'diagnosis' && s.code && s.disangkal !== true).map(s => String(s.code).toUpperCase());
  // Hanya bila luka bakar memang diagnosis (T20-T32 sudah dikode, atau resume menulis luka bakar sebagai diagnosis).
  const sumber = barisLukaBakar(pages);
  if (!sumber.length) return { saran: daftar, perubahan };
  const adaDxBakar = dx().some(k => /^T(?:2\d|3[0-2])/.test(k));
  if (!adaDxBakar && !sumber.some(s => /diagnos/i.test(s.blok) || /combustio/i.test(s.blok))) return { saran: daftar, perubahan };

  const tambah = (kode, b, catatan) => {
    if (!deskripsiDiagnosis(kode) || dx().includes(kode)) return;
    daftar.push({ code: kode, type: 'diagnosis', kamus_valid: true, page_number: b.halaman, quotation: b.kutipan,
      sumber_aturan: 'koding_luka_bakar', catatan_aturan: catatan });
    perubahan.push({ aksi: 'tambah', kode });
  };

  // Derajat: ambil yang tertinggi yang tertulis.
  const deg = Math.max(0, ...sumber.map(s => derajat(s.blok) || 0)) || null;
  const teksSemua = sumber.map(s => s.blok).join(' ');

  // Lokasi: baris status lokalis/anamnesis yang menyebut luka bakar.
  if (deg) {
    const sudah = new Set();
    for (const s of sumber) {
      for (const [kat, nama, pola] of LOKASI) {
        if (sudah.has(kat) || !pola.test(s.blok)) continue;
        // "pergelangan kaki" tidak dihitung lagi sebagai "kaki" (tungkai).
        if (kat === 'T24' && !/\b(?:tungkai|paha|lutut|betis)\b/i.test(s.blok) && /\b(?:pergelangan\s+kaki|telapak\s+kaki|punggung\s+kaki|jari\s+kaki)\b/i.test(s.blok)
          && !/\bkaki\s+(?:kanan|kiri)\b/i.test(s.blok)) continue;
        sudah.add(kat);
        tambah(`${kat}.${deg}`, s, `Luka bakar derajat ${deg} di ${nama} -> ${kat}.${deg} (${deskripsiDiagnosis(`${kat}.${deg}`)}).`);
      }
    }
  }

  // Penyebab luar + tempat kejadian.
  if (!dx().some(k => /^[VWXY]\d/.test(k))) {
    const p = PENYEBAB.find(([pola]) => pola.test(teksSemua));
    if (p) {
      const t = TEMPAT.find(([pola]) => pola.test(teksSemua));
      const kode = `${p[1]}.${t ? t[1] : '9'}`;
      const b = sumber.find(s => p[0].test(s.blok)) || sumber[0];
      tambah(kode, b, `Penyebab luar: ${p[2]}${t ? `, tempat ${t[2]}` : ', tempat kejadian tidak tertulis'} -> ${kode}. ${t ? 'Tempat ditafsirkan dari anamnesis; konfirmasi bila berbeda.' : ''}`.trim());
    }
  }

  // T31 (luas) sebagai diagnosis utama bila ada: urutan casemix RS T31.x lalu lokasi.
  const iT31 = daftar.findIndex(s => s && s.type === 'diagnosis' && /^T31/.test(String(s.code)));
  const iDxPertama = daftar.findIndex(s => s && s.type === 'diagnosis');
  if (iT31 > iDxPertama && iDxPertama !== -1 && /^T(?:2\d|3[0-2])/.test(String(daftar[iDxPertama].code))) {
    const [t31] = daftar.splice(iT31, 1);
    daftar.splice(iDxPertama, 0, t31);
  }
  return { saran: daftar, perubahan };
}

module.exports = { lengkapiKodeLukaBakar, derajat };
