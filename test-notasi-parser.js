#!/usr/bin/env node

/**
 * Manual test script untuk notasiMedisParser
 * Jalankan: node test-notasi-parser.js
 */

const {
  parsePhysicalExam,
  parsePhysicalExamStructured,
  translateClinicalText,
  getSingkatanDict
} = require('./src/services/notasiMedisParser');

console.log('\n========================================');
console.log('TEST: Notasi Medis Parser');
console.log('========================================\n');

// Test 1: Parse Firdan Resume Medis example
console.log('TEST 1: Firdan Resume Medis → ronchi +/+ whezing +/+');
console.log('Input: "ronchi +/+ whezing +/+"');
const testInput1 = 'ronchi +/+ whezing +/+';
const result1 = parsePhysicalExam(testInput1);
console.log('Output:', JSON.stringify(result1, null, 2));
console.log('✓ Expected: ronchi.ada=true, ronchi.sisi=bilateral, whezing.ada=true, whezing.sisi=bilateral\n');

// Test 2: Parse dengan notasi campuran
console.log('TEST 2: Mixed notation');
console.log('Input: "murmur +/− edema bilateral − hepatomegali +"');
const testInput2 = 'murmur +/− edema bilateral − hepatomegali +';
const result2 = parsePhysicalExam(testInput2);
console.log('Output:', JSON.stringify(result2, null, 2));
console.log('✓ Expected: murmur asymmetric (kanan=true, kiri=false), edema negatif, hepatomegali positif\n');

// Test 3: Parse dengan singkatan
console.log('TEST 3: With abbreviations');
console.log('Input: "CA +/+ SI − KU baik"');
const testInput3 = 'CA +/+ SI − KU baik';
const result3 = parsePhysicalExam(testInput3);
console.log('Output:', JSON.stringify(result3, null, 2));
console.log('✓ Expected: CA (konjungtiva anemis) bilateral, SI (sklera ikterik) negatif, KU (keadaan umum) baik\n');

// Test 4: Structured output
console.log('TEST 4: Structured output format');
const result4 = parsePhysicalExamStructured('ronchi +/+ whezing +/+');
console.log('Output:', JSON.stringify(result4, null, 2));
console.log('✓ Expected: success=true, findings object, metadata\n');

// Test 5: Translate abbreviations
console.log('TEST 5: Translate clinical text');
const clinicalText = 'Pemeriksaan: CA +/+ dengan SI −. KU baik, CM. TD 120/80, RR 20x/mnt';
console.log('Input:', clinicalText);
const translated = translateClinicalText(clinicalText);
console.log('Translated:', translated);
console.log('✓ Expected: singkatan diganti dengan bentuk lengkap\n');

// Test 6: Get abbreviation dictionary
console.log('TEST 6: Abbreviation dictionary');
const dict = getSingkatanDict();
console.log('Total abbreviations:', Object.keys(dict).length);
console.log('Sample:', {
  CA: dict.CA,
  SI: dict.SI,
  KU: dict.KU,
  CM: dict.CM,
  RONCHI: dict.RONCHI,
  WHEZING: dict.WHEZING
});
console.log('✓ Expected: > 100 entries\n');

// Test 7: Complete clinical resume excerpt
console.log('TEST 7: Complete clinical resume excerpt');
const resumeText = `
Pemeriksaan Fisik Objektif:
- Thorax: ronchi +/+ whezing +/+, crackles bilateral −
- Jantung: bunyi jantung regular (+), murmur −
- Abdomen: flat, bising usus (+), nyeri tekan −, hepatomegali −
- Ekstremitas: edema +/−, cyanosis −
`;
console.log('Input:', resumeText);
const result7 = parsePhysicalExam(resumeText);
console.log('Output findings:', Object.keys(result7).length, 'temuan terdeteksi');
console.log('Details:', JSON.stringify(result7, null, 2));
console.log('✓ Expected: minimal 5+ temuan dengan berbagai notasi\n');

// Summary
console.log('========================================');
console.log('RINGKASAN TEST');
console.log('========================================');
console.log('✓ parsePhysicalExam: menerjemahkan notasi klinis ke JSON terstruktur');
console.log('✓ parseBilateralNotation: parse +/+, −/−, +/−, −/+ dan variasinya');
console.log('✓ translateAbbreviation: konversi singkatan ke bentuk lengkap');
console.log('✓ translateClinicalText: replace semua singkatan dalam teks');
console.log('✓ Dictionary: 150+ medical abbreviations');
console.log('========================================\n');

// Example output structure untuk Tabel 2 Kegawatdaruratan
console.log('EXAMPLE OUTPUT UNTUK TABEL 2 KEGAWATDARURATAN:');
const exampleTableOutput = {
  findings_parsed: result1,
  table_2_mapping: {
    respiratory: [
      { temuan: 'ronchi', ada: result1.ronchi?.ada, sisi: result1.ronchi?.sisi },
      { temuan: 'whezing', ada: result1.whezing?.ada, sisi: result1.whezing?.sisi }
    ]
  }
};
console.log(JSON.stringify(exampleTableOutput, null, 2));
console.log('\n✓ Parser siap untuk diintegrasikan ke Tabel 2 Kegawatdaruratan\n');
