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
const { normalisasiPenggunaan, estimasiBiaya } = require('./biayaModelService');
const konteksAi = require('./konteksPenggunaanAiService');

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

async function panggilChatCompletions({ apiKey, baseUrl, timeoutMs, label, model, system, prompt, json, maxTokens, reasoningEffort, fetchImpl }) {
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
    const body = { model, messages, max_completion_tokens: reasoningEffort ? Math.max(maxTokens || 3000, minimum) : (maxTokens || 3000) };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (json) body.response_format = { type: 'json_object' };
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const respText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${respText.slice(0, 160)}`);
    const data = JSON.parse(respText);
    const content = data.choices?.[0]?.message?.content || '';
    // Penggunaan tetap diteruskan bila JSON kosong/terpotong: biaya terjadi.
    return { content, usage: data.usage || {} };
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
  const rute = await routerModel.resolve(db, tugas);
  const reasoningEffort = effortUntuk(rute.model, tugas);
  const dasar = {
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
    const fn = adapter[rute.penyedia];
    if (!fn) throw new Error(`Adapter untuk penyedia "${rute.penyedia}" tidak ada`);

    const penyamar = buatPenyamar(payload.dikenal || {});
    const system = payload.system ? penyamar.samarkan(payload.system) : undefined;
    const prompt = penyamar.samarkan(payload.prompt);

    const jawaban = await fn({
      model: rute.model, system, prompt, json: !!payload.json,
      maxTokens: payload.maxTokens, fetchImpl: payload.fetchImpl,
      reasoningEffort,
    });
    const content = typeof jawaban === 'string' ? jawaban : jawaban && jawaban.content;
    const usage = typeof jawaban === 'string' ? {} : (jawaban && jawaban.usage) || {};
    penggunaan = normalisasiPenggunaan(usage);
    biaya = estimasiBiaya(rute.model, penggunaan, rute.penyedia);
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
      penggunaan, biaya,
      ...dasar, durasi_ms: Date.now() - mulai,
    };
  } catch (err) {
    return {
      ok: false, error: String(err.message || err).slice(0, 200), kode: err.kode, ...dasar,
      durasi_ms: Date.now() - mulai,
      penggunaan, biaya,
    };
  } finally {
    if (db) {
      await catatan.catat(db, {
        tugas, penyedia: rute.penyedia, model: rute.model, versi: payload && payload.versi,
        durasi_ms: Date.now() - mulai, ok,
        ...konteksAi.saatIni(),
        effort: reasoningEffort, penggunaan, biaya, jenis_klaim: payload?.jenisKlaim || konteksAi.saatIni().jenis_klaim,
      });
    }
  }
}

module.exports = { panggilModel, pasangAdapter, panggilChatCompletions, effortUntuk };
