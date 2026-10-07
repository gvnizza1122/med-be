/**
 * Konvensi koding yang sudah ditetapkan RS -- satu sumber untuk semua lapisan
 * AI (penalaran diagnosis, pemeriksa kritis, agen). Kode bertanda [aturan RS]
 * berasal dari konvensi ini dan hanya dipersoalkan bila bukti berkas
 * BERTENTANGAN LANGSUNG, bukan sekadar karena dokumentasinya ringkas.
 */
const KONVENSI_KODING_RS = `KONVENSI KODING RS (sudah ditetapkan; jangan dipersoalkan kecuali bukti berkas BERTENTANGAN LANGSUNG):
- KPD: lama ketuban pecah > 24 jam = O42.1 (termasuk persalinan seksio); tidak perlu catatan mulai kontraksi.
- Persalinan: cara persalinan O80-O84 dan hasil persalinan Z37.- dikode sebagai sekunder; surat kelahiran/data bayi
  lahir = bukti Z37.0; SC tanpa keterangan jenis = 74.1.
- Patologi: cocokkan hasil PA dengan diagnosis akhir dokter, spesimen dan lokasi. Tidak ganas tidak otomatis
  neoplasma jinak atau lesi superfisial. Normal/radang/lesi non-neoplastik dibaca sesuai laporan; diagnosis
  banding PA tidak dikode terpisah dan perbedaan dengan diagnosis dokter memerlukan klarifikasi.
- Penunjang darah (darah rutin, kimia, serologi) = 90.59.
  Untuk saran INA-CBG, anemia pada CKD memakai N18.- dengan D63.8 di ICD-10 WHO.
  D63.1 adalah kode berbeda pada ICD-10-CM/IM iDRG; jangan menyatakan padanan WHO
  salah hanya karena kode yang lebih rinci tersedia pada sistem lain.
- Prosedur mengikuti tindakan yang benar-benar dilakukan dan kamus ICD-9-CM, bukan kebiasaan kode pada
  berkas casemix lain. Kateterisasi urin terapeutik yang tercatat dapat menjadi kandidat 57.94.
  GDS adalah pemeriksaan darah, bukan kode pemeriksaan fisik 89.29/89.39.
  Laparotomi sebagai akses apendektomi bukan laparotomi eksplorasi 54.11 tersendiri. Jangan menambah
  prosedur hanya dari resep, rencana, tagihan, atau untuk menaikkan tarif.
- Diagnosis yang dikode adalah diagnosis akhir dokter di resume; diagnosis masuk (SPRI/SEP/IGD) yang tidak ditulis ulang
  sebagai diagnosis akhir adalah riwayat diagnosis awal. Perbedaan diagnosis awal dengan resume TIDAK dengan
  sendirinya memerlukan klarifikasi. Klarifikasi bila resume akhir ambigu atau bukti klinis bertentangan langsung.
  Kehamilan bersamaan/konsul SpOG tidak sendiri membuktikan penyakit pencernaan menyulitkan kehamilan.
  Pertimbangkan O99.6 beserta urutannya berdasarkan hubungan yang ditetapkan dokter dan aturan koding;
  jangan menambahkannya atau menyatakan diagnosis utama salah hanya karena pasien hamil.
- Persyaratan kelengkapan klaim BPJS adalah ketentuan klaim dari sumber verifikasi/regulasi,
  bukan aturan internal atau pilihan layanan RS. Tampilkan sumbernya dan nilai bukti pemenuhannya.
- ADAPTASI LAYANAN: ikuti profil fasilitas RS yang sedang dinilai. Jangan menyarankan klaim
  tindakan rehabilitasi tanpa bukti pelaksanaan. Bila dibutuhkan secara klinis, pertimbangkan layanan/rujukan yang tersedia.
  Ketiadaan layanan tidak dengan sendirinya menghapus atau memenuhi persyaratan BPJS. Jika tindakan/kode
  rehabilitasi tercantum pada klaim, persyaratan dan bukti yang relevan tetap perlu diperiksa sesuai sumbernya.`;

function konvensiUntukRs(record = {}, pages = []) {
  const konteks = require('./konteksPenggunaanAiService').saatIni();
  const profil = konteks.profil_klaim_rs || require('./profilKlaimRsService').profilBawaan(record.hospital_code || record.KODE_RS || konteks.hospital_code);
  const rehab = profil.layanan.rehabilitasi_medis;
  const adaptasi = rehab === false ? 'RS ini tidak menyediakan rehabilitasi medis; pertimbangkan rujukan bila terindikasi. Ketiadaan layanan tidak menghapus persyaratan klaim.'
    : rehab === true ? 'Rehabilitasi medis tersedia; rekomendasi dan klaim tetap memerlukan indikasi serta bukti pelaksanaan.'
      : 'Ketersediaan rehabilitasi medis belum ditentukan; jangan mengasumsikan tersedia atau tidak tersedia.';
  const rujukan = require('./referensiKlaimService').konteksReferensiUntukAi(record,pages,{profil});
  return `${KONVENSI_KODING_RS}\nPROFIL FASILITAS: ${adaptasi}\n${rujukan ? `REFERENSI BERSUMBER (pedoman klinis tidak otomatis menjadi kewajiban administratif; tidak menetapkan diagnosis atau mengarang tes):\n${rujukan}` : ''}`;
}

/**
 * Prosedur rutin yang TIDAK dikode casemix RS (dipelajari dari keputusan
 * casemix pada berkas berlembar grouper: KHOIRIYAH, YETY, ANNISA -- 99.21,
 * 99.23, 99.24, 99.29, 38.93, 57.94, 93.96 selalu dibuang casemix) ditambah
 * kerabat terdekatnya (99.18 infus elektrolit, 99.22 injeksi anti-infeksi lain).
 */
const PROSEDUR_RUTIN_TIDAK_DIKODE = new Set(['99.18', '99.21', '99.22', '99.23', '99.24', '99.29', '38.93', '93.96']);
const ALASAN_PROSEDUR_RUTIN = 'Tindakan rutin obat/akses infus/oksigen memerlukan penelaahan koder; tidak ditambahkan otomatis dari resep atau tagihan.';

const HALAMAN_HASIL_PENUNJANG = new Set(['lab_results', 'radiology', 'ekg', 'rekaman_ctg']);
/**
 * Kode penunjang yang dibuktikan LEMBAR HASIL di berkas (lab -> 90.59, rontgen
 * -> 87.44, EKG -> 89.52, CTG eksternal -> 75.34), bukan tagihan saja.
 * Satu sumber untuk pengisian PROCLIST dan kode final semua lapisan.
 */
function penunjangBerhasil(ai) {
  const { deskripsiProsedur } = require('./kamusKodeService');
  return [...new Set((Array.isArray(ai && ai.temuan_penunjang) ? ai.temuan_penunjang : [])
    .filter(t => t && t.kode_usulan && HALAMAN_HASIL_PENUNJANG.has(t.jenis_halaman)
      && (String(t.kode_usulan) !== '75.34' || t.jenis_halaman === 'rekaman_ctg'))
    .map(t => String(t.kode_usulan).trim())
    .filter(k => deskripsiProsedur(k) && !PROSEDUR_RUTIN_TIDAK_DIKODE.has(k)))];
}

function tindakanTerverifikasi(ai) {
  const { deskripsiProsedur } = require('./kamusKodeService');
  return [...new Set((ai?.temuan_tindakan || []).filter(t => t && t.kode_usulan && !t.disangkal
    && (t.bukti || []).some(b => ['resume_medis', 'triase_igd'].includes(b.sumber)))
    .map(t => t.kode_usulan).filter(k => deskripsiProsedur(k) && !PROSEDUR_RUTIN_TIDAK_DIKODE.has(k)))];
}

function tindakanBelumDikode(record, ai) {
  const px = String(record.PROCLIST || record.prosedur_list || '').split(/[;,]/).map(k => k.trim());
  // Saat daftar kosong, kode akan diisi dari sumber terverifikasi. Saat koder
  // sudah mengisi, kekurangan ditampilkan sebagai usulan, tanpa menimpa pilihannya.
  if (!px.some(Boolean)) return [];
  return (ai?.temuan_tindakan || []).filter(t => tindakanTerverifikasi(ai).includes(t.kode_usulan) && !px.includes(t.kode_usulan))
    .map(t => ({ nama: t.nama, kode: t.kode_usulan, bukti: t.bukti, pesan: 'Tindakan tercatat, tetapi belum ada di daftar prosedur klaim. Periksa dan tambahkan bila sesuai.' }));
}

module.exports = { KONVENSI_KODING_RS, konvensiUntukRs, PROSEDUR_RUTIN_TIDAK_DIKODE, ALASAN_PROSEDUR_RUTIN, penunjangBerhasil, tindakanTerverifikasi, tindakanBelumDikode };
