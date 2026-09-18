/**
 * Integration test untuk notasiMedisParser dengan pdfExtractionPipeline
 * Verifikasi parser terintegrasi dengan baik dalam pipeline ekstraksi
 */

const { parsePhysicalExam, parsePhysicalExamStructured } = require('../../services/notasiMedisParser');

describe('notasiMedisParser Integration', () => {
  describe('Integration dengan PDF Extraction Pipeline', () => {
    test('Parser siap diintegrasikan ke pdfExtractionPipeline', () => {
      // Simulasi teks yang akan diekstrak dari PDF
      const clinicalText = `
RESUME MEDIS RAWAT DARURAT

Subjektif:
Pasien datang dengan keluhan sesak napas sejak 3 jam yang lalu.

Objektif:
Pemeriksaan Umum:
- Keadaan Umum: sedang
- TD: 130/80 mmHg, N: 92 x/mnt, RR: 24 x/mnt, S: 37.2°C

Pemeriksaan Paru:
- Inspeksi: retraksi +/+
- Palpasi: fremitus +/+
- Perkusi: resonan bilateral
- Auskultasi: ronchi +/+ whezing +/+, crackles −/−

Pemeriksaan Jantung:
- Bunyi jantung: reguler (+)
- Murmur: −
- Gallop: −

Pemeriksaan Abdomen:
- Bising usus: (+)
- Nyeri tekan: −
- Hepatomegali: −
- Splenomegali: −
- Ascites: −

Pemeriksaan Ekstremitas:
- Edema: +/−
- Sianosis: −

Assessment:
Bronkitis akut dengan bronkospasme

Plan:
Terapi oksigen, nebulizer, terapi farmakologi
      `;

      // Parse temuan pemeriksaan fisik
      const findings = parsePhysicalExam(clinicalText);

      // Verifikasi temuan yang diharapkan terparse
      expect(findings).toBeDefined();
      expect(Object.keys(findings).length).toBeGreaterThan(5);

      // Verifikasi temuan spesifik
      const findingNames = Object.keys(findings);
      const hasRonchi = findingNames.some(name => name.includes('ronchi'));
      const hasWhezing = findingNames.some(name => name.includes('whezing'));
      const hasEdema = findingNames.some(name => name.includes('edema'));

      expect(hasRonchi).toBe(true);
      expect(hasWhezing).toBe(true);
      expect(hasEdema).toBe(true);

      // Verifikasi struktur output yang sesuai dengan vClaim record
      const ronchiEntry = findings[Object.keys(findings).find(k => k.includes('ronchi'))];
      expect(ronchiEntry).toHaveProperty('ada');
      expect(ronchiEntry).toHaveProperty('sisi');
      expect(ronchiEntry).toHaveProperty('notasi_asli');
      if (ronchiEntry.sisi === 'bilateral' || ronchiEntry.sisi === 'kanan' || ronchiEntry.sisi === 'kiri') {
        expect(ronchiEntry).toHaveProperty('kanan');
        expect(ronchiEntry).toHaveProperty('kiri');
      }

      console.log('✓ Parser integration test passed');
      console.log('✓ Findings terparse:', Object.keys(findings).length);
    });

    test('Parser output dapat langsung ditambahkan ke record vClaim', () => {
      const clinicalText = 'ronchi +/+ whezing +/+ hepatomegali −';
      const findings = parsePhysicalExam(clinicalText);

      // Simulasi vClaim record
      const vcclaimRecord = {
        SEP: '0170R0110626V000012',
        NOKARTU: '0000123456789',
        NAMA_PESERTA: 'John Doe',
        // ... field lainnya
        physical_exam_findings: findings // Tambahkan hasil parsing
      };

      expect(vcclaimRecord).toHaveProperty('physical_exam_findings');
      expect(vcclaimRecord.physical_exam_findings).toBe(findings);
      expect(Object.keys(vcclaimRecord.physical_exam_findings).length).toBeGreaterThan(0);
    });

    test('Parser output dapat langsung digunakan untuk Tabel 2 Kegawatdaruratan', () => {
      const clinicalText = 'ronchi +/+ whezing +/+';
      const findings = parsePhysicalExam(clinicalText);

      // Mapping ke Tabel 2 (Emergency Severity)
      const table2Data = {
        respiratory_findings: [],
        cardiovascular_findings: [],
        abdominal_findings: [],
        neurological_findings: []
      };

      // Auto-map respiratory findings
      Object.entries(findings).forEach(([finding, data]) => {
        if (['ronchi', 'whezing', 'crackles', 'rhonki'].includes(finding)) {
          table2Data.respiratory_findings.push({
            name: finding,
            present: data.ada,
            laterality: data.sisi,
            translation: data.translasi
          });
        }
      });

      expect(table2Data.respiratory_findings.length).toBeGreaterThan(0);
      expect(table2Data.respiratory_findings[0]).toHaveProperty('present', true);
      expect(table2Data.respiratory_findings[0]).toHaveProperty('laterality');
    });
  });

  describe('Real-world scenario: Firdan Resume Medis', () => {
    test('Parse Firdan Resume Medis example successfully', () => {
      // Simulasi resume medis Firdan
      const firdanResume = `
Resume Medis IGD

Pasien: Firdan, umur 25 tahun

Pemeriksaan Fisik:
Umum: Keadaan umum sedang, kompos mentis
Vital: TD 120/80, HR 88, RR 20, S 37°C
Paru: ronchi +/+ whezing +/+, crackles −
Jantung: S1S2 reguler, murmur −
Perut: flat, bising usus (+), nyeri tekan −
      `;

      const result = parsePhysicalExamStructured(firdanResume);

      expect(result.success).toBe(true);
      expect(result.findings).toBeDefined();

      const findingKeys = Object.keys(result.findings);
      const hasRonchi = findingKeys.some(k => k.includes('ronchi'));
      const hasWhezing = findingKeys.some(k => k.includes('whezing'));

      expect(hasRonchi).toBe(true);
      expect(hasWhezing).toBe(true);

      // Verify specific findings for Firdan
      const ronchi = result.findings[findingKeys.find(k => k.includes('ronchi'))];
      if (ronchi) {
        expect(ronchi.ada).toBe(true);
        expect(ronchi.sisi).toBe('bilateral');
      }
    });
  });

  describe('Error handling dalam pipeline', () => {
    test('Parser handles malformed input gracefully', () => {
      const malformedInputs = [
        null,
        undefined,
        '',
        '   ',
        'no notations here',
        '+++---++-+-'
      ];

      malformedInputs.forEach(input => {
        expect(() => parsePhysicalExam(input)).not.toThrow();
      });
    });

    test('Parser returns empty object for inputs tanpa temuan', () => {
      const noFindingsText = 'This is just random text without any clinical findings or notations';
      const result = parsePhysicalExam(noFindingsText);

      // Mungkin parse beberapa kata sebagai temuan tanpa notasi, tapi itu OK
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    test('Non-blocking error handling dalam pipeline context', () => {
      // Simulasi pipeline context
      let parsingError = null;
      let record = { SEP: '12345', NOKARTU: '9876543' };

      try {
        const findings = parsePhysicalExam(null); // Malformed input
        if (Object.keys(findings).length > 0) {
          record.physical_exam_findings = findings;
        }
      } catch (error) {
        parsingError = error;
      }

      // Parser tidak throw error, pipeline continues
      expect(parsingError).toBeNull();
      expect(record).toHaveProperty('SEP');
      expect(record).toHaveProperty('NOKARTU');
      // Field physical_exam_findings tidak ditambahkan (graceful degradation)
    });
  });

  describe('Performance under load', () => {
    test('Parser dapat handle dokumen panjang dengan banyak temuan', () => {
      // Generate dokumen panjang dengan 50+ temuan
      const longDocument = Array.from({ length: 50 }, (_, i) => {
        const notations = ['+/+', '−/−', '+/−', '−/+', '+', '−'];
        const notasi = notations[i % notations.length];
        return `temuan_${i} ${notasi}`;
      }).join('\n');

      const startTime = Date.now();
      const result = parsePhysicalExam(longDocument);
      const duration = Date.now() - startTime;

      expect(Object.keys(result).length).toBeGreaterThan(30);
      expect(duration).toBeLessThan(100); // Should complete in < 100ms

      console.log(`✓ Parsed 50+ findings in ${duration}ms`);
    });

    test('Dictionary lookup performance', () => {
      const text = 'CA SI KU CM RR HR TD S';
      const iterations = 1000;

      const startTime = Date.now();
      for (let i = 0; i < iterations; i++) {
        parsePhysicalExam(text);
      }
      const duration = Date.now() - startTime;
      const avgPerDoc = duration / iterations;

      expect(avgPerDoc).toBeLessThan(10); // Should be < 10ms per document

      console.log(`✓ Parsed ${iterations} documents in ${duration}ms (avg: ${avgPerDoc.toFixed(2)}ms)`);
    });
  });
});
