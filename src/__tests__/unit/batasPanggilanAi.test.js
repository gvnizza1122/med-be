const {jalankan}=require('../../services/batasPanggilanAiService');
test('300 panggilan dibatasi enam slot; gagal satu permintaan tidak menghentikan antrean',async()=>{
  const old=process.env.AI_CALL_CONCURRENCY;process.env.AI_CALL_CONCURRENCY='6';
  let active=0,peak=0,done=0;
  try {
    const hasil=await Promise.allSettled(Array.from({length:300},(_,i)=>jalankan(async()=>{
      active++;peak=Math.max(peak,active);
      try {await new Promise(r=>setTimeout(r,1));if(i===77)throw Error('gangguan tiruan');done++;return i;}
      finally{active--;}
    })));
    expect(peak).toBe(6);expect(active).toBe(0);expect(done).toBe(299);
    expect(hasil.filter(r=>r.status==='rejected')).toHaveLength(1);
  } finally {if(old===undefined)delete process.env.AI_CALL_CONCURRENCY;else process.env.AI_CALL_CONCURRENCY=old;}
});
