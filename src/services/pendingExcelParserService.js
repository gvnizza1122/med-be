/** Pembaca rekap pending lokal. Tidak memanggil AI atau menulis basis data. */
const XLSX = require('xlsx');
const REQUIRED_HEADER = 'NOSEP';

const BULAN = {jan:1,january:1,januari:1,feb:2,february:2,februari:2,mar:3,march:3,maret:3,apr:4,april:4,
  may:5,mei:5,jun:6,june:6,juni:6,jul:7,july:7,juli:7,aug:8,august:8,agu:8,agustus:8,
  sep:9,september:9,oct:10,okt:10,october:10,oktober:10,nov:11,november:11,dec:12,des:12,december:12,desember:12};
function tanggalISO(tahun, bulan, hari) {
  const y=Number(tahun),m=Number(bulan),d=Number(hari);
  const date=new Date(Date.UTC(y,m-1,d));
  if (date.getUTCFullYear()!==y || date.getUTCMonth()!==m-1 || date.getUTCDate()!==d) return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function excelDateToISO(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0,10);
  if (typeof v === 'number') {
    const d=new Date(Math.round((v-25569)*86400*1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
  }
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
  if (m) return tanggalISO(m[1],m[2],m[3]);
  m=s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return tanggalISO(m[3],m[2],m[1]);
  m=s.match(/^(\d{1,2})[ -]+([a-z]+)\.?[ -]+(\d{4})$/i);
  if (m && BULAN[m[2].toLowerCase()]) return tanggalISO(m[3],BULAN[m[2].toLowerCase()],m[1]);
  return null;
}

function dateCell(v) {
  const iso=excelDateToISO(v);
  if (v != null && String(v).trim() && !iso) {
    const e=new Error('Tanggal pada rekap pending tidak dikenali atau tidak valid. Gunakan YYYY-MM-DD, DD/MM/YYYY, atau tanggal seperti 2 Jan 2026.');
    e.kode='tanggal_rekap_tidak_valid';
    throw e;
  }
  return iso;
}

/** Jawaban RS eksplisit didahulukan; Konfirmasi pada format RSLR adalah jawaban RS. */
function bacaJawaban(row, headers) {
  const norm=s=>String(s||'').trim().toUpperCase().replace(/\s+/g,'');
  for (const label of ['JAWABANRS','JAWABANRUMAHSAKIT','KONFIRMASI']) {
    const idx=headers.findIndex(h=>norm(h)===label);
    const text=idx>=0 ? String(row[idx]??'').trim() : '';
    if (text) return text;
  }
  return '';
}

/**
 * Cari baris header (mengandung "NOSEP") lalu map baris-baris di bawahnya
 * jadi objek by kolom. Baris tanpa NOSEP (baris judul/kosong) dilewati.
 */
function parsePendingSheet(sheet, sheetLabel) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const headerIdxPrimary = rows.findIndex(r => r.some(c => String(c).trim().toUpperCase() === REQUIRED_HEADER));
  if (headerIdxPrimary !== -1) {
    const headers = rows[headerIdxPrimary].map(h => String(h).trim().toUpperCase());
    const colIdx = (name) => headers.indexOf(name);
    const iSep = colIdx('NOSEP'), iTglSep = colIdx('TGLSEP'), iTglPlg = colIdx('TGLPLG'),
      iNokartu = colIdx('NOKARTU'), iMr = colIdx('MR'), iNama = colIdx('NAMAPESERTA'),
      iInacbg = colIdx('KDINACBG'), iBiaya = colIdx('BYPENGAJUAN'), iAlasan = colIdx('ALASANPENDING');

    const out = [];
    for (let i = headerIdxPrimary + 1; i < rows.length; i++) {
      const row = rows[i];
      const sep = String(row[iSep] ?? '').trim();
      if (!sep) continue;
      out.push({
        sheet: sheetLabel,
        sep,
        tgl_sep: dateCell(row[iTglSep]),
        tgl_pulang: dateCell(row[iTglPlg]),
        nokartu: iNokartu >= 0 ? String(row[iNokartu] ?? '').trim() : '',
        mr: iMr >= 0 ? String(row[iMr] ?? '').trim() : '',
        nama_peserta: iNama >= 0 ? String(row[iNama] ?? '').trim() : '',
        kdinacbg: iInacbg >= 0 ? String(row[iInacbg] ?? '').trim() : '',
        by_pengajuan: iBiaya >= 0 ? row[iBiaya] : null,
        alasan_pending: iAlasan >= 0 ? String(row[iAlasan] ?? '').trim() : '',
        jawaban_rs: bacaJawaban(row, headers),
      });
    }
    return out;
  }

  // Format alternatif (ditemukan 8 Sep 2026 di rekap RI Januari 2026 RS
  // Lestari Raharja — sheet "RI" & "RJ" dalam satu file XLSX ternyata bisa
  // punya format kolom BERBEDA: "No. | Tgl. Masuk | Tgl. Pulang | No. RM |
  // Nama Pasien | No. Klaim / SEP | INACBG | Top Up | Total Tarif | Tarif RS
  // | Jenis | Konfirmasi" — kolom "Jenis" di format ini ternyata isinya
  // ALASAN PENDING (bukan kategori jenis), "Konfirmasi" = jawaban/tindakan
  // RS. Tanpa fallback ini, sheet berformat begini SILENT gagal total (0
  // baris ter-import) — bukan error, cuma diam-diam kosong.
  const normalize = (s) => String(s).trim().toUpperCase().replace(/\.\s*/g, ' ').replace(/\s+/g, ' ');
  const headerIdxAlt = rows.findIndex(r => r.some(c => /NO\s*KLAIM\s*\/?\s*SEP/.test(normalize(c))));
  if (headerIdxAlt === -1) return [];

  const headersAlt = rows[headerIdxAlt].map(normalize);
  const findCol = (...patterns) => headersAlt.findIndex(h => patterns.some(p => p.test(h)));

  const iSep = findCol(/NO\s*KLAIM\s*\/?\s*SEP/), iTglMasuk = findCol(/^TGL\s*MASUK$/),
    iTglPlg = findCol(/^TGL\s*PULANG$/), iMr = findCol(/^NO\s*RM$/), iNama = findCol(/^NAMA\s*PASIEN$/),
    iInacbg = findCol(/^INACBG$/), iBiaya = findCol(/^TOTAL\s*TARIF$/),
    // Kolom alasan pending di format alternatif ternyata beda label antar
    // bulan (ditemukan 8 Sep 2026, cross-check 6 file Excel Jan-Jun 2026):
    // "Jenis" (Feb-Apr) vs "Keterangan Pending" (Mei) — sama-sama berisi
    // alasan pending walau labelnya beda, JENIS bukan berarti kategori.
    iAlasan = findCol(/^JENIS$/, /KETERANGAN\s*PENDING/);

  const out = [];
  for (let i = headerIdxAlt + 1; i < rows.length; i++) {
    const row = rows[i];
    const sep = iSep >= 0 ? String(row[iSep] ?? '').trim() : '';
    if (!sep) continue;
    out.push({
      sheet: sheetLabel,
      sep,
      // Format alternatif tidak punya "Tanggal SEP" terpisah — pakai
      // Tanggal Masuk sebagai referensi tanggal terdekat yang tersedia.
      tgl_sep: iTglMasuk >= 0 ? dateCell(row[iTglMasuk]) : null,
      tgl_pulang: iTglPlg >= 0 ? dateCell(row[iTglPlg]) : null,
      nokartu: '',
      mr: iMr >= 0 ? String(row[iMr] ?? '').trim() : '',
      nama_peserta: iNama >= 0 ? String(row[iNama] ?? '').trim() : '',
      kdinacbg: iInacbg >= 0 ? String(row[iInacbg] ?? '').trim() : '',
      by_pengajuan: iBiaya >= 0 ? row[iBiaya] : null,
      alasan_pending: iAlasan >= 0 ? String(row[iAlasan] ?? '').trim() : '',
      jawaban_rs: bacaJawaban(row, headersAlt),
    });
  }
  return out;
}

function sheetLabelOf(name) {
  return /rawat\s*inap|^ri$|pending\s*ri/i.test(name) ? 'RI'
    : /rawat\s*jalan|^rj$|pending\s*rj/i.test(name) ? 'RJ' : name;
}
function parsePendingWorkbook(wb) {
  const rows=[], sheets=[];
  for (const name of wb.SheetNames) {
    const parsed=parsePendingSheet(wb.Sheets[name],sheetLabelOf(name));
    rows.push(...parsed);
    sheets.push({sheet:name,jenis:sheetLabelOf(name),jumlah:parsed.length});
  }
  return {rows,sheets};
}
module.exports={excelDateToISO,parsePendingSheet,parsePendingWorkbook};
