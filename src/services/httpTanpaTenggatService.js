// Menunggu respons lengkap tanpa batas durasi. Error jaringan tetap ditangani.
// Soket baru mencegah pemakaian ulang koneksi yang kedaluwarsa selama OCR panjang.
const http = require('http');
const https = require('https');
function kirim(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: options.method || 'POST', headers: options.headers, agent: false,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Koneksi penyedia terputus sebelum jawaban lengkap.')));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: async () => Buffer.concat(chunks).toString('utf8'),
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', cause => {
      const error = new Error(`Koneksi penyedia gagal (${cause.code || 'network_error'}).`);
      error.kode = 'koneksi_penyedia_gagal';
      error.definiteNoCharge = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(cause.code);
      reject(error);
    });
    req.end(options.body);
  });
}
module.exports = { kirim };
