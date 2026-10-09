/**
 * routes/bpjsPending.js callAi() disambungkan ke gatewayModelService
 * (tugas 'rancang_jawaban_pending') — pengujian ini membuktikan:
 *  1. Dengan router_model KOSONG, request keluar (URL, header, body) PERSIS
 *     sama seperti fetch() langsung yang dipakai callAi() lama.
 *  2. Baris di router_model mengubah penyedia/model seperti diharapkan.
 *  3. catatan_panggilan_model dapat 1 baris per panggilan, tanpa data pasien.
 *  4. dikenalDariClaim membangun daftar identitas dari field klaim asli
 *     (claim_records) / baris rekap (bpjs_pending_responses), dan identitas
 *     itu disamarkan sebelum keluar lewat gateway.
 *  5. Perilaku luar callAi() (null tanpa API key, throw pada error lain, hasil
 *     JSON pada sukses) tetap sama seperti sebelum disambungkan ke gateway.
 */
const { callAi, dikenalDariClaim } = require('../../routes/bpjsPending');
const router = require('../../services/routerModelService');

// DB tiruan minimal: router_model + catatan_panggilan_model in-memory.
function dbTiruan({ rusak = false } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows, log,
    async get(sql, p) {
      if (rusak) throw new Error('relation "router_model" does not exist');
      return rows.get(p[0]);
    },
    async run(sql, p) {
      if (rusak) throw new Error('relation does not exist');
      if (/INSERT INTO router_model/.test(sql)) {
        rows.set(p[0], { tugas: p[0], penyedia: p[1], model: p[2], lulus_uji: p[3] });
        return { changes: 1 };
      }
      if (/UPDATE router_model/.test(sql)) {
        const r = rows.get(p[1]);
        if (r) r.lulus_uji = p[0];
        return { changes: r ? 1 : 0 };
      }
      if (/DELETE FROM router_model/.test(sql)) { rows.delete(p[0]); return { changes: 1 }; }
      if (/INSERT INTO catatan_panggilan_model/.test(sql)) { log.push(p); return { changes: 1 }; }
      throw new Error('sql tak dikenal ' + sql);
    },
    async query() { return {}; },
    async all() { return []; },
  };
}

function fetchTiruan(jawaban, { status = 200 } = {}) {
  return jest.fn(async () => ({
    ok: status === 200,
    status,
    text: async () => (status === 200 ? JSON.stringify({ choices: [{ message: { content: jawaban } }] }) : 'gagal'),
  }));
}

const ENV_ASLI = { ...process.env };
beforeEach(() => {
  router.hapusCache();
  process.env.AI_MODEL = 'gpt-6-luna';
  process.env.AI_PROVIDER_API_KEY = 'kunci-luna';
  process.env.AI_PROVIDER_BASE_URL = 'https://luna.example/v1';
  delete process.env.AI_TIMEOUT_MS;
});
afterAll(() => { process.env = ENV_ASLI; });

describe('bpjsPending.callAi — equivalence request dengan router_model kosong', () => {
  test('URL, header, dan bentuk body PERSIS seperti fetch() langsung lama (dikenal kosong)', async () => {
    const f = fetchTiruan(JSON.stringify({ jawaban: 'ok', kategori_pending: 'lainnya', kolom_penyebab: [] }));
    const prompt = 'ALASAN_PENDING:\nContoh alasan pending tanpa identitas.\n\nDATA_KLAIM_ASLI:\n(tidak ada)';
    const hasil = await callAi(prompt, { db: dbTiruan(), dikenal: {}, fetchImpl: f });

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://luna.example/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer kunci-luna');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-6-luna'); // = process.env.AI_MODEL, sama seperti callAi() lama
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.reasoning_effort).toBe('medium');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: prompt }); // tanpa identitas -> prompt tidak berubah

    expect(hasil).toEqual({ jawaban: 'ok', kategori_pending: 'lainnya', kolom_penyebab: [] });
  });

  test('tanpa AI_PROVIDER_API_KEY -> null (bukan melempar), sama seperti callAi() lama', async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    const hasil = await callAi('prompt apa saja', { db: dbTiruan() });
    expect(hasil).toBeNull();
  });

  test('HTTP error dari provider -> melempar Error (pemanggil tetap bisa try/catch seperti sebelumnya)', async () => {
    const f = fetchTiruan('tidak dipakai', { status: 500 });
    await expect(callAi('prompt', { db: dbTiruan(), fetchImpl: f })).rejects.toThrow(/HTTP 500/);
  });

  test('balasan bukan JSON -> melempar Error', async () => {
    const f = fetchTiruan('bukan json sama sekali');
    await expect(callAi('prompt', { db: dbTiruan(), fetchImpl: f })).rejects.toThrow();
  });
});

describe('bpjsPending.callAi — router_model terisi mengubah penyedia/model', () => {
  test('baris rancang_jawaban_pending -> panggilan diarahkan ke penyedia/model baru', async () => {
    const db = dbTiruan();
    await router.setModel(db, 'rancang_jawaban_pending', { penyedia: 'kimi', model: 'kimi-k3-baru', lulus_uji: true });
    process.env.KIMI_API_KEY = 'kunci-kimi';
    process.env.KIMI_BASE_URL = 'https://kimi.example/v1';
    const f = fetchTiruan(JSON.stringify({ jawaban: 'dari kimi' }));
    const hasil = await callAi('prompt', { db, fetchImpl: f });
    expect(f.mock.calls[0][0]).toBe('https://kimi.example/v1/chat/completions');
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.model).toBe('kimi-k3-baru');
    expect(hasil).toEqual({ jawaban: 'dari kimi' });
  });
});

describe('bpjsPending.callAi — catatan_panggilan_model', () => {
  test('setiap panggilan tercatat (metadata saja, tanpa data pasien)', async () => {
    const db = dbTiruan();
    const f = fetchTiruan(JSON.stringify({ jawaban: 'Balasan untuk Siti Rahayu' }));
    await callAi('ALASAN_PENDING mengandung Siti Rahayu dan kartu 0001234567890', {
      db, dikenal: { nama: 'Siti Rahayu', nomor_kartu: '0001234567890' }, fetchImpl: f,
    });
    expect(db.log).toHaveLength(1);
    const [tugas, penyedia, model, versi, durasi, ok] = db.log[0];
    expect(tugas).toBe('rancang_jawaban_pending');
    expect(penyedia).toBe('openai_compat');
    expect(ok).toBe(true);
    expect(JSON.stringify(db.log)).not.toMatch(/Siti|Rahayu|0001234567890/);
  });

  test('panggilan gagal pun tercatat ok=false', async () => {
    const db = dbTiruan();
    const f = fetchTiruan('x', { status: 500 });
    await expect(callAi('prompt', { db, fetchImpl: f })).rejects.toThrow();
    expect(db.log).toHaveLength(1);
    expect(db.log[0][5]).toBe(false);
  });
});

describe('dikenalDariClaim', () => {
  test('mengambil dari claim_records bila tersedia', () => {
    const claimRecord = { sep: 'SEP123', nokartu: '0001234567890', nama_pasien: 'Budi Santoso', mrn: 'MR001' };
    expect(dikenalDariClaim(claimRecord, null)).toEqual({
      nama: 'Budi Santoso', nomor_kartu: '0001234567890', no_rm: 'MR001', sep: 'SEP123',
    });
  });

  test('jatuh ke baris rekap (existingRow) bila claim_records tidak tertaut', () => {
    const existingRow = { sep: 'SEP999', nokartu: '0009876543210', nama_peserta: 'Siti Aminah', mrn: null };
    expect(dikenalDariClaim(null, existingRow)).toEqual({
      nama: 'Siti Aminah', nomor_kartu: '0009876543210', no_rm: undefined, sep: 'SEP999',
    });
  });

  test('claim_records diutamakan di atas baris rekap saat keduanya ada', () => {
    const claimRecord = { sep: 'SEP-ASLI', nokartu: '111', nama_pasien: 'Nama Asli', mrn: 'MR-ASLI' };
    const existingRow = { sep: 'SEP-REKAP', nokartu: '222', nama_peserta: 'Nama Rekap', mrn: 'MR-REKAP' };
    expect(dikenalDariClaim(claimRecord, existingRow)).toEqual({
      nama: 'Nama Asli', nomor_kartu: '111', no_rm: 'MR-ASLI', sep: 'SEP-ASLI',
    });
  });

  test('tidak melempar bila keduanya null/undefined', () => {
    expect(dikenalDariClaim(null, undefined)).toEqual({
      nama: undefined, nomor_kartu: undefined, no_rm: undefined, sep: undefined,
    });
  });
});

describe('bpjsPending.callAi — identitas dikenal benar-benar disamarkan sebelum keluar', () => {
  test('nama pasien & nomor kartu di dalam prompt diganti token sebelum dikirim ke provider, lalu dipulihkan di jawaban', async () => {
    const claimRecord = { sep: 'SEP123', nokartu: '0001234567890', nama_pasien: 'Siti Rahayu', mrn: 'MR01' };
    const dikenal = dikenalDariClaim(claimRecord, null);
    // Prompt dirakit manual (bukan lewat buildPrompt, yang templatenya tidak
    // menyertakan nomor kartu) supaya kedua identitas benar-benar diuji.
    const prompt = `ALASAN_PENDING:\nMohon konfirmasi identitas pasien.\n\nDATA_KLAIM_ASLI:\nNAMA PASIEN: Siti Rahayu\nNOMOR KARTU: 0001234567890`;
    let terkirim;
    const f = jest.fn(async (url, init) => {
      terkirim = init.body;
      const dikirimKeProvider = JSON.parse(init.body).messages[1].content;
      // "Model" membalas dengan mengutip token nama yang dilihatnya — kalau
      // pemulihan token bekerja, jawaban akhir harus berisi nama ASLI lagi.
      const token = dikirimKeProvider.match(/\[NAMA_\d+\]/)[0];
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ jawaban: `Konfirmasi untuk ${token}` }) } }] }),
      };
    });
    const hasil = await callAi(prompt, { db: dbTiruan(), dikenal, fetchImpl: f });
    expect(terkirim).not.toMatch(/Siti Rahayu/);
    expect(terkirim).not.toMatch(/0001234567890/);
    expect(hasil.jawaban).toBe('Konfirmasi untuk Siti Rahayu');
  });
});
