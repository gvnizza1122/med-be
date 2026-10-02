/**
 * Kronologi pelayanan dari tanggal/jam pada setiap dokumen berkas, tanpa AI:
 * SEP, SPRI, triase, laboratorium, operasi, kelahiran, PA, resume pulang,
 * rincian biaya, dan CPPT/catatan perkembangan (rawat inap panjang).
 * Setiap peristiwa membawa halaman dan kutipan sumbernya.
 */
const { classifyPageDocumentType } = require('./pdfPageClassifier');

const BULAN = { jan: 1, januari: 1, feb: 2, februari: 2, mar: 3, maret: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6,
  jul: 7, juli: 7, agu: 8, agt: 8, agustus: 8, aug: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10,
  nov: 11, november: 11, des: 12, desember: 12, dec: 12 };

function iso(th, bl, tg) {
  const t = Number(th) < 100 ? 2000 + Number(th) : Number(th);
  if (!(bl >= 1 && bl <= 12 && tg >= 1 && tg <= 31 && t >= 2000 && t <= 2100)) return null;
  return `${t}-${String(bl).padStart(2, '0')}-${String(tg).padStart(2, '0')}`;
}

/** Tanggal pertama dalam teks: 31-12-2025, 31/12/2025, 2025-12-31, 29 Desember 2025, 2 Jan 2026. */
function ambilTanggal(teks) {
  const s = String(teks || '');
  let m = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s);
  if (m) return iso(m[1], +m[2], +m[3]);
  m = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/.exec(s);
  if (m) return iso(m[3], +m[2], +m[1]);
  m = /(?<!\d)(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})(?!\d)/.exec(s);
  if (m && BULAN[m[2].toLowerCase()]) return iso(m[3], BULAN[m[2].toLowerCase()], +m[1]);
  return null;
}
function ambilJam(teks) {
  const m = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d.])/.exec(String(teks || ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Pola per jenis dokumen: [jenis halaman | null untuk semua, pola baris, peristiwa]
const POLA = [
  ['sep', /tgl\.?\s*sep/i, 'SEP diterbitkan'],
  ['spri', /tanggal\s+mrs|tgl\.?\s*mrs/i, 'Rencana masuk rawat inap (SPRI)'],
  ['triase_igd', /^\s*tanggal\s*:/i, 'Triase IGD'],
  ['lab_results', /tgl\.?\s*(?:permintaan|periksa)/i, 'Pemeriksaan laboratorium'],
  ['laporan_operasi', /tgl\.?\s*operasi|tanggal\s+operasi/i, 'Operasi'],
  ['patologi_anatomi', /tgl\.?\s*(?:sampling|jawab|keluar)/i, 'Hasil patologi anatomi'],
  ['rincian_biaya', /tgl\.?\s*rawat/i, 'Periode rawat (rincian biaya)'],
  ['resume_medis', /tgl\s+kontrol/i, 'Rencana kontrol'],
  [null, /telah\s+lahir|^\s*tanggal\s*:\s*\d{1,2}\s+[a-z]+\s+\d{4}/i, 'Bayi lahir'],
];

/**
 * @param {Array} pages [{page_number, ocr_text}]
 * @returns {Array<{tanggal, jam, peristiwa, halaman, kutipan}>} terurut
 */
function susunKronologi(pages) {
  const hasil = [];
  const tambah = (e) => {
    if (!e.tanggal) return;
    if (hasil.some(x => x.tanggal === e.tanggal && x.peristiwa === e.peristiwa)) return;
    hasil.push(e);
  };
  for (const p of pages || []) {
    const teks = String(p.ocr_text || '');
    const jenis = classifyPageDocumentType(teks);
    const baris = teks.split(/\r?\n/);
    const kelahiran = /telah\s+lahir|surat\s+(?:keterangan\s+)?kelahiran/i.test(teks);
    for (let i = 0; i < baris.length; i++) {
      const b = baris[i];
      for (const [j, pola, peristiwa] of POLA) {
        if (j && j !== jenis) continue;
        if (peristiwa === 'Bayi lahir' && !kelahiran) continue;
        const cocok = pola.exec(b);
        if (!cocok) continue;
        // Tanggal diambil SETELAH label: "Umur 19/01/2004 ... Tgl Operasi : 2/1/26"
        // dulu terbaca tanggal lahir sebagai tanggal operasi.
        const konteks = `${b.slice(cocok.index)} ${baris[i + 1] || ''}`;
        const tanggal = ambilTanggal(konteks);
        if (!tanggal) continue;
        const jamBaris = baris.slice(i, i + 3).find(x => /jam|pukul/i.test(x));
        tambah({ tanggal, jam: ambilJam(jamBaris || b), peristiwa, halaman: p.page_number, kutipan: b.trim().slice(0, 160) });
        // Rincian biaya "Tgl Rawat : 2 Jan 2026 - 3 Jan 2026": tanggal pulang juga.
        if (jenis === 'rincian_biaya') {
          const kedua = ambilTanggal(konteks.slice(konteks.indexOf('-', konteks.search(/\d{4}/)) + 1));
          if (kedua && kedua !== tanggal) tambah({ tanggal: kedua, jam: null, peristiwa: 'Pulang (rincian biaya)', halaman: p.page_number, kutipan: b.trim().slice(0, 160) });
        }
      }
    }
    // Resume: tanggal-jam cetak di kop = saat resume pulang dibuat.
    if (jenis === 'resume_medis') {
      const kop = baris.slice(0, 12).find(x => /(?<!\d)\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2}/.test(x));
      if (kop) tambah({ tanggal: ambilTanggal(kop), jam: ambilJam(kop), peristiwa: /igd|rawat\s+jalan/i.test(teks) ? 'Resume medis kunjungan' : 'Resume medis pulang', halaman: p.page_number, kutipan: kop.trim().slice(0, 160) });
    }
    // CPPT / catatan perkembangan: baris bertanggal diikuti asesmen (A).
    if (/cppt|catatan\s+perkembangan\s+pasien\s+terintegrasi|catatan\s+perkembangan/i.test(teks)) {
      for (let i = 0; i < baris.length; i++) {
        const tg = ambilTanggal(baris[i]);
        if (!tg) continue;
        const blok = baris.slice(i, i + 8).join(' ');
        const a = /\bA\s*[:/]\s*([^|]{3,120}?)(?=\s+P\s*[:/]|$)/i.exec(blok);
        tambah({ tanggal: tg, jam: ambilJam(baris[i]), peristiwa: a ? `Catatan perkembangan: ${a[1].trim()}` : 'Catatan perkembangan', halaman: p.page_number, kutipan: baris[i].trim().slice(0, 160) });
      }
    }
  }
  return hasil.sort((a, b) => `${a.tanggal} ${a.jam || '99:99'}`.localeCompare(`${b.tanggal} ${b.jam || '99:99'}`));
}

module.exports = { susunKronologi, ambilTanggal, ambilJam };
