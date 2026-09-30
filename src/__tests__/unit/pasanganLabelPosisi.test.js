/**
 * Pasangan label <-> isi berdasarkan posisi kata.
 *
 * JUJUR SOAL SUMBER DATA: tidak ada PDF asli di lingkungan pengembangan. Tata
 * letak di sini SINTETIS — hanya koordinat yang dilaporkan `pdftotext -bbox`
 * pada berkas 0170R0110926V001943 halaman 2 (Diagnosa y=441.3, isi
 * "Nebulisasi Ventasal" y=481.5, Tindakan y=489.6, Rencana y=513.6) yang nyata;
 * baris lain (Penyebab Cedera, isi Diagnosa, dsb) dan lebar kata direkaan.
 * Satu tes membuat PDF sungguhan dari tata letak itu dan membacanya lewat
 * mupdf, untuk menguji jalur ekstraksi ujung ke ujung — tetap PDF sintetis.
 */
const {
  ambilIsiLabel, pasangkanSemuaLabel, bacaLabelHalaman, cariLabel,
} = require('../../services/pasanganLabelPosisiService');
const { classifyPageDocumentType } = require('../../services/pdfPageClassifier');

const w = (text, x0, top) => ({ text, x0, x1: x0 + text.length * 5, top, bottom: top + 9 });

/** Halaman 2 resume IGD: label terpusat vertikal, isi menempel di atas sel. */
function halamanResume() {
  return [
    w('RESUME', 200, 60), w('MEDIS', 245, 60), w('IGD', 280, 60),
    w('Diagnosa', 40, 441.3), w('PPOK,', 150, 441.3), w('Pneumonia', 150, 453.0),
    w('Penyebab', 40, 465.0), w('Cedera', 92, 465.0), w('-', 150, 465.0),
    w('Nebulisasi', 150, 481.5), w('Ventasal', 205, 481.5),
    w('Tindakan', 40, 489.6),
    w('Rencana', 40, 513.6), w('Rawat', 150, 513.6), w('jalan', 180, 513.6),
  ];
}

describe('ambilIsiLabel — kasus resume dengan label terpusat vertikal', () => {
  test('isi Tindakan yang 8 pt DI ATAS labelnya terbaca', () => {
    const r = ambilIsiLabel(halamanResume(), 'Tindakan', 'Rencana', { labelSebelum: 'Penyebab Cedera' });
    expect(r.ditemukan).toBe(true);
    expect(r.kata).toEqual(['Nebulisasi', 'Ventasal']);
  });

  test('Nebulisasi Ventasal TIDAK menempel ke label Penyebab Cedera', () => {
    const r = ambilIsiLabel(halamanResume(), 'Penyebab Cedera', 'Tindakan', { labelSebelum: 'Diagnosa' });
    expect(r.teks).toBe('-');
  });

  test('pola yang sama untuk Diagnosa', () => {
    const r = ambilIsiLabel(halamanResume(), 'Diagnosa', 'Penyebab Cedera');
    expect(r.teks).toBe('PPOK, Pneumonia');
  });

  test('isi tidak boleh jauh di atas label (di luar toleransi 12 pt)', () => {
    const kata = [w('Tindakan', 40, 489.6), w('Nebulisasi', 150, 470.0), w('Rencana', 40, 513.6)];
    expect(ambilIsiLabel(kata, 'Tindakan', 'Rencana').kata).toEqual([]);
  });

  test('kata di KIRI label bukan isinya', () => {
    const kata = [w('Tindakan', 100, 489.6), w('Nebulisasi', 20, 489.6), w('Rencana', 100, 513.6)];
    expect(ambilIsiLabel(kata, 'Tindakan', 'Rencana').kata).toEqual([]);
  });

  test('kata di bawah label berikutnya bukan isinya', () => {
    const kata = [w('Tindakan', 40, 489.6), w('Rencana', 40, 513.6), w('Rawat', 150, 513.6)];
    expect(ambilIsiLabel(kata, 'Tindakan', 'Rencana').kata).toEqual([]);
  });

  test('label tidak ada -> ditemukan false, bukan galat', () => {
    expect(ambilIsiLabel(halamanResume(), 'Alergi', 'Rencana')).toEqual({ ditemukan: false, kata: [], teks: '' });
    expect(ambilIsiLabel([], 'Tindakan', 'Rencana').ditemukan).toBe(false);
    expect(ambilIsiLabel(null, 'Tindakan', 'Rencana').ditemukan).toBe(false);
  });

  test('isi berbaris ganda dirakit berurutan atas ke bawah', () => {
    const kata = [
      w('Tindakan', 40, 500), w('inj', 150, 490), w('omeprazole', 175, 490),
      w('inj', 150, 502), w('ketorolac', 175, 502), w('Rencana', 40, 530),
    ];
    expect(ambilIsiLabel(kata, 'Tindakan', 'Rencana').teks).toBe('inj omeprazole inj ketorolac');
  });
});

describe('pasangkanSemuaLabel / bacaLabelHalaman', () => {
  test('memasangkan seluruh label resume sekaligus', () => {
    const p = pasangkanSemuaLabel(halamanResume(), [
      { label: 'Diagnosa' }, { label: 'Penyebab Cedera' }, { label: 'Tindakan' }, { label: 'Rencana' },
    ]);
    expect(p.Tindakan).toBe('Nebulisasi Ventasal');
    expect(p.Diagnosa).toBe('PPOK, Pneumonia');
    expect(p['Penyebab Cedera']).toBe('-');
    expect(p.Rencana).toBe('Rawat jalan');
  });

  test('hanya berlaku pada halaman RESUME (pdfPageClassifier)', () => {
    const teksResume = 'RESUME MEDIS IGD\nDiagnosa PPOK';
    expect(classifyPageDocumentType(teksResume)).toBe('resume_medis');
    expect(bacaLabelHalaman(halamanResume(), classifyPageDocumentType(teksResume)).Tindakan).toBe('Nebulisasi Ventasal');

    // Halaman lain yang kebetulan punya kata "Tindakan" tidak dibaca.
    for (const teks of ['TRIAGE IGD\nRisiko Jatuh\nTindakan', 'R/ Masker Nebul DWS', 'Rincian Biaya']) {
      expect(bacaLabelHalaman(halamanResume(), classifyPageDocumentType(teks))).toEqual({});
    }
  });

  test('"Tindakan Keperawatan" adalah label lain dan diabaikan', () => {
    const kata = [
      w('Tindakan', 40, 300), w('Keperawatan', 90, 300), w('nebul', 200, 300), w('ventasal', 235, 300),
      w('Rencana', 40, 330),
    ];
    expect(cariLabel(kata, 'Tindakan', { hindariDiikuti: ['keperawatan'] })).toEqual([]);
    expect(bacaLabelHalaman(kata, 'resume_medis').Tindakan).toBeUndefined();
  });

  test('"Tindakan" kosong (mis. Risiko Jatuh) memberi string kosong, bukan isi tetangga', () => {
    const kata = [w('Tindakan', 40, 400), w('Rencana', 40, 430), w('Rawat', 150, 430)];
    expect(bacaLabelHalaman(kata, 'resume_medis').Tindakan).toBe('');
  });

  test('tanpa koordinat -> {} (pemanggil jatuh ke jalur teks)', () => {
    expect(bacaLabelHalaman(undefined, 'resume_medis')).toEqual({});
    expect(bacaLabelHalaman([], 'resume_medis')).toEqual({});
  });
});

// ── ujung ke ujung dengan PDF sungguhan (sintetis) ─────────────────────────
function buatPdf(kata, tinggi = 842) {
  const isi = kata.map(k => {
    const y = (tinggi - k.top - 8).toFixed(2);
    return `BT /F1 10 Tf 1 0 0 1 ${k.x0.toFixed(2)} ${y} Tm (${k.text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  }).join('\n');
  const objek = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${tinggi}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(isi)} >>\nstream\n${isi}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offset = [];
  objek.forEach((o, i) => { offset.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objek.length + 1}\n0000000000 65535 f \n`;
  offset.forEach(o => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objek.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// mupdf adalah modul ESM dan dimuat lewat import() dinamis, yang tidak jalan di
// dalam VM jest (tanpa --experimental-vm-modules). Jadi ekstraksinya dijalankan
// di proses Node terpisah — sama seperti di produksi, di luar sandbox jest.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ekstrakDiProsesTerpisah(buffer, halaman) {
  const berkas = path.join(os.tmpdir(), `kotak-kata-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(berkas, buffer);
  try {
    const skrip = `
      const { ekstrakKotakKata } = require(${JSON.stringify(path.resolve(__dirname, '../../services/pdfWordBoxService'))});
      const fs = require('fs');
      ekstrakKotakKata(fs.readFileSync(process.argv[1]), JSON.parse(process.argv[2]))
        .then(p => process.stdout.write(JSON.stringify([...p])));
    `;
    const keluar = execFileSync(process.execPath, ['-e', skrip, berkas, JSON.stringify(halaman)], { encoding: 'utf8' });
    return new Map(JSON.parse(keluar));
  } finally {
    fs.unlinkSync(berkas);
  }
}

describe('ekstrakKotakKata + pasangan label — PDF sintetis sungguhan', () => {
  test('kotak kata dibaca dari PDF dan isi Tindakan terpasang', () => {
    const peta = ekstrakDiProsesTerpisah(buatPdf(halamanResume()), [1]);
    expect(peta.has(1)).toBe(true);
    const kata = peta.get(1);
    expect(kata.map(k => k.text)).toEqual(expect.arrayContaining(['Tindakan', 'Nebulisasi', 'Ventasal', 'Diagnosa']));
    const nilai = bacaLabelHalaman(kata, 'resume_medis');
    expect(nilai.Tindakan).toBe('Nebulisasi Ventasal');
    expect(nilai.Diagnosa).toBe('PPOK, Pneumonia');
  });

  test('PDF rusak / bukan PDF -> peta kosong, tidak melempar', () => {
    expect(ekstrakDiProsesTerpisah(Buffer.from('bukan pdf'), [1]).size).toBe(0);
  });

  test('halaman di luar jangkauan diabaikan', () => {
    expect(ekstrakDiProsesTerpisah(buatPdf(halamanResume()), [9]).size).toBe(0);
  });
});
