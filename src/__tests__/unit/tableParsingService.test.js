/**
 * Unit tests untuk Table Parsing Service
 */

const {
  parseTable,
  parseVitalSignsTable,
  parsePengkajianKeperawatanBox,
  parseAssessmentSection,
  splitRowTokens,
  looksLikeHeaderLine
} = require('../../services/tableParsingService');

describe('Table Parsing Service', () => {
  describe('splitRowTokens', () => {
    it('should split by runs of 2+ spaces (kolom tabel)', () => {
      expect(splitRowTokens('BB   TB   TD')).toEqual(['BB', 'TB', 'TD']);
    });

    it('should fallback ke single space kalau tidak ada run panjang', () => {
      expect(splitRowTokens('BB TB TD')).toEqual(['BB', 'TB', 'TD']);
    });

    it('should handle empty/null input', () => {
      expect(splitRowTokens('')).toEqual([]);
      expect(splitRowTokens(null)).toEqual([]);
    });
  });

  describe('looksLikeHeaderLine', () => {
    it('should return true untuk baris token pendek', () => {
      expect(looksLikeHeaderLine('BB   TB   TD   Heart Rate   RR   Temp')).toBe(true);
    });

    it('should return false untuk kalimat naratif panjang', () => {
      expect(looksLikeHeaderLine('Pasien datang dengan keluhan demam, mual, dan muntah sejak 3 hari.')).toBe(false);
    });

    it('should return false untuk baris 1 token saja', () => {
      expect(looksLikeHeaderLine('VITAL')).toBe(false);
    });
  });

  describe('parseTable', () => {
    it('should parse header + 1 baris data jadi {header, rows}', () => {
      const text = 'BB   TB   TD\n55 kg   160 cm   110/70 mmHg';
      const result = parseTable(text);

      expect(result.header).toEqual(['BB', 'TB', 'TD']);
      expect(result.rows).toEqual([
        { col1: '55 kg', col2: '160 cm', col3: '110/70 mmHg' }
      ]);
    });

    it('should return struktur kosong untuk teks tanpa tabel', () => {
      const result = parseTable('Ini cuma paragraf naratif biasa tanpa tabel sama sekali.');
      expect(result.header).toEqual([]);
      expect(result.rows).toEqual([]);
    });

    it('should return struktur kosong untuk input null/kosong', () => {
      expect(parseTable(null)).toEqual({ header: [], rows: [] });
      expect(parseTable('')).toEqual({ header: [], rows: [] });
    });

    it('should berhenti sebelum tabel/section berikutnya', () => {
      const text = 'BB   TB\n55 kg   160 cm\nPRIMARY SURVEY\nAirway : Paten';
      const result = parseTable(text);
      expect(result.rows.length).toBe(1);
    });
  });

  describe('parseVitalSignsTable', () => {
    it('should extract via label eksplisit ("Label: nilai")', () => {
      const text = 'VITAL SIGN\nBB: 60 kg\nTB: 165 cm\nTD: 120/80 mmHg\nHeart Rate: 90 x/mnt\nRR: 22 x/mnt\nTemp: 36.8 C';
      const result = parseVitalSignsTable(text);

      expect(result.Weight).toMatchObject({ value: '60', source: 'label' });
      expect(result.Height).toMatchObject({ value: '165', source: 'label' });
      expect(result.BloodPressure).toMatchObject({ value: '120/80', source: 'label' });
      expect(result.HeartRate).toMatchObject({ value: '90', source: 'label' });
      expect(result.RespiratoryRate).toMatchObject({ value: '22', source: 'label' });
      expect(result.Temperature).toMatchObject({ value: '36.8', source: 'label' });
    });

    it('should fallback ke tabel posisional kalau tidak ada label eksplisit', () => {
      const text = 'VITAL SIGN\nBB   TB   TD   Heart Rate   RR   Temp\n55 kg   160 cm   110/70 mmHg   88 x/mnt   20 x/mnt   37.8 C';
      const result = parseVitalSignsTable(text);

      expect(result.Weight).toMatchObject({ value: '55', source: 'table' });
      expect(result.HeartRate).toMatchObject({ value: '88', source: 'table' });
      expect(result.RespiratoryRate).toMatchObject({ value: '20', source: 'table' });
      // Field non-BloodPressure tidak boleh menyisakan karakter "/" dari unit "x/mnt"
      expect(result.HeartRate.value).not.toContain('/');
      expect(result.RespiratoryRate.value).not.toContain('/');
    });

    it('should return object kosong kalau tidak ada heading VITAL SIGN dan tidak ada label', () => {
      const result = parseVitalSignsTable('Pasien datang dengan keluhan demam.');
      expect(Object.keys(result).length).toBe(0);
    });

    it('should handle null/empty input', () => {
      expect(parseVitalSignsTable(null)).toEqual({});
      expect(parseVitalSignsTable('')).toEqual({});
    });
  });

  describe('parsePengkajianKeperawatanBox', () => {
    it('should extract keluhan, riwayat penyakit, skala nyeri, skor ESI', () => {
      const text = `PENGKAJIAN KEPERAWATAN
Keluhan Utama : Demam 3 hari, mual muntah
Riwayat Penyakit Sekarang : Demam sejak 3 hari SMRS
Skala Nyeri : 4
Skor ESI : 2
VITAL SIGN
BB TB TD`;
      const result = parsePengkajianKeperawatanBox(text);

      expect(result.keluhan).toBe('Demam 3 hari, mual muntah');
      expect(result.riwayat_penyakit).toBe('Demam sejak 3 hari SMRS');
      expect(result.skala_nyeri).toBe('4');
      expect(result.skor_esi).toBe('2');
    });

    it('should handle label "ESI" tanpa kata "Skor"', () => {
      const text = 'PENGKAJIAN KEPERAWATAN\nKeluhan : Nyeri dada\nESI : 3';
      const result = parsePengkajianKeperawatanBox(text);
      expect(result.skor_esi).toBe('3');
    });

    it('should return object kosong untuk teks tanpa box ini', () => {
      const result = parsePengkajianKeperawatanBox('Halaman resep obat biasa.');
      expect(Object.keys(result).length).toBe(0);
    });
  });

  describe('parseAssessmentSection', () => {
    it('should extract Psikososial/Spiritual, Diagnosis Keperawatan, Pengkajian Fungsional', () => {
      const text = `PSIKOSOSIAL/SPIRITUAL : Pasien kooperatif, didampingi keluarga
DIAGNOSIS KEPERAWATAN : Hipertermi berhubungan dengan proses infeksi
PENGKAJIAN FUNGSIONAL : Mandiri, tidak ada keterbatasan aktivitas`;
      const result = parseAssessmentSection(text);

      expect(result.psikososial_spiritual).toBe('Pasien kooperatif, didampingi keluarga');
      expect(result.diagnosis_keperawatan).toBe('Hipertermi berhubungan dengan proses infeksi');
      expect(result.pengkajian_fungsional).toBe('Mandiri, tidak ada keterbatasan aktivitas');
    });

    it('should return object kosong untuk teks tanpa section ini', () => {
      const result = parseAssessmentSection('Halaman SEP biasa.');
      expect(Object.keys(result).length).toBe(0);
    });
  });
});
