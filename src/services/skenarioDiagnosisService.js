/**
 * Skenario diagnosis alternatif: bila isi berkas menyiratkan diagnosis yang
 * TIDAK ditulis DPJP sebagai diagnosis (mis. foto toraks "Kesan
 * bronkopneumonia" pada klaim kejang demam + ISPA), laporan casemix
 * menunjukkan: apa dasar temuannya, kode skenario setelah aturan kombinasi,
 * INA-CBG/tarif dan selisihnya, serta syarat diagnosis itu (BA/PNPK/aturan
 * aplikasi) yang dinilai dari berkas yang sama.
 *
 * PAGAR ANTI-UPCODING: aplikasi tidak menegakkan diagnosis. Skenario tidak
 * pernah diterapkan otomatis; berlaku hanya bila DPJP menuliskan diagnosis
 * tersebut. Bila tarif naik sementara syarat belum terpenuhi, skenario ditandai
 * "berisiko_upcoding". Kenaikan tarif bukan alasan mengubah diagnosis.
 */
const { DETEKTOR, periksa, konteks, cari } = require('./baKesepakatan2018Service');
const { evaluasiKombinasiKode } = require('./ketentuanKlaimService');
const { deskripsiDiagnosis } = require('./kamusKodeService');

const PERINGATAN = 'Aplikasi tidak menegakkan diagnosis. Gunakan hanya bila DPJP menuliskan diagnosis ini pada resume/rekam medis '
  + 'berdasarkan penilaian klinisnya; selisih tarif bukan alasan mengubah diagnosis. Tidak diterapkan otomatis.';

// ---- Pembaca temuan ----
const isi = p => String(p?.ocr_text ?? p?.text ?? '');
const unik = a => a.filter((x, i, arr) => arr.findIndex(y => y.kutipan === x.kutipan) === i);
// Hasil negatif/non-reaktif/tidak tumbuh tidak pernah menjadi pemicu.
const TOLAK_NEGATIF = /\b(?:non[- ]?re?a[ck]ti\w*|negati(?:f|ve)|tidak (?:tumbuh|ditemukan|tampak|terdeteksi)|no growth|not detected|normal)\b|\(\s*-\s*\)/i;
const MODALITAS = '(?:USG|ultrason\\w*|CT|MSCT|MRI|BNO|IVP|rontgen|foto|x-?ray|kesan|impresi|ekspertise|expertise)';
/** Temuan pada halaman radiologi, atau baris yang menyebut modalitas pencitraan. */
function temuanPencitraan(ctx, pola) {
  return unik([...cari({ jenis: ['radiology'], pola, tolak: TOLAK_NEGATIF }, ctx.klinis),
    ...cari({ pola: new RegExp(`\\b${MODALITAS}\\b[^\\n]{0,100}(?:${pola.source})`, 'i'), tolak: TOLAK_NEGATIF }, ctx.klinis)]);
}
function temuanLab(ctx, pola) {
  return cari({ jenis: ['lab_results'], pola, tolak: TOLAK_NEGATIF, ragu: false }, ctx.semua);
}
function temuanOperasi(ctx, pola) {
  return cari({ jenis: ['laporan_operasi', 'patologi_anatomi'], pola, tolak: /\btidak tampak\b|\bnormal\b/i }, ctx.semua);
}

/**
 * Pemicu: diagnosis yang tersirat dari temuan penunjang/operasi. Tambahkan entri baru di sini.
 *  sudahDikode  : kode yang sudah mewakili diagnosis ini (skenario tidak dibuat)
 *  menjelaskan  : diagnosis utama saat ini yang dijelaskan oleh diagnosis ini (skenario menjadi utama; selain itu sekunder)
 *  terserap     : kode gejala yang menjadi bagian diagnosis ini (tidak dikode terpisah, ICD-10 Vol. 2)
 *  kata         : istilah untuk mencari apakah DPJP menuliskannya pada diagnosis
 *  bertentangan : temuan berkas yang melemahkan (mis. "batuk (-)")
 */
const PEMICU = [
  { id: 'pneumonia', nama: 'pneumonia', sudahDikode: /^J1[2-8]/, menjelaskan: /^(?:R|J06|J20|J22|J40)/, terserap: /^(?:R05|R06\.[0-8]|R50)/,
    kata: /\b(?:bron[ck]h?o\s*-?\s*pneumonia|pneumonia|BP|CAP|HAP)\b/i,
    bertentangan: ctx => ctx.klinis.flatMap(p => [...isi(p).matchAll(/\b(?:batuk|sesak|sesek)\b\s*\n?\s*\(\s*-\s*\)/gi)]
      .map(m => ({ page_number: p.page_number, kutipan: m[0].replace(/\s+/g, ' ') }))).slice(0, 3),
    deteksi: ctx => {
      const foto = periksa('infiltrat_toraks', ctx);
      if (foto.status !== 'bukti_ditemukan') return null;
      // Bronkopneumonia dicari tersendiri: pencarian mengambil satu kutipan per halaman.
      const kesan = [...cari({ jenis: ['radiology'], pola: /bron[ck]h?o\s*-?\s*pneumonia/i, ragu: false }, ctx.klinis),
        ...cari({ jenis: ['radiology'], pola: /\bpneumonia\b/i }, ctx.klinis)];
      const teks = [...kesan, ...foto.bukti].map(b => b.kutipan).join(' ');
      if (!/pneumonia|infiltrat|konsolidasi/i.test(teks)) return null;
      return { kode: /bron[ck]h?o\s*pneumonia/i.test(teks) ? 'J18.0' : 'J18.9', bukti: unik([...kesan, ...foto.bukti]).slice(0, 3) };
    } },
  { id: 'dengue', nama: 'infeksi dengue', sudahDikode: /^A9[01]/, menjelaskan: /^(?:R|D69)/, terserap: /^(?:R50|R51|D69\.6)/,
    kata: /\b(?:dengue|DHF|DBD|DSS|DF)\b/i,
    deteksi: ctx => {
      const b = temuanLab(ctx, /\b(?:NS[ -]?1|Ig\s?M[^\n]{0,25}dengue|dengue[^\n]{0,30}Ig\s?M)\b[^\n]{0,40}(?:positi(?:f|ve)|reakti(?:f|ve)|\(\s*\+\s*\))/i);
      return b.length ? { kode: 'A90', bukti: b.slice(0, 2), catatan: 'A91 bila kriteria DBD (kebocoran plasma) tertulis.' } : null;
    } },
  { id: 'tifoid', nama: 'demam tifoid', sudahDikode: /^A01/, menjelaskan: /^(?:R|A09)/, terserap: /^(?:R50)/,
    kata: /\b(?:tifoid|typhoid|thypoid|typus|tifus)\b/i,
    deteksi: ctx => {
      const b = temuanLab(ctx, /\b(?:salmonella\s+typhi|S\.\s?typhi)\b[^\n]{0,60}(?:tumbuh|positi(?:f|ve)|isolat|ditemukan|detected)|(?:kultur|biakan|PCR)[^\n]{0,40}\b(?:salmonella\s+typhi|S\.\s?typhi)\b/i);
      return b.length ? { kode: 'A01.0', bukti: b.slice(0, 2), catatan: 'Serologi cepat (Tubex/Widal) tidak dipakai sebagai pemicu.' } : null;
    } },
  { id: 'isk', nama: 'infeksi saluran kemih', sudahDikode: /^(?:N10|N11|N12|N30|N39\.0)/, menjelaskan: /^R/, terserap: /^(?:R30|R39|R50)/,
    kata: /\b(?:ISK|UTI|infeksi saluran kemih|sistitis|cystitis|pielonefritis)\b/i,
    deteksi: ctx => {
      const kultur = periksa('kultur_urin_tumbuh', ctx);
      if (kultur.status === 'bukti_ditemukan') return { kode: 'N39.0', bukti: kultur.bukti.slice(0, 2) };
      const gejala = periksa('gejala_isk', ctx), piuria = periksa('piuria_5', ctx);
      return gejala.status === 'bukti_ditemukan' && piuria.status === 'bukti_ditemukan' ? { kode: 'N39.0', bukti: [...gejala.bukti.slice(0, 1), ...piuria.bukti.slice(0, 1)] } : null;
    } },
  { id: 'batu_kemih', nama: 'batu saluran kemih', sudahDikode: /^N2[0-3]/, menjelaskan: /^(?:R|N23)/, terserap: /^(?:R10|N23)/,
    kata: /\b(?:nefrolitiasis|nephrolithiasis|ureterolitiasis|urolitiasis|vesikolitiasis|batu (?:ginjal|ureter|buli|saluran kemih)|BSK)\b/i,
    deteksi: ctx => {
      const b = temuanPencitraan(ctx, /\b(?:batu|stone|lith\w*|kalkulus|calculus)\b/i).filter(x => /ginjal|ren|kidney|ureter|buli|vesic|nefro|uro/i.test(x.kutipan));
      if (!b.length) return null;
      const t = b.map(x => x.kutipan).join(' ');
      const ginjal = /ginjal|ren\b|renal|kidney|nefro|nephro|pelvi|kaliks|calyx/i.test(t), ureter = /ureter/i.test(t), buli = /buli|vesic/i.test(t);
      return { kode: ginjal && ureter ? 'N20.2' : ginjal ? 'N20.0' : ureter ? 'N20.1' : buli ? 'N21.0' : 'N20.9', bukti: b.slice(0, 2) };
    } },
  { id: 'kolelitiasis', nama: 'kolelitiasis', sudahDikode: /^K8[01]/, menjelaskan: /^(?:R|K29|K30)/, terserap: /^R10/,
    kata: /\b(?:kolelitiasis|cholelithiasis|kolesistitis|cholecystitis|batu empedu)\b/i,
    deteksi: ctx => {
      const b = temuanPencitraan(ctx, /\b(?:kolelitiasis|cholelithiasis|batu[^\n]{0,20}(?:kandung empedu|vesica fellea|GB\b|gall\s?bladder))\b/i);
      if (!b.length) return null;
      const t = b.map(x => x.kutipan).join(' ');
      return { kode: /kolesistitis akut|acute cholecystitis/i.test(t) ? 'K80.0' : /kolesistitis|cholecystitis/i.test(t) ? 'K80.1' : 'K80.2', bukti: b.slice(0, 2) };
    } },
  { id: 'apendisitis', nama: 'apendisitis', sudahDikode: /^K3[5-7]/, menjelaskan: /^(?:R|K29|K30|A09)/, terserap: /^R10/,
    kata: /\b(?:apendisitis|appendicitis|apendiks|appendix)\b/i,
    deteksi: ctx => {
      const b = unik([...temuanPencitraan(ctx, /\b(?:apendisitis|appendicitis)\b/i), ...temuanOperasi(ctx, /\b(?:apendisitis|appendicitis|apendiks[^\n]{0,30}(?:meradang|hiperemis|perforasi|gangren\w*)|appendix[^\n]{0,30}(?:inflamed|perforated))\b/i)]);
      if (!b.length) return null;
      return { kode: /perforasi|perforated|peritonitis/i.test(b.map(x => x.kutipan).join(' ')) ? 'K35.2' : 'K35.8', bukti: b.slice(0, 2) };
    } },
  { id: 'stroke', nama: 'stroke', sudahDikode: /^I6[0-4]/, menjelaskan: /^(?:R|G45|G81)/, terserap: /^(?:R2[69]|R4[0-7]|R51|R53)/,
    kata: /\b(?:stroke|CVA|SNH|SH|infark serebri|ICH|perdarahan intraserebral)\b/i,
    deteksi: ctx => {
      const b = cari({ pola: /\b(?:CT|MSCT|MRI)\b[^\n]{0,60}\b(?:kepala|brain|head|kranial|cranial)?[^\n]{0,60}\b(?:infark\w*|iskemi\w*|perdarahan intra\w*|ICH|hemoragi\w*)\b|\bkesan\b[^\n]{0,60}\b(?:infark serebri|perdarahan intraserebral|ICH|stroke)\b/i, tolak: TOLAK_NEGATIF }, ctx.klinis);
      if (!b.length) return null;
      return { kode: /perdarahan|hemoragi|ICH/i.test(b.map(x => x.kutipan).join(' ')) ? 'I61.9' : 'I63.9', bukti: b.slice(0, 2) };
    } },
  { id: 'tb', nama: 'tuberkulosis paru', sudahDikode: /^A1[5-9]/, menjelaskan: /^(?:R|J18|J20|J40|J98)/, terserap: /^(?:R05|R04\.2|R50|R63\.4)/,
    kata: /\b(?:TB|TBC|tuberkulosis|tuberculosis|KP)\b/i,
    deteksi: ctx => {
      const b = periksa('konfirmasi_bakteriologis_tb', ctx);
      return b.status === 'bukti_ditemukan' ? { kode: 'A15.0', bukti: b.bukti.slice(0, 2) } : null;
    } },
];

/** Baris diagnosis yang ditulis DPJP (resume, SPRI, triase): baris berlabel "diagnosis" dan beberapa baris sesudahnya. */
function barisDiagnosisDpjp(ctx) {
  const out = [];
  const urut = { resume_medis: 0, triase_igd: 1, spri: 2 };
  for (const p of ctx.semua.filter(x => x.jenis in urut).sort((a, b) => urut[a.jenis] - urut[b.jenis])) {
    const l = isi(p).split(/\r?\n/);
    l.forEach((s, i) => {
      if (!/\bdiagno(?:sa|sis)\b/i.test(s) || /\b(?:keperawatan|banding)\b/i.test(s)) return;
      // Baris diagnosis dan lanjutannya; berhenti di label isian lain ("Ruang Perawatan :", "Kelas :").
      for (let j = i; j < Math.min(l.length, i + 6); j += 1) {
        const t = l[j].trim();
        if (j > i && /^[A-Za-z][A-Za-z /.]{2,30}\s*:/.test(t) && !/diagno/i.test(t)) break;
        if (t && !/^diagno\w*\s*(?:utama|sekunder|kerja|masuk|akhir)?\s*:?\s*$/i.test(t)) out.push({ page_number: p.page_number, kutipan: t.slice(0, 160) });
      }
    });
  }
  return unik(out);
}

/** Kode skenario: diagnosis tersirat menjadi utama, lalu aturan kombinasi diterapkan (buang pasangan / ganti gabungan). */
function kodeSkenario(alt, dx, { utama = true, terserap = null, nama = '' } = {}) {
  let kode = utama ? [alt, ...dx.filter(k => k !== alt)] : [...dx.filter(k => k !== alt), alt];
  const dihapus = [];
  if (terserap) for (const k of kode.filter(x => x !== alt && terserap.test(x))) {
    kode = kode.filter(x => x !== k);
    dihapus.push({ kode: k, aturan: 'ICD-10', alasan: `Gejala bagian dari ${nama}; tidak dikode terpisah bila diagnosis definitif ditegakkan.` });
  }
  for (const k of evaluasiKombinasiKode(kode.join(';'))) {
    if (k.aksi === 'buang_pasangan') {
      for (const t of k.kode_terdampak) if (kode.includes(t)) { kode = kode.filter(x => x !== t); dihapus.push({ kode: t, aturan: k.kode, alasan: k.pesan }); }
    } else if (k.aksi === 'ganti_gabungan' && k.kode_gabungan) {
      const lama = [...k.kode_utama, ...k.kode_terdampak];
      kode = [k.kode_gabungan, ...kode.filter(x => !lama.includes(x) && x !== k.kode_gabungan)];
      for (const t of lama) dihapus.push({ kode: t, aturan: k.kode, alasan: k.pesan });
    }
  }
  return { kode, dihapus };
}

/** Syarat diagnosis skenario yang dinilai mesin aturan dari berkas yang sama; satu baris per aturan. */
function syaratSkenario(record, pages, kode, alt, ctx) {
  const ref = require('./referensiKlaimService').evaluasiReferensiKlaim({ ...record, diagnosa_list: kode.join(';'), DIAGLIST: kode.join(';') }, pages);
  const relevan = t => (t.kode_diagnosis || []).some(k => k === alt || alt.startsWith(String(k).slice(0, 3)));
  const semua = [...ref.temuan, ...ref.temuan.flatMap(t => t.rujukan_ba_2018 || [])]
    .filter(t => t && relevan(t) && t.id !== 'RK-19' && ['bukti_ditemukan', 'bukti_belum_cukup'].includes(t.status));
  const terpenuhi = [], belum = [];
  const kutip = b => b?.bukti?.[0] ? `"${String(b.bukti[0].kutipan).slice(0, 120)}"${b.bukti[0].page_number ? ` (hal. ${b.bukti[0].page_number})` : ''}` : null;
  for (const t of semua) {
    const label = `${t.label_sumber || require('./baKesepakatan2018Service').labelBa(t)} ${t.nama}`.trim();
    const kriteria = (t.bukti || []).filter(x => !x.info && !String(x.id || '').includes(':'));
    const ada = kriteria.filter(x => x.status === 'bukti_ditemukan'), kurang = kriteria.filter(x => x.status !== 'bukti_ditemukan');
    if (t.status === 'bukti_ditemukan') terpenuhi.push({ syarat: label, dasar: ada.map(x => `${x.nama}: ${kutip(x) || 'tertulis'}`).join('; ') });
    else belum.push({ syarat: label, dasar: `Belum ada: ${kurang.map(x => x.catatan ? `${x.nama} (${String(x.catatan).replace(/\.$/, '')})` : x.nama).join('; ')}` });
  }
  if (/^J1[2-8]/.test(alt)) {
    const anak = require('./pneumoniaAnakService');
    const usia = require('./usiaPasienService').resolveUsia(record);
    const batas = anak.batasNapasCepat(usia.bulan);
    if (usia.tahun !== null && usia.tahun < 18) {
      // PNPK IDAI hal. 3-4: anak 2 bulan-5 tahun, pneumonia = batuk/kesulitan bernapas disertai napas cepat.
      // Butir formulir skrining bernomor tanpa jawaban ("1 Batuk berdahak lebih dari 2 minggu") bukan keluhan pasien.
      const butirFormulir = k => /^\s*\d+[.)]?\s+\D/.test(k) && !/\b(?:ya|positif)\b|\(\s*\+\s*\)|\s\+\s*$/i.test(k);
      const respirasi = cari({ pola: /\b(?:batuk\w*|sesak|sulit bernapas|kesulitan bernapas|napas cepat|retraksi|tarikan dinding dada)\b/i, ragu: false }, ctx.klinis, 12)
        .filter(b => !butirFormulir(b.kutipan));
      // Gejala yang di berkas yang sama tegas disangkal ("Batuk (-)") hanya dihitung bila sebutan positifnya
      // berisi penegasan (OCR bisa menyisipkan label formulir di antara "Batuk" dan "(-)").
      const disangkal = new Set(ctx.klinis.flatMap(p => [...String(p.ocr_text || '').matchAll(/\b(batuk|sesak|sesek)\b\s*\n?\s*\(\s*-\s*\)/gi)].map(m => m[1].toLowerCase().replace('sesek', 'sesak'))));
      const tegas = /\b(?:batuk|sesak|sesek)\b\s*(?:\(\s*\+\s*\)|\+|\d|sejak|berdahak|kering|terus|hari|minggu|bulan|napas)/i;
      for (let i = respirasi.length - 1; i >= 0; i -= 1) {
        const kata = (respirasi[i].kutipan.match(/\b(batuk|sesak|sesek)\b/i) || [])[1];
        if (kata && disangkal.has(kata.toLowerCase().replace('sesek', 'sesak')) && !tegas.test(respirasi[i].kutipan)) respirasi.splice(i, 1);
      }
      (respirasi.length ? terpenuhi : belum).push({ syarat: 'PNPK IDAI pneumonia anak (hal. 3-4): batuk atau kesulitan bernapas',
        dasar: respirasi.length ? respirasi.slice(0, 2).map(b => `"${b.kutipan}" (hal. ${b.page_number})`).join('; ')
          : 'Tidak tertulis; keluhan respirasi yang ada tertulis disangkal/negatif (mis. "batuk (-)", "sesak (-)").' });
      const nilai = anak.nilaiPneumoniaAnak({ record, dx: kode, pages, jenisKlaim: record.jenis_klaim || record.JENIS_KLAIM });
      if (batas) {
        const rr = nilai?.rr_tertinggi;
        const cepat = rr && rr.nilai >= batas.ambang;
        (cepat ? terpenuhi : belum).push({ syarat: `PNPK IDAI pneumonia anak (hal. 3): napas cepat >=${batas.ambang}/menit (usia ${batas.kelompok})`,
          dasar: rr ? `RR tertinggi tertulis ${rr.nilai}/menit (hal. ${rr.page_number})` : 'Frekuensi napas tidak terbaca.' });
      }
      if (nilai && nilai.kriteria_rawat_inap) {
        const dasar = [nilai.rr_tertinggi ? `RR tertinggi ${nilai.rr_tertinggi.nilai}/menit` : null, nilai.spo2_terendah ? `SpO2 terendah ${nilai.spo2_terendah.nilai}%` : null].filter(Boolean).join(', ');
        (nilai.perlu_telaah ? belum : terpenuhi).push({ syarat: `PNPK IDAI pneumonia anak: indikasi rawat inap (salah satu dari: ${nilai.kriteria_rawat_inap.map(k => k.nama).join(' / ')})`,
          dasar: `${nilai.perlu_telaah ? 'Tidak ada yang tertulis' : 'Tertulis'}${dasar ? `; ${dasar}` : ''}.` });
      }
    }
  }
  return { terpenuhi, belum };
}

/**
 * @returns {Array} skenario {jenis:'diagnosis_alternatif', posisi, judul, diagnosis, dasar_temuan, ditulis_dpjp, kode_dihapus,
 *   syarat_terpenuhi, syarat_belum, bertentangan, peringatan} -- INA-CBG/tarif dan penilaian diisi pemanggil (nilaiSkenario).
 */
function skenarioAlternatif({ record = {}, dx = [], px = [], pages = [] }) {
  if (!Array.isArray(pages) || !pages.length || !dx.length) return [];
  const ctx = konteks(record, pages, { dx, px });
  const dpjp = barisDiagnosisDpjp(ctx);
  const out = [];
  for (const p of PEMICU) {
    if (dx.some(k => p.sudahDikode.test(k))) continue; // diagnosis ini sudah dikode
    const temuan = p.deteksi(ctx);
    if (!temuan) continue;
    const utama = p.menjelaskan.test(dx[0]);
    const { kode, dihapus } = kodeSkenario(temuan.kode, dx, { utama, terserap: p.terserap, nama: p.nama });
    const { terpenuhi, belum } = syaratSkenario(record, pages, kode, temuan.kode, ctx);
    // Apakah DPJP menuliskan diagnosis ini (pasti / hanya suspek / tidak sama sekali)?
    const tulis = dpjp.filter(b => p.kata.test(b.kutipan));
    const pasti = tulis.find(b => !/(?:suspek|susp|suspect|curiga|dd|diagnosis banding|obs\.?|observasi|r\/o|rule out)/i.test(b.kutipan));
    const ditulis = pasti ? 'ya' : tulis.length ? 'suspek' : 'tidak';
    out.push({
      jenis: 'diagnosis_alternatif', pemicu: p.id, nama: p.nama, posisi: utama ? 'utama' : 'sekunder', kode_pemicu: temuan.kode,
      judul: `Bila DPJP menegakkan ${deskripsiDiagnosis(temuan.kode) || p.nama} (${temuan.kode}) sebagai diagnosis ${utama ? 'utama' : 'sekunder'}`,
      diagnosis: kode, dasar_temuan: temuan.bukti.map(b => ({ kutipan: b.kutipan, halaman: b.page_number || null })),
      ditulis_dpjp: ditulis, kutipan_dpjp: (pasti || tulis[0]) ? { kutipan: (pasti || tulis[0]).kutipan, halaman: (pasti || tulis[0]).page_number } : null,
      diagnosis_dpjp_tertulis: dpjp.slice(0, 4).map(b => ({ kutipan: b.kutipan, halaman: b.page_number })),
      bertentangan: (p.bertentangan ? p.bertentangan(ctx) : []).map(b => ({ kutipan: b.kutipan, halaman: b.page_number })),
      kode_dihapus: dihapus, syarat_terpenuhi: terpenuhi, syarat_belum: belum, catatan_kode: temuan.catatan || null,
      peringatan: PERINGATAN,
    });
  }
  return out;
}

const rp = n => `Rp${Math.round(Math.abs(n)).toLocaleString('id-ID')}`;
/**
 * Penilaian setelah tarif diketahui, dengan alasan yang dapat dibaca:
 *  ditulis_dpjp_belum_dikode       -- DPJP menulis, syarat ada/tidak dinilai: kode terlewat (sah)
 *  ditulis_dpjp_bukti_belum_cukup  -- DPJP menulis, syarat belum ada: berisiko pending bila dikode
 *  berisiko_upcoding               -- DPJP TIDAK menulis (atau hanya suspek) dan tarif naik
 *  perlu_diagnosis_dpjp            -- DPJP tidak menulis, bukti mendukung, tarif tidak naik: klarifikasi
 *  bukti_belum_cukup               -- DPJP tidak menulis dan syarat belum ada
 */
function nilaiSkenario(s) {
  const naik = Number(s.selisih_tarif) > 0;
  const nBelum = s.syarat_belum.length;
  const lengkap = nBelum === 0;
  const ditulis = s.ditulis_dpjp === 'ya';
  const penilaian = ditulis ? (lengkap ? 'ditulis_dpjp_belum_dikode' : 'ditulis_dpjp_bukti_belum_cukup')
    : naik ? 'berisiko_upcoding' : lengkap && s.syarat_terpenuhi.length ? 'perlu_diagnosis_dpjp' : 'bukti_belum_cukup';
  const nama = s.nama || s.kode_pemicu;
  const tarif = s.selisih_tarif == null ? '' : naik ? `tarif naik ${rp(s.selisih_tarif)}` : Number(s.selisih_tarif) < 0 ? `tarif turun ${rp(s.selisih_tarif)}` : 'tarif sama';
  const ringkas = {
    ditulis_dpjp_belum_dikode: `Kode terlewat: DPJP menuliskan ${nama} tetapi belum dikode${tarif ? `; ${tarif}` : ''}.`,
    ditulis_dpjp_bukti_belum_cukup: `DPJP menuliskan ${nama}, tetapi ${nBelum} syarat belum ada di berkas: berisiko pending bila dikode tanpa melengkapi bukti${tarif ? ` (${tarif})` : ''}.`,
    berisiko_upcoding: `Berisiko upcoding: DPJP ${s.ditulis_dpjp === 'suspek' ? 'hanya menulis' : 'tidak menulis'} ${nama}${s.ditulis_dpjp === 'suspek' ? ' sebagai suspek' : ''}${nBelum ? ` dan ${nBelum} syarat belum terpenuhi` : ''}; ${tarif}.`,
    perlu_diagnosis_dpjp: `Bukti berkas mendukung ${nama}, tetapi DPJP tidak menuliskannya: klarifikasi ke DPJP${tarif ? ` (${tarif})` : ''}.`,
    bukti_belum_cukup: `${nama} tidak ditulis DPJP dan ${nBelum} syarat belum terpenuhi di berkas${tarif ? ` (${tarif})` : ''}.`,
  }[penilaian];
  const alasan = [];
  if (s.ditulis_dpjp === 'ya') alasan.push(`DPJP menuliskan: "${s.kutipan_dpjp.kutipan}" (hal. ${s.kutipan_dpjp.halaman}).`);
  else if (s.ditulis_dpjp === 'suspek') alasan.push(`DPJP hanya menulis sebagai suspek/diagnosis banding: "${s.kutipan_dpjp.kutipan}" (hal. ${s.kutipan_dpjp.halaman}).`);
  else alasan.push(`DPJP tidak menuliskan ${nama} sebagai diagnosis${s.diagnosis_dpjp_tertulis?.length ? `; yang tertulis: ${s.diagnosis_dpjp_tertulis.map(b => `"${b.kutipan}" (hal. ${b.halaman})`).join(', ')}` : ''}.`);
  for (const b of s.syarat_belum) alasan.push(`Belum terpenuhi -- ${b.syarat}: ${b.dasar}`);
  for (const b of s.bertentangan || []) alasan.push(`Bertentangan dengan ${nama}: "${b.kutipan}" (hal. ${b.halaman}).`);
  if (naik && !ditulis) alasan.push(`Mengode diagnosis yang tidak ditulis DPJP sehingga tarif naik ${rp(s.selisih_tarif)} adalah upcoding; yang sah adalah klarifikasi ke DPJP.`);
  if (s.catatan_kode) alasan.push(s.catatan_kode);
  return { ...s, penilaian, ringkas, alasan, syarat: `${ringkas} ${PERINGATAN}` };
}

module.exports = { skenarioAlternatif, nilaiSkenario, kodeSkenario, PEMICU, PERINGATAN };
