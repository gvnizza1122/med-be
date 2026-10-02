/**
 * Koding tindakan bedah yang lazim (ortopedi & bedah umum), tanpa AI.
 *
 * Nama operasi di resume/laporan operasi ("ORIF femur dextra", "apendektomi",
 * "herniorafi") selama ini dikode AI per istilah dan sering jatuh ke kode
 * "unspecified" (74.99, 79.30) -- kode tanpa lokasi tulang tidak bisa
 * dikelompokkan ke CMG bedah, sehingga INA-CBG jatuh ke kelompok medis.
 *
 * Hanya halaman resume medis & laporan operasi yang dibaca, dan rencana
 * ("pro ORIF", "rencana operasi") tidak dihitung sebagai tindakan. Setiap kode
 * diperiksa ke kamus ICD-9-CM dan membawa kutipan dari berkas.
 */
const { deskripsiProsedur } = require('./kamusKodeService');
const { classifyPageDocumentType } = require('./pdfPageClassifier');

// Lokasi tulang -> digit lokasi ICD-9-CM. 79.x dan 77/78.x memakai digit
// berbeda (lihat inacbgGroupingService.kelompokTulang).
const LOKASI = [
  { pola: /\b(?:femur|femoris|paha|collum\s+femur|intertrochanter\w*|subtrochanter\w*)\b/i, d79: 5, d78: 5, nama: 'femur' },
  { pola: /\b(?:tibia|fibula|cruris|kruris|maleol\w*|malleol\w*|pilon|plateau\s+tibia|ankle|bimaleol\w*)\b/i, d79: 6, d78: 7, nama: 'tibia/fibula' },
  { pola: /\b(?:humerus|humeri|supracondyl\w*|suprakondil\w*)\b/i, d79: 1, d78: 2, nama: 'humerus' },
  { pola: /\b(?:radius|ulna|antebrachi\w*|antebraki\w*|colles|galeazzi|monteggia)\b/i, d79: 2, d78: 3, nama: 'radius/ulna' },
  { pola: /\b(?:metacarpal\w*|metakarpal\w*|carpal\w*|karpal\w*|scaphoid|skafoid)\b/i, d79: 3, d78: 4, nama: 'karpal/metakarpal' },
  { pola: /\b(?:metatarsal\w*|tarsal\w*|calcaneus|kalkaneus|talus)\b/i, d79: 7, d78: 8, nama: 'tarsal/metatarsal' },
  { pola: /\b(?:clavicula\w*|klavikula\w*|clavicle)\b/i, d79: 9, d78: 1, nama: 'klavikula' },
];
// Diagnosis fraktur ICD-10 -> lokasi, bila nama tulang tidak tertulis.
const LOKASI_DARI_DIAGNOSIS = [
  [/^S72/, 'femur'], [/^S82/, 'tibia/fibula'], [/^S42\.[2-4]/, 'humerus'], [/^S42\.0/, 'klavikula'],
  [/^S52/, 'radius/ulna'], [/^S62/, 'karpal/metakarpal'], [/^S92\.[0-3]/, 'tarsal/metatarsal'],
];

// Rencana ("pro ORIF") dan riwayat ("post ORIF", "s/p apendektomi") bukan
// tindakan episode ini.
const RENCANA = /\b(?:pro|rencana|rencanakan|planning|plan|usul\w*|konsul\w*|jadwal\w*|indikasi|post|pasca|paska|riwayat|rwy|status\s+post|s\s*\/\s*p)\s*[:.]?\s*$/i;

// [pola, kode atau fungsi(baris, lokasi) -> kode, nama]
const ISTILAH = [
  [/\b(?:orif|open\s+reduction|reposisi\s+terbuka)\b/i, (lok) => (lok ? `79.3${lok.d79}` : null), 'ORIF'],
  [/\b(?:crif|closed\s+reduction\s+(?:and\s+)?internal|reposisi\s+tertutup\s+(?:dan\s+)?fiksasi\s+interna)\b/i, (lok) => (lok ? `79.1${lok.d79}` : null), 'CRIF'],
  [/\b(?:ofe|oref|external\s+fixat\w*|fiksasi\s+eksterna|fiksator\s+eksterna)\b/i, (lok) => (lok ? `78.1${lok.d78}` : null), 'Fiksasi eksterna'],
  [/\b(?:aff|lepas|pengangkatan|removal)\s+(?:of\s+)?(?:implant?\w*|plate\w*|screw\w*|k[\s-]?wire|wire|nail\w*|pen)\b/i, (lok) => (lok ? `78.6${lok.d78}` : null), 'Pengangkatan implan'],
  [/\b(?:total\s+knee|tkr|tka)\b/i, '81.54', 'Artroplasti lutut total'],
  [/\b(?:total\s+hip|thr|tha)\b/i, '81.51', 'Artroplasti panggul total'],
  [/\b(?:hemiarthroplast\w*|hemiartroplasti|bipolar|austin\s+moore)\b/i, '81.52', 'Hemiartroplasti panggul'],
  [/\bamputasi\s+(?:below\s+knee|bawah\s+lutut|bk)\b|\bbka\b/i, '84.15', 'Amputasi bawah lutut'],
  [/\bamputasi\s+(?:above\s+knee|atas\s+lutut|ak)\b|\baka\b/i, '84.17', 'Amputasi atas lutut'],
  [/\b(?:laparoskopi\w*\s+apend\w*|lap\.?\s*appendectomy|laparoscopic\s+appendectomy)\b/i, '47.01', 'Apendektomi laparoskopik'],
  [/\b(?:apendektomi|appendectomy|apendiktomi|appendektomi|appendiktomi)\b/i, '47.09', 'Apendektomi'],
  [/\b(?:laparotomi\s+eksplor\w*|explorative\s+laparotomy|eksplorasi\s+laparotomi|laparotomi)\b/i, '54.11', 'Laparotomi eksplorasi'],
  [/\b(?:lap\.?\s*chole|laparoscopic\s+cholecystectomy|kolesistektomi\s+laparoskop\w*)\b/i, '51.23', 'Kolesistektomi laparoskopik'],
  [/\b(?:kolesistektomi|cholecystectomy)\b/i, '51.22', 'Kolesistektomi'],
  [/\b(?:hernioplast\w*|lichtenstein|mesh)\b/i, '53.05', 'Repair hernia inguinal dengan mesh'],
  [/\b(?:herniotomi|herniorafi|herniorrhaphy|herniotomy)\b/i, '53.00', 'Repair hernia inguinal'],
  [/\b(?:hemoroidektomi|haemorrhoidectomy|hemorrhoidectomy)\b/i, '49.46', 'Hemoroidektomi'],
  [/\b(?:fistulektomi|fistulectomy)\b/i, '49.12', 'Fistulektomi ani'],
  [/\b(?:insisi\s+(?:dan\s+)?drainase\s+abses\s+perianal|insisi\s+abses\s+perianal)\b/i, '49.01', 'Insisi abses perianal'],
  [/\b(?:debridement|debridemen|necrotomi|nekrotomi)\b/i, '86.22', 'Debridemen eksisional'],
  [/\b(?:eksisi|ekstirpasi|excision)\s+(?:fam|fibroadenoma|tumor\s+mamm\w*|benjolan\s+payudara)\b/i, '85.21', 'Eksisi lesi payudara'],
  [/\b(?:eksisi|ekstirpasi|excision)\s+(?:lipoma|kista|atheroma|ateroma|tumor\s+jaringan\s+lunak|soft\s+tissue\s+tumor|clavus|kalus|nevus|keloid)\b/i, '86.3', 'Eksisi lesi kulit/subkutis'],
  [/\b(?:sirkumsisi|circumcisi\w*|khitan)\b/i, '64.0', 'Sirkumsisi'],
  [/\b(?:hidrokelektomi|hydrocelectomy|eksisi\s+hidrokel)\b/i, '61.2', 'Eksisi hidrokel'],
  [/\b(?:orchidopexy|orkidopeksi|orchiopexy)\b/i, '62.5', 'Orkidopeksi'],
  [/\b(?:tonsilektomi|tonsillectomy)\b/i, '28.2', 'Tonsilektomi'],
];

function lokasiDari(teks, diagnosis) {
  const tertulis = LOKASI.find(l => l.pola.test(teks));
  if (tertulis) return tertulis;
  for (const kode of diagnosis) {
    const cocok = LOKASI_DARI_DIAGNOSIS.find(([pola]) => pola.test(kode));
    if (cocok) return LOKASI.find(l => l.nama === cocok[1]);
  }
  return null;
}

function halamanBedah(pool) {
  return pool.filter(p => {
    const jenis = classifyPageDocumentType(String(p.ocr_text || p.text || ''));
    return jenis === 'resume_medis' || jenis === 'laporan_operasi';
  });
}

/**
 * @param {Array} saran suggested_codes
 * @param {Array} halaman evidencePool [{page_number, ocr_text}]
 * @returns {{ saran: Array, perubahan: Array }}
 */
function lengkapiKodeBedah(saran, halaman) {
  const daftar = Array.isArray(saran) ? saran.map(s => ({ ...s })) : [];
  const perubahan = [];
  const diagnosis = daftar.filter(s => s && s.type === 'diagnosis' && s.code && s.disangkal !== true).map(s => String(s.code).toUpperCase());
  const adaKode = k => daftar.some(s => s && s.type === 'procedure' && !s._diganti && String(s.code) === k);

  for (const p of halamanBedah(Array.isArray(halaman) ? halaman : [])) {
    for (const baris of String(p.ocr_text || p.text || '').split(/\r?\n/)) {
      // Satu tindakan per kelompok kode per baris: "herniotomi + hernioplasti
      // mesh" -> 53.05 saja (istilah spesifik ada di atas daftar).
      const kelompokBaris = new Set();
      for (const [pola, kodeAtauFn, nama] of ISTILAH) {
        const m = pola.exec(baris);
        if (!m || RENCANA.test(baris.slice(0, m.index))) continue;
        const lokasi = typeof kodeAtauFn === 'function' ? lokasiDari(baris, diagnosis) : null;
        const kode = typeof kodeAtauFn === 'function' ? kodeAtauFn(lokasi) : kodeAtauFn;
        if (!kode || kelompokBaris.has(kode.slice(0, 3))) continue;
        kelompokBaris.add(kode.slice(0, 3));
        if (!deskripsiProsedur(kode) || adaKode(kode)) continue;
        // Kode tanpa lokasi/jenis untuk tindakan yang sama (79.30, 79.39 ...)
        // diganti yang spesifik.
        const umum = new RegExp(`^${kode.slice(0, 4).replace('.', '\\.')}[09]$`);
        const diganti = daftar.filter(s => s && s.type === 'procedure' && !s._diganti && umum.test(String(s.code)) && String(s.code) !== kode);
        for (const s of diganti) s._diganti = true;
        daftar.push({
          code: kode, type: 'procedure', kamus_valid: true,
          nama_tindakan: `${nama}${lokasi ? ` ${lokasi.nama}` : ''}`,
          page_number: p.page_number || null, quotation: baris.trim().slice(0, 200),
          sumber_aturan: 'koding_bedah',
          catatan_aturan: `${nama}${lokasi ? ` ${lokasi.nama}` : ''} -> ${kode} (${deskripsiProsedur(kode)})${diganti.length ? `, menggantikan ${diganti.map(s => s.code).join(', ')}` : ''}.`,
        });
        perubahan.push({ aksi: diganti.length ? 'ganti' : 'tambah', dari: diganti.map(s => s.code), kode });
      }
    }
  }
  return { saran: daftar.filter(s => !s._diganti), perubahan };
}

/**
 * Berkas memuat operasi (laporan operasi, lembar anestesi, atau tagihan
 * "Operasi ...") tetapi tidak ada satu pun kode tindakan operasi. Isian
 * laporan operasi umumnya tulisan tangan dan sering tidak terbaca OCR --
 * operasinya tetap terjadi, jadi koder diingatkan, bukan dipending.
 * (ANNISA NUR CHASANAH: laporan operasi tulisan tangan tak terbaca; bukti
 * yang jelas justru tagihan "Operasi Kecil" di rincian biaya.)
 * @returns {object|null} temuan konsistensi_data
 */
function periksaOperasiTanpaKode(saran, halaman, proclist = '') {
  const { adalahProsedurBedah } = require('./inacbgGroupingService');
  const pool = Array.isArray(halaman) ? halaman : [];
  let bukti = null;
  for (const p of pool) {
    const teks = String(p.ocr_text || p.text || '');
    const jenis = classifyPageDocumentType(teks);
    const tagihan = jenis === 'rincian_biaya' && (teks.split(/\r?\n/).find(b => /\boperasi\s+(?:kecil|sedang|besar|khusus|canggih)\b|\bjasa\s+operator\b|\bsewa\s+(?:ok|kamar\s+operasi)\b/i.test(b)));
    if (tagihan) { bukti = { kutipan: tagihan.trim().slice(0, 160), page_number: p.page_number }; break; }
    if (!bukti && jenis === 'laporan_operasi') bukti = { kutipan: /lembar\s+anest/i.test(teks) ? 'Lembar anestesi' : 'Laporan operasi', page_number: p.page_number };
  }
  if (!bukti) return null;
  const kode = [
    ...(Array.isArray(saran) ? saran.filter(s => s && s.type === 'procedure' && s.code && s.disangkal !== true).map(s => String(s.code)) : []),
    ...String(proclist || '').split(/[;,]/).map(k => k.trim()).filter(Boolean),
  ];
  if (kode.some(adalahProsedurBedah)) return null;
  return {
    id: 'KD-OP', nama: 'Ada operasi, tetapi kode tindakan operasi belum ada',
    keparahan: 'sedang', diverifikasi: true,
    pesan: 'Berkas memuat operasi, tetapi daftar prosedur belum berisi kode tindakan operasi. Isian laporan operasi tulisan tangan sering tidak terbaca OCR -- lihat laporan operasi/resume dan isi kode tindakannya.',
    yang_dicari: 'kode ICD-9-CM tindakan operasi sesuai laporan operasi',
    yang_ditemukan: bukti,
  };
}

module.exports = { lengkapiKodeBedah, periksaOperasiTanpaKode };
