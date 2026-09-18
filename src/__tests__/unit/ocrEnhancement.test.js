/**
 * Unit tests untuk OCR Enhancement Module
 *
 * Tests untuk:
 * - Clinical field extraction (vital signs & findings)
 * - Page classification
 * - Validation logic
 * - Pattern matching accuracy
 */

const {
  extractClinicalFields,
  classifyPageContent,
  validateVitalSigns,
  CLINICAL_PATTERNS
} = require('../../services/ocrEnhancement');

describe('OCR Enhancement Module', () => {
  describe('extractClinicalFields', () => {
    it('should extract HR from standard format', () => {
      const mockPages = [{
        page_number: 1,
        text: 'Tanda Vital:\nHR: 77 bpm\nRR: 18 x/min',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.HeartRate).toBeDefined();
      expect(result.vital_signs.HeartRate.value).toBe('77');
      expect(result.vital_signs.HeartRate.page).toBe(1);
    });

    it('should extract SpO2 with percentage symbol', () => {
      const mockPages = [{
        page_number: 1,
        text: 'SpO2: 95%',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.SpO2).toBeDefined();
      expect(result.vital_signs.SpO2.value).toBe('95');
    });

    it('should extract BP in systolic/diastolic format', () => {
      const mockPages = [{
        page_number: 1,
        text: 'Tekanan Darah: 130/80 mmHg',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.BloodPressure).toBeDefined();
      expect(result.vital_signs.BloodPressure.value).toBe('130/80');
    });

    it('should detect ronchi finding', () => {
      const mockPages = [{
        page_number: 2,
        text: 'Auskultasi: Ronchi +/+ Whezing -/-',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.clinical_findings.Ronchi).toBe(true);
      expect(result.clinical_findings.Whezing).toBeUndefined();
    });

    it('should extract multiple vital signs from one page', () => {
      const mockPages = [{
        page_number: 1,
        text: `
          VITAL SIGNS:
          HR: 77 bpm
          RR: 18 x/min
          SpO2: 95%
          BP: 130/80 mmHg
          Temp: 37.2°C
        `,
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(Object.keys(result.vital_signs).length).toBeGreaterThanOrEqual(4);
      expect(result.vital_signs.HeartRate).toBeDefined();
      expect(result.vital_signs.RespiratoryRate).toBeDefined();
      expect(result.vital_signs.SpO2).toBeDefined();
      expect(result.vital_signs.BloodPressure).toBeDefined();
    });

    it('should handle empty pages', () => {
      const result = extractClinicalFields([]);

      expect(result.vital_signs).toEqual({});
      expect(result.clinical_findings).toEqual({});
    });

    it('should return empty result for null input', () => {
      const result = extractClinicalFields(null);

      expect(result.vital_signs).toEqual({});
      expect(result.clinical_findings).toEqual({});
    });
  });

  describe('classifyPageContent', () => {
    it('should classify Resume Medis IGD page', () => {
      const text = `
        RESUME MEDIS IGD
        Pasien: Firdan
        Triage: Sedang
        Vital Signs: HR 77, RR 18, SpO2 95%
      `;

      const result = classifyPageContent(text);

      expect(result.type).toBe('resume_medis_igd');
      expect(result.sections).toContain('vital_signs');
      expect(result.sections).toContain('triage');
    });

    it('should classify Triage page', () => {
      const text = `
        TRIASE
        Vital Sign:
        BP: 130/80
        HR: 77
        RR: 18
        SpO2: 95%
      `;

      const result = classifyPageContent(text);

      expect(result.type).toBe('triage');
      expect(result.sections).toContain('vital_signs');
    });

    it('should classify Resume Medis Rawat Inap', () => {
      const text = `
        RESUME MEDIS RAWAT INAP
        Diagnosis: Pneumonia
        Pemeriksaan Fisik: Ronchi +/+
      `;

      const result = classifyPageContent(text);

      expect(result.type).toBe('resume_medis_inap');
      expect(result.sections).toContain('physical_exam');
    });

    it('should classify SEP page', () => {
      const text = `
        SURAT ELIGIBILITAS PESERTA
        No. SEP: 0170R0110626V000012
        Peserta: Firdan
      `;

      const result = classifyPageContent(text);

      expect(result.type).toBe('sep');
      expect(result.sections).toContain('eligibility');
    });

    it('should detect clinical keywords', () => {
      const text = `
        Pemeriksaan Fisik:
        - Ronchi +/+
        - Whezing -/-
        - Palpasi: normal
        - Edema -/-
      `;

      const result = classifyPageContent(text);

      expect(result.keywords_found).toContain('ronchi');
      expect(result.keywords_found).toContain('whezing');
      expect(result.keywords_found).toContain('palpasi');
      expect(result.keywords_found).toContain('edema');
    });

    it('should handle null input gracefully', () => {
      const result = classifyPageContent(null);

      expect(result.type).toBe('general');
      expect(result.sections).toEqual([]);
    });
  });

  describe('validateVitalSigns', () => {
    it('should validate normal HR', () => {
      const vitalSigns = {
        HeartRate: { value: '77' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.validated_values.HeartRate).toBe(77);
    });

    it('should warn for low HR (bradycardia)', () => {
      const vitalSigns = {
        HeartRate: { value: '35' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(true); // warning saja, not error
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('bradikardia');
    });

    it('should error for very high HR', () => {
      const vitalSigns = {
        HeartRate: { value: '250' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should validate normal SpO2', () => {
      const vitalSigns = {
        SpO2: { value: '95' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(true);
      expect(result.validated_values.SpO2).toBe(95);
    });

    it('should error for critical SpO2 (<80%)', () => {
      const vitalSigns = {
        SpO2: { value: '75' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('kritical');
    });

    it('should warn for SpO2 >100%', () => {
      const vitalSigns = {
        SpO2: { value: '105' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should validate temperature range', () => {
      const vitalSigns = {
        Temperature: { value: '37.5' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(true);
      expect(result.validated_values.Temperature).toBe(37.5);
    });

    it('should error for extreme temperature', () => {
      const vitalSigns = {
        Temperature: { value: '43' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(false);
    });

    it('should validate RR in normal range', () => {
      const vitalSigns = {
        RespiratoryRate: { value: '18' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(true);
      expect(result.validated_values.RespiratoryRate).toBe(18);
    });

    it('should handle multiple vital signs', () => {
      const vitalSigns = {
        HeartRate: { value: '77' },
        RespiratoryRate: { value: '18' },
        SpO2: { value: '95' },
        Temperature: { value: '37.2' },
        BloodPressure: { value: '130/80' }
      };

      const result = validateVitalSigns(vitalSigns);

      expect(result.valid).toBe(true);
      expect(Object.keys(result.validated_values).length).toBe(5);
    });
  });

  describe('CLINICAL_PATTERNS', () => {
    it('should have patterns for all vital signs', () => {
      expect(CLINICAL_PATTERNS.SpO2).toBeDefined();
      expect(CLINICAL_PATTERNS.HeartRate).toBeDefined();
      expect(CLINICAL_PATTERNS.RespiratoryRate).toBeDefined();
      expect(CLINICAL_PATTERNS.BloodPressure).toBeDefined();
      expect(CLINICAL_PATTERNS.Temperature).toBeDefined();
      expect(CLINICAL_PATTERNS.Weight).toBeDefined();
      expect(CLINICAL_PATTERNS.Height).toBeDefined();
    });

    it('should have patterns for clinical findings', () => {
      expect(CLINICAL_PATTERNS.Ronchi).toBeDefined();
      expect(CLINICAL_PATTERNS.Whezing).toBeDefined();
      expect(CLINICAL_PATTERNS.Murmur).toBeDefined();
      expect(CLINICAL_PATTERNS.Crackles).toBeDefined();
      expect(CLINICAL_PATTERNS.Edema).toBeDefined();
    });

    it('should match HR variations', () => {
      const patterns = CLINICAL_PATTERNS.HeartRate;

      expect('HR: 77 bpm'.match(patterns[0])?.[1]).toBe('77');
      expect('Heart rate: 88 bpm'.match(patterns[1])?.[1]).toBe('88');
      expect('Nadi: 95 bpm'.match(patterns[2])?.[1]).toBe('95');
    });

    it('should match BP variations', () => {
      const patterns = CLINICAL_PATTERNS.BloodPressure;
      const match = 'BP: 130/80 mmHg'.match(patterns[0]);

      expect(match?.[1]).toBe('130');
      expect(match?.[2]).toBe('80');
    });
  });

  describe('Edge cases', () => {
    it('should handle malformed vital signs gracefully', () => {
      const mockPages = [{
        page_number: 1,
        text: 'HR: invalid bpm',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.HeartRate).toBeUndefined();
    });

    it('should handle mixed case text', () => {
      const mockPages = [{
        page_number: 1,
        text: 'HR: 77 BPM\nspO2: 95%',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.HeartRate?.value).toBe('77');
      expect(result.vital_signs.SpO2?.value).toBe('95');
    });

    it('should handle whitespace variations', () => {
      const mockPages = [{
        page_number: 1,
        text: 'HR  :  77  bpm',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.HeartRate?.value).toBe('77');
    });
  });
});
