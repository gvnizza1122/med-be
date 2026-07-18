const { Pool } = require('pg');

let pool = null;
let isInitialized = false;
let initPromise = null;

function convertSql(sql) {
  if (!sql) return sql;
  let index = 1;
  let converted = sql.replace(/\?/g, () => `$${index++}`);
  converted = converted.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
  return converted;
}

const dbHelper = {
  async initialize() {
    if (isInitialized) return;
    if (initPromise) return initPromise;
    
    initPromise = (async () => {
      await initializeSchema();
      isInitialized = true;
      initPromise = null;
    })();
    return initPromise;
  },
  query(sql, params = []) {
    const converted = convertSql(sql);
    return pool.query(converted, params);
  },
  async get(sql, params = []) {
    const converted = convertSql(sql);
    const res = await pool.query(converted, params);
    return res.rows[0];
  },
  async all(sql, params = []) {
    const converted = convertSql(sql);
    const res = await pool.query(converted, params);
    return res.rows;
  },
  async run(sql, params = []) {
    const converted = convertSql(sql);
    const res = await pool.query(converted, params);
    return { changes: res.rowCount };
  },
  prepare(sql) {
    return {
      all: async (...params) => {
        const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        return dbHelper.all(sql, flattened);
      },
      get: async (...params) => {
        const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        return dbHelper.get(sql, flattened);
      },
      run: async (...params) => {
        const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        return dbHelper.run(sql, flattened);
      }
    };
  },
  async transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const clientWrapper = {
        query(sql, params = []) {
          const converted = convertSql(sql);
          return client.query(converted, params);
        },
        async get(sql, params = []) {
          const converted = convertSql(sql);
          const res = await client.query(converted, params);
          return res.rows[0];
        },
        async all(sql, params = []) {
          const converted = convertSql(sql);
          const res = await client.query(converted, params);
          return res.rows;
        },
        async run(sql, params = []) {
          const converted = convertSql(sql);
          const res = await client.query(converted, params);
          return { changes: res.rowCount };
        },
        prepare(sql) {
          return {
            all: async (...params) => {
              const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
              return clientWrapper.all(sql, flattened);
            },
            get: async (...params) => {
              const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
              return clientWrapper.get(sql, flattened);
            },
            run: async (...params) => {
              const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
              return clientWrapper.run(sql, flattened);
            }
          };
        }
      };

      const result = await callback(clientWrapper);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

function getDb() {
  if (pool) return dbHelper;

  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'eclaim',
  };

  if (process.env.DATABASE_URL) {
    config.connectionString = process.env.DATABASE_URL;
  }

  pool = new Pool(config);

  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
  });
  
  return dbHelper;
}

async function initializeSchema() {
  try {
    await dbHelper.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        nik TEXT UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('admin','supervisor','verifikator')),
        hospital_code TEXT NOT NULL DEFAULT '3371084',
        is_active INTEGER DEFAULT 1,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS claim_files (
        id TEXT PRIMARY KEY,
        hospital_code TEXT NOT NULL DEFAULT '3371084',
        file_name TEXT NOT NULL,
        file_path TEXT,
        period TEXT,
        total_records INTEGER DEFAULT 0,
        valid_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        pending_count INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'uploaded' CHECK(status IN ('uploaded','parsing','validating','completed','error','approved')),
        error_message TEXT,
        parsed_at TIMESTAMP,
        validated_at TIMESTAMP,
        uploaded_by TEXT REFERENCES users(id),
        approved_by TEXT REFERENCES users(id),
        approved_at TIMESTAMP,
        description TEXT,
        column_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS claim_records (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES claim_files(id) ON DELETE CASCADE,
        row_number INTEGER,
        kode_rs TEXT,
        sep TEXT,
        nokartu TEXT,
        nama_pasien TEXT,
        mrn TEXT,
        birth_date TEXT,
        umur_tahun INTEGER,
        umur_hari INTEGER DEFAULT 0,
        gender TEXT,
        kelas_rawat INTEGER,
        kelas_rs TEXT,
        admission_date TEXT,
        discharge_date TEXT,
        discharge_status INTEGER,
        los INTEGER DEFAULT 0,
        diagnosa_list TEXT,
        prosedur_list TEXT,
        inacbg_code TEXT,
        deskripsi_inacbg TEXT,
        tarif_inacbg DOUBLE PRECISION DEFAULT 0,
        tarif_rs DOUBLE PRECISION DEFAULT 0,
        total_tarif DOUBLE PRECISION DEFAULT 0,
        tarif_poli_eks DOUBLE PRECISION DEFAULT 0,
        icu_indikator INTEGER DEFAULT 0,
        icu_los INTEGER DEFAULT 0,
        vent_hour INTEGER DEFAULT 0,
        birth_weight INTEGER DEFAULT 0,
        dpjp_name TEXT,
        payor_id TEXT,
        coder_id TEXT,
        jenis_rawat TEXT,
        
        jenis_konsultasi TEXT,
        jumlah_episode_klaim INTEGER DEFAULT 1,
        is_same_day INTEGER DEFAULT 0,
        histori_obat_kronis_bulan_berturut INTEGER DEFAULT 0,
        status_pasien TEXT DEFAULT 'STABIL',
        flag_rujuk_balik_prb INTEGER DEFAULT 0,
        urutan_iterasi INTEGER DEFAULT 0,
        jenis_klaim TEXT DEFAULT 'RAWAT_INAP',
        
        validation_status TEXT DEFAULT 'pending' CHECK(validation_status IN ('valid','error','pending')),
        error_count INTEGER DEFAULT 0,
        ai_status TEXT DEFAULT 'pending' CHECK(ai_status IN ('valid','dispute','warning','pending')),
        ai_notes TEXT,
        ai_suggestions TEXT,
        raw_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS validation_rules (
        id TEXT PRIMARY KEY,
        rule_code TEXT UNIQUE NOT NULL,
        rule_name TEXT NOT NULL,
        description TEXT,
        field_name TEXT,
        priority INTEGER DEFAULT 2,
        is_active INTEGER DEFAULT 1,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS validation_errors (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES claim_records(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL REFERENCES validation_rules(id),
        field_name TEXT,
        error_message TEXT,
        expected_value TEXT,
        actual_value TEXT,
        severity TEXT DEFAULT 'major' CHECK(severity IN ('critical','major','minor')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        user_email TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Mirror dari migrations/002-ai-audit-log.sql (auto-init untuk deployment tanpa migration runner)
      CREATE TABLE IF NOT EXISTS ai_audit_log (
        id TEXT PRIMARY KEY,
        file_id TEXT REFERENCES claim_files(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL REFERENCES claim_records(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        ai_suggestion TEXT,
        confidence DOUBLE PRECISION,
        reasoning TEXT,
        style TEXT NOT NULL DEFAULT 'ponytail' CHECK (style IN ('ponytail','caveman','neutral')),
        nurse_action TEXT CHECK (nurse_action IN ('accepted','rejected','unsure')),
        was_correct BOOLEAN,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create Indexes
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_files_hospital_period ON claim_files(hospital_code, period)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_files_status ON claim_files(status)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_records_file_id ON claim_records(file_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_records_validation_status ON claim_records(validation_status)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_records_sep ON claim_records(sep)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_validation_errors_record_id ON validation_errors(record_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_validation_errors_rule_id ON validation_errors(rule_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_ai_audit_record ON ai_audit_log(record_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_ai_audit_file ON ai_audit_log(file_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_ai_audit_style_action ON ai_audit_log(style, nurse_action)`);

    await migrateSchema(dbHelper);
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
  }
}

async function migrateSchema(db) {
  try {
    const res = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'claim_records'
    `);
    
    if (res.rows.length === 0) return;
    
    const existingCols = res.rows.map(c => c.column_name.toLowerCase());
    
    const newCols = {
      'mrn': 'TEXT',
      'umur_hari': 'INTEGER DEFAULT 0',
      'kelas_rs': 'TEXT',
      'los': 'INTEGER DEFAULT 0',
      'inacbg_code': 'TEXT',
      'deskripsi_inacbg': 'TEXT',
      'tarif_inacbg': 'DOUBLE PRECISION DEFAULT 0',
      'tarif_poli_eks': 'DOUBLE PRECISION DEFAULT 0',
      'icu_indikator': 'INTEGER DEFAULT 0',
      'icu_los': 'INTEGER DEFAULT 0',
      'vent_hour': 'INTEGER DEFAULT 0',
      'birth_weight': 'INTEGER DEFAULT 0',
      'payor_id': 'TEXT',
      'coder_id': 'TEXT',
      'jenis_konsultasi': 'TEXT',
      'jumlah_episode_klaim': 'INTEGER DEFAULT 1',
      'is_same_day': 'INTEGER DEFAULT 0',
      'histori_obat_kronis_bulan_berturut': 'INTEGER DEFAULT 0',
      'status_pasien': 'TEXT DEFAULT \'STABIL\'',
      'flag_rujuk_balik_prb': 'INTEGER DEFAULT 0',
      'urutan_iterasi': 'INTEGER DEFAULT 0',
      'jenis_klaim': 'TEXT DEFAULT \'RAWAT_INAP\'',
      'ai_status': 'TEXT DEFAULT \'pending\'',
      'ai_notes': 'TEXT',
      'ai_suggestions': 'TEXT'
    };

    for (const [col, type] of Object.entries(newCols)) {
      if (!existingCols.includes(col.toLowerCase())) {
        try {
          await db.query(`ALTER TABLE claim_records ADD COLUMN ${col} ${type}`);
        } catch (e) {
          // Column may already exist
        }
      }
    }

    // Migrate claim_files table
    const fileRes = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'claim_files'
    `);
    
    if (fileRes.rows.length > 0) {
      const fileCols = fileRes.rows.map(c => c.column_name.toLowerCase());
      if (!fileCols.includes('column_count')) {
        try {
          await db.query(`ALTER TABLE claim_files ADD COLUMN column_count INTEGER DEFAULT 0`);
        } catch (e) {}
      }
      if (!fileCols.includes('ai_prompt_tokens')) {
        try {
          await db.query(`ALTER TABLE claim_files ADD COLUMN ai_prompt_tokens INTEGER DEFAULT 0`);
        } catch (e) {}
      }
      if (!fileCols.includes('ai_completion_tokens')) {
        try {
          await db.query(`ALTER TABLE claim_files ADD COLUMN ai_completion_tokens INTEGER DEFAULT 0`);
        } catch (e) {}
      }
      if (!fileCols.includes('ai_total_tokens')) {
        try {
          await db.query(`ALTER TABLE claim_files ADD COLUMN ai_total_tokens INTEGER DEFAULT 0`);
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('Failed to run schema migration:', err);
  }
}

function closeDb() {
  if (pool) {
    pool.end();
    pool = null;
  }
}

module.exports = { getDb, closeDb };