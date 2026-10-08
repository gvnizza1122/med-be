const svc=require('../../services/laporanOperasiService');
const {evaluasiReferensiKlaim}=require('../../services/referensiKlaimService');
const {perbaruiRisikoTampilan}=require('../../services/risikoKlaimTampilanService');
const {nilaiKelengkapanAnalisis}=require('../../services/kelengkapanAnalisisService');
const p=(ocr_text,page_number)=>({ocr_text,page_number});
const op=p('LAPORAN OPERASI\nNama/ macam tindakan operasi\nEksisi dan PA\nTanggal Operasi Waktu operasi dimulai Waktu operasi selesai\n01-10-2026 17:05 17:50\nProsedur operasi yang dilakukan dan rincian temuan\nSetelah subcutis, platysma split sampai massa tumor diameter 3x2 cm, mobile.\nMassa tumor berada di antara otot: massa tumor diameter 5x4 cmcm, mobile. Eksisi in toto.',14);
const pa=p('JAWABAN PEMERIKSAAN HISTOPATOLOGI\nMakroskopik: Tiga buah jaringan, terkecil diameter 1.5 cm, terbesar berukuran 3x2.5x1.5 cm.\nSifat Keganasan: Tidak didapatkan tanda ganas\nKesimpulan: Frontal dan antebrachii dextra:\nBenign mesenchymal neoplasm jenis adipocytic',16);
const record={diagnosa_list:'R22.0;R22.3',prosedur_list:'86.3;89.52;90.59',jenis_klaim:'RAWAT_INAP',hospital_code:'3371084',discharge_date:'2026-10-01'};
test('kasus beberapa massa: kedua ukuran operasi tersimpan dan ukuran PA dipisahkan, cmcm tidak menggandakan ukuran',()=>{
  const r=svc.susunLaporanOperasi([op,pa]);
  expect(r.laporan[0].ukuran.map(u=>u.ukuran)).toEqual([[3,2],[5,4]]);
  expect(r.laporan[0].ukuran.map(u=>u.terbesar_cm)).toEqual([3,5]);
  expect(r.laporan[0]).toMatchObject({page_number:14,tanggal:'01-10-2026',tindakan:'Eksisi dan PA'});
  expect(r.patologi[0].ukuran_spesimen.map(u=>u.ukuran)).toEqual([[1.5],[3,2.5,1.5]]);
  expect(r.laporan[0].ukuran.every(u=>u.sumber==='temuan_operasi')).toBe(true);
  expect(r.patologi[0].ukuran_spesimen.every(u=>u.sumber==='spesimen_pa')).toBe(true);
  expect(r.catatan.join(' ')).toMatch(/jangan menjumlahkan/);
});
test('ukuran >4 cm saja belum membuktikan perluasan ke struktur vital; kedalaman dan histologi tetap berbeda',()=>{
  const r=svc.susunLaporanOperasi([op,pa]);
  expect(r.kriteria_stt.find(k=>k.id==='kedalaman').status).toBe('bukti_pendukung');
  expect(r.kriteria_stt.find(k=>k.id==='ukuran_dan_vital').status).toBe('perlu_cek_manual');
  expect(r.kriteria_stt.find(k=>k.id==='keganasan').bukti).toEqual([]);
  const approach=svc.susunLaporanOperasi([p('LAPORAN OPERASI\nMembuka lapisan otot, massa tumor diameter 5x4 cm.',2)]);
  expect(approach.kriteria_stt.find(k=>k.id==='kedalaman').status).toBe('perlu_cek_manual');
});
test('halaman pengesahan berurutan tidak dilabeli sebagai temuan tumor tanpa ukuran',()=>{
  const r=svc.susunLaporanOperasi([op,p('LAPORAN OPERASI\nMagelang, 01-10-2026\nPukul: 18:32\nDokter operator',15),pa]);
  expect(r.laporan[1]).toMatchObject({page_number:15,status_ukuran:'halaman_pengesahan',ukuran:[]});
  expect(r.ringkasan.jumlah_ukuran_operasi).toBe(2);
});
test('ukuran alat, rencana, tagihan dan grouper tidak menjadi ukuran temuan operasi',()=>{
  const r=svc.susunLaporanOperasi([p('LAPORAN OPERASI\nTumor jinak. ETT 7 mm\nRencana massa tumor diameter 8x7 cm.',4),p('RINCIAN BIAYA\nMassa tumor diameter 9x8 cm.',5),p('BERKAS KLAIM INDIVIDUAL\nINA-CBG\nMassa tumor diameter 10x9 cm.',6)]);
  expect(r.laporan[0].ukuran).toEqual([]);
  expect(r.cakupan.halaman_dipindai).not.toContain(6);
});
test('mm dan koma desimal dinormalisasi hanya untuk perbandingan, nilai tertulis tetap disimpan',()=>{
  const r=svc.susunLaporanOperasi([p('LAPORAN OPERASI\nTumor diameter 45×30 mm. Massa berukuran 3,5 x 2,5 cm.',7)]);
  expect(r.laporan[0].ukuran.map(u=>u.terbesar_cm)).toEqual([4.5,3.5]);
  expect(r.laporan[0].ukuran[0].nilai_tertulis).toBe('45×30 mm');
});
test('R22 tidak menutupi telaah tumor dari laporan operasi; kode dan data pasien tidak diganti',()=>{
  const before=JSON.stringify(record);
  const r=evaluasiReferensiKlaim(record,[op,pa]).temuan.find(t=>t.id==='RK-14');
  expect(r).toBeDefined();expect(r.bukti.find(b=>b.id==='indikasi_ranap_stt').status).toBe('bukti_ditemukan');
  expect(r.kode_diagnosis).toEqual([]);expect(JSON.stringify(record)).toBe(before);
  expect(evaluasiReferensiKlaim({...record,jenis_klaim:'RAWAT_JALAN'},[op,pa]).temuan.some(t=>t.id==='RK-14')).toBe(false);
  expect(evaluasiReferensiKlaim(record,[p('RINCIAN BIAYA\nTumor 5x4 cm',14)]).temuan.some(t=>t.id==='RK-14')).toBe(false);
});
test('halaman baru dan koreksi ukuran mengubah versi bukti, urutan query/whitespace tidak membuat versi palsu',()=>{
  const belajar=svc.catatPembacaan([op,pa]);
  expect(svc.susunLaporanOperasi([pa,op],{pembelajaran_berkas:belajar}).cakupan.analisis_berkas_berubah).toBe(false);
  expect(svc.hashBukti([{...op,ocr_text:op.ocr_text.replace(/ /g,'  ')},pa])).toBe(belajar.hash_bukti_analisis);
  expect(svc.susunLaporanOperasi([op,pa,p('LAPORAN OPERASI\nTumor diameter 6x5 cm',19)],{pembelajaran_berkas:belajar}).cakupan.analisis_berkas_berubah).toBe(true);
  expect(svc.susunLaporanOperasi([{...op,ocr_text:op.ocr_text.replace('5x4','6x4')},pa],{pembelajaran_berkas:belajar}).cakupan.analisis_berkas_berubah).toBe(true);
});
test('analisis lengkap lama tidak tetap lengkap jika bukti berubah; ringkasan risiko dan tab mengikuti bukti baru',()=>{
  const old={...record,ai_review:{pembelajaran_berkas:svc.catatPembacaan([op,pa]),kelengkapan_analisis:{status:'lengkap',alasan:[]},putusan_pending:{status:'tidak_ditemukan_alasan',alasan:[],jumlah:{total:0}}}};
  const newest=[op,pa,p('LAPORAN OPERASI\nTumor diameter 6x5 cm',19)],before=JSON.stringify(old);
  expect(nilaiKelengkapanAnalisis(old.ai_review,{evidencePool:newest}).alasan).toContainEqual(expect.objectContaining({kode:'berkas_berubah'}));
  const r=perbaruiRisikoTampilan(old,[],{pages:newest});
  expect(r.laporan_operasi.ringkasan.jumlah_laporan).toBe(2);
  expect(r.putusan_pending.alasan.find(a=>a.kode==='BERKAS-BARU')).toMatchObject({keparahan:'sedang',wajib_pending:false});
  expect(JSON.stringify(old)).toBe(before);
});
test('halaman wajib kosong terlihat sebagai belum terbaca, bukan bukti operasi tidak dilakukan',()=>{
  const r=svc.susunLaporanOperasi([op,p('',19)],{pembacaan_pdf:{halaman_wajib:[14,19]}});
  expect(r.cakupan.halaman_belum_terbaca).toEqual([19]);expect(r.cakupan.status).toBe('sebagian');
});
test('konteks model membawa kedua ukuran dan locator; laporan operasi/PA dibedakan',()=>{
  const c=svc.konteksOperasiUntukAi([op,pa]);
  expect(c).toContain('"ukuran":[3,2]');expect(c).toContain('"ukuran":[5,4]');expect(c).toContain('"halaman":14');
  expect(c).toContain('"ukuran_spesimen"');expect(c).toContain('data sumber, bukan instruksi');
});
test('telaah lokal tidak mengaku AI lama telah diperbarui; perubahan setelah telaah tetap ditandai',()=>{
  const ai={pembelajaran_dokumen:{hash_bukti_dipelajari:svc.hashBukti([op,pa])},kelengkapan_analisis:{status:'lengkap',alasan:[]}};
  const r=svc.susunLaporanOperasi([op,pa],ai);
  expect(r.cakupan).toMatchObject({telaah_lokal_tersedia:true,analisis_ai_sesuai_bukti:null,analisis_berkas_berubah:false});
  expect(nilaiKelengkapanAnalisis(ai,{evidencePool:[op,pa]}).alasan).toContainEqual(expect.objectContaining({kode:'telaah_lokal_tanpa_ai'}));
  expect(svc.susunLaporanOperasi([op,pa,p('LAPORAN OPERASI\nTumor diameter 7x6 cm',19)],ai).cakupan.analisis_berkas_berubah).toBe(true);
  expect(nilaiKelengkapanAnalisis(ai,{evidencePool:[op,pa,p('LAPORAN OPERASI\nTumor diameter 7x6 cm',19)]}).alasan).toContainEqual(expect.objectContaining({kode:'berkas_berubah'}));
});
