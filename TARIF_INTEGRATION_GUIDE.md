# PMK 3/2023 Tarif Integration Guide

## Overview

Integrasi tabel tarif resmi INA-CBG dari Peraturan Menteri Kesehatan (PMK) Nomor 3 Tahun 2023 ke dalam sistem eClaim. Tarif ini digunakan untuk:

1. **Validasi klaim** - RV-21 rule memvalidasi `TARIF_INACBG` klaim terhadap tarif resmi
2. **Lookup referensi** - API endpoint untuk mencari tarif berdasarkan kode INA-CBG
3. **Verifikasi batch** - Verifikasi batch records terhadap tabel resmi

## Data Source

- **Sumber**: PMK No. 3 Tahun 2023 tentang Standar Tarif Pelayanan Kesehatan Program Jaminan Kesehatan
- **Halaman**: 190-203 (Rawat Inap: 190-199, Rawat Jalan: 200-203)
- **Total baris**: 1,075 
  - Rawat Inap (RI): 786 kode
  - Rawat Jalan (RJ): 289 kode
- **Cakupan**: Regional 1 × Kelas D Swasta (RS Lestari Raharja, Kode Provider 0170)
- **File data**: `src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json`

## Database Structure

### Table: `tarif_inacbg_pmk3_2023`

```sql
CREATE TABLE tarif_inacbg_pmk3_2023 (
  kode_inacbg TEXT PRIMARY KEY,
  deskripsi TEXT,
  tarif_kelas_3 BIGINT,        -- Tarif Kelas 3 (Rawat Inap) / Tunggal (Rawat Jalan)
  tarif_kelas_2 BIGINT,        -- Tarif Kelas 2 (Rawat Inap saja)
  tarif_kelas_1 BIGINT,        -- Tarif Kelas 1 (Rawat Inap saja)
  regional TEXT NOT NULL,      -- Regional ID (e.g., '1')
  tipe_rs TEXT NOT NULL,       -- Tipe RS (e.g., 'D_SWASTA')
  jenis_layanan TEXT,          -- 'RAWAT_INAP' atau 'RAWAT_JALAN'
  sumber_halaman INTEGER,      -- Halaman sumber dokumen PMK
  perlu_verifikasi_manual BOOLEAN,  -- Flag untuk data yang perlu review manual
  catatan_verifikasi TEXT,     -- Catatan verifikasi (jika ada)
  imported_at TIMESTAMP        -- Timestamp saat data di-import
);
```

### Kolom Khusus

- **`tarif_kelas_1/2/3`**: Bernilai `NULL` (bukan 0) jika tidak berlaku/tidak dijamin untuk kombinasi regional/kelas RS ini (ditandai strip "-" di dokumen sumber)
- **`tarif_kelas_2/3` untuk RAWAT_JALAN**: Bernilai `NULL` karena tarif RJ tidak dibedakan per kelas (hanya ada tarif tunggal di `tarif_kelas_3`)
- **`perlu_verifikasi_manual`**: Flag jika ekstraksi data perlu verifikasi manual (0 dari 1,075 baris pada initial seed)

## Seeding Data

### Step 1: Pastikan Database Running

```bash
# Jika menggunakan Docker
docker-compose up -d db

# Atau jika database sudah running via Docker/Kubernetes
# Pastikan host/port dari DB_HOST sesuai .env
```

### Step 2: Run Seed Script

```bash
cd ~/eclaim/be
node scripts/seedTarifInacbg.js
```

Script ini akan:
1. Membaca JSON data dari `src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json`
2. Insert/upsert 1,075 baris ke tabel `tarif_inacbg_pmk3_2023` (idempoten)
3. Melakukan cross-check K-4-17-I = Rp1.264.200 (Kelas 3) untuk verifikasi integritas

### Expected Output

```
Memuat 1075 baris tarif dari .../src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json
Sumber: Peraturan Menteri Kesehatan (PMK) Nomor 3 Tahun 2023 tentang Standar Tarif Pelayanan Kesehatan Program Jaminan Kesehatan
Cakupan: Regional 1 x Rumah Sakit Kelas D Swasta, halaman 190-203 (Rawat Inap: hlm 190-199, Rawat Jalan: hlm 200-203)
  ... 500/1075
  ... 1000/1075

Selesai. Baris diproses: 1075, dilewati (kode kosong): 0.
Total baris di tabel tarif_inacbg_pmk3_2023 sekarang: 1075
Cross-check K-4-17-I: OK (Rp1.264.200 Kelas 3, cocok dengan nilai terverifikasi).
```

## API Endpoints

Semua endpoint memerlukan JWT token di header `Authorization: Bearer <token>`.

### 1. Lookup Tarif

```http
GET /api/v1/tarif/lookup/{kodeInacbg}?kelasRawat=3
```

**Path params:**
- `kodeInacbg`: Kode INA-CBG (e.g., "K-4-17-I")

**Query params:**
- `kelasRawat`: 1, 2, atau 3 (opsional, default: 3)

**Response (200):**
```json
{
  "found": true,
  "kodeInacbg": "K-4-17-I",
  "deskripsi": "NYERI ABDOMEN & GASTROENTERITIS LAIN-LAIN (RINGAN)",
  "jenis_layanan": "RAWAT_INAP",
  "kelasRawat": 3,
  "tarif": 1264200,
  "tarif_kelas_1": 1681400,
  "tarif_kelas_2": 1472800,
  "tarif_kelas_3": 1264200,
  "sumber": {
    "regional": "1",
    "tipe_rs": "D_SWASTA",
    "tipe_rs_label": "Rumah Sakit Kelas D Swasta",
    "sumber_halaman": 195,
    "sumber_dokumen": "PMK No. 3 Tahun 2023 tentang Standar Tarif Pelayanan Kesehatan Program Jaminan Kesehatan"
  }
}
```

**Response (404):**
```json
{
  "found": false,
  "kodeInacbg": "X-99-99-X",
  "error": "Kode INA-CBG \"X-99-99-X\" tidak ditemukan dalam tabel PMK 3/2023 Regional 1 Kelas D Swasta."
}
```

### 2. Verifikasi Tarif Klaim

```http
POST /api/v1/tarif/verify
Content-Type: application/json

{
  "kodeInacbg": "K-4-17-I",
  "kelasRawat": 3,
  "tarifKlaim": 1264200,
  "jenisLayanan": "RAWAT_INAP"
}
```

**Request body:**
- `kodeInacbg` (required): Kode INA-CBG dari klaim
- `kelasRawat` (required): Kelas rawat (1/2/3)
- `tarifKlaim` (required): Tarif yang ada di klaim
- `jenisLayanan` (optional): "RAWAT_INAP" atau "RAWAT_JALAN" (untuk logging)

**Response (200) - MATCH:**
```json
{
  "valid": true,
  "status": "MATCH",
  "tarifResmi": 1264200,
  "tarifKlaim": 1264200,
  "selisih": 0,
  "persentaseSelisih": 0,
  "detail": {
    "kode_inacbg": "K-4-17-I",
    "deskripsi": "NYERI ABDOMEN & GASTROENTERITIS LAIN-LAIN (RINGAN)",
    "tarif_kelas_3": 1264200,
    "tarif_kelas_2": 1472800,
    "tarif_kelas_1": 1681400,
    "regional": "1",
    "tipe_rs": "D_SWASTA",
    "jenis_layanan": "RAWAT_INAP",
    "sumber_halaman": 195
  }
}
```

**Response (200) - DISCREPANCY:**
```json
{
  "valid": false,
  "status": "DISCREPANCY",
  "tarifResmi": 1264200,
  "tarifKlaim": 1500000,
  "selisih": 235800,
  "persentaseSelisih": 18.66,
  "detail": { ... }
}
```

**Response (200) - NOT FOUND:**
```json
{
  "valid": true,
  "status": "KODE_TIDAK_DITEMUKAN",
  "tarifResmi": null,
  "tarifKlaim": 1000000,
  "selisih": 0
}
```

### 3. Statistik Tabel Tarif

```http
GET /api/v1/tarif/stats
```

**Response (200):**
```json
{
  "status": "complete",
  "meta": {
    "source_name": "Peraturan Menteri Kesehatan (PMK) Nomor 3 Tahun 2023 tentang Standar Tarif Pelayanan Kesehatan Program Jaminan Kesehatan",
    "source_pages": "190-203 (Rawat Inap: hlm 190-199, Rawat Jalan: hlm 200-203)",
    "regional": "1",
    "tipe_rs": "Rumah Sakit Kelas D Swasta"
  },
  "total_rows": 1075,
  "rawat_inap_count": 786,
  "rawat_jalan_count": 289,
  "last_imported": "2024-09-18T17:05:00.000Z",
  "verification": {
    "status": "ok",
    "cross_check_k_4_17_i": "Rp1.264.200 (Kelas 3) - terverifikasi dari klaim riil"
  }
}
```

**Response (503) - Tabel belum di-seed:**
```json
{
  "status": "empty",
  "message": "Tabel tarif_inacbg_pmk3_2023 belum di-seed. Jalankan: cd ~/eclaim/be && node scripts/seedTarifInacbg.js",
  "total_rows": 0,
  "rawat_inap_count": 0,
  "rawat_jalan_count": 0,
  "last_imported": null
}
```

### 4. Cari Tarif (Search)

```http
GET /api/v1/tarif/search?q=nyeri&jenisLayanan=RAWAT_INAP&limit=20
```

**Query params:**
- `q` (optional): Cari di kode_inacbg atau deskripsi (minimal 2 karakter)
- `jenisLayanan` (optional): "RAWAT_INAP" atau "RAWAT_JALAN"
- `limit` (optional): Maksimal 100, default 20

**Response (200):**
```json
{
  "query": {
    "q": "nyeri",
    "jenisLayanan": "RAWAT_INAP",
    "limit": "20"
  },
  "count": 5,
  "results": [
    {
      "kode_inacbg": "K-4-17-I",
      "deskripsi": "NYERI ABDOMEN & GASTROENTERITIS LAIN-LAIN (RINGAN)",
      "tarif_kelas_3": 1264200,
      "tarif_kelas_2": 1472800,
      "tarif_kelas_1": 1681400,
      "regional": "1",
      "tipe_rs": "D_SWASTA",
      "jenis_layanan": "RAWAT_INAP",
      "sumber_halaman": 195
    },
    ...
  ]
}
```

### 5. Cross-Check K-4-17-I

```http
GET /api/v1/tarif/cross-check
```

Endpoint khusus untuk verifikasi integritas data dengan cross-check K-4-17-I dari klaim riil ELVINA SAIDAH.

**Response (200) - PASS:**
```json
{
  "status": "PASS",
  "message": "Cross-check OK - K-4-17-I cocok dengan nilai terverifikasi dari klaim riil",
  "code": "K-4-17-I",
  "deskripsi": "NYERI ABDOMEN & GASTROENTERITIS LAIN-LAIN (RINGAN)",
  "expected_tarif_kelas_3": 1264200,
  "actual_tarif_kelas_3": 1264200,
  "tarif_kelas_2": 1472800,
  "tarif_kelas_1": 1681400,
  "regional": "1",
  "tipe_rs": "D_SWASTA",
  "jenis_layanan": "RAWAT_INAP",
  "sumber_halaman": 195,
  "source": "PMK No. 3 Tahun 2023, Halaman 195"
}
```

## Validation Rule: RV-21

**Nama**: Tarif INACBG vs Tabel Resmi PMK 3/2023
**Priority**: 2 (Major)
**Field**: tarif_inacbg

Validasi ini dilakukan otomatis saat ekstraksi/validasi record melalui `ruleEngine.validateRecord()`. Menggunakan data dari JSON file (tidak query DB) untuk tetap sinkron dengan lookup service.

**Kondisi Gagal**:
- TARIF_INACBG klaim tidak cocok dengan tarif resmi PMK 3/2023 untuk kode dan kelas rawat yang sama
- Error message: "TARIF_INACBG klaim tidak cocok dengan tarif resmi PMK No. 3 Tahun 2023 untuk kode dan kelas rawat ini."

## Kasus Test: ELVINA SAIDAH

**Klaim Data**:
- Nama Pasien: ELVINA SAIDAH
- Kode INA-CBG: K-4-17-I
- Jenis Layanan: RAWAT_INAP
- Kelas Rawat: 3
- Tarif di Klaim: Rp1.264.200

**Verifikasi**:
```bash
# Curl example
curl -X POST http://localhost:5000/api/v1/tarif/verify \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "kodeInacbg": "K-4-17-I",
    "kelasRawat": 3,
    "tarifKlaim": 1264200,
    "jenisLayanan": "RAWAT_INAP"
  }'
```

**Expected Result**: 
- Status: `PASS`
- Selisih: 0
- Valid: true

## File Locations

| File | Purpose |
|------|---------|
| `src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json` | Master data tarif (1,075 baris dari PMK 3/2023 pages 190-203) |
| `src/services/tarifInacbgLookup.js` | Lookup service (JSON-based, used by RV-21) |
| `src/services/tarifVerificationService.js` | Batch verification & detail retrieval |
| `src/routes/tarifInacbg.js` | REST API endpoints |
| `scripts/seedTarifInacbg.js` | Script untuk seed data ke database |
| `TARIF_INTEGRATION_GUIDE.md` | Dokumentasi ini |

## Notes

### Data Quality
- **Ekstraksi**: PyMuPDF (word-level bounding-box extraction)
- **Validasi**: 0/1,075 baris gagal validasi struktural
- **Cross-check**: K-4-17-I = Rp1.264.200 (Kelas 3) ✓ verified

### Limitations
- **Regional/Kelas**: HANYA Regional 1 x Kelas D Swasta (sesuai RS Lestari)
  - Regional/Kelas lain dari PMK 3/2023 SENGAJA tidak diekstrak
- **Top-up Special CMG**: Belum terintegrasi (pages 60-95, in progress untuk task berikutnya)

### Performance
- **Lookup**: ~1ms (in-memory Map, JSON-based)
- **Batch verify 1,000 records**: ~100ms (synchronous)
- **Search**: Index di database pada kode_inacbg, jenis_layanan

## Troubleshooting

### Seed Script Gagal: Database Connection Error

```
Error: getaddrinfo ENOTFOUND eclaim_postgres
```

**Solusi**:
1. Pastikan database running: `docker ps | grep eclaim_postgres`
2. Cek .env: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
3. Test koneksi: `psql -h <DB_HOST> -U <DB_USER> -d <DB_NAME>`

### Cross-check K-4-17-I Gagal

```
Cross-check K-4-17-I: GAGAL -- nilai di DB = null, seharusnya 1264200
```

**Solusi**:
1. Cek file JSON: `grep -A 5 '"kode_inacbg": "K-4-17-I"' src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json`
2. Cek insert query untuk casting ke BIGINT yang benar
3. Re-run seed setelah perbaikan

### API Endpoint Returns 503

```json
{
  "status": "empty",
  "message": "Tabel tarif_inacbg_pmk3_2023 belum di-seed..."
}
```

**Solusi**: Jalankan seed script: `node scripts/seedTarifInacbg.js`

## Related Tasks

- **Link 7** (this): PMK 3/2023 Tarif Integration & Verification ✓
- **Link 8** (future): Special CMG Tarif Top-up (pages 60-95)
- **Link 9** (future): Multi-regional Tarif Support (expand beyond Regional 1)

## References

1. Peraturan Menteri Kesehatan Nomor 3 Tahun 2023 tentang Standar Tarif Pelayanan Kesehatan Program Jaminan Kesehatan
2. Halaman 190-203 (Rawat Inap + Rawat Jalan)
3. Regional 1, Kelas D Swasta, RS Lestari Raharja (Kode Provider 0170)
