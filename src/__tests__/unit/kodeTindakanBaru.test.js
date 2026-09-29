/**
 * Pemberian kode pada tindakan yang belum ada di kamus bawaan.
 *
 * Yang diuji terutama PAGARNYA, bukan kemampuan memberi kodenya: kegagalan
 * paling sering pada pemberian kode oleh model adalah kode karangan, dan itu
 * harus tertahan sebelum sampai ke kolom klaim.
 */

const mockIcd9 = new Set();
const mockKamus = new Map();
let mockJawabanAi = null;
let mockAiDipanggil = 0;

jest.mock('../../database/init', () => ({
  getDb: () => ({
    all: async (sql, params) => {
      if (/icd9_cm_procedures/.test(sql)) {
        return params.filter(k => mockIcd9.has(k)).map(code => ({ code }));
      }
      return params.filter(k => mockKamus.has(k)).map(k => ({ kunci: k, ...mockKamus.get(k) }));
    },
    run: async (sql, params) => {
      const [kunci, kode, nama, teks_asal] = params;
      mockKamus.set(kunci, { kode, nama, teks_asal });
    },
  }),
}));

global.fetch = jest.fn(async () => {
  mockAiDipanggil++;
  return {
    ok: true,
    text: async () => JSON.stringify({
      usage: { total_tokens: 100 },
      choices: [{ message: { content: JSON.stringify(mockJawabanAi) } }],
    }),
  };
});

const { kodekanTindakanBaru, kunciIstilah } = require('../../services/kodeTindakanBaruService');

beforeEach(() => {
  mockIcd9.clear();
  ['57.94', '86.59', '93.94'].forEach(k => mockIcd9.add(k));
  mockKamus.clear();
  mockAiDipanggil = 0;
  mockJawabanAi = { hasil: [] };
  process.env.AI_PROVIDER_API_KEY = 'uji';
});

describe('pagar kode karangan', () => {
  // Pagar yang paling penting. Kode yang tidak ada di ICD-9-CM tidak boleh
  // sampai ke kolom klaim dalam keadaan apa pun.
  test('kode yang tidak ada di ICD-9-CM dibuang', async () => {
    mockJawabanAi = { hasil: [{ teks: 'pasang kateter urin', kode: '99.999', nama: 'Kateter' }] };
    expect(await kodekanTindakanBaru(['pasang kateter urin'])).toEqual([]);
  });

  test('kode yang nyata diterima', async () => {
    mockJawabanAi = { hasil: [{ teks: 'pasang kateter urin', kode: '57.94', nama: 'Pemasangan kateter urin' }] };
    const h = await kodekanTindakanBaru(['pasang kateter urin']);
    expect(h).toHaveLength(1);
    expect(h[0].kode).toBe('57.94');
  });

  // Menjawab null jauh lebih baik daripada menebak: kode yang salah terkirim
  // ke BPJS atas nama rumah sakit.
  test('AI yang tidak yakin tidak menghasilkan kode', async () => {
    mockJawabanAi = { hasil: [{ teks: 'kontrol poli', kode: null, nama: null }] };
    expect(await kodekanTindakanBaru(['kontrol poli'])).toEqual([]);
  });
});

describe('kamus tumbuh sendiri', () => {
  // AI dipanggil SEKALI seumur hidup per istilah, bukan sekali per klaim.
  test('istilah yang sudah dipelajari dijawab tanpa memanggil AI', async () => {
    mockJawabanAi = { hasil: [{ teks: 'jahit luka', kode: '86.59', nama: 'Jahit luka' }] };
    await kodekanTindakanBaru(['jahit luka']);
    expect(mockAiDipanggil).toBe(1);

    mockAiDipanggil = 0;
    const h = await kodekanTindakanBaru(['jahit luka']);
    expect(mockAiDipanggil).toBe(0);
    expect(h[0].kode).toBe('86.59');
    expect(h[0].dari).toBe('kamus_dipelajari');
  });

  // Kalimat yang memang bukan tindakan tidak boleh ditanyakan berulang dan
  // membayar token setiap kali berkas serupa masuk.
  test('istilah yang pernah dijawab null tidak ditanyakan lagi', async () => {
    mockJawabanAi = { hasil: [{ teks: 'kontrol poli', kode: null }] };
    await kodekanTindakanBaru(['kontrol poli']);
    mockAiDipanggil = 0;
    await kodekanTindakanBaru(['kontrol poli']);
    expect(mockAiDipanggil).toBe(0);
  });

  // Dosis tidak membedakan jenis tindakan, jadi tidak boleh membuat istilah
  // yang sama dianggap baru dan dibayari token lagi.
  test('perbedaan dosis dan huruf besar tidak dianggap istilah baru', () => {
    expect(kunciIstilah('Inj. Omeprazole 1A')).toBe(kunciIstilah('inj omeprazole 2a'));
    expect(kunciIstilah('Jahit Luka 3 jahitan')).toBe(kunciIstilah('jahit luka 5 jahitan'));
  });
});

describe('kehati-hatian', () => {
  test('masukan kosong tidak memanggil AI', async () => {
    expect(await kodekanTindakanBaru([])).toEqual([]);
    expect(await kodekanTindakanBaru(null)).toEqual([]);
    expect(mockAiDipanggil).toBe(0);
  });

  test('tanpa kunci API tidak error, hanya tidak memberi kode', async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    expect(await kodekanTindakanBaru(['pasang kateter urin'])).toEqual([]);
  });

  test('AI gagal dipanggil tidak menggagalkan apa pun', async () => {
    global.fetch = jest.fn(async () => { throw new Error('jaringan putus'); });
    expect(await kodekanTindakanBaru(['pasang kateter urin'])).toEqual([]);
  });
});
