// Dokumen pengguna adalah data rujukan. Tidak memberi wewenang mengganti kode
// atau menetapkan ketentuan BPJS nasional; setiap butir tetap berjejak sumber.
const katalog = require('../data/bpjsDoDont.json');
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { isLembarGrouper } = require('./lembarGrouperService');
const BOBOT = { tinggi: 25, sedang: 12, rendah: 5 };
const isi = p => String(p?.ocr_text || p?.text || '');
const kode = v => (Array.isArray(v) ? v : String(v || '').split(/[;,]/))
  .map(k => String(k).trim().toUpperCase()).filter(k => /^[A-Z]\d{2}(?:\.\d{1,2})?$/.test(k));
const cocok = (k,p) => k === p || k.startsWith(p + '.');

function cakupan(record, options) {
  const konteks = require('./konteksPenggunaanAiService').saatIni();
  // Profil yang diberikan pemanggil menjadi otoritas RS, termasuk saat kosong.
  const rs = options.profil ? options.profil.hospital_code
    : record.hospital_code || record.KODE_RS || konteks.hospital_code;
  return katalog.hospital_codes.includes(String(rs || ''));
}

function halamanHasil(pages) {
  return (Array.isArray(pages) ? pages : []).filter(p => p && !isLembarGrouper(isi(p)))
    .map(p => ({...p, jenis: classifyPageDocumentType(isi(p))}))
    .filter(p => p.jenis === 'lab_results');
}

/** Baca hasil setelah label leukosit; angka nilai rujukan tidak ikut terbaca.
 * Dipstick, darah dan satuan LPB/HPF dipertahankan, tidak dikonversi ke /uL. */
function bacaLeukositUrine(pages) {
  const hasil = [];
  for (const p of halamanHasil(pages)) {
    let urine = false;
    for (const baris of isi(p).split(/\r?\n/)) {
      if (/\b(?:urine?\s+(?:rutin|lengkap)|urinalisis|urinalysis|pemeriksaan\s+urine?)\b/i.test(baris)) urine = true;
      if (/\b(?:darah\s+rutin|hematologi|kimia\s+darah|complete\s+blood|full\s+blood)\b/i.test(baris)) urine = false;
      if (!urine && !/\b(?:leukosit|lekosit)\s+urine?\b/i.test(baris)) continue;
      if (/\b(?:rencana|belum|menunggu|tidak\s+dilakukan)\b/i.test(baris)) continue;
      const label = /^\s*(?:leukosit|lekosit|leucocytes?|leukocytes?|wbc)(?:\s+(?:urine?|esterase))?\s*[:=]?\s*(.*)/i.exec(baris);
      if (!label) continue;
      const raw = label[1];
      const n = /^([<>]=?|[≤≥])?\s*(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?(?=\s|$)/.exec(raw);
      const q = /^(?:\+[1-4]?|[1-4]\+|positif|positive|negatif|negative)\b/i.exec(raw)
        || /^(?:\+[1-4]?|[1-4]\+)(?=\s|$)/.exec(raw);
      if (!n && !q) continue;
      const unit = /(?:leu|wbc|cells?|sel)?\s*\/\s*([uµμ]l|lpb|hpf)\b/i.exec(baris);
      const satuan = unit ? (/^[uµμ]l$/i.test(unit[1]) ? 'Leu/uL' : unit[1].toUpperCase()) : null;
      const min = n ? Number(n[2].replace(',','.')) : null;
      const maks = n ? Number((n[3] || n[2]).replace(',','.')) : null;
      hasil.push({ page_number: Number(p.page_number) || null, kutipan: baris.trim(),
        metode: n ? 'numerik' : 'semikuantitatif', satuan, min, maks,
        operator: n?.[1] || null, nilai_tertulis: n ? n[0].trim() : q[0],
        rentang_sah: n ? min <= maks : true });
    }
  }
  return hasil;
}

function bandingkanAmbang(h) {
  if (h.metode !== 'numerik' || h.satuan !== 'Leu/uL' || !h.rentang_sah) return null;
  if (!h.operator) return h.min > 10 ? true : h.maks <= 10 ? false : null;
  if (h.operator === '>') return h.min >= 10 ? true : null;
  if (['>=','≥'].includes(h.operator)) return h.min > 10 ? true : null;
  if (['<','<=','≤'].includes(h.operator)) return h.maks <= 10 ? false : null;
  return null;
}

function nilaiLeukositUrine(pages) {
  const hasil = bacaLeukositUrine(pages);
  const angka = hasil.filter(h => h.metode === 'numerik');
  const dibandingkan = angka.map(bandingkanAmbang);
  let status = 'perlu_cek_manual';
  if (!hasil.length) status = 'bukti_belum_cukup';
  else if (dibandingkan.length && dibandingkan.every(x => x === true)) status = 'ambang_terpenuhi';
  else if (dibandingkan.length && dibandingkan.every(x => x === false)) status = 'ambang_tidak_terpenuhi';
  const catatan = status === 'ambang_tidak_terpenuhi'
    ? 'Leukosit urine numerik yang terbaca tidak melebihi 10 Leu/uL pada butir 13. Telaah syarat klaim bersama casemix; temuan ini tidak membatalkan diagnosis ISK.'
    : status === 'ambang_terpenuhi'
      ? 'Nilai numerik melebihi 10 Leu/uL pada catatan; ini tidak memastikan diagnosis atau kelulusan klaim.'
      : 'Ambang >10 Leu/uL belum dapat dipastikan. Dipstick +1, LPB/HPF, satuan tidak jelas, rentang melintasi ambang atau hasil berbeda perlu ditelaah tanpa konversi otomatis.';
  return {id:'leukosit_urine',nama:'Leukosit urine numerik lebih dari 10 Leu/uL',status,catatan,
    bukti:hasil.slice(0,8), hasil_terbaca:hasil.length > 0};
}

function evaluasiCatatanDokumen(record = {}, pages = [], options = {}) {
  if (!cakupan(record,options)) return [];
  const dx = kode(options.dx ?? record.DIAGLIST ?? record.diagnosa_list);
  const hasil = [];
  for (const a of katalog.aturan) {
    const kena = a.pemicu_gejala_utama ? /^R\d/.test(dx[0] || '')
      : a.dx_semua.length && a.dx_semua.every(group => group.some(p => dx.some(k => cocok(k,p))));
    if (!kena) continue;
    if (a.id === 'BDD-08') continue; // Dibahas bersama BA/PNPK sesuai usia; hindari checklist pneumonia berulang.
    const bukti = a.pemeriksa === 'leukosit_urine' ? [nilaiLeukositUrine(pages)]
      : a.bukti.map(k => options.cariBukti ? options.cariBukti(pages,k)
        : {id:k,nama:k,status:'perlu_cek_manual',bukti:[]});
    const perluTelaah = a.pemeriksa === 'leukosit_urine' && bukti[0].status !== 'ambang_terpenuhi';
    hasil.push({id:a.id,nama:a.nama,kode_diagnosis:dx.filter(k => a.pemicu_gejala_utama ? k === dx[0] : a.dx_semua.some(g => g.some(p => cocok(k,p)))),
      kode_prosedur:[],jenis_ketentuan:'catatan_casemix',
      sumber:{...katalog.sumber,halaman:String(a.halaman),butir:a.butir,teks_asli:a.teks_asli},
      status:perluTelaah?'perlu_telaah_koding':'perlu_konfirmasi_ketentuan',bukti,
      catatan:a.catatan + (a.pemeriksa === 'leukosit_urine' ? ' ' + bukti[0].catatan : ''),
      keterbatasan:['Sumber berupa catatan pengguna; pengesah dan masa berlaku ketentuan belum tersedia. Telaah terhadap sumber resmi dan episode sebelum menetapkan kode.'],
      berlaku_pada_episode:null,blokir_submit:false,mengubah_kode:false,perlu_telaah_koding:perluTelaah});
  }
  return hasil;
}

function temuanKritisDokumen(record,pages,options = {}) {
  return evaluasiCatatanDokumen(record,pages,options).filter(t => t.perlu_telaah_koding)
    .map(t => ({id:t.id,jenis:'inkonsistensi',keparahan:'sedang',sumber:'aturan',
      sumber_dokumen:katalog.sumber.id,ketentuan_terverifikasi:false,
      pesan:`${t.nama}: ${t.bukti[0].catatan}`,
      saran:'Konfirmasi nilai, satuan, metode dan ketentuan bersama casemix/DPJP. Jangan mengganti N39.0 ke N39.8 atau N23 hanya dari catatan ini.',
      bukti:t.bukti[0].bukti.find(b => b.metode === 'numerik') || t.bukti[0].bukti[0] || null}));
}

/** Segarkan hasil lama tanpa AI/DB write, tanpa mengubah keberatan lain. */
function perbaruiKritikDokumen(lama,record,pages,options = {}) {
  if (!lama || !Array.isArray(lama.temuan) || typeof lama.skor_keyakinan !== 'number') return lama;
  const milik = t => t.sumber_dokumen === katalog.sumber.id;
  const dulu = lama.temuan.filter(milik), baru = temuanKritisDokumen(record,pages,options);
  if (!dulu.length && !baru.length) return lama;
  const temuan = [...lama.temuan.filter(t => !milik(t)),...baru];
  const bobot = list => list.reduce((n,t) => n + (BOBOT[t.keparahan] || 0),0);
  const dasar = lama.pembaruan_catatan_dokumen?.dasar || {
    skor_keyakinan: Math.min(100,lama.skor_keyakinan + bobot(dulu)), kesimpulan:lama.kesimpulan,
  };
  const skor = Math.max(0,Math.min(lama.ai_gagal ? 70 : 100,dasar.skor_keyakinan - bobot(baru)));
  return {...lama,temuan,skor_keyakinan:skor,tingkat:skor>=80?'tinggi':skor>=55?'sedang':'rendah',
    ringkas:{...lama.ringkas,total:temuan.length},
    kesimpulan:temuan.length ? `${temuan.length} hal perlu ditinjau koder sebelum unggah. Catatan dokumen dinilai ulang dari bukti tersimpan.`
      : 'Pemeriksaan yang dijalankan belum menemukan keberatan pada kode dan bukti yang terbaca.',
    perlu_analisis_mendalam:temuan.some(t => t.keparahan === 'tinggi'),
    pembaruan_catatan_dokumen:{versi:katalog.versi,sumber:katalog.sumber.id,tanpa_ai_ulang:true,dasar}};
}

module.exports = {katalog,bacaLeukositUrine,nilaiLeukositUrine,evaluasiCatatanDokumen,temuanKritisDokumen,perbaruiKritikDokumen};
