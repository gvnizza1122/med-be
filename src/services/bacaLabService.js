/**
 * Baca tabel laboratorium per BARIS (kesalahan tipe 2: teks benar, tempat salah;
 * tipe 1: huruf salah pada angka).
 *
 * Satu baris = parameter . nilai . satuan . rujukan . flag (H/L) . tanggal,
 * semuanya dibaca dari SATU baris teks yang sama. Nilai tidak pernah diambil
 * dari baris tetangga. Bila sebuah baris tidak lengkap, ia tetap dikembalikan
 * apa adanya dan ditandai, bukan dilengkapi dari baris lain.
 *
 * Pemeriksa kewajaran menandai nilai yang tidak masuk akal sebagai
 * "tidak dapat dipakai memutuskan syarat klaim":
 *   - Hb 120 g/dL  => mustahil, kemungkinan 12.0 (atau 120 g/L)
 *   - Ht 470 %     => mustahil, kemungkinan 47.0
 *   - trombosit 150 vs 150.000 => dinormalkan menurut SATUAN; satuan tak jelas
 *     ditandai ambigu, tidak ditebak diam-diam
 *   - huruf terselip pada angka ("1O,2") => dikoreksi dan ditandai, tidak
 *     dipakai memutuskan
 *   - flag cetak bertentangan dengan nilai (cetak L, nilai di rentang normal)
 *     => salah satunya keliru, tidak dipakai memutuskan
 *   - satuan tak cocok dengan parameter (Hb dalam mg/dL) => kolom bergeser
 *
 * Beberapa tanggal (rawat inap): setiap baris membawa `tanggal`; trombosit hari
 * ke-1 dan ke-3 adalah dua baris berbeda dan tidak pernah saling menimpa.
 *
 * Nama parameter dinormalkan dengan kamusPenunjangService (cocokkan) ditambah
 * alias lokal untuk parameter yang di kamus bergabung (kreatinin/ureum, dll).
 *
 * STATUS: ekstraksi baris lab dan serologi diuji pada PDF asli lokal serta
 * fixture sintetis. Pemakaian nilai untuk syarat klaim aktif secara default;
 * SYARAT_PAKAI_BACA_LAB=false mematikannya.
 */

const { cocokkan, rapikan } = require('./kamusPenunjangService');

// ── parameter yang diperiksa kewajarannya ───────────────────────────────────
// mustahil: di luar rentang ini tidak mungkin pada manusia hidup.
// inti: rentang normal sempit, hanya untuk uji silang flag bila rujukan tidak dicetak.
// satuanDiterima: bentuk satuan (sudah dinormalkan) yang cocok dengan parameter.
const PARAMETER = {
  hemoglobin: { baku: 'Hemoglobin', satuan: 'g/dl', satuanDiterima: ['g/dl', 'g/l'], konversi: { 'g/l': 0.1 }, mustahil: [1, 25], inti: [12.5, 15] },
  hematokrit: { baku: 'Hematokrit', satuan: '%', satuanDiterima: ['%'], mustahil: [5, 75], inti: [38, 46] },
  trombosit: { baku: 'Trombosit', satuan: '/ul', satuanDiterima: ['/ul', 'ribu/ul'], perUl: true, mustahil: [1000, 2000000], inti: [180000, 350000] },
  leukosit: { baku: 'Leukosit', satuan: '/ul', satuanDiterima: ['/ul', 'ribu/ul'], perUl: true, mustahil: [200, 500000], inti: [5000, 10000] },
  eritrosit: { baku: 'Eritrosit', satuan: 'juta/ul', satuanDiterima: ['juta/ul'], mustahil: [1, 10], inti: [4.2, 5.5] },
  kreatinin: { baku: 'Kreatinin', satuan: 'mg/dl', satuanDiterima: ['mg/dl', 'umol/l'], konversi: { 'umol/l': 1 / 88.4 }, mustahil: [0.1, 30], inti: [0.7, 1.0] },
  ureum: { baku: 'Ureum', satuan: 'mg/dl', satuanDiterima: ['mg/dl'], mustahil: [2, 500], inti: [20, 40] },
  gula_darah_sewaktu: { baku: 'Gula darah sewaktu', satuan: 'mg/dl', satuanDiterima: ['mg/dl'], mustahil: [10, 1500], inti: [80, 140] },
  gula_darah_puasa: { baku: 'Gula darah puasa', satuan: 'mg/dl', satuanDiterima: ['mg/dl'], mustahil: [10, 1500], inti: [75, 99] },
  natrium: { baku: 'Natrium', satuan: 'mmol/l', satuanDiterima: ['mmol/l', 'meq/l'], mustahil: [90, 190], inti: [137, 145] },
  kalium: { baku: 'Kalium', satuan: 'mmol/l', satuanDiterima: ['mmol/l', 'meq/l'], mustahil: [1.5, 10], inti: [3.7, 5.0] },
  sgot: { baku: 'SGOT (AST)', satuan: 'u/l', satuanDiterima: ['u/l'], mustahil: [1, 10000], inti: [10, 35] },
  sgpt: { baku: 'SGPT (ALT)', satuan: 'u/l', satuanDiterima: ['u/l'], mustahil: [1, 10000], inti: [10, 35] },
  albumin: { baku: 'Albumin', satuan: 'g/dl', satuanDiterima: ['g/dl'], mustahil: [0.5, 7], inti: [3.8, 5.0] },
  hba1c: { baku: 'HbA1c', satuan: '%', satuanDiterima: ['%'], mustahil: [3, 20], inti: [4.5, 5.6] },
  // Hitung jenis & indeks eritrosit (darah lengkap otomatis) -- dibaca supaya
  // syarat penunjang seperti leukositosis/neutrofilia/anemia mikrositik dapat
  // diperiksa dari hasil lab, bukan hanya "DL" di resume.
  neutrofil_persen: { baku: 'Neutrofil %', satuan: '%', satuanDiterima: ['%'], mustahil: [0, 100], inti: [50, 70] },
  limfosit_persen: { baku: 'Limfosit %', satuan: '%', satuanDiterima: ['%'], mustahil: [0, 100], inti: [20, 40] },
  monosit_persen: { baku: 'Monosit %', satuan: '%', satuanDiterima: ['%'], mustahil: [0, 100], inti: [2, 8] },
  eosinofil_persen: { baku: 'Eosinofil %', satuan: '%', satuanDiterima: ['%'], mustahil: [0, 100], inti: [1, 3] },
  basofil_persen: { baku: 'Basofil %', satuan: '%', satuanDiterima: ['%'], mustahil: [0, 100], inti: [0, 1] },
  neutrofil_absolut: { baku: 'Neutrofil absolut', satuan: 'ribu/ul', satuanDiterima: ['ribu/ul', '/ul'], mustahil: [0, 300], inti: [1.5, 7] },
  limfosit_absolut: { baku: 'Limfosit absolut', satuan: 'ribu/ul', satuanDiterima: ['ribu/ul', '/ul'], mustahil: [0, 300], inti: [1, 3.7] },
  monosit_absolut: { baku: 'Monosit absolut', satuan: 'ribu/ul', satuanDiterima: ['ribu/ul', '/ul'], mustahil: [0, 100], inti: [0.2, 1] },
  eosinofil_absolut: { baku: 'Eosinofil absolut', satuan: 'ribu/ul', satuanDiterima: ['ribu/ul', '/ul'], mustahil: [0, 100], inti: [0, 0.5] },
  basofil_absolut: { baku: 'Basofil absolut', satuan: 'ribu/ul', satuanDiterima: ['ribu/ul', '/ul'], mustahil: [0, 50], inti: [0, 0.2] },
  nlr: { baku: 'Neutrophil-lymphocyte ratio', satuan: null, satuanDiterima: [], mustahil: [0, 200], inti: [1, 3.13] },
  mcv: { baku: 'MCV', satuan: 'fl', satuanDiterima: ['fl'], mustahil: [40, 160], inti: [80, 94] },
  mch: { baku: 'MCH', satuan: 'pg', satuanDiterima: ['pg'], mustahil: [10, 60], inti: [26, 32] },
  mchc: { baku: 'MCHC', satuan: 'g/dl', satuanDiterima: ['g/dl', '%'], mustahil: [20, 45], inti: [32, 36] },
  rdw: { baku: 'RDW', satuan: '%', satuanDiterima: ['%'], mustahil: [5, 40], inti: [11, 16] },
};

// Nama dengan akhiran % / # (alat hematologi otomatis): persen vs absolut.
const HITUNG_JENIS = { neutrofil: 'neutrofil', neutrophil: 'neutrofil', segmen: 'neutrofil', limfosit: 'limfosit', lymphocyte: 'limfosit', lymph: 'limfosit', monosit: 'monosit', monocyte: 'monosit', eosinofil: 'eosinofil', eosinophil: 'eosinofil', basofil: 'basofil', basophil: 'basofil' };

// Alias nama (bentuk rapikan) untuk parameter yang di kamus bergabung atau
// tidak ada. Hanya dicocokkan terhadap SELURUH nama (atau isi kurung).
const ALIAS = {
  hb: 'hemoglobin', hgb: 'hemoglobin', hemoglobin: 'hemoglobin', haemoglobin: 'hemoglobin',
  hct: 'hematokrit', pcv: 'hematokrit', hematokrit: 'hematokrit', hematocrit: 'hematokrit',
  trombosit: 'trombosit', platelet: 'trombosit', plt: 'trombosit', thrombocyte: 'trombosit', trombo: 'trombosit', 'hitung trombosit': 'trombosit', 'jumlah trombosit': 'trombosit',
  leukosit: 'leukosit', wbc: 'leukosit', leuko: 'leukosit', 'white blood cell': 'leukosit', 'jumlah leukosit': 'leukosit', 'hitung leukosit': 'leukosit',
  eritrosit: 'eritrosit', rbc: 'eritrosit', 'jumlah eritrosit': 'eritrosit',
  kreatinin: 'kreatinin', creatinin: 'kreatinin', creatinine: 'kreatinin', 'serum creatinin': 'kreatinin', 'serum kreatinin': 'kreatinin',
  ureum: 'ureum', urea: 'ureum', bun: 'ureum',
  gds: 'gula_darah_sewaktu', 'gula darah sewaktu': 'gula_darah_sewaktu', 'gula darah acak': 'gula_darah_sewaktu',
  'glukosa darah sewaktu': 'gula_darah_sewaktu', 'glukosa sewaktu': 'gula_darah_sewaktu', 'glukosa darah puasa': 'gula_darah_puasa', 'glukosa puasa': 'gula_darah_puasa',
  // Ejaan cetakan lab RS Lestari Raharja dan salah baca OCR yang lazim.
  lekosit: 'leukosit', lokosit: 'leukosit', leucosit: 'leukosit',
  gdp: 'gula_darah_puasa', 'gula darah puasa': 'gula_darah_puasa',
  natrium: 'natrium', sodium: 'natrium', na: 'natrium',
  kalium: 'kalium', potassium: 'kalium', k: 'kalium',
  sgot: 'sgot', ast: 'sgot', sgpt: 'sgpt', alt: 'sgpt',
  albumin: 'albumin', hba1c: 'hba1c', a1c: 'hba1c',
  nlr: 'nlr', mcv: 'mcv', mch: 'mch', mchc: 'mchc', 'rdw cv': 'rdw', rdw: 'rdw',
};

// Salah baca OCR yang lazim pada nama parameter ("Lokosit", "Enitrosit",
// "Umfosit#" -- hasil lab YETY NOVIATI). Dicocokkan ke nama baku dengan jarak
// edit kecil, hanya bila tepat satu kandidat terdekat.
const NAMA_BAKU_OCR = ['hemoglobin', 'hematokrit', 'trombosit', 'leukosit', 'eritrosit', 'kreatinin', 'ureum', 'albumin', 'natrium', 'kalium',
  'neutrofil', 'limfosit', 'monosit', 'eosinofil', 'basofil'];
function jarakEdit(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
function namaBakuOcr(nama) {
  const n = String(nama || '').toLowerCase().replace(/[^a-z]/g, '');
  if (n.length < 6) return null;
  const batas = n.length >= 7 ? 2 : 1;
  const skor = NAMA_BAKU_OCR.map(b => [b, jarakEdit(n, b)]).filter(([, j]) => j <= batas).sort((x, y) => x[1] - y[1]);
  if (skor.length === 0 || (skor[1] && skor[1][1] === skor[0][1])) return null;
  return skor[0][0];
}

// istilah_id kamusPenunjang yang berpadanan 1-1 dengan satu parameter.
const KAMUS_KE_PARAMETER = {
  hemoglobin: 'hemoglobin', hematokrit: 'hematokrit', trombosit: 'trombosit', leukosit: 'leukosit',
  eritrosit: 'eritrosit', gds: 'gula_darah_sewaktu', gdp: 'gula_darah_puasa', hba1c: 'hba1c', albumin: 'albumin',
};

const STATUS_KEWAJARAN = { WAJAR: 'wajar', DIRAGUKAN: 'diragukan', MUSTAHIL: 'mustahil', TIDAK_DIPERIKSA: 'tidak_diperiksa' };
const PESAN_TIDAK_DAPAT_DIPAKAI = 'tidak dapat dipakai memutuskan syarat klaim';

// ── satuan ──────────────────────────────────────────────────────────────────
const SATUAN_POLA = '(?:10\\^?[369]\\s*/\\s*[uµμ]?l|x\\s*10\\^?[369]\\s*/\\s*[uµμ]?l|ribu\\s*/\\s*[uµμ]?l|juta\\s*/\\s*[uµμ]?l|g\\s*/\\s*dl|g\\s*/\\s*l|mg\\s*/\\s*dl|mg\\s*/\\s*l|mmol\\s*/\\s*l|meq\\s*/\\s*l|umol\\s*/\\s*l|[µμ]mol\\s*/\\s*l|iu\\s*/\\s*l|u\\s*/\\s*l|mm\\s*/\\s*jam|mm\\s*/\\s*h|/\\s*[uµμ]l|/\\s*mm3|fl|pg|%)';
const RE_SATUAN = new RegExp(`(?<![A-Za-z0-9])${SATUAN_POLA}(?![A-Za-z0-9])`, 'i');

/** Bentuk baku satuan: huruf kecil, tanpa spasi, µ->u, 10^3/uL -> ribu/ul. */
function normalisasiSatuan(satuan) {
  if (!satuan) return null;
  let s = String(satuan).toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '');
  if (/^x?10\^?3\/ul$/.test(s)) return 'ribu/ul';
  if (/^x?10\^?6\/ul$/.test(s)) return 'juta/ul';
  if (/^x?10\^?9\/ul$/.test(s)) return 'miliar/ul';
  if (s === '/mm3') return '/ul';
  if (s === 'iu/l') return 'u/l';
  return s;
}

// ── tanggal ─────────────────────────────────────────────────────────────────
// Pemisah tanggal harus sama di kedua posisi ("31-12-2025", "31/12/25").
// Dulu rujukan "4.5-11" (leukosit) terbaca sebagai tanggal 4 Mei 2011.
const RE_TANGGAL = /(?<![\d.])(\d{1,2})([/.\-])(\d{1,2})\2(\d{2,4})(?![\d.])|(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;

// Kop lembar hasil lab: "Tgl.Keluar Hasil : 17-09-2026". RapidOCR menggabungkan
// teks yang sejajar menjadi satu baris (mis. dengan "Alamat : ..."), sehingga
// tanggalJudul() yang mensyaratkan baris pendek tidak menangkapnya.
const RE_TGL_KELUAR_HASIL = /Tgl\.?\s*Keluar\s*Hasil\s*:?\s*/i;
const RE_TGL_PERMINTAAN = /Tgl\.?\s*Permintaan\s*:?\s*/i;

function tanggalKop(baris, re) {
  const m = re.exec(baris);
  if (!m) return null;
  const t = ambilTanggal(baris.slice(m.index + m[0].length));
  return t.tanggal;
}

function ubahTanggal(m) {
  let d, bln, th;
  if (m[5]) { th = +m[5]; bln = +m[6]; d = +m[7]; } else { d = +m[1]; bln = +m[3]; th = +m[4]; if (th < 100) th += 2000; }
  if (bln < 1 || bln > 12 || d < 1 || d > 31) return null;
  return `${String(th).padStart(4, '0')}-${String(bln).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Cari tanggal dalam teks; kembalikan {tanggal, sisa} dengan tanggal dibuang dari sisa. */
function ambilTanggal(teks) {
  const m = RE_TANGGAL.exec(teks);
  if (!m) return { tanggal: null, sisa: teks };
  const tanggal = ubahTanggal(m);
  if (!tanggal) return { tanggal: null, sisa: teks };
  return { tanggal, sisa: (teks.slice(0, m.index) + ' ' + teks.slice(m.index + m[0].length)).trim() };
}

// ── angka ───────────────────────────────────────────────────────────────────
const RE_NILAI = /^([<>]=?)?\s*([0-9OoIl]{1,3}(?:[.,][0-9OoIl]{3})+|[0-9OoIl]{1,7}(?:[.,][0-9OoIl]{1,3})?)\s*([HLhl*↑↓])?$/;

/**
 * Ubah token menjadi angka.
 * @returns {{nilai:number, teks:string, koreksiHuruf:boolean, ribuan:boolean, pembanding:string|null, flagMelekat:string|null}|null}
 */
function bacaAngka(token, { ribuanBolehTitik = false } = {}) {
  const m = RE_NILAI.exec(String(token || '').trim());
  if (!m) return null;
  let isi = m[2];
  if (!/[0-9]/.test(isi)) return null;
  const koreksiHuruf = /[OoIl]/.test(isi);
  isi = isi.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  const ribuan = /^\d{1,3}([.,]\d{3})+$/.test(isi);
  let nilai;
  if (ribuan && ribuanBolehTitik) nilai = Number(isi.replace(/[.,]/g, ''));
  else nilai = Number(isi.replace(',', '.'));
  if (!Number.isFinite(nilai)) return null;
  const flagMelekat = m[3] ? { '*': null, '↑': 'H', '↓': 'L' }[m[3]] ?? m[3].toUpperCase() : null;
  return { nilai, teks: m[2], koreksiHuruf, ribuan, pembanding: m[1] || null, flagMelekat };
}

// ── nama parameter ──────────────────────────────────────────────────────────
function kunciParameter(nama, sisaBaris = '') {
  const asli = String(nama || '').trim();
  if (!asli) return { key: null, istilah_id: null, ambigu: false };
  const dalamKurung = [...asli.matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
  const tanpaKurung = asli.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const kandidat = [asli, tanpaKurung, ...dalamKurung].filter(Boolean);

  // Hitung jenis: "Neutrofil%" / "Neutrofil#" / "Neutrofil (%)".
  // Bila akhiran tak terbaca (OCR membaca "#" sebagai "a"), satuan di baris
  // yang menentukan: "%" persen, "sel/mm3"/"10^3/uL" absolut.
  const akhiran = /#\s*$|\(\s*#\s*\)|\babs(?:olut)?\b/i.test(asli) ? 'absolut'
    : /%\s*$|\(\s*%\s*\)/.test(asli) ? 'persen'
      : /(?:^|\s)%(?:\s|$)/.test(sisaBaris) ? 'persen'
        : /sel|mm|\/\s*[uµμ]l|10\s*\^?\s*3/i.test(sisaBaris) ? 'absolut' : null;
  const dasarNama = asli.replace(/[#%()]/g, ' ').replace(/\babs(?:olut)?\b/i, ' ').replace(/\s+/g, ' ').trim();
  const dasarTanpaA = /a$/i.test(dasarNama) ? dasarNama.slice(0, -1) : dasarNama;
  const jenisHitung = HITUNG_JENIS[rapikan(dasarNama)] || HITUNG_JENIS[rapikan(dasarTanpaA)] || HITUNG_JENIS[namaBakuOcr(dasarNama)];
  if (jenisHitung) {
    const key = `${jenisHitung}_${akhiran || 'persen'}`;
    if (PARAMETER[key]) return { key, istilah_id: 'hitung_jenis', ambigu: false, koreksi_ocr: !HITUNG_JENIS[rapikan(dasarNama)] };
    return { key: null, istilah_id: 'hitung_jenis', ambigu: false };
  }

  let istilahId = null;
  let ambigu = false;
  for (const k of kandidat) {
    const alias = ALIAS[rapikan(k)];
    const kamus = cocokkan(k, { bagian: 'lab' });
    if (kamus.status === 'dikenali' && !istilahId) istilahId = kamus.istilah_id;
    if (kamus.status === 'perlu_konfirmasi') ambigu = true;
    if (alias) return { key: alias, istilah_id: istilahId, ambigu: false };
    if (kamus.status === 'dikenali' && KAMUS_KE_PARAMETER[kamus.istilah_id]) {
      return { key: KAMUS_KE_PARAMETER[kamus.istilah_id], istilah_id: kamus.istilah_id, ambigu: false };
    }
  }
  const tebakan = !istilahId && !ambigu ? namaBakuOcr(tanpaKurung) : null;
  if (tebakan && ALIAS[tebakan]) return { key: ALIAS[tebakan], istilah_id: null, ambigu: false, koreksi_ocr: true };
  return { key: null, istilah_id: istilahId, ambigu };
}

// ── rujukan dan flag ────────────────────────────────────────────────────────
function bacaRujukan(teks, opsi) {
  const rentang = /(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)/.exec(teks);
  const angka = s => bacaAngka(s, opsi);
  if (rentang) {
    const a = angka(rentang[1]); const b = angka(rentang[2]);
    if (a && b && a.nilai <= b.nilai) {
      return { rujukan: { min: a.nilai, max: b.nilai, teks: rentang[0].trim() }, sisa: teks.replace(rentang[0], ' ') };
    }
  }
  const batas = /([<>]=?)\s*(\d+(?:[.,]\d+)?)/.exec(teks);
  if (batas) {
    const a = angka(batas[2]);
    if (a) {
      const r = batas[1].startsWith('<') ? { min: null, max: a.nilai, teks: batas[0].trim() } : { min: a.nilai, max: null, teks: batas[0].trim() };
      return { rujukan: r, sisa: teks.replace(batas[0], ' ') };
    }
  }
  return { rujukan: null, sisa: teks };
}

const PETA_FLAG = { HH: 'H', LL: 'L', H: 'H', L: 'L', '↑': 'H', '↓': 'L', '*': null };

function bacaFlag(teks) {
  const m = /(?<![A-Za-z0-9])(HH|LL|H|L|↑|↓|[*])(?![A-Za-z0-9])/.exec(teks);
  return m ? PETA_FLAG[m[1]] : null;
}

// ── kewajaran ───────────────────────────────────────────────────────────────
function dalam(n, [a, b]) { return n >= a && n <= b; }

/** Cari koreksi skala (geser desimal) yang membuat nilai masuk akal. */
function usulkanNilai(nilai, def) {
  for (const f of [0.1, 0.01, 10, 100, 0.001, 1000]) {
    const n = nilai * f;
    if (dalam(n, def.mustahil)) return Number(n.toPrecision(6));
  }
  return null;
}

/**
 * Nilai satu baris terhadap kamus kewajaran.
 * @returns {{nilai_dinormalkan:number|null, satuan_dinormalkan:string|null, status:string, alasan:string[], kemungkinan_nilai:number|null, ambigu_satuan:boolean, satuan_tidak_cocok:boolean}}
 */
function periksaKewajaran(key, nilai, satuanTertulis) {
  const def = PARAMETER[key];
  const hasil = { nilai_dinormalkan: null, satuan_dinormalkan: null, status: STATUS_KEWAJARAN.TIDAK_DIPERIKSA, alasan: [], kemungkinan_nilai: null, ambigu_satuan: false, satuan_tidak_cocok: false };
  if (!def || nilai == null) return hasil;

  const satuan = normalisasiSatuan(satuanTertulis);
  let n = nilai;
  let satuanAkhir = def.satuan;

  if (satuan) {
    if (!def.satuanDiterima.includes(satuan)) {
      hasil.satuan_tidak_cocok = true;
      hasil.alasan.push(`satuan "${satuanTertulis}" tidak cocok untuk ${def.baku} (kolom mungkin bergeser)`);
    } else if (def.konversi && def.konversi[satuan]) {
      n = nilai * def.konversi[satuan];
    } else if (def.perUl && satuan === 'ribu/ul') {
      n = nilai * 1000;
    }
  } else if (def.perUl && nilai < def.mustahil[0]) {
    // Tanpa satuan, 150 vs 150.000 tidak dapat dibedakan dengan pasti.
    hasil.ambigu_satuan = true;
    hasil.alasan.push(`${def.baku} ${nilai} tanpa satuan: bisa ${nilai} ribu/uL (${nilai * 1000}) atau angka mentah`);
    hasil.kemungkinan_nilai = nilai * 1000;
  }
  if (def.perUl && satuan === '/ul' && nilai < def.mustahil[0]) {
    hasil.ambigu_satuan = true;
    hasil.alasan.push(`${def.baku} ${nilai} berlabel /uL tetapi terlalu kecil: kemungkinan ${nilai * 1000}/uL (satuan ribu)`);
    hasil.kemungkinan_nilai = nilai * 1000;
  }

  hasil.nilai_dinormalkan = Number(n.toPrecision(8));
  hasil.satuan_dinormalkan = satuanAkhir;

  if (hasil.ambigu_satuan) {
    hasil.status = STATUS_KEWAJARAN.DIRAGUKAN;
  } else if (!dalam(n, def.mustahil)) {
    hasil.status = STATUS_KEWAJARAN.MUSTAHIL;
    hasil.kemungkinan_nilai = usulkanNilai(n, def);
    hasil.alasan.push(`${def.baku} ${nilai}${satuanTertulis ? ' ' + satuanTertulis : ''} di luar batas yang mungkin (${def.mustahil[0]} sampai ${def.mustahil[1]} ${def.satuan})` +
      (hasil.kemungkinan_nilai != null ? `; kemungkinan ${hasil.kemungkinan_nilai}` : ''));
  } else {
    hasil.status = hasil.satuan_tidak_cocok ? STATUS_KEWAJARAN.DIRAGUKAN : STATUS_KEWAJARAN.WAJAR;
  }
  return hasil;
}

/**
 * Uji silang flag cetak dengan nilai. Kembalikan alasan konflik atau null.
 * Rujukan cetak diutamakan; bila tak ada dipakai rentang inti parameter.
 */
function ujiSilangFlag(flag, nilaiMentah, nilaiDinormalkan, rujukan, key) {
  if (!flag) return null;
  const def = PARAMETER[key];
  let min = null; let max = null; let nilai = nilaiMentah; let sumber = 'rujukan cetak';
  if (rujukan && (rujukan.min != null || rujukan.max != null)) {
    const batasAtas = rujukan.max != null ? rujukan.max : rujukan.min;
    // Skala rujukan beda jauh dengan nilai (150 vs 150.000): jangan menuduh.
    if (nilaiMentah != null && batasAtas > 0 && (nilaiMentah / batasAtas > 50 || batasAtas / Math.max(nilaiMentah, 1e-9) > 50)) return null;
    min = rujukan.min; max = rujukan.max;
  } else if (def && nilaiDinormalkan != null) {
    [min, max] = def.inti; nilai = nilaiDinormalkan; sumber = 'rentang normal inti';
  } else {
    return null;
  }
  if (nilai == null) return null;
  if (flag === 'L' && min != null && nilai >= min) {
    return `flag cetak L tetapi nilai ${nilai} tidak di bawah batas bawah ${min} (${sumber}); salah satunya keliru`;
  }
  if (flag === 'H' && max != null && nilai <= max) {
    return `flag cetak H tetapi nilai ${nilai} tidak di atas batas atas ${max} (${sumber}); salah satunya keliru`;
  }
  return null;
}

// ── baris ───────────────────────────────────────────────────────────────────
function pecahToken(baris) {
  const runs = String(baris).split(/\s{2,}|\t+|\|/).map(t => t.trim()).filter(Boolean);
  if (runs.length > 1) return runs;
  return String(baris).split(/\s+/).map(t => t.trim()).filter(Boolean);
}

/** Baris yang hanya memuat tanggal (judul kelompok hasil). */
function tanggalJudul(baris) {
  const { tanggal, sisa } = ambilTanggal(baris);
  if (!tanggal) return null;
  const huruf = sisa.replace(/[^A-Za-z]/g, '');
  const angkaLain = /\d{2,}/.test(sisa.replace(/\d{1,2}:\d{2}/g, ''));
  return huruf.length <= 40 && !angkaLain ? tanggal : null;
}

/**
 * Baca SATU baris. Kembalikan null bila bukan baris hasil lab.
 * Tidak pernah mengintip baris lain.
 */
// Salah baca OCR pada satuan ("ribulut", "juia/ui", "g/dt") -> bentuk baku.
function rapikanSatuanOcr(teks) {
  return teks
    .replace(/\bribu\s*[\/l1|]?\s*[uµμ][lt1|]\b\.?/gi, 'ribu/uL')
    .replace(/\bju[it1l]a\s*\/\s*[uµμ][il1|]\b\.?/gi, 'juta/uL')
    .replace(/\bg\s*\/\s*d[tl1|]\b\.?/gi, 'g/dL')
    // "U/L" terbaca "L/L"/"1/L" -- huruf L di depan dulu dianggap flag rendah (SGPT YETY).
    .replace(/(?<![A-Za-z])[Ll1|]\s*\/\s*L\b/g, 'U/L');
}

function bacaSatuBaris(baris, { tanggal = null, tanggalDari = null } = {}) {
  const teks = rapikanSatuanOcr(String(baris || '').replace(/\r/g, ''));
  if (!teks.trim()) return null;
  const token = pecahToken(teks);
  if (token.length < 2) return null;
  if (!/^[A-Za-z]/.test(token[0])) return null;

  // Token nilai pertama setelah nama. Untuk trombosit/leukosit ribuan bertitik.
  let idx = -1;
  for (let i = 1; i < token.length; i++) {
    if (bacaAngka(token[i], { ribuanBolehTitik: true })) { idx = i; break; }
    // Kata lain sebelum angka tetap bagian nama; berhenti bila ketemu satuan.
    if (RE_SATUAN.test(token[i]) && new RegExp(`^${SATUAN_POLA}$`, 'i').test(token[i])) break;
  }
  if (idx === -1) return null;

  const nama = token.slice(0, idx).join(' ');
  const { key, istilah_id: istilahKamus, ambigu, koreksi_ocr: koreksiNama } = kunciParameter(nama, token.slice(idx + 1).join(' '));
  // "PCT 0.257 %" pada darah lengkap = plateletcrit, bukan prokalsitonin.
  const istilahId = istilahKamus === 'penanda_radang' && /^pct$/i.test(nama.trim()) && /%/.test(teks) ? null : istilahKamus;
  const bolehRibuan = key === 'trombosit' || key === 'leukosit';
  const angka = bacaAngka(token[idx], { ribuanBolehTitik: bolehRibuan }) || bacaAngka(token[idx], { ribuanBolehTitik: true });
  if (!angka) return null;
  let nilai = angka.nilai;
  // "8.500" untuk parameter selain trombosit/leukosit dibaca desimal biasa.
  if (angka.ribuan && !bolehRibuan) nilai = Number(String(angka.teks).replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(',', '.'));

  let sisa = token.slice(idx + 1).join('  ');
  const tgl = ambilTanggal(sisa);
  sisa = tgl.sisa;
  const barisTanggal = tgl.tanggal;

  const sat = RE_SATUAN.exec(sisa);
  const satuanTertulis = sat ? sat[0].replace(/\s+/g, '') : null;
  if (sat) sisa = sisa.replace(sat[0], ' ');

  const rj = bacaRujukan(sisa, { ribuanBolehTitik: bolehRibuan });
  sisa = rj.sisa;
  const flagCetak = angka.flagMelekat || bacaFlag(sisa);

  // Baris tanpa satuan, rujukan, dan bukan parameter dikenal bukan baris lab.
  if (!key && !satuanTertulis && !rj.rujukan) return null;

  const wajar = periksaKewajaran(key, nilai, satuanTertulis);
  const alasan = [...wajar.alasan];
  if (key && !satuanTertulis) alasan.push('satuan tidak terbaca pada baris yang sama');
  if (angka.koreksiHuruf) alasan.push(`angka "${angka.teks}" memuat huruf yang mirip angka (O/l); dibaca ${nilai}`);
  const konflik = key ? ujiSilangFlag(flagCetak, nilai, wajar.nilai_dinormalkan, rj.rujukan, key) : null;
  if (konflik) alasan.push(konflik);
  if (!key) alasan.push(ambigu ? 'nama parameter bertabrakan, perlu konfirmasi' : 'parameter tidak dikenali');

  const dapatDipakai = Boolean(key) && Boolean(satuanTertulis) && wajar.status === STATUS_KEWAJARAN.WAJAR && !konflik && !angka.koreksiHuruf && !wajar.ambigu_satuan && !wajar.satuan_tidak_cocok;

  return {
    parameter: key,
    parameter_baku: key ? PARAMETER[key].baku : null,
    istilah_id: istilahId,
    parameter_ditulis: nama,
    nilai,
    nilai_teks: angka.teks,
    pembanding: angka.pembanding,
    satuan: satuanTertulis,
    rujukan: rj.rujukan,
    flag_cetak: flagCetak || null,
    tanggal: barisTanggal || tanggal,
    tanggal_dari: barisTanggal ? 'baris' : (tanggal ? (tanggalDari || 'judul') : null),
    kutipan: teks.trim().slice(0, 200),
    ...(koreksiNama ? { nama_dikoreksi_ocr: true } : {}),
    kewajaran: {
      status: wajar.status,
      nilai_dinormalkan: wajar.nilai_dinormalkan,
      satuan_dinormalkan: wajar.satuan_dinormalkan,
      kemungkinan_nilai: wajar.kemungkinan_nilai,
      koreksi_huruf: angka.koreksiHuruf,
      ambigu_satuan: wajar.ambigu_satuan,
      satuan_tidak_cocok: wajar.satuan_tidak_cocok,
      konflik_flag: Boolean(konflik),
    },
    dapat_dipakai_memutuskan_syarat: dapatDipakai,
    alasan_tidak_dapat_dipakai: dapatDipakai ? null : `${PESAN_TIDAK_DAPAT_DIPAKAI}: ${alasan.join('; ') || 'nilai belum terverifikasi'}`,
    perlu_cek_manusia: !dapatDipakai,
  };
}

/**
 * Baca seluruh teks satu halaman. Tanggal pada baris judul berlaku untuk baris
 * berikutnya sampai judul tanggal berikutnya; tanggal pada baris itu sendiri
 * selalu didahulukan.
 * @returns {Array} baris hasil (parameter dikenal maupun tidak), berurutan
 */
function bacaBarisLab(teks, { halaman = null, tanggalAwal = null } = {}) {
  const hasil = [];
  let tanggal = tanggalAwal;
  let tanggalDari = tanggalAwal ? 'halaman' : null;
  const barisList = String(teks || '').split('\n');
  let dariKeluarHasil = false;
  barisList.forEach((baris, i) => {
    // Tanggal kop lembar lab. "Tgl.Keluar Hasil" didahulukan atas
    // "Tgl.Permintaan" (sampel bisa diambil malam, hasil keluar esok hari).
    const keluar = tanggalKop(baris, RE_TGL_KELUAR_HASIL);
    if (keluar) { tanggal = keluar; tanggalDari = 'kop'; dariKeluarHasil = true; return; }
    const minta = !dariKeluarHasil && tanggalKop(baris, RE_TGL_PERMINTAAN);
    if (minta) { tanggal = minta; tanggalDari = 'kop'; return; }
    const judul = tanggalJudul(baris);
    if (judul) { tanggal = judul; tanggalDari = 'judul'; return; }
    const r = bacaSatuBaris(baris, { tanggal, tanggalDari });
    if (!r) return;
    hasil.push({ ...r, halaman, id_baris: `${halaman == null ? '-' : halaman}:${i}` });
  });
  return hasil;
}

function statusSerologi(raw) {
  const teks = String(raw || '').toLowerCase();
  if (/\b(non[\s-]*reactive|non[\s-]*reaktif|negatif|negative)\b/.test(teks)) return 'NEGATIF';
  if (/\b(positif|positive|reactive|reaktif)\b/.test(teks)) return 'POSITIF';
  return null;
}

/** Baca hasil serologi yang tertulis pada baris yang sama dengan nama tes. */
function bacaSerologiDariHalaman(halaman) {
  const hasil = [];
  for (const hal of halaman || []) {
    const teks = hal && (hal.ocr_text != null ? hal.ocr_text : hal.text);
    if (!teks) continue;
    for (const baris of String(teks).split('\n')) {
      const line = baris.trim();
      if (!line) continue;

      const dengue = line.match(/\b(IgG|IgM)\b.*\bDengue\b|\bDengue\b.*\b(IgG|IgM)\b/i);
      if (dengue) {
        const jenis = (dengue[1] || dengue[2]).toUpperCase();
        const status = statusSerologi(line);
        // Judul pemeriksaan (mis. "DENGUE IGG/IGM") dan baris tarif bukan
        // hasil pasien. Tanpa hasil kualitatif eksplisit, jangan buat temuan.
        if (!status) continue;
        hasil.push({
          jenis: 'dengue_serologi', parameter: `dengue_${jenis.toLowerCase()}`,
          hasil: status, hasil_ditulis: line, page_number: hal.page_number || null,
          kutipan: line.slice(0, 200), perlu_cek_manusia: status === null,
        });
        continue;
      }

      const widal = line.match(/^\s*(?:Salmonella\s+)?(Typhi|Paratyphi)\s+(AO|BO|CO|AH|BH|CH|O|H)\b\s*(.*)$/i);
      if (!widal) continue;
      const kelompok = widal[1].toLowerCase();
      const antigen = widal[2].toUpperCase();
      const raw = widal[3].trim();
      const titer = raw.match(/\b(\d+)\s*[:/]\s*(\d+)\b/);
      const status = statusSerologi(raw);
      hasil.push({
        jenis: 'widal', parameter: `widal_${kelompok}_${antigen.toLowerCase()}`,
        hasil: status, hasil_ditulis: raw || null,
        ...(titer ? { titer: `${titer[1]}/${titer[2]}`, titer_penyebut: Number(titer[2]) } : {}),
        page_number: hal.page_number || null, kutipan: line.slice(0, 200),
        perlu_cek_manusia: !status && !titer,
      });
    }
  }
  return hasil;
}

/**
 * Baca banyak halaman.
 * @param {Array<{page_number:number, ocr_text?:string, text?:string}>} halaman
 * @returns {{baris: Array, tidak_dikenali: Array<{nama:string, halaman:number|null}>}}
 */
// Lembar hasil lab (kop "HASIL PEMERIKSAAN LABORATORIUM" RS Lestari Raharja,
// atau judul serupa). Dipakai untuk membedakan "berkas tanpa hasil lab" dari
// "hasil lab ada tetapi tidak terbaca" -- yang kedua tidak boleh lewat diam-diam.
const RE_HALAMAN_LAB = /HASIL\s+(?:PEMERIKSAAN\s+)?LAB(?:ORATORIUM|ORATORIK)?\b/i;

const RE_KUALITATIF = /\b(non[\s-]*reaktif|non[\s-]*reactive|negatif|negative|positif|positive|reaktif|reactive)\b/i;

/**
 * Hasil kualitatif pada lembar lab (mis. "HBsAg Kualitatif Negatif Negatif")
 * yang tidak berupa angka sehingga tidak tertangkap bacaSatuBaris. Hanya
 * dicatat apa adanya -- tidak dipakai memutuskan syarat klaim.
 */
function bacaKualitatif(teks, halaman, sudahSerologi) {
  const hasil = [];
  for (const baris of String(teks || '').split('\n')) {
    const line = baris.trim();
    const m = RE_KUALITATIF.exec(line);
    if (!m || m.index === 0 || sudahSerologi.has(line)) continue;
    const nama = line.slice(0, m.index).replace(/\b(kualitatif|kuantitatif)\b/ig, '').replace(/[:\s]+$/, '').trim();
    if (!/^[A-Za-z]/.test(nama) || nama.length > 40 || /catatan|kesimpulan|kesan/i.test(nama)) continue;
    hasil.push({ nama, hasil: statusSerologi(m[1]), hasil_ditulis: m[1], halaman, kutipan: line.slice(0, 200) });
  }
  return hasil;
}

function bacaLabDariHalaman(halaman) {
  const baris = [];
  const tidakDikenali = [];
  const kualitatif = [];
  const halamanLab = [];
  const serologi = bacaSerologiDariHalaman(halaman);
  const sudahSerologi = new Set(serologi.map(s => s.kutipan));
  for (const h of halaman || []) {
    const teks = h && (h.ocr_text != null ? h.ocr_text : h.text);
    if (!teks) continue;
    const lembarLab = RE_HALAMAN_LAB.test(teks);
    if (lembarLab) halamanLab.push(h.page_number || null);
    for (const b of bacaBarisLab(teks, { halaman: h.page_number || null })) {
      if (b.parameter) baris.push(b); else tidakDikenali.push({ nama: b.parameter_ditulis, halaman: b.halaman });
    }
    if (lembarLab) kualitatif.push(...bacaKualitatif(teks, h.page_number || null, sudahSerologi));
  }

  // Status bacaan:
  //   terbaca                     -- ada nilai lab yang terbaca
  //   halaman_lab_tidak_terbaca   -- lembar hasil lab ADA tetapi tak satu pun
  //                                  hasil terbaca (OCR buruk / format baru)
  //   tidak_ada_halaman_lab       -- berkas memang tidak memuat lembar lab
  const adaHasil = baris.length + serologi.length + kualitatif.length + tidakDikenali.length > 0;
  let statusBacaan = 'tidak_ada_halaman_lab';
  if (adaHasil) statusBacaan = 'terbaca';
  else if (halamanLab.length > 0) statusBacaan = 'halaman_lab_tidak_terbaca';

  return {
    baris,
    serologi,
    kualitatif,
    tidak_dikenali: tidakDikenali,
    halaman_lab: halamanLab,
    status_bacaan: statusBacaan,
  };
}

/**
 * Temuan konsistensi untuk klaim RAWAT INAP yang lembar hasil lab-nya ada
 * tetapi tidak terbaca sama sekali -- supaya koder memeriksanya manual dan
 * aplikasi tidak diam-diam menganggap "tidak ada hasil lab".
 */
function temuanLabRawatInap(jenisKlaim, bacaanLab) {
  if (jenisKlaim !== 'RAWAT_INAP' || !bacaanLab) return [];
  if (!['halaman_lab_tidak_terbaca', 'gagal_dibaca'].includes(bacaanLab.status_bacaan)) return [];
  const hal = (bacaanLab.halaman_lab || []).filter(h => h != null);
  return [{
    id: 'LAB-01',
    nama: 'Hasil laboratorium tidak terbaca',
    keparahan: 'rendah',
    pesan: (bacaanLab.status_bacaan === 'gagal_dibaca'
      ? 'Pembacaan hasil laboratorium gagal karena gangguan sistem.'
      : `Lembar hasil laboratorium ditemukan${hal.length ? ` di halaman ${hal.join(', ')}` : ''}, tetapi tidak satu pun hasilnya terbaca otomatis.`)
      + ' Hasil lab rawat inap sering menjadi dasar syarat klaim -- periksa lembar hasil lab secara manual.',
    yang_ditemukan: hal.length ? { kutipan: 'HASIL PEMERIKSAAN LABORATORIUM', page_number: hal[0] } : null,
    yang_dicari: 'Nilai hasil laboratorium (mis. Hemoglobin, Trombosit, Leukosit) yang terbaca dari lembar hasil lab',
    sumber_aturan: null,
    diverifikasi: false,
  }];
}

/** Semua baris satu parameter, urut tanggal (tanggal kosong di akhir). Tidak ada yang ditimpa. */
function barisPerParameter(baris, key) {
  return (baris || []).filter(b => b.parameter === key)
    .map((b, urut) => ({ b, urut }))
    .sort((x, y) => {
      const a = x.b.tanggal; const c = y.b.tanggal;
      if (a && c && a !== c) return a < c ? -1 : 1;
      if (a && !c) return -1;
      if (!a && c) return 1;
      return x.urut - y.urut;
    }).map(x => x.b);
}

/**
 * Untuk syaratPenunjangService: nilai terendah dari baris yang DAPAT DIPAKAI.
 * Bila ada baris tetapi tak satu pun dapat dipakai, kembalikan
 * {nilai: null, tidak_dapat_dipakai: true, ...} agar pemanggil menjadikannya
 * perlu cek manual, bukan menebak. Tanpa baris sama sekali: null.
 */
function nilaiLabDariBaris(halaman, parameter) {
  const { baris } = bacaLabDariHalaman(halaman);
  const semua = barisPerParameter(baris, parameter);
  if (!semua.length) return null;
  const dapat = semua.filter(b => b.dapat_dipakai_memutuskan_syarat);
  if (!dapat.length) {
    return {
      nilai: null,
      tidak_dapat_dipakai: true,
      kutipan: semua[0].kutipan,
      page_number: semua[0].halaman,
      alasan: semua[0].alasan_tidak_dapat_dipakai,
      jumlah_baris: semua.length,
    };
  }
  const terendah = dapat.reduce((m, b) => (b.kewajaran.nilai_dinormalkan < m.kewajaran.nilai_dinormalkan ? b : m));
  return {
    nilai: terendah.kewajaran.nilai_dinormalkan,
    tidak_dapat_dipakai: false,
    kutipan: terendah.kutipan,
    page_number: terendah.halaman,
    tanggal: terendah.tanggal,
    jumlah_baris: semua.length,
  };
}

module.exports = {
  PARAMETER, STATUS_KEWAJARAN, PESAN_TIDAK_DAPAT_DIPAKAI,
  normalisasiSatuan, bacaAngka, kunciParameter,
  periksaKewajaran, ujiSilangFlag,
  bacaSatuBaris, bacaBarisLab, bacaLabDariHalaman, temuanLabRawatInap,
  barisPerParameter, nilaiLabDariBaris,
  bacaSerologiDariHalaman,
};
