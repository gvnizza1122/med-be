const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { getDb, closeDb } = require('./init');

async function seed() {
  const db = getDb();
  await db.initialize();

  console.log('Seeding database...');

  // Add username column if not exists
  try {
    await db.prepare('ALTER TABLE users ADD COLUMN username TEXT UNIQUE').run();
  } catch (e) { /* already exists */ }

  // Admin
  const admin = await db.prepare("SELECT id FROM users WHERE email = 'admin@rslestari.id'").get();
  if (!admin) {
    await db.prepare('INSERT INTO users (id, email, username, password_hash, full_name, nik, role, hospital_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), 'admin@rslestari.id', 'admin', bcrypt.hashSync('admin123', 10), 'Administrator', '3371080000000001', 'admin', '3371084'
    );
    console.log('  Admin: admin / admin123');
  } else {
    await db.prepare("UPDATE users SET username = 'admin' WHERE email = 'admin@rslestari.id' AND username IS NULL").run();
  }

  // Supervisor
  const sup = await db.prepare("SELECT id FROM users WHERE email = 'supervisor@rslestari.id'").get();
  if (!sup) {
    await db.prepare('INSERT INTO users (id, email, username, password_hash, full_name, nik, role, hospital_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), 'supervisor@rslestari.id', 'supervisor', bcrypt.hashSync('super123', 10), 'Supervisor Klaim', '3371080000000002', 'supervisor', '3371084'
    );
    console.log('  Supervisor: supervisor / super123');
  } else {
    await db.prepare("UPDATE users SET username = 'supervisor' WHERE email = 'supervisor@rslestari.id' AND username IS NULL").run();
  }

  // Verifikator
  const ver = await db.prepare("SELECT id FROM users WHERE email = 'verifikator@rslestari.id'").get();
  if (!ver) {
    await db.prepare('INSERT INTO users (id, email, username, password_hash, full_name, nik, role, hospital_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      uuidv4(), 'verifikator@rslestari.id', 'verifikator', bcrypt.hashSync('verif123', 10), 'Verifikator Klaim', '3371080000000003', 'verifikator', '3371084'
    );
    console.log('  Verifikator: verifikator / verif123');
  } else {
    await db.prepare("UPDATE users SET username = 'verifikator' WHERE email = 'verifikator@rslestari.id' AND username IS NULL").run();
  }

  // Rules
  const rules = [
    { id: 'RV-01', rule_code: 'format_sep', rule_name: 'Format SEP', description: 'SEP harus uppercase semua.', field_name: 'sep', priority: 1, error_message: 'SEP mengandung huruf kecil. Harus uppercase semua.' },
    { id: 'RV-02', rule_code: 'format_nokartu', rule_name: 'Format NOKARTU', description: 'Nomor kartu BPJS harus 13 digit angka.', field_name: 'nokartu', priority: 1, error_message: 'NOKARTU harus 13 digit angka.' },
    { id: 'RV-03', rule_code: 'date_admission_discharge', rule_name: 'Tanggal Masuk vs Keluar', description: 'Tanggal masuk harus <= tanggal keluar.', field_name: 'admission_date', priority: 1, error_message: 'Tanggal masuk harus sebelum atau sama dengan tanggal keluar.' },
    { id: 'RV-04', rule_code: 'crosscheck_umur', rule_name: 'Cross-check Umur', description: 'Umur harus sesuai kalkulasi dari tanggal lahir.', field_name: 'umur_tahun', priority: 2, error_message: 'Umur tidak sesuai dengan tanggal lahir.' },
    { id: 'RV-05', rule_code: 'icd10_valid', rule_name: 'Kode ICD-10 Valid', description: 'Diagnosa harus berisi kode ICD-10 valid.', field_name: 'diagnosa_list', priority: 2, error_message: 'Kode diagnosa ICD-10 tidak valid.' },
    { id: 'RV-06', rule_code: 'icd9cm_valid', rule_name: 'Kode Prosedur ICD-9-CM Valid', description: 'Prosedur harus berisi kode ICD-9-CM valid.', field_name: 'prosedur_list', priority: 2, error_message: 'Kode prosedur ICD-9-CM tidak valid.' },
    { id: 'RV-07', rule_code: 'kelas_rawat_valid', rule_name: 'Kelas Rawat Valid', description: 'Kelas rawat harus 1, 2, atau 3.', field_name: 'kelas_rawat', priority: 2, error_message: 'Kelas rawat hanya boleh 1, 2, atau 3.' },
    { id: 'RV-08', rule_code: 'discharge_status_valid', rule_name: 'Discharge Status Valid', description: 'Status keluar harus 1-5.', field_name: 'discharge_status', priority: 2, error_message: 'Status keluar hanya boleh 1-5.' },
    { id: 'RV-09', rule_code: 'nama_pasien_required', rule_name: 'Nama Pasien Wajib', description: 'Nama pasien tidak boleh kosong.', field_name: 'nama_pasien', priority: 1, error_message: 'Nama pasien wajib diisi.' },
    { id: 'RV-10', rule_code: 'selisih_tarif', rule_name: 'Selisih Tarif Wajar', description: 'Selisih tarif RS vs INACBG < 50%.', field_name: 'tarif_rs', priority: 3, error_message: 'Selisih tarif RS vs INACBG > 50%.' },
    { id: 'RV-11', rule_code: 'rehab_medik_dokumen', rule_name: 'Berkas Rehabilitasi Medik', description: 'Tindakan Rehab Medik (93...) wajib dokumen.', field_name: 'prosedur_list', priority: 2, error_message: 'Tindakan Rehab Medik terdeteksi. Pastikan dokumen lengkap.' },
    { id: 'RV-12', rule_code: 'eksisi_tumor_dokumen', rule_name: 'Berkas Eksisi Tumor & PA', description: 'Diagnosis tumor dengan eksisi wajib laporan PA.', field_name: 'diagnosa_list', priority: 2, error_message: 'Diagnosis tumor dengan tindakan eksisi. Laporan PA wajib.' },
    { id: 'RV-13', rule_code: 'gabung_episode_konsul_internal', rule_name: 'Gabung Episode Konsul Internal', description: 'Konsul internal antar-poli digabung 1 episode.', field_name: 'jumlah_episode_klaim', priority: 2, error_message: 'Konsul internal harus digabung 1 episode.' },
    { id: 'RV-14', rule_code: 'validasi_rujukan_internal', rule_name: 'Validasi Episode Rujukan Internal', description: 'Rujukan internal antar-poli divalidasi episodenya.', field_name: 'jumlah_episode_klaim', priority: 2, error_message: 'Rujukan internal terpisah episode, verifikasi.' },
    { id: 'RV-15', rule_code: 'flagging_rujuk_balik_prb', rule_name: 'Flagging Rujuk Balik (PRB)', description: 'Penyakit kronis stabil 3 bulan wajib PRB.', field_name: 'diagnosa_list', priority: 2, error_message: 'Pasien kronis stabil >3 bulan wajib PRB.' },
    { id: 'RV-16', rule_code: 'batas_max_iterasi_obat', rule_name: 'Batasan Maksimal Iterasi Obat', description: 'Iterasi obat kronis maksimal 2 kali.', field_name: 'urutan_iterasi', priority: 2, error_message: 'Iterasi obat melebihi batas maksimal 2 kali.' },
    { id: 'RV-17', rule_code: 'odontektomi_rawat_jalan', rule_name: 'Odontektomi Khusus Rawat Jalan', description: 'Odontektomi hanya untuk rawat jalan.', field_name: 'prosedur_list', priority: 2, error_message: 'Odontektomi hanya berlaku untuk rawat jalan.' },
  ];

  for (const rule of rules) {
    await db.prepare(`
      INSERT INTO validation_rules (id, rule_code, rule_name, description, field_name, priority, is_active, error_message)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (id) DO UPDATE SET rule_name = excluded.rule_name, description = excluded.description, error_message = excluded.error_message
    `).run(rule.id, rule.rule_code, rule.rule_name, rule.description, rule.field_name, rule.priority, rule.error_message);
  }
  console.log('  17 validation rules seeded');

  closeDb();
  console.log('Seeding complete!');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  closeDb();
  process.exit(1);
});
