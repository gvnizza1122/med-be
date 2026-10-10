/** Nilai penunjang tetap dibaca; hasil abnormal saja bukan diagnosis terlewat. */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { bacaDiagnosisAkhir, buktiDiagnosisAkhir } = require('./dasarDiagnosisService');
const { deskripsiDiagnosis, deskripsiProsedur } = require('./kamusKodeService');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const KEBIJAKAN = `Hasil laboratorium rendah/tinggi tidak otomatis menjadi diagnosis tersendiri atau kode yang terlewat.
Na/K/Cl, Hb, glukosa, fungsi ginjal, AGD dan hasil lain dibaca dalam konteks diagnosis akhir, perjalanan penyakit,
resusitasi cairan, respons dan pemilihan terapi. Infus, koreksi elektrolit, transfusi atau pemantauan saja tidak menetapkan diagnosis baru.
Jangan menilai potensi rugi RS, menaikkan severity, atau membuat alasan pending hanya karena angka abnormal belum memiliki kode diagnosis.
Diagnosis tersendiri memerlukan penetapan dokter dan relevansi pelayanan, bukan angka atau obat saja. Bila hanya penunjang,
pertahankan sebagai konteks analisis; jangan mewajibkan dokter menambah diagnosis. Diagnosis yang sudah ditulis/dikode tetap dinilai dukungannya.
Lembar anestesi dapat dipakai untuk sedasi pemasangan endotracheal tube (ETT), bukan hanya operasi bedah.
Cocokkan dengan tindakan intubasi dan episode; judul/pre-post operasi cetak atau obat sedasi tidak sendiri membuktikan operasi.`;
const PARAMETER = /\b(?:natrium|sodium|kalium|potassium|chlorida|klorida|chloride|na|k|cl|hemoglobin|hb|hematokrit|leukosit|trombosit|glukosa|gula darah|creatinin|kreatinin|ureum|sgot|sgpt|albumin|pco2|po2|hco3|ph|laktat|kalsium|magnesium)\b/i;
const KONDISI = [
  [/\b(?:hipo|hypo)natremia\b/i, 'E87.1'], [/\b(?:hiper|hyper)natremia\b/i, 'E87.0'],
  [/\b(?:hipo|hypo)kal(?:emi[a]?|aemia)\b|\bhipokalemi\b/i, 'E87.6'], [/\b(?:hiper|hyper)kal(?:emi[a]?|aemia)\b|\bhiperkalemi\b/i, 'E87.5'],
  [/\b(?:hiper|hyper|hipo|hypo)(?:kloremia|chloremia)\b/i, 'E87.8'],
  [/\banemia\b/i, 'D64.9'], [/\b(?:hipo|hypo)glikemia\b/i, 'E16.2'],
];
function kodeDalam(teks, jenis) {
  const re = jenis === 'dx' ? /\b[A-Z]\d{2}(?:\.\d{1,2})?\b/g : /\b\d{2}\.\d{1,2}\b/g;
  return [...new Set(String(teks || '').match(re) || [])].filter(k => jenis === 'dx' ? deskripsiDiagnosis(k) : deskripsiProsedur(k));
}
function hanyaKonteksPenunjang(t, pages, { dx = [], diagnosisTertulis = [], tersirat = false } = {}) {
  if (!t) return false;
  const teks = `${t.kondisi || ''} ${t.pesan || ''} ${t.saran || ''}`;
  const kutipan = t.kutipan || t.bukti?.kutipan || '';
  const halaman = t.halaman ?? t.bukti?.page_number;
  const p = (pages || []).find(p => Number(p.page_number) === Number(halaman));
  if (!/\d/.test(kutipan) || !(PARAMETER.test(kutipan) || p && classifyPageDocumentType(p.ocr_text || '') === 'lab_results')) return false;
  if (!tersirat && !['kode_terlewat', 'potensi_rugi_rs'].includes(t.jenis)) return false;
  if (!tersirat && kodeDalam(teks, 'px').length) return false;
  const disebut = kodeDalam(teks, 'dx');
  if (!tersirat && disebut.some(k => dx.includes(k) || diagnosisTertulis.includes(k))) return false;
  if (buktiDiagnosisAkhir({ quotation: kutipan, page_number: halaman }, pages)) return false;
  const diagnosis = bacaDiagnosisAkhir(pages).flatMap(d => d.kutipan.split(/\r?\n/));
  const keluarga = KONDISI.filter(([re, k]) => re.test(teks) || disebut.includes(k));
  // Diagnosis tertulis berbeda dari temuan lab pada formulir. Rencana/DD/negasi belum menetapkan diagnosis.
  if (diagnosis.some(line => !/\b(?:dd|suspek|kemungkinan|rencana|tanpa|tidak|no)\b|\(-\)/i.test(line)
    && (keluarga.some(([re]) => re.test(line)) || disebut.some(k => new RegExp(`\\b${k.replace('.', '\\.')}(?!\\d)`).test(line))))) return false;
  return tersirat || keluarga.length > 0 || disebut.length > 0 || /diagnos|kode.*(?:tambah|terlewat)|(?:tambah|lengkapi).*kode/i.test(teks);
}
function catatanPenunjang(t, pages) {
  let kutipan = t.kutipan || t.bukti?.kutipan;
  const halaman = Number(t.halaman ?? t.bukti?.page_number);
  const p = (pages || []).find(p => Number(p.page_number) === halaman);
  // Anotasi penalaran dapat menambah rujukan dalam tanda kurung. Jika perlu,
  // ambil baris asli dengan parameter DAN nilai yang sama; jangan menciptakan kutipan.
  if (p && !norm(p.ocr_text).includes(norm(kutipan))) {
    const parameter = PARAMETER.exec(kutipan || '');
    const nilai = parameter && String(kutipan).slice(parameter.index + parameter[0].length).match(/\d+(?:[.,]\d+)?/);
    if (nilai) {
      const target = Number(nilai[0].replace(',', '.'));
      const asli = String(p.ocr_text).split(/\r?\n/).find(line => {
        if (!new RegExp(`\\b${parameter[0]}\\b`, 'i').test(line)) return false;
        const n = line.slice(line.toLowerCase().indexOf(parameter[0].toLowerCase()) + parameter[0].length).match(/\d+(?:[.,]\d+)?/);
        return n && Number(n[0].replace(',', '.')) === target;
      });
      if (asli) kutipan = asli.trim();
    }
  }
  const sah = p && norm(kutipan).length >= 3 && norm(p.ocr_text).includes(norm(kutipan));
  return { jenis: 'konteks_penunjang', hash_bukti: require('./laporanOperasiService').hashBukti(pages),
    pesan: 'Hasil penunjang dinilai bersama diagnosis yang tertulis, perjalanan penyakit dan pilihan terapi; tidak otomatis menjadi diagnosis tambahan.',
    ...(sah ? { bukti: { kutipan, page_number: halaman } } : {}),
    temuan_asal: t };
}
function sesuaikanKritik(analisis, { record = {}, ai = {}, pages = [] } = {}) {
  if (!analisis || !Array.isArray(analisis.temuan)) return analisis;
  const dx = analisis.dinilai?.dx || String(record.DIAGLIST || record.diagnosa_list || '').split(/[;,]/).map(s => s.trim());
  const hash = require('./laporanOperasiService').hashBukti(pages);
  const diagnosisTertulis = (ai.suggested_codes || []).filter(s => s.type === 'diagnosis' && !s.disangkal
    && buktiDiagnosisAkhir(s, pages)).map(s => String(s.code).toUpperCase());
  const catatan = (analisis.catatan_klinis || []).filter(c => !['konteks_penunjang','konteks_anestesi'].includes(c.jenis) || c.hash_bukti === hash);
  const temuan = analisis.temuan.filter(t => {
    if (!hanyaKonteksPenunjang(t, pages, { dx, diagnosisTertulis })) return true;
    catatan.push(catatanPenunjang(t, pages)); return false;
  });
  for (const t of ai.penalaran_diagnosis?.kondisi_tersirat || []) {
    if (hanyaKonteksPenunjang(t, pages, { tersirat: true })) catatan.push(catatanPenunjang(t, pages));
  }
  for (const k of ai.klarifikasi_berkas || []) {
    if (k.jenis === 'sedasi_ett' && k.sumber === 'klarifikasi_pengguna' && k.hash_bukti === hash
      && pages.some(p => Number(p.page_number) === Number(k.halaman))) {
      catatan.push({jenis: 'konteks_anestesi', hash_bukti: hash, pesan: `Lembar anestesi halaman ${k.halaman} digunakan untuk sedasi pemasangan ETT, sesuai klarifikasi pengguna. Ditelaah bersama bukti intubasi; tidak dianggap operasi bedah.`, halaman: k.halaman, temuan_asal: k});
    }
  }
  const unik = catatan.filter((c, i) => catatan.findIndex(x => x.jenis === c.jenis && norm(x.temuan_asal?.kutipan || x.temuan_asal?.bukti?.kutipan || x.pesan) === norm(c.temuan_asal?.kutipan || c.temuan_asal?.bukti?.kutipan || c.pesan)) === i);
  if (temuan.length === analisis.temuan.length && !unik.length && !analisis.catatan_klinis?.length) return analisis;
  const bobot = { tinggi: 25, sedang: 12, rendah: 5 };
  const skor = Math.max(0, 100 - temuan.reduce((n, t) => n + (bobot[t.keparahan] || 0), 0));
  const gagal = Boolean(analisis.ai_gagal);
  const nilai = gagal ? Math.min(skor, 70) : skor;
  const rugi = temuan.filter(t => t.jenis === 'potensi_rugi_rs').length;
  const upcoding = temuan.filter(t => t.jenis === 'potensi_upcoding').length;
  return { ...analisis, versi_konteks_penunjang: 'penunjang-2026-10-10.1', temuan, catatan_klinis: unik,
    skor_keyakinan: nilai, tingkat: nilai >= 80 ? 'tinggi' : nilai >= 55 ? 'sedang' : 'rendah',
    ringkas: { potensi_rugi_rs: rugi, potensi_upcoding: upcoding, total: temuan.length },
    perlu_analisis_mendalam: temuan.some(t => t.keparahan === 'tinggi'),
    kesimpulan: (gagal ? `Pemeriksaan kritis AI belum selesai: ${analisis.pesan_gangguan || 'gangguan layanan AI'}. Pemeriksaan aturan tetap diterapkan. ` : '')
      + (temuan.length ? `${temuan.length} hal perlu ditinjau koder sebelum unggah${rugi ? `, ${rugi} berpotensi merugikan RS` : ''}${upcoding ? `, ${upcoding} berisiko ditolak/diaudit` : ''}.` : 'Pemeriksaan yang dijalankan belum menemukan keberatan pada kode dan bukti yang terbaca.') };
}
module.exports = { KEBIJAKAN, hanyaKonteksPenunjang, sesuaikanKritik };
