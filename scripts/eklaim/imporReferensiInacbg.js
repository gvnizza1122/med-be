#!/usr/bin/env node
/**
 * Importer referensi INA-CBG dari tabel RESMI E-Klaim ke src/data/inacbg/.
 *
 * Sumber = tabel MyISAM terbuka yang dibawa installer/patch E-Klaim (bukan
 * berkas iDRG .iccdb yang terenkripsi). Lihat scripts/eklaim/PANDUAN.md bagian
 * "Memperbarui kamus & tarif INA-CBG" untuk cara mengekspor TSV dari patch.
 *
 * Masukan: direktori berisi berkas TSV (hasil `mysqldump`/ekspor) dengan header:
 *   casemix.alt_diagnosis.tsv      chapter,s1,code,code2,description,severity,Inpatient,Outpatient
 *   casemix.alt_procedures.tsv     Code,Code2,Description,Class,Inpatient,Outpatient
 *   casemix.alt_hierarchy1.tsv     ID,PCAT,DRG,InOut,Description
 *   casemix.alt_unucbg.tsv         UNUCBG,Description,...
 *   inacbg5.tariff_20230124.tsv    INACBG,REGIONAL,KODE_TARIFF,KELAS_RAWAT,JENIS_PELAYANAN,TARIFF_ORIGINAL,TARIFF
 *   inacbg5.cclist.tsv             code,cc,maincc,ccrow
 *   inacbg5.c51ccex.tsv            cc10,notfor_pdx
 *
 * Pemakaian:
 *   node scripts/eklaim/imporReferensiInacbg.js <dir_tsv> [--regional reg1] [--kodeTarif DS] [--iccVersion x]
 *
 * Keluaran: src/data/inacbg/*.json + memperbarui nilai tarif di
 * src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json (deskripsi Indonesia
 * yang sudah ada dipertahankan).
 */
'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { regional: 'reg1', kodeTarif: 'DS', iccVersion: '' };
  a.dir = argv[2];
  for (let i = 3; i < argv.length; i++) {
    const m = /^--([a-zA-Z]+)$/.exec(argv[i]);
    if (m && argv[i + 1] != null) { a[m[1]] = argv[++i]; }
  }
  return a;
}
function loadTsv(dir, name) {
  const p = path.join(dir, `${name}.tsv`);
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split('\t');
  return lines.slice(1).map(l => {
    const c = l.split('\t'); const o = {};
    head.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}
const norm = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const groups = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function main() {
  const args = parseArgs(process.argv);
  if (!args.dir) {
    console.error('Pemakaian: node scripts/eklaim/imporReferensiInacbg.js <dir_tsv> [--regional reg1] [--kodeTarif DS] [--iccVersion x]');
    process.exit(1);
  }
  const OUT = path.resolve(__dirname, '../../src/data/inacbg');
  fs.mkdirSync(OUT, { recursive: true });

  const dx = {};
  for (const r of loadTsv(args.dir, 'casemix.alt_diagnosis')) {
    const k = norm(r.code); if (k) dx[k] = { ip: groups(r.Inpatient), op: groups(r.Outpatient) };
  }
  const px = {};
  for (const r of loadTsv(args.dir, 'casemix.alt_procedures')) {
    const k = norm(r.Code); if (k) px[k] = { ip: groups(r.Inpatient), op: groups(r.Outpatient) };
  }
  const hier = {};
  for (const r of loadTsv(args.dir, 'casemix.alt_hierarchy1')) { if (r.DRG) hier[r.DRG.trim()] = Number(r.ID); }

  const desc = {};
  try { for (const r of loadTsv(args.dir, 'casemix.alt_unucbg')) { if (r.UNUCBG) desc[r.UNUCBG.trim()] = (r.Description || '').trim(); } } catch (_) {}

  const tarif = {};
  for (const r of loadTsv(args.dir, 'inacbg5.tariff_20230124')) {
    if (r.REGIONAL === args.regional && r.KODE_TARIFF === args.kodeTarif) {
      (tarif[r.INACBG] = tarif[r.INACBG] || {})[r.KELAS_RAWAT] = Number(r.TARIFF);
    }
  }
  const cc = {};
  for (const r of loadTsv(args.dir, 'inacbg5.cclist')) {
    const k = norm(r.code);
    if (k && ((r.cc || '').trim() !== '0' && (r.cc || '').trim() !== '' || (r.maincc || '').trim())) {
      cc[k] = { cc: Number(r.cc || 0), maincc: norm(r.maincc) };
    }
  }
  const ccex = {};
  try { for (const r of loadTsv(args.dir, 'inacbg5.c51ccex')) { (ccex[norm(r.cc10)] = ccex[norm(r.cc10)] || []).push(norm(r.notfor_pdx)); } } catch (_) {}

  const meta = {
    sumber: 'Patch/installer E-Klaim INA-CBG (tabel MyISAM terbuka, inacbg.kemkes.go.id)',
    tarif: 'PMK No. 3 Tahun 2023 (tabel tariff_20230124)',
    profil: { regional: args.regional, kode_tarif: args.kodeTarif },
    icc_version: args.iccVersion || null,
    diambil: new Date().toISOString().slice(0, 10),
    catatan: 'Base group & tarif = tabel referensi resmi E-Klaim (terbuka). Impor ini tidak mencakup matriks CCL atau pemetaan dccol; keberadaan dan kelengkapannya harus diperiksa pada setiap patch. Severity I/II/III tetap estimasi; hasil mesin grouper E-Klaim otoritas final.',
  };

  const w = (n, o) => fs.writeFileSync(path.join(OUT, `${n}.json`), JSON.stringify(o));
  w('grouperDiagnosis', dx); w('grouperProsedur', px); w('grouperHierarki', hier);
  w('tarif', tarif); w('cc', cc); w('ccExclusion', ccex);
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));

  // Perbarui file tarif datar (dipakai tarifInacbgLookup); pertahankan deskripsi
  // Indonesia yang sudah ada, koreksi nilai ke resmi, tambahkan kode yang kurang.
  const flatPath = path.resolve(__dirname, '../../src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json');
  let flat = { source: meta.tarif, region: `${args.regional} ${args.kodeTarif}`, data: [] };
  try { flat = JSON.parse(fs.readFileSync(flatPath, 'utf8')); } catch (_) {}
  const arr = (flat.tarif || flat.data || []).map(r => ({ ...r }));
  const have = new Set(arr.map(r => String(r.code).toUpperCase()));
  for (const r of arr) {
    const o = tarif[String(r.code).toUpperCase()]; if (!o) continue;
    r.kelasA = o['1'] ?? null; r.kelasB = o['2'] ?? null; r.kelasC = o['3'] ?? null; r.kelasD = o['0'] ?? null;
  }
  for (const code of Object.keys(tarif)) {
    if (have.has(code.toUpperCase())) continue;
    const o = tarif[code];
    arr.push({ code, description: desc[code] || null, kelasA: o['1'] ?? null, kelasB: o['2'] ?? null, kelasC: o['3'] ?? null, kelasD: o['0'] ?? null });
  }
  arr.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  fs.writeFileSync(flatPath, JSON.stringify({ source: flat.source || meta.tarif, region: flat.region || `${args.regional} ${args.kodeTarif}`, data: arr }));

  console.log(`diagnosis=${Object.keys(dx).length} prosedur=${Object.keys(px).length} hierarki=${Object.keys(hier).length} tarif=${Object.keys(tarif).length} cc=${Object.keys(cc).length} profil=${args.regional}/${args.kodeTarif}`);
}
main();
