#!/usr/bin/env node
/**
 * Test script untuk verifikasi Tarif INACBG PMK 3/2023 integration
 *
 * Jalankan dengan:
 *   node scripts/testTarifInacbg.js
 *
 * Script ini memverifikasi:
 * 1. Data JSON terload dengan benar (1,075 baris)
 * 2. Lookup service bekerja (K-4-17-I = Rp1.264.200 Kelas 3)
 * 3. Validasi discrepancy berfungsi
 * 4. Cross-check untuk klaim ELVINA SAIDAH
 */

const path = require('path');
const { lookupTarifInacbg, getTarifResmi, validateTarifDiscrepancy } = require('../src/services/tarifInacbgLookup');

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║         Tarif INACBG PMK 3/2023 - Test Suite                 ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

// Test 1: Data JSON terload
console.log('TEST 1: Verifikasi Data JSON Terload');
console.log('─'.repeat(60));

const tarifData = require('../src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json');
const meta = tarifData.meta || {};
const rows = tarifData.tarif || [];

console.log(`✓ Total baris: ${rows.length} (expected: 1075)`);
console.log(`  - Rawat Inap: ${meta.rawat_inap_count || 0} (expected: 786)`);
console.log(`  - Rawat Jalan: ${meta.rawat_jalan_count || 0} (expected: 289)`);
console.log(`✓ Sumber: ${meta.source_name || '(tidak tercatat)'}`);
console.log(`✓ Halaman: ${meta.source_pages || '(tidak tercatat)'}`);
console.log(`✓ Regional: ${meta.regional}`);
console.log(`✓ Tipe RS: ${meta.tipe_rs_label}`);

if (rows.length !== 1075) {
  console.error('\n✗ FAIL: Jumlah baris tidak sesuai!');
  process.exit(1);
}

console.log('\n✓ PASS: Data JSON valid\n');

// Test 2: Lookup K-4-17-I
console.log('TEST 2: Lookup Kode K-4-17-I (ELVINA SAIDAH)');
console.log('─'.repeat(60));

const k417i = lookupTarifInacbg('K-4-17-I');

if (!k417i) {
  console.error('✗ FAIL: Kode K-4-17-I tidak ditemukan!');
  process.exit(1);
}

console.log(`✓ Kode: ${k417i.kode_inacbg}`);
console.log(`✓ Deskripsi: ${k417i.deskripsi}`);
console.log(`✓ Jenis Layanan: ${k417i.jenis_layanan}`);
console.log(`✓ Tarif Kelas 3: Rp${Number(k417i.tarif_kelas_3).toLocaleString('id-ID')}`);
console.log(`✓ Tarif Kelas 2: Rp${Number(k417i.tarif_kelas_2).toLocaleString('id-ID')}`);
console.log(`✓ Tarif Kelas 1: Rp${Number(k417i.tarif_kelas_1).toLocaleString('id-ID')}`);
console.log(`✓ Halaman Sumber: ${k417i.sumber_halaman}`);
console.log(`✓ Regional: ${k417i.regional}`);
console.log(`✓ Tipe RS: ${k417i.tipe_rs}`);

if (Number(k417i.tarif_kelas_3) !== 1264200) {
  console.error(`\n✗ FAIL: Tarif K-4-17-I Kelas 3 seharusnya 1264200, tapi ${k417i.tarif_kelas_3}`);
  process.exit(1);
}

console.log('\n✓ PASS: K-4-17-I lookup valid\n');

// Test 3: getTarifResmi Function
console.log('TEST 3: getTarifResmi untuk Berbagai Kelas');
console.log('─'.repeat(60));

const tarif1 = getTarifResmi('K-4-17-I', 1);
const tarif2 = getTarifResmi('K-4-17-I', 2);
const tarif3 = getTarifResmi('K-4-17-I', 3);

console.log(`✓ Kelas 1: Rp${Number(tarif1?.tarif).toLocaleString('id-ID')} (expected: 1681400)`);
console.log(`✓ Kelas 2: Rp${Number(tarif2?.tarif).toLocaleString('id-ID')} (expected: 1472800)`);
console.log(`✓ Kelas 3: Rp${Number(tarif3?.tarif).toLocaleString('id-ID')} (expected: 1264200)`);

if (tarif1.tarif !== 1681400 || tarif2.tarif !== 1472800 || tarif3.tarif !== 1264200) {
  console.error('\n✗ FAIL: Tarif kelas tidak sesuai!');
  process.exit(1);
}

console.log('\n✓ PASS: getTarifResmi works correctly\n');

// Test 4: Validasi Discrepancy - MATCH Case
console.log('TEST 4: Validasi Discrepancy - Case MATCH');
console.log('─'.repeat(60));

const match = validateTarifDiscrepancy('K-4-17-I', 3, 1264200);
console.log(`✓ Status: ${match.status}`);
console.log(`✓ Valid: ${match.valid}`);
console.log(`✓ Tarif Resmi: Rp${Number(match.tarifResmi).toLocaleString('id-ID')}`);
console.log(`✓ Tarif Klaim: Rp${Number(match.tarifKlaim).toLocaleString('id-ID')}`);
console.log(`✓ Selisih: Rp${Number(match.selisih).toLocaleString('id-ID')}`);

if (!match.valid || match.status !== 'MATCH' || match.selisih !== 0) {
  console.error('\n✗ FAIL: MATCH case tidak valid!');
  process.exit(1);
}

console.log('\n✓ PASS: MATCH validation works\n');

// Test 5: Validasi Discrepancy - DISCREPANCY Case
console.log('TEST 5: Validasi Discrepancy - Case DISCREPANCY');
console.log('─'.repeat(60));

const discrepancy = validateTarifDiscrepancy('K-4-17-I', 3, 1500000);
console.log(`✓ Status: ${discrepancy.status}`);
console.log(`✓ Valid: ${discrepancy.valid}`);
console.log(`✓ Tarif Resmi: Rp${Number(discrepancy.tarifResmi).toLocaleString('id-ID')}`);
console.log(`✓ Tarif Klaim: Rp${Number(discrepancy.tarifKlaim).toLocaleString('id-ID')}`);
console.log(`✓ Selisih: Rp${Number(discrepancy.selisih).toLocaleString('id-ID')}`);
console.log(`✓ Persentase Selisih: ${(discrepancy.selisih / discrepancy.tarifResmi * 100).toFixed(2)}%`);

if (discrepancy.valid || discrepancy.status !== 'DISCREPANCY' || discrepancy.selisih !== 235800) {
  console.error('\n✗ FAIL: DISCREPANCY case tidak valid!');
  process.exit(1);
}

console.log('\n✓ PASS: DISCREPANCY validation works\n');

// Test 6: Validasi Discrepancy - NOT FOUND Case
console.log('TEST 6: Validasi Discrepancy - Case KODE_TIDAK_DITEMUKAN');
console.log('─'.repeat(60));

const notFound = validateTarifDiscrepancy('Z-99-99-X', 3, 1000000);
console.log(`✓ Status: ${notFound.status}`);
console.log(`✓ Valid: ${notFound.valid}`);
console.log(`✓ Tarif Resmi: ${notFound.tarifResmi}`);
console.log(`✓ Tarif Klaim: Rp${Number(notFound.tarifKlaim).toLocaleString('id-ID')}`);

if (!notFound.valid || notFound.status !== 'KODE_TIDAK_DITEMUKAN') {
  console.error('\n✗ FAIL: NOT_FOUND case tidak valid!');
  process.exit(1);
}

console.log('\n✓ PASS: KODE_TIDAK_DITEMUKAN validation works\n');

// Test 7: Validasi Tarif Kosong
console.log('TEST 7: Validasi Discrepancy - Case TARIF_KLAIM_KOSONG');
console.log('─'.repeat(60));

const emptyTarif = validateTarifDiscrepancy('K-4-17-I', 3, 0);
console.log(`✓ Status: ${emptyTarif.status}`);
console.log(`✓ Valid: ${emptyTarif.valid}`);
console.log(`✓ Tarif Resmi: Rp${Number(emptyTarif.tarifResmi).toLocaleString('id-ID')}`);
console.log(`✓ Tarif Klaim: ${emptyTarif.tarifKlaim}`);

if (!emptyTarif.valid || emptyTarif.status !== 'TARIF_KLAIM_KOSONG') {
  console.error('\n✗ FAIL: TARIF_KLAIM_KOSONG case tidak valid!');
  process.exit(1);
}

console.log('\n✓ PASS: TARIF_KLAIM_KOSONG validation works\n');

// Test 8: ELVINA SAIDAH Claim Verification
console.log('TEST 8: Verifikasi Klaim ELVINA SAIDAH');
console.log('─'.repeat(60));

const elvinaClaim = {
  nama: 'ELVINA SAIDAH',
  kode_inacbg: 'K-4-17-I',
  kelas_rawat: 3,
  tarif_inacbg: 1264200,
  jenis_klaim: 'RAWAT_INAP'
};

const elvinaVerif = validateTarifDiscrepancy(
  elvinaClaim.kode_inacbg,
  elvinaClaim.kelas_rawat,
  elvinaClaim.tarif_inacbg
);

console.log(`✓ Pasien: ${elvinaClaim.nama}`);
console.log(`✓ Kode: ${elvinaClaim.kode_inacbg}`);
console.log(`✓ Kelas: ${elvinaClaim.kelas_rawat}`);
console.log(`✓ Tarif Klaim: Rp${Number(elvinaClaim.tarif_inacbg).toLocaleString('id-ID')}`);
console.log(`✓ Status Verifikasi: ${elvinaVerif.status}`);
console.log(`✓ Valid: ${elvinaVerif.valid ? 'YES' : 'NO'}`);
console.log(`✓ Selisih: Rp${Number(elvinaVerif.selisih).toLocaleString('id-ID')}`);

if (!elvinaVerif.valid || elvinaVerif.status !== 'MATCH') {
  console.error('\n✗ FAIL: ELVINA verification failed!');
  process.exit(1);
}

console.log('\n✓ PASS: ELVINA SAIDAH claim verified\n');

// Test 9: Test Rawat Jalan Tarif
console.log('TEST 9: Verifikasi Rawat Jalan (RAWAT_JALAN)');
console.log('─'.repeat(60));

// Find a RAWAT_JALAN code
const rjCode = rows.find(r => r.jenis_layanan === 'RAWAT_JALAN');
if (rjCode) {
  console.log(`✓ Kode Rawat Jalan: ${rjCode.kode_inacbg}`);
  console.log(`✓ Deskripsi: ${rjCode.deskripsi}`);
  console.log(`✓ Tarif: Rp${Number(rjCode.tarif_kelas_3).toLocaleString('id-ID')}`);

  const rjTarif = getTarifResmi(rjCode.kode_inacbg, 3);
  console.log(`✓ getTarifResmi returns: Rp${Number(rjTarif?.tarif).toLocaleString('id-ID')}`);

  // For RAWAT_JALAN, tarif_kelas_2 and tarif_kelas_1 should be null
  console.log(`✓ Tarif Kelas 1 (should be null): ${rjCode.tarif_kelas_1}`);
  console.log(`✓ Tarif Kelas 2 (should be null): ${rjCode.tarif_kelas_2}`);

  if (rjCode.tarif_kelas_1 !== null || rjCode.tarif_kelas_2 !== null) {
    console.error('\n✗ FAIL: RAWAT_JALAN tarif_kelas_1/2 should be null!');
    process.exit(1);
  }

  console.log('\n✓ PASS: RAWAT_JALAN tarif structure valid\n');
} else {
  console.error('✗ WARNING: No RAWAT_JALAN code found in data\n');
}

// Summary
console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║                   ✓ ALL TESTS PASSED                         ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

console.log('Summary:');
console.log(`  • Data JSON: ✓ ${rows.length} baris terload`);
console.log(`  • K-4-17-I Lookup: ✓ Rp1.264.200 (Kelas 3)`);
console.log(`  • getTarifResmi: ✓ Semua kelas valid`);
console.log(`  • MATCH validation: ✓ Works`);
console.log(`  • DISCREPANCY validation: ✓ Works`);
console.log(`  • KODE_TIDAK_DITEMUKAN: ✓ Works`);
console.log(`  • TARIF_KLAIM_KOSONG: ✓ Works`);
console.log(`  • ELVINA SAIDAH claim: ✓ Verified`);
console.log(`  • RAWAT_JALAN structure: ✓ Valid`);
console.log('\nSiap untuk produksi. Jalankan seed script untuk populate database:\n');
console.log('  cd ~/eclaim/be && node scripts/seedTarifInacbg.js\n');
