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
  splitToList,
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

  describe('Resume Medis IGD: diagnosis, prosedur & findings notation', () => {
    it('should extract Diagnosis Utama, Sekunder, dan Prosedur sebagai list', () => {
      const mockPages = [{
        page_number: 1,
        text: `RESUME MEDIS IGD
Diagnosis Utama : Demam Berdarah Dengue
Diagnosis Sekunder : 1. Dehidrasi ringan
2. Trombositopenia
Tindakan/Prosedur : 1. Pemasangan infus
2. Observasi tanda vital
Keadaan Pulang: Membaik`,
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.diagnosis_list).toEqual([
        'Demam Berdarah Dengue', 'Dehidrasi ringan', 'Trombositopenia'
      ]);
      expect(result.prosedur_list).toEqual([
        'Pemasangan infus', 'Observasi tanda vital'
      ]);
    });

    it('should stop capture di batas halaman (tidak bocor ke halaman berikutnya)', () => {
      const mockPages = [
        { page_number: 1, text: 'Diagnosis Utama : Appendisitis Akut', confidence: 95 },
        { page_number: 2, text: 'TRIASE IGD\nKeluhan Utama : Nyeri perut', confidence: 95 }
      ];

      const result = extractClinicalFields(mockPages);

      expect(result.structured_text.DiagnosisUtama).toBe('Appendisitis Akut');
      expect(result.structured_text.DiagnosisUtama).not.toMatch(/TRIASE|Keluhan/i);
    });

    it('should detect bilateral notation detail (+/+, −/−, +/−, −/+) per temuan', () => {
      const mockPages = [{
        page_number: 1,
        text: 'Pemeriksaan fisik: ronchi +/+ whezing -/- edema +/- murmur -/+',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.clinical_findings_notation.whezing).toMatchObject({ ada: false, sisi: 'negatif' });
      expect(result.clinical_findings_notation.edema).toMatchObject({ ada: true, sisi: 'kanan' });
      expect(result.clinical_findings_notation.murmur).toMatchObject({ ada: true, sisi: 'kiri', page: 1 });
    });

    it('should detect Ronchi boolean finding dengan notasi slash (+/+)', () => {
      const mockPages = [{
        page_number: 1,
        text: 'Auskultasi: Ronchi +/+ Whezing -/-',
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.clinical_findings.Ronchi).toBe(true);
    });
  });

  describe('Triage IGD: Vital Sign table, Pengkajian Keperawatan & Primary Survey', () => {
    it('should parse tabel Vital Sign posisional (header + 1 baris nilai tanpa label)', () => {
      const mockPages = [{
        page_number: 2,
        text: `VITAL SIGN
BB   TB   TD   Heart Rate   RR   Temp
55 kg   160 cm   110/70 mmHg   88 x/mnt   20 x/mnt   37.8 C
PRIMARY SURVEY
Airway : Paten`,
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.vital_signs.Weight.value).toBe('55');
      expect(result.vital_signs.Height.value).toBe('160');
      expect(result.vital_signs.BloodPressure.value).toBe('110/70');
      expect(result.vital_signs.HeartRate.value).toBe('88');
      expect(result.vital_signs.Temperature.value).toBe('37.8');
    });

    it('should extract Pengkajian Keperawatan box (keluhan, riwayat, skala nyeri, skor ESI)', () => {
      const mockPages = [{
        page_number: 2,
        text: `PENGKAJIAN KEPERAWATAN
Keluhan Utama : Demam 3 hari, mual muntah
Riwayat Penyakit Sekarang : Demam sejak 3 hari SMRS
Skala Nyeri : 4
Skor ESI : 2
VITAL SIGN
BB TB TD`,
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.pengkajian_keperawatan.keluhan).toBe('Demam 3 hari, mual muntah');
      expect(result.pengkajian_keperawatan.riwayat_penyakit).toBe('Demam sejak 3 hari SMRS');
      expect(result.pengkajian_keperawatan.skala_nyeri).toBe('4');
      expect(result.pengkajian_keperawatan.skor_esi).toBe('2');
    });

    it('should extract Primary Survey fields (Airway/Breathing/Circulation/Disability/Exposure)', () => {
      const mockPages = [{
        page_number: 2,
        text: `PRIMARY SURVEY
Airway : Paten, tidak ada sumbatan
Breathing : Spontan, RR 20x/menit
Circulation : Akral hangat, CRT < 2 detik
Disability : GCS 15, compos mentis
Exposure : Tidak ada jejas`,
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);

      expect(result.primary_survey.Airway).toBe('Paten, tidak ada sumbatan');
      expect(result.primary_survey.Breathing).toBe('Spontan, RR 20x/menit');
      expect(result.primary_survey.Circulation).toBe('Akral hangat, CRT < 2 detik');
      expect(result.primary_survey.Disability).toBe('GCS 15, compos mentis');
      expect(result.primary_survey.Exposure).toBe('Tidak ada jejas');
    });
  });

  describe('Assessment/Lembar Lain: Psikososial, Diagnosis Keperawatan, Pengkajian Fungsional', () => {
    it('should extract 3 field Assessment dan classify sebagai assessment_keperawatan', () => {
      const mockPages = [{
        page_number: 3,
        text: `PSIKOSOSIAL/SPIRITUAL : Pasien kooperatif, didampingi keluarga
DIAGNOSIS KEPERAWATAN : Hipertermi berhubungan dengan proses infeksi
PENGKAJIAN FUNGSIONAL : Mandiri, tidak ada keterbatasan aktivitas`,
        confidence: 95
      }];

      const result = extractClinicalFields(mockPages);
      expect(result.assessment.psikososial_spiritual).toBe('Pasien kooperatif, didampingi keluarga');
      expect(result.assessment.diagnosis_keperawatan).toBe('Hipertermi berhubungan dengan proses infeksi');
      expect(result.assessment.pengkajian_fungsional).toBe('Mandiri, tidak ada keterbatasan aktivitas');

      const classification = classifyPageContent(mockPages[0].text);
      expect(classification.type).toBe('assessment_keperawatan');
    });

    it('should not downgrade type resume_medis_igd yang juga menyebut vital sign', () => {
      const text = `RESUME MEDIS IGD
Pasien: Firdan
Triage: Sedang
Vital Signs: HR 77, RR 18, SpO2 95%`;

      const result = classifyPageContent(text);
      expect(result.type).toBe('resume_medis_igd');
    });
  });

  describe('splitToList', () => {
    it('should split numbered list jadi array item', () => {
      expect(splitToList('1. Pemasangan infus\n2. Observasi tanda vital')).toEqual([
        'Pemasangan infus', 'Observasi tanda vital'
      ]);
    });

    it('should return empty array untuk input kosong/null', () => {
      expect(splitToList('')).toEqual([]);
      expect(splitToList(null)).toEqual([]);
    });

    it('should strip bullet marker dan skip item kosong/"-"', () => {
      expect(splitToList('- Infus\n-\n- Observasi')).toEqual(['Infus', 'Observasi']);
    });
  });
});
