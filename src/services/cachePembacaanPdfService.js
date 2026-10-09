// Hasil pembacaan lokal disimpan sebelum AI dipanggil. Gangguan AI tidak
// mengulang OCR seluruh PDF; file sumber tetap menjadi acuan.
const fs = require('fs/promises');
const { promisify } = require('util');
const zlib = require('zlib');
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const VERSI = 1;
async function identitas(filePath) {
  const s = await fs.stat(filePath);
  return `${s.size}:${s.mtimeMs}:${s.ino}`;
}
function lengkap(c) {
  if (!c?.success || !c.totalPages || c.pages?.length !== c.totalPages) return false;
  const ocr = c.ocr_enhancement?.pass1_general_ocr;
  if (ocr?.errors?.length || ocr?.pemulihan_otomatis?.belum_terbaca?.length) return false;
  const terbaca = new Set([...(ocr?.pages || []).filter(p => p.text?.trim()).map(p => p.page_number),
    ...(c.grouperPages || []).map(p => p.page_num)]);
  const { punyaLapisanTeksNyata } = require('./keputusanSumberHalamanService');
  return c.pages.every(p => p.is_lembar_grouper || terbaca.has(p.page_num)
    || punyaLapisanTeksNyata(p.text_full));
}
async function ambil(filePath) {
  try {
    const c = JSON.parse((await gunzip(await fs.readFile(`${filePath}.reading-v1.json.gz`))).toString('utf8'));
    return c.versi === VERSI && c.identitas === await identitas(filePath) && lengkap(c.hasil) ? c.hasil : null;
  } catch { return null; }
}
async function simpan(filePath, hasil) {
  if (!lengkap(hasil)) return false;
  const target = `${filePath}.reading-v1.json.gz`;
  const temp = `${target}.${process.pid}.${require('crypto').randomUUID()}.tmp`;
  try {
    const data = await gzip(JSON.stringify({ versi: VERSI, identitas: await identitas(filePath), hasil }));
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, target);
    return true;
  } catch { return false; }
  finally { await fs.unlink(temp).catch(() => {}); }
}
module.exports = { ambil, simpan, lengkap };
