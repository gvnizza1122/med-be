const ai=require('../../services/anggaranAiService');
const gateway=require('../../services/gatewayModelService');
const ctx=require('../../services/konteksPenggunaanAiService');
const router=require('../../services/routerModelService');
const {batasBiaya,normalisasiPenggunaan,estimasiBiaya}=require('../../services/biayaModelService');
const fs=require('fs'),os=require('os'),path=require('path');

function database(spent=0) {
  const row={id:'b',hospital_code:'RS',target_idr:500,batas_idr:600,terpakai_idr:spent,dicadangkan_idr:0,belum_pasti_idr:0,gagal_idr:0,tambahan_alasan:[]};
  const cache=new Map(),failed=new Map(),logs=[];
  const db={row,cache,failed,logs,query:async()=>({}),
    get:async(sql,p=[])=>{
      if(sql.includes('router_model')) return null;
      if(sql.startsWith('UPDATE ai_anggaran_berkas')) {
        const [value,optional,, , ,alasan,id,hospital,second,,normal,kritis,cap]=p;
        const limit=optional?Math.min(row.target_idr,normal-175):kritis || row.gagal_idr===0 && row.belum_pasti_idr===0?Math.max(row.batas_idr,cap):row.batas_idr;
        const total=row.terpakai_idr+row.belum_pasti_idr+row.dicadangkan_idr+second;
        if(id!==row.id || hospital!==row.hospital_code || total>limit) return null;
        if(!optional && total>row.batas_idr) {row.tambahan_alasan.push(...JSON.parse(alasan));row.batas_idr=Math.ceil(total);}
        row.dicadangkan_idr+=value;return {id};
      }
      if(sql.startsWith('INSERT INTO ai_kegagalan_berkas')) {
        const previous=failed.get(p[0]);
        if(previous && !(previous.scope===p[1] && ((previous.kode==='terputus_restart' && p[2]==='permintaan_ulang_setelah_restart') || (previous.kode==='ulang_disetujui_pengguna' && p[2]==='permintaan_ulang_disetujui'))))return null;
        failed.set(p[0],{scope:p[1],kode:p[2]||'permintaan_sedang_berjalan'});return {kunci:p[0]};
      }
      if(sql.startsWith('DELETE FROM ai_kegagalan_berkas')) {const f=failed.get(p[0]);if(f?.scope===p[1]&&f.kode==='terputus_restart'){failed.delete(p[0]);return {kunci:p[0]};}return null;}
      if(sql.includes('FROM ai_kegagalan_berkas')) return failed.get(p[0])?.scope===p[1] ? {kode:failed.get(p[0]).kode} : null;
      if(sql.includes('FROM ai_cache_berkas')) return cache.get(p[0])?.scope===p[1] ? {jawaban:cache.get(p[0]).value} : null;
      if(sql.includes('FROM ai_anggaran_berkas')) return p[0]===row.id && p[1]===row.hospital_code ? {...row} : null;
      return null;
    },
    run:async(sql,p=[])=>{
      if(sql.startsWith('UPDATE ai_anggaran_berkas')) {row.dicadangkan_idr=Math.max(0,row.dicadangkan_idr-p[0]);row.terpakai_idr+=p[1];row.belum_pasti_idr+=p[2];row.gagal_idr+=p[3];}
      if(sql.startsWith('DELETE FROM ai_kegagalan_berkas') && failed.get(p[0])?.scope===p[1]) failed.delete(p[0]);
      if(sql.startsWith('INSERT INTO ai_kegagalan_berkas')) failed.set(p[0],{scope:p[1],kode:p[2]});
      if(sql.startsWith('INSERT INTO ai_cache_berkas')) cache.set(p[0],{scope:p[1],value:JSON.parse(p[2])});
      if(sql.startsWith('INSERT INTO catatan_panggilan_model')) logs.push(p);
      return {changes:1};
    }};
  return db;
}
const scope={id:'b',hospital_code:'RS'};
const payload={system:'Periksa bukti, jangan mengarang.',prompt:'Resume medis. Diagnosis akhir dokter tertulis.',json:true};
const answer=()=>({content:JSON.stringify({hasil:'bukti diperiksa'}),usage:{prompt_tokens:1200,completion_tokens:1800,total_tokens:3000},finish_reason:'stop'});
const call=(db,task='baca_berkas',p=payload)=>ctx.jalankan({hospital_code:'RS',record_id:'r',anggaran_ai:scope},()=>gateway.panggilModel(task,p,{db}));
let restore;
beforeEach(()=>{process.env.AI_MODEL='gpt-6-luna';process.env.AI_REVIEW_MODEL='gpt-6.1-sol';router.hapusCache();});
afterEach(()=>{restore?.();restore=null;});

test('reservasi atomik mencegah 100 panggilan paralel melewati Rp600',async()=>{
  const db=database(); const result=await Promise.all(Array.from({length:100},()=>ai.cadangkan(db,scope,80)));
  expect(result.filter(Boolean)).toHaveLength(7);expect(db.row.dicadangkan_idr).toBe(560);
});
test('alat tambahan menyisakan anggaran untuk pemeriksaan wajib',async()=>{
  const db=database(420);expect(await ai.cadangkan(db,scope,10,true)).toBe(false);
  expect(await ai.cadangkan(db,scope,100,false)).toBe(true);
});
test('reservasi tidak dapat memakai anggaran RS lain',async()=>{
  const db=database();expect(await ai.cadangkan(db,{...scope,hospital_code:'OTHER'},1)).toBe(false);
  expect(db.row.dicadangkan_idr).toBe(0);
});
test('biaya aktual melepaskan sisa reservasi tanpa menghapus biaya jawaban gagal',async()=>{
  const db=database();await ai.cadangkan(db,scope,150);
  await ai.lunasi(db,scope,150,{biaya:{idr:30},usageKnown:true});
  expect(db.row).toMatchObject({terpakai_idr:30,dicadangkan_idr:0,belum_pasti_idr:0});
});
test('timeout tetap diperhitungkan secara konservatif dan tidak dianggap gratis',async()=>{
  const db=database();await ai.cadangkan(db,scope,150);await ai.lunasi(db,scope,150,{usageKnown:false});
  expect((await ai.ringkasan(db,scope))).toMatchObject({terpakai_idr:0,belum_pasti_idr:150,sisa_idr:450});
});
test('tahap klinis menggunakan reasoning tinggi dan tanpa batas completion aplikasi',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const result=await call(db);expect(result.ok).toBe(true);expect(result.effort).toBe('high');
  expect(fn.mock.calls[0][0]).toMatchObject({reasoningEffort:'high',completionLimit:undefined});
  expect(db.row.terpakai_idr).toBeGreaterThan(0);expect(db.row.dicadangkan_idr).toBe(0);
});
test('20 permintaan identik hanya memanggil penyedia sekali; hasil berikutnya tidak menambah token/biaya',async()=>{
  const db=database(),fn=jest.fn(async()=>{await new Promise(r=>setTimeout(r,10));return answer();});restore=gateway.pasangAdapter('openai_compat',fn);
  const results=await Promise.all(Array.from({length:20},()=>call(db)));
  expect(results.every(r=>r.ok)).toBe(true);expect(fn).toHaveBeenCalledTimes(1);expect(db.logs).toHaveLength(1);
  expect(results.filter(r=>r.dari_cache)).toHaveLength(19);
  const spent=db.row.terpakai_idr;const reused=await call(db);
  expect(reused).toMatchObject({ok:true,dari_cache:true,penggunaan:{total_tokens:0}});expect(db.row.terpakai_idr).toBe(spent);
});
test('perubahan bukti atau instruksi tidak memakai hasil cache lama',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  await call(db);await call(db,'baca_berkas',{...payload,prompt:payload.prompt+' Bukti baru.'});
  await call(db,'baca_berkas',{...payload,system:'Aturan diperbarui.'});expect(fn).toHaveBeenCalledTimes(3);
});
test('plafon lama yang habis tidak menahan penyelesaian analisis',async()=>{
  const db=database(1499),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db)).toMatchObject({ok:true});expect(fn).toHaveBeenCalledTimes(1);expect(db.logs).toHaveLength(1);
});
test('plafon lama tidak mengganti model tinjauan mendalam',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const r=await call(db,'tinjau_kasus_lanjutan');expect(r).toMatchObject({ok:true,model:'gpt-6.1-sol',effort:'high'});
});
test('tarif yang belum tersedia tidak menahan analisis, penggunaan tetap dicatat',async()=>{
  process.env.AI_MODEL='unknown-model';router.hapusCache();const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db)).toMatchObject({ok:true});expect(fn).toHaveBeenCalledTimes(1);
});
test.each(['length','empty','bad_json','{}','[]','null'])('jawaban %s tidak masuk cache dan biayanya tetap tercatat',async kind=>{
  const db=database(),fn=jest.fn(async()=>({...answer(),finish_reason:kind==='length'?'length':'stop',content:kind==='empty'?'':kind==='bad_json'?'tidak JSON':['{}','[]','null'].includes(kind)?kind:answer().content}));
  restore=gateway.pasangAdapter('openai_compat',fn);expect((await call(db)).ok).toBe(false);
  expect(fn).toHaveBeenCalledTimes(1);expect(db.cache.size).toBe(0);expect(db.row.terpakai_idr).toBeGreaterThan(0);expect(db.logs).toHaveLength(1);
});
test('timeout tidak mengulang permintaan otomatis dan cadangannya tetap terlihat',async()=>{
  const db=database(),fn=jest.fn(async()=>{throw Error('timeout');});restore=gateway.pasangAdapter('openai_compat',fn);
  expect((await call(db)).ok).toBe(false);expect(fn).toHaveBeenCalledTimes(1);
  expect([...db.failed.values()][0].kode).toBe('biaya_belum_pasti');expect(db.row.dicadangkan_idr).toBe(0);
});
test('429 dicoba ulang hanya pada tahap yang sama, tanpa biaya fiktif pada penolakan',async()=>{
  const db=database(),fn=jest.fn().mockRejectedValueOnce(Object.assign(Error('429'),{status:429,definiteNoCharge:true})).mockResolvedValueOnce(answer());
  restore=gateway.pasangAdapter('openai_compat',fn);expect((await call(db)).ok).toBe(true);
  expect(fn).toHaveBeenCalledTimes(2);expect(db.logs).toHaveLength(2);expect(db.row.belum_pasti_idr).toBe(0);
});
test('batas byte memperhitungkan UTF-8, penalaran, cache write, dan konteks panjang',()=>{
  const bound=batasBiaya('gpt-6-luna','Instruksi','脈搏 '.repeat(10000),12000);
  const real=estimasiBiaya('gpt-6-luna',normalisasiPenggunaan({prompt_tokens:40000,completion_tokens:12000,prompt_tokens_details:{cache_write_tokens:40000}}));
  expect(bound.idr).toBeGreaterThan(real.idr);
  expect(batasBiaya('gpt-6.1-sol','', 'a'.repeat(300000),8000).idr).toBeGreaterThan(600);
});
test('cache write yang belum dirinci memakai batas tarif input konservatif dalam anggaran',()=>{
  const u=normalisasiPenggunaan({prompt_tokens:10000,completion_tokens:2000});
  expect(gateway.biayaUntukAnggaran('gpt-6-luna',u,'openai_compat',{},scope).idr).toBeCloseTo(40.5);
  expect(gateway.biayaUntukAnggaran('gpt-6-luna',u,'openai_compat',{prompt_tokens_details:{cache_write_tokens:0}},scope).idr).toBeCloseTo(36);
});
test('isi PDF sama tetap memakai anggaran yang sama saat nama atau kategori berubah',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sidik-anggaran-'));
  try {
    const a=path.join(dir,'a.pdf'),b=path.join(dir,'b.pdf');fs.writeFileSync(a,'isi simulasi');fs.copyFileSync(a,b);
    expect(await ai.sidikBerkas(a,['RAWAT_INAP'])).toBe(await ai.sidikBerkas(b,['RAWAT_JALAN','RAWAT_INAP']));
    fs.writeFileSync(b,'berubah');expect(await ai.sidikBerkas(b,[])).not.toBe(await ai.sidikBerkas(a,[]));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('jawaban tidak digunakan lintas kategori walau anggaran PDF sama',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  await call(db,'baca_berkas',{...payload,jenisKlaim:'RAWAT_INAP'});
  await call(db,'baca_berkas',{...payload,jenisKlaim:'RAWAT_JALAN'});
  expect(fn).toHaveBeenCalledTimes(2);
});

test('tahap klinis wajib dapat menambah secukupnya tanpa memakai plafon mendalam',async()=>{
  const db=database(599),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db)).toMatchObject({ok:true,model:'gpt-6-luna'});
  expect(db.row.batas_idr).toBe(600);expect(db.row.terpakai_idr).toBeGreaterThan(599);
});
test('klarifikasi bukti memungkinkan Sol high dengan ruang penalaran lebih besar',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const r=await call(db,'tinjau_kasus_lanjutan',{...payload,pemicuPendalaman:['diagnosis_atau_urutan_belum_jelas']});
  expect(r).toMatchObject({ok:true,model:'gpt-6.1-sol',effort:'high'});
  expect(fn.mock.calls[0][0].completionLimit).toBeUndefined();
  expect(fn.mock.calls[0][0].timeoutMs).toBe(0);
  expect(db.row.batas_idr).toBe(600);
});
test('sampel kualitas mengikuti model yang dipilih',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db,'tinjau_kasus_lanjutan',{...payload,pemicuPendalaman:['sampel_kualitas']})).toMatchObject({ok:true,model:'gpt-6.1-sol'});
  expect(db.row.batas_idr).toBe(600);
});
test('hasil Sol tersimpan tetap gratis ketika anggaran habis',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const p={...payload,pemicuPendalaman:['permintaan_koder']};
  await call(db,'tinjau_kasus_lanjutan',p);db.row.terpakai_idr=5000;
  expect(await call(db,'tinjau_kasus_lanjutan',p)).toMatchObject({ok:true,model:'gpt-6.1-sol',dari_cache:true,penggunaan:{total_tokens:0}});
  expect(fn).toHaveBeenCalledTimes(1);expect(db.row.terpakai_idr).toBe(5000);
});
test('hasil pendalaman lengkap tetap dipakai gratis',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  await call(db,'tinjau_kasus_lanjutan');
  expect(await call(db,'tinjau_kasus_lanjutan',{...payload,pemicuPendalaman:['permintaan_koder']})).toMatchObject({ok:true,model:'gpt-6.1-sol',dari_cache:true});
  expect(fn).toHaveBeenCalledTimes(1);
});
test.each(['timeout','invalid'])('kegagalan %s persisten mencegah panggilan identik berikutnya',async kind=>{
  const db=database(),fn=jest.fn(async()=>{if(kind==='timeout')throw Error('timeout');return {...answer(),content:'{}'};});restore=gateway.pasangAdapter('openai_compat',fn);
  expect((await call(db)).ok).toBe(false);expect(db.failed.size).toBe(1);
  const before=db.row.terpakai_idr+db.row.belum_pasti_idr;
  expect(await call(db)).toMatchObject({ok:false,kode:'pengulangan_berbiaya_dicegah'});
  expect(fn).toHaveBeenCalledTimes(1);expect(db.row.terpakai_idr+db.row.belum_pasti_idr).toBe(before);
});
test.each(['unknown','failed'])('tambahan biaya tidak dibuka karena kegagalan %s',async kind=>{
  const db=database(599);db.row[kind==='unknown'?'belum_pasti_idr':'gagal_idr']=1;
  expect(await ai.cadangkan(db,scope,100,false,{klinis:true})).toBe(false);expect(db.row.batas_idr).toBe(600);
});
test('100 reservasi mendalam tetap atomik dan dibatasi Rp5000',async()=>{
  const db=database();const result=await Promise.all(Array.from({length:100},()=>ai.cadangkan(db,scope,600,false,{pendalaman:true})));
  expect(result.filter(Boolean)).toHaveLength(8);expect(db.row.dicadangkan_idr).toBe(4800);expect(db.row.batas_idr).toBe(4800);
});
test('reservasi aktif ditunggu sebelum membuka anggaran tambahan yang sebenarnya tidak perlu',async()=>{
  const db=database();const done=await ai.cadangkanSaatSiap(db,scope,450,false,{klinis:true});
  let secondReady=false;const second=ai.cadangkanSaatSiap(db,scope,450,false,{klinis:true}).then(r=>{secondReady=true;return r;});
  await new Promise(r=>setTimeout(r,5));expect(secondReady).toBe(false);expect(db.row.batas_idr).toBe(600);
  await ai.lunasi(db,scope,450,{usageKnown:true,biaya:{idr:30}});done();const done2=await second;
  expect(done2).toEqual(expect.any(Function));expect(db.row.batas_idr).toBe(600);
  await ai.lunasi(db,scope,450,{usageKnown:true,biaya:{idr:30}});done2();
});
test.each([-1,0,NaN,Infinity])('reservasi tidak menerima nilai tidak sah %s',async nilai=>{
  const db=database();expect(await ai.cadangkan(db,scope,nilai,false,{pendalaman:true})).toBe(false);expect(db.row.dicadangkan_idr).toBe(0);
});

test('penanda permintaan persisten mencegah pembayaran ganda sesudah proses terputus',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const key=ai.kunciCache(scope,'baca_berkas',{penyedia:'openai_compat',model:'gpt-6-luna'},payload.system,payload.prompt,'high',12000);
  expect(await ai.mulaiPanggilan(db,key,scope)).toBe(true);
  expect(await ai.mulaiPanggilan(db,key,scope)).toBe(false);
  expect(await call(db)).toMatchObject({ok:false,kode:'pengulangan_berbiaya_dicegah'});
  expect(fn).not.toHaveBeenCalled();expect(db.logs).toHaveLength(0);
});
test('kegagalan menyimpan cache tidak mengirim ulang jawaban yang sudah berbiaya',async()=>{
  const db=database(),run=db.run;db.run=async(sql,p)=>{if(sql.startsWith('INSERT INTO ai_cache_berkas'))throw Error('database unavailable');return run(sql,p);};
  const fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect((await call(db)).ok).toBe(false);
  expect(await call(db)).toMatchObject({ok:false,kode:'pengulangan_berbiaya_dicegah'});expect(fn).toHaveBeenCalledTimes(1);
});
test('20 pendalaman serentak memakai satu Sol dan metadata model yang sama',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const p={...payload,pemicuPendalaman:['permintaan_koder']};
  const results=await Promise.all(Array.from({length:20},()=>call(db,'tinjau_kasus_lanjutan',p)));
  expect(results.every(r=>r.ok && r.model==='gpt-6.1-sol')).toBe(true);expect(fn).toHaveBeenCalledTimes(1);
  expect(results.filter(r=>r.dari_cache)).toHaveLength(19);
});

test('model yang dipilih tidak diganti berdasarkan plafon lama',async()=>{
  const db=database();db.row.batas_idr=4500;const fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db,'tinjau_kasus_lanjutan',{...payload,pemicuPendalaman:['sampel_kualitas']})).toMatchObject({ok:true,model:'gpt-6.1-sol'});
});

test('pendalaman terpicu tetap dapat memakai Luna hemat setelah biaya tahap sebelumnya melampaui Rp1500',async()=>{
  process.env.AI_REVIEW_MODEL='gpt-6-luna';router.hapusCache();
  const db=database(1499),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db,'tinjau_kasus_lanjutan',{...payload,pemicuPendalaman:['permintaan_koder']})).toMatchObject({ok:true,model:'gpt-6-luna',effort:'high'});
  expect(db.row.terpakai_idr).toBeGreaterThan(1499);
});

// KASUS ACUAN SLE (0000R0000126V000003): server dimulai ulang saat permintaan AI
// berjalan; penanda yang tertinggal dulu memblokir tahap itu selamanya.
test('permintaan yang terputus karena server dimulai ulang dikirim ulang tepat satu kali',async()=>{
  const db=database();
  const key=ai.kunciCache(scope,'baca_berkas',{penyedia:'openai_compat',model:'gpt-6-luna'},payload.system,payload.prompt,'high',12000);
  db.failed.set(key,{scope:'b',kode:'terputus_restart'});
  let kodeSaatKirim=null;
  const fn=jest.fn(async()=>{kodeSaatKirim=db.failed.get(key)?.kode;return answer();});restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db)).toMatchObject({ok:true});
  expect(fn).toHaveBeenCalledTimes(1);
  expect(kodeSaatKirim).toBe('permintaan_ulang_setelah_restart');
  expect(db.failed.has(key)).toBe(false);
});
test('percobaan ulang setelah restart yang terputus lagi tetap diblokir',async()=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const key=ai.kunciCache(scope,'baca_berkas',{penyedia:'openai_compat',model:'gpt-6-luna'},payload.system,payload.prompt,'high',12000);
  db.failed.set(key,{scope:'b',kode:'biaya_belum_pasti'});
  expect(await call(db)).toMatchObject({ok:false,kode:'pengulangan_berbiaya_dicegah'});
  expect(fn).not.toHaveBeenCalled();
});
test('restart dapat dipulihkan meskipun plafon lama habis',async()=>{
  const db=database(1500),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  const key=ai.kunciCache(scope,'baca_berkas',{penyedia:'openai_compat',model:'gpt-6-luna'},payload.system,payload.prompt,'high',12000);
  db.failed.set(key,{scope:'b',kode:'terputus_restart'});
  expect(await call(db)).toMatchObject({ok:true});
  expect(db.failed.has(key)).toBe(false);
  expect(fn).toHaveBeenCalledTimes(1);
});
test('100 pekerja hanya dapat mengklaim satu percobaan ulang setelah restart',async()=>{
  const db=database();db.failed.set('restart',{scope:'b',kode:'terputus_restart'});
  const result=await Promise.all(Array.from({length:100},()=>ai.mulaiPanggilan(db,'restart',scope,'permintaan_ulang_setelah_restart')));
  expect(result.filter(Boolean)).toHaveLength(1);
  expect(db.failed.get('restart').kode).toBe('permintaan_ulang_setelah_restart');
});
test('penanda restart tidak dapat diklaim oleh RS lain atau sebagai panggilan baru',async()=>{
  const db=database();db.failed.set('restart',{scope:'b',kode:'terputus_restart'});
  expect(await ai.mulaiPanggilan(db,'restart',{id:'other',hospital_code:'OTHER'},'permintaan_ulang_setelah_restart')).toBe(false);
  expect(await ai.mulaiPanggilan(db,'restart',scope)).toBe(false);
  expect(db.failed.get('restart').kode).toBe('terputus_restart');
});
test.each([[13000,13000],[30000,16000],[3000,8000]])('batas keluaran lama %s tidak diteruskan ke penyedia',async(minta,harap)=>{
  const db=database(),fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect((await call(db,'agen_tinjau',{...payload,prioritasKlinis:true,batasKeluaran:minta})).ok).toBe(true);
  expect(fn.mock.calls[0][0].completionLimit).toBeUndefined();
});

test('pemulihan yang diminta pengguna hanya memberi satu kesempatan ulang',async()=>{
  const db=database();
  const key=ai.kunciCache(scope,'baca_berkas',{penyedia:'openai_compat',model:'gpt-6-luna'},payload.system,payload.prompt,'high',12000);
  db.failed.set(key,{scope:'b',kode:'ulang_disetujui_pengguna'});
  const fn=jest.fn(async()=>{throw Error('koneksi putus');});restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db)).toMatchObject({ok:false});
  expect(await call(db)).toMatchObject({ok:false,kode:'pengulangan_berbiaya_dicegah'});
  expect(fn).toHaveBeenCalledTimes(1);
});

test('pemeriksa kritis tetap berjalan dengan biaya lama belum pasti tanpa menghapus biayanya',async()=>{
  const db=database(339);db.row.belum_pasti_idr=124;
  expect(await ai.cadangkan(db,scope,200,false,{klinis:true})).toBe(false);
  expect(await ai.cadangkan(db,scope,200,false,{klinis:true,kritis:true})).toBe(true);
  expect(db.row.belum_pasti_idr).toBe(124);expect(db.row.batas_idr).toBe(663);
  expect(await ai.cadangkan(db,scope,838,false,{klinis:true,kritis:true})).toBe(false);
});
test('gateway hanya memberi ruang pemeriksa kritis pada tugas tinjauan yang ditandai',async()=>{
  const db=database(550);db.row.belum_pasti_idr=40;
  const fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
  expect(await call(db,'agen_tinjau',{...payload,prioritasKlinis:true,pemeriksaKritis:true})).toMatchObject({ok:true});
  expect(db.row.belum_pasti_idr).toBe(40);expect(db.row.batas_idr).toBeLessThanOrEqual(1500);
});

test('kritik berkas panjang mendapat 16000 token dengan batas biaya klinis',async()=>{
 const db=database(480);db.row.gagal_idr=124;db.row.belum_pasti_idr=145;
 const fn=jest.fn(async()=>answer());restore=gateway.pasangAdapter('openai_compat',fn);
 expect(await call(db,'agen_tinjau',{...payload,prioritasKlinis:true,pemeriksaKritis:true,batasKeluaran:16000})).toMatchObject({ok:true});
 expect(fn.mock.calls[0][0]).toMatchObject({completionLimit:undefined,reasoningEffort:'high',timeoutMs:0});
 expect(db.row.batas_idr).toBeLessThanOrEqual(1500);expect(db.row.belum_pasti_idr).toBe(145);expect(db.row.gagal_idr).toBe(124);
});
