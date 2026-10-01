const router = require('../../services/routerModelService');
const catatan = require('../../services/catatanPanggilanModelService');
const gateway = require('../../services/gatewayModelService');

// DB tiruan minimal: router_model in-memory + catatan.
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

const ENV_ASLI = { ...process.env };
beforeEach(() => {
  router.hapusCache();
  process.env.AI_MODEL = 'gpt-6-luna';
  process.env.AI_PROVIDER_API_KEY = 'kunci-luna';
  process.env.AI_PROVIDER_BASE_URL = 'https://luna.example/v1';
  process.env.KIMI_API_KEY = 'kunci-kimi';
  process.env.KIMI_BASE_URL = 'https://kimi.example/v1';
  process.env.KIMI_MODEL = 'kimi-k3';
});
afterAll(() => { process.env = ENV_ASLI; });

describe('routerModelService — fallback env', () => {
  test('tabel kosong -> perilaku env, tanpa peringatan', async () => {
    const r = await router.resolve(dbTiruan(), 'baca_berkas');
    expect(r).toMatchObject({ penyedia: 'openai_compat', model: 'gpt-6-luna', sumber: 'env', peringatan: null });
  });

  test('tabel hilang / DB error -> tidak melempar, jatuh ke env', async () => {
    const r = await router.resolve(dbTiruan({ rusak: true }), 'baca_kedua');
    expect(r.sumber).toBe('env');
    expect(r.model).toBe('gpt-6-luna');
  });

  test('db null -> env', async () => {
    expect((await router.resolve(null, 'analisis_pending')).sumber).toBe('env');
  });

  test('tugas tak dikenal -> env dengan peringatan, tidak melempar', async () => {
    const r = await router.resolve(dbTiruan(), 'tugas_ngawur');
    expect(r.sumber).toBe('env');
    expect(r.peringatan).toMatch(/tidak dikenal/);
  });

  test('tanpa env AI_MODEL, default tetap gpt-4o-mini seperti kode lama', async () => {
    delete process.env.AI_MODEL;
    expect((await router.resolve(dbTiruan(), 'baca_berkas')).model).toBe('gpt-4o-mini');
  });

  test('ringkas_training_pending kosong di router tetap memakai Kimi dan env khusus Kimi', async () => {
    const db = dbTiruan();
    const rute = await router.resolve(db, 'ringkas_training_pending');
    expect(rute).toMatchObject({ penyedia: 'kimi', model: 'kimi-k3', sumber: 'env' });
    const f = jest.fn(async (url, init) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"kategori_pending":"koding_diagnosis"}' } }] }),
    }));
    const hasil = await gateway.panggilModel('ringkas_training_pending', {
      prompt: 'Alasan untuk SEP 0170R0111225V003433',
      dikenal: { sep: '0170R0111225V003433' }, json: true, fetchImpl: f,
    }, { db });
    expect(hasil.ok).toBe(true);
    expect(f.mock.calls[0][0]).toBe('https://kimi.example/v1/chat/completions');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer kunci-kimi');
    expect(f.mock.calls[0][1].body).not.toContain('0170R0111225V003433');
  });

  test('putuskan_pending terdaftar dan fallback ke model env tanpa perubahan default', async () => {
    const r = await router.resolve(dbTiruan(), 'putuskan_pending');
    expect(r).toMatchObject({ penyedia: 'openai_compat', model: 'gpt-6-luna', sumber: 'env' });
    expect(r.peringatan).toBeNull();
  });
});

describe('routerModelService — baris router_model', () => {
  test('baris dipakai; lulus_uji=true tanpa peringatan', async () => {
    const db = dbTiruan();
    await router.setModel(db, 'baca_kedua', { penyedia: 'kimi', model: 'kimi-k3', lulus_uji: true });
    const r = await router.resolve(db, 'baca_kedua');
    expect(r).toMatchObject({ penyedia: 'kimi', model: 'kimi-k3', sumber: 'router_model', lulus_uji: true, peringatan: null });
  });

  test('lulus_uji=false terlihat lewat peringatan tapi TIDAK diblokir', async () => {
    const db = dbTiruan();
    const s = await router.setModel(db, 'analisis_pending', { penyedia: 'kimi', model: 'kimi-x' });
    expect(s.peringatan).toMatch(/belum lulus uji/);
    const r = await router.resolve(db, 'analisis_pending');
    expect(r.model).toBe('kimi-x');
    expect(r.peringatan).toMatch(/belum lulus uji/);
  });

  test('tandaiLulusUji menghapus peringatan; hapusModel kembali ke env', async () => {
    const db = dbTiruan();
    await router.setModel(db, 'baca_regulasi', { penyedia: 'kimi', model: 'kimi-k3' });
    await router.tandaiLulusUji(db, 'baca_regulasi', true);
    expect((await router.resolve(db, 'baca_regulasi')).peringatan).toBeNull();
    await router.hapusModel(db, 'baca_regulasi');
    expect((await router.resolve(db, 'baca_regulasi')).sumber).toBe('env');
  });

  test('setModel menolak tugas/penyedia/model tak valid', async () => {
    const db = dbTiruan();
    await expect(router.setModel(db, 'x', { penyedia: 'kimi', model: 'm' })).rejects.toThrow();
    await expect(router.setModel(db, 'baca_berkas', { penyedia: 'zzz', model: 'm' })).rejects.toThrow();
    await expect(router.setModel(db, 'baca_berkas', { penyedia: 'kimi', model: '  ' })).rejects.toThrow();
  });

  test('penyedia tak dikenal di tabel diabaikan -> env + peringatan', async () => {
    const db = dbTiruan();
    db.rows.set('baca_berkas', { tugas: 'baca_berkas', penyedia: 'aneh', model: 'm', lulus_uji: true });
    const r = await router.resolve(db, 'baca_berkas');
    expect(r.sumber).toBe('env');
    expect(r.peringatan).toMatch(/tidak dikenal/);
  });
});

describe('catatanPanggilanModelService', () => {
  test('hanya metadata yang ditulis (tanpa isi)', async () => {
    const db = dbTiruan();
    const ok = await catatan.catat(db, {
      tugas: 'baca_berkas', penyedia: 'kimi', model: 'kimi-k3', versi: 'v1', durasi_ms: 123.4, ok: true,
      prompt: 'RAHASIA', response: 'RAHASIA', nama: 'RAHASIA',
    });
    expect(ok).toBe(true);
    expect(JSON.stringify(db.log)).not.toContain('RAHASIA');
    expect(db.log[0]).toEqual(['baca_berkas', 'kimi', 'kimi-k3', 'v1', 123, true]);
  });

  test('gagal mencatat tidak melempar', async () => {
    expect(await catatan.catat(dbTiruan({ rusak: true }), { tugas: 't', ok: true })).toBe(false);
    expect(await catatan.catat(null, { tugas: 't', ok: true })).toBe(false);
  });
});

describe('gatewayModelService.panggilModel', () => {
  function fetchTiruan(jawaban, { status = 200 } = {}) {
    const f = jest.fn(async (url, init) => ({
      ok: status === 200,
      status,
      text: async () => JSON.stringify({ choices: [{ message: { content: jawaban } }] }),
    }));
    return f;
  }

  test('fallback env: memanggil endpoint luna dengan model env, body sama seperti callAi lama', async () => {
    const f = fetchTiruan('{"ok":1}');
    const r = await gateway.panggilModel('baca_berkas', { prompt: 'halo', system: 'sys', json: true, fetchImpl: f }, { db: dbTiruan() });
    expect(r.ok).toBe(true);
    expect(r.sumber).toBe('env');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://luna.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer kunci-luna');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_completion_tokens).toBe(3000);
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  test('Kimi (TIRUAN): rute ke KIMI_BASE_URL dengan kunci Kimi', async () => {
    const db = dbTiruan();
    await router.setModel(db, 'baca_kedua', { penyedia: 'kimi', model: 'kimi-k3', lulus_uji: false });
    const f = fetchTiruan('jawab');
    const r = await gateway.panggilModel('baca_kedua', { prompt: 'x', fetchImpl: f }, { db });
    expect(r.ok).toBe(true);
    expect(r.peringatan).toMatch(/belum lulus uji/);
    expect(f.mock.calls[0][0]).toBe('https://kimi.example/v1/chat/completions');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer kunci-kimi');
  });

  test('identitas disamarkan saat keluar dan dipulihkan saat jawaban kembali', async () => {
    let terkirim;
    const f = jest.fn(async (url, init) => {
      terkirim = init.body;
      const isi = JSON.parse(init.body).messages[0].content; // model "membalas" dengan token
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ringkas: `Kasus ${isi.match(/\[NAMA_1\]/)[0]} pending` }) } }] }) };
    });
    const r = await gateway.panggilModel('rancang_jawaban_pending', {
      prompt: 'Pasien Siti Rahayu, kartu 0001234567890, mengeluh sesak',
      dikenal: { nama: 'Siti Rahayu' },
      json: true,
      fetchImpl: f,
    }, { db: dbTiruan() });
    expect(terkirim).not.toMatch(/Siti|Rahayu|0001234567890/);
    expect(r.hasil.ringkas).toBe('Kasus Siti Rahayu pending');
  });

  test('tanpa kunci -> ok:false, tidak melempar, dan tercatat ok=false tanpa isi', async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    const db = dbTiruan();
    const r = await gateway.panggilModel('baca_berkas', { prompt: 'rahasia pasien' }, { db });
    expect(r.ok).toBe(false);
    expect(db.log).toHaveLength(1);
    expect(db.log[0][5]).toBe(false);
    expect(JSON.stringify(db.log)).not.toContain('rahasia');
  });

  test('HTTP error -> ok:false dan pesan dipotong', async () => {
    const f = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'x'.repeat(1000) }));
    const r = await gateway.panggilModel('baca_berkas', { prompt: 'a', fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(r.error.length).toBeLessThanOrEqual(200);
  });

  test('json:true tetapi model membalas bukan JSON -> ok:false', async () => {
    const r = await gateway.panggilModel('baca_berkas', { prompt: 'a', json: true, fetchImpl: fetchTiruan('bukan json') });
    expect(r.ok).toBe(false);
  });

  test('pasangAdapter menggantikan penyedia dan bisa dikembalikan', async () => {
    const lepas = gateway.pasangAdapter('openai_compat', async () => 'dari adapter');
    const r = await gateway.panggilModel('baca_berkas', { prompt: 'a' });
    lepas();
    expect(r.teks).toBe('dari adapter');
  });
});
