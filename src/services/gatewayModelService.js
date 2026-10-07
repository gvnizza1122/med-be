/**
 * Gateway model — pintu tipis `panggilModel(tugas, payload)`.
 *
 * Urutan tiap panggilan:
 *   1. routerModelService.resolve(tugas)  -> penyedia + model (fallback env)
 *   2. penyamaranService                  -> samarkan prompt SEBELUM keluar
 *   3. adapter penyedia                   -> kirim (fetch, kompatibel OpenAI)
 *   4. pulihkan token di jawaban          -> identitas kembali hanya di sisi kita
 *   5. catatanPanggilanModelService.catat -> metadata saja, tanpa isi
 *
 * SIFAT KEAMANAN
 *  - Tidak ada teks mentah yang sampai ke penyedia tanpa lewat penyamar.
 *  - Isi prompt/jawaban tidak pernah dicatat; pesan error dipotong dan tidak
 *    memuat prompt.
 *  - Kegagalan tidak dilempar: kembalikan {ok:false, error}. Pemanggil harus
 *    menangani ok=false (sama seperti callAi lama yang mengembalikan null).
 *  - Model yang belum lulus uji tetap dipanggil; `peringatan` diteruskan.
 *  - Jawaban model TIDAK otomatis dipercaya: kewajiban kutipan dan cek tabel
 *    rujukan tetap di sisi pemanggil (lihat bacaKeduaService).
 *
 * STATUS PENGUJIAN
 *  - Adapter 'openai_compat' meniru bentuk request callAi() yang sudah hidup.
 *  - Adapter 'kimi' BELUM PERNAH diuji terhadap API Kimi K3 sungguhan
 *    (tidak ada kunci saat dibangun); hanya diuji dengan fetch tiruan.
 *    Bentuk request mengikuti kimiClient.js (chat/completions ala OpenAI).
 */

const routerModel = require('./routerModelService');
const catatan = require('./catatanPanggilanModelService');
const { buatPenyamar } = require('./penyamaranService');
const { normalisasiPenggunaan, estimasiBiaya, batasBiaya } = require('./biayaModelService');
const konteksAi = require('./konteksPenggunaanAiService');
const anggaranAi = require('./anggaranAiService');
const batasPanggilan = require('./batasPanggilanAiService');

function effortUntuk(model, tugas) {
  if (model === 'gpt-6-luna') return tugas === 'ekstrak_pdf' ? 'low' : 'medium';
  if (model === 'gpt-6.1-sol') return 'high';
  return undefined;
}

// Adapter bisa diganti (tes, atau penyedia baru) tanpa menyentuh gateway.
const adapter = {
  openai_compat: (p) => panggilChatCompletions({
    apiKey: process.env.AI_PROVIDER_API_KEY,
    baseUrl: process.env.AI_PROVIDER_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),
    label: 'AI',
    ...p,
  }),
  kimi: (p) => panggilChatCompletions({
    apiKey: process.env.KIMI_API_KEY,
    baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    timeoutMs: Number(process.env.KIMI_TIMEOUT_MS || 60000),
    label: 'Kimi',
    ...p,
  }),
};

function pasangAdapter(nama, fn) {
  const asli = adapter[nama];
  adapter[nama] = fn;
  return () => { adapter[nama] = asli; };
}

async function panggilChatCompletions({ apiKey, baseUrl, timeoutMs, label, model, system, prompt, json, maxTokens, reasoningEffort, completionLimit, fetchImpl }) {
  if (!apiKey) {
    const e = new Error(`API key ${label} belum disetel`);
    e.kode = 'tanpa_kunci';
    throw e;
  }
  const doFetch = fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    // Batas completion mencakup penalaran DAN jawaban JSON. Sediakan ruang
    // penalaran agar jawaban tidak terpotong, tanpa meminta penalaran mentah.
    const minimum = reasoningEffort === 'high' ? 16000 : reasoningEffort === 'medium' ? 8000 : 3000;
    const body = { model, messages, max_completion_tokens: completionLimit || (reasoningEffort ? Math.max(maxTokens || 3000, minimum) : (maxTokens || 3000)) };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (json) body.response_format = { type: 'json_object' };
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const respText = await response.text();
    if (!response.ok) {
      const e=new Error(`HTTP ${response.status}: penyedia belum berhasil memproses permintaan`);
      e.status=response.status; e.kode='http_penyedia';
      e.definiteNoCharge=[400,401,403,404,422,429].includes(response.status);
      throw e;
    }
    const data = JSON.parse(respText);
    const content = data.choices?.[0]?.message?.content || '';
    // Penggunaan tetap diteruskan bila JSON kosong/terpotong: biaya terjadi.
    return { content, usage: data.usage || {}, finish_reason:data.choices?.[0]?.finish_reason || null };
  } finally {
    clearTimeout(timer);
  }
}

function urai(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try { return JSON.parse(m[0]); } catch { return undefined; }
  }
}

function biayaUntukAnggaran(model,usage,provider,rawUsage,scope) {
  if(scope && !Number.isFinite(rawUsage?.prompt_tokens_details?.cache_write_tokens)) {
    const b=estimasiBiaya(model,{...usage,cache_write_tokens:usage.prompt_tokens-usage.cached_tokens},provider);
    return b ? {...b,dasar:`${b.dasar}_cache_write_belum_dirinci`} : null;
  }
  return estimasiBiaya(model,usage,provider);
}

/**
 * @param {string} tugas salah satu routerModelService.TUGAS
 * @param {object} payload
 *   { prompt: string, system?: string, dikenal?: object (identitas klaim),
 *     json?: boolean, maxTokens?: number, versi?: string, fetchImpl?: fn }
 * @param {{db?: object}} [opsi] db untuk router & catatan (opsional)
 * @returns {Promise<{ok:boolean, teks?:string, hasil?:any, penyedia:string, model:string,
 *                    sumber:string, peringatan:string|null, error?:string, durasi_ms:number}>}
 */
async function panggilModel(tugas, payload, opsi = {}) {
  const db = opsi.db || null;
  const mulai = Date.now();
  let rute = await routerModel.resolve(db, tugas);
  const scope = konteksAi.saatIni().anggaran_ai;
  // Tahap klinis memakai penalaran tinggi. Pendalaman yang terpicu bukti
  // mendapat ruang biaya tambahan, tanpa mengulang jawaban yang sudah tersedia.
  let reasoningEffort = effortUntuk(rute.model, tugas);
  const klinis=payload?.prioritasKlinis===true || ['baca_berkas','tinjau_kasus_lanjutan','putuskan_pending'].includes(tugas);
  if(scope && klinis && rute.model==='gpt-6-luna') reasoningEffort='high';
  let completionLimit = scope ? (tugas==='ekstrak_pdf' ? 4000 : tugas==='baca_berkas' ? 12000 : klinis ? 8000 : 6000) : undefined;
  const alasanMendalam=new Set(['tinjauan_awal_belum_terverifikasi','diagnosis_atau_urutan_belum_jelas','dukungan_diagnosis_perlu_klarifikasi','diagnosis_bertentangan_dengan_bukti','prosedur_dan_bukti_perlu_ditinjau','risiko_klinis_perlu_penafsiran','kriteria_igd_borderline','alasan_pending_belum_tegas','inacbg_atau_tarif_belum_pasti','agen_belum_yakin','keberatan_kritis_berat','permintaan_koder']);
  const pendalaman=tugas==='tinjau_kasus_lanjutan' && Array.isArray(payload?.pemicuPendalaman) && payload.pemicuPendalaman.some(p=>alasanMendalam.has(p));
  if(scope && rute.model==='gpt-6.1-sol' && pendalaman) completionLimit=16000;
  let dasar = {
    penyedia: rute.penyedia, model: rute.model, sumber: rute.sumber, peringatan: rute.peringatan,
    effort: reasoningEffort || null,
  };

  let ok = false;
  let penggunaan = normalisasiPenggunaan();
  let biaya = null;
  try {
    if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
      throw new Error('payload.prompt wajib berupa teks');
    }
    const penyamar = buatPenyamar(payload.dikenal || {});
    const system = payload.system ? penyamar.samarkan(payload.system) : undefined;
    const prompt = penyamar.samarkan(payload.prompt);

    const jenis=payload.jenisKlaim||konteksAi.saatIni().jenis_klaim;
    const buatKey=(route,effort,limit)=>anggaranAi.kunciCache(scope,tugas,route,system,prompt,effort,limit,jenis);
    const kunciAwal=scope ? buatKey(rute,reasoningEffort,completionLimit) : null;
    let cacheKey=kunciAwal;
    let penyesuaian=null;
    const invoke=async()=>{
      if(scope) {
        const pilihan=[{rute,effort:reasoningEffort,limit:completionLimit}];
        if(rute.model==='gpt-6.1-sol') {
          // Kebijakan baru tidak membatalkan hasil Sol/Luna lama yang telah selesai.
          if(completionLimit!==8000) pilihan.push({rute,effort:reasoningEffort,limit:8000});
          pilihan.push({rute:{...rute,model:'gpt-6-luna',penyedia:'openai_compat',sumber:'anggaran_berkas'},effort:'high',limit:8000});
        }
        for(const p of pilihan) {
          const key=buatKey(p.rute,p.effort,p.limit);
          const cached=await anggaranAi.ambilCache(db,key,scope);
          if(cached) return {...cached,reused:true,ruteDigunakan:p.rute,effortDigunakan:p.effort};
        }
        // Kegagalan berbiaya tersimpan melewati restart/klik ulang. Tidak
        // mengubah model untuk melewati pencegahan pembayaran ganda.
        for(const p of pilihan) {
          const failed=await anggaranAi.ambilKegagalan(db,buatKey(p.rute,p.effort,p.limit),scope);
          if(failed) {
            const e=new Error('Tahap ini sebelumnya gagal dan mungkin sudah berbiaya. Permintaan yang sama ditahan agar biaya tidak berulang; hasil tahap lain tetap tersedia.');
            e.kode='pengulangan_berbiaya_dicegah';throw e;
          }
        }
        if(rute.model==='gpt-6.1-sol') {
          const available=await anggaranAi.ringkasan(db,scope);
          const total=(available?.terpakai_idr||0)+(available?.dicadangkan_idr||0)+(available?.belum_pasti_idr||0);
          const cap=pendalaman ? (!available?.gagal_idr && !available?.belum_pasti_idr ? 5000 : available?.batas_idr||600)
            : Math.min(600,available?.batas_idr||600);
          // Reservasi aktif diselesaikan sebelum menentukan apakah perlu fallback.
          if((batasBiaya(rute.model,system,prompt,completionLimit,rute.penyedia)?.idr || Infinity)>cap-total+(available?.dicadangkan_idr||0)) {
            rute={...rute,model:'gpt-6-luna',penyedia:'openai_compat',sumber:'anggaran_berkas'};
            reasoningEffort='high';completionLimit=8000;
            penyesuaian='Pendalaman memakai Luna high karena estimasi maksimum Sol melebihi batas pengaman berkas.';
            cacheKey=buatKey(rute,reasoningEffort,completionLimit);
          }
        }
      }
      const fn=adapter[rute.penyedia];
      if(!fn) throw new Error(`Adapter untuk penyedia "${rute.penyedia}" tidak ada`);
      dasar={...dasar,model:rute.model,penyedia:rute.penyedia,sumber:rute.sumber,effort:reasoningEffort||null,
        ...(penyesuaian ? {penyesuaian_anggaran:penyesuaian} : {})};
      let answer;
      // Percobaan ulang hanya permintaan ini, bukan ekstraksi/analisis penuh.
      const attempts=scope ? 2 : 1;
      for(let i=0;i<attempts;i++) {
        const reserve=scope ? batasBiaya(rute.model,system,prompt,completionLimit,rute.penyedia) : null;
        const termine=scope && reserve ? await anggaranAi.cadangkanSaatSiap(db,scope,reserve.idr,
          !klinis && ['agen_tinjau','agen_casemix'].includes(tugas),{klinis:klinis||tugas==='ekstrak_pdf',pendalaman}) : null;
        if(scope && !termine) {
          const e=new Error('Anggaran AI berkas tidak cukup untuk tahap ini. Hasil dan bukti yang sudah tersimpan tetap tersedia.');
          e.kode='anggaran_ai_terbatas';throw e;
        }
        const selesaiReservasi=termine||(()=>{});
        let cost=null,known=false,noCharge=false,callOk=false,requestMade=false;
        let requestUsage=normalisasiPenggunaan();
        try {
          // Penanda atomik tersimpan SEBELUM request. Setelah proses mati atau
          // ada pekerja lain, permintaan yang sama tidak dikirim dua kali.
          if(scope && !await anggaranAi.mulaiPanggilan(db,cacheKey,scope)) {
            const e=new Error('Permintaan yang sama sudah diproses atau perlu verifikasi biaya. Pengiriman ganda dicegah.');
            e.kode='pengulangan_berbiaya_dicegah';throw e;
          }
          answer=await batasPanggilan.jalankan(()=>{requestMade=true;return fn({model:rute.model,system,prompt,json:!!payload.json,
            maxTokens:payload.maxTokens,fetchImpl:payload.fetchImpl,reasoningEffort,completionLimit,
            ...(scope ? {timeoutMs:rute.model==='gpt-6.1-sol'
              ? Math.max(180000,Number(process.env.AI_DEEP_TIMEOUT_MS)||300000)
              : Math.max(60000,Number(process.env.AI_BUDGET_TIMEOUT_MS)||120000)} : {})});});
          const usage=normalisasiPenggunaan(typeof answer==='string' ? {} : answer?.usage||{});
          requestUsage=usage;
          penggunaan=usage; biaya=cost=biayaUntukAnggaran(rute.model,usage,rute.penyedia,answer?.usage,scope);known=Boolean(cost);
          const content=typeof answer==='string' ? answer : answer?.content;
          if(answer?.finish_reason==='length') {const e=new Error('Jawaban AI terpotong; tahap ini belum dapat dinyatakan lengkap.'); e.kode='output_terpotong';throw e;}
          const parsed=payload.json ? urai(content) : undefined;
          if(!content || payload.json && (parsed===undefined || scope && (!parsed || typeof parsed!=='object' || Array.isArray(parsed) || !Object.keys(parsed).length))) {
            const e=new Error('Jawaban AI belum membentuk hasil yang dapat diverifikasi.');e.kode='jawaban_belum_valid';throw e;
          }
          if(scope) {
            await anggaranAi.simpanCache(db,cacheKey,scope,typeof answer==='string'?{content:answer}:answer);
            await anggaranAi.hapusPenanda(db,cacheKey,scope).catch(()=>{});
          }
          callOk=true;
          return {...(typeof answer==='string'?{content:answer}:answer),ruteDigunakan:rute,effortDigunakan:reasoningEffort,penyesuaianAnggaran:penyesuaian};
        } catch(e) {
          noCharge=!requestMade || e.definiteNoCharge || e.kode==='tanpa_kunci';
          // 429 tidak memulai komputasi. Timeout atau jawaban rusak tidak
          // diulang otomatis: biaya/hasilnya belum pasti dan duplikasi dicegah.
          if(scope && !noCharge) await anggaranAi.simpanKegagalan(db,cacheKey,scope,e.kode);
          if(scope && noCharge && requestMade) await anggaranAi.hapusPenanda(db,cacheKey,scope);
          if(e.status!==429 || i===attempts-1) throw e;
        } finally {
          try {
            if(scope) await anggaranAi.lunasi(db,scope,reserve.idr,{biaya:cost,usageKnown:known,definiteNoCharge:noCharge,gagal:!callOk});
          } finally {selesaiReservasi();}
          if(db && requestMade) await catatan.catat(db, {tugas,penyedia:rute.penyedia,model:rute.model,versi:payload.versi,
            durasi_ms:Date.now()-mulai,ok:callOk,...konteksAi.saatIni(),effort:reasoningEffort,
            penggunaan:requestUsage,biaya:cost,jenis_klaim:payload.jenisKlaim||konteksAi.saatIni().jenis_klaim});
        }
        await new Promise(resolve=>setTimeout(resolve,1000*(i+1)));
      }
      return answer;
    };
    const jawaban=scope ? await anggaranAi.satuPanggilan(kunciAwal,invoke) : await invoke();
    rute=jawaban?.ruteDigunakan||rute;
    reasoningEffort=jawaban?.effortDigunakan||reasoningEffort;
    dasar={...dasar,model:rute.model,penyedia:rute.penyedia,sumber:rute.sumber,effort:reasoningEffort||null,
      ...(jawaban?.penyesuaianAnggaran ? {penyesuaian_anggaran:jawaban.penyesuaianAnggaran} : {})};
    const content = typeof jawaban === 'string' ? jawaban : jawaban && jawaban.content;
    const usage = jawaban?.reused ? {} : typeof jawaban === 'string' ? {} : (jawaban && jawaban.usage) || {};
    penggunaan = normalisasiPenggunaan(usage);
    biaya = biayaUntukAnggaran(rute.model,penggunaan,rute.penyedia,jawaban?.usage,scope);
    if (typeof content !== 'string' || !content) throw new Error('Model membalas kosong');
    const teks = penyamar.pulihkan(content);
    let hasil;
    if (payload.json) {
      const mentah = urai(content);
      if (mentah === undefined) throw new Error('Model tidak mengembalikan JSON');
      hasil = penyamar.pulihkanObjek(mentah);
    }
    ok = true;
    return {
      ok: true, teks, hasil,
      penggunaan, biaya, ...(jawaban?.reused ? {dari_cache:true} : {}),
      ...dasar, durasi_ms: Date.now() - mulai,
    };
  } catch (err) {
    return {
      ok: false, error: String(err.message || err).slice(0, 200), kode: err.kode, ...dasar,
      durasi_ms: Date.now() - mulai,
      penggunaan, biaya,
    };
  }
}

module.exports = { panggilModel, pasangAdapter, panggilChatCompletions, effortUntuk,biayaUntukAnggaran };
