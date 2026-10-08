/**
 * Penilai butir ASPEK MEDIS BA Kesepakatan Bersama Kemenkes-BPJS 2018
 * (JP.02.03/3/2411/2018; 620/BA/1118), halaman PDF 31-40, butir 1-63.
 * Pemetaan butir ada di src/data/baPnpkAnak.json (satu katalog untuk BA 2018).
 *
 * Penilai hanya membaca bukti tertulis: teks halaman, kode yang diklaim dan
 * hasil lab yang terbaca. Tidak menetapkan diagnosis, tidak mengganti kode
 * dan tidak membuat pending wajib. Nilai/catatan yang tidak terbaca bukan
 * bukti tindakan tidak dilakukan.
 *
 * Tumpang tindih: butir yang topiknya sudah dinilai aturan lain (RK/TK/BDD/SP)
 * mencantumkan `gabung_ke`. Temuan BA ditempel ke kartu aturan itu (satu kartu
 * dan satu alasan per topik) dan baru berdiri sendiri bila aturan itu tidak
 * terpicu pada klaim ini (mis. catatan BDD hanya untuk RS tertentu).
 */
const { bacaLabDariHalaman } = require('./bacaLabService');
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { isLembarGrouper } = require('./lembarGrouperService');

const teks = p => String(p?.ocr_text ?? p?.text ?? '');
const angka = s => Number(String(s).replace(',', '.'));
// Penyangkalan pada baris yang sama: "sesak (-)", "tidak ada muntah", "tanpa transfusi".
const NEG_SESUDAH = /^\s*(?:\(\s*-\s*\)|-(?!\s*\d)|:\s*-|\s*negatif|\s*disangkal|\s*tidak\s+ada|\s*\(?\s*neg\b)/i;
const NEG_SEBELUM = /\b(?:tidak\s+(?:ada|didapatkan|ditemukan|tampak|terdapat|diberikan|dilakukan)|tanpa|bukan|belum|disangkal|tdk|rencana|direncanakan|pro|usul|anjuran)\s*:?\s*$/i;
const NEG_HASIL = /\b(?:non[- ]?re?a[ck]ti(?:f|ve)|negatif|negative|not detected|tidak (?:ditemukan|terdeteksi|tumbuh)|no growth)\b|\(\s*-\s*\)/i;
const RAGU = /\b(?:suspek|susp|suspect|curiga|riwayat|rencana|direncanakan|bila perlu|jika perlu|k\/p|prn)\b/i;

const DX_INFEKSI = /^(?:A\d|B\d|G0[0-6]|J0|J1[0-8]|J2[0-2]|J44\.0|J8[56]|K3[5-7]|K57\.[028]|K6[15]|K8[01]|K83\.0|L0[0-8]|M00|M86|N10|N30\.0|N39\.0|N45|N7[0-6]|O8[56]|P36|T81\.4)/;
const DX_KANKER = /^C(?:[0-8]\d|9[0-7])/;
const DX_HAMIL = /^(?:O\d|Z3[3-9])/;
const HEMOROID = '\\b(?:hemoroid\\w*|haemorrhoid\\w*|hemorrhoid\\w*|wasir)\\b';
const GRADE = '\\b(?:grade|gr\\.?|derajat|stadium)\\s*';
const DX_JANTUNG = /^(?:I0[5-9]|I2[0-5]|I3[0-8]|I4[0-7]|I50|I51|Q2[0-8])/;

// Satu kutipan per halaman per pola; negasi dan kata ragu dinilai pada baris yang sama.
function cari(d, pages, maks = 4) {
  const out = [];
  for (const p of pages) {
    if (d.jenis && !d.jenis.includes(p.jenis)) continue;
    const t = teks(p);
    for (const re0 of [].concat(d.pola)) {
      const re = new RegExp(re0.source, re0.flags.includes('g') ? re0.flags : `${re0.flags}g`);
      for (const m of t.matchAll(re)) {
        const awal = t.lastIndexOf('\n', m.index) + 1, akhir = t.indexOf('\n', m.index);
        const line = t.slice(awal, akhir < 0 ? undefined : akhir);
        if (!d.tanpa_negasi) {
          const sebelum = t.slice(Math.max(awal, m.index - 30), m.index);
          const sesudah = line.slice(m.index - awal + m[0].length, m.index - awal + m[0].length + 12);
          if (NEG_SEBELUM.test(sebelum) || NEG_SESUDAH.test(sesudah)) continue;
        }
        if (d.ragu !== false && RAGU.test(line)) continue;
        if (d.tolak && d.tolak.test(line)) continue; // baris hasil negatif ('non reaktif', 'tidak ditemukan')
        out.push({ page_number: p.page_number || null, kutipan: line.trim().slice(0, 220), jenis_halaman: p.jenis });
        break;
      }
      if (out.length >= maks) return out;
    }
  }
  return out;
}

const kutipLab = b => ({ page_number: b.halaman, kutipan: b.kutipan, nilai: b.kewajaran.nilai_dinormalkan, tanggal: b.tanggal });
function ambangLab(ctx, param, uji, label) {
  const rows = ctx.lab().filter(b => b.parameter === param);
  const kena = rows.filter(b => uji(b.kewajaran.nilai_dinormalkan, b));
  return { status: kena.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', nilai_terbaca: rows.length > 0,
    bukti: (kena.length ? kena : rows).slice(0, 6).map(kutipLab),
    catatan: !rows.length ? `Hasil ${label} belum terbaca dari halaman tersimpan.`
      : kena.length ? undefined : `${rows.length} hasil ${label} terbaca; tidak ada yang memenuhi ambang.` };
}
// Batas atas memakai nilai rujukan pada baris yang sama bila ada, lalu flag cetak.
const diAtasRujukan = (bawaan) => (v, b) => b.flag_cetak && /^(?:H|HH|\*|high|tinggi)$/i.test(b.flag_cetak)
  || (Number.isFinite(b.rujukan?.max) ? b.nilai > b.rujukan.max : v > bawaan);

function bacaTd(pages) {
  const out = [];
  for (const p of pages) {
    teks(p).split(/\r?\n/).forEach(line => {
      for (const m of line.matchAll(/\b(?:TD|T\.D|tekanan darah|tensi|BP|blood pressure)\s*[:=]?\s*(\d{2,3})\s*\/\s*(\d{2,3})/gi)) {
        const s = Number(m[1]);
        if (s >= 30 && s <= 300) out.push({ nilai: s, page_number: p.page_number || null, kutipan: line.trim().slice(0, 200) });
      }
    });
  }
  return out;
}
function bacaPola(pages, re, uji) {
  const out = [];
  for (const p of pages) teks(p).split(/\r?\n/).forEach(line => {
    for (const m of line.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
      const v = angka(m[1] ?? m[2]);
      if (Number.isFinite(v) && (!uji || uji(v, m, line))) out.push({ nilai: v, page_number: p.page_number || null, kutipan: line.trim().slice(0, 200), m });
    }
  });
  return out;
}
function hasilAngka(rows, uji, label, catatanKosong) {
  const kena = rows.filter(r => uji(r.nilai, r));
  const bersih = r => ({ page_number: r.page_number, kutipan: r.kutipan, nilai: r.nilai });
  return { status: kena.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', nilai_terbaca: rows.length > 0,
    bukti: (kena.length ? kena : rows).slice(0, 6).map(bersih),
    catatan: !rows.length ? (catatanKosong || `${label} belum terbaca.`) : kena.length ? undefined : `${label} terbaca, tidak memenuhi ambang.` };
}
const RE_SPO2 = /\b(?:SpO2|SpO₂|saturasi(?:\s+oksigen)?|sat\.?)\s*[:=]?\s*(\d{2,3})\s*%/i;
function bacaAgd(pages) {
  const ambil = re => bacaPola(pages, re);
  return {
    po2: ambil(/\bp(?:a)?O2\s*[:=]?\s*(\d{2,3}(?:[.,]\d+)?)/i), pco2: ambil(/\bp(?:a)?CO2\s*[:=]?\s*(\d{2,3}(?:[.,]\d+)?)/i),
    ph: ambil(/\bpH\s*(?:darah)?\s*[:=]?\s*([67][.,]\d{1,3})/i), sao2: ambil(/\bSaO2\s*[:=]?\s*(\d{2,3})/i),
    hco3: ambil(/\bHCO3\s*[:=]?\s*(\d{1,2}(?:[.,]\d+)?)/i), pf: ambil(/\b(?:P\s*\/\s*F|PF\s*ratio|rasio\s*P\/F)\s*[:=]?\s*(\d{2,3})/i),
  };
}

function nilaiPiuria(ctx, ambangLpb, dasar) {
    const hasil = require('./bpjsDoDontService').bacaLeukositUrine(ctx.semua);
    const lpb = bacaPola(ctx.klinis, /\b(?:leu[kc]osit|lekosit|leuko|WBC)\b[^\n]{0,30}?(?:(\d{1,3})\s*[-–]\s*)?(\d{1,3})\s*\/\s*(?:LPB|lpb|HPF|hpf|lpk)\b/i)
      .map(r => ({ satuan: 'LPB', maks: Number(r.m[2]), kutipan: r.kutipan, page_number: r.page_number }));
    const rsBdd = (require('../data/bpjsDoDont.json').hospital_codes || []).includes(String(ctx.record.hospital_code || ctx.record.KODE_RS || ''));
    const nilai = [];
    const dibaca = [...hasil.filter(h => h.metode === 'numerik'), ...lpb].filter((h, i, arr) => arr.findIndex(x => x.kutipan === h.kutipan) === i);
    for (const h of dibaca) {
      if (h.satuan === 'LPB' || h.satuan === 'HPF') { nilai.push({ ...h, piuria: h.maks > ambangLpb, dasar }); continue; }
      if (h.satuan !== 'Leu/uL') continue;
      const sisa = String(h.kutipan).slice(String(h.kutipan).indexOf(h.nilai_tertulis) + String(h.nilai_tertulis).length);
      const rj = /(?:<=|<|≤)\s*(\d+(?:[.,]\d+)?)/.exec(sisa) || /(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)/.exec(sisa);
      const batas = rj ? Number((rj[2] || rj[1]).replace(',', '.')) : rsBdd ? 10 : null;
      if (batas === null) continue;
      nilai.push({ ...h, piuria: h.maks > batas, dasar: rj ? `nilai rujukan lab ${rj[0].trim()} Leu/uL` : 'catatan casemix RS: >10 Leu/uL' });
    }
    const dip = hasil.filter(h => h.metode === 'semikuantitatif' && /\+|positi/i.test(h.nilai_tertulis));
    const kutip = arr => arr.slice(0, 6).map(h => ({ page_number: h.page_number, kutipan: h.kutipan, nilai: h.maks }));
    if (nilai.length) {
      const pos = nilai.filter(h => h.piuria);
      return { status: pos.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', nilai_terbaca: true, angka: true, bukti: kutip(pos.length ? pos : nilai),
        catatan: pos.length ? `Di atas ambang (${pos[0].dasar}).` : `Leukosit urin terbaca tidak melebihi ambang (${[...new Set(nilai.map(h => h.dasar))].join('; ')})`
          + (dip.length ? `; dipstick tertulis ${dip.map(h => h.nilai_tertulis).join(', ')} (kurang spesifik, tidak menggantikan sedimen).` : '.') };
    }
    if (dip.length) return { status: 'bukti_ditemukan', bukti: kutip(dip), catatan: 'Hanya dipstick leukosit esterase positif; sensitif tetapi kurang spesifik dibanding sedimen.' };
    const lain = hasil.filter(h => h.metode === 'numerik');
    if (lain.length) return { status: 'perlu_cek_manual', bukti: kutip(lain), catatan: 'Leukosit urin terbaca dalam Leu/uL tanpa nilai rujukan pada baris hasil; minta hasil lab yang mencantumkan nilai rujukan sebelum menilai piuria.' };
    return { status: 'bukti_belum_cukup', angka: true, nilai_terbaca: false, bukti: [], catatan: 'Hasil urinalisis (leukosit urin) belum terbaca dari berkas.' };
}

// IMT tertulis, atau dihitung dari BB (kg) dan TB (cm) pada baris yang sama.
function bacaImt(pages) {
  const out = [];
  for (const p of pages) for (const l of teks(p).split(/\r?\n/)) {
    const m = /\b(?:IMT|BMI)\s*[:=]?\s*(\d{2}(?:[.,]\d{1,2})?)/i.exec(l);
    if (m) { const v = Number(m[1].replace(',', '.')); if (v >= 10 && v <= 70) out.push({ nilai: v, page_number: p.page_number || null, kutipan: l.trim().slice(0, 200) }); continue; }
    const bb = /\b(\d{2,3}(?:[.,]\d)?)\s*kg\b/i.exec(l), tb = /\b(1\d{2}|2[0-2]\d)\s*cm\b/i.exec(l);
    if (bb && tb) { const v = Number(bb[1].replace(',', '.')) / ((Number(tb[1]) / 100) ** 2); if (v >= 10 && v <= 70) out.push({ nilai: Math.round(v * 10) / 10, page_number: p.page_number || null, kutipan: `${l.trim().slice(0, 160)} (IMT dihitung)` }); }
  }
  return out;
}

// Detektor: pola teks, kode yang diklaim, atau nilai(ctx) untuk ambang angka.
const DETEKTOR = {
  td_syok: { nama: 'TD sistolik <90 mmHg tanpa inotropik atau <80 mmHg dengan inotropik', nilai: ctx => {
    const ino = periksa('inotropik', ctx).status === 'bukti_ditemukan';
    return { ...hasilAngka(bacaTd(ctx.klinis), v => v < (ino ? 80 : 90), 'Tekanan darah'), angka: true };
  } },
  inotropik: { nama: 'Pemberian inotropik/vasopresor', terapi: true, pola: /\b(?:dobutamin\w*|dopamin\w*|nor[ -]?epinefrin\w*|norepinephrin\w*|vascon|raivas|epinefrin|adrenalin|milrinon\w*)\b/i },
  ef_rendah: { nama: 'Ejection fraction <50%', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis,
    /\b(?:LV\s*)?EF\b\s*(?:[:=]|sebesar)?\s*(\d{1,2}(?:[.,]\d+)?)\s*%|\b(?:ejection fraction|fraksi ejeksi)\s*[:=]?\s*(\d{1,2}(?:[.,]\d+)?)\s*%/i), v => v < 50, 'Nilai EF', 'Nilai EF (ekokardiografi) belum terbaca.'), angka: true }) },
  hb_6: { nama: 'Hemoglobin <6 g/dL', nilai: ctx => ({ ...ambangLab(ctx, 'hemoglobin', v => v < 6, 'hemoglobin'), angka: true }) },
  hb_8: { nama: 'Anemia gravis: hemoglobin <8 g/dL', nilai: ctx => ({ ...ambangLab(ctx, 'hemoglobin', v => v < 8, 'hemoglobin'), angka: true }) },
  hb_10: { nama: 'Hemoglobin <10 g/dL', nilai: ctx => ({ ...ambangLab(ctx, 'hemoglobin', v => v < 10, 'hemoglobin'), angka: true }) },
  hb_11: { nama: 'Hemoglobin <11 g/dL (standar WHO kehamilan)', nilai: ctx => ({ ...ambangLab(ctx, 'hemoglobin', v => v < 11, 'hemoglobin'), angka: true }) },
  albumin_25: { nama: 'Albumin <2,5 g/dL', nilai: ctx => ({ ...ambangLab(ctx, 'albumin', v => v < 2.5, 'albumin'), angka: true }) },
  transaminase_tinggi: { nama: 'SGOT/SGPT di atas nilai normal', nilai: ctx => {
    const a = ambangLab(ctx, 'sgot', diAtasRujukan(40), 'SGOT'), b = ambangLab(ctx, 'sgpt', diAtasRujukan(40), 'SGPT');
    const ok = [a, b].some(x => x.status === 'bukti_ditemukan');
    return { status: ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', nilai_terbaca: a.nilai_terbaca || b.nilai_terbaca, angka: true,
      bukti: [...a.bukti, ...b.bukti].slice(0, 6), catatan: ok ? undefined : (a.nilai_terbaca || b.nilai_terbaca ? 'SGOT/SGPT terbaca dalam batas rujukan.' : 'Hasil SGOT/SGPT belum terbaca.') };
  } },
  elektrolit_abnormal: { nama: 'Gangguan elektrolit (Na/K di luar normal)', nilai: ctx => {
    const na = ambangLab(ctx, 'natrium', v => v < 135 || v > 145, 'natrium'), k = ambangLab(ctx, 'kalium', v => v < 3.5 || v > 5.5, 'kalium');
    const t = cari({ pola: /\b(?:hipo|hiper)(?:natremi|kalemi|kalsemi)\w*\b/i }, ctx.klinis);
    const ok = na.status === 'bukti_ditemukan' || k.status === 'bukti_ditemukan' || t.length > 0;
    return { status: ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', nilai_terbaca: na.nilai_terbaca || k.nilai_terbaca,
      bukti: [...(na.status === 'bukti_ditemukan' ? na.bukti : []), ...(k.status === 'bukti_ditemukan' ? k.bukti : []), ...t].slice(0, 6) };
  } },
  hipoglikemi: { nama: 'Hipoglikemia', nilai: ctx => {
    const g = ambangLab(ctx, 'gula_darah_sewaktu', v => v < 70, 'gula darah');
    const t = cari({ pola: /\bhipoglikemi\w*\b/i }, ctx.klinis);
    return { ...g, status: g.status === 'bukti_ditemukan' || t.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: [...(g.status === 'bukti_ditemukan' ? g.bukti : []), ...t].slice(0, 6) };
  } },
  spo2_91: { nama: 'SpO2 <91%', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis, RE_SPO2, v => v >= 40 && v <= 100), v => v < 91, 'SpO2'), angka: true }) },
  lesi_signifikan: { nama: 'Lesi koroner signifikan (LM >=50%; LAD proksimal >50% atau mid-distal >70%; LCx/RCA >70%)', nilai: ctx => {
    const rows = bacaPola(ctx.klinis, /\b(?:LMCA|LM|left main|LAD|LCx|LCX|circumflex|RCA)\b[^\n%]{0,40}?(\d{2,3})\s*%/i);
    return { ...hasilAngka(rows, (v, r) => {
      const arteri = r.m[0].match(/^(\S+)/)[1].toUpperCase();
      if (/^(?:LM|LMCA|LEFT)/.test(arteri)) return v >= 50;
      if (arteri === 'LAD') return /\b(?:prok\w*|prox\w*|ost\w*)/i.test(r.m[0]) ? v > 50 : v > 70;
      return v > 70;
    }, 'Persentase stenosis', 'Hasil angiografi (persentase stenosis) belum terbaca.'), angka: true };
  } },
  ffr_08: { nama: 'FFR <0,8', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis, /\bFFR\s*[:=]?\s*(0[.,]\d+)/i), v => v < 0.8, 'FFR', 'Nilai FFR belum terbaca.'), angka: true }) },
  vas_7: { nama: 'Nyeri hebat VAS >=7', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis, /\b(?:VAS|NRS|skala nyeri|skor nyeri|pain scale)\s*[:=]?\s*(\d{1,2})(?!\d)/i, v => v <= 10), v => v >= 7, 'Skala nyeri', 'Skala nyeri belum terbaca.'), angka: true }) },
  usia_anak: { nama: 'Pasien anak (<18 tahun)', nilai: ctx => ctx.usia.tahun === null
    ? { status: 'bukti_belum_cukup', bukti: [], catatan: 'Usia belum terkonfirmasi.' }
    : { status: ctx.usia.tahun < 18 ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: [{ page_number: null, kutipan: `Usia ${ctx.usia.tahun} tahun pada awal episode` }] } },
  sesak: { nama: 'Sesak napas', pola: /\b(?:sesak|dyspn\w*|dispne\w*|takipne\w*|napas cepat|nafas cepat)\b/i },
  dx_gagal_jantung: { nama: 'Komplikasi dekompensasi kordis', dx: /^(?:I50|I11\.0|I13\.[02])/, pola: /\b(?:decompensatio cordis|dekompensasi kordis|gagal jantung|CHF|ADHF)\b/i },
  reaksi_transfusi: { nama: 'Reaksi transfusi', dx: /^T80/, pola: /\breaksi transfusi\b/i },
  transfusi_epo: { nama: 'Transfusi darah atau eritropoetin', terapi: true, px: /^99\.0[34]/,
    pola: /\b(?:transfusi|PRC|packed red|whole blood|eritropoetin|erythropoietin|epoetin|EPO|hemapo|recormon|eprex)\b/i },
  penyakit_kronik: { nama: 'Penyakit kronik (mis. gagal ginjal kronik, kanker)', dx: /^(?:N18|N19|C\d|B2[0-4]|K7[04]|I50|E1[0-4]|J44|M32|D61|D63\.0|D63\.8)/ },
  luka_luas_dalam: { nama: 'Luka luas dan dalam (indikasi graft)', pola: /\b(?:luka (?:luas|dalam|bakar)|combustio|vulnus \w+ (?:luas|dalam)|defek (?:kulit|jaringan)|ulkus|ulcus|degloving|luas luka\s*\d|\d+\s*%\s*(?:TBSA|luas permukaan))\b/i },
  bukan_estetik: { nama: 'Bukan indikasi estetik (pigmentasi, deposit lemak, tato)', kebalikan: true, dx: /^(?:L8[01]|Z41)/,
    pola: /\b(?:tato|tattoo|hiperpigmentasi|hipopigmentasi|estetik|kosmetik)\b/i, catatan_ada: 'Ada penanda indikasi estetik; skin graft untuk estetik tidak dijamin.' },
  pungsi_pleura: { nama: 'Pungsi pleura/torakosentesis', px: /^34\.(?:91|04)/, pola: /\b(?:pungsi pleura|punksi pleura|pungsi\s+cairan pleura|torakosentesis|thoracocentesis|thorakosintesis|WSD|chest tube|drainase pleura)\b/i },
  imaging_efusi: { nama: 'Efusi terbukti pada foto/USG/CT toraks', jenis: ['radiology'], pola: /\b(?:efusi pleura|pleural effusion|sinus (?:costo|kosto)\w* (?:kanan |kiri |dextra |sinistra )?tumpul|meniscus sign)\b/i },
  tatalaksana_efusi: { nama: 'Tatalaksana tambahan efusi', terapi: true, pola: /\b(?:WSD|chest tube|pleurodesis|drainase|furosemid\w*|lasix|diuretik|albumin|OAT)\b/i },
  terapi_oksigen: { nama: 'Terapi oksigen/ventilasi (low/high flow, NIV, ventilator)', terapi: true,
    pola: [/\b(?:nasal kanul|nasal canul\w*|NRM|non[ -]?rebreathing|rebreathing mask|simple mask|masker sederhana|venturi|HFNC|high flow|CPAP|BiPAP|NIV|ventilator|intubasi)\b/i,
      /\b(?:O2|oksigen|oxygen)\b[^\n]{0,20}\d+\s*(?:lpm|l\/m|lt|liter)/i] },
  henti_napas: { nama: 'Tidak ada frekuensi napas (henti napas)', tanpa_negasi: true,
    pola: /\b(?:henti nap?f?as|apne(?:a|u)|apnoe|respiratory arrest|nap?f?as spontan\s*(?:\(-\)|tidak ada|negatif)|tidak (?:ada )?nap?f?as)\b/i },
  ventilasi_buatan: { nama: 'Ventilasi buatan (bag mask/mouth to mouth) atau ventilasi mekanik', terapi: true, px: /^(?:96\.7|93\.9[0-3]|96\.04)/,
    pola: /\b(?:bagging|bag[ -]?(?:valve[ -]?)?mask|BVM|ambu ?bag|mouth to mouth|ventilasi (?:mekanik|buatan)|ventilator|intubasi|ETT|RJP|CPR|resusitasi jantung paru)\b/i },
  gizi_kurang: { nama: 'Gizi kurang akibat gangguan menelan (BB/IMT menurut usia)', dx: /^E4[0-6]/,
    pola: /\b(?:gizi kurang|gizi buruk|underweight|wasting|malnutrisi|BB kurang|berat badan kurang|BB\/U\s*[<(]|IMT\/U\s*[<(]|z[- ]?score\s*<?\s*-\s*[23])\b/i },
  fisioterapi: { nama: 'Tindakan fisioterapi selama rawat inap', terapi: true, px: /^93\.(?:0|1|3)/,
    pola: /\b(?:fisioterapi|physiotherap\w*|rehab(?:ilitasi)? medi[ck]|terapi latihan|latihan ROM|ROM exercise|Sp\.?KFR)\b/i },
  etiologi_vertigo_sentral: { nama: 'Etiologi vertigo sentral (stroke, infeksi, trauma kepala, tumor dengan peningkatan TIK)',
    dx: /^(?:I6[0-4]|G0[0-6]|S06|C71|D33|D43|G93\.[26])/,
    pola: /\b(?:stroke|infark (?:serebri|cerebri|otak)|perdarahan intra(?:serebral|kranial)|ICH|SNH|meningitis|ensefalitis|encephalitis|abses otak|trauma kepala|cedera kepala|tumor intra\w*|space occupying|peningkatan (?:tekanan intra\s*kranial|TIK))\b/i },
  muntah: { nama: 'Muntah hebat (sulit makan)', pola: /\b(?:muntah\w*|vomit\w*|emesis)\b/i },
  dehidrasi: { nama: 'Tanda dehidrasi', pola: /\b(?:dehidrasi|turgor (?:kulit )?(?:menurun|kurang|lambat|kembali lambat)|mata cekung|mukosa (?:bibir )?kering|ubun[- ]ubun cekung)\b/i },
  hemodinamik: { nama: 'Gangguan hemodinamik (takikardi, nadi lemah, hipotensi)', pola: /\b(?:takikardi\w*|tachycardi\w*|nadi (?:lemah|cepat lemah|tidak teraba)|hipotensi)\b/i },
  px_ecce: { nama: 'Tindakan ECCE (ekstraksi ekstrakapsular)', px: /^13\.(?:2|3|5)/ },
  komorbid_katarak: { nama: 'Penyakit penyerta (HT, DM, HBsAg +) atau indikasi medis lain', dx: /^(?:I1[0-5]|E1[0-4]|B16|B18\.[01])/,
    pola: /\bHBsAg\s*[:=]?\s*(?:reaktif|positif|\+)/i },
  asuhan_spesialis_lain: { nama: 'Tatalaksana khusus/asuhan spesialis lain selama perawatan',
    pola: /\b(?:konsul\w*|rawat bersama|raber)\b[^\n]{0,40}\b(?:penyakit dalam|interna|Sp\.?\s?PD|jantung|Sp\.?\s?JP|paru|anak|Sp\.?\s?A\b|anestesi|endokrin)/i },
  pterigium_grade4: { nama: 'Pterigium grade IV', pola: /\b(?:pterigium|pterygium)\b[^\n]{0,40}\b(?:grade|gr\.?|derajat|stadium)\s*(?:IV|4)\b/i },
  teknik_pterigium: { nama: 'Teknik graft/flap konjungtiva atau membran amnion', pola: /\b(?:conjunctival (?:auto)?graft|graft konjungtiva|konjungtiva graft|autograft|flap konjungtiva|conjunctival flap|membran amnion|amnion(?:ic)? membrane|fibrin glue|tissue glue)\b/i },
  perdarahan_komplikasi: { nama: 'Perdarahan masif atau komplikasi lain', pola: /\bperdarahan (?:masif|banyak|hebat)\b/i },
  anestesi_umum: { nama: 'Memerlukan anestesi umum', pola: [/\b(?:anestesi umum|anastesi umum|general anest\w*|GETA|narkose umum|bius total)\b/i, /\b(?:GA|LMA)\b/] },
  tidak_kooperatif: { nama: 'Anak belum kooperatif', tanpa_negasi: true, pola: /\b(?:tidak|belum|kurang) kooperatif\b/i },
  tatalaksana_perdarahan: { nama: 'Penatalaksanaan perdarahan tercatat', terapi: true,
    pola: /\b(?:tampon\w*|asam traneksamat|tranexamic|traneksamat|kalnex|transamin|kauter\w*|adrenalin|epinefrin|vitamin K|transfusi trombosit|thrombocyte concentrate)\b/i },
  terapi_cairan: { nama: 'Penatalaksanaan terapi cairan', terapi: true,
    pola: /\b(?:IVFD|infus|RL|ringer\w*|NaCl\s*0[.,]9|asering|KAEN|D5|rehidrasi|loading cairan|cairan (?:kristaloid|intravena|IV))\b/i },
  indikasi_spesifik_hd: { nama: 'Indikasi medis spesifik rawat inap (mis. anemia), bukan perbaikan KU', dx: /^(?:D5\d|D6[0-4]|J81|E87\.[2-7]|I50)/,
    pola: /\b(?:anemia|transfusi|edema paru|overload|kelebihan cairan|hiperkalemi\w*|ensefalopati uremik|asidosis|perikarditis)\b/i },
  ku_rawat: { nama: 'Keadaan umum yang memerlukan rawat inap', pola: /\b(?:KU lemah|keadaan umum (?:lemah|buruk|jelek)|perdarahan (?:aktif|masif)|hematemesis|melena|hematok[ec]zia|hematoschezia|anemia|dehidrasi|geriatri|cemas berat|kecemasan tinggi)\b/i },
  manifestasi_syok: { nama: 'Manifestasi klinis syok saat operasi', pola: /\b(?:syok|shock|hipotensi|akral dingin|nadi lemah|TD (?:turun|drop))\b/i },
  tatalaksana_syok: { nama: 'Penatalaksanaan syok tertulis', terapi: true, pola: /\b(?:efedrin|ephedrin\w*|vasopresor|nor[ -]?epinefrin\w*|dopamin\w*|loading|bolus|resusitasi|transfusi|koloid|gelafusal|HES)\b/i },
  edema_paru_klinis: { nama: 'Gejala edema paru (sesak, takikardi, ronki)', pola: /\b(?:sesak|dyspn\w*|ronki|rhonki|ronkhi|takikardi\w*)\b/i },
  diuretik: { nama: 'Terapi diuretik', terapi: true, pola: /\b(?:furosemid\w*|lasix|spironolakton|torasemid\w*|diuretik)\b/i },
  dx_utama_bukan_z49: { nama: 'Diagnosis utama CKD, bukan kontrol HD/kode Z', nilai: ctx => ({ status: /^Z/.test(ctx.dx[0] || '') ? 'bukti_belum_cukup' : 'bukti_ditemukan',
    bukti: [{ page_number: null, kutipan: `Diagnosis utama diklaim: ${ctx.dx[0] || '-'}` }] }) },
  ascites_masif: { nama: 'Ascites masif', pola: /\b(?:asites|ascites)\s+(?:masif|massive|permagna|berat|grade\s*(?:3|III))\b/i },
  pungsi_ascites: { nama: 'Pungsi ascites untuk terapeutik', px: /^54\.91/, pola: /\b(?:parasentesis|paracentesis|pungsi (?:asites|ascites|abdomen)|punksi (?:asites|ascites))\b/i },
  penyakit_jantung_dasar: { nama: 'Penyakit jantung yang berpotensi menyebabkan henti jantung', dx: DX_JANTUNG },
  tatalaksana_henti_jantung: { nama: 'Tatalaksana henti jantung (RJP/defibrilasi)', terapi: true, px: /^99\.6[0-2]/,
    pola: /\b(?:RJP|CPR|DC shock|defibrilasi|kejut listrik|amiodaron\w*|ROSC)\b/i },
  tatalaksana_hepatitis: { nama: 'Tata laksana khusus hepatitis', terapi: true, pola: /\b(?:hepatoprotekt\w*|curcuma|ursodeoxy\w*|UDCA|urdafalk|SNMC|silymarin|hepamerz|aminoleban|lactulos\w*)\b/i },
  gout_poliartikular: { nama: 'Gout >=3 sendi atau poliartikular', pola: /\b(?:poliartikular|polyarticular|poliartritis|banyak sendi|multipel sendi|multiple joint|(?:3|tiga|4|empat|5|lima) sendi)\b/i },
  tatalaksana_flebitis: { nama: 'Tatalaksana khusus flebitis (debridement atau antibiotik)', terapi: true,
    pola: /\b(?:debridemen\w*|debridement|antibiotik|ceftriaxon\w*|cefotaxim\w*|cefazolin\w*|amoxicillin\w*|clindamycin\w*)\b/i },
  alergi_obat_resume: { nama: 'Alergi obat tercantum pada resume pulang', jenis: ['resume_medis'], ragu: false,
    pola: /\b(?:alergi obat|drug allergy|reaksi alergi|erupsi obat|drug eruption|SJS|steven[s]? johnson|urti[ck]aria)\b/i },
  bukan_skin_test: { nama: 'Bukan alergi karena skin test', kebalikan: true, pola: /\bskin test\b[^\n]{0,30}\b(?:positif|alergi|reaksi)/i,
    catatan_ada: 'Alergi karena hasil skin test tidak termasuk T88.7 menurut BA.' },
  overload: { nama: 'Overload (sesak/bengkak kelopak mata, kaki, perut)', pola: /\b(?:edema|oedema|bengkak|sembab|overload|kelebihan cairan|sesak)\b/i },
  akses_dialisis: { nama: 'Pemasangan akses dialisis', px: /^(?:38\.95|39\.27|39\.93|54\.93)/, pola: /\b(?:pemasangan|insersi|pasang)\b[^\n]{0,20}\b(?:CDL|cimino|AV ?shunt|AV ?fistula|double lumen|kateter (?:HD|dialisis)|CAPD)\b/i },
  malfungsi_akses: { nama: 'Malfungsi akses dialisis', px: /^39\.4[2-3]/, pola: /\b(?:malfungsi|macet|tersumbat|disfungsi)\b[^\n]{0,30}\b(?:CDL|cimino|AV ?shunt|AV ?fistula|akses|kateter|double lumen)\b/i },
  transfusi: { nama: 'Memerlukan transfusi', terapi: true, px: /^99\.0[34]/, pola: /\b(?:transfusi|PRC|packed red|whole blood)\b/i },
  // Bukti EKG, bukan baris diagnosis "AF RVR": halaman EKG atau baris yang menyebut EKG/ECG/irama.
  ekg_af: { nama: 'EKG fibrilasi atrium (ireguler, tanpa gelombang P)', pola: [/\b(?:EKG|ECG|elektrokardiogra\w*|irama)\b[^\n]{0,60}\b(?:AF|atrial fibrilasi|atrial fibrillation|fibrilasi atri(?:um|al)|ireguler|irreguler|tidak teratur)\b/i] },
  ccs_34: { nama: 'Angina CCS kelas 3-4 (simptomatik)', pola: /\bCCS\s*(?:kelas\s*|class\s*)?(?:III|IV|3|4)\b/i },
  riwayat_infark: { nama: 'Riwayat infark miokard lama', ragu: false, dx: /^I25\.2/, pola: /\b(?:old MI|OMI|riwayat (?:infark|IMA|serangan jantung)|post (?:MI|IMA))\b/i },
  stress_test_positif: { nama: 'Uji iskemik (treadmill/ekokardiografi stres/perfusi) positif', ragu: false,
    pola: /\b(?:treadmill|TMT|stress test|uji latih|ekokardiografi stres|dobutamine stress|perfusi miokard)\b[^\n]{0,40}\b(?:positif|positive|iskemi\w*)\b/i },
  risiko_sangat_tinggi: { nama: 'Kriteria risiko sangat tinggi NSTEMI', pola: /\b(?:angina berulang|nyeri dada berulang|syok kardiogenik|VT|VF|TAVB|total AV block|AV block total|hemodinamik tidak stabil)\b/i },
};

function periksa(key, ctx) {
  const d = DETEKTOR[key];
  if (!d) return { id: key, nama: key, status: 'bukti_belum_cukup', bukti: [] };
  if (d.nilai) return { id: key, nama: d.nama, ...d.nilai(ctx) };
  const bukti = [];
  const px = d.px ? ctx.px.filter(k => d.px.test(k)) : [], dx = d.dx ? ctx.dx.filter(k => d.dx.test(k)) : [];
  if (px.length) bukti.push({ page_number: null, kutipan: `Kode prosedur diklaim: ${px.join(', ')}` });
  if (dx.length) bukti.push({ page_number: null, kutipan: `Kode diagnosis diklaim: ${dx.join(', ')}` });
  if (d.pola) bukti.push(...cari(d, d.terapi ? ctx.terapi : d.termasuk_spri ? ctx.klinisSpri : ctx.klinis));
  if (d.kebalikan) return { id: key, nama: d.nama, status: bukti.length ? 'bukti_belum_cukup' : 'bukti_ditemukan', bukti: bukti.slice(0, 6),
    ...(bukti.length ? { catatan: d.catatan_ada } : {}) };
  return { id: key, nama: d.nama, status: bukti.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: bukti.slice(0, 6) };
}

// kriteria: daftar kelompok; kelompok = satu kunci atau array kunci (semua harus ada).
// syarat 'salah_satu' -> cukup satu kelompok; 'semua' -> seluruh kelompok.
function nilaiKriteria(a, ctx) {
  const memo = {};
  const ambil = k => (memo[k] ??= periksa(k, ctx));
  const kelompok = a.kriteria.map(g => [].concat(g).map(ambil));
  const lolos = kelompok.map(g => g.every(b => b.status === 'bukti_ditemukan'));
  const ok = a.syarat === 'semua' ? lolos.every(Boolean) : lolos.some(Boolean);
  const bukti = Object.values(memo);
  const angkaB = bukti.filter(b => b.angka);
  // 'semua': satu ambang wajib yang terbaca dan tidak terpenuhi sudah bertentangan.
  // 'salah_satu': seluruh alternatif angka terbaca tidak terpenuhi dan tidak ada alternatif lain.
  // 'salah_satu': semua alternatif gagal dan minimal satu angka terbaca jelas tidak memenuhi ambang.
  const kontradiksi = !ok && a.kontradiksi_tinggi === true && angkaB.length > 0 && (a.syarat === 'semua'
    ? angkaB.some(b => b.nilai_terbaca && b.status !== 'bukti_ditemukan')
    : angkaB.some(b => b.nilai_terbaca && b.status === 'bukti_belum_cukup'));
  // Kriteria yang tertulis tetapi tidak dapat dinilai otomatis (mis. satuan lain) -> telaah manual, bukan alasan pending.
  const manual = !ok && bukti.some(b => b.status === 'perlu_cek_manual');
  return { status: ok ? 'bukti_ditemukan' : manual ? 'perlu_cek_manual' : 'bukti_belum_cukup', bukti, menilai: !manual, kontradiksi: kontradiksi && !manual };
}

const hasil = (status, bukti, catatan, extra = {}) => ({ status, bukti, menilai: status !== 'perlu_cek_manual', catatan, ...extra });
const butirBukti = (id, nama, status, bukti, catatan) => ({ id, nama, status, bukti, ...(catatan ? { catatan } : {}) });

// Butir dengan cabang/aturan koding yang tidak cukup dinyatakan sebagai kelompok kriteria.
const KHUSUS = {
  selalu_telaah: (a) => hasil('bukti_belum_cukup', [], a.alasan_telaah),
  natrium_anak: (a, ctx) => {
    const jantung = ctx.dx.some(k => DX_JANTUNG.test(k));
    const lab = ambangLab(ctx, 'natrium', v => v < (jantung ? 135 : 130), 'natrium');
    const klinis = periksa('kejang_kesadaran_dehidrasi_berat', ctx), terapi = periksa('koreksi_elektrolit', ctx);
    const ok = (lab.status === 'bukti_ditemukan' || klinis.status === 'bukti_ditemukan') && terapi.status === 'bukti_ditemukan';
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup',
      [butirBukti('natrium', `Natrium <${jantung ? 135 : 130} mmol/L${jantung ? ' (penyerta penyakit jantung)' : ''}`, lab.status, lab.bukti, lab.catatan), klinis, terapi]);
  },
  kalium_anak: (a, ctx) => {
    const jantung = ctx.dx.some(k => DX_JANTUNG.test(k));
    const lab = ambangLab(ctx, 'kalium', v => v < (jantung ? 3.5 : 3), 'kalium');
    const klinis = periksa('gejala_hipokalemia', ctx), terapi = periksa('koreksi_elektrolit', ctx);
    const ok = (lab.status === 'bukti_ditemukan' || klinis.status === 'bukti_ditemukan') && terapi.status === 'bukti_ditemukan';
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup',
      [butirBukti('kalium', `Kalium <${jantung ? 3.5 : 3} mmol/L${jantung ? ' (penyerta penyakit jantung)' : ''}`, lab.status, lab.bukti, lab.catatan), klinis, terapi]);
  },
  tb_a15: (a, ctx) => {
    const btaNeg = cari({ pola: /\b(?:BTA|AFB|Ziehl)\b[^\n]{0,40}\b(?:negatif|negative|neg|\(-\))/i, tanpa_negasi: true }, ctx.klinis);
    const pos = cari({ pola: [/\b(?:BTA|AFB)\b[^\n]{0,40}(?:positif|positive|\+|scanty|1\+|2\+|3\+)/i,
      /\b(?:TCM|GeneXpert|Xpert|MTB)\b[^\n]{0,40}\b(?:detected|positif|positive|terdeteksi)\b(?!\s*not)/i, /\bkultur\b[^\n]{0,30}\b(?:M\.?\s*tb|mycobacterium)\b[^\n]{0,20}\b(?:tumbuh|positif)/i] }, ctx.klinis)
      .filter(b => !/\bnot detected|tidak terdeteksi\b/i.test(b.kutipan));
    const edukasi = periksa('edukasi_oat', ctx);
    if (pos.length) return hasil('bukti_ditemukan', [butirBukti('konfirmasi_bakteriologis', 'Konfirmasi bakteriologis positif (BTA/TCM/kultur)', 'bukti_ditemukan', pos), edukasi]);
    if (btaNeg.length) return hasil('bukti_belum_cukup', [butirBukti('konfirmasi_bakteriologis', 'Konfirmasi bakteriologis positif (BTA/TCM/kultur)', 'bukti_belum_cukup', btaNeg,
      'BTA negatif tertulis dan konfirmasi TCM/kultur positif belum terbaca. Menurut BA, BTA negatif memakai kode A16.'), edukasi]);
    return hasil('perlu_cek_manual', [butirBukti('konfirmasi_bakteriologis', 'Konfirmasi bakteriologis positif (BTA/TCM/kultur)', 'bukti_belum_cukup', [], 'Hasil BTA/TCM belum terbaca.'), edukasi]);
  },
  i12_ggk: (a, ctx) => {
    const ginjal = ctx.dx.filter(k => /^(?:N0[0-7]|N18|N19|N26)/.test(k));
    const gga = ctx.dx.filter(k => /^N17/.test(k));
    if (ginjal.length || !gga.length) return null;
    return hasil('bukti_belum_cukup', [butirBukti('kelainan_ginjal_i12', 'Kelainan ginjal yang termasuk I12 (N00-N07, N18, N19, N26)', 'bukti_belum_cukup',
      [{ page_number: null, kutipan: `Kode ginjal diklaim: ${gga.join(', ')}` }], 'Gagal ginjal akut (N17) tidak termasuk kode I12 (hypertensive renal disease).')]);
  },
  leukositosis: (a, ctx) => {
    const rows = ctx.lab().filter(b => b.parameter === 'leukosit');
    const hamil = ctx.dx.some(k => DX_HAMIL.test(k));
    const ambang = hamil ? 16000 : 10000;
    const tinggi = rows.filter(b => b.kewajaran.nilai_dinormalkan > ambang);
    const infeksi = ctx.dx.filter(k => DX_INFEKSI.test(k));
    const mpn = ctx.dx.filter(k => /^(?:D45|D47\.[13]|C92\.1)/.test(k));
    const obat = cari({ pola: /\b(?:G-?CSF|filgrastim|leucogen|leukokine|dexametason\w*|dexamethason\w*|metilprednisolon\w*|methylprednisolon\w*|prednison\w*|hidrokortison\w*|steroid)\b/i }, ctx.terapi);
    const lab = butirBukti('leukosit_tinggi', `Leukosit >${ambang.toLocaleString('id-ID')}/uL${hamil ? ' (kehamilan: s.d. 16.000 masih fisiologis)' : ''}`,
      tinggi.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', (tinggi.length ? tinggi : rows).slice(0, 6).map(kutipLab),
      rows.length ? undefined : 'Hasil leukosit belum terbaca.');
    const sebab = butirBukti('bukan_infeksi_obat_mpn', 'Bukan akibat infeksi, obat (G-CSF/steroid) atau MPN', infeksi.length || mpn.length || obat.length ? 'bukti_belum_cukup' : 'bukti_ditemukan',
      [...[...infeksi, ...mpn].map(k => ({ page_number: null, kutipan: `Kode diagnosis diklaim: ${k}` })), ...obat].slice(0, 6),
      infeksi.length || mpn.length || obat.length ? 'Leukositosis yang disebabkan infeksi, pemberian obat (G-CSF, steroid) atau MPN bukan D72.8 sebagai diagnosis sekunder.' : undefined);
    const ok = lab.status === 'bukti_ditemukan' && sebab.status === 'bukti_ditemukan';
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', [lab, sebab], undefined, { kontradiksi: rows.length > 0 && !tinggi.length });
  },
  leukopenia: (a, ctx) => {
    const kanker = ctx.dx.some(k => DX_KANKER.test(k));
    const rows = ctx.lab().filter(b => b.parameter === 'leukosit');
    const rendah = rows.filter(b => b.kewajaran.nilai_dinormalkan < (kanker ? 3000 : 4000));
    return hasil(rendah.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', [butirBukti('leukosit_rendah', kanker ? 'Leukosit <3.000/uL pada pasien kanker' : 'Bukti lab leukopenia',
      rendah.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', (rendah.length ? rendah : rows).slice(0, 6).map(kutipLab), rows.length ? undefined : 'Hasil leukosit belum terbaca.')],
      kanker ? 'Pada pasien kanker D70 ditulis terpisah dari diagnosis kanker karena berdampak pada pemberian G-CSF pasca kemoterapi sampai leukosit >=4.000.' : undefined,
      { kontradiksi: rows.length > 0 && !rendah.length });
  },
  gagal_napas: (a, ctx) => {
    const kronik = ctx.dx.some(k => /^J96\.1/.test(k));
    const agd = bacaAgd(ctx.klinis);
    const spo2 = bacaPola(ctx.klinis, RE_SPO2, v => v >= 40 && v <= 100);
    const kutip = arr => arr.slice(0, 3).map(r => ({ page_number: r.page_number, kutipan: r.kutipan, nilai: r.nilai }));
    let kriteria;
    if (kronik) {
      const ok = agd.pco2.some(r => r.nilai > 50) && agd.hco3.some(r => r.nilai > 24) && agd.ph.some(r => r.nilai >= 7.35 && r.nilai <= 7.45)
        && (agd.po2.some(r => r.nilai < 60) || agd.sao2.some(r => r.nilai < 91));
      kriteria = butirBukti('agd_kronik', 'AGD gagal napas kronik: pCO2 >50, HCO3 >24, pH 7,35-7,45 dan pO2 <60/SaO2 <91 (seluruhnya)',
        ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', kutip([...agd.pco2, ...agd.hco3, ...agd.ph, ...agd.po2]), ok ? undefined : 'Seluruh kriteria AGD kronik belum terbaca.');
    } else {
      const kena = [...agd.po2.filter(r => r.nilai < 60), ...agd.sao2.filter(r => r.nilai < 91), ...spo2.filter(r => r.nilai < 91), ...agd.pf.filter(r => r.nilai < 300)];
      const hiperkapnia = agd.pco2.some(r => r.nilai > 50) && agd.ph.some(r => r.nilai < 7.35);
      const ok = kena.length > 0 || hiperkapnia;
      kriteria = butirBukti('kriteria_akut', 'Salah satu: pO2 <60/SaO2 <91, SpO2 <91, P/F <300, pCO2 >50 dengan pH <7,35, atau pCO2 naik >=10 dari dasar',
        ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', kutip(ok ? (kena.length ? kena : [...agd.pco2, ...agd.ph]) : [...spo2, ...agd.po2]),
        ok ? undefined : spo2.length || agd.po2.length ? 'SpO2/AGD terbaca, belum memenuhi ambang (nilai sesudah oksigen perlu dibedakan dari nilai awal).' : 'SpO2/AGD belum terbaca.');
    }
    const o2 = periksa('terapi_oksigen', ctx);
    return hasil(kriteria.status === 'bukti_ditemukan' && o2.status === 'bukti_ditemukan' ? 'bukti_ditemukan' : 'bukti_belum_cukup', [kriteria, o2]);
  },
  insufisiensi_renal: (a, ctx) => {
    const rows = ctx.lab().filter(b => b.parameter === 'kreatinin');
    if (ctx.usia.tahun !== null && ctx.usia.tahun < 18) {
      const ureum = ctx.lab().filter(b => b.parameter === 'ureum');
      const ok = rows.length >= 2 || ureum.length >= 2;
      return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', [butirBukti('ureum_kreatinin_berulang', 'Anak: pemeriksaan ureum/kreatinin berulang',
        ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', [...rows, ...ureum].slice(0, 6).map(kutipLab), ok ? undefined : `${rows.length} kreatinin dan ${ureum.length} ureum terbaca.`)]);
    }
    const g = String(ctx.record.gender ?? ctx.record.GENDER ?? ctx.record.jenis_kelamin ?? '').trim().toUpperCase();
    const wanita = /^(?:2|P|F|W|PEREMPUAN|WANITA|FEMALE)$/.test(g), pria = /^(?:1|L|M|LAKI|LAKI-LAKI|PRIA|MALE)$/.test(g);
    const batas = wanita ? 1.1 : 1.3;
    const tinggi = rows.filter(b => b.kewajaran.nilai_dinormalkan > batas);
    const gfr = bacaPola(ctx.klinis, /\b(?:e?GFR|LFG|CCT|klirens kreatinin|creatinine clearance)\s*[:=]?\s*(\d{1,3}(?:[.,]\d+)?)/i);
    const gfrRendah = gfr.filter(r => r.nilai < 60);
    const ok = tinggi.length > 0 || gfrRendah.length > 0;
    const catatan = !wanita && !pria && rows.some(b => b.kewajaran.nilai_dinormalkan > 1.1 && b.kewajaran.nilai_dinormalkan <= 1.3)
      ? 'Jenis kelamin belum terbaca; kreatinin 1,1-1,3 memenuhi ambang wanita tetapi tidak ambang pria.' : undefined;
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', [butirBukti('kreatinin_gfr', `GFR <60 atau kreatinin >${String(batas).replace('.', ',')} mg/dL${wanita ? ' (wanita)' : pria ? ' (pria)' : ''}`,
      ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', [...(ok ? tinggi : rows).map(kutipLab), ...(ok ? gfrRendah : gfr).map(r => ({ page_number: r.page_number, kutipan: r.kutipan, nilai: r.nilai }))].slice(0, 6),
      rows.length || gfr.length ? catatan : 'Hasil kreatinin/GFR belum terbaca.')], undefined,
      { kontradiksi: !ok && (rows.length > 0 || gfr.length > 0) && !catatan });
  },
  hemoroid: (a, ctx) => {
    const intervensi = periksa('px_hemoroid', ctx), g4 = periksa('hemoroid_grade4', ctx), lain = periksa('hemoroid_ri_lain', ctx), hb = periksa('hb_10', ctx);
    const bukti = [intervensi, g4, lain, hb];
    let ok = [intervensi, g4, lain, hb].some(b => b.status === 'bukti_ditemukan');
    if (ctx.px.some(k => /^49\.46/.test(k))) {
      const g34 = periksa('hemoroid_grade34', ctx), g2a = periksa('hemoroid_grade2', ctx), g2b = periksa('hemoroid_penyulit', ctx);
      const g2 = { status: g2a.status === 'bukti_ditemukan' && g2b.status === 'bukti_ditemukan' ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: [...g2a.bukti, ...g2b.bukti] };
      const indikasi = butirBukti('indikasi_hemoroidektomi', 'Indikasi hemoroidektomi: grade III-IV, atau grade II dengan perdarahan akut/kronis dengan anemia/trombosis',
        g34.status === 'bukti_ditemukan' || g2.status === 'bukti_ditemukan' ? 'bukti_ditemukan' : 'bukti_belum_cukup', [...g34.bukti, ...g2.bukti].slice(0, 6));
      bukti.push(indikasi);
      ok = ok && indikasi.status === 'bukti_ditemukan';
    }
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti);
  },
  batu: (a, ctx) => {
    const rows = bacaPola(ctx.klinis, /\b(?:batu|stone|kalkulus|calculus|BSK|nefrolitiasis|ureterolitiasis|nephrolith\w*)\b[^\n]{0,60}?(\d{1,2}(?:[.,]\d+)?)\s*(?:x\s*\d{1,2}(?:[.,]\d+)?\s*)?(mm|cm)\b/i)
      .map(r => ({ ...r, nilai: /mm/i.test(r.m[2]) ? r.nilai / 10 : r.nilai }));
    if (!rows.length) return hasil('bukti_belum_cukup', [butirBukti('ukuran_batu', 'Ukuran dan lokasi batu', 'bukti_belum_cukup', [], 'Ukuran batu belum terbaca dari imaging/laporan operasi.')]);
    const terbesar = Math.max(...rows.map(r => r.nilai));
    const ok = terbesar <= 2;
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', [butirBukti('ukuran_batu', 'Batu <=2 cm (di atas 2 cm dianjurkan PCNL/operasi terbuka)', ok ? 'bukti_ditemukan' : 'bukti_belum_cukup',
      rows.slice(0, 4).map(r => ({ page_number: r.page_number, kutipan: r.kutipan, nilai: r.nilai })), ok ? undefined : `Ukuran terbesar terbaca ${String(terbesar).replace('.', ',')} cm.`)]);
  },
  kejang: (a, ctx) => {
    const r56 = ctx.dx.filter(k => /^R56/.test(k));
    const eksklusi = ctx.dx.filter(k => /^(?:G4[01]|F44\.5)/.test(k));
    const neonatus = ctx.usia.hari !== null && ctx.usia.hari < 28;
    if (!neonatus && !eksklusi.length) return null;
    const bukti = [];
    if (neonatus) bukti.push(butirBukti('bukan_neonatus', 'Kejang neonatus dikode P90, bukan R56', 'bukti_belum_cukup', [{ page_number: null, kutipan: `Usia ${ctx.usia.hari} hari; kode ${r56.join(', ')}` }]));
    if (eksklusi.length) bukti.push(butirBukti('bukan_epilepsi_disosiatif', 'R56 mengecualikan epilepsi (G40-G41) dan kejang disosiatif (F44.5)', 'bukti_belum_cukup',
      [{ page_number: null, kutipan: `Kode diklaim bersama: ${eksklusi.join(', ')}` }]));
    return hasil('bukti_belum_cukup', bukti);
  },
  // Kode P07 menurut berat lahir (P07.0 <=999 g, P07.1 1000-2499 g) dan usia gestasi (P07.2 <28, P07.3 28-<37 minggu).
  bblr: (a, ctx) => {
    const p07 = ctx.dx.filter(k => /^P07/.test(k));
    const berat = bacaPola(ctx.klinis, /\b(?:BB\s*lahir|BBL|berat\s*(?:badan\s*)?lahir|BB\s*bayi\s*lahir)\s*[:=]?\s*(\d{1,2}[.,]?\d{0,3})\s*(gr|gram|g|kg)\b/i)
      .map(r => { const t = r.m[1].replace(',', '.'); const kg = /kg/i.test(r.m[2]); const n = kg ? Number(t) * 1000 : Number(t.replace('.', '')); return { ...r, nilai: n }; })
      .filter(r => r.nilai >= 300 && r.nilai <= 6000);
    const gestasi = bacaPola(ctx.klinis, /\b(?:usia\s*(?:gestasi|kehamilan)|UK|masa\s*gestasi|gestational\s*age|GA)\s*[:=]?\s*(\d{2})\s*(?:\+\s*\d\s*)?(?:minggu|mgg|mg|weeks?)\b/i, v => v >= 20 && v <= 45);
    const kutip = arr => arr.slice(0, 3).map(r => ({ page_number: r.page_number, kutipan: r.kutipan, nilai: r.nilai }));
    const bukti = [];
    let kontradiksi = false;
    const pBerat = p07.filter(k => /^P07\.[01]/.test(k));
    if (pBerat.length) {
      if (!berat.length) bukti.push(butirBukti('berat_lahir', 'Berat lahir tertulis sesuai kode P07.0/P07.1', 'bukti_belum_cukup', [], 'Berat lahir belum terbaca dari berkas.'));
      else {
        const bb = berat[0].nilai, harap = bb < 1000 ? 'P07.0' : bb < 2500 ? 'P07.1' : null;
        const ok = harap !== null && pBerat.some(k => k.startsWith(harap));
        if (!ok) kontradiksi = true;
        bukti.push(butirBukti('berat_lahir', 'Berat lahir tertulis sesuai kode P07.0/P07.1', ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', kutip(berat),
          ok ? undefined : harap ? `Berat lahir ${bb} g sesuai ${harap}, sedangkan diklaim ${pBerat.join(', ')}.` : `Berat lahir ${bb} g (>=2500 g) bukan BBLR menurut PNPK; kode ${pBerat.join(', ')} tidak sesuai.`));
      }
    }
    const pGestasi = p07.filter(k => /^P07\.[23]/.test(k));
    if (pGestasi.length) {
      if (!gestasi.length) bukti.push(butirBukti('usia_gestasi', 'Usia gestasi tertulis sesuai kode P07.2/P07.3', 'bukti_belum_cukup', [], 'Usia gestasi belum terbaca dari berkas.'));
      else {
        const ga = gestasi[0].nilai, harap = ga < 28 ? 'P07.2' : ga < 37 ? 'P07.3' : null;
        const ok = harap !== null && pGestasi.some(k => k.startsWith(harap));
        if (!ok) kontradiksi = true;
        bukti.push(butirBukti('usia_gestasi', 'Usia gestasi tertulis sesuai kode P07.2/P07.3', ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', kutip(gestasi),
          ok ? undefined : harap ? `Usia gestasi ${ga} minggu sesuai ${harap}, sedangkan diklaim ${pGestasi.join(', ')}.` : `Usia gestasi ${ga} minggu (cukup bulan) tidak sesuai kode prematur ${pGestasi.join(', ')}.`));
      }
    }
    if (!bukti.length) return null;
    const ok = bukti.every(b => b.status === 'bukti_ditemukan');
    return hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti, undefined, { kontradiksi: !ok && kontradiksi });
  },
  // BA 2023 koding no. 18 & BA 2019 butir 197-209: tindakan yang diklaim harus tertulis di berkas
  // (resume/laporan/catatan). Lab, rontgen toraks, nebulisasi dan operasi dinilai KD-06/07/01/05.
  prosedur_tertulis: (a, ctx) => {
    const PETA = [
      [/^57\.94/, 'Pemasangan kateter urin (57.94)', /\b(?:pasang\w*|insersi|terpasang|pemasangan)\b[^\n]{0,20}\b(?:kateter|catheter|DC|dower|foley|DK)\b|\b(?:kateter urin|foley catheter|DC)\b[^\n]{0,15}\b(?:no\.?|ukuran|terpasang|\d{2}\s*Fr)/i],
      [/^97\.64/, 'Lepas kateter/alat drainase urin (97.64)', /\b(?:aff|lepas|pelepasan|cabut|remove\w*)\b[^\n]{0,20}\b(?:kateter|catheter|DC|DJ|stent|dower|foley|DK)\b/i],
      [/^96\.07/, 'Pemasangan NGT (96.07)', /\b(?:pasang\w*|insersi|terpasang|pemasangan)\b[^\n]{0,15}\b(?:NGT|OGT|selang lambung|sonde)\b|\b(?:NGT|OGT)\b[^\n]{0,15}\bterpasang\b/i],
      [/^99\.04/, 'Transfusi PRC (99.04)', /\b(?:transfusi|PRC|packed red)\b/i],
      [/^99\.6/, 'Resusitasi jantung paru (99.60-99.62)', /\b(?:RJP|CPR|resusitasi jantung paru|kompresi dada|DC shock|defibrilasi)\b/i],
      [/^93\.93/, 'Resusitasi non-mekanik (93.93)', /\b(?:bagging|bag[ -]?(?:valve[ -]?)?mask|BVM|ambu ?bag|mouth to mouth|resusitasi)\b/i],
      [/^96\.04/, 'Intubasi endotrakeal (96.04)', /\b(?:intubasi|ETT|endotracheal|endotrakeal)\b/i],
      [/^34\.04/, 'Pemasangan WSD/chest tube (34.04)', /\b(?:WSD|chest tube|water seal)\b/i],
      [/^89\.52/, 'EKG (89.52)', /\b(?:EKG|ECG|elektrokardiogra\w*)\b/i],
    ];
    const bukti = [];
    for (const k of ctx.px) {
      const peta = PETA.find(([re]) => re.test(k));
      if (!peta) continue;
      const b = cari({ pola: peta[2], ragu: false }, ctx.semua);
      bukti.push(butirBukti(`tindakan_${k}`, peta[1], b.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', b.slice(0, 2),
        b.length ? undefined : `Kode ${k} diklaim tetapi tindakan tidak tertulis di berkas.`));
    }
    if (!bukti.length) return null;
    return hasil(bukti.every(b => b.status === 'bukti_ditemukan') ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti);
  },
  laparotomi: (a, ctx) => {
    const utama = ctx.px[0] && /^54\.11/.test(ctx.px[0]);
    const lain = ctx.px.filter(k => /^(?:4[5-9]\.|5[0-3]\.|54\.[2-9]|6[5-9]\.)/.test(k) && !/^54\.11/.test(k));
    const bukti = [];
    let ok = true;
    if (ctx.dx.some(k => /^(?:K3[5-7]|K4[0-6])/.test(k))) {
      const pp = periksa('perforasi_peritonitis', ctx);
      bukti.push({ ...pp, nama: 'Apendisitis/hernia dengan perforasi dan peritonitis (indikasi laparotomi eksplorasi)' });
      ok = pp.status === 'bukti_ditemukan';
    }
    if (lain.length) {
      bukti.push(butirBukti('bukan_prosedur_utama', 'Laparotomi eksplorasi insidental bukan prosedur utama', utama ? 'bukti_belum_cukup' : 'bukti_ditemukan',
        [{ page_number: null, kutipan: `Urutan prosedur diklaim: ${ctx.px.join(', ')}` }],
        utama ? 'Ada prosedur operasi lain; laparotomi eksplorasi insidental tidak direncanakan dan bukan prosedur utama.' : undefined));
      ok = ok && !utama;
    }
    return bukti.length ? hasil(ok ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti) : null;
  },
};
Object.assign(DETEKTOR, {
  kejang_kesadaran_dehidrasi_berat: { nama: 'Kejang, penurunan kesadaran atau dehidrasi berat', pola: /\b(?:kejang|konvulsi|penurunan kesadaran|somnolen|sopor|koma|dehidrasi berat)\b/i },
  gejala_hipokalemia: { nama: 'Kelemahan otot, kembung, aritmia atau bising usus menurun', pola: /\b(?:kelemahan otot|lemah otot|paresis|kembung|distensi|meteorismus|aritmia|bising usus (?:menurun|lemah|melemah|\(\s*[↓-]\s*\)))\b/i },
  // --- Butir BA 2018 bawaan (M03, M43, M61) ---
  // Hasil foto toraks: halaman radiologi, atau baris yang menyebut toraks/rontgen (sering disalin ke resume).
  infiltrat_toraks: { nama: 'Foto toraks: infiltrat baru/progresif', nilai: ctx => {
    const temuan = /\b(?:infiltrat\w*|konsolidasi|perselubungan|air bronchogram|bronko\s*pneumonia|bronchopneumonia|pneumonia)\b/i;
    const b = [...cari({ jenis: ['radiology'], pola: temuan }, ctx.klinis),
      ...cari({ pola: new RegExp(`\\b(?:thorax|thoraks|toraks|ro\\.?\\s*thorax|rontgen|x-?ray|foto dada|CXR)\\b[^\\n]{0,80}${temuan.source}`, 'i') }, ctx.klinis)]
      .filter((x, i, arr) => arr.findIndex(y => y.kutipan === x.kutipan) === i);
    return { status: b.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: b.slice(0, 4), catatan: b.length ? undefined : 'Hasil foto toraks dengan infiltrat belum terbaca.' };
  } },
  dua_gejala_pneumonia: { nama: '>=2 gejala: batuk bertambah, dahak purulen, suhu >38 C/riwayat demam, konsolidasi/bronkial/ronki, leukosit >10.000 atau <4.500', nilai: ctx => {
    const g = [
      ['batuk', cari({ pola: /\bbatuk\w*\b/i }, ctx.klinis)],
      ['dahak purulen', cari({ pola: /\b(?:dahak|sputum)\b[^\n]{0,25}\b(?:purulen|kuning|hijau|kental)\b|\bpurulen\b/i }, ctx.klinis)],
      ['demam', [...cari({ pola: /\b(?:demam|febris|panas)\b/i }, ctx.klinis), ...bacaPola(ctx.klinis, /\b(?:suhu|temp\w*|T)\s*[:=]?\s*(\d{2}(?:[.,]\d)?)\s*(?:°|o)?\s*C?\b/i, v => v > 38 && v < 43)]],
      ['ronki/konsolidasi', cari({ pola: /\b(?:ronki|rhonki|ronkhi|rh\s*\+|suara napas bronkial|konsolidasi)\b/i }, ctx.klinis)],
      ['leukosit', ctx.lab().filter(b => b.parameter === 'leukosit' && (b.kewajaran.nilai_dinormalkan > 10000 || b.kewajaran.nilai_dinormalkan < 4500)).map(kutipLab)],
    ].filter(([, b]) => b.length);
    return { status: g.length >= 2 ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: g.flatMap(([, b]) => b.slice(0, 1)).map(({ m, ...b }) => b),
      catatan: `Gejala terbaca: ${g.map(([n]) => n).join(', ') || '-'} (${g.length} dari minimal 2).` };
  } },
  sirs_2: { nama: '>=2 kriteria SIRS (suhu >38,5/<36; nadi >90; napas >20 atau PaCO2 <32; leukositosis)', nilai: ctx => {
    const v = (re, uji) => bacaPola(ctx.klinis, re, uji);
    const g = [
      ['suhu', v(/\b(?:suhu|temp\w*|T)\s*[:=]?\s*(\d{2}(?:[.,]\d)?)\s*(?:°|o)?\s*C?\b/i, x => (x > 38.5 && x < 43) || (x < 36 && x > 30))],
      ['nadi', v(/\b(?:nadi|HR|heart rate|N)\s*[:=]?\s*(\d{2,3})\s*(?:x|kali|bpm)/i, x => x > 90 && x < 250)],
      ['napas', v(/\b(?:RR|respirasi|napas|nafas|R)\s*[:=]?\s*(\d{2})\s*(?:x|kali)/i, x => x > 20 && x < 80)],
      ['leukosit', ctx.lab().filter(b => b.parameter === 'leukosit' && (b.kewajaran.nilai_dinormalkan > 12000 || b.kewajaran.nilai_dinormalkan < 4000)).map(kutipLab)],
    ].filter(([, b]) => b.length);
    return { status: g.length >= 2 ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: g.flatMap(([, b]) => b.slice(0, 1)).map(({ m, ...b }) => b),
      catatan: `Kriteria SIRS terbaca: ${g.map(([n]) => n).join(', ') || '-'} (${g.length} dari minimal 2).` };
  } },
  kultur_darah_hasil: { nama: 'Hasil kultur darah dilampirkan', tanpa_negasi: true,
    pola: /\b(?:kultur|biakan|culture)\s*(?:darah|blood)\b[^\n]{0,60}\b(?:tumbuh|positif|negatif|steril|no growth|isolat\w*|bakteri|\w+coccus|\w+bacter\w*|E\.?\s*coli|klebsiella|pseudomonas|salmonella)\b/i },
  tanpa_dx_penyebab_kejang: { nama: 'Tidak ada diagnosis lain penyebab kejang (meningitis/ensefalitis, gangguan elektrolit/metabolik, cedera kepala, epilepsi)', kebalikan: true,
    dx: /^(?:G0[0-5]|A8[3-9]|A39|E87|E16\.[012]|E83\.5|S06|G40|G41|P90)/, catatan_ada: 'Ada diagnosis lain penyebab kejang yang dikode.' },
  oak_iv: { nama: 'Memerlukan obat anti kejang intravena', terapi: true,
    pola: /\b(?:diazepam|stesolid|fenitoin|phenytoin|fenobarbital|phenobarbital|midazolam|levetiracetam|valproat)\b[^\n]{0,40}\b(?:iv|i\.v|intravena|intravenous|bolus|drip|inj\w*)\b|\b(?:iv|inj\w*)\s+(?:diazepam|fenitoin|phenytoin|fenobarbital|phenobarbital|midazolam|levetiracetam)\b/i },
  // --- Kriteria PNPK (src/data/kriteriaPnpk.json) ---
  pelod_10: { nama: 'Skor PELOD-2 >=10', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis,
    /\bPELOD[- ]?2?\b\s*(?:score|skor)?\s*[:=]?\s*(\d{1,2})(?!\d)/i, v => v <= 40), v => v >= 10, 'Skor PELOD-2', 'Skor PELOD-2 belum terbaca.'), angka: true }) },
  bukti_infeksi: { nama: 'Bukti/kecurigaan infeksi (fokus, kultur, penanda infeksi)', dx: /^(?:A\d|B\d|G0[0-6]|J1[2-8]|J2[0-2]|K35|K65|L0[0-8]|N10|N39\.0|P36)/,
    pola: /\b(?:fokus infeksi|kultur\b[^\n]{0,40}\b(?:tumbuh|positif)|prokalsitonin|procalcitonin|PCT|CRP|pneumonia|ISK|meningitis|peritonitis|selulitis|infeksi)\b/i },
  hasil_tsb: { nama: 'Bilirubin serum total (TSB) terukur', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis,
    /\b(?:bilirubin\s*total|total\s*bilirubin|T\.?\s*bil(?:irubin)?|TSB|bil(?:irubin)?\s*tot(?:al)?)\b(?![^\n]{0,15}transkutan)\s*[:=]?\s*(\d{1,2}(?:[.,]\d+)?)/i, v => v > 0 && v < 60), () => true,
    'Bilirubin total serum', 'Bilirubin total serum (TSB) belum terbaca; TcB/Kramer saja bukan dasar plot nomogram.') }) },
  kejang_berulang_atau_sindrom: { nama: 'Dua kejang tanpa provokasi berjarak >=24 jam atau sindrom epilepsi/terapi OAE', ragu: false,
    pola: /\b(?:kejang berulang|bangkitan berulang|riwayat (?:kejang|epilepsi)|(?:sudah|pernah) kejang|kejang (?:ke-?\s*[2-9]|kedua|[2-9]\s*x)|sindrom (?:west|lennox|dravet|epilepsi)|spasme infantil|OAE|asam valproat|valproic|depakene|fenitoin|phenytoin|levetiracetam|keppra|karbamazepin|carbamazepin|fenobarbital|phenobarbital)\b/i },
  bukan_kejang_terprovokasi: { nama: 'Bukan kejang pertama atau kejang terprovokasi (demam, elektrolit, trauma)', kebalikan: true, ragu: false,
    pola: /\b(?:kejang (?:pertama|pertama kali|1x pertama)|first (?:unprovoked )?seizure|kejang demam|febrile (?:seizure|convulsion))\b/i,
    catatan_ada: 'Tertulis kejang pertama/terprovokasi; epilepsi memerlukan >=2 kejang tanpa provokasi atau sindrom epilepsi.' },
  hasil_hb: { nama: 'Hemoglobin pratransfusi terukur', nilai: ctx => ({ ...ambangLab(ctx, 'hemoglobin', () => true, 'hemoglobin') }) },
  gds_200: { nama: 'Glukosa plasma sewaktu >=200 mg/dL', nilai: ctx => ({ ...ambangLab(ctx, 'gula_darah_sewaktu', v => v >= 200, 'gula darah sewaktu'), angka: true }) },
  gdp_126: { nama: 'Glukosa plasma puasa >=126 mg/dL', nilai: ctx => ({ ...ambangLab(ctx, 'gula_darah_puasa', v => v >= 126, 'gula darah puasa'), angka: true }) },
  hba1c_65: { nama: 'HbA1c >6,5% (tidak dipakai sendiri)', nilai: ctx => ({ ...ambangLab(ctx, 'hba1c', v => v > 6.5, 'HbA1c'), angka: true }) },
  gejala_dm: { nama: 'Gejala klasik DM (poliuria, polidipsia, nokturia, enuresis, penurunan BB, polifagia)',
    pola: /\b(?:poliuri\w*|polidipsi\w*|polifagi\w*|nokturi\w*|enuresis|sering (?:BAK|kencing)|banyak minum|(?:berat badan|BB) (?:turun|menurun)|penurunan (?:berat badan|BB))\b/i },
  // Bukti DM yang sudah ada sebelum episode: riwayat eksplisit atau obat DM. Tulisan diagnosis episode ini
  // ("Diagnosis Utama : DM tipe 2") bukan bukti dirinya sendiri.
  riwayat_dm_terapi: { nama: 'DM yang sudah terdiagnosis sebelumnya (riwayat/terapi insulin atau OAD)', ragu: false, terapi: true,
    pola: [/\b(?:riwayat (?:DM|diabetes|kencing manis)|DM sejak|diabetes sejak|diketahui (?:DM|diabetes)|kontrol rutin DM)\b/i,
      /\b(?:insulin|novorapid|novomix|lantus|levemir|humalog|apidra|ryzodeg|sansulin|metformin|glimepirid\w*|gliclazid\w*|glibenclamid\w*|acarbose|pioglitazon\w*|sitagliptin|vildagliptin|linagliptin|empagliflozin|dapagliflozin)\b/i] },
  gejala_isk: { nama: 'Gejala ISK (disuria, anyang-anyangan, nyeri suprapubik/pinggang, nyeri ketok CVA)',
    // Ejaan OCR/RS bervariasi ("anyang-anyangen") dan kata dapat terpotong di akhir baris ("BAK anyang-").
    pola: [/\b(?:disuri\w*|dysuri\w*|nyeri (?:saat )?(?:BAK|kencing)|sakit (?:saat )?(?:BAK|kencing)|anyang[\s-]*anyang\w*|urgensi|nyeri suprapubi\w*|nyeri tekan suprapubi\w*|nyeri (?:perut bawah|pinggang)|nyeri ketok (?:CVA|costovertebra\w*|ginjal)|CVA\s*\(\s*\+\s*\))/i,
      /\banyang\s*-\s*$/i] },
  // Piuria dinilai tegas: /LPB memakai PNPK (>5); Leu/uL dibandingkan dengan nilai rujukan lab pada
  // baris yang sama (tanpa konversi satuan); tanpa rujukan memakai ambang catatan RS (>10 Leu/uL) bila
  // catatan itu berlaku di RS ini. Mikroskopis didahulukan daripada dipstick.
  piuria_5: { nama: 'Piuria >5/LPB atau di atas nilai rujukan (PNPK ISK)', nilai: ctx => nilaiPiuria(ctx, 5, 'PNPK ISK: >5-10/LPB') },
  piuria_10: { nama: 'Leukosit urin >10/LPB atau di atas nilai rujukan (BA 2018 butir 37)', nilai: ctx => nilaiPiuria(ctx, 10, 'BA 2018: >10/LPB') },
  kultur_urin_tumbuh: { tolak: NEG_HASIL, nama: 'Kultur urin bermakna', tanpa_negasi: false,
    pola: /\bkultur\s*urin\w*\b[^\n]{0,60}\b(?:tumbuh|positif|\d+\s*(?:x\s*)?10\s*\^?\s*[2-5]|cfu)\b/i },
  konfirmasi_bakteriologis_tb: { tolak: NEG_HASIL, nama: 'Konfirmasi bakteriologis TB (BTA/TCM/biakan/PCR positif)',
    pola: [/\b(?:BTA|AFB)\b[^\n]{0,40}(?:positif|positive|scanty|[1-3]\+)/i, /\b(?:TCM|GeneXpert|Xpert)\b(?![^\n]{0,50}\b(?:not detected|tidak terdeteksi|negatif|negative)\b)[^\n]{0,40}\b(?:MTB detected|detected|positif|positive|terdeteksi)\b/i,
      /\b(?:biakan|kultur)\b[^\n]{0,30}\b(?:M\.?\s*tb|mycobacterium)\b[^\n]{0,20}\b(?:tumbuh|positif)\b/i] },
  skor_tb_anak_6: { nama: 'Sistem skoring TB anak >=6', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis,
    /\bskor(?:ing)?\s*(?:TB|tuberkulosis)\b[^\n\d]{0,15}(\d{1,2})(?!\d)/i, v => v <= 13), v => v >= 6, 'Skor TB anak', 'Skor TB anak belum terbaca.'), angka: true }) },
  kesan_radiologi_isk: { nama: 'Kesan pencitraan sistitis/pielonefritis', pola: /\b(?:kesan|kesimpulan)?[^\n]{0,20}\b(?:cystitis|sistitis|pielonefritis|pyelonephritis)\b/i },
  temuan_urin_lain: { nama: 'Temuan urinalisis lain (nitrit, bakteri)', jenis: ['lab_results'], pola: /\b(?:nitrit\s*[:=]?\s*(?:positif|\+)|bakteri\s*[:=]?\s*(?:\+\s*[1-4]|positif|banyak))\b/i },
  hba1c_65_dewasa: { nama: 'HbA1c >=6,5%', nilai: ctx => ({ ...ambangLab(ctx, 'hba1c', v => v >= 6.5, 'HbA1c'), angka: true }) },
  gds_200_dua: { nama: 'Dua pemeriksaan glukosa sewaktu >=200 mg/dL (tanpa gejala klasik)', nilai: ctx => {
    const r = ctx.lab().filter(b => b.parameter === 'gula_darah_sewaktu');
    const kena = r.filter(b => b.kewajaran.nilai_dinormalkan >= 200);
    return { status: kena.length >= 2 ? 'bukti_ditemukan' : 'bukti_belum_cukup', angka: true, nilai_terbaca: r.length > 0, bukti: (kena.length ? kena : r).slice(0, 6).map(kutipLab),
      catatan: `${kena.length} hasil GDS >=200 dari ${r.length} yang terbaca.` };
  } },
  // Laporan operasi yang ada tetapi tidak terbaca (tulisan tangan) berbeda dengan eksisi yang tidak tertulis.
  eksisi_debridemen: { nama: 'Eksisi jaringan pada debridemen (laporan operasi)', nilai: ctx => {
    const b = cari({ ragu: false, pola: /\b(?:eksisi|excision\w*|excisional|nekrotomi|necrotomy|sharp debridement|debridemen(?:t)? tajam|dieksisi|gunting|scalpel|pisau)\b/i }, ctx.semua);
    if (b.length) return { status: 'bukti_ditemukan', bukti: b };
    const lapop = ctx.semua.filter(p => p.jenis === 'laporan_operasi' || /LAPORAN\s+OPERASI/i.test(teks(p)));
    const terbaca = lapop.some(p => /\b(?:insisi|dijahit|perdarahan|dibersihkan|irigasi|jaringan|luka|diangkat|tindakan)\b/i.test(teks(p).split(/LAPORAN OPERASI LENGKAP|perjalanan operasi/i)[1] || ''));
    if (lapop.length && !terbaca) return { status: 'perlu_cek_manual', bukti: lapop.slice(0, 2).map(p => ({ page_number: p.page_number, kutipan: 'Laporan operasi ada, rincian tidak terbaca OCR' })),
      catatan: `Laporan operasi ada (hal. ${lapop.map(p => p.page_number).join(', ')}) tetapi rincian perjalanan operasi tidak terbaca OCR (mis. tulisan tangan); buka PDF untuk memastikan eksisi.` };
    return { status: 'bukti_belum_cukup', bukti: [], catatan: lapop.length ? 'Rincian laporan operasi terbaca tetapi tidak menulis eksisi; tanpa eksisi dikode 86.28.' : 'Laporan operasi yang menulis eksisi tidak ada di berkas; tanpa eksisi dikode 86.28.' };
  } },
  // --- Onkologi: konfirmasi diagnosis ---
  konfirmasi_pa_kanker: { nama: 'Konfirmasi patologi anatomi/biopsi (termasuk riwayat PA)', ragu: false, nilai: ctx => {
    const ganas = /\b(?:karsinoma|carcinoma|adeno\s*ca\w*|adenokarsinoma|ganas|malignan\w*|maligna|sarkoma|sarcoma|limfoma|lymphoma|IDC|ILC|invasive ductal|skuamosa|squamous|NPC|keganasan|metasta\w*|blastoma|melanoma)\b/i;
    const b = [...cari({ ragu: false, jenis: ['patologi_anatomi'], pola: ganas }, ctx.semua),
      ...cari({ ragu: false, pola: new RegExp(`\\b(?:PA|P\\.A|histopatologi\\w*|patologi anatomi|biopsi|biopsy|sitologi|FNAB|BAJH|FNA|IHK|imunohistokimia|core biopsy)\\b[^\\n]{0,80}${ganas.source}|${ganas.source}[^\\n]{0,40}\\b(?:PA|histopatologi|biopsi|IHK)\\b`, 'i') }, ctx.semua)]
      .filter((x, i, arr) => arr.findIndex(y => y.kutipan === x.kutipan) === i);
    return { status: b.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: b.slice(0, 4), catatan: b.length ? undefined : 'Hasil PA/biopsi (atau riwayat PA tertulis) belum terlihat di berkas.' };
  } },
  konfirmasi_pa_nasofaring: { nama: 'Biopsi nasofaring (biopsi/BAJH kelenjar leher bukan diagnosis pasti)', ragu: false, nilai: ctx => {
    const r = DETEKTOR.konfirmasi_pa_kanker.nilai(ctx);
    const pasti = r.bukti.filter(b => !/\b(?:KGB|kelenjar getah bening|kelenjar leher|BAJH|FNAB\s*colli|colli|leher)\b/i.test(b.kutipan) || /nasofaring|nasopharyn/i.test(b.kutipan));
    return { ...r, status: pasti.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: r.bukti,
      catatan: pasti.length ? undefined : r.bukti.length ? 'Hanya biopsi/BAJH kelenjar leher terbaca; PNPK: bukan diagnosis pasti kanker nasofaring.' : r.catatan };
  } },
  imaging_hati_khas: { nama: 'Pencitraan hati dengan lesi/gambaran khas KSH (CT/MRI/USG, LI-RADS)', ragu: false,
    pola: /\b(?:CT|MSCT|MRI|USG)\b[^\n]{0,80}\b(?:hepar|hati|liver)\b[^\n]{0,80}\b(?:massa|nodul|lesi|SOL|hipervaskular|wash\s*out|LR-?[45M]|hepatoma|KSH|HCC)\b|\b(?:LR-?[45]|LI-?RADS\s*[45]|hepatoma|HCC)\b/i },
  penanda_tumor_hati: { nama: 'Penanda tumor (AFP/PIVKA-II) atau penyakit hati kronik yang mendasari', dx: /^(?:B18|K74|K70\.3|K76\.6)/,
    pola: /\b(?:AFP|alfa\s*feto\w*|alpha\s*feto\w*|PIVKA)\b[^\n]{0,30}\d|\b(?:sirosis|cirrhosis|hepatitis B kronik|hepatitis C kronik|HBsAg\s*(?:reaktif|positif|\+)|anti[- ]?HCV\s*(?:reaktif|positif|\+))\b/i },
  imaging_otak_tumor: { nama: 'MRI/CT kepala dengan massa/tumor (MRI baku emas) atau PA pascaoperasi', ragu: false,
    pola: /\b(?:MRI|CT|MSCT)\b[^\n]{0,80}\b(?:kepala|otak|brain|head|kranial)?[^\n]{0,60}\b(?:massa|tumor|SOL|space occupying|meningioma|glioma|neoplasma|lesi desak ruang)\b|\b(?:meningioma|glioma|astrositoma|glioblastoma|medulloblastoma)\b[^\n]{0,30}\b(?:PA|histopatologi|WHO grade)\b/i },
  bmp_blas: { nama: 'Aspirasi sumsum tulang (blas >=20%) atau imunofenotipe/flowcytometry', ragu: false,
    pola: /\b(?:BMP|aspira\w*\s*sumsum|bone marrow|sumsum tulang|immunophenotyp\w*|imunofenotip\w*|flow\s*cytometry|flowsitometri)\b[^\n]{0,100}\b(?:blas|blast|LLA|ALL|leukemia|limfoblas\w*|CD\s*\d{1,2})\b|\bblas(?:t)?\s*[:=]?\s*(?:[2-9]\d|100)\s*%/i },
  imaging_retinoblastoma: { nama: 'Funduskopi/USG/CT/MRI orbita dengan massa retina/leukokoria', ragu: false,
    pola: /\b(?:funduskopi|USG|CT|MRI|oftalmoskop\w*)\b[^\n]{0,80}\b(?:massa|tumor|kalsifikasi|retinoblastoma|leukokoria)\b|\bleukokoria\b/i },
  // --- Infeksi: konfirmasi laboratorium ---
  hasil_hiv: { tolak: NEG_HASIL, nama: 'Tes HIV serologis/virologis reaktif atau ODHA dalam terapi ARV', ragu: false,
    pola: [/\b(?:anti[- ]?HIV|HIV|R1|R2|R3|rapid(?: test)? HIV|tes HIV|VCT|EIA|ELISA|viral load|HIV RNA)\b[^\n]{0,40}\b(?:reaktif|reactive|positif|positive|detected|terdeteksi)\b/i,
      /\b(?:ODHA|on ARV|terapi ARV|tenofovir|lamivudin\w*|efavirenz|dolutegravir|zidovudin\w*|nevirapin\w*|TLE|TLD)\b/i] },
  hasil_malaria: { tolak: NEG_HASIL, nama: 'Parasit malaria pada mikroskopik (baku emas) atau RDT positif', ragu: false,
    pola: /\b(?:malaria|plasmodium|DDR|sediaan darah|apusan darah|RDT)\b[^\n]{0,50}\b(?:positif|positive|\+|ditemukan|tropozoit|trofozoit|gametosit|skizon|ring|P\.?\s*falciparum|P\.?\s*vivax|P\.?\s*malariae|P\.?\s*ovale|P\.?\s*knowlesi)\b(?![^\n]{0,10}\b(?:negatif|tidak ditemukan)\b)/i },
  hbsag_reaktif: { tolak: NEG_HASIL, nama: 'HBsAg reaktif (kronik: >6 bulan) atau DNA VHB/IgM anti-HBc', ragu: false,
    pola: /\b(?:HBsAg|HBV DNA|DNA VHB|IgM anti[- ]?HBc)\b[^\n]{0,30}\b(?:reaktif|reactive|positif|positive|\+|detected|\d)/i },
  hcv_reaktif: { tolak: NEG_HASIL, nama: 'Anti-HCV reaktif dan/atau RNA VHC terdeteksi', ragu: false,
    pola: /\b(?:anti[- ]?HCV|HCV RNA|RNA VHC|VHC RNA)\b[^\n]{0,30}\b(?:reaktif|reactive|positif|positive|\+|detected|terdeteksi|\d)/i },
  tanda_kardinal_kusta: { nama: 'Tanda kardinal kusta (lesi mati rasa, penebalan saraf dengan gangguan fungsi, atau BTA kerokan kulit)', ragu: false,
    pola: [/\b(?:hipopigmentasi|eritema|bercak|makula|lesi)\b[^\n]{0,40}\b(?:mati rasa|anestesi|hipoestesi|baal)\b/i, /\bpenebalan (?:saraf|n\.)/i,
      /\b(?:BTA|slit skin smear|kerokan (?:jaringan )?kulit)\b[^\n]{0,30}\b(?:positif|\+|[1-6]\+)/i] },
  serologi_sifilis: { tolak: NEG_HASIL, nama: 'Tes serologi sifilis (RPR/VDRL dan TPHA/TPPA/tes treponema) reaktif', ragu: false,
    pola: /\b(?:RPR|VDRL|TPHA|TPPA|treponem\w*|syphilis|sifilis|TP rapid)\b[^\n]{0,30}\b(?:reaktif|reactive|positif|positive|\+|1\s*:\s*\d+)/i },
  // --- Kardiovaskular ---
  td_hipertensi: { nama: 'Tekanan darah >=140/90 mmHg tercatat', nilai: ctx => {
    const rows = bacaPola(ctx.klinis, /\b(?:TD|T\.D|tekanan darah|tensi|BP)?\s*[:=]?\s*(\d{2,3})\s*\/\s*\d{2,3}\s*(?:mm\s*Hg)?/i, (v, m) => v >= 60 && v <= 300 && /mm\s*Hg|\bTD\b|tekanan darah|tensi|\bBP\b/i.test(m[0]))
      .map(r => ({ ...r, dia: Number(/\/\s*(\d{2,3})/.exec(r.m[0])[1]) }));
    const kena = rows.filter(r => r.nilai >= 140 || r.dia >= 90);
    return { status: kena.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', angka: true, nilai_terbaca: rows.length > 0,
      bukti: (kena.length ? kena : rows).slice(0, 4).map(({ m, ...r }) => ({ page_number: r.page_number, kutipan: r.kutipan, nilai: `${r.nilai}/${r.dia}` })),
      catatan: kena.length ? undefined : rows.length ? `${rows.length} pengukuran TD terbaca, semua <140/90.` : 'Tekanan darah belum terbaca.' };
  } },
  terapi_antihipertensi: { nama: 'Riwayat hipertensi atau obat antihipertensi', ragu: false, terapi: true,
    pola: [/\b(?:riwayat (?:HT|hipertensi|darah tinggi)|HT sejak|hipertensi sejak)\b/i,
      /\b(?:amlodipin\w*|nifedipin\w*|candesartan|valsartan|irbesartan|telmisartan|losartan|captopril|kaptopril|lisinopril|ramipril|bisoprolol|metoprolol|propranolol|HCT|hidroklorotiazid|spironolakton|metildopa|methyldopa|labetalol|clonidin\w*|diltiazem)\b/i] },
  mgso4_hdk: { nama: 'Tatalaksana hipertensi kehamilan (MgSO4/antihipertensi)', terapi: true, pola: /\b(?:MgSO4|magnesium sulfat|nifedipin\w*|metildopa|methyldopa|labetalol)\b/i },
  nyeri_dada_angina: { nama: 'Angina tipikal/atipikal (substernal, dipicu aktivitas/stres, hilang dengan istirahat/nitrat)',
    pola: /\b(?:nyeri dada|chest pain|angina)\b[^\n]{0,80}\b(?:aktivitas|beraktivitas|stres|istirahat|nitrat|ISDN|NTG|menjalar|substernal|tertekan|(?:ter|di)?tindih\w*|ditekan|diremas|tembus ke punggung)\b/i },
  ekg_iskemia: { nama: 'EKG/uji latih iskemia (depresi/elevasi segmen ST, T inversi)', pola: [/\b(?:EKG|ECG|treadmill|TMT)\b[^\n]{0,80}\b(?:ST depresi|depresi ST|ST elevasi|elevasi ST|T inversi|inversi T|iskemi\w*|positif)\b/i,
    /\b(?:ST[- ]T (?:abnormal\w*|changes?)|ST (?:depression|elevation)|T[- ]wave inversion|(?:myocardial|anterior|inferior|lateral|septal) ischemia)\b/i] },
  // --- Endokrin, gizi, ginjal, saluran cerna, tulang ---
  tsh_tinggi: { nama: 'TSH tinggi (di atas nilai rujukan) dengan FT4/T4 rendah', nilai: ctx => {
    const rows = bacaPola(ctx.klinis, /\bTSH(?:s)?\b[^\n\d]{0,15}(\d{1,3}(?:[.,]\d+)?)/i).map(r => {
      const rj = /(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)/.exec(r.kutipan.slice(r.kutipan.indexOf(r.m[1]) + r.m[1].length));
      return { ...r, batas: rj ? Number(rj[2].replace(',', '.')) : 4.5 };
    });
    return { ...hasilAngka(rows, (v, r) => v > r.batas, 'TSH', 'Hasil TSH belum terbaca.'), angka: true };
  } },
  terapi_hipotiroid: { nama: 'Riwayat hipotiroid atau terapi levotiroksin', ragu: false, terapi: true, pola: /\b(?:levotiroksin|levothyroxin\w*|euthyrox|thyrax|riwayat hipotiroid)\b/i },
  imt_25: { nama: 'IMT >25 kg/m2', nilai: ctx => ({ ...hasilAngka(bacaImt(ctx.klinis), v => v > 25, 'IMT', 'IMT atau BB/TB belum terbaca.'), angka: true }) },
  imt_185: { nama: 'IMT <18,5 kg/m2', nilai: ctx => ({ ...hasilAngka(bacaImt(ctx.klinis), v => v < 18.5, 'IMT', 'IMT atau BB/TB belum terbaca.'), angka: true }) },
  bb_turun: { nama: 'Penurunan berat badan tidak disengaja tertulis', pola: /\b(?:(?:berat badan|BB)\s+(?:turun|menurun|berkurang)|penurunan (?:berat badan|BB))\b[^\n]{0,30}(?:\d+\s*(?:kg|%)|bulan|drastis)?/i },
  albumin_30: { nama: 'Hipoalbuminemia (albumin <3,0 g/dL)', nilai: ctx => ({ ...ambangLab(ctx, 'albumin', v => v < 3.0, 'albumin'), angka: true }) },
  bukti_pgk: { nama: 'Kelainan ginjal >=3 bulan atau eGFR <60 (riwayat CKD/HD rutin)', ragu: false,
    pola: [/\b(?:e?GFR|LFG)\s*[:=]?\s*(?:[1-5]?\d)(?:[.,]\d+)?\b/i, /\b(?:CKD|PGK|gagal ginjal kronik|chronic kidney)\b[^\n]{0,20}\b(?:stage|st\.?|stadium|G)\s*(?:[3-5]|V|IV|III)/i,
      /\b(?:HD rutin|hemodialisis rutin|cuci darah rutin|riwayat (?:CKD|HD|hemodialisis))\b/i] },
  hematemesis_melena: { nama: 'Hematemesis dan/atau melena tertulis', pola: /\b(?:hematemesis|muntah darah|muntah (?:hitam|coklat|seperti kopi)|melena|BAB (?:hitam|seperti aspal|darah))\b/i },
  imaging_batu: { nama: 'Batu terlihat pada pencitraan (USG/BNO/CT/IVP)', ragu: false,
    pola: /\b(?:USG|BNO|IVP|CT|MSCT|foto polos|KUB)\b[^\n]{0,100}\b(?:batu|stone|lith\w*|kalkulus|calculus|opak)\b|\b(?:nefrolitiasis|ureterolitiasis|vesikolitiasis|urolitiasis|nephrolithiasis|ureterolithiasis)\b/i },
  tscore_osteoporosis: { nama: 'BMD T-score <=-2,5 (atau Z-score <=-2) atau fraktur kerapuhan', nilai: ctx => {
    const rows = bacaPola(ctx.klinis, /\b(?:T|Z)[- ]?score\s*[:=]?\s*(-\s*\d(?:[.,]\d+)?)/i).map(r => ({ ...r, nilai: Number(r.m[1].replace(/\s/g, '').replace(',', '.')), z: /^Z/i.test(r.m[0]) }));
    return { ...hasilAngka(rows, (v, r) => r.z ? v <= -2 : v <= -2.5, 'BMD', 'Hasil BMD DXA (T-score) belum terbaca.'), angka: true };
  } },
  // --- Hematologi, trauma, mata, gizi anak ---
  faktor_pembekuan: { nama: 'Aktivitas faktor VIII/IX terukur atau riwayat hemofilia dengan konsentrat faktor', ragu: false,
    pola: [/\b(?:F\s?VIII|F\s?IX|faktor\s*(?:VIII|8|IX|9)|factor\s*(?:VIII|IX))\b[^\n]{0,30}\d/i, /\b(?:riwayat hemofilia|hemofilia [AB]\b|koate|konsentrat faktor|emicizumab)\b/i] },
  // Label diagnosis (CKR/COT/"cedera kepala") bukan bukti: yang dicari mekanisme trauma pada kepala dan tanda klinisnya.
  mekanisme_trauma_kepala: { nama: 'Riwayat trauma (ruda paksa) pada kepala', ragu: false,
    pola: /\b(?:jatuh|terjatuh|KLL|kecelakaan|terbentur|benturan|dipukul|ditabrak|tertimpa|terpeleset|dianiaya|kepala (?:terbentur|terkena|membentur)|trauma (?:tumpul )?(?:pada |di )?kepala)\b/i },
  tanda_cot: { nama: 'Tanda COT: jejas kepala, penurunan kesadaran/pingsan, nyeri kepala, muntah, kejang, atau defisit neurologis', ragu: false,
    pola: /\b(?:jejas|vulnus|VL|VE|luka (?:robek|lecet)|hematom\w*|cephal\s*hematom\w*|pingsan|tidak sadar|penurunan kesadaran|amnesia|lupa kejadian|nyeri kepala|sakit kepala|pusing|muntah|kejang|lateralisasi|hemiparesis|anisokor|otorea|rinorea|brill hematom\w*|battle sign|racoon)\b/i },
  visus_612: { nama: 'Tajam penglihatan <6/12 (indikasi operasi katarak)', nilai: ctx => {
    const rows = [];
    for (const p of ctx.klinis) for (const l of teks(p).split(/\r?\n/)) {
      if (!/\b(?:visus|VOD|VOS|VA|tajam penglihatan|BCVA|UCVA)\b/i.test(l)) continue;
      for (const m of l.matchAll(/(\d{1,2})\s*\/\s*(\d{1,3}|~|∞)|\b(1\s*\/\s*~|LP|HM|1\/300|1\/60|0[.,]\d{1,2}|1[.,]0)\b/gi)) {
        let v = null;
        if (m[1] && m[2]) v = /~|∞/.test(m[2]) ? 0.001 : Number(m[1]) / Number(m[2]);
        else if (m[3]) v = /LP|HM|~/.test(m[3]) ? 0.001 : m[3].includes('/') ? Number(m[3].split('/')[0]) / Number(m[3].split('/')[1]) : Number(m[3].replace(',', '.'));
        if (v !== null && v > 0 && v <= 2) rows.push({ nilai: Math.round(v * 1000) / 1000, page_number: p.page_number || null, kutipan: l.trim().slice(0, 200) });
      }
    }
    return { ...hasilAngka(rows, v => v < 0.5, 'Tajam penglihatan', 'Tajam penglihatan (visus) belum terbaca.'), angka: true };
  } },
  tio_glaukoma: { nama: 'Pemeriksaan TIO/gonioskopi/papil (CDR) tercatat', ragu: false,
    pola: /\b(?:TIO|IOP|tekanan intra\s*okular|tonometri\w*|gonioskopi|CDR|cup disc)\b[^\n]{0,30}(?:\d|sempit|tertutup|terbuka|glaukomatosa)/i },
  fundus_retinopati: { nama: 'Temuan fundus retinopati diabetik (mikroaneurisma, perdarahan, eksudat, neovaskularisasi, edema makula)', ragu: false,
    pola: /\b(?:funduskopi|fundus|slit lamp|OCT|foto fundus)\b[^\n]{0,80}\b(?:mikroaneurisma|microaneurysm|perdarahan|eksudat|exudate|neovaskular\w*|NPDR|PDR|edema makula|DME|CSME|cotton wool)\b|\b(?:NPDR|PDR|CSME)\b/i },
  tbu_minus2: { nama: 'Panjang/tinggi badan menurut usia < -2 SD (kurva WHO)', ragu: false,
    pola: /\b(?:TB\/U|PB\/U|HAZ|z[- ]?score\s*(?:TB|PB)\/U|tinggi badan menurut umur)\b[^\n]{0,20}(?:<\s*-?\s*[23]\s*SD|-\s*[2-5](?:[.,]\d+)?)|\b(?:stunted|severely stunted|perawakan pendek)\b/i },
  tbsa_luka_bakar: { nama: 'Luas (% TBSA) dan derajat luka bakar tercatat sesuai kode T31', nilai: ctx => {
    const luas = bacaPola(ctx.klinis, /\b(?:luas(?:\s*luka\s*bakar)?|TBSA|BSA|LLB)\b[^\n\d]{0,15}(\d{1,3}(?:[.,]\d+)?)\s*%/i, v => v > 0 && v <= 100)
      .concat(bacaPola(ctx.klinis, /(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:TBSA|BSA|luas)/i, v => v > 0 && v <= 100));
    const derajat = cari({ pola: /\b(?:derajat|grade|gr\.?)\s*(?:I{1,3}|[1-3])\s*[AB]?\b|\b(?:superficial|partial|full) thickness\b/i, ragu: false }, ctx.klinis);
    const t31 = ctx.dx.find(k => /^T31\.\d/.test(k));
    const bukti = [...luas.slice(0, 2).map(({ m, ...r }) => r), ...derajat.slice(0, 1)];
    if (!luas.length || !derajat.length) return { status: 'bukti_belum_cukup', bukti, catatan: `${!luas.length ? 'Luas luka bakar (% TBSA) belum tercatat' : ''}${!luas.length && !derajat.length ? '; ' : ''}${!derajat.length ? 'derajat luka bakar belum tercatat' : ''}.` };
    if (t31) {
      const harap = Math.min(9, Math.floor(luas[0].nilai / 10));
      if (Number(t31[4]) !== harap) return { status: 'bukti_belum_cukup', angka: true, nilai_terbaca: true, bukti, catatan: `Luas ${luas[0].nilai}% sesuai T31.${harap}, sedangkan diklaim ${t31}.` };
    }
    return { status: 'bukti_ditemukan', bukti, angka: !!t31, nilai_terbaca: true };
  } },
  // --- THT, ortopedi, bedah anak, hepatologi ---
  gejala_rsk_12_minggu: { nama: 'Gejala rinosinusitis (hidung tersumbat/beringus + nyeri wajah/gangguan penghidu) ≥12 minggu', nilai: ctx => {
    const GEJALA = /\b(?:hidung (?:tersumbat|buntu|mampet)|kongesti|pilek|beringus|ingus|rinore\w*|post ?nasal drip|lendir (?:di )?tenggorok|nyeri wajah|rasa tertekan|hiposmia|anosmia|penciuman)\b/i;
    const bukti = [];
    for (const p of ctx.klinis) for (const l of teks(p).split(/\r?\n/)) {
      if (!GEJALA.test(l)) continue;
      for (const m of l.matchAll(/(\d{1,2}|se|satu|dua|tiga|enam)\s*(minggu|bulan|bln|tahun|thn)\b/gi)) {
        const n = { se: 1, satu: 1, dua: 2, tiga: 3, enam: 6 }[m[1].toLowerCase()] ?? Number(m[1]);
        const minggu = /minggu/i.test(m[2]) ? n : /bul|bln/i.test(m[2]) ? n * 4.3 : n * 52;
        if (minggu >= 12) bukti.push({ page_number: p.page_number || null, kutipan: l.trim().slice(0, 200) });
      }
    }
    return bukti.length ? { status: 'bukti_ditemukan', bukti: bukti.slice(0, 2) }
      : { status: 'bukti_belum_cukup', bukti: [], catatan: 'Gejala hidung/sinus dengan lama keluhan ≥12 minggu belum tercatat.' };
  } },
  perforasi_mt: { nama: 'Perforasi membran timpani tercatat pada pemeriksaan telinga', ragu: false,
    pola: /\bperforasi\b[^\n]{0,40}\b(?:membran timpani|MT|sentral|marginal|atik|subtotal|total|attic)\b|\b(?:MT|membran timpani)\b[^\n]{0,30}\bperforasi\b|\bkolesteatoma\b/i },
  indikasi_tonsilektomi: { nama: 'Indikasi tonsilektomi tercatat (frekuensi episode, obstruksi/OSAS, hipertrofi T3-T4, abses peritonsil, disfagia)', ragu: false,
    pola: /\b\d+\s*(?:x|kali)\s*(?:\/|per|dalam|dlm|setahun|sebulan)\s*(?:1\s*)?(?:tahun|thn|bulan|bln)?|\b(?:kambuh|berulang|rekuren)\b[^\n]{0,40}\b(?:\d+|sering)\b|\b(?:OSA|OSAS|ngorok|mendengkur|snoring|henti napas saat tidur|abses peritonsil\w*|disfagia|sulit menelan)\b|\bT\s?[34]\s*[-\/]\s*T\s?[34]\b|\bhipertrofi tonsil\b/i },
  cobb_10: { nama: 'Sudut Cobb ≥10°', nilai: ctx => ({ ...hasilAngka(bacaPola(ctx.klinis, /\bcobb\b[^\n\d]{0,25}(\d{1,3})/i, v => v > 0 && v < 180), v => v >= 10, 'Sudut Cobb', 'Sudut Cobb belum tercatat.'), angka: true }) },
  konfirmasi_hirschsprung: { nama: 'Konfirmasi Hirschsprung: biopsi rektum aganglionosis atau zona transisi pada barium enema', ragu: false, tanpa_negasi: true,
    pola: /\baganglion\w*|\b(?:tidak (?:ditemukan|dijumpai|tampak|didapatkan)|tanpa)\s+sel ganglion|\bsel ganglion\s*(?:\(-\)|negatif|tidak ada)|\b(?:zona transisi|transition zone|rektosigmoid index\s*<\s*1)\b(?![^\n]{0,15}tidak)/i },
  imaging_sirosis: { nama: 'Penunjang sirosis: USG/CT/MRI (permukaan nodular, ekogenisitas kasar, splenomegali, asites), elastografi F4, biopsi, atau varises', ragu: false,
    pola: [/\b(?:USG|CT|MSCT|MRI|fibroscan|elastograf\w*|kesan|impresi|biopsi hati)\b[^\n]{0,120}\b(?:sirosis|cirrhosis|nodular|ireguler|irregular|ekogenisitas\s*(?:kasar|meningkat|heterogen)|coarse|splenomegal\w*|hipertensi porta\w*|F\s?4\b)/i,
      /\b(?:varises|varices)\s*(?:esofag\w*|gaster|oesophag\w*)/i] },
  radiologi_fraktur: { nama: 'Foto/CT memperlihatkan fraktur (garis fraktur/diskontinuitas)', ragu: false,
    pola: /\b(?:rontgen|ro\.?|foto|x-?ray|radiologi|CT|MSCT|kesan|impresi|expertise|ekspertise)\b[^\n]{0,120}\b(?:fraktur\w*|fracture|frx|fr\.|diskontinuitas|garis fraktur|patah)\b/i },
  radiologi_oa: { nama: 'Radiologi OA (osteofit, penyempitan celah sendi, sklerosis subkondral, Kellgren-Lawrence)', ragu: false,
    pola: [/\b(?:osteofit\w*|osteophyte\w*|penyempitan (?:celah|ruang) sendi|joint space narrowing|sklerosis subkondral|subchondral sclerosis|kellgren|KL\s*(?:grade|gr\.?)?\s*[1-4I])\b/i,
      /\b(?:rontgen|foto|x-?ray|radiologi|kesan|impresi|ekspertise|expertise)\b[^\n]{0,80}\b(?:osteoart(?:ritis|hrosis)|OA)\b/i] },
  krepitasi_sendi: { nama: 'Krepitasi/kaku sendi <30 menit (kriteria klinis ACR)', ragu: false,
    pola: /\b(?:krepitasi|crepitus|kaku (?:sendi )?(?:pagi )?(?:<|kurang dari)\s*30\s*menit)\b/i },
  tes_kognitif: { nama: 'Uji kognitif tercatat (MMSE/MoCA/AD8/CDR)', ragu: false,
    pola: /\b(?:MMSE|MoCA|AD8|CDR|mini[- ]mental\w*|clock drawing)\b[^\n]{0,25}\d/i },
  audiologi_tuli: { nama: 'Pemeriksaan audiologi tercatat (OAE/BERA/ABR/ASSR/audiometri dengan ambang dB)', ragu: false,
    pola: /\b(?:OAE|BERA|ABR|ASSR|audiometri\w*|audiogram)\b|\b\d{2,3}\s*dB\b/i },
  koreksi_elektrolit: { nama: 'Tatalaksana/koreksi elektrolit diberikan', terapi: true,
    pola: /\b(?:koreksi (?:Na|K|natrium|kalium|elektrolit)|KCl|KSR|aspar[- ]?K|NaCl\s*3\s*%|drip KCl)\b/i },
  // BA 2019 aspek medis 64-66 dan BA koding 2023 (415/BA/0623) no. 34.
  hasil_echo: { nama: 'Hasil ekokardiografi (maksimal 1 tahun)', ragu: false, nilai: ctx => {
    const t = cari({ pola: [/\b(?:ekokardiografi|echocardiograph\w*|echo\s*(?:jantung|cardiography)|TTE|TEE)\b[^\n]{0,80}\b(?:EF|LVEF|kesan|kesimpulan|fungsi sistolik|dilatasi|hipertrofi|normal|regurgitasi|stenosis)\b/i,
      /\b(?:LV\s*)?EF\b\s*(?:[:=]|sebesar)?\s*\d{1,2}(?:[.,]\d+)?\s*%/i], ragu: false }, ctx.klinis);
    return { status: t.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: t,
      catatan: t.length ? 'Pastikan tanggal ekokardiografi tidak lebih dari 1 tahun; pengulangan <1 tahun memerlukan indikasi (perburukan sesak, pasca operasi/PTCA).' : 'Hasil ekokardiografi belum terbaca (hasil sebelumnya <=1 tahun dapat dipakai).' };
  } },
  hasil_spirometri: { nama: 'Hasil spirometri (saat penegakan atau riwayat)', ragu: false, pola: /\b(?:spirometri\w*|spirometry|FEV1|VEP1|FEV1\s*\/\s*FVC|KVP|FVC)\b/i },
  indikasi_intravitreal: { nama: 'Indikasi injeksi intravitreal (AMD basah, retinopati DM, CRVO/BRVO, CNV, uveitis posterior, endoftalmitis, CME, ROP)',
    dx: /^(?:H35\.[13]|H36\.0|E1[0-4]\.3|H34\.[128]|H30|H44\.[01]|H31\.4)/,
    pola: /\b(?:AMD|age[- ]related macular|degenerasi makula|retinopati diabet\w*|retinopathy diabet\w*|CRVO|BRVO|oklusi vena retina|CNV|neovaskular\w* koroid|uveitis posterior|endoftalmitis|endophthalmitis|CME|cystoid macular|edema makula|ROP|retinopathy of prematurity)\b/i },
  apgar_berat: { nama: 'Skor Apgar menit pertama 0-3 (asfiksia berat P21.0)', nilai: ctx => {
    const rows = [...bacaPola(ctx.klinis, /\b(?:apgar(?:\s*score)?|A\s*\/\s*S|AS)\b\s*[:=]?\s*(\d{1,2})\s*[\/\-,]\s*\d{1,2}/i, v => v <= 10),
      ...bacaPola(ctx.klinis, /\bapgar\b[^\n]{0,20}?\b1\s*(?:'|menit|mnt)\s*[:=]?\s*(\d{1,2})\b/i, v => v <= 10)];
    return { ...hasilAngka(rows, v => v <= 3, 'Skor Apgar menit pertama', 'Skor Apgar belum terbaca.'), angka: true };
  } },
  edukasi_oat: { nama: 'Edukasi minum obat', pola: /\bedukasi\b[^\n]{0,40}\b(?:minum obat|OAT|kepatuhan|teratur)\b/i },
  px_hemoroid: { nama: 'Hemoroid memerlukan tindakan intervensi', px: /^49\.4/ },
  // Grade sering ditulis dokter bedah pada SPRI ("Hemoroid interna grade 2-3"); rentang memakai batas atas.
  hemoroid_grade4: { nama: 'Hemoroid interna grade IV', termasuk_spri: true, pola: new RegExp(`${HEMOROID}[^\\n]{0,40}${GRADE}(?:(?:I{1,3}|[1-3])\\s*[-–/]\\s*)?(?:IV|4)\\b`, 'i') },
  hemoroid_grade34: { nama: 'Hemoroid grade III-IV', termasuk_spri: true, pola: new RegExp(`${HEMOROID}[^\\n]{0,40}${GRADE}(?:(?:I{1,2}|[12])\\s*[-–/]\\s*)?(?:III|IV|3|4)\\b`, 'i') },
  hemoroid_grade2: { nama: 'Hemoroid grade II', termasuk_spri: true, pola: new RegExp(`${HEMOROID}[^\\n]{0,40}${GRADE}(?:I\\s*[-–/]\\s*|1\\s*[-–/]\\s*)?(?:II|2)\\b(?!\\s*[-–/])`, 'i') },
  hemoroid_penyulit: { nama: 'Perdarahan akut/kronis dengan anemia atau trombosis', termasuk_spri: true,
    pola: [new RegExp(`${HEMOROID}[^\\n]{0,40}\\b(?:perdarahan|berdarah|trombos\\w*)`, 'i'), /\b(?:BAB (?:berdarah|darah)|hematok[ec]zia|perdarahan per ?anal|trombosis hemoroid)\b/i] },
  hemoroid_ri_lain: { nama: 'Fibrosis/striktur, fistula/fisura, atau interna+eksterna dengan nyeri >5', pola: /\b(?:fibrosis|striktur|fistula|fisura|fissura|trombos\w*)\b/i },
  perforasi_peritonitis: { nama: 'Perforasi dengan peritonitis', pola: /\b(?:perforasi|perforated|peritonitis|pus|purulen)\b/i },
});

function konteks(record, pages, { dx = [], px = [], usia, jenis } = {}) {
  const semua = (Array.isArray(pages) ? pages : []).filter(p => p && teks(p).trim() && !isLembarGrouper(teks(p)))
    .map(p => ({ ...p, jenis: p.jenis || classifyPageDocumentType(teks(p)) }));
  const klinis = semua.filter(p => !['rincian_biaya', 'resep', 'sep', 'spri'].includes(p.jenis));
  let lab = null;
  return { record, dx, px, usia, jenis, semua, klinis, terapi: semua.filter(p => p.jenis !== 'sep'),
    klinisSpri: semua.filter(p => !['rincian_biaya', 'resep', 'sep'].includes(p.jenis)),
    lab: () => (lab ??= bacaLabDariHalaman(klinis).baris.filter(b => b.dapat_dipakai_memutuskan_syarat)) };
}

/** null bila butir tidak relevan pada klaim ini (mis. tidak ada konflik koding). */
function nilaiButir(a, ctx) {
  if (a.pemeriksa_ba) {
    const r = KHUSUS[a.pemeriksa_ba](a, ctx);
    if (r && r.status !== 'perlu_cek_manual' && !ctx.klinis.length && a.pemeriksa_ba !== 'kejang' && a.pemeriksa_ba !== 'laparotomi' && a.pemeriksa_ba !== 'i12_ggk')
      return { ...r, status: 'belum_dapat_dinilai', menilai: false };
    return r;
  }
  if (a.syarat === 'informasi' || !a.kriteria?.length) return { status: 'perlu_cek_manual', bukti: [], menilai: false };
  if (!ctx.klinis.length) return { status: 'belum_dapat_dinilai', bukti: [], menilai: false };
  const n = nilaiKriteria(a, ctx);
  // Temuan pendukung (tidak menentukan status) ikut ditampilkan agar alasan menyebut bukti yang ada.
  const info = (a.bukti_info || []).map(k => periksa(k, ctx)).filter(b => b.status === 'bukti_ditemukan').map(b => ({ ...b, info: true }));
  return info.length ? { ...n, bukti: [...n.bukti, ...info] } : n;
}

// Butir BA dan kriteria PNPK yang dinilai dari berkas (id BA-xx-* / PNPK-*).
const BUTIR_BA = /^(?:BA-\d{2}|PNPK)-/;
const labelBa = t => `${t.sumber?.jenis === 'pedoman_klinis' ? 'PNPK' : 'BA'} ${(String(t.sumber?.versi || t.sumber?.id).match(/20\d\d/) || [''])[0]}`.trim();
const RINGKAS_BA = t => ({ id: t.id, nama: t.nama, status: t.status, butir: t.sumber.butir, halaman: t.sumber.halaman, catatan: t.catatan,
  sumber: { id: t.sumber.id, judul: t.sumber.judul, nomor: t.sumber.nomor, jenis: t.sumber.jenis, versi: t.sumber.versi }, label_sumber: labelBa(t),
  bukti: t.bukti, menilai_putusan: t.menilai_putusan === true, kontradiksi_angka: t.kontradiksi_angka === true, gabung_ke: t.gabung_ke || [],
  ...(t.ringkas_telaah ? { ringkas_telaah: t.ringkas_telaah } : {}) });

/**
 * Temuan BA 2018 yang topiknya sudah dinilai aturan lain ditempel ke kartu
 * aturan itu: satu kartu per topik, rujukan BA tetap terlihat (keterbatasan +
 * bukti berlabel BA 2018) dan tersimpan di `rujukan_ba_2018` untuk putusan.
 */
function gabungkanTumpang(temuan) {
  const keluar = new Set();
  const hasilGabung = temuan.map(t => ({ ...t }));
  for (const ba of hasilGabung) {
    if (!BUTIR_BA.test(String(ba.id)) || !ba.gabung_ke?.length) continue;
    const target = ba.gabung_ke.map(id => hasilGabung.find(x => x.id === id && !keluar.has(x))).find(Boolean);
    if (!target) continue;
    target.rujukan_ba_2018 = [...(target.rujukan_ba_2018 || []), RINGKAS_BA(ba)];
    target.bukti = [...(target.bukti || []), ...(ba.bukti || []).map(b => ({ ...b, id: `${ba.id}:${b.id}`, nama: `${labelBa(ba)} ${ba.sumber.butir}: ${b.nama}` }))];
    target.keterbatasan = [...(target.keterbatasan || []),
      `Rujukan ${labelBa(ba)} (${ba.sumber.nomor}), ${ba.sumber.butir}, hal. ${ba.sumber.halaman}: ${ba.catatan}`];
    keluar.add(ba);
  }
  return hasilGabung.filter(t => !keluar.has(t));
}

module.exports = { DETEKTOR, KHUSUS, periksa, nilaiButir, konteks, gabungkanTumpang, cari, BUTIR_BA, labelBa };
