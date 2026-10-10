// Isi PDF adalah data sumber. Pembaca ini hanya menelaah dokumentasi,
// tidak mengeksekusi instruksi sumber atau mengganti kode/episode pasien.
const katalog = require('../data/baTkmkb2025.json');
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { isLembarGrouper } = require('./lembarGrouperService');
const isi = p => String(p?.ocr_text || p?.text || '');
const pecah = v => (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map(k=>String(k).trim().toUpperCase()).filter(Boolean);
const cocok = (k,p) => k === p || k.startsWith(p+'.');
const objek = v => { if(typeof v==='string'){try{return JSON.parse(v)||{};}catch{return {};}}return v||{}; };
const NEGASI = /\b(?:belum|rencana|direncanakan|akan|disarankan|tidak\s+(?:ada|dilakukan|diberikan|diperiksa|terpasang))\b/i;
const DET = {
  derajat_asma:['Derajat serangan dan respons terapi',/\b(?:asma\s+(?:akut|persisten|berat|sedang)|PEF\s*[:=]?\s*\d|FEV1\s*[:=]?\s*\d|silent chest)\b/i],
  terapi_asma:['Bukti bronkodilator dan kortikosteroid sistemik',/(?:diberikan|pemberian|terapi|nebulisasi).*\b(?:salbutamol|ipratropium|bronkodilator|kortikosteroid|metilprednisolon|dexamethasone|deksametason)\b/i],
  skor_pneumonia:['CURB-65 atau PSI dan dasar indikasi rawat',/\b(?:CURB[ -]?65|PSI)\s*(?:score|skor)?\s*[:=]?\s*\d/i],
  penilaian_gerd:['Gejala khas, GERD-Q/respons PPI atau hasil endoskopi',/\b(?:GERD[ -]?Q\s*[:=]?\s*\d|heartburn|regurgitasi|mucosal break|esofagitis|respons\s+PPI)\b/i],
  dehidrasi:['Derajat dehidrasi dan temuan klinis',/\b(?:dehidrasi\s+(?:sedang|berat|ringan)|turgor\s*[:=]?\s*(?:lambat|menurun|\d)|CRT\s*[:=<>]?\s*\d|diuresis\s*[:=]?\s*\d)/i],
  bilirubin:['Hasil bilirubin dengan metode, usia dan waktu',/\b(?:bilirubin|TcB|TSB)\b.*\d+(?:[.,]\d+)?\s*(?:mg\s*\/\s*d[lL]|[uµμ]mol\s*\/\s*[lL])/i,['lab_results'],true],
  evaluasi_fototerapi:['Indikasi, fototerapi dan evaluasi ulang',/\b(?:fototerapi|phototherapy)\b.*(?:dilakukan|diberikan|selesai|evaluasi|bilirubin|jam)|(?:dilakukan|diberikan).*\b(?:fototerapi|phototherapy)\b/i],
  apgar_serial:['Apgar dengan menit penilaian',/\bAPGAR\b.*(?:menit\s*(?:ke[ -]?)?\s*(?:5|10)|(?:5|10)\s*menit).*\d/i],
  resusitasi_neonatus:['Resusitasi/VTP dengan durasi dan respons',/\b(?:VTP|ventilasi tekanan positif|resusitasi)\b.*(?:dilakukan|diberikan|menit|respons|evaluasi)|(?:dilakukan|diberikan).*\b(?:VTP|resusitasi)\b/i],
  downe_cpap:['Downe, CPAP dan lembar observasi bila berindikasi',/\b(?:Downe|Downes)\s*(?:score|skor)?\s*[:=]?\s*\d|\bCPAP\b.*(?:terpasang|FiO2|PEEP|cmH2O)/i],
  glukosa_spesimen:['Hasil glukosa, spesimen dan waktu',/\b(?:glukosa|gula darah|GDS|GDA)\b.*\d+(?:[.,]\d+)?\s*mg\s*\/\s*d[lL]/i,['lab_results'],true],
  terapi_hipoglikemia:['Tata laksana khusus dan evaluasi hipoglikemia',/(?:diberikan|pemberian|koreksi|bolus|infus).*\b(?:dekstrosa|dextrose|D10|D40|glukosa)\b/i],
  skor_sepsis:['SOFA/PELOD-2 dengan angka pada resume',/\b(?:SOFA|PELOD[ -]?2)\s*(?:score|skor)?\s*[:=]?\s*\d/i,['resume_medis']],
  darah_serial:['Hematokrit/trombosit bertanggal untuk telaah serial',/\b(?:hematokrit|trombosit|platelet)\b\s*[:=]?\s*\d/i,['lab_results'],true],
  kebocoran_plasma:['Bukti kebocoran plasma dan perbandingan hematokrit',/\b(?:efusi pleura|asites|ascites|hipoalbuminemia|hipoproteinemia|hemokonsentrasi|kebocoran plasma|plasma leakage)\b/i],
  visus_grading:['Visus, dilatasi pupil dan grading',/\b(?:visus|VOD|VOS)\b.*(?:\d\s*\/\s*\d|LP|HM)|\b(?:grading|grade)\s*[:=]?\s*\d/i],
  indikasi_ventilator:['Indikasi ventilator dan kondisi klinis',/\b(?:gagal napas|gagal nafas|apnea|henti napas|henti nafas|distres napas|syok septik|asidosis berat)\b/i],
  monitoring_ventilator:['Mode ventilator, PEEP dan FiO2 serta monitoring',/\b(?:PEEP|SIMV|FiO2|mode ventilator)\b\s*[:=]?\s*\w/i],
  waktu_ventilator:['Waktu pemasangan dan pelepasan ventilator',/\b(?:intubasi|ekstubasi|ventilator\s+(?:mulai|berakhir)|pemasangan ventilator|pelepasan ventilator)\b.*\d{1,2}[:.]\d{2}/i],
  indikasi_pci:['Indikasi PCI, anatomi dan hasil pemeriksaan',/\b(?:stenosis|SYNTAX|FFR|iFR|QFR|LVEF)\b.*\d/i],
  strategi_pci:['Strategi PCI, alasan bertahap/conference bila kompleks',/\b(?:ad hoc|staged PCI|PCI bertahap|cardiac conference|heart team|revaskularisasi komplit)\b/i],
  indikasi_eswl:['Ukuran, lokasi dan densitas batu serta consent',/\bbatu\b.*\d+(?:[.,]\d+)?\s*(?:mm|cm|HU)\b/i],
  evaluasi_eswl:['Evaluasi ESWL dan alasan pengulangan',/\b(?:evaluasi|hasil|pasca|post)\b.*\bESWL\b|\bESWL\b.*\b(?:evaluasi|residu|sisa|ulang)\b/i],
  protokol_rehab:['Protokol, diagnosis fungsi dan goal terapi',/\b(?:diagnosis fungsi|diagnosa fungsi|goal\s*(?:of\s*)?(?:therapy|treatment)|target terapi|program rehabilitasi|protokol terapi)\b\s*[:=].+/i],
  asesmen_rehab:['SOAP dan asesmen fungsi rehabilitasi',/\b(?:asesmen fungsi|assessment fungsi|uji fungsi|SOAP)\b\s*[:=].+/i],
  supervisi_rehab:['Pemantauan/pengawasan Sp.KFR',/\b(?:Sp[ .]*KFR)\b.*(?:pemantauan|supervisi|pengawasan|pendampingan)|(?:pemantauan|supervisi|pengawasan|pendampingan).*\bSp[ .]*KFR\b/i],
  pemeriksaan_sesi_rehab:['Pemeriksaan sebelum dan sesudah sesi',/\b(?:sebelum|sesudah|setelah)\b.*\b(?:sesi|rehabilitasi|terapi)\b.*(?:hasil|VAS|fungsi|nyeri|pemeriksaan)/i],
  reasesmen_rehab:['Re-asesmen Sp.KFR dan jadwal/protokol terapi',/\b(?:re[ -]?(?:asesmen|assessment|assesment))\b.*(?:\d|Sp[ .]*KFR|hasil)/i],
  jawaban_konsul:['Surat rujukan dan jawaban konsul internal',/\b(?:jawaban konsul|hasil konsultasi|rujukan internal)\b\s*[:=].+/i,['resume_medis','cppt']],
  riwayat_prb:['Riwayat obat kronis sama 3 bulan dan diagnosis PRB',/\b(?:PRB|Program Rujuk Balik)\b.*(?:diagnosis|diagnosa|obat|bulan)|\bobat kronis\b.*(?:3|tiga)\s*bulan/i],
  resep_iterasi:['Resep/urutan pengambilan obat iterasi',/\b(?:iterasi|iter)\b\s*[:=]?\s*(?:[12]|pertama|kedua)|\bpengambilan obat\b.*\bbulan\s*(?:ke[ -]?)?[23]/i],
};

function halamanBukti(pages) {
  return (Array.isArray(pages)?pages:[]).filter(p=>p&&isi(p).trim()&&!isLembarGrouper(isi(p)))
    .map(p=>({...p,jenis:classifyPageDocumentType(isi(p))}))
    .filter(p=>!['rincian_biaya','resep','sep','spri'].includes(p.jenis));
}
function cari(pages,key,cariBukti) {
  if (key === 'terapi_asma') return buktiTerapiAsma(pages);
  const d=DET[key];
  if(!d) return cariBukti ? cariBukti(pages,key) : {id:key,nama:key,status:'perlu_cek_manual',bukti:[]};
  const [nama,pola,jenis,negatifDiterima]=d;
  const bukti=pages.flatMap(p=>(jenis&&!jenis.includes(p.jenis)?[]:isi(p).split(/\r?\n/)
    .filter(line=>pola.test(line)&&(negatifDiterima||!NEGASI.test(line)))
    .map(line=>({page_number:p.page_number||null,kutipan:line.trim().slice(0,500),jenis_halaman:p.jenis})))).slice(0,8);
  return {id:key,nama,status:bukti.length?'bukti_ditemukan':'bukti_belum_cukup',bukti,
    catatan:bukti.length?'Kutipan menunjukkan dokumentasi terkait; isi, hasil, waktu dan kelengkapan seluruh kriteria tetap ditelaah.'
      :`${nama} tidak tertulis pada halaman klinis yang terbaca.`};
}
function buktiTerapiAsma(pages) {
  const groups = { bronkodilator: [], steroid_sistemik: [] };
  for (const p of pages) {
    const lines = isi(p).split(/\r?\n/); let pelaksanaan = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^(?:intervensi|rencana|terapi\s+pulang|instruksi\s+tindak\s+lanjut|pengkajian\s+fungsional)\b/i.test(line)) pelaksanaan = false;
      if (/tindakan\s+keperawatan|catatan\s+pemberian\s+obat|terapi\/pengobatan\s+selama|^memberikan\s*:/i.test(line)) pelaksanaan = true;
      if (!line || NEGASI.test(line) || ['resep','rincian_biaya'].includes(p.jenis)) continue;
      const aksi = pelaksanaan || /\b(?:diberikan|pemberian|memberikan|dinebul\w*|telah|sudah)\b/i.test(line);
      if (!aksi) continue;
      const e = { page_number:p.page_number, kutipan:line, jenis_halaman:p.jenis };
      if (/\b(?:salbutamol|ipratropium|lasalcom|ventasal|bronkodilator)\b/i.test(line)) groups.bronkodilator.push(e);
      if (/\b(?:methylprednisolon\w*|metilprednisolon\w*|dexamethasone|deksametason|prednison\w*|hydrocortisone|hidrokortison)\b/i.test(line)
          && /\b(?:inj\w*|iv|intravena|oral|tablet|po)\b/i.test(line)) groups.steroid_sistemik.push(e);
    }
  }
  const lengkap = groups.bronkodilator.length > 0 && groups.steroid_sistemik.length > 0;
  const kurang = [!groups.bronkodilator.length && 'bronkodilator', !groups.steroid_sistemik.length && 'kortikosteroid sistemik'].filter(Boolean);
  return {id:'terapi_asma',nama:DET.terapi_asma[0],status:lengkap?'bukti_ditemukan':'bukti_belum_cukup',
    bukti:[...groups.bronkodilator.slice(0,1),...groups.steroid_sistemik.slice(0,1)],
    catatan:lengkap?'Pemberian bronkodilator dan kortikosteroid sistemik tertulis. Respons terapi dinilai bersama perjalanan kasus.'
      :`Rincian ${kurang.join(' dan ')} ditelaah casemix; budesonide inhalasi tidak dianggap steroid sistemik.`};
}
function konteksIcuTerdokumentasi(pages) {
  return pages.some(p=>p.jenis==='resume_medis' && /\bICU\b/i.test(isi(p)) && /Bangsal|ruang\s+rawat/i.test(isi(p)))
    && pages.some(p=>p.jenis==='resume_medis' && /(?:Alasan\s+Masuk\s+Rawat\s+Inap|Diagnosis\s+Utama)\s*:\s*[^\s-]/i.test(isi(p)));
}
function pemicu(a,record,pages,dx,px) {
  const raw=objek(record.raw_data), jenis=record.jenis_klaim||record.JENIS_KLAIM||raw.JENIS_KLAIM;
  const klinis=pages.filter(p=>!['lab_results','radiology','ekg','patologi_anatomi'].includes(p.jenis)).map(isi).join('\n');
  if(a.pemicu==='rehab') return dx.includes('Z50.1')||px.some(k=>/^93\.(?:0[1-9]|1\d|2\d|3\d|8[0-9])$/.test(k))
    || /\b(?:pelayanan rehabilitasi medik|program rehabilitasi|Sp[ .]*KFR)\b/i.test(klinis);
  if(a.pemicu==='konsul_internal') return jenis==='RAWAT_JALAN' && (record.konsul_internal===true||record.rujukan_internal===true
    || ['KONSUL_INTERNAL','RUJUKAN_INTERNAL'].includes(record.jenis_konsultasi)
    || /\b(?:konsul internal|rujukan internal)\b.*\b(?:dokter|perujuk|dikembalikan|episode)\b/i.test(klinis));
  if(a.pemicu==='prb') return jenis==='RAWAT_JALAN' && (/\b(?:program rujuk balik|PRB|obat kronis)\b/i.test(klinis)
    || Number(record.flag_rujuk_balik_prb)===1 || (Number(record.histori_obat_kronis_bulan_berturut)>=3
      && require('./prbRules').matchPrbCategory(dx.join(';'))));
  if(a.pemicu==='iterasi') return jenis==='RAWAT_JALAN' && (Number(record.urutan_iterasi)>0
    || /\b(?:iterasi obat|iterasi resep|resep iterasi|resep\s+iter\s*[12])\b/i.test(klinis));
  return (a.dx||[]).some(p=>dx.some(k=>cocok(k,p))) || (a.px||[]).some(p=>px.some(k=>cocok(k,p)));
}
function usiaHari(record) {
  const raw=objek(record.raw_data), value=record.umur_hari??record.UMUR_HARI??raw.UMUR_HARI;
  if(value!==null&&value!==undefined&&value!=='') return Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
  // Umur dalam tahun saja tidak memastikan usia <28 hari.
  const b=String(record.birth_date||record.BIRTH_DATE||raw.BIRTH_DATE||'').slice(0,10);
  const a=String(record.admission_date||record.ADMISSION_DATE||raw.ADMISSION_DATE||'').slice(0,10);
  const sah=require('./profilKlaimRsService').tanggalSah;
  if(!b||!a||!sah(b)||!sah(a)||a<b) return null;
  return (Date.parse(a)-Date.parse(b))/86400000;
}

function evaluasiDokumen(record={},pages=[],options={}) {
  const dx=pecah(options.dx??record.DIAGLIST??record.diagnosa_list),px=pecah(options.px??record.PROCLIST??record.prosedur_list);
  const klinis=halamanBukti(pages), tanggal=options.tanggal??require('./referensiKlaimService').tanggalRecord(record);
  const usia=options.usia??require('./referensiKlaimService').usiaRecord(record), hari=usiaHari(record), temuan=[];
  for(const a of katalog.aturan) {
    if((options.profil?.referensi_dinonaktifkan||[]).includes(a.id)||!pemicu(a,record,klinis,dx,px)) continue;
    if(require('./usiaPasienService').cakupanUsia(a,require('./usiaPasienService').resolveUsia(record))!==true) continue;
    if(a.sindrom_koroner_kronik&&dx.some(k=>['I20.0','I21','I22','I24'].some(p=>cocok(k,p)))) continue;
    const sumber=katalog.sumber.find(s=>s.id===a.sumber_id),tk=sumber.jenis==='rekomendasi_tkmkb';
    const sebelum=!!(tanggal&&(sumber.berlaku_mulai||sumber.diterbitkan_pada)&&tanggal<(sumber.berlaku_mulai||sumber.diterbitkan_pada));
    const batas=[...a.keterbatasan];
    if(!tanggal)batas.push('Tanggal episode belum terkonfirmasi.');
    if(sebelum)batas.push('Episode mendahului tanggal penerapan BA atau penerbitan buku; jangan menerapkan butir ini sebagai syarat retrospektif.');
    if(tk)batas.push('Rekomendasi audit TKMKB; awal berlaku sebagai syarat klaim belum tersedia pada berkas.');
    const usiaBelum=(a.usia_min!==undefined&&usia===null)||(a.neonatus&&hari===null);
    if(usiaBelum)batas.push('Kelompok usia atau usia bayi dalam hari belum terkonfirmasi.');
    const bukti=a.bukti.map(k=>cari(klinis,k,options.cariBukti));
    let nama=a.nama, catatan=a.catatan;
    if(a.id==='TK-25-09') {
      const score=bukti.find(b=>b.id==='skor_sepsis');
      if(usia===null){score.bukti=[];score.status='perlu_cek_manual';score.nama='Skor disfungsi organ: konfirmasi usia';catatan='Konfirmasi usia sebelum memilih skor disfungsi organ; parameter yang tidak terbaca bukan nol.';}
      else {
        const dewasa=usia>=18; score.nama=dewasa?'SOFA dewasa dengan angka pada resume':'PELOD-2 anak dengan angka pada resume';
        score.bukti=score.bukti.filter(e=>(dewasa?/\bSOFA\b/i:/\bPELOD[ -]?2\b/i).test(e.kutipan));
        nama=dewasa?'Sepsis dewasa (TKMKB)':'Sepsis anak (TKMKB)';
        catatan=`Telaah fokus infeksi, disfungsi organ, ${dewasa?'SOFA dewasa':'PELOD-2 anak'}, kultur dan tata laksana. Kultur negatif tidak sendiri menggugurkan diagnosis; parameter hilang bukan nol.`;
      }
      score.status=usia===null?'perlu_cek_manual':score.bukti.length?'bukti_ditemukan':'bukti_belum_cukup';
    }
    if(a.id==='BA-24-A1') {
      const tamat=klinis.flatMap(p=>isi(p).split(/\r?\n/).map(line=>({line,p})))
        .find(({line})=>/\bprotokol terapi\b.*\btuntas\b.*\b(?:[1-9]|1[0-3])\s*hari\b/i.test(line)&&!NEGASI.test(line));
      const reassess=bukti.find(b=>b.id==='reasesmen_rehab');
      if(tamat){reassess.status='tidak_terindikasi_rutin';reassess.bukti=[{page_number:tamat.p.page_number,kutipan:tamat.line}];
        reassess.catatan='Protokol tuntas kurang dari 2 minggu: BA mengecualikan re-asesmen. Tanggal dan penyelesaian terapi tetap dikonfirmasi.';}
      else {reassess.status='perlu_cek_manual';reassess.catatan='Periksa rentang program dan pengecualian tuntas <2 minggu; satu kunjungan tidak membuktikan kewajiban re-asesmen telah jatuh tempo.';}
    }
    if(['BA-24-A2','BA-24-A3','BA-24-A4'].includes(a.id))batas.push('Penetapan episode, riwayat 3 bulan atau urutan iterasi memerlukan dokumen antar-kunjungan; tidak diputus dari satu klaim.');
    if(a.id==='BA-24-A2'&&record.jenis_konsultasi)batas.push('Label konsul internal yang dihitung dari kunjungan antar-poli belum membuktikan surat konsul dan pengembalian ke perujuk.');
    if(a.id==='BA-24-A3'&&Number(record.histori_obat_kronis_bulan_berturut)>0)batas.push('Riwayat sistem dihitung dari kategori diagnosis; belum membuktikan obat yang sama 3 bulan berturut-turut.');
    if(a.id==='BA-24-A4'&&Number(record.urutan_iterasi)>0)batas.push('Nomor iterasi sistem merupakan perkiraan frekuensi kunjungan; cocokkan urutan resep asli.');
    const missing=bukti.filter(b=>b.status==='bukti_belum_cukup');
    const berlaku=sebelum?false:(!tk&&tanggal?true:null);
    // Rekomedasi yang belum memiliki masa berlaku tetap bisa menambah telaah,
    // tetapi tidak menjadi kewajiban nasional/putusan pending otomatis.
    const telaah=!!tanggal&&!sebelum&&!usiaBelum&&missing.length>0;
    const manualIcu=tk && konteksIcuTerdokumentasi(klinis) && missing.length>0;
    temuan.push({id:a.id,nama,kode_diagnosis:dx.filter(k=>(a.dx||[]).some(p=>cocok(k,p))),
      kode_prosedur:px.filter(k=>(a.px||[]).some(p=>cocok(k,p))),jenis_ketentuan:sumber.jenis,
      sumber:{...sumber,halaman:a.halaman_pdf.join(', ')+(a.halaman_buku?` (buku ${a.halaman_buku})`:''),butir:a.bab,teks_asli:a.teks_asli},
      tanggal_acuan:tanggal,berlaku_pada_episode:berlaku,
      status:sebelum||!tanggal||usiaBelum?'perlu_konfirmasi_ketentuan':missing.length?'bukti_belum_cukup':tk?'telaah_rekomendasi':'perlu_cek_manual',
      bukti,catatan,keterbatasan:batas,perlu_telaah_dokumen:telaah,
      blokir_submit:false,mengubah_kode:false,wajib_pending:false,
      ...(manualIcu ? {tanpa_putusan:true,telaah_casemix:true,catatan:catatan+' Rincian audit yang belum tertulis dicocokkan casemix dengan CPPT; tidak menjadi pending otomatis pada episode ICU yang terdokumentasi.'} : {})});
  }
  return temuan;
}

function buktiPola(pages,id,nama,pola,catatan) {
  const bukti=pages.flatMap(p=>isi(p).split(/\r?\n/).filter(l=>pola.test(l)&&!NEGASI.test(l))
    .map(l=>({page_number:p.page_number,kutipan:l.trim().slice(0,500),jenis_halaman:p.jenis}))).slice(0,8);
  return {id,nama,status:bukti.length?'bukti_ditemukan':'bukti_belum_cukup',bukti,catatan};
}
function buktiTatalaksanaRi(pages) {
  const label=/\b(?:terapi\/pengobatan selama di rumah sakit|tata\s?laksana rawat inap)\b\s*[:=]/i;
  const hasil={id:'matriks_tatalaksana_ri',nama:'Tata laksana rawat inap',status:'bukti_belum_cukup',bukti:[],
    catatan:'Telaah daftar terapi dan catatan pelaksanaan perawatan, bukan hanya judul formulir atau resep. Dokumentasi terapi tidak sendiri membuktikan seluruh indikasi rawat inap.'};
  for(const p of pages) {
    const lines=isi(p).split(/\r?\n/);
    for(let i=0;i<lines.length;i++) {
      if(!label.test(lines[i])||NEGASI.test(lines[i]))continue;
      const body=[lines[i].split(/[:=]/).slice(1).join(':').trim()];
      for(let n=i+1;n<Math.min(lines.length,i+13);n++) {
        if(/^[^\n:]{2,100}:/.test(lines[n]))break;
        body.push(lines[n]);
      }
      const ada=body.some(l=>!NEGASI.test(l)&&/\b(?:INJ(?:EKSI)?|INFUS|tablet|kapsul|\d+(?:[.,]\d+)?\s*(?:mg|gr|ml))\b/i.test(l));
      if(ada)hasil.bukti.push({page_number:p.page_number,kutipan:[lines[i],...body.filter(Boolean)].join('\n').slice(0,500),jenis_halaman:p.jenis});
    }
  }
  hasil.bukti=hasil.bukti.slice(0,8);
  if(hasil.bukti.length)hasil.status='bukti_ditemukan';
  return hasil;
}
function matriksIgd(record,pages,options={}) {
  const klinis=halamanBukti(pages);
  const a=options.kegawatdaruratan||objek(record.ai_review).kegawatdaruratan_assessment||{};
  const criteria=Array.isArray(a.kriteria)?a.kriteria:[];
  const norm=s=>String(s).replace(/\s+/g,' ').trim().toLowerCase();
  const buktiKgd=criteria.flatMap(k=>(k.evidence||[]).filter(e=>e.kutipan&&pages.some(p=>
    Number(p.page_number)===Number(e.page_number)&&norm(isi(p)).includes(norm(e.kutipan)))));
  const terbukti=criteria.some(k=>['ya','TERPENUHI'].includes(k.status)&&(k.evidence||[]).some(e=>buktiKgd.includes(e)));
  // Kriteria a-e dibaca langsung dari triase (ESI, primary survey, GCS, tanda vital, tindakan segera);
  // penilaian AI berkutipan tetap diterima sebagai alternatif.
  const igd=require('./matriksIgdService'), semua=(Array.isArray(pages)?pages:[]).filter(p=>p&&!isLembarGrouper(isi(p)));
  const det=igd.kriteriaGawatDarurat(record,semua);
  const adaKgd=terbukti||det.kena.length>0;
  const kgd={id:'matriks_kegawatan',nama:'Salah satu kriteria gawat darurat (a-e)',status:adaKgd?'bukti_ditemukan':'bukti_belum_cukup',
    bukti:[...det.kena.map(k=>({page_number:k.page_number,kutipan:`[${k.kode}] ${k.nama}: ${k.kutipan}`})),...buktiKgd].slice(0,8),
    catatan:adaKgd?'Kriteria gawat darurat tertulis pada dokumen IGD; penilaian klinis tetap mengikuti DPJP.'
      :det.ada_triase?`Tidak ada kriteria gawat darurat a-e (mengancam nyawa, gangguan ABC, GCS <=8, gangguan hemodinamik, tindakan segera) yang tertulis. Terbaca: ${det.terbaca.join('; ')||'-'}. False emergency tidak dijamin; telaah alasan IGD bersama DPJP.`
      :'Lembar triase IGD (ABC, GCS, tanda vital) tidak ada di berkas; kriteria gawat darurat tidak dapat ditunjukkan.'};
  const hasil=[kgd,buktiPola(klinis,'matriks_rujukan','Tatalaksana tuntas dan status rujukan',/\b(?:kelanjutan|tindak lanjut|disposisi|cara keluar|keadaan keluar|status keluar)\s*:?\s*(?:pulang|dirujuk|rujuk|rawat inap|MRS|meninggal|membaik)|\b(?:tidak dirujuk|dirujuk ke|stabil menunggu rujuk|pulang ijin dokter|diijinkan pulang|KRS)\b/i,'Status rujuk dan tuntasnya tata laksana ditelaah sesuai jalur matriks; stabil menunggu rujuk memiliki jalur RJTL.')];
  const raw=objek(record.raw_data),jenis=record.jenis_klaim||record.JENIS_KLAIM||raw.JENIS_KLAIM;
  if(jenis!=='RAWAT_INAP')return hasil;
  // Hanya DURASI IGD tertulis. Tanggal masuk-pulang RS, jam pengkajian selesai,
  // dan waktu cetak tidak digunakan untuk mengarang lama pelayanan di IGD.
  const durasi=[];
  for(const p of klinis)for(const line of isi(p).split(/\r?\n/)) {
    if(NEGASI.test(line))continue;
    const m=/(?:durasi|lama(?: pelayanan| perawatan)?)\s+(?:di\s+)?(?:IGD|UGD)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*jam\b/i.exec(line);
    if(m)durasi.push({page_number:p.page_number,kutipan:line.trim(),nilai:Number(m[1].replace(',','.'))});
  }
  const dur=igd.durasiIgd(semua);
  const durBukti=[...durasi,...(dur.masuk?[{page_number:dur.masuk.page_number,kutipan:`Masuk IGD (triase): ${dur.masuk.kutipan}`}]:[]),...(dur.keluar?[{page_number:dur.keluar.page_number,kutipan:`Keluar IGD: ${dur.keluar.kutipan}`}]:[])];
  const lama=durasi.length?durasi[0].nilai:dur.jam;
  hasil.push({id:'matriks_durasi_igd',nama:'Waktu masuk dan keluar IGD tercatat',status:lama!==null&&lama!==undefined?'bukti_ditemukan':'bukti_belum_cukup',bukti:durBukti.slice(0,8),
    catatan:lama!==null&&lama!==undefined?`Pelayanan IGD ${String(lama).replace('.',',')} jam${durasi.length?' (tertulis)':' (dari jam triase sampai tiba di ruang rawat)'}. Matriks menyebut IGD >6 jam pada jalurnya; durasi pendek tidak sendiri menggugurkan rawat inap yang memenuhi indikasi, dan lama rawat inap bukan durasi IGD.`
      :'Jam masuk IGD (triase) dan jam pindah ke ruang rawat belum tercatat di berkas; durasi pelayanan IGD tidak dapat ditunjukkan.'});
  const ind=igd.indikasiRawatInap(semua);
  hasil.push({id:'matriks_indikasi_ri',nama:'Indikasi medis rawat inap',status:ind.length?'bukti_ditemukan':'bukti_belum_cukup',bukti:ind,
    catatan:ind.length?'Alasan/indikasi rawat inap tertulis (SPRI/resume DPJP); kesesuaian dengan PNPK dinilai pada butir diagnosis.':'Alasan atau indikasi rawat inap belum tertulis pada SPRI/resume; judul kosong atau kode penyakit bukan indikasi.'});
  hasil.push(buktiTatalaksanaRi(klinis));
  const rd=igd.ruangDanDpjp(semua);
  const visite=buktiPola(klinis,'visitasi','Visitasi spesialis',/\b(?:visitasi|visite)\b.*\bSp[ .]*\w|\bSp[ .]*\w.*\b(?:visitasi|visite)\b/i,'');
  const okRuang=rd.ruang.length>0&&(rd.dpjp.length>0||visite.bukti.length>0);
  hasil.push({id:'matriks_ruang_dpjp',nama:'Menempati ruang perawatan dan dirawat DPJP spesialis',status:okRuang?'bukti_ditemukan':'bukti_belum_cukup',
    bukti:[...rd.ruang,...rd.dpjp,...visite.bukti].slice(0,8),
    catatan:okRuang?`Ruang rawat dan DPJP spesialis tertulis${visite.bukti.length?' dengan catatan visite':' (catatan masuk ruang/resume DPJP; CPPT visite tidak dilampirkan pada berkas)'}.`
      :!rd.ruang.length?'Catatan masuk ruang perawatan belum ada di berkas.':'DPJP spesialis yang merawat/visite belum tertulis di berkas.'});
  // SEP/SPRI administratif dibaca untuk checklist administrasi saja, bukan diagnosis.
  const admin=(Array.isArray(pages)?pages:[]).filter(p=>!isLembarGrouper(isi(p))).map(p=>({...p,jenis:classifyPageDocumentType(isi(p))}));
  hasil.push(buktiPola(admin,'matriks_administrasi_ri','Administrasi rawat inap',/\b(?:No\.?\s*SEP|SURAT PERINTAH RAWAT INAP|SURAT ELEGIBILITAS PESERTA)\b/i,'Telaah kesesuaian SEP, tanggal, jenis rawat dan surat perintah; keberadaan judul belum membuktikan seluruh data administrasi sah.'));
  const dukunganRi = [kgd,...hasil.filter(b=>['matriks_indikasi_ri','matriks_ruang_dpjp','matriks_tatalaksana_ri'].includes(b.id))];
  if (dukunganRi.length===4 && dukunganRi.every(b=>b.status==='bukti_ditemukan') && konteksIcuTerdokumentasi(klinis)) {
    const waktu=hasil.find(b=>b.id==='matriks_durasi_igd');
    if(waktu.status==='bukti_belum_cukup') Object.assign(waktu,{status:'perlu_cek_manual',info:true,catatan:'Durasi IGD belum lengkap. Kegawatan, indikasi rawat, terapi dan perawatan ICU oleh DPJP tertulis; jam transfer dicocokkan casemix tanpa menjadi pending otomatis.'});
  }
  return hasil;
}
function lengkapiReferensiBa(temuan,record,pages,options={}) {
  return temuan.map(t=>{
    const a=katalog.pelengkap_aturan.find(a=>a.id===t.id);if(!a)return t;
    const bukti=t.id==='RK-16'?[...t.bukti,...matriksIgd(record,pages,options)]:t.bukti;
    const manual=bukti.some(b=>!b.info&&['perlu_cek_manual','bukti_belum_cukup'].includes(b.status));
    return {...t,sumber:{...katalog.sumber[0],halaman:a.halaman_pdf.join(', '),butir:a.bab,teks_asli:a.teks_asli},
      catatan:a.catatan,bukti,status:t.berlaku_pada_episode===true&&manual?'bukti_belum_cukup':t.status,
      perlu_telaah_dokumen:t.id==='RK-16'&&t.berlaku_pada_episode===true&&manual};
  });
}
function temuanKritis(temuan) {
  return temuan.filter(t=>!t.tanpa_putusan&&t.perlu_telaah_dokumen&&t.jenis_ketentuan==='rekomendasi_tkmkb')
    .map(t=>({id:t.id,jenis:'inkonsistensi',keparahan:'sedang',sumber:'aturan',sumber_dokumen:t.sumber.id,
      ketentuan_terverifikasi:false,pesan:`${t.nama}: ${t.bukti.filter(b=>b.status==='bukti_belum_cukup').map(b=>b.nama).join('; ')} belum terkonfirmasi dari berkas.`,
      saran:`Telaah rekomendasi ${t.sumber.judul}, halaman ${t.sumber.halaman}, bersama DPJP/casemix dan pedoman episode. Bukti belum terbaca bukan bukti tindakan tidak dilakukan.`,
      bukti:t.bukti.flatMap(b=>b.bukti)[0]||null}));
}
// Skor lama mungkin telah dibatasi 0/70. Tambah/kurangi hanya selisih temuan
// sumber ini agar perubahan sumber lain tetap dipertahankan dan idempotent.
function perbaruiKritik(lama,record,pages,temuanReferensi,options={}) {
  if(!lama||!Array.isArray(lama.temuan)||typeof lama.skor_keyakinan!=='number')return lama;
  const bdd=require('./bpjsDoDontService');
  const milik=t=>['TKMKB-PUSAT-2025',bdd.katalog.sumber.id].includes(t.sumber_dokumen);
  const baru=[...bdd.temuanKritisDokumen(record,pages,options),...temuanKritis(temuanReferensi)],dulu=lama.temuan.filter(milik);
  if(!dulu.length&&!baru.length)return lama;
  const temuan=[...lama.temuan.filter(t=>!milik(t)),...baru];
  const bobot=list=>list.reduce((n,t)=>n+({tinggi:25,sedang:12,rendah:5}[t.keparahan]||0),0);
  const dasar=lama.pembaruan_ba_tkmkb?.dasar||lama.pembaruan_catatan_dokumen?.dasar||{skor_keyakinan:Math.min(100,lama.skor_keyakinan+bobot(dulu))};
  const skor=Math.min(lama.ai_gagal?70:100,Math.max(0,dasar.skor_keyakinan-bobot(baru)));
  return {...lama,temuan,skor_keyakinan:skor,tingkat:skor>=80?'tinggi':skor>=55?'sedang':'rendah',ringkas:{...lama.ringkas,total:temuan.length},
    kesimpulan:temuan.length?`${temuan.length} hal perlu ditinjau koder sebelum unggah. Sumber dokumen ditelaah dari bukti tersimpan.`:'Pemeriksaan yang dijalankan belum menemukan keberatan pada kode dan bukti yang terbaca.',
    pembaruan_ba_tkmkb:{versi:katalog.versi,tanpa_ai_ulang:true,dasar}};
}
module.exports={katalog,halamanBukti,cari,usiaHari,evaluasiDokumen,matriksIgd,lengkapiReferensiBa,temuanKritis,perbaruiKritik};
