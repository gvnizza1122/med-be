/**
 * Koding neoplasma/benjolan dari resume + hasil patologi anatomi (PA), tanpa AI.
 *
 * Kode neoplasma ICD-10 WHO ditentukan oleh SIFAT (jinak/ganas, dari PA),
 * JENIS JARINGAN (lipoma, fibroadenoma, kista epidermoid, jaringan lunak,
 * kulit) dan LOKASI. Resume biasanya hanya menulis "Tumor regio sternum";
 * jenisnya baru diketahui dari PA. Tanpa aturan ini AI memberi kode ICD-10-CM
 * (D49.2, tidak ada di WHO) yang ditolak, DIAGLIST kosong, INA-CBG tidak
 * terhitung -- berkas ANNISA NUR CHASANAH (casemix: D21.3 + 86.3, L-1-40-I).
 *
 * Neoplasma GANAS tidak dikode otomatis (letak primer/metastasis perlu koder);
 * hanya diberi catatan. Setiap kode membawa kutipan resume dan kesimpulan PA.
 */
const { deskripsiDiagnosis, deskripsiProsedur } = require('./kamusKodeService');
const { classifyPageDocumentType } = require('./pdfPageClassifier');

const LESI = /\b(?:tumou?r|massa|benjolan|neoplasma?|lipoma|kista|cyst|nodul\w*|fibroma|dermatofibroma|fam|fibroadenoma|ateroma|atheroma|keloid|sst|soft\s+tissue\s+tumou?r|nevus|naevus)\b/i;
const RENCANA = /\b(?:pro|rencana|planning|plan|usul\w*|konsul\w*|jadwal\w*|post|pasca|riwayat|s\s*\/\s*p)\s*[:.]?\s*$/i;
const EKSISI = /\b(?:eksisi|excisi\w*|excision|ekstirpasi|eksterpasi|extirpasi|ekstirpasi|biopsi\s+eksisi|enukleasi|marsupialisasi)\b/i;

// Lokasi -> wilayah. Urutan penting: payudara/tiroid sebelum dada/leher.
const WILAYAH = [
  ['payudara', /\b(?:payudara|mammae?|mamma|breast)\b/i],
  ['tiroid', /\b(?:tiroid|thyroid|struma)\b/i],
  ['wajah', /\b(?:wajah|muka|facial|pipi|dahi|frontal|hidung|nasal|bibir|labial|palpebra|kelopak|auricula|telinga|preaurikula\w*)\b/i],
  ['kepala_leher', /\b(?:kepala|capitis|scalp|kulit\s+kepala|occipital|oksipital|temporal|parietal|leher|colli|coli|cervical|servikal|submandibula\w*|parotis)\b/i],
  ['toraks', /\b(?:dada|sternum|sternal|thorax|thoraks|toraks|thoracal|torakal|aksila\w*|axilla\w*|ketiak|klavikula\w*|clavicula\w*|pectoral\w*)\b/i],
  ['ekstremitas_atas', /\b(?:lengan|brachii|brachium|antebrachii|antebrachium|bahu|shoulder|humerus|cubiti|siku|manus|tangan|wrist|pergelangan\s+tangan|digiti\s+manus|jari\s+tangan|palmar|deltoid)\b/i],
  ['ekstremitas_bawah', /\b(?:tungkai|paha|femoris|femur|cruris|kruris|genu|lutut|pedis|kaki|ankle|pergelangan\s+kaki|digiti\s+pedis|jari\s+kaki|plantar|coxae|hip|poplitea|calf|betis)\b/i],
  ['pelvis', /\b(?:gluteal|glutea|bokong|pantat|pelvis|perineum|perineal|sakral|sacral|coccyg\w*)\b/i],
  ['abdomen', /\b(?:abdomen|abdominal|perut|umbilikal\w*|umbilicus|inguinal|lipat\s+paha|epigastri\w*|hipogastri\w*|flank|lumbal\s+anterior)\b/i],
  ['badan', /\b(?:punggung|back|skapula\w*|scapula\w*|lumbal|lumbar|pinggang|trunk|badan|truncus)\b/i],
];

// Kode per jenis jaringan x wilayah (semua diperiksa ke kamus WHO).
const KODE = {
  jaringan_lunak: { kepala_leher: 'D21.0', wajah: 'D21.0', ekstremitas_atas: 'D21.1', ekstremitas_bawah: 'D21.2', toraks: 'D21.3', abdomen: 'D21.4', pelvis: 'D21.5', badan: 'D21.6', _: 'D21.9' },
  kulit: { wajah: 'D23.3', kepala_leher: 'D23.4', toraks: 'D23.5', abdomen: 'D23.5', pelvis: 'D23.5', badan: 'D23.5', ekstremitas_atas: 'D23.6', ekstremitas_bawah: 'D23.7', _: 'D23.9' },
  lipoma: { kepala_leher: 'D17.0', wajah: 'D17.0', toraks: 'D17.1', abdomen: 'D17.1', pelvis: 'D17.1', badan: 'D17.1', ekstremitas_atas: 'D17.2', ekstremitas_bawah: 'D17.2', _: 'D17.3' },
};

function wilayahDari(teks) {
  const w = WILAYAH.find(([, pola]) => pola.test(teks || ''));
  return w ? w[0] : null;
}

function halamanJenis(pool, jenis) {
  return pool.filter(p => classifyPageDocumentType(String(p.ocr_text || '')) === jenis);
}

/** Baris diagnosis utama resume ("Diagnosis Utama :" lalu nilainya). */
function diagnosisUtamaResume(pagesResume) {
  for (const p of pagesResume) {
    const baris = String(p.ocr_text || '').split(/\r?\n/);
    const i = baris.findIndex(b => /diagnos[ai]s?\s+utama/i.test(b));
    if (i === -1) continue;
    const diBaris = baris[i].replace(/.*diagnos[ai]s?\s+utama\s*:?\s*/i, '').trim();
    const nilai = diBaris || (baris.slice(i + 1).find(b => b.trim()) || '').trim();
    if (nilai) return { page_number: p.page_number, quotation: nilai.slice(0, 200), teks: nilai };
  }
  return null;
}

/** Kesimpulan & sifat dari lembar patologi anatomi. */
function bacaPa(pagesPa) {
  for (const p of pagesPa) {
    const teks = String(p.ocr_text || '');
    const baris = teks.split(/\r?\n/);
    const iK = baris.findIndex(b => /^\s*kesimpulan\b/i.test(b) || /\bkesimpulan\s*:/i.test(b));
    if (iK === -1) continue;
    const kumpul = [];
    for (let j = iK; j < baris.length && j < iK + 4; j++) {
      if (j > iK && /^\s*(?:saran|catatan|pemeriksa|dr\.)/i.test(baris[j])) break;
      kumpul.push(baris[j].replace(/^\s*kesimpulan\s*:?\s*/i, '').trim());
    }
    const kesimpulan = kumpul.join(' ').replace(/\s+/g, ' ').trim();
    const sifatBaris = baris.find(b => /^\s*sifat\b|keganasan/i.test(b)) || '';
    const bahan = (baris.find(b => /^\s*bahan\b/i.test(b)) || '').replace(/^\s*bahan\s*:?\s*/i, '').trim();
    return { page_number: p.page_number, kesimpulan, sifat: sifatBaris.trim(), bahan, quotation: baris[iK].trim().slice(0, 200) };
  }
  return null;
}

const TIDAK_GANAS = /tidak\s+(?:didapatkan|ditemukan|tampak|ada)?\s*(?:tanda[\s-]+)?(?:keganasan|ganas|malignan\w*)|jinak|benign|non[\s-]?ganas/i;
const GANAS = /karsinoma|carcinoma|sarkoma|sarcoma|malignan\w*|limfoma|lymphoma|melanoma|metasta\w*|\bganas\b|adenokarsinoma|blastoma/i;

function sifatPa(pa) {
  if (!pa) return null;
  const isi = `${pa.sifat} ${pa.kesimpulan}`;
  if (TIDAK_GANAS.test(isi)) return 'jinak';
  if (GANAS.test(pa.kesimpulan) || GANAS.test(pa.sifat.replace(/^\s*sifat\s*:?\s*/i, ''))) return 'ganas';
  return null;
}

/**
 * Tentukan kode jinak dari kesimpulan PA + teks klinis resume.
 * @returns {{kode, jenis, alternatif: string[]}|null}
 */
function kodeJinak(pa, teksKlinis, wilayah) {
  const k = `${pa.kesimpulan} ${pa.bahan}`.toLowerCase();
  const klinis = String(teksKlinis || '').toLowerCase();
  if (wilayah === 'payudara' || /fibroadenoma|\bfam\b|mamma/.test(k)) return { kode: 'D24', jenis: 'payudara', alternatif: [] };
  if (/lipoma|lipomatous/.test(k)) return { kode: KODE.lipoma[wilayah] || KODE.lipoma._, jenis: 'lipoma', alternatif: [] };
  if (/kista\s+epiderm|epidermal\s+cyst|epidermoid|ateroma|atheroma|kista\s+sebase/.test(k)) return { kode: 'L72.0', jenis: 'kista epidermal', alternatif: [] };
  if (/trikilemal|trichilemmal/.test(k)) return { kode: 'L72.1', jenis: 'kista trikilemal', alternatif: [] };
  if (/^\s*[^,;]*keloid/.test(k) && !/fibroma|tumou?r|neoplas/.test(k)) return { kode: 'L91.0', jenis: 'keloid', alternatif: [] };
  // Lesi di bawah fascia / jaringan lunak dalam -> jaringan ikat & lunak (D21);
  // lesi dermis/kulit tanpa keterangan dalam -> kulit (D23).
  const dalam = /sub\s*fasci|subfasci|intramuskul|jaringan\s+lunak|soft\s+tissue|\bsst\b/.test(`${klinis} ${k}`);
  const kulit = /dermatofibroma|nevus|naevus|epidermis|dermis|kulit|skin/.test(k);
  const jenis = dalam || !kulit ? 'jaringan_lunak' : 'kulit';
  const kode = KODE[jenis][wilayah] || KODE[jenis]._;
  const alternatif = [];
  if (/keloid/.test(k)) alternatif.push('L91.0');
  if (jenis === 'jaringan_lunak' && kulit) alternatif.push(KODE.kulit[wilayah] || KODE.kulit._);
  if (jenis === 'kulit' && !dalam) alternatif.push(KODE.jaringan_lunak[wilayah] || KODE.jaringan_lunak._);
  return { kode, jenis: jenis === 'kulit' ? 'neoplasma jinak kulit' : 'neoplasma jinak jaringan ikat/lunak', alternatif };
}

// Kode diagnosis lesi yang boleh diganti: bukan WHO, atau tidak spesifik.
const KODE_LESI_UMUM = /^(?:D4[89]|D36\.9|D21\.9|D23\.9|D17\.9|R22)/;

/**
 * @param {Array} saran suggested_codes
 * @param {Array} halaman evidencePool [{page_number, ocr_text}]
 * @returns {{saran: Array, perubahan: Array, catatan: string|null}}
 */
function lengkapiKodeNeoplasma(saran, halaman) {
  const daftar = Array.isArray(saran) ? saran.map(s => ({ ...s })) : [];
  const pool = Array.isArray(halaman) ? halaman : [];
  const perubahan = [];
  const resume = halamanJenis(pool, 'resume_medis');
  const dx = diagnosisUtamaResume(resume);
  if (!dx || !LESI.test(dx.teks)) return { saran: daftar, perubahan, catatan: null };

  const teksResume = resume.map(p => p.ocr_text || '').join('\n');
  const statusLokalis = (teksResume.match(/status\s+lokalis[^\n]*/i) || [''])[0];
  const wilayah = wilayahDari(dx.teks) || wilayahDari(statusLokalis);
  const pa = bacaPa(halamanJenis(pool, 'patologi_anatomi'));
  const sifat = sifatPa(pa);

  if (sifat === 'ganas') {
    return { saran: daftar, perubahan, catatan: `Hasil PA hal. ${pa.page_number}: ganas ("${pa.kesimpulan.slice(0, 120)}"). Kode neoplasma ganas (C..) dan letak primernya ditentukan koder.` };
  }
  if (sifat !== 'jinak') {
    return { saran: daftar, perubahan, catatan: pa ? null : 'Diagnosis berupa tumor/benjolan tanpa hasil PA di berkas: sifat jinak/ganas belum dapat dipastikan dari dokumen.' };
  }

  const hasil = kodeJinak(pa, `${dx.teks} ${statusLokalis}`, wilayah);
  if (!hasil || !deskripsiDiagnosis(hasil.kode)) return { saran: daftar, perubahan, catatan: null };

  // Kode lesi yang tidak sah WHO / tidak spesifik diganti kode hasil PA.
  const aktif = s => s && !s._diganti && s.type === 'diagnosis' && s.code && s.disangkal !== true;
  const diganti = daftar.filter(s => aktif(s) && String(s.code).toUpperCase() !== hasil.kode
    && (s.kamus_valid !== true || KODE_LESI_UMUM.test(String(s.code).toUpperCase())));
  for (const s of diganti) s._diganti = true;
  const sudahAda = daftar.some(s => aktif(s) && String(s.code).toUpperCase() === hasil.kode);
  if (!sudahAda) {
    const posisi = diganti.length ? daftar.indexOf(diganti[0]) : 0;
    const alt = hasil.alternatif.filter(k => deskripsiDiagnosis(k));
    daftar.splice(posisi, 0, {
      code: hasil.kode, type: 'diagnosis', kamus_valid: true,
      page_number: dx.page_number, quotation: dx.quotation,
      sumber_aturan: 'koding_neoplasma',
      catatan_aturan: `${hasil.jenis} regio ${wilayah ? wilayah.replace('_', ' ') : 'tidak disebut'} -> ${hasil.kode} (${deskripsiDiagnosis(hasil.kode)}), berdasarkan PA hal. ${pa.page_number}: "${pa.kesimpulan.slice(0, 140)}"`
        + `${diganti.length ? `; menggantikan ${diganti.map(s => s.code).join(', ')}` : ''}.`
        + `${alt.length ? ` Alternatif bila koder menilai lain: ${alt.map(k => `${k} ${deskripsiDiagnosis(k)}`).join('; ')}.` : ''}`,
    });
    perubahan.push({ aksi: diganti.length ? 'ganti' : 'tambah', dari: diganti.map(s => s.code), kode: hasil.kode });
  }

  // Diagnosis banding PA untuk lesi YANG SAMA (mis. "keloid DD dermatofibroma"
  // -> L91.0/D23.5) bukan diagnosis sekunder: menambahkannya menaikkan
  // severity tanpa dasar (ANNISA: L-1-40-II Rp6.028.100 vs casemix L-1-40-I
  // Rp3.811.600). Cukup disebut sebagai alternatif di catatan kode utama.
  const lesiSama = new Set([...hasil.alternatif, ...Object.values(KODE).flatMap(t => Object.values(t)), 'L91.0', 'L72.0', 'L72.1', 'D24']);
  const banding = daftar.filter(s => aktif(s) && String(s.code).toUpperCase() !== hasil.kode
    && (lesiSama.has(String(s.code).toUpperCase()) || /^D48/.test(String(s.code).toUpperCase())));
  for (const s of banding) s._diganti = true;
  if (banding.length) perubahan.push({ aksi: 'buang', dari: banding.map(s => s.code), kode: hasil.kode });

  // Tindakan eksisi tanpa objek ("Eksisi dan PA") -- objeknya lesi tadi.
  const sudahEksisi = daftar.some(s => s && !s._diganti && s.type === 'procedure' && /^(?:86\.[234]|85\.2|83\.3)/.test(String(s.code)));
  if (!sudahEksisi) {
    for (const p of resume) {
      const baris = String(p.ocr_text || '').split(/\r?\n/).find(b => {
        const m = EKSISI.exec(b);
        return m && !RENCANA.test(b.slice(0, m.index));
      });
      if (!baris) continue;
      const kode = hasil.kode === 'D24' ? '85.21' : '86.3';
      if (!deskripsiProsedur(kode)) break;
      daftar.push({
        code: kode, type: 'procedure', kamus_valid: true, page_number: p.page_number, quotation: baris.trim().slice(0, 200),
        sumber_aturan: 'koding_neoplasma', nama_tindakan: kode === '85.21' ? 'Eksisi lesi payudara' : 'Eksisi lesi kulit/subkutis',
        catatan_aturan: `Eksisi ${hasil.jenis} -> ${kode} (${deskripsiProsedur(kode)}).`
          + (hasil.jenis.includes('lunak') && kode === '86.3' ? ' Bila lesi di otot/fascia dalam, alternatifnya 83.39 (Excision of lesion of other soft tissue).' : ''),
      });
      perubahan.push({ aksi: 'tambah', dari: [], kode });
      break;
    }
  }
  return { saran: daftar.filter(s => !s._diganti), perubahan, catatan: null };
}

module.exports = { lengkapiKodeNeoplasma, bacaPa, sifatPa, wilayahDari, kodeJinak };
