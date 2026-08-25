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
    // max (naik dari default pg = 10 ke 30): upload batch memproses file secara
    // paralel (BATCH_AI_CONCURRENCY di routes/claimFiles.js) dan tiap file
    // membuka koneksi DB — kalau pool lebih kecil dari concurrency, file-file
    // paralel saling antre koneksi & throughput dibatasi pool, bukan AI.
    // Nilai aman untuk Postgres default (max_connections=100).
    max: parseInt(process.env.DB_POOL_MAX || '30', 10),
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
        jenis_klaim TEXT,
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
        klinik_poli TEXT,

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
        ai_review TEXT,
        raw_data TEXT,
        has_bpjs_page BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Satu baris = satu file Excel rekap pending BPJS yang diimpor (mis.
      -- "PENDING PELKES JUNI 2026.xlsx") — dipakai supaya halaman Pending BPJS
      -- bisa tampil per-file dulu (seperti Riwayat Upload), baru masuk ke isi
      -- filenya setelah diklik. Lihat routes/bpjsPending.js.
      CREATE TABLE IF NOT EXISTS bpjs_pending_files (
        id TEXT PRIMARY KEY,
        file_name TEXT,
        total_rows INTEGER DEFAULT 0,
        imported_rows INTEGER DEFAULT 0,
        skipped_duplicate INTEGER DEFAULT 0,
        matched_claim INTEGER DEFAULT 0,
        uploaded_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Jawaban Pending BPJS + draft klarifikasi AI (lihat routes/bpjsPending.js).
      CREATE TABLE IF NOT EXISTS bpjs_pending_responses (
        id TEXT PRIMARY KEY,
        pending_file_id TEXT,
        claim_record_id TEXT,
        sep TEXT,
        mrn TEXT,
        tanggal_pending TEXT,
        alasan_raw TEXT,
        alasan_parsed TEXT,
        draft_klarifikasi TEXT,
        status TEXT DEFAULT 'draft',
        outcome TEXT,
        -- Kolom tambahan untuk rekap pending BPJS berformat XLSX (bukan
        -- surat PDF per-klaim) — lihat routes/bpjsPending.js parsePendingSheet().
        source TEXT DEFAULT 'pdf_upload',   -- 'pdf_upload' | 'xlsx_import'
        jenis_klaim TEXT,                    -- 'RJ' | 'RI', dari nama sheet
        nama_peserta TEXT,
        nokartu TEXT,
        kdinacbg TEXT,
        by_pengajuan NUMERIC,
        tgl_pulang TEXT,
        jawaban_rs_manual TEXT,              -- kolom "JAWABAN RS" apa adanya dari file RS, kalau sudah diisi
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- "Memori" AI (RAG, bukan fine-tuning) — pasangan alasan pending + draft
      -- yang berhasil diterima BPJS, diambil sebagai few-shot example saat
      -- generate draft baru untuk kategori serupa.
      CREATE TABLE IF NOT EXISTS ai_training_examples (
        id TEXT PRIMARY KEY,
        kategori_pending TEXT,
        alasan_bpjs TEXT,
        draft_berhasil TEXT,
        poin_kunci TEXT,
        outcome TEXT,
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

      CREATE TABLE IF NOT EXISTS ocr_results (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES claim_records(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        ocr_text TEXT,
        confidence DOUBLE PRECISION,
        block_count INTEGER DEFAULT 0,
        processing_duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(record_id, page_number)
      );

      -- Profil RS per hospital_code — saat ini cuma kelas_rs (kelas akreditasi
      -- RS, mis. A/B/C/D). KODE_RS TIDAK disimpan di sini karena sudah ada di
      -- users.hospital_code/claim_files.hospital_code (dipakai sejak awal untuk
      -- pemisahan data antar RS) — field itu memang identik dengan KODE_RS vClaim.
      -- kelas_rs tidak pernah tercetak di SEP/Resume Medis pasien, jadi diisi
      -- sekali oleh admin di sini lalu dipakai otomatis untuk semua klaim RS itu.
      CREATE TABLE IF NOT EXISTS hospital_settings (
        hospital_code TEXT PRIMARY KEY,
        kelas_rs TEXT,
        updated_by TEXT REFERENCES users(id),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Daftar pasien kronis yang SENGAJA tidak dialihkan ke Program Rujuk
      -- Balik (PRB) walau sudah stabil ≥3 bulan berturut (mis. komplikasi
      -- berat, komorbid) — dikelola manual oleh admin di halaman Exempt PRB.
      -- Dicek oleh detectAndFlagPRB() di claimFiles.js sebelum RV-15 menyala.
      CREATE TABLE IF NOT EXISTS prb_exemption_list (
        id TEXT PRIMARY KEY,
        hospital_code TEXT NOT NULL,
        mrn TEXT NOT NULL,
        nokartu TEXT,
        nama_pasien TEXT,
        alasan_exempt TEXT NOT NULL,
        dpjp TEXT,
        tanggal_exempt DATE,
        berlaku_sampai DATE,
        diinput_oleh TEXT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Audit trail konfirmasi manual RV-20 (kriteria kegawatan IGD) —
      -- verifikator wajib centang checklist sebelum lanjut kalau RV-20
      -- (WARNING, tidak blocking) terdeteksi. Disimpan permanen untuk bukti
      -- kalau BPJS mempertanyakan klaim ini nanti.
      CREATE TABLE IF NOT EXISTS rv20_confirmations (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES claim_records(id) ON DELETE CASCADE,
        sep TEXT,
        mrn TEXT,
        checklist_items TEXT,
        confirmed_by TEXT REFERENCES users(id),
        confirmed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Mirror dari migrations/003-error-knowledge-base.sql (auto-init untuk deployment tanpa migration runner)
      CREATE TABLE IF NOT EXISTS error_knowledge_base (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES validation_rules(id) ON DELETE CASCADE,
        field_name TEXT,
        pattern_summary TEXT NOT NULL,
        solution TEXT NOT NULL,
        hit_count INTEGER DEFAULT 1,
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
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_ocr_results_record_id ON ocr_results(record_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_ocr_results_page ON ocr_results(record_id, page_number)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_error_kb_rule ON error_knowledge_base(rule_id)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_error_kb_rule_hits ON error_knowledge_base(rule_id, hit_count DESC, created_at DESC)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_prb_exemption_mrn ON prb_exemption_list(hospital_code, mrn)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_records_nokartu ON claim_records(nokartu)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_rv20_confirmations_record ON rv20_confirmations(record_id)`);

    // Item 10 (optimasi performa) — kolom-kolom berikut dipakai search/filter
    // di fitur search Riwayat Upload (item 8) dan Pending BPJS (item 9), belum
    // punya index sebelumnya, jadi jadi full-scan begitu datanya banyak.
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_claim_records_nama_pasien ON claim_records(nama_pasien)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_bpjs_pending_file_status ON bpjs_pending_responses(pending_file_id, status)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_bpjs_pending_sep ON bpjs_pending_responses(sep)`);
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_bpjs_pending_nama_peserta ON bpjs_pending_responses(nama_peserta)`);

    // Explicit index pada users.email untuk mempercepat login queries
    await dbHelper.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

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
      'ai_suggestions': 'TEXT',
      // Hasil AI review tahap kedua (alur AI ekstraksi -> rule engine -> AI
      // review) — JSON string {field_notes, code_evidence, suggested_codes,
      // generated_at}. Diisi otomatis saat upload/validasi, dibaca langsung
      // oleh tabel hasil validasi tanpa perlu AI call lagi saat halaman dibuka.
      'ai_review': 'TEXT',
      // Nama klinik/poli dari SEP (mis. "INSTALASI GAWAT DARURAT", "POLI
      // PENYAKIT DALAM") — dipakai cross-check RV-13/14 (episode konsul/
      // rujukan internal): kalau ada >1 record NOKARTU sama + tanggal sama
      // dengan klinik BEDA, itu indikasi kunjungan lintas-poli hari yang
      // sama yang seharusnya digabung 1 episode klaim. Lihat
      // detectInternalEpisodes() di claimFiles.js.
      'klinik_poli': 'TEXT',
      'prb_exempt_reason': 'TEXT',
      // Penanda dokumen ini punya halaman SEP/BPJS asli (bukan cuma dokumen
      // klinis non-BPJS) — dipakai RV-01/RV-02 buat bedakan "AI gagal ekstrak
      // NOKARTU dari dokumen BPJS asli" (tetap critical) vs "dokumennya
      // memang bukan klaim BPJS" (bukan error). Default TRUE supaya record
      // lama (sebelum kolom ini ada) tetap divalidasi ketat seperti biasa.
      'has_bpjs_page': 'BOOLEAN DEFAULT TRUE'
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
      // Kategori pelayanan (RAWAT_JALAN/RAWAT_INAP/GAWAT_DARURAT) dipilih user
      // saat upload PDF di halaman Extract - dipakai sebagai konteks AI review
      // (supaya tidak salah saran, mis. saran ruangan rawat inap untuk klaim
      // rawat jalan) dan untuk filter/tampilan di Riwayat Upload.
      if (!fileCols.includes('jenis_klaim')) {
        try {
          await db.query(`ALTER TABLE claim_files ADD COLUMN jenis_klaim TEXT`);
        } catch (e) {}
      }
    }

    // Migrate bpjs_pending_responses table (kolom tambahan untuk import XLSX)
    const pendingRes = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'bpjs_pending_responses'
    `);
    if (pendingRes.rows.length > 0) {
      const pendingCols = pendingRes.rows.map(c => c.column_name.toLowerCase());
      const pendingNewCols = {
        source: `TEXT DEFAULT 'pdf_upload'`,
        jenis_klaim: 'TEXT',
        nama_peserta: 'TEXT',
        nokartu: 'TEXT',
        kdinacbg: 'TEXT',
        by_pengajuan: 'NUMERIC',
        tgl_pulang: 'TEXT',
        jawaban_rs_manual: 'TEXT',
        pending_file_id: 'TEXT',
      };
      for (const [col, type] of Object.entries(pendingNewCols)) {
        if (!pendingCols.includes(col)) {
          try {
            await db.query(`ALTER TABLE bpjs_pending_responses ADD COLUMN ${col} ${type}`);
          } catch (e) {}
        }
      }

      // Backfill: baris hasil import XLSX yang dibuat SEBELUM tabel
      // bpjs_pending_files ada (pending_file_id masih NULL) jadi tidak
      // kelihatan sama sekali di UI per-file yang baru — kelompokkan jadi
      // satu "file" sintetis supaya tidak hilang dari tampilan.
      try {
        const orphans = await db.query(`
          SELECT COUNT(*) as count FROM bpjs_pending_responses
          WHERE source = 'xlsx_import' AND pending_file_id IS NULL
        `);
        const orphanCount = Number(orphans.rows?.[0]?.count || 0);
        if (orphanCount > 0) {
          const { v4: uuidv4 } = require('uuid');
          const backfillId = uuidv4();
          const matched = await db.query(`
            SELECT COUNT(*) as count FROM bpjs_pending_responses
            WHERE source = 'xlsx_import' AND pending_file_id IS NULL AND claim_record_id IS NOT NULL
          `);
          await db.query(`
            INSERT INTO bpjs_pending_files (id, file_name, total_rows, imported_rows, skipped_duplicate, matched_claim, created_at)
            VALUES (?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
          `, [backfillId, 'Rekap Pending BPJS (data sebelum fitur daftar per-file)', orphanCount, orphanCount, Number(matched.rows?.[0]?.count || 0)]);
          await db.query(`
            UPDATE bpjs_pending_responses SET pending_file_id = ?
            WHERE source = 'xlsx_import' AND pending_file_id IS NULL
          `, [backfillId]);
          console.log(`[migration] Backfilled ${orphanCount} baris pending BPJS lama ke file "${backfillId}"`);
        }
      } catch (e) {
        console.error('[migration] Gagal backfill pending_file_id:', e.message);
      }
    }

    // RV-20 (Kriteria Kegawatan IGD) ditambahkan ke seed.js belakangan, TAPI
    // seed.js cuma jalan sekali saat database masih kosong — deployment yang
    // sudah lama jalan (validation_rules sudah terisi RV-01..RV-17 dari seed
    // lama) tidak pernah dapat baris RV-20 ini, jadi ruleEngine.js selalu skip
    // RV-20 (`ruleMap['RV-20']?.is_active` selalu undefined/false) walau kode
    // rule-nya sendiri sudah lengkap — checklist konfirmasi, Surat Klarifikasi,
    // dst semuanya sudah dibangun tapi rule intinya tidak pernah benar-benar
    // aktif. INSERT idempoten ini menutup celah itu untuk deployment lama.
    try {
      await db.query(`
        INSERT INTO validation_rules (id, rule_code, rule_name, description, field_name, priority, error_message)
        VALUES (
          'RV-20', 'kegawatan_igd_kode', 'Kriteria Kegawatan IGD',
          'Diagnosis IGD hanya kode nyeri generik tanpa kode kegawatan pendamping — BPJS sering menolak dengan alasan "tidak memenuhi kriteria gawat darurat".',
          'diagnosa_list', 3,
          'Diagnosis IGD ini hanya kode nyeri generik tanpa bukti kegawatan objektif. Pastikan TTV abnormal/pemeriksaan penunjang terdokumentasi sebelum submit.'
        )
        ON CONFLICT (id) DO NOTHING
      `);
    } catch (e) {
      console.error('[migration] Gagal memastikan rule RV-20 ada:', e.message);
    }

    // One-time backfill: baris Pending BPJS yang tadinya "belum ditemukan"
    // (diimpor sebelum klaim PDF yang cocok sempat diupload) tapi klaimnya
    // SEKARANG sudah ada di claim_records — link sekarang juga, jangan
    // tunggu sampai file itu diupload ulang. Sinkronisasi rutin untuk upload
    // baru ke depannya ada di services/bpjsPendingLink.js.
    try {
      const linked = await db.query(`
        UPDATE bpjs_pending_responses bpr
        SET claim_record_id = cr.id
        FROM claim_records cr
        WHERE bpr.claim_record_id IS NULL AND bpr.sep = cr.sep
      `);
      if (linked.rowCount > 0) {
        console.log(`[migration] Menautkan ${linked.rowCount} baris pending BPJS ke klaim yang sudah ada.`);
      }
    } catch (e) {
      console.error('[migration] Gagal backfill claim_record_id pending BPJS:', e.message);
    }

    // Kolom baru untuk pipeline training RAG (Kimi K3) — generated_by
    // membedakan asal contoh ('kimi-k3-backfill' dari arsip lama vs
    // 'kimi-k3-auto' dari draft yang baru dibuat, vs NULL untuk entri lama
    // yang masih pakai alur approve manual), confidence_score dipakai
    // getRelevantBpjsExamples() untuk memprioritaskan contoh yang paling
    // meyakinkan sejak filter outcome='approved' dilepas.
    try {
      const trainingRes = await db.query(`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_training_examples'
      `);
      if (trainingRes.rows.length > 0) {
        const trainingCols = trainingRes.rows.map(c => c.column_name.toLowerCase());
        const trainingNewCols = { generated_by: 'TEXT', confidence_score: 'NUMERIC' };
        for (const [col, type] of Object.entries(trainingNewCols)) {
          if (!trainingCols.includes(col)) {
            try {
              await db.query(`ALTER TABLE ai_training_examples ADD COLUMN ${col} ${type}`);
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      console.error('[migration] Gagal tambah kolom generated_by/confidence_score:', e.message);
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