const pnpk=require('../../data/kriteriaPnpk.json');
const {evaluasiBaPnpk}=require('../../services/baPnpkAnakService');
const {susunPutusan,memerlukanTelaah}=require('../../services/putusanPendingService');
const {bentukPutusan}=require('../../services/putusanPendingAiService');
const catalog=require('../../data/katalogPedoman.json');
const page=t=>({page_number:3,ocr_text:'RESUME MEDIS\n'+t});
const base={admission_date:'2026-10-01',discharge_date:'2026-10-05',umur_tahun:40,jenis_klaim:'RAWAT_INAP'};
const cases=[
 ['PNPK-HIPERTENSI-ANAK-DOK','I10','',10,'TD persentil 95'],
 ['PNPK-KATARAK-ANAK-DOK','H26.9','',10,'Lensa keruh'],
 ['PNPK-ULKUS-KORNEA-DOK','H16.0','',40,'Kornea defek epitel'],
 ['PNPK-SKIZOFRENIA-DOK','F20.9','',40,'Status mental: waham kejar\nPsikotik sejak 2 bulan'],
 ['PNPK-JIWA-DOK','F32.9','',40,'Status mental: mood depresi'],
 ['PNPK-SARKOPENIA-DOK','M62.8','',70,'Sarkopenia\nHandgrip: 12 kg\nBIA massa otot rendah'],
 ['PNPK-AKUPUNKTUR-DOK','R52.9','99.91',40,'Akupunktur titik LI4\nInformed consent ditandatangani'],
 ['PNPK-ANESTESI-DOK','R52.9','03.91',40,'Asesmen anestesi\nASA: II\nMallampati: 2\nInformed consent ditandatangani'],
 ['PNPK-NYERI-DOK','R52.9','',40,'Skala nyeri: 7'],
 ['PNPK-TRAUMA-DOK','S72.0','',40,'Primary survey: airway bebas, luka tungkai kanan'],
 ['PNPK-INFEKSI-ABD-DOK','K35.9','',40,'Nyeri tekan kuadran kanan bawah'],
 ['PNPK-PERIODONTAL-DOK','K05.3','',40,'Poket 5 mm'],
 ['PNPK-KARIES-DOK','K02.9','',40,'Gigi 36 kavitas sampai dentin'],
 ['PNPK-PULPA-DOK','K04.0','',40,'Perkusi positif'],
 ['PNPK-SEBOROIK-DOK','L21.9','',40,'Skuama pada kulit kepala'],
 ['PNPK-SUMBING-DOK','Q37.9','',10,'Celah bibir unilateral kiri'],
];
test.each(cases)('%s memeriksa dukungan nyata; diagnosis saja tidak lulus dan bukti ditemukan tetap meminta telaah klinis',(id,diagnosa_list,prosedur_list,umur_tahun,text)=>{
  const record={...base,diagnosa_list,prosedur_list,umur_tahun};
  const found=evaluasiBaPnpk(record,[page(text)]).find(t=>t.id===id);
  expect(found).toMatchObject({status:'perlu_cek_manual'});
  expect(found.bukti.every(b=>b.status==='bukti_ditemukan')).toBe(true);
  const putusan=susunPutusan({referensi_klaim:{temuan:[found]}});
  expect(memerlukanTelaah(putusan)).toBe(true);
  expect(bentukPutusan(putusan,{status:'tidak_ditemukan_alasan',alasan_ids:[]}).putusan.status).toBe('perlu_dicek');
  // Menyisakan pemicu konteks supaya pemeriksaan sarkopenia/anestesi tetap relevan.
  const kosong=evaluasiBaPnpk(record,[page(id.includes('SARKOPENIA')?'Diagnosis: sarkopenia':id.includes('ANESTESI')?'Asesmen anestesi':'Diagnosis tanpa temuan pemeriksaan')]).find(t=>t.id===id);
  expect(kosong.status).toBe('bukti_belum_cukup');
});
test('seluruh 78 aturan memiliki sumber, halaman yang tersedia dan tidak menyatakan bukti ditemukan dari berkas kosong',()=>{
  expect(pnpk.aturan).toHaveLength(78);
  for (const a of pnpk.aturan) {
    const d=catalog.dokumen.find(d=>d.id===a.katalog_id);
    expect(d).toBeDefined();
    expect(a.halaman.every(p=>Number.isInteger(p)&&p>0&&p<=d.berkas[0].jumlah_halaman)).toBe(true);
    const diagnosis=(a.dx||[]).map(p=>p.startsWith('^')?'F20.9':p);
    const r={...base,diagnosa_list:diagnosis.join(';'),prosedur_list:(a.px||[]).join(';'),umur_tahun:a.usia_max??a.usia_min??40,umur_hari:a.neonatus?2:undefined};
    const t=evaluasiBaPnpk(r,[]).find(t=>t.id===a.id);
    if(t) expect(t.status).not.toBe('bukti_ditemukan');
  }
});
test('12 pemetaan menunjuk aturan riil; versi yang digantikan tidak dianggap aturan klinis aktif',()=>{
  const all=[...pnpk.aturan,...require('../../data/baPnpkAnak.json').aturan,...require('../../data/referensiKesesuaianKlaim.json').aturan,...require('../../data/baTkmkb2025.json').aturan,...require('../../data/baTkmkb2025.json').pelengkap_aturan];
  expect(pnpk.tanpa_aturan).toHaveLength(0);expect(pnpk.pemetaan_aturan).toHaveLength(12);
  for(const m of pnpk.pemetaan_aturan)for(const id of m.aturan_ids)expect(all.some(a=>a.id===id)).toBe(true);
});
test('rujukan informasi PNPK tidak berubah menjadi alasan pending mandiri',()=>{
  const t=evaluasiBaPnpk({...base,diagnosa_list:'J44.9'},[page('Spirometri FEV1/FVC 55%')]).find(t=>t.id==='PNPK-PPOK-01');
  expect(t.tanpa_putusan).toBe(true);
  expect(susunPutusan({referensi_klaim:{temuan:[t]}}).alasan).toEqual([]);
});
test('detektor dokumentasi mengabaikan rencana, resep dan kasus yang tidak terkait',()=>{
  const r={...base,diagnosa_list:'K04.0'};
  expect(evaluasiBaPnpk(r,[page('Rencana perkusi positif')]).find(t=>t.id==='PNPK-PULPA-DOK').status).toBe('bukti_belum_cukup');
  expect(evaluasiBaPnpk(r,[{page_number:3,ocr_text:'RESEP\nPerkusi positif'}]).find(t=>t.id==='PNPK-PULPA-DOK').status).toBe('belum_dapat_dinilai');
  expect(evaluasiBaPnpk({...base,diagnosa_list:'N39.0'},[page('Perkusi positif')]).some(t=>t.id==='PNPK-PULPA-DOK')).toBe(false);
});
