/**
 * Kesesuaian klaim RAWAT INAP tumor jaringan lunak (STT) dengan BA 2024
 * (JP.02.03/H.IV/3760/2024 - 1247/BA/1124, aspek medis no. 1, berlaku untuk
 * tanggal pulang RI mulai 1 Desember 2024):
 *   Rawat inap STT memenuhi SALAH SATU:
 *     1. deep tumor: di bawah fascia / menginfiltrasi;
 *     2. salah satu dimensi > 4 cm YANG MELUAS ke struktur vital
 *        (pembuluh darah utama, saraf utama, saluran pernapasan, tulang);
 *     3. STT dengan keganasan.
 *   Di luar kriteria itu diklaimkan sebagai rawat jalan. Kelengkapan: PA
 *   dan/atau laporan operasi eksisi tumor.
 *
 * Pemeriksaan bukti per kriteria memakai laporanOperasiService. Yang DITAMBAH
 * di sini: apakah KODE yang diajukan mencerminkan lesi yang memenuhi kriteria.
 * KASUS ACUAN STT (0000R0000126V000001): kriteria hanya terpenuhi oleh massa 5x4 cm
 * "di antara otot" pectoralis (dinding dada, hal. 14), tetapi klaim diajukan
 * dengan 86.3 (eksisi kulit/subkutis) dan R22.0/R22.3 (benjolan kepala &
 * lengan) -- di mata verifikator itu lesi superfisial yang diklaimkan rawat
 * jalan. Dulu aplikasi menyatakan "tidak ditemukan alasan pending".
 *
 * Tidak mengubah kode; hanya alasan pending beserta bukti dan tindakannya.
 */
const { susunLaporanOperasi } = require('./laporanOperasiService');

const BERLAKU_MULAI = '2024-12-01';
const SUPERFISIAL = /^86\.[34]$/; // eksisi lesi kulit & subkutis
const JARINGAN_DALAM = /^83\.(?:3\d?|4\d?)$/; // eksisi lesi otot/tendon/fascia/jaringan lunak lain
const DX_STT = /^(?:R22|D17|D21|D48\.1|C49)/;

// Lokasi lesi dan kode diagnosis yang menunjuk lokasi itu.
const LOKASI = [
  ['dada', /\b(?:dada|thorax|thoraks|toraks|pectoral\w*|pektoral\w*|aksila|axilla)\b/i, /^(?:R22\.2|D17\.[14]|D21\.[36]|C49\.3)/],
  ['punggung', /\b(?:punggung|scapula|skapula|paravertebra\w*|latissimus)\b/i, /^(?:R22\.2|D17\.1|D21\.6|C49\.6)/],
  ['perut', /\b(?:abdomen|perut|rektus|rectus)\b/i, /^(?:R22\.2|D17\.[15]|D21\.4|C49\.4)/],
  ['kepala/leher', /\b(?:kepala|frontal|temporal|oksipital|occipital|parietal|wajah|leher|colli|platysma|scalp)\b/i, /^(?:R22\.[01]|D17\.0|D21\.0|C49\.0)/],
  ['lengan', /\b(?:lengan|brachi\w*|antebrachi\w*|humerus|bahu|shoulder|deltoid|biceps|triceps|manus|tangan)\b/i, /^(?:R22\.3|D17\.2|D21\.1|C49\.1)/],
  ['tungkai', /\b(?:tungkai|femur|femoral|cruris|paha|betis|genu|pedis|kaki|gluteal|bokong)\b/i, /^(?:R22\.4|D17\.2|D21\.[25]|C49\.2)/],
];
const POLA_DALAM = /\b(?:di\s*bawah\s+(?:fasia|fascia)|sub[ -]?(?:fasial|fascial)|intra[ -]?muskul\w*|inter[ -]?muskul\w*|di\s+antara\s+otot|menginfiltrasi|menembus)\b/i;

const norm = (k) => String(k || '').trim().toUpperCase();
const isi = (p) => String(p?.ocr_text ?? p?.text ?? '');

/** Langkah narasi operasi yang memuat temuan tumor dalam + 2 langkah sebelumnya. */
function konteksLesiDalam(teks) {
  // Baris OCR sering terputus di tengah kalimat; gabungkan dulu, lalu pecah per
  // langkah narasi operasi ("- Insisi ... - Platysma split ... - Massa ...").
  const langkah = String(teks).replace(/\s+/g, ' ').split(/\s-\s|;/).map(s => s.trim()).filter(Boolean);
  const i = langkah.findIndex(s => POLA_DALAM.test(s));
  if (i < 0) return null;
  return langkah.slice(Math.max(0, i - 2), i + 1).join(' - ');
}

function lokasiDari(teks) {
  return LOKASI.filter(([, re]) => re.test(teks)).map(([nama]) => nama);
}

/** Baris "Diagnosis pra/pasca tindakan" beserta isinya pada laporan operasi. */
function diagnosisTindakan(teks) {
  const baris = String(teks || '').split(/\r?\n/);
  return baris.flatMap((l, i) => /\bdiagnosis\s+(?:pra|pasca|post|pre)\b/i.test(l) ? [l, baris[i + 1] || ''] : []).join('\n');
}

function ukuranDari(teks) {
  const m = /(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)(?:\s*[x×*]\s*(\d+(?:[.,]\d+)?))?\s*(?:cm|mm)/i.exec(teks || '');
  return m ? m[0].replace(/cmcm/i, 'cm') : null;
}

/**
 * @param {{jenisKlaim:string, dx:string[], px:string[], pages:Array, tanggal?:string}} masukan
 * @returns {null | {id, keparahan, wajib_pending, ringkas, penjelasan, bukti_ringkas, tindakan, kriteria}}
 */
function nilaiKesesuaianStt({ jenisKlaim, dx = [], px = [], pages = [], tanggal = null } = {}) {
  if (String(jenisKlaim || '').toUpperCase() !== 'RAWAT_INAP') return null;
  if (tanggal && String(tanggal).slice(0, 10) < BERLAKU_MULAI) return null;
  const kodeDx = dx.map(norm).filter(Boolean);
  const kodePx = px.map(k => String(k || '').trim()).filter(Boolean);
  const pxSuperfisial = kodePx.filter(k => SUPERFISIAL.test(k));
  const pxDalam = kodePx.filter(k => JARINGAN_DALAM.test(k));
  if (!pxSuperfisial.length && !pxDalam.length) return null;

  const r = susunLaporanOperasi(pages);
  const tentangTumor = r.laporan.some(l => /\b(?:tumou?r|massa|lipoma|benjolan)\b/i.test(l.teks));
  if (!kodeDx.some(k => DX_STT.test(k)) && !tentangTumor) return null;

  const kriteria = Object.fromEntries(r.kriteria_stt.map(k => [k.id, k]));
  const dasar = 'BA 2024 (aspek medis no. 1): rawat inap STT harus memenuhi salah satu -- tumor di bawah fascia/menginfiltrasi, '
    + 'dimensi >4 cm yang meluas ke struktur vital, atau ganas; di luar itu diklaimkan sebagai rawat jalan.';

  // 3. Ganas: kriteria terpenuhi apa pun lokasi kodenya.
  if (kriteria.keganasan?.status === 'bukti_pendukung') return null;

  const laporanTerbaca = r.laporan.some(l => /\b(?:prosedur|rincian temuan|insisi|eksisi)\b/i.test(l.teks) && l.teks.length > 200);
  const lesiDalam = kriteria.kedalaman?.status === 'bukti_pendukung' ? kriteria.kedalaman.bukti[0] : null;

  if (lesiDalam) {
    // 1. Tumor dalam terdokumentasi. Kode jaringan dalam -> sesuai.
    if (pxDalam.length) return null;
    const halamanOp = r.laporan.find(l => l.page_number === lesiDalam.page_number) || r.laporan[0];
    const teksOp = halamanOp ? halamanOp.teks : lesiDalam.kutipan;
    const konteks = konteksLesiDalam(teksOp) || lesiDalam.kutipan;
    // Lokasi lesi dalam hanya dari langkah yang memuat temuan dalam (langkah
    // sebelumnya bisa milik lesi lain); bila tidak disebut, pakai lokasi pada
    // diagnosis pra/pasca tindakan yang tidak tercantum di kode.
    const langkahDalam = konteks.split(' - ').slice(-1)[0];
    const ukuran = ukuranDari(langkahDalam) || ukuranDari(konteks);
    const lokasiDalam = lokasiDari(langkahDalam);
    const lokasiDiagnosis = lokasiDari(diagnosisTindakan(teksOp));
    const tidakDikode = lokasiDiagnosis.filter(n => !kodeDx.some(k => LOKASI.find(l => l[0] === n)[2].test(k)));
    const lokasi = lokasiDalam.length ? lokasiDalam : tidakDikode;
    const lokasiPasti = lokasiDalam.length > 0;
    const belumDikode = lokasi.length > 0 && lokasi.some(n => tidakDikode.includes(n));
    const pa = r.patologi.map(p => (/\bbahan\s*:\s*([^\n]+)/i.exec(p.teks) || [])[1]).filter(Boolean).map(b => b.trim());
    const paJinak = r.patologi.some(p => /\b(?:benign|jinak|tidak didapat(?:kan)? tanda ganas|tidak ganas)\b/i.test(p.teks));
    const paTanpaLokasi = lokasi.length > 0 && pa.length > 0 && !pa.some(b => lokasi.some(n => LOKASI.find(l => l[0] === n)[1].test(b)));
    const lesiLain = [...new Set(r.laporan.flatMap(l => l.ukuran).map(u => u.nilai_tertulis.replace(/cmcm/i, 'cm')))]
      .filter(u => !ukuran || u.replace(/\s/g, '') !== ukuran.replace(/\s/g, ''));
    const besarTanpaVital = r.laporan.some(l => l.ukuran.some(u => u.terbesar_cm > 4)) && kriteria.ukuran_dan_vital?.status !== 'perlu_konfirmasi_lesi_sama';
    const lesi = `tumor ${ukuran || ''} ${lokasiPasti ? `di ${lokasi.join('/')} ` : ''}di antara otot/di bawah fascia`.replace(/\s+/g, ' ');
    const kodeDiajukan = `${pxSuperfisial.join(', ')} (eksisi lesi kulit/subkutis)${kodeDx.length ? ` + ${kodeDx.join(', ')}` : ''}`;
    return {
      id: 'BA-STT-KODE',
      keparahan: 'tinggi',
      wajib_pending: true,
      ringkas: `STT rawat inap berisiko dialihkan ke rawat jalan: syarat rawat inap hanya dipenuhi ${lesi} (hal. ${lesiDalam.page_number}), tetapi kode ${pxSuperfisial.join(', ')}${kodeDx.length ? ` + ${kodeDx.join(', ')}` : ''} menggambarkan eksisi benjolan kulit/subkutis`,
      penjelasan: [
        'Syarat BA 2024 (aspek medis no. 1): rawat inap STT bila memenuhi salah satu -- (1) tumor di bawah fascia/menginfiltrasi, (2) ukuran >4 cm DAN meluas ke struktur vital, atau (3) ganas. Di luar itu diklaimkan rawat jalan.',
        `Yang tertulis: (1) terpenuhi oleh ${lesi} (hal. ${lesiDalam.page_number}).`
          + (besarTanpaVital ? ' (2) tidak terpenuhi: ukuran >4 cm tertulis, tetapi tidak disebut meluas ke struktur vital.' : '')
          + (paJinak ? ' (3) tidak terpenuhi: PA jinak.' : '')
          + (lesiLain.length ? ` Lesi lain (${lesiLain.join(', ')}) tidak disebut di bawah fascia, jadi tidak menjadi syarat rawat inap.` : ''),
        `Masalahnya: kode ${kodeDiajukan} dibaca verifikator sebagai eksisi benjolan kulit/subkutis, yaitu kasus rawat jalan; tumor dalam yang menjadi alasan rawat inap tidak tercermin di kode.`,
        belumDikode ? (lokasiPasti ? `Lokasi lesi dalam itu (${lokasi.join('/')}) belum tercantum pada kode diagnosis.`
          : `Diagnosis pra/pasca tindakan juga menyebut tumor di ${lokasi.join('/')}, tetapi lokasi itu tidak ada di kode diagnosis.`) : null,
        paTanpaLokasi ? `Bahan PA hanya "${pa[0]}", tidak menyebut lesi ${lokasi.join('/')}.` : null,
      ].filter(Boolean).join(' '),
      bukti_ringkas: `"${konteks.slice(0, 260)}" (hal. ${lesiDalam.page_number})`,
      tindakan: 'Bila tumor dalam itu indikasi rawat inapnya: kode tindakannya sebagai eksisi lesi jaringan lunak/otot (mis. 83.39 atau 83.32, sesuai keputusan operator) '
        + 'dan diagnosis sesuai PA serta lokasinya, pastikan PA mencakup lesi tersebut. Bila tidak, klaim berisiko dialihkan ke rawat jalan.',
      kriteria: r.kriteria_stt.map(k => ({ id: k.id, status: k.status })),
    };
  }

  // Tidak ada kriteria yang terdokumentasi.
  if (kriteria.ukuran_dan_vital?.status === 'perlu_konfirmasi_lesi_sama') {
    return {
      id: 'BA-STT-KRITERIA', keparahan: 'sedang', wajib_pending: false,
      ringkas: 'Rawat inap STT: ukuran >4 cm dan struktur vital perlu dipastikan berasal dari lesi yang sama',
      penjelasan: dasar, bukti_ringkas: null,
      tindakan: 'Pastikan laporan operasi menyebut lesi yang sama berukuran >4 cm dan meluas ke struktur vital.',
      kriteria: r.kriteria_stt.map(k => ({ id: k.id, status: k.status })),
    };
  }
  return {
    id: 'BA-STT-KRITERIA',
    keparahan: laporanTerbaca ? 'tinggi' : 'sedang',
    wajib_pending: laporanTerbaca,
    ringkas: laporanTerbaca
      ? 'Rawat inap STT tanpa kriteria BA 2024 (tumor dalam, >4 cm meluas ke struktur vital, atau ganas)'
      : `Rawat inap STT: laporan operasi ${r.laporan.length ? `(hal. ${r.laporan.map(l => l.page_number).join(', ')}) tidak terbaca` : 'tidak ada di berkas'} sehingga kedalaman/ukuran/keganasan tumor belum dapat dinilai`,
    penjelasan: laporanTerbaca
      ? `${dasar} Laporan operasi terbaca, tetapi tidak menyebut tumor di bawah fascia/infiltratif, perluasan ke struktur vital, maupun keganasan.`
      : `${dasar} Laporan operasi tidak tersedia atau tidak terbaca (mis. tulisan tangan), sehingga kriteria belum dapat dinilai.`,
    bukti_ringkas: null,
    tindakan: laporanTerbaca
      ? 'Lengkapi uraian kedalaman/perluasan tumor oleh operator bila memang ada; bila tidak, klaim berisiko dialihkan ke rawat jalan.'
      : 'Periksa laporan operasi dan PA asli.',
    kriteria: r.kriteria_stt.map(k => ({ id: k.id, status: k.status })),
  };
}

module.exports = { nilaiKesesuaianStt, BERLAKU_MULAI };
