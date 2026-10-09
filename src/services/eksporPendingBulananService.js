/**
 * Ekspor klaim PENDING satu bulan ke Excel: satu lembar berisi judul, tabel
 * alasan pending + saran, dan keterangan di bawah tabel.
 *
 * Kolom "Jawaban Rumah Sakit" SENGAJA dikosongkan -- diisi manual oleh
 * casemix, seperti kolom jawaban pada rekap pending BPJS.
 *
 * Alasan pending = alasan dari putusan pending medaudit DITAMBAH masalah data
 * klaim dari pemeriksaan aturan. Keduanya membuat klaim berstatus pending;
 * tanpa yang kedua, klaim yang pending hanya karena data (mis. DPJP kosong)
 * akan muncul di daftar tanpa alasan sama sekali.
 */

const ExcelJS = require('exceljs');
const { labelPeriode } = require('./periodeKlaimService');

const KOLOM = [
  { header: 'No', key: 'no', width: 5 },
  { header: 'SEP', key: 'sep', width: 22, teks: true },
  { header: 'Nama Pasien', key: 'nama', width: 26 },
  { header: 'Tanggal', key: 'tanggal', width: 14 },
  { header: 'ICD-10 (Diagnosis)', key: 'icd10', width: 18, teks: true },
  { header: 'ICD-9-CM (Prosedur)', key: 'icd9', width: 18, teks: true },
  { header: 'Status', key: 'status', width: 11 },
  { header: 'Alasan Pending', key: 'alasan', width: 55 },
  { header: 'Saran / Tindakan', key: 'saran', width: 55 },
  { header: 'Jawaban Rumah Sakit', key: 'jawaban', width: 50 },
];
const JUMLAH_KOLOM = KOLOM.length;
const BARIS_JUDUL_TABEL = 5;

// Nama kolom internal -> nama kolom vClaim yang dibaca koder sehari-hari.
const LABEL_KOLOM = {
  diagnosa_list: 'DIAGLIST', prosedur_list: 'PROCLIST', dpjp_name: 'DPJP', tarif_rs: 'TARIF_RS',
  kode_rs: 'KODE_RS', sep: 'SEP', nokartu: 'NOKARTU', nama_pasien: 'NAMA_PASIEN', mrn: 'MRN', gender: 'SEX',
  kelas_rawat: 'KELAS_RAWAT', discharge_status: 'DISCHARGE_STATUS', admission_date: 'ADMISSION_DATE',
  discharge_date: 'DISCHARGE_DATE', birth_date: 'BIRTH_DATE', umur_tahun: 'UMUR_TAHUN', inacbg_code: 'INACBG',
  tarif_inacbg: 'TARIF_INACBG', total_tarif: 'TOTAL_TARIF',
};
const labelKolom = (f) => LABEL_KOLOM[f] || String(f || '').toUpperCase();

// Di aplikasi status 'pending' maupun 'error' sama-sama tampil "PENDING".
const LABEL_STATUS = { pending: 'PENDING', error: 'PENDING' };

function parseJson(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}') || {}; } catch (_) { return {}; }
}

const bernomor = (daftar) => [...new Set(daftar.filter(Boolean))].map((t, i) => `${i + 1}. ${t}`).join('\n');

/** Ringkasan, alasan pending, dan saran untuk satu klaim. */
function alasanDanSaran(record) {
  const ai = parseJson(record.ai_review);
  const putusan = ai.putusan_pending || null;
  const catatan = ai.field_notes || {};
  const alasan = [];
  const saran = [];
  for (const a of (putusan && Array.isArray(putusan.alasan) ? putusan.alasan : [])) {
    if (!a) continue;
    alasan.push([a.ringkas, a.bukti ? `(${a.bukti})` : null].filter(Boolean).join(' '));
    if (a.tindakan) saran.push(a.tindakan);
  }
  for (const e of record.errors || []) {
    const label = labelKolom(e.field_name);
    alasan.push(`Data klaim ${label}: ${e.error_message || 'perlu diperiksa'}`);
    if (catatan[e.field_name]) saran.push(`${label}: ${catatan[e.field_name]}`);
  }
  const ringkasan = (putusan && putusan.ringkasan)
    || ((record.errors || []).length ? 'Ada data klaim yang perlu diperbaiki.' : '');
  return { ringkasan, alasan: bernomor(alasan), saran: bernomor(saran) };
}

const bersih = (v) => String(v || '').trim().toUpperCase();
// Tanggal masuk bisa datang sebagai Date (kolom DATE) atau teks "YYYY-MM-DD".
// Komponen lokal dipakai, bukan toISOString(), yang menggeser tanggal satu
// hari di zona WIB (tengah malam lokal = 17:00 UTC hari sebelumnya).
const tanggal = (v) => {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
};
const waktuUnggah = (r) => new Date(r.created_at || r.uploaded_at || 0).getTime() || 0;

/**
 * Kelompokkan upload menjadi KUNJUNGAN dan ambil upload TERAKHIR tiap kunjungan.
 *
 * Berkas klaim yang sama sering diunggah berkali-kali (7 Okt 2026: satu
 * pasien 5x, satu lagi 6x). Yang mewakili keadaan klaim adalah unggahan
 * terakhir -- unggahan lama yang dulu bermasalah tidak relevan bila unggahan
 * terbarunya sudah valid.
 *
 * Kunci kunjungan: SEP. Unggahan yang SEP-nya tidak terbaca digabung ke
 * kunjungan ber-SEP dengan MRN + tanggal masuk yang sama bila padanannya
 * tepat satu; bila tidak ada padanan, MRN + tanggal masuk menjadi kuncinya;
 * bila itu pun kosong, unggahan berdiri sendiri.
 */
function kelompokkanKunjungan(records, { pilih = null } = {}) {
  const grup = new Map();
  const tambah = (kunci, r) => { if (!grup.has(kunci)) grup.set(kunci, []); grup.get(kunci).push(r); };
  const sepPerMrnTanggal = new Map();
  for (const r of records || []) {
    if (!bersih(r.sep)) continue;
    tambah(`sep:${bersih(r.sep)}`, r);
    if (bersih(r.mrn) && tanggal(r.admission_date)) {
      const k = `${bersih(r.mrn)}|${tanggal(r.admission_date)}`;
      if (!sepPerMrnTanggal.has(k)) sepPerMrnTanggal.set(k, new Set());
      sepPerMrnTanggal.get(k).add(bersih(r.sep));
    }
  }
  for (const r of records || []) {
    if (bersih(r.sep)) continue;
    const mrnTanggal = bersih(r.mrn) && tanggal(r.admission_date) ? `${bersih(r.mrn)}|${tanggal(r.admission_date)}` : null;
    const padanan = mrnTanggal ? sepPerMrnTanggal.get(mrnTanggal) : null;
    if (padanan && padanan.size === 1) tambah(`sep:${[...padanan][0]}`, r);
    else if (mrnTanggal) tambah(`kunjungan:${mrnTanggal}`, r);
    else tambah(`unggahan:${r.id}`, r);
  }
  return [...grup.values()].map(daftar => {
    const urut = [...daftar].sort((a, b) => waktuUnggah(b) - waktuUnggah(a));
    const terbaru = pilih ? pilih(urut) : urut[0];
    if (!terbaru) return null;
    // SEP diambil dari unggahan mana pun di kunjungan ini bila yang terbaru
    // tidak terbaca, supaya baris Excel tetap bisa dicocokkan.
    const sep = bersih(terbaru.sep) ? terbaru.sep : (urut.find(x => bersih(x.sep)) || {}).sep || '';
    return { ...terbaru, sep, jumlah_unggahan: daftar.length };
  }).filter(Boolean);
}

const bukanValid = (r) => String(r.validation_status || '').toLowerCase() !== 'valid';

/**
 * Kunjungan yang MASIH punya unggahan berstatus pending -- sama dengan yang
 * tampil "Perlu dikerjakan" di Riwayat Upload (9 Okt 2026: aturan "unggahan
 * terakhir menentukan" membuang pasien yang masih tampil pending di layar,
 * sehingga Excel tidak cocok dengan yang dilihat pengguna). Satu baris per
 * kunjungan; alasan diambil dari unggahan pending yang TERBARU.
 */
function pilihKlaimPending(records) {
  // SEMUA unggahan dikelompokkan dulu supaya unggahan tanpa SEP tetap
  // tergabung ke kunjungan ber-SEP-nya. Wakil tiap kunjungan = unggahan
  // pending terbaru; kunjungan tanpa unggahan pending tidak diekspor.
  return kelompokkanKunjungan(records, { pilih: (urutTerbaru) => urutTerbaru.find(bukanValid) || null })
    .filter(Boolean)
    .sort((a, b) => String(a.sep || a.nama_pasien || '').localeCompare(String(b.sep || b.nama_pasien || '')));
}

/** Satu klaim per SEP (dipakai pemanggil lama): unggahan terbaru per kunjungan. */
function satuPerSep(records) {
  return kelompokkanKunjungan(records).sort((a, b) => String(a.sep || '').localeCompare(String(b.sep || '')));
}

/** "I51.7;I48" -> "I51.7; I48"; kosong -> "-". */
function daftarKode(v) {
  const kode = String(v || '').split(/[;,]/).map(k => k.trim()).filter(k => k && k !== '-');
  return kode.length ? kode.join('; ') : '-';
}

/** dd/mm/yyyy dari Date atau teks "YYYY-MM-DD" / "dd/mm/yyyy". */
function ddmmyyyy(v) {
  const t = tanggal(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)}`;
  return t;
}

/** Tanggal masuk; bila pulang di hari lain: "15/09/2026 – 18/09/2026". */
function tanggalPelayanan(r) {
  const masuk = ddmmyyyy(r.admission_date);
  const pulang = ddmmyyyy(r.discharge_date);
  if (!masuk) return pulang || '-';
  return pulang && pulang !== masuk ? `${masuk} – ${pulang}` : masuk;
}

/** "07/10/2026 22:19 WIB" -- WIB tetap UTC+7, tanpa bergantung zona waktu server. */
function waktuWib(d = new Date()) {
  const w = new Date(d.getTime() + 7 * 3600 * 1000);
  const dua = (n) => String(n).padStart(2, '0');
  return `${dua(w.getUTCDate())}/${dua(w.getUTCMonth() + 1)}/${w.getUTCFullYear()} ${dua(w.getUTCHours())}:${dua(w.getUTCMinutes())} WIB`;
}

const kodeRsDari = (records, cadangan = null) => (records || []).map(r => r.kode_rs || parseJson(r.raw_data).KODE_RS).find(Boolean) || cadangan || null;

const GARIS = { style: 'thin', color: { argb: 'FFB7B7B7' } };
const BINGKAI = { top: GARIS, left: GARIS, bottom: GARIS, right: GARIS };

function satuBarisPenuh(ws, baris, nilai, gaya = {}) {
  ws.mergeCells(baris, 1, baris, JUMLAH_KOLOM);
  const sel = ws.getCell(baris, 1);
  sel.value = nilai;
  Object.assign(sel, gaya);
  return sel;
}

/**
 * @param {Array} records SEMUA unggahan klaim satu periode (claim_records +
 *   errors + file_name), termasuk yang valid: pengelompokan per kunjungan
 *   butuh unggahan valid untuk tahu bahwa unggahan lama yang bermasalah
 *   sudah digantikan.
 * @param {{periode: string, diexportOleh?: string, namaRs?: string, kodeRs?: string, waktu?: Date}} cakupan
 */
async function buatEksporPendingBulanan(records, cakupan = {}) {
  const daftar = pilihKlaimPending(records);
  const periode = cakupan.periode ? labelPeriode(cakupan.periode) : '-';
  const namaRs = cakupan.namaRs || 'RS Lestari Raharja';
  const kodeRs = kodeRsDari(records, cakupan.kodeRs);

  const wb = new ExcelJS.Workbook();
  wb.created = cakupan.waktu || new Date();
  // Nama lembar maks. 31 karakter dan tanpa karakter terlarang Excel.
  const ws = wb.addWorksheet(`Pending ${periode}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31));
  ws.columns = KOLOM.map(k => ({ key: k.key, width: k.width, style: k.teks ? { numFmt: '@' } : {} }));

  // ── Judul ──
  satuBarisPenuh(ws, 1, 'DAFTAR KLAIM PENDING', { font: { bold: true, size: 16 } });
  satuBarisPenuh(ws, 2, `${namaRs}${kodeRs ? ` (${kodeRs})` : ''} · Periode ${periode}`, { font: { bold: true, size: 12 } });
  satuBarisPenuh(ws, 3, 'Hasil pemeriksaan medaudit sebelum klaim dikirim — bukan keputusan BPJS. Kolom Jawaban Rumah Sakit diisi oleh casemix.',
    { font: { italic: true, size: 10, color: { argb: 'FF595959' } } });
  ws.getRow(1).height = 24;

  // ── Tabel ──
  const judul = ws.getRow(BARIS_JUDUL_TABEL);
  judul.values = KOLOM.map(k => k.header);
  judul.height = 22;
  judul.eachCell((sel) => {
    sel.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    sel.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    sel.border = BINGKAI;
  });

  let baris = BARIS_JUDUL_TABEL;
  daftar.forEach((r, i) => {
    baris += 1;
    const a = alasanDanSaran(r);
    const row = ws.getRow(baris);
    row.values = {
      no: i + 1, sep: r.sep || `(SEP tidak terbaca${r.file_name ? ` — berkas ${r.file_name}` : ''})`, nama: r.nama_pasien || '',
      tanggal: tanggalPelayanan(r), icd10: daftarKode(r.diagnosa_list), icd9: daftarKode(r.prosedur_list),
      status: LABEL_STATUS[r.validation_status] || String(r.validation_status || '').toUpperCase(),
      alasan: a.alasan, saran: a.saran, jawaban: '',
    };
    row.eachCell({ includeEmpty: true }, (sel, kolom) => {
      if (kolom > JUMLAH_KOLOM) return;
      sel.border = BINGKAI;
      sel.alignment = { vertical: 'top', wrapText: true, horizontal: kolom === 1 ? 'center' : 'left' };
    });
    // Kolom isian casemix diberi warna supaya jelas harus diisi.
    ws.getCell(baris, JUMLAH_KOLOM).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  });
  if (!daftar.length) {
    baris += 1;
    satuBarisPenuh(ws, baris, 'Tidak ada klaim pending pada periode ini.',
      { font: { italic: true }, alignment: { horizontal: 'center' }, border: BINGKAI });
  } else {
    ws.autoFilter = { from: { row: BARIS_JUDUL_TABEL, column: 1 }, to: { row: baris, column: JUMLAH_KOLOM } };
  }

  // ── Keterangan di bawah tabel ──
  baris += 2;
  ws.getCell(baris, 1).value = 'Keterangan';
  ws.getCell(baris, 1).font = { bold: true };
  const keterangan = [
    ['Periode', periode],
    ['Isi', 'Klaim berstatus pending menurut medaudit (bukan keputusan BPJS)'],
    ['Cara hitung', 'Satu baris per kunjungan (SEP) yang masih punya unggahan berstatus pending. Bila berkas yang sama diunggah berkali-kali, alasan diambil dari unggahan pending terbaru.'],
    ['Jumlah klaim', daftar.length],
    ['Tanggal ekspor', waktuWib(cakupan.waktu || new Date())],
    ['Diekspor oleh', cakupan.diexportOleh || '-'],
  ];
  for (const [label, nilai] of keterangan) {
    baris += 1;
    ws.mergeCells(baris, 1, baris, 2);
    ws.mergeCells(baris, 3, baris, JUMLAH_KOLOM);
    ws.getCell(baris, 1).value = label;
    ws.getCell(baris, 3).value = nilai;
    ws.getCell(baris, 3).alignment = { horizontal: 'left' };
  }

  ws.views = [{ state: 'frozen', ySplit: BARIS_JUDUL_TABEL }];
  ws.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printTitlesRow: `${BARIS_JUDUL_TABEL}:${BARIS_JUDUL_TABEL}`,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  };

  return wb.xlsx.writeBuffer();
}

/** <KODE_RS>_<YYYYMM>_PENDING.xlsx */
function namaBerkasPendingBulanan(records, periode, kodeRsCadangan = null) {
  return `${kodeRsDari(records, kodeRsCadangan) || 'RS'}_${String(periode || '').replace('-', '')}_PENDING.xlsx`;
}

module.exports = {
  KOLOM, BARIS_JUDUL_TABEL, alasanDanSaran, satuPerSep, kelompokkanKunjungan, pilihKlaimPending, waktuWib, labelKolom,
  buatEksporPendingBulanan, namaBerkasPendingBulanan,
};
