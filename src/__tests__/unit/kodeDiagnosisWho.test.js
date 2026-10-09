// Layanan jaringan tiruan tetap memakai fetch yang disiapkan setiap skenario.
jest.mock('../../services/httpTanpaTenggatService', () => ({
  kirim: (...args) => global.fetch(...args),
}));

/**
 * Pemetaan kode diagnosis di luar ICD-10 WHO ke padanannya.
 *
 * Kasus asal: DIAGLIST berisi "r10.84" (ICD-10-CM Amerika) yang tampil "Valid".
 * BPJS hanya mengenal ICD-10 WHO; padanannya R10.4.
 *
 * Yang diuji terutama PAGARNYA: AI hanya boleh MEMILIH dari kode WHO yang pasti
 * ada di kamus, jadi kode karangan tidak mungkin lolos dari tahap ini.
 */

const mockWho = [
  { code: 'R10.0', description_id: 'Abdomen akut', description_en: 'Acute abdomen' },
  { code: 'R10.1', description_id: 'Nyeri perut bagian atas', description_en: 'Pain localized to upper abdomen' },
  { code: 'R10.2', description_id: 'Nyeri panggul dan perineum', description_en: 'Pelvic and perineal pain' },
  { code: 'R10.3', description_id: 'Nyeri perut bagian bawah lainnya', description_en: 'Pain localized to other parts of lower abdomen' },
  { code: 'R10.4', description_id: 'Lain dan tidak spesifik sakit perut', description_en: 'Other and unspecified abdominal pain' },
  { code: 'A90', description_id: 'Demam dengue', description_en: 'Dengue fever' },
];
const mockDipelajari = new Map();
let mockJawabanAi = null;
let mockAiDipanggil = 0;

jest.mock('../../database/init', () => ({
  getDb: () => ({
    all: async (sql, params) => {
      if (/icd10_who_codes/.test(sql)) {
        const awalan = String(params[0]).replace('%', '');
        return mockWho.filter(r => r.code.startsWith(awalan));
      }
      const k = mockDipelajari.get(params[0]);
      return k ? [k] : [];
    },
    run: async (sql, params) => {
      const [kunci, kode, nama] = params;
      if (!mockDipelajari.has(kunci)) mockDipelajari.set(kunci, { kode, nama });
    },
  }),
}));

global.fetch = jest.fn(async () => {
  mockAiDipanggil++;
  return {
    ok: true,
    text: async () => JSON.stringify({
      usage: { total_tokens: 50 },
      choices: [{ message: { content: JSON.stringify(mockJawabanAi) } }],
    }),
  };
});

const { petakanKeKodeWho } = require('../../services/kodeDiagnosisWhoService');

beforeEach(() => {
  mockDipelajari.clear();
  mockAiDipanggil = 0;
  mockJawabanAi = { kode: 'R10.4' };
  process.env.AI_PROVIDER_API_KEY = 'uji';
});

describe('kasus asal: r10.84 -> R10.4', () => {
  test('kode Amerika dipetakan ke padanan WHO dalam kategori yang sama', async () => {
    const h = await petakanKeKodeWho('r10.84', 'kolik abdomen');
    expect(h.kode).toBe('R10.4');
  });

  // Huruf kecil adalah bentuk asli di klaim itu.
  test('huruf kecil tidak jadi masalah', async () => {
    expect((await petakanKeKodeWho('r10.84', 'kolik abdomen')).kode).toBe('R10.4');
  });
});

describe('pagar: AI hanya boleh memilih dari daftar', () => {
  // Pagar terpenting. Kalau AI menjawab kode yang tidak ada di daftar kandidat
  // — termasuk kode Amerika yang tadi memicu masalah — jawabannya ditolak.
  test('jawaban di luar daftar kandidat ditolak', async () => {
    mockJawabanAi = { kode: 'R10.84' };
    expect(await petakanKeKodeWho('r10.84', 'kolik abdomen')).toBeNull();
  });

  test('kode nyata tetapi dari kategori lain ditolak', async () => {
    mockJawabanAi = { kode: 'A90' };
    expect(await petakanKeKodeWho('r10.84', 'kolik abdomen')).toBeNull();
  });

  test('AI menjawab null -> tidak ada penggantian', async () => {
    mockJawabanAi = { kode: null };
    expect(await petakanKeKodeWho('r10.84', 'kolik abdomen')).toBeNull();
  });

  // Tanpa istilah diagnosis tidak ada dasar memilih di antara beberapa
  // kandidat, dan menebak hanya memindahkan kekeliruan ke kode lain.
  test('tanpa istilah diagnosis dan banyak kandidat -> tidak menebak', async () => {
    expect(await petakanKeKodeWho('r10.84', '')).toBeNull();
    expect(mockAiDipanggil).toBe(0);
  });
});

describe('satu kandidat tidak perlu AI', () => {
  test('kategori dengan satu kode WHO langsung dipakai', async () => {
    const h = await petakanKeKodeWho('A90.1', '');
    expect(h.kode).toBe('A90');
    expect(mockAiDipanggil).toBe(0);
  });
});

describe('kamus tumbuh sendiri', () => {
  test('istilah yang sudah dipelajari tidak menanyakan AI lagi', async () => {
    await petakanKeKodeWho('r10.84', 'kolik abdomen');
    expect(mockAiDipanggil).toBe(1);
    mockAiDipanggil = 0;
    const h = await petakanKeKodeWho('r10.84', 'Kolik Abdomen');
    expect(h.kode).toBe('R10.4');
    expect(h.dari).toBe('kamus_dipelajari');
    expect(mockAiDipanggil).toBe(0);
  });
});

describe('kehati-hatian', () => {
  test('bentuk kode yang bukan ICD-10 tidak dipetakan', async () => {
    expect(await petakanKeKodeWho('99.999', 'apa saja')).toBeNull();
    expect(await petakanKeKodeWho('', 'apa saja')).toBeNull();
    expect(await petakanKeKodeWho(null, 'apa saja')).toBeNull();
  });

  test('kategori yang tidak ada di kamus tidak dipetakan', async () => {
    expect(await petakanKeKodeWho('Z99.99', 'apa saja')).toBeNull();
  });

  test('tanpa kunci API tidak error, hanya tidak mengganti', async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    expect(await petakanKeKodeWho('r10.84', 'kolik abdomen')).toBeNull();
  });

  test('AI gagal dipanggil tidak menggagalkan apa pun', async () => {
    global.fetch = jest.fn(async () => { throw new Error('jaringan putus'); });
    expect(await petakanKeKodeWho('r10.84', 'kolik abdomen')).toBeNull();
  });
});
