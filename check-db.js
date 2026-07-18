const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'eclaim',
});

async function check() {
  const cf = await pool.query('SELECT * FROM claim_files ORDER BY created_at DESC LIMIT 1');
  const fileId = cf.rows[0].id;
  
  const res = await pool.query(`
    SELECT ve.error_message, ve.actual_value
    FROM validation_errors ve
    JOIN claim_records cr ON ve.record_id = cr.id
    WHERE cr.file_id = $1 AND ve.rule_id = 'RV-01'
    LIMIT 5
  `, [fileId]);
  
  console.log("RV-01 Errors:", res.rows);
  pool.end();
}
check();
