/**
 * Penarik data E-Klaim khusus baca (scripts/eklaim/eklaimBaca.js).
 * Tanpa jaringan: `kirim` diganti tiruan yang meniru ws.php.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  METHOD_BACA, enkripsi, dekripsi, buatKlien, ringkasKlaim, pecahProsedurIdrg,
  perintahKlaim, perintahKamus,
} = require('../../../scripts/eklaim/eklaimBaca');

const KEY = 'a'.repeat(64);

/** Server tiruan: membaca permintaan terenkripsi, menjawab terenkripsi seperti E-Klaim. */
function serverTiruan(jawab, { debug = false } = {}) {
  const diterima = [];
  const kirim = async (url, body) => {
    const req = JSON.parse(debug ? body : dekripsi(body, KEY));
    diterima.push({ url, req });
    const res = JSON.stringify(jawab(req));
    return { status: 200, teks: debug ? res : `----BEGIN ENCRYPTED DATA----\n${enkripsi(res, KEY)}\n----END ENCRYPTED DATA----` };
  };
  return { kirim, diterima };
}

// Bentuk respons get_claim_data dari koleksi Postman E-Klaim (data tiruan).
const KLAIM = {
  metadata: { code: 200, message: 'Ok' },
  response: {
    data: {
      nomor_sep: '000R222TEST', nama_pasien: 'TEST-PASIEN', nomor_kartu: '00055555', nomor_rm: 'R003333',
      tgl_lahir: '20/01/1990', coder_nik: '00001', nama_dokter: 'DR. X', jenis_rawat: 1, kelas_rawat: 1, los: '8',
      diagnosa: 'S73.0#S87.0#E11.9', procedure: '81.53#86.28#91.79',
      diagnosa_inagrouper: 'S73.02#S87.9#E11.9', procedure_inagrouper: '81.53#86.28+2#91.799#86.28+4',
      klaim_status_cd: 'normal',
      grouper: {
        response_inacbg: { cbg: { code: 'M-1-04-I', description: 'PROSEDUR PADA SENDI' }, base_tariff: '42178700', tariff: '73277700', kelas: 'kelas_1', status_cd: 'final' },
        response_idrg: { mdc_number: '18', drg_code: '1807119', drg_description: 'Hip Revision Proc.', cost_weight: '5.14', total_cost_weight: '7.19', total_tarif: '57848075', status_cd: 'final' },
      },
    },
  },
};

describe('enkripsi E-Klaim', () => {
  test('bolak-balik enkripsi/dekripsi', () => {
    expect(dekripsi(enkripsi('{"a":1}', KEY), KEY)).toBe('{"a":1}');
  });
  test('kunci salah ditolak lewat tanda tangan, bukan menghasilkan sampah', () => {
    expect(() => dekripsi(enkripsi('{"a":1}', KEY), 'b'.repeat(64))).toThrow(/tanda tangan/i);
  });
  test('kunci bukan 64 hex ditolak', () => {
    expect(() => enkripsi('x', 'abc')).toThrow(/64 karakter hex/);
  });
});

describe('hanya method baca', () => {
  test.each(['new_claim', 'set_claim_data', 'grouper', 'idrg_diagnosa_set', 'claim_final', 'send_claim_individual', 'delete_patient', 'reedit_claim', 'idrg_to_inacbg_import'])(
    '%s ditolak sebelum request dikirim',
    async (m) => {
      const s = serverTiruan(() => ({ metadata: { code: 200 } }));
      const panggil = buatKlien({ url: 'http://eklaim.lokal', key: KEY, kirim: s.kirim });
      await expect(panggil(m, {})).rejects.toThrow(/DITOLAK/);
      expect(s.diterima).toHaveLength(0);
    },
  );
  test('daftar method baca tidak memuat method tulis', () => {
    for (const m of METHOD_BACA) expect(m).toMatch(/_get$|^search_|^get_claim_data$/);
  });
  test('endpoint dan bentuk permintaan', async () => {
    const s = serverTiruan(() => KLAIM);
    const panggil = buatKlien({ url: 'http://eklaim.lokal/', key: KEY, kirim: s.kirim });
    await panggil('get_claim_data', { nomor_sep: '000R222TEST' });
    expect(s.diterima[0].url).toBe('http://eklaim.lokal/E-Klaim/ws.php');
    expect(s.diterima[0].req).toEqual({ metadata: { method: 'get_claim_data' }, data: { nomor_sep: '000R222TEST' } });
  });
  test('mode debug: tanpa enkripsi, ?mode=debug', async () => {
    const s = serverTiruan(() => KLAIM, { debug: true });
    const panggil = buatKlien({ url: 'http://eklaim.lokal', debug: true, kirim: s.kirim });
    const r = await panggil('get_claim_data', { nomor_sep: 'X' });
    expect(s.diterima[0].url).toMatch(/\?mode=debug$/);
    expect(r.response.data.diagnosa).toBe('S73.0#S87.0#E11.9');
  });
});

describe('ringkasan klaim', () => {
  const r = ringkasKlaim('000R222TEST', KLAIM);
  test('koding INA-CBG dan iDRG dipisah', () => {
    expect(r.inacbg.diagnosa).toEqual(['S73.0', 'S87.0', 'E11.9']);
    expect(r.idrg.diagnosa).toEqual(['S73.02', 'S87.9', 'E11.9']);
    expect(r.idrg.prosedur).toEqual([
      { kode: '81.53', jumlah: 1 }, { kode: '86.28', jumlah: 2 }, { kode: '91.799', jumlah: 1 }, { kode: '86.28', jumlah: 4 },
    ]);
  });
  test('hasil grouping dan tarif', () => {
    expect(r.inacbg).toMatchObject({ cbg: 'M-1-04-I', tarif_dasar: 42178700, tarif: 73277700 });
    expect(r.idrg).toMatchObject({ drg: '1807119', mdc: '18', cost_weight: 5.14, tarif: 57848075 });
  });
  test('identitas pasien dibuang', () => {
    for (const k of ['nama_pasien', 'nomor_kartu', 'nomor_rm', 'tgl_lahir', 'coder_nik', 'nama_dokter']) {
      expect(r.data_mentah).not.toHaveProperty(k);
    }
    expect(JSON.stringify(r)).not.toMatch(/TEST-PASIEN|00055555|R003333/);
  });
  test('SEP tidak ditemukan', () => {
    const g = ringkasKlaim('X', { metadata: { code: 400, message: 'Nomor SEP tidak ditemukan', error_no: 'E2004' } });
    expect(g).toMatchObject({ ok: false, galat: 'Nomor SEP tidak ditemukan', kode_galat: 'E2004' });
  });
  test('pecahProsedurIdrg tanpa pengali', () => {
    expect(pecahProsedurIdrg('')).toEqual([]);
  });
});

describe('perintah klaim', () => {
  test('menarik, menyimpan JSONL, dan melewati SEP yang sudah ditarik', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklaim-'));
    const daftar = path.join(dir, 'sep.txt');
    const keluar = path.join(dir, 'hasil.jsonl');
    fs.writeFileSync(daftar, '000R222TEST\n0170r0110926v000001\n\nbukan sep\n');
    const s = serverTiruan((req) => (req.data.nomor_sep === '000R222TEST' ? KLAIM : { metadata: { code: 400, message: 'Nomor SEP tidak ditemukan' } }));
    const panggil = buatKlien({ url: 'http://eklaim.lokal', key: KEY, kirim: s.kirim });

    const r1 = await perintahKlaim(panggil, daftar, keluar, { jeda: 0, log: () => {} });
    expect(r1).toEqual({ ok: 1, gagal: 1 });
    const baris = fs.readFileSync(keluar, 'utf8').trim().split('\n').map(JSON.parse);
    expect(baris.map(b => b.sep)).toEqual(['000R222TEST', '0170R0110926V000001']);

    // Jalankan ulang: yang sukses dilewati, yang gagal dicoba lagi.
    const sebelum = s.diterima.length;
    await perintahKlaim(panggil, daftar, keluar, { jeda: 0, log: () => {} });
    const ulang = s.diterima.slice(sebelum).filter(d => d.req.metadata.method === 'get_claim_data').map(d => d.req.data.nomor_sep);
    expect(ulang).toEqual(['0170R0110926V000001']);
  });
});

describe('perintah kamus', () => {
  test('kata kunci diperhalus bila hasil terpotong; kode berawalan lain dibuang', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklaim-'));
    const keluar = path.join(dir, 'kamus.jsonl');
    const s = serverTiruan((req) => {
      const k = req.data.keyword;
      if (k === '99') return { metadata: { code: 200 }, response: { count: 3, data: [{ code: '99.0', validcode: '0' }] } };
      if (k === '990') return { metadata: { code: 200 }, response: { count: 2, data: [{ code: '99.0', validcode: '0' }, { code: '99.01', validcode: '1' }] } };
      if (k === '991') return { metadata: { code: 200 }, response: { count: 1, data: [{ code: '99.10', validcode: '1' }, { code: '12.99', validcode: '1' }] } };
      return { metadata: { code: 200 }, response: { count: 0, data: [] } };
    });
    const panggil = buatKlien({ url: 'http://eklaim.lokal', key: KEY, kirim: s.kirim });
    const n = await perintahKamus(panggil, 'prosedur', keluar, { jeda: 0, log: () => {} });
    const kode = fs.readFileSync(keluar, 'utf8').trim().split('\n').map(l => JSON.parse(l).code);
    expect(kode).toEqual(['99.0', '99.01', '99.10']);
    expect(n).toBe(3);
    expect(s.diterima.every(d => d.req.metadata.method === 'search_procedures_inagrouper')).toBe(true);
  });
});
