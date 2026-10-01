#!/usr/bin/env node
/**
 * Ekspor keluaran pipeline aktual untuk scripts/evaluasiKunciJawaban.js.
 * Hanya membaca claim_records, ai_review, dan ocr_results; tidak membuat kunci.
 *
 *   node scripts/eksporKeluaranEvaluasi.js --record-id ID --out keluaran.json
 *   node scripts/eksporKeluaranEvaluasi.js --file-id ID --out keluaran.json
 */

const fs = require('fs');
const path = require('path');
const { getDb, closeDb } = require('../src/database/init');

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function parseKode(value) {
  return String(value || '').split(/[;,]/).map(k => k.trim()).filter(Boolean);
}

function uniqKode(recordCodes, suggestions, type) {
  const out = new Map(parseKode(recordCodes).map(k => [k.toUpperCase(), k]));
  for (const s of suggestions || []) {
    if (!s || s.type !== type || !s.code) continue;
    out.set(String(s.code).toUpperCase(), {
      kode: s.code,
      halaman: s.page_number || null,
      kutipan: s.quotation || null,
      teks: s.reasoning || null,
      sumber: 'ai_review.suggested_codes',
    });
  }
  return [...out.values()];
}

function bentukKeluaran(record, halaman) {
  const review = parseJson(record.ai_review);
  const suggestions = Array.isArray(review.suggested_codes) ? review.suggested_codes : [];
  const lab = review.temuan_lab && Array.isArray(review.temuan_lab.baris)
    ? review.temuan_lab.baris.filter(b => b && b.parameter && b.nilai !== null && b.nilai !== undefined).map(b => ({
      parameter: b.parameter_baku || b.parameter,
      nilai: b.nilai,
      satuan: b.satuan || '',
      ...(b.tanggal ? { tanggal: b.tanggal } : {}),
      halaman: b.halaman || null,
      kutipan: b.kutipan || null,
    }))
    : [];
  return {
    klaim_id: String(record.id),
    diagnosis: uniqKode(record.diagnosa_list, suggestions, 'diagnosis'),
    prosedur: uniqKode(record.prosedur_list, suggestions, 'procedure'),
    nilai_lab: lab,
    halaman: (halaman || []).map(h => ({ page_number: h.page_number, ocr_text: h.ocr_text || '' })),
  };
}

function bacaArgumen(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--record-id') a.recordId = argv[++i];
    else if (argv[i] === '--file-id') a.fileId = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--help') a.help = true;
    else throw new Error(`Argumen tidak dikenal: ${argv[i]}`);
  }
  return a;
}

async function ekspor(db, { recordId, fileId }) {
  if (!!recordId === !!fileId) throw new Error('Pilih tepat satu: --record-id atau --file-id');
  const records = recordId
    ? [await db.prepare('SELECT id, diagnosa_list, prosedur_list, ai_review FROM claim_records WHERE id = ?').get(recordId)].filter(Boolean)
    : await db.prepare('SELECT id, diagnosa_list, prosedur_list, ai_review FROM claim_records WHERE file_id = ? ORDER BY row_number, id').all(fileId);
  if (!records.length) throw new Error('Tidak ada record klaim untuk cakupan yang diminta');
  const hasil = [];
  for (const record of records) {
    const halaman = await db.prepare('SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number').all(record.id);
    hasil.push(bentukKeluaran(record, halaman));
  }
  return hasil;
}

async function main() {
  const a = bacaArgumen(process.argv);
  if (a.help) {
    console.log('Pakai: --record-id ID | --file-id ID, wajib bersama --out keluaran.json');
    return;
  }
  if (!a.out) throw new Error('--out wajib diisi');
  const out = path.resolve(a.out);
  if (path.extname(out).toLowerCase() !== '.json') throw new Error('--out harus berakhiran .json');
  const db = getDb();
  try {
    await db.initialize();
    const hasil = await ekspor(db, a);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(hasil, null, 2), 'utf8');
    console.log(`Keluaran evaluasi dibuat: ${out} (${hasil.length} klaim). Tidak ada kunci jawaban yang dibuat.`);
  } finally {
    closeDb();
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`GAGAL: ${err.message}`); process.exitCode = 1; });
}

module.exports = { parseJson, parseKode, uniqKode, bentukKeluaran, bacaArgumen, ekspor };
