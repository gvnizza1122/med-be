const request = require('supertest');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

jest.mock('../../database/init', () => {
  const mockDb = {
    prepare: jest.fn().mockReturnThis(),
    get: jest.fn().mockResolvedValue(null),
    all: jest.fn().mockResolvedValue([]),
    run: jest.fn().mockResolvedValue({ changes: 0 }),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn().mockImplementation(async (cb) => {
      const mockTx = {
        prepare: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ changes: 0 })
      };
      return cb(mockTx);
    })
  };

  return {
    getDb: jest.fn(() => ({ ...mockDb, initialize: jest.fn().mockResolvedValue() })),
    closeDb: jest.fn()
  };
});

jest.mock('../../services/auditService', () => ({
  logAudit: jest.fn()
}));

const app = require('../../index');

const JWT_SECRET = process.env.JWT_SECRET || 'eclaim-secret';

function generateToken(userOverrides = {}) {
  const defaultUser = {
    userId: uuidv4(),
    email: 'test@example.com',
    role: 'verifikator',
    ...userOverrides
  };
  return jwt.sign(defaultUser, JWT_SECRET, { expiresIn: '1h' });
}

describe('Health Check', () => {
  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('1.0.0');
  });
});

describe('Auth API', () => {
  describe('POST /api/v1/auth/login', () => {
    test('returns 400 when email and password are missing', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('wajib diisi');
    });

    test('returns 400 when password is missing', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({ username: 'test@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('wajib diisi');
    });

    test('returns 401 for non-existent user', async () => {
      const { getDb } = require('../../database/init');
      getDb().prepare().get.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'nonexistent@example.com', password: 'password123' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('salah');
    });

    test('returns 401 for inactive user', async () => {
      const { getDb } = require('../../database/init');
      getDb().prepare().get.mockResolvedValue({
        id: 'user-1',
        email: 'inactive@example.com',
        password_hash: '$2a$10$dummyhash',
        is_active: 0,
        role: 'verifikator',
        full_name: 'Inactive User',
        hospital_code: '3371084'
      });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ username: 'inactive@example.com', password: 'password123' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('tidak aktif');
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    test('returns 400 when refresh token is missing', async () => {
      const res = await request(app).post('/api/v1/auth/refresh').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Refresh token diperlukan');
    });

    test('returns 401 for invalid refresh token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refresh_token: 'invalid-token' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    test('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    test('returns user data with valid token', async () => {
      const { getDb } = require('../../database/init');
      getDb().prepare().get.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        full_name: 'Test User',
        role: 'verifikator',
        hospital_code: '3371084',
        is_active: 1
      });

      const token = generateToken();
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('test@example.com');
    });
  });
});

describe('Bridging API', () => {
  describe('POST /api/v1/bridging/validate', () => {
    test('returns 401 without API key', async () => {
      const res = await request(app)
        .post('/api/v1/bridging/validate')
        .send({ sep: 'TEST001' });
      expect(res.status).toBe(401);
    });

    test('returns 400 with empty body', async () => {
      const res = await request(app)
        .post('/api/v1/bridging/validate')
        .set('X-API-Key', process.env.SIMRS_API_KEY || 'eclaim-simrs-secret-key-12345')
        .send({});
      expect(res.status).toBe(400);
    });

    test('returns validation result with valid request', async () => {
      const res = await request(app)
        .post('/api/v1/bridging/validate')
        .set('X-API-Key', process.env.SIMRS_API_KEY || 'eclaim-simrs-secret-key-12345')
        .send({ sep: 'TEST001', nama_pasien: 'BUDI' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body).toHaveProperty('validation_status');
      expect(res.body).toHaveProperty('errors');
    });
  });
});

describe('Dashboard API', () => {
  describe('GET /api/v1/dashboard/summary', () => {
    test('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/dashboard/summary');
      expect(res.status).toBe(401);
    });

    test('returns summary with valid token', async () => {
      const { getDb } = require('../../database/init');
      getDb().prepare().get.mockResolvedValueOnce({ id: 'user-1', is_active: 1 });

      const mockCountResult = { count: '10' };
      getDb().prepare().get.mockResolvedValue(mockCountResult);
      getDb().prepare().all
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const token = generateToken();
      const res = await request(app)
        .get('/api/v1/dashboard/summary')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_files');
      expect(res.body).toHaveProperty('total_claims');
    });
  });

  describe('GET /api/v1/dashboard/error-trends', () => {
    test('returns 401 without token', async () => {
      const res = await request(app).get('/api/v1/dashboard/error-trends');
      expect(res.status).toBe(401);
    });
  });
});

describe('Claim File Upload API', () => {
  function createValidTxtContent() {
    const header = 'SEP\tNOKARTU\tNAMA_PASIEN\tDIAGNOSA\tPROSEDUR\tTGLMASUK\tTGLKELUAR\tTGLLAHIR\tUMUR_TAHUN\tJK\tKELAS_RAWAT\tTARIF_RS\tTARIF_INACBG\tLOS\tSTATUS_PULANG\tJENIS_RAWAT\tDPJP';
    const row1 = '0101R0010724\t0000012345678\tBUDI SANTOSO\tI10;E11.9\t88.72\t01/01/2024\t05/01/2024\t01/01/1990\t34\tL\t3\t5000000\t4200000\t4\t1\tRAWAT_INAP\tDr. Andi';
    const row2 = '0101R0010725\t0000098765432\tSITI AISYAH\tJ45.9\t93.38;99.04\t02/01/2024\t02/01/2024\t15/06/1995\t29\tP\t2\t3000000\t2800000\t1\t1\tRAWAT_JALAN\tDr. Budi';
    return `${header}\n${row1}\n${row2}`;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/claim-files/upload', () => {
    test('returns 401 without token', async () => {
      const res = await request(app)
        .post('/api/v1/claim-files/upload')
        .attach('file', Buffer.from(createValidTxtContent()), 'test-claim.txt');
      expect(res.status).toBe(401);
    });

    test('returns 400 when no file is attached', async () => {
      const { getDb } = require('../../database/init');
      getDb().prepare().get.mockResolvedValue({
        id: 'user-1', email: 'test@example.com', full_name: 'Test User',
        role: 'verifikator', hospital_code: '3371084', is_active: 1
      });

      const token = generateToken();
      const res = await request(app)
        .post('/api/v1/claim-files/upload')
        .set('Authorization', `Bearer ${token}`)
        .field('description', 'test upload');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('File tidak ditemukan');
    });

    test('uploads and validates file successfully', async () => {
      const { getDb } = require('../../database/init');
      const db = getDb();

      db.prepare().get.mockResolvedValue({
        id: 'user-1', email: 'test@example.com', full_name: 'Test User',
        role: 'verifikator', hospital_code: '3371084', is_active: 1
      });

      db.prepare().all.mockResolvedValue([]);
      db.prepare().run.mockResolvedValue({ changes: 1 });

      const token = generateToken();
      const res = await request(app)
        .post('/api/v1/claim-files/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(createValidTxtContent()), 'test-claim.txt');

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('completed');
      expect(res.body).toHaveProperty('file_id');
      expect(res.body.summary.total_records).toBe(2);
      expect(res.body.summary).toHaveProperty('valid');
      expect(res.body.summary).toHaveProperty('error');
    });

    test('processes file with custom rules', async () => {
      const { getDb } = require('../../database/init');
      const db = getDb();

      db.prepare().get.mockResolvedValue({
        id: 'user-1', email: 'test@example.com', full_name: 'Test User',
        role: 'verifikator', hospital_code: '3371084', is_active: 1
      });

      const customRule = {
        id: 'RV-CUSTOM', rule_code: 'RV-CUSTOM', is_active: 1,
        rule_type: 'configurable', error_message: 'Nama pasien wajib diisi',
        rule_logic: JSON.stringify({ checks: [{ field: 'nama_pasien', operator: 'required', severity: 'critical' }] })
      };
      db.prepare().all.mockResolvedValue([customRule]);
      db.prepare().run.mockResolvedValue({ changes: 1 });

      const token = generateToken();
      const res = await request(app)
        .post('/api/v1/claim-files/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(createValidTxtContent()), 'test-claim.txt');

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('completed');
    });

    test('handles invalid TXT file gracefully', async () => {
      const { getDb } = require('../../database/init');
      const db = getDb();

      db.prepare().get.mockResolvedValue({
        id: 'user-1', email: 'test@example.com', full_name: 'Test User',
        role: 'verifikator', hospital_code: '3371084', is_active: 1
      });

      const token = generateToken();
      const res = await request(app)
        .post('/api/v1/claim-files/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('BROKEN DATA WITHOUT HEADER'), 'broken.txt');

      expect(res.status).toBe(400);
    });
  });
});
