/**
 * Penilai deterministik matriks IGD BA 2024 (lampiran 1, PDF hal. 6-7) dari
 * dokumen IGD yang tersimpan: lembar triase (ESI, primary survey ABC, GCS,
 * tanda vital), catatan "Tiba di ruangan ... dari ruangan UGD", SPRI/resume.
 *
 * Ambang memakai sumber yang sudah ada di katalog: GCS <=8 (matriks BA 2024),
 * SpO2 <91% (BA 2018 butir 17), TD sistolik <90 mmHg (BA 2018 butir 1/8);
 * anak memakai tabel tanda vital normal & persentil 5 TD sistolik PNPK Sepsis
 * pada Anak (KMK 4722/2021, hal. 15-16). Tidak menetapkan false emergency
 * secara otomatis dan tidak mengubah kode/status klaim.
 */
const teks = p => String(p?.ocr_text ?? p?.text ?? '');
const BULAN = { januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12 };

function tanggalIndo(s) {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s) || /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s);
  if (!m) return null;
  const bln = BULAN[String(m[2]).toLowerCase()] || Number(m[2]);
  return bln ? `${m[3]}-${String(bln).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null;
}

// Tabel PNPK Sepsis pada Anak: batas atas nadi & napas normal, persentil 5 TD sistolik.
function batasAnak(usia) {
  const hari = usia.hari, th = usia.tahun;
  if (th === null) return null;
  if (hari !== null && hari <= 30) return { hr: 190, rr: 68, sbp: 60, kelompok: '0 hari-1 bulan' };
  if (th < 2) return { hr: 180, rr: 58, sbp: th < 1 ? 70 : 72, kelompok: '>1 bulan-<2 tahun' };
  if (th <= 5) return { hr: 160, rr: 44, sbp: 70 + 2 * th, kelompok: '2-5 tahun' };
  if (th <= 12) return { hr: 140, rr: 38, sbp: th <= 10 ? 70 + 2 * th : 90, kelompok: '6-12 tahun' };
  if (th < 18) return { hr: 130, rr: 35, sbp: 90, kelompok: '13-18 tahun' };
  return null;
}

function halamanTriase(pages) {
  return (pages || []).filter(p => /\b(?:TRIAGE|TRIASE)\s*(?:IGD|UGD)?\b|\bSkor\s*ESI\b|PRIMARY\s*SURVEY/i.test(teks(p)));
}

function bacaTriase(pages) {
  const out = { esi: null, abc: [], gcs: null, td: [], hr: [], rr: [], spo2: [], mulai: null, kutipan: [] };
  for (const p of halamanTriase(pages)) {
    const t = teks(p), lines = t.split(/\r?\n/);
    const esi = /\b(?:Skor\s*)?ESI\s*[:=]?\s*(?:ESI\s*)?([1-5])\b/i.exec(t);
    if (esi && out.esi === null) { out.esi = Number(esi[1]); out.kutipan.push({ page_number: p.page_number, kutipan: esi[0] }); }
    const tgl = /Tanggal\s*:?\s*([^\n]{6,25})/i.exec(t), jam = /Mulai\s*Pukul\s*:?\s*(\d{1,2})[:.](\d{2})/i.exec(t);
    if (!out.mulai && tgl && jam && tanggalIndo(tgl[1])) out.mulai = { tanggal: tanggalIndo(tgl[1]), jam: `${jam[1].padStart(2, '0')}:${jam[2]}`, page_number: p.page_number, kutipan: `${tgl[0].trim()} ${jam[0]}` };
    lines.forEach((l, i) => {
      // Primary survey: nilai pada baris yang sama atau 1-2 baris berikutnya.
      if (/Airway/i.test(l) && /Breathing/i.test(l)) {
        const nilai = [l.split(/Exposure/i)[1] || '', lines[i + 1] || '', lines[i + 2] || ''].join(' ');
        const abn = nilai.match(/\b(?:sumbatan|obstruksi|gurgling|snoring|stridor|sesak|takipne\w*|dispne\w*|apne\w*|retraksi|syok|pucat|sianosis|akral dingin|perdarahan|CRT\s*>\s*2\w*|unresponsive|pain|sopor|koma|somnolen|tidak\s+paten)\b/gi);
        if (abn) out.abc.push({ page_number: p.page_number, kutipan: `${l.trim()} | ${nilai.trim()}`.slice(0, 220), temuan: [...new Set(abn.map(x => x.toLowerCase()))] });
      }
      const sat = /\b(?:SpO2|SpO₂|saturasi)\s*[:=]?\s*(\d{2,3})\s*%/i.exec(l);
      if (sat && !/x\s*\/\s*m/i.test(l) && Number(sat[1]) >= 40 && Number(sat[1]) <= 100) out.spo2.push({ nilai: Number(sat[1]), page_number: p.page_number, kutipan: l.trim() });
      const g = /\bGCS\s*[:=]?\s*(\d{1,2})\b/i.exec(l) || /\bE\s*(\d)\s*V\s*(\d|T)\s*M\s*(\d)\b/i.exec(l);
      if (g && out.gcs === null) out.gcs = { nilai: g.length > 2 ? Number(g[1]) + (g[2] === 'T' ? 1 : Number(g[2])) + Number(g[3]) : Number(g[1]), page_number: p.page_number, kutipan: l.trim() };
      if (/\bcompos\s*ment\w*/i.test(l) && out.gcs === null) out.gcs = { nilai: 15, page_number: p.page_number, kutipan: l.trim() };
      // Baris nilai tabel tanda vital: "139/82 mmHg 72 x/mnt 22 x/mnt 37oC 98%".
      if (/x\s*\/\s*m/i.test(l)) {
        const td = /(\d{2,3})\s*\/\s*(\d{2,3})\s*mm\s*Hg/i.exec(l);
        if (td && Number(td[1]) > 0) out.td.push({ nilai: Number(td[1]), page_number: p.page_number, kutipan: l.trim() });
        const perMenit = [...l.matchAll(/(\d{1,3})\s*x\s*\/\s*m/gi)].map(m => Number(m[1]));
        const judul = lines.slice(Math.max(0, i - 3), i).join(' ');
        if (perMenit.length >= 2 && /heart\s*rate|\bHR\b|nadi/i.test(judul)) { out.hr.push({ nilai: perMenit[0], page_number: p.page_number, kutipan: l.trim() }); out.rr.push({ nilai: perMenit[1], page_number: p.page_number, kutipan: l.trim() }); }
        const sp = /(\d{2,3})\s*%/.exec(l.replace(/\d{2,3}\s*\/\s*\d{2,3}/, ''));
        if (sp && Number(sp[1]) >= 40 && Number(sp[1]) <= 100) out.spo2.push({ nilai: Number(sp[1]), page_number: p.page_number, kutipan: l.trim() });
      }
    });
  }
  return out;
}

/** Kriteria gawat darurat a-e matriks BA 2024 dari dokumen. */
function kriteriaGawatDarurat(record, pages, opsi = {}) {
  const usia = require('./usiaPasienService').resolveUsia(record);
  const tr = bacaTriase(pages);
  const anak = batasAnak(usia);
  const kena = [];
  const tambah = (kode, nama, b) => kena.push({ kode, nama, page_number: b.page_number, kutipan: String(b.kutipan).slice(0, 220) });
  if (tr.esi === 1) tambah('a', 'Mengancam nyawa (ESI 1: perlu intervensi penyelamatan segera)', tr.kutipan[0]);
  for (const b of tr.abc) tambah('b', `Gangguan jalan napas/pernapasan/sirkulasi pada primary survey (${b.temuan.join(', ')})`, b);
  if (tr.gcs && tr.gcs.nilai <= 8) tambah('c', `Penurunan kesadaran GCS ${tr.gcs.nilai} (<=8)`, tr.gcs);
  const spo2 = tr.spo2.find(b => b.nilai < 91); if (spo2) tambah('b', `SpO2 ${spo2.nilai}% (<91%)`, spo2);
  const sbpBatas = anak ? anak.sbp : 90;
  const td = tr.td.find(b => b.nilai < sbpBatas); if (td) tambah('d', `Gangguan hemodinamik: TD sistolik ${td.nilai} mmHg (<${sbpBatas}${anak ? `, persentil 5 usia ${anak.kelompok}` : ''})`, td);
  if (anak) {
    const hr = tr.hr.find(b => b.nilai > anak.hr); if (hr) tambah('d', `Nadi ${hr.nilai}x/menit di atas normal usia ${anak.kelompok} (>${anak.hr})`, hr);
    const rr = tr.rr.find(b => b.nilai > anak.rr); if (rr) tambah('b', `Napas ${rr.nilai}x/menit di atas normal usia ${anak.kelompok} (>${anak.rr})`, rr);
  }
  const px = String(record.prosedur_list || record.PROCLIST || '').split(/[;,]/).map(s => s.trim());
  const pxSegera = px.filter(k => /^(?:93\.93|96\.04|99\.6[0-2]|34\.04)/.test(k));
  if (pxSegera.length) kena.push({ kode: 'e', nama: `Tindakan segera (${pxSegera.join(', ')})`, page_number: null, kutipan: `Kode prosedur diklaim: ${pxSegera.join(', ')}` });
  for (const p of halamanTriase(pages)) {
    const m = /\b(?:RJP|CPR|intubasi|DC shock|defibrilasi|resusitasi jantung paru|bagging)\b/i.exec(teks(p));
    if (m) { kena.push({ kode: 'a/e', nama: `Tindakan penyelamatan segera (${m[0]})`, page_number: p.page_number, kutipan: m[0] }); break; }
  }
  const terbaca = [tr.esi !== null ? `ESI ${tr.esi}` : null, tr.abc.length ? 'primary survey abnormal' : halamanTriase(pages).some(p => /Airway/i.test(teks(p))) ? 'primary survey ABC clear' : null,
    tr.gcs ? `GCS ${tr.gcs.nilai}` : null, tr.td[0] ? `TD sistolik ${tr.td[0].nilai}` : null, tr.hr[0] ? `nadi ${tr.hr[0].nilai}` : null, tr.rr[0] ? `napas ${tr.rr[0].nilai}` : null,
    tr.spo2[0] ? `SpO2 ${tr.spo2[0].nilai}%` : null].filter(Boolean);
  return { kena, terbaca, ada_triase: halamanTriase(pages).length > 0, triase: tr };
}

/** Durasi di IGD dari jam triase (masuk) sampai "Tiba di ruangan ... dari ruangan UGD/IGD" (keluar). */
function durasiIgd(pages) {
  const tr = bacaTriase(pages);
  let keluar = null;
  for (const p of pages || []) {
    const t = teks(p).replace(/\s+/g, ' ');
    const m = /Tiba di ruangan\s*:?\s*([^:]{1,40}?)\s*dari ruangan\s*:?\s*(UGD|IGD)\s*Tanggal\s*:?\s*([^:]{6,25}?)\s*Pukul\s*:?\s*(\d{1,2})[:.](\d{2})/i.exec(t);
    if (m && tanggalIndo(m[3])) { keluar = { tanggal: tanggalIndo(m[3]), jam: `${m[4].padStart(2, '0')}:${m[5]}`, ruang: m[1].trim(), page_number: p.page_number, kutipan: m[0].slice(0, 200) }; break; }
  }
  if (!tr.mulai || !keluar) return { masuk: tr.mulai, keluar, jam: null };
  const jam = (Date.parse(`${keluar.tanggal}T${keluar.jam}:00`) - Date.parse(`${tr.mulai.tanggal}T${tr.mulai.jam}:00`)) / 3600000;
  return { masuk: tr.mulai, keluar, jam: Number.isFinite(jam) && jam >= 0 && jam < 96 ? Math.round(jam * 10) / 10 : null };
}

/** Isi alasan/indikasi rawat inap: pada baris label atau baris berikutnya (SPRI atau resume). */
function indikasiRawatInap(pages) {
  const out = [];
  for (const p of pages || []) {
    const lines = teks(p).split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = /\b(?:alasan masuk rawat inap|indikasi rawat inap|alasan dirawat)\b\s*[:=]?\s*(.*)$/i.exec(l);
      if (!m) return;
      // Isi di baris berikutnya hanya bila baris itu bukan label lain ("Terapi/Pengobatan ...:").
      const berikut = (lines[i + 1] || '').trim();
      const isiTeks = m[1].trim() || (/^[^:]{2,70}:\s*\S?/.test(berikut) && /:\s*$/.test(berikut) ? '' : /^[A-Za-z /]{2,60}:/.test(berikut) ? '' : berikut);
      if (isiTeks.length >= 4 && !/^[:\-–]+$/.test(isiTeks)) out.push({ page_number: p.page_number, kutipan: `${l.trim()}${m[1].trim() ? '' : ' ' + isiTeks}`.slice(0, 300) });
    });
  }
  return out.slice(0, 4);
}

/** Menempati ruang perawatan dan DPJP spesialis yang merawat. */
function ruangDanDpjp(pages) {
  const ruang = [], dpjp = [];
  for (const p of pages || []) {
    const t = teks(p);
    const r = /Tiba di ruangan\s*:?\s*[^\n]{1,40}|Bangsal\s+Masuk\s+Keluar[^\n]*\n[^\n]+/i.exec(t);
    if (r) ruang.push({ page_number: p.page_number, kutipan: r[0].replace(/\s+/g, ' ').trim().slice(0, 200) });
    const d = /(?:Dokter yang merawat|DPJP|Dokter Penanggung Jawab(?: Pelayanan)?|visit\w*|visite)\s*:?[^\n]{0,80}?\bSp\.?\s?[A-Z]{1,4}\b[^\n]{0,20}/i.exec(t.replace(/\n(?=[^\n]{0,40}Sp\.)/g, ' '));
    if (d) dpjp.push({ page_number: p.page_number, kutipan: d[0].replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
  const resume = (pages || []).some(p => /RESUME\s+MEDIS(?:\s+RAWAT\s+INAP)?/i.test(teks(p)));
  return { ruang: ruang.slice(0, 3), dpjp: resume ? dpjp.slice(0, 3) : [], resume };
}

module.exports = { kriteriaGawatDarurat, durasiIgd, indikasiRawatInap, ruangDanDpjp, bacaTriase, batasAnak, tanggalIndo };
