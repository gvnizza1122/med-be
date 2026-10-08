const katalogBa = require('../data/baPnpkAnak.json');
const kriteriaPnpk = require('../data/kriteriaPnpk.json');
// Satu mesin penilai untuk butir BA dan kriteria PNPK (katalog_id -> Katalog Pedoman).
const katalog = { ...katalogBa, aturan: [...katalogBa.aturan, ...kriteriaPnpk.aturan] };
const sumberPnpk = id => {
  const d = require('./katalogPedomanService').getDokumen(id);
  if (!d) return null;
  return { id, judul: d.judul, nomor: d.nomor, jenis: 'pedoman_klinis', versi: String(d.tahun || ''), url: d.sumber?.[0]?.url || '',
    halaman: '', status_verifikasi: 'salinan_sumber_ditelaah', berlaku_mulai: d.berlaku_mulai, sha256: d.berkas?.[0]?.sha256 || null,
    catatan: 'PNPK dari Katalog Pedoman; kriteria dibaca dari PDF sumber. Pedoman klinis menjadi telaah, bukan keputusan penjaminan otomatis.' };
};
const { resolveUsia, cakupanUsia } = require('./usiaPasienService');
const pecah = v => (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map(v => String(v).trim().toUpperCase()).filter(Boolean);
const cocok = (k,p) => k === p || k.startsWith(p + '.');
// Pola diawali '^' adalah regex (mis. seluruh bab O); prosedur ICD-9 memakai awalan (86.6 -> 86.60-86.69).
const cocokDx = (k,p) => p.startsWith('^') ? new RegExp(p).test(k) : cocok(k,p);
const cocokPx = (k,p) => k === p || k.startsWith(p);
const ada = (daftar, pola) => daftar.some(k => (pola || []).some(p => cocokDx(k,p)));
function evaluasiBaPnpk(record = {}, pages = [], options = {}) {
  const dx = pecah(options.dx ?? record.DIAGLIST ?? record.diagnosa_list), usia = resolveUsia(record);
  const px = pecah(options.px ?? record.PROCLIST ?? record.prosedur_list);
  const jenis = String(record.jenis_klaim || record.JENIS_KLAIM || '').toUpperCase();
  const episode = require('./usiaPasienService').tanggal(record.admission_date || record.ADMISSION_DATE);
  const tanggal = require('./referensiKlaimService').tanggalRecord(record);
  const klinis = require('./referensiKlaimService').halamanKlinis(pages), out = [];
  const ba2018 = require('./baKesepakatan2018Service');
  let ctxBa = null;
  for (const a of katalog.aturan) {
    // dx_utama_atau_terapi: diagnosis utama, atau episode terapi (Z51 kemo/radioterapi) dengan diagnosis itu sebagai sekunder.
    const dxPicu = a.dx_utama ? dx.slice(0,1) : a.dx_sekunder ? dx.slice(1)
      : a.dx_utama_atau_terapi ? (/^Z5[01]/.test(dx[0] || '') ? dx : dx.slice(0,1)) : dx;
    const kena = dxPicu.filter(k => (a.dx || []).some(p => cocokDx(k,p)));
    const kenaPx = px.filter(k => (a.px || []).some(p => cocokPx(k,p)));
    const picu = a.pemicu === 'dx_dan_px' ? kena.length && kenaPx.length : kena.length || kenaPx.length;
    if (!picu || (options.profil?.referensi_dinonaktifkan || []).includes(a.id) || cakupanUsia(a,usia) !== true) continue;
    if (a.jenis_klaim && !a.jenis_klaim.includes(jenis)) continue;
    if ((a.dx_bersama && !ada(dx, a.dx_bersama)) || ada(dx, a.dx_kecuali)) continue;
    if (a.px_bersama && !px.some(k => a.px_bersama.some(p => cocokPx(k,p)))) continue;
    if (a.px_kecuali && px.some(k => a.px_kecuali.some(p => cocokPx(k,p)))) continue;
    const sumber = a.katalog_id ? sumberPnpk(a.katalog_id) : katalog.sumber.find(s => s.id === a.sumber_id);
    if (!sumber) continue;
    const berlakuPnpk = a.katalog_id ? require('./katalogPedomanService').berlakuPadaEpisode(a.katalog_id, episode) : null;
    if (berlakuPnpk === false) continue; // versi lain PNPK yang berlaku pada episode ini
    const batas = [sumber.catatan, ...(a.katalog_id && berlakuPnpk === null ? ['Tanggal awal episode atau awal berlaku PNPK belum terkonfirmasi; versi pedoman perlu dicek.'] : [])];
    let bukti, catatan = a.catatan, status = 'perlu_cek_manual', penilaian, menilai = false, kontradiksi = false;
    if (a.pemeriksa === 'pneumonia_anak') {
      penilaian = require('./pneumoniaAnakService').nilaiPneumoniaAnak({ record, dx, pages, jenisKlaim:record.jenis_klaim || record.JENIS_KLAIM });
      if (!penilaian) continue;
      bukti = penilaian.kriteria_rawat_inap.map(k => ({ id:k.id, nama:k.nama,
        status:k.status === 'terpenuhi' ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti:k.bukti,
        ...(k.status === 'tidak_terbaca' ? {catatan_tidak_tercatat:true} : {}),
        catatan:k.status === 'tidak_terbaca' ? `${k.nama} tidak tercatat di berkas yang terbaca (triase, resume, catatan perkembangan).`
          : 'Indikasi rawat merupakan alternatif yang ditelaah bersama kondisi klinis; seluruh butir tidak harus terpenuhi sekaligus.' }));
      status = penilaian.rawat_inap_terdukung ? 'bukti_ditemukan' : penilaian.vital_terbaca ? 'bukti_belum_cukup' : 'belum_dapat_dinilai';
      catatan = `Usia ${usia.bulan === null ? usia.tahun+' tahun (bulan belum pasti)' : usia.bulan+' bulan'}; jalur ${penilaian.kelompok}. `
        + 'Napas cepat menurut kelompok usia dan indikasi rawat inap adalah penilaian berbeda. Rawat: SpO2 <=92%/sianosis, RR >60 bayi atau >40 anak, distres/grunting, gangguan asupan bayi atau dehidrasi anak, serta kemampuan keluarga. '
        + 'Foto toraks tidak rutin pada pneumonia anak tanpa komplikasi; dipertimbangkan pada pneumonia berat/komplikasi. Kultur sputum hanya dipertimbangkan pada remaja. Perkiraan rawat 5-7 hari bukan minimum lama rawat atau antibiotik IV 72 jam untuk kelulusan klaim. '
        + penilaian.catatan.join(' ');
      batas.push('Bukti memenuhi indikasi klinis belum berarti klaim valid; diagnosis akhir, pengobatan, penunjang sesuai indikasi dan persyaratan episode tetap diperiksa.');
    } else if (a.kriteria || a.pemeriksa_ba || a.syarat) {
      const n = ba2018.nilaiButir(a, ctxBa ??= ba2018.konteks(record, pages, { dx, px, usia, jenis }));
      if (!n) continue;
      ({ status, bukti } = n);
      menilai = n.menilai === true && a.tanpa_putusan !== true;
      kontradiksi = n.kontradiksi === true;
      if (n.catatan) catatan = `${catatan} ${n.catatan}`;
      batas.push(a.katalog_id ? 'Kriteria PNPK dinilai dari bukti tertulis; penilaian DPJP dan pengecualian klinis tetap ditelaah. Tidak mengganti kode atau memutus klaim otomatis.'
        : 'Butir BA dinilai dari bukti tertulis. Masa berlaku dan pembaruan sesudahnya (BA/PNPK pada episode) tetap ditelaah; tidak mengganti kode atau memutus klaim otomatis.');
      if (!a.katalog_id && tanggal && tanggal < '2018-11-29') batas.push('Episode mendahului surat pengantar BA; jangan menerapkan butir secara retrospektif.');
    } else {
      bukti = (a.bukti || []).map(k => require('./referensiKlaimService').cariBukti(klinis,k));
      batas.push('Butir BA lama ditampilkan untuk telaah; awal berlaku dan perubahan berikutnya belum memastikan putusan klaim otomatis.');
      if (tanggal && tanggal < '2018-11-29') batas.push('Episode mendahului surat pengantar BA; jangan menerapkan butir secara retrospektif.');
    }
    out.push({ id:a.id, nama:a.nama, kelompok_usia:usia.kelompok, jenis_ketentuan:sumber.jenis, kode_diagnosis:kena, kode_prosedur:kenaPx,
      gabung_ke:a.gabung_ke || [], menilai_putusan:menilai, kontradiksi_angka:kontradiksi, ...(a.ringkas_telaah ? {ringkas_telaah:a.ringkas_telaah} : {}),
      sumber:{...sumber,halaman:a.halaman.join(', '),butir:a.butir || 'Pneumonia pada anak'}, tanggal_acuan:tanggal,
      status, bukti, catatan, keterbatasan:batas, berlaku_pada_episode:null, blokir_submit:false, mengubah_kode:false, wajib_pending:false,
      ...(penilaian ? {penilaian_pneumonia:penilaian} : {}) });
  }
  return out;
}
function temuanUsia(record, dx) {
  const usia = resolveUsia(record);
  const catalogs = [require('../data/referensiKesesuaianKlaim.json'),require('../data/baTkmkb2025.json'),katalog];
  const neonatusBelum = usia.tahun !== null && usia.tahun < 1 && usia.hari === null && catalogs.some(c=>c.aturan.some(a=>a.neonatus && (a.dx||[]).some(p=>dx.some(k=>cocok(k,p)))));
  if (usia.tahun !== null && !neonatusBelum) return null;
  if (!catalogs.some(c => c.aturan.some(a => (a.usia_min !== undefined || a.usia_max !== undefined || a.neonatus)
    && (a.dx || []).some(p => dx.some(k => cocokDx(k,p)))))) return null;
  return {id:'RK-USIA',nama:'Konfirmasi usia sebelum memilih kriteria kasus',kelompok_usia:'belum_terkonfirmasi',jenis_ketentuan:'cakupan_usia',
    kode_diagnosis:dx,kode_prosedur:[],status:'perlu_konfirmasi_usia',bukti:[],catatan:neonatusBelum?'Usia bayi dalam hari belum terkonfirmasi; umur tahun 0 tidak membuktikan neonatus.':usia.alasan,
    keterbatasan:['Kelompok usia belum terkonfirmasi. Kriteria khusus anak/dewasa/neonatus belum dinilai. Lengkapi tanggal lahir dan awal episode atau umur yang dapat dikonfirmasi.'],
    sumber:{judul:'Pemilihan cakupan usia pasien',nomor:null,versi:katalog.versi,url:'',halaman:'',catatan:'Tidak memilih pedoman dewasa sebagai nilai bawaan.'},
    berlaku_pada_episode:null,blokir_submit:false,mengubah_kode:false,wajib_pending:false};
}
module.exports = { katalog, evaluasiBaPnpk, temuanUsia, gabungkanTumpang: require('./baKesepakatan2018Service').gabungkanTumpang };
