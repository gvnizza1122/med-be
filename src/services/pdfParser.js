const { PDFParse } = require('pdf-parse');
const fs = require('fs');

// Regex patterns untuk setiap field
const FIELD_PATTERNS = {
  noRM: [
    /No\s*\.?\s*RM\s*[:=]?\s*(\d+)/i,
    /MR\.\s*(\d+)/i,
  ],
  noKartu: [
    /No\s*\.?\s*Kartu\s*[:=]?\s*([\d\s]+)/i,
  ],
  nama: [
    /Nama\s*(?:Peserta)?\s*[:=]?\s*([A-Z][A-Z\s.,]+)/,
    /Nama\s*[:=]?\s*([^\n]+)/i,
  ],
  tglLahir: [
    /Tgl\s*\.?\s*[Ll]ahir\s*[:=]?\s*([\d\-\/]+)/i,
  ],
  tglSEP: [
    /Tgl\s*\.?\s*SEP\s*[:=]?\s*([\d\-\/]+)/i,
  ],
  noSEP: [
    /No\s*\.?\s*SEP\s*[:=]?\s*(0170[A-Z0-9]+)/i,
    /No\s*Versi\s*BPJS\s*[:=]?\s*(0170[A-Z0-9]+)/i,
  ],
  kelasRawat: [
    /Kls\s*\.?\s*Rawat\s*[:=]?\s*(\d)/i,
    /Kelas\s*[:=]?\s*(\d)\s/i,
  ],
  dokter: [
    /DPJP\s*[:=]?\s*([^\n]+)/i,
    /Dokter\s*[:=]?\s*(dr\.[^\n]+)/i,
  ],
  alamat: [
    /Alamat\s*[:=]?\s*([^\n]+)/i,
  ],
  diagnosaAwal: [
    /Diagnosa\s*Awal\s*[:=]?\s*([^\n]+)/i,
  ],
  diagnosUtama: [
    /Diagnosis\s*Utama\s*[:=]?\s*\n([^\n]+)/i,
    /Diagnosa\s*[:=]?\s*([^\n]+)/i,
  ],
  diagnosSekunder: [
    /Diagnosis\s*Sekunder\s*[:=]?\s*\n([\s\S]*?)(?=Tindakan|$)/i,
  ],
  tindakan: [
    /Tindakan\s*\/?\s*Prosedur\s*[:=]?\s*\n([\s\S]*?)(?=Terapi|$)/i,
  ],
  tglMasuk: [
    /Tanggal\s*MRS\s*[:=]?\s*([^\n]+)/i,
    /(?:ADMISSION|Tgl\s*\.?\s*Masuk)\s*[:=]?\s*([\d\-\/]+)/i,
  ],
  tglKeluar: [
    /Tgl\s*\.?\s*Keluar\s*[:=]?\s*([\d\-\/]+)/i,
    /(?:DISCHARGE)\s*[:=]?\s*([\d\-\/]+)/i,
  ],
  jnsRawat: [
    /Jns\s*\.?\s*Rawat\s*[:=]?\s*([^\n]+)/i,
  ],
  jenisKelamin: [
    /Kelamin\s*[:=]?\s*(Laki-laki|Perempuan|L|P)/i,
    /\(([PL])\)/,
  ],
};

function extractField(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let value = match[1].trim();
      value = value.replace(/[\s:=;,]*$/g, '').trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

const MONTH_MAP = {
  jan: '01', januari: '01', january: '01',
  feb: '02', februari: '02', february: '02',
  mar: '03', maret: '03', march: '03',
  apr: '04', april: '04',
  mei: '05', may: '05',
  jun: '06', juni: '06', june: '06',
  jul: '07', juli: '07', july: '07',
  agu: '08', agustus: '08', aug: '08', august: '08',
  sep: '09', september: '09',
  okt: '10', oktober: '10', oct: '10', october: '10',
  nov: '11', november: '11',
  des: '12', desember: '12', dec: '12', december: '12',
};

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  // "12 Jun 2026" or "12 Juni 2026"
  const named = s.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
  if (named) {
    const m = MONTH_MAP[named[2].toLowerCase()];
    if (m) return `${named[3]}-${m}-${named[1].padStart(2, '0')}`;
  }

  return s;
}

async function parsePDF(filePath) {
  const result = {
    success: false,
    fields: {},
    vclaimFormat: {}, // 60 kolom vClaim format
    rawText: '',
    pages: [],
    metadata: { totalPages: 0, extractedFields: 0, pagesScanned: 0 },
    errors: [],
  };

  try {
    let data;
    if (typeof filePath === 'string') {
      data = fs.readFileSync(filePath);
    } else {
      data = filePath;
    }

    const parser = new PDFParse({ data });
    const pdfResult = await parser.getText();

    result.rawText = pdfResult.text;
    result.metadata.totalPages = pdfResult.totalPages || 0;

    // ponytail: Split pages by marker "-- N of M --" dan scan SEMUA halaman
    const pageChunks = pdfResult.text.split(/--\s*\d+\s*of\s*\d+\s*--/i);
    result.pages = pageChunks.filter(p => p.trim().length > 0);
    result.metadata.pagesScanned = result.pages.length;

    // Combine ALL pages for comprehensive extraction (bukan hanya 3 pertama)
    const allPages = result.pages.join('\n');

    // Extract standard fields dari semua halaman
    for (const [fieldName, patterns] of Object.entries(FIELD_PATTERNS)) {
      const value = extractField(allPages, patterns);
      if (value) {
        if (fieldName.startsWith('tgl') || fieldName === 'tglSEP') {
          result.fields[fieldName] = normalizeDate(value);
        } else if (fieldName === 'noKartu') {
          result.fields[fieldName] = value.replace(/\s/g, '');
        } else {
          result.fields[fieldName] = value;
        }
        result.metadata.extractedFields++;
      }
    }

    // ponytail: Map ke vClaim 60-column format (hanya field yang relevan)
    // Field yang E-Claim ambil dari PDF:
    const vclaimBase = {
      KODE_RS: '3371084',
      KELAS_RAWAT: result.fields.kelasRawat || '',
      ADMISSION_DATE: result.fields.tglMasuk || '',
      DISCHARGE_DATE: result.fields.tglKeluar || '',
      BIRTH_DATE: result.fields.tglLahir || '',
      BIRTH_WEIGHT: '',
      SEX: result.fields.jenisKelamin === 'P' || result.fields.jenisKelamin === 'Perempuan' ? '2' : result.fields.jenisKelamin === 'L' || result.fields.jenisKelamin === 'Laki-laki' ? '1' : '',
      DISCHARGE_STATUS: result.fields.dischargeStatus || '1',
      DIAGLIST: result.fields.diagnosUtama || '',
      PROCLIST: result.fields.tindakan || '',
      NAMA_PASIEN: result.fields.nama || '',
      MRN: result.fields.noRM || '',
      DPJP: result.fields.dokter || '',
      SEP: result.fields.noSEP || '',
      NOKARTU: result.fields.noKartu || '',
      TARIF_RS: result.fields.tarifRS || '',
      LOS: '', // vClaim isi
      ALAMAT: result.fields.alamat || '',
    };

    // Field kosong (vClaim isi sendiri):
    const vclaimFilled = {
      KELAS_RS: 'D',
      KODE_TARIF: 'DS',
      PTD: '1',
      ADL1: '',
      ADL2: '',
      IN_SP: '',
      IN_SR: '',
      IN_SI: '',
      IN_SD: '',
      INACBG: '',
      SUBACUTE: '',
      CHRONIC: '',
      SP: '',
      SR: '',
      SI: '',
      SD: '',
      DESKRIPSI_INACBG: '',
      TARIF_INACBG: '',
      TARIF_SUBACUTE: '',
      TARIF_CHRONIC: '',
      DESKRIPSI_SP: '',
      TARIF_SP: '',
      DESKRIPSI_SR: '',
      TARIF_SR: '',
      DESKRIPSI_SI: '',
      TARIF_SI: '',
      DESKRIPSI_SD: '',
      TARIF_SD: '',
      TOTAL_TARIF: '',
      TARIF_POLI_EKS: '',
      ICU_INDIKATOR: '',
      ICU_LOS: '',
      VENT_HOUR: '',
      UMUR_TAHUN: '', // Bisa hitung dari BIRTH_DATE
      UMUR_HARI: '',
      PAYOR_ID: '',
      CODER_ID: '',
      VERSI_INACBG: '',
      VERSI_GROUPER: '',
      C1: '',
      C2: '',
      C3: '',
      C4: '',
    };

    result.vclaimFormat = { ...vclaimBase, ...vclaimFilled };
    result.success = true;
  } catch (error) {
    result.errors.push({ type: 'parse_error', message: error.message });
  }

  return result;
}

function validateFields(fields, requiredFields = ['noRM', 'noKartu', 'nama']) {
  const errors = [];
  const warnings = [];

  for (const field of requiredFields) {
    if (!fields[field]) errors.push(`Required field missing: ${field}`);
  }

  if (fields.noKartu && !/^\d{13}$/.test(fields.noKartu.replace(/\D/g, ''))) {
    warnings.push(`No.Kartu bukan 13 digit: ${fields.noKartu}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { parsePDF, validateFields, extractField, normalizeDate };
