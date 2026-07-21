const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'E-Claim BPJS Validator API',
    version: '1.0.0',
    description: `API Bridging untuk Pre-Validasi Klaim BPJS RS Mitra Keluarga Batang.
    \\
    Berdasarkan BA Kesepakatan Bersama BPJS No. 1247/2024.`,
    contact: {
      name: 'RS Mitra Keluarga Batang — IT',
      email: 'it@rsmitrabatang.id',
    },
  },
  servers: [
    { url: 'http://localhost:5000', description: 'Development' },
    { url: 'https://eclaim.rsmitrabatang.id', description: 'Production' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API Key untuk bridging integration. Hubungi admin RS untuk mendapatkan key.',
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token dari endpoint /api/v1/auth/login',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Deskripsi error.' },
        },
      },
      ClaimRecord: {
        type: 'object',
        required: ['sep', 'nokartu', 'nama_pasien', 'kode_rs', 'admission_date', 'discharge_date', 'gender', 'diagnosa_list', 'prosedur_list'],
        properties: {
          sep: { type: 'string', example: '0634R0020226V000001', description: 'No. SEP BPJS (19 karakter)' },
          nokartu: { type: 'string', example: '0001210056092', description: 'No. Kartu BPJS (13 digit)' },
          nama_pasien: { type: 'string', example: 'BUDI SANTOSO', description: 'Nama pasien huruf kapital' },
          mrn: { type: 'string', example: '00004961', description: 'No. Rekam Medis' },
          kode_rs: { type: 'string', example: '3371084', description: 'Kode RS BPJS' },
          kelas_rs: { type: 'integer', example: 3 },
          kelas_rawat: { type: 'integer', example: 1, description: '1=Kelas 1, 2=Kelas 2, 3=Kelas 3' },
          jenis_rawat: { type: 'integer', example: 1, description: '1=Rawat Inap, 2=Rawat Jalan' },
          gender: { type: 'string', example: 'L', description: 'L/P' },
          admission_date: { type: 'string', format: 'date', example: '02/03/2026', description: 'DD/MM/YYYY' },
          discharge_date: { type: 'string', format: 'date', example: '11/03/2026' },
          birth_date: { type: 'string', format: 'date', example: '15/06/1978' },
          umur_tahun: { type: 'integer', example: 47 },
          umur_hari: { type: 'integer', example: 0 },
          birth_weight: { type: 'number', example: 3200, description: 'Berat lahir (gram)' },
          diagnosa_list: { type: 'string', example: 'A09;J18.0;E11.9', description: 'ICD-10 codes dipisah ;' },
          prosedur_list: { type: 'string', example: '99.29;92.29', description: 'ICD-9-CM codes dipisah ;' },
          discharge_status: { type: 'integer', example: 1, description: '1=Sembuh, 2=Rujuk, 3=Meninggal, 4=APS' },
          los: { type: 'integer', example: 9, description: 'Length of Stay (hari)' },
          icu_indikator: { type: 'integer', example: 0 },
          icu_los: { type: 'integer', example: 0 },
          vent_hour: { type: 'number', example: 0 },
          tarif_rs: { type: 'number', example: 9500000 },
          tarif_inacbg: { type: 'number', example: 8200000 },
          total_tarif: { type: 'number', example: 9500000 },
          inacbg_code: { type: 'string', example: 'K-4-15-I' },
          dpjp_name: { type: 'string', example: 'dr. SUTRISNO Sp.PD' },
          adl1: { type: 'number' },
          adl2: { type: 'number' },
          subacute: { type: 'integer' },
          chronic: { type: 'integer' },
          coder_id: { type: 'string' },
          payor_id: { type: 'string' },
        },
      },
      ValidationError: {
        type: 'object',
        properties: {
          rule_id: { type: 'string', example: 'RV-01' },
          field_name: { type: 'string', example: 'nokartu' },
          severity: { type: 'string', enum: ['critical', 'major', 'warning'], example: 'critical' },
          error_message: { type: 'string', example: 'Nomer Kartu BPJS harus 13 digit.' },
          expected: { type: 'string', example: '13 digit numerik' },
          actual: { type: 'string', example: '0001210056092' },
        },
      },
      ValidationResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'success' },
          validation_status: { type: 'string', enum: ['valid', 'warning', 'error'] },
          rule_errors_count: { type: 'integer', example: 0 },
          errors: { type: 'array', items: { $ref: '#/components/schemas/ValidationError' } },
          ai_audit: {
            type: 'object',
            nullable: true,
            properties: {
              status: { type: 'string' },
              reason: { type: 'string' },
              suggestion: { type: 'string' },
            },
          },
        },
      },
      BulkValidationResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'success' },
          total_records: { type: 'integer', example: 50 },
          errors_found: { type: 'boolean', example: true },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                row_number: { type: 'integer' },
                nama_pasien: { type: 'string' },
                sep: { type: 'string' },
                nokartu: { type: 'string' },
                mrn: { type: 'string' },
                validation_status: { type: 'string', enum: ['valid', 'warning', 'error'] },
                errors: { type: 'array', items: { $ref: '#/components/schemas/ValidationError' } },
                ai_audit: { type: 'object', nullable: true },
              },
            },
          },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'admin@rsmitrabatang.id' },
          password: { type: 'string', example: 'Admin@2026' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          access_token: { type: 'string' },
          refresh_token: { type: 'string' },
          expires_in: { type: 'integer', example: 3600 },
          user: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              full_name: { type: 'string' },
              role: { type: 'string', enum: ['admin', 'coder', 'verifikator'] },
              hospital_code: { type: 'string' },
            },
          },
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          timestamp: { type: 'string', format: 'date-time' },
          version: { type: 'string', example: '1.0.0' },
        },
      },
    },
  },
  tags: [
    { name: 'Bridging', description: 'API untuk integrasi SIMRS / INACBG' },
    { name: 'Auth', description: 'Autentikasi dashboard admin' },
    { name: 'Claim Files', description: 'Upload & manajemen file klaim' },
    { name: 'Health', description: 'Health check & monitoring' },
  ],
};

const options = {
  swaggerDefinition,
  apis: [
    path.join(__dirname, 'routes', '*.js'),
    path.join(__dirname, 'index.js'),
  ],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
