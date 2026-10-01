/**
 * Unit test untuk notasiMedisParser.js
 * Test parsing notasi medis dan singkatan klinis
 */

const {
  parsePhysicalExam,
  parsePhysicalExamStructured,
  parseBilateralNotation,
  parseSingleNotation,
  translateAbbreviation,
  translateClinicalText,
  getSingkatanDict
} = require('../../services/notasiMedisParser');

describe('notasiMedisParser', () => {
  describe('parseBilateralNotation', () => {
    test('should parse +/+ (bilateral positif)', () => {
      const result = parseBilateralNotation('+/+');
      expect(result).toEqual({
        ada: true,
        sisi: 'bilateral',
        kanan: true,
        kiri: true
      });
    });

    test('should parse −/− (bilateral negatif)', () => {
      const result = parseBilateralNotation('−/−');
      expect(result).toEqual({
        ada: false,
        sisi: 'negatif',
        kanan: false,
        kiri: false
      });
    });

    test('should parse +/− (kanan positif, kiri negatif)', () => {
      const result = parseBilateralNotation('+/−');
      expect(result).toEqual({
        ada: true,
        sisi: 'kanan',
        kanan: true,
        kiri: false
      });
    });

    test('should parse −/+ (kanan negatif, kiri positif)', () => {
      const result = parseBilateralNotation('−/+');
      expect(result).toEqual({
        ada: true,
        sisi: 'kiri',
        kanan: false,
        kiri: true
      });
    });

    test('should handle spaces in notation', () => {
      const result = parseBilateralNotation('+ / +');
      expect(result).toEqual({
        ada: true,
        sisi: 'bilateral',
        kanan: true,
        kiri: true
      });
    });

    test('should return null for invalid notation', () => {
      expect(parseBilateralNotation('invalid')).toBeNull();
      expect(parseBilateralNotation('')).toBeNull();
      expect(parseBilateralNotation(null)).toBeNull();
    });
  });

  describe('parseSingleNotation', () => {
    test('should parse + (positif)', () => {
      const result = parseSingleNotation('+');
      expect(result).toEqual({ ada: true });
    });

    test('should parse − (negatif)', () => {
      const result = parseSingleNotation('−');
      expect(result).toEqual({ ada: false });
    });

    test('should parse - (hyphen as negatif)', () => {
      const result = parseSingleNotation('-');
      expect(result).toEqual({ ada: false });
    });

    test('should return null for invalid notation', () => {
      expect(parseSingleNotation('invalid')).toBeNull();
      expect(parseSingleNotation('')).toBeNull();
    });
  });

  describe('parsePhysicalExam', () => {
    test('should parse single finding with bilateral notation', () => {
      const result = parsePhysicalExam('ronchi +/+');
      expect(result).toHaveProperty('ronchi');
      expect(result.ronchi).toMatchObject({
        ada: true,
        sisi: 'bilateral',
        kanan: true,
        kiri: true,
        notasi_asli: '+/+',
        translasi: 'suara napas tambahan kasar'
      });
    });

    test('should parse multiple findings (Firdan Resume Medis example)', () => {
      const text = 'ronchi +/+ whezing +/+';
      const result = parsePhysicalExam(text);

      expect(Object.keys(result).length).toBeGreaterThanOrEqual(2);
      expect(result).toHaveProperty('ronchi');
      expect(result).toHaveProperty('whezing');

      expect(result.ronchi).toMatchObject({
        ada: true,
        sisi: 'bilateral'
      });

      expect(result.whezing).toMatchObject({
        ada: true,
        sisi: 'bilateral'
      });
    });

    test('should parse mixed notation (some bilateral, some single)', () => {
      const text = 'ronchi +/+ edema bilateral −';
      const result = parsePhysicalExam(text);

      expect(result).toHaveProperty('ronchi');
      expect(result.ronchi.ada).toBe(true);
      expect(result.ronchi.sisi).toBe('bilateral');

      expect(result).toHaveProperty('edema bilateral');
      expect(result['edema bilateral'].ada).toBe(false);
    });

    test('should handle newline-separated findings', () => {
      const text = `ronchi +/+
whezing +/+
hepatomegali −`;
      const result = parsePhysicalExam(text);

      expect(Object.keys(result).length).toBeGreaterThanOrEqual(3);
    });

    test('should handle semicolon-separated findings', () => {
      const text = 'ronchi +/+; whezing +/+; edema −';
      const result = parsePhysicalExam(text);

      expect(Object.keys(result).length).toBeGreaterThanOrEqual(3);
    });

    test('should handle right/left asymmetric findings', () => {
      const result = parsePhysicalExam('murmur +/−');

      expect(result).toHaveProperty('murmur');
      expect(result.murmur).toMatchObject({
        ada: true,
        sisi: 'kanan',
        kanan: true,
        kiri: false
      });
    });

    test('should handle empty string gracefully', () => {
      const result = parsePhysicalExam('');
      expect(result).toEqual({});
    });

    test('should handle null gracefully', () => {
      const result = parsePhysicalExam(null);
      expect(result).toEqual({});
    });

    test('should translate abbreviations in findings', () => {
      const result = parsePhysicalExam('CA +/+ SI −');

      // CA should be in result (case-insensitive key)
      const hasCA = Object.keys(result).some(key => key.toLowerCase().includes('ca'));
      expect(hasCA).toBe(true);
    });
  });

  describe('parsePhysicalExamStructured', () => {
    test('should return structured result with metadata', () => {
      const result = parsePhysicalExamStructured('ronchi +/+');

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('findings');
      expect(result).toHaveProperty('raw_input');
      expect(result).toHaveProperty('parsed_at');
      expect(result.findings).toHaveProperty('ronchi');
    });

    test('should return success=false for empty input', () => {
      const result = parsePhysicalExamStructured('');
      expect(result.success).toBe(false);
    });
  });

  describe('translateAbbreviation', () => {
    test('should translate common medical abbreviations', () => {
      expect(translateAbbreviation('CA')).toBe('konjungtiva anemis');
      expect(translateAbbreviation('SI')).toBe('sklera ikterik');
      expect(translateAbbreviation('KU')).toBe('keadaan umum');
      expect(translateAbbreviation('CM')).toBe('compos mentis');
    });

    test('should handle case-insensitive translation', () => {
      expect(translateAbbreviation('ca')).toBe('konjungtiva anemis');
      expect(translateAbbreviation('Ca')).toBe('konjungtiva anemis');
    });

    test('should return original if not found', () => {
      const original = 'unknown_abbrev';
      expect(translateAbbreviation(original)).toBe(original);
    });

    test('should handle empty string', () => {
      expect(translateAbbreviation('')).toBe('');
      expect(translateAbbreviation(null)).toBe(null);
    });
  });

  describe('translateClinicalText', () => {
    test('should replace multiple abbreviations in text', () => {
      const text = 'CA +/+ SI − KU baik';
      const result = translateClinicalText(text);

      expect(result).toContain('konjungtiva anemis');
      expect(result).toContain('sklera ikterik');
      expect(result).toContain('keadaan umum');
    });

    test('should preserve notation and non-abbreviation text', () => {
      const text = 'Pemeriksaan: CA +/+ dengan SI −';
      const result = translateClinicalText(text);

      expect(result).toContain('+/+');
      expect(result).toContain('−');
      expect(result).toContain('Pemeriksaan:');
    });
  });

  describe('getSingkatanDict', () => {
    test('should return dictionary object', () => {
      const dict = getSingkatanDict();
      expect(typeof dict).toBe('object');
      expect(Object.keys(dict).length).toBeGreaterThan(100);
    });

    test('should contain expected abbreviations', () => {
      const dict = getSingkatanDict();
      expect(dict).toHaveProperty('CA');
      expect(dict).toHaveProperty('SI');
      expect(dict).toHaveProperty('KU');
      expect(dict).toHaveProperty('CM');
    });
  });

  describe('Complex clinical text scenarios', () => {
    test('should parse complete resume medis excerpt', () => {
      const clinicalText = `
Pemeriksaan Fisik:
Keadaan umum: baik
Vital signs: TD 120/80, N 80x/mnt, RR 20x/mnt, S 36.5°C
Thorax: ronchi +/+ whezing +/+, crackles di basal bilateral −
Abdomen: flat, bising usus (+), nyeri rebound −, hepatomegali +, splenomegali −
Ekstremitas: edema +/−
      `;

      const result = parsePhysicalExam(clinicalText);

      // Minimal must find at least some findings
      expect(Object.keys(result).length).toBeGreaterThan(0);
    });

    test('should handle mixed notation styles in resume', () => {
      const text = `
Objektif:
Pemeriksaan Paru: ronchi +/+, whezing +/+
Jantung: bising jantung normal (+), murmur −
Perut: distension − ascites −
      `;

      const result = parsePhysicalExam(text);
      expect(result).toBeDefined();
    });
  });
});
