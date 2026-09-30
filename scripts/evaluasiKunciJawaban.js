#!/usr/bin/env node
/**
 * CLI harness akurasi pembacaan berkas: membandingkan kunci jawaban manusia
 * dengan keluaran sistem. Tidak memakai DB, AI, atau jaringan.
 *
 *   node scripts/evaluasiKunciJawaban.js --berkas <berkas.json>
 *   node scripts/evaluasiKunciJawaban.js --kunci <berkas|folder> --keluaran <berkas|folder> [--json] [--gagal-bila-dikarang]
 *
 * Format: src/__tests__/fixtures/kunciJawaban/README.md
 * Kode keluar: 0 normal; 1 bila --gagal-bila-dikarang dan ada kode dikarang;
 * 2 untuk kesalahan penggunaan.
 */

const fs = require('fs');
const path = require('path');
const { evaluasiSemua, klasifikasiKlaim } = require('../src/services/evaluasiAkurasiService');

function bacaArgumen(argv) {
  const a = { json: false, gagalBilaDikarang: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--gagal-bila-dikarang') a.gagalBilaDikarang = true;
    else if (k === '--kunci') a.kunci = argv[++i];
    else if (k === '--keluaran') a.keluaran = argv[++i];
    else if (k === '--berkas') a.berkas = argv[++i];
    else if (k === '-h' || k === '--help') a.bantuan = true;
    else { a.salah = `Argumen tidak dikenal: ${k}`; }
  }
  return a;
}

function bacaJson(jalur) {
  return JSON.parse(fs.readFileSync(jalur, 'utf8').replace(/^﻿/, ''));
}

/** Berkas larik, atau folder berisi banyak .json (larik atau objek tunggal). */
function bacaDaftar(jalur, kunciObjek) {
  const stat = fs.statSync(jalur);
  const berkas = stat.isDirectory()
    ? fs.readdirSync(jalur).filter(f => f.endsWith('.json')).map(f => path.join(jalur, f))
    : [jalur];
  const hasil = [];
  for (const b of berkas) {
    const isi = bacaJson(b);
    if (Array.isArray(isi)) hasil.push(...isi);
    else if (isi && Array.isArray(isi[kunciObjek])) hasil.push(...isi[kunciObjek]);
    else if (isi && isi.klaim_id) hasil.push(isi);
  }
  return hasil;
}

const persen = (x) => (x == null ? '   n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);

function cetak(hasil, klasifikasi) {
  const a = hasil.agregat;
  const baris = [];
  baris.push(`Klaim dievaluasi: ${a.jumlah_klaim}`);
  if (a.klaim_tanpa_keluaran.length) baris.push(`Tanpa keluaran sistem: ${a.klaim_tanpa_keluaran.join(', ')}`);
  if (hasil.keluaran_tanpa_kunci.length) baris.push(`Keluaran tanpa kunci (diabaikan): ${hasil.keluaran_tanpa_kunci.join(', ')}`);
  baris.push('');
  baris.push('                 Tertangkap   Tepat   Tepat kategori (terpisah)');
  for (const [nama, d] of [['Diagnosis', a.diagnosis], ['Prosedur', a.prosedur]]) {
    baris.push(`${nama.padEnd(14)} ${persen(d.tertangkap)}  ${persen(d.tepat_rasio)}   kategori_saja=${d.kategori_saja}  (Tepat+kategori: ${persen(d.tepat_kategori)})`);
  }
  baris.push('');
  baris.push(`Nilai lab tepat (parameter+nilai+satuan): ${persen(a.lab.nilai_lab_tepat)}  (${a.lab.nilai_lab_tepat_count}/${a.lab.jumlah_benar})`);
  const d = a.kode_dikarang;
  baris.push(`Kode dikarang: ${d.jumlah} (target 0) pada ${d.klaim_dinilai} klaim dinilai` +
    (d.klaim_tidak_dinilai ? `; ${d.klaim_tidak_dinilai} klaim tidak dinilai (teks berkas tidak diberikan)` : ''));
  if (klasifikasi) {
    baris.push('');
    baris.push('Ketidakcocokan menurut tipe (heuristik, perlu tinjauan manusia):');
    const t = klasifikasi.per_tipe;
    baris.push(`  tipe 1 huruf salah: ${t[1]}   tipe 2 tempat salah: ${t[2]}   tipe 3 salah tafsir: ${t[3]}   tipe 4 dikarang: ${t[4]}   tipe 5 tulisan tangan: ${t[5]}   tidak dapat ditentukan: ${t.tidak_dapat_ditentukan}`);
  }
  console.log(baris.join('\n'));
}

function utama(argv) {
  const a = bacaArgumen(argv);
  if (a.bantuan || a.salah || (!a.berkas && !(a.kunci && a.keluaran))) {
    if (a.salah) console.error(a.salah);
    console.error('Pemakaian: --berkas <berkas.json> | --kunci <berkas|folder> --keluaran <berkas|folder> [--json] [--gagal-bila-dikarang]');
    return a.bantuan ? 0 : 2;
  }
  let daftarKunci; let daftarKeluaran;
  try {
    daftarKunci = bacaDaftar(a.berkas || a.kunci, 'kunci');
    daftarKeluaran = bacaDaftar(a.berkas || a.keluaran, 'keluaran');
  } catch (e) {
    console.error(`Gagal membaca berkas: ${e.message}`);
    return 2;
  }
  const hasil = evaluasiSemua(daftarKunci, daftarKeluaran);

  // Klasifikasi tipe kesalahan per klaim, dijumlahkan.
  const perTipe = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, tidak_dapat_ditentukan: 0 };
  const rincian = [];
  const petaKeluaran = new Map(daftarKeluaran.map(o => [String(o.klaim_id), o]));
  hasil.per_klaim.forEach((h, i) => {
    const k = klasifikasiKlaim(h, daftarKunci[i], petaKeluaran.get(String(h.klaim_id)) || null);
    Object.keys(perTipe).forEach(t => { perTipe[t] += k.per_tipe[t]; });
    rincian.push({ klaim_id: h.klaim_id, ketidakcocokan: k.daftar });
  });
  const klasifikasi = { per_tipe: perTipe, rincian };

  if (a.json) console.log(JSON.stringify({ ...hasil, klasifikasi }, null, 2));
  else cetak(hasil, klasifikasi);

  return a.gagalBilaDikarang && hasil.agregat.kode_dikarang.jumlah > 0 ? 1 : 0;
}

if (require.main === module) process.exit(utama(process.argv.slice(2)));

module.exports = { utama, bacaArgumen, bacaDaftar };
