# Tahap 2: Form Verifikasi Berbasis Eksepsi — Implementasi Backend

**Status:** ✅ Selesai (Backend)  
**Branch:** `feat/ai-ekstraksi-pdf`  
**Tanggal:** 21 Jul 2026

## Ringkasan

Tahap 2 mengintegrasikan validasi rule engine ke dalam alur ekstraksi PDF, sehingga sistem otomatis mendeteksi field yang bermasalah. Data ekstraksi sekarang disimpan bersama hasil validasinya, siap untuk ditampilkan di form verifikasi.

---

## File yang Diubah

### 1. `be/src/routes/claimFiles.js`

#### Helper Function: `vclaimToDbFormat()`

Mengkonversi record vClaim (format uppercase, struktur vClaim) ke format database (lowercase snake_case).

```javascript
// Input (vClaim format):
{
  KODE_RS: '3371084',
  SEP: '0170R0110626V000314',
  NOKARTU: '0000000000001',
  NAMA_PASIEN: 'PASIEN TEST',
  BIRTH_DATE: '15/05/1990',
  ADMISSION_DATE: '10/03/2026',
  DISCHARGE_DATE: '15/03/2026',
  ...
}

// Output (Database format):
{
  kode_rs: '3371084',
  sep: '0170R0110626V000314',
  nokartu: '0000000000001',
  nama_pasien: 'PASIEN TEST',
  birth_date: '1990-05-15',
  admission_date: '2026-03-10',
  discharge_date: '2026-03-15',
  ...
}
```

**Field yang di-cover (35+ kolom):**
- Identitas: SEP, NOKARTU, NAMA_PASIEN, MRN, DPJP
- Tanggal: BIRTH_DATE, ADMISSION_DATE, DISCHARGE_DATE
- Pasien: SEX (→ gender), UMUR_TAHUN, UMUR_HARI, BIRTH_WEIGHT
- Klaim: KELAS_RAWAT, DISCHARGE_STATUS, KODE_RS, KELAS_RS
- Diagnosis/Prosedur: DIAGLIST (→ diagnosa_list), PROCLIST (→ prosedur_list)
- Tarif: TARIF_INACBG, TARIF_RS, TOTAL_TARIF, TARIF_POLI_EKS
- Administrasi: LOS, ICU_INDIKATOR, ICU_LOS, VENT_HOUR
- Konsultasi: JENIS_KONSULTASI, JUMLAH_EPISODE_KLAIM, IS_SAME_DAY
- Program: HISTORI_OBAT_KRONIS_BULAN_BERTURUT, STATUS_PASIEN, FLAG_RUJUK_BALIK_PRB, URUTAN_ITERASI

#### Endpoint: `POST /api/v1/claim-files/upload-pdf`

**Perubahan:**
1. Setelah ekstraksi PDF, data dikonversi ke format database
2. Jalankan `validateRecord()` dari ruleEngine (RV-01 sampai RV-17)
3. Tentukan validation_status: `valid` / `error` / `pending`
4. Simpan extracted record + validation errors dalam transaction
5. Return validation results dalam response

**Response:**
```json
{
  "status": "success",
  "file_id": "uuid-here",
  "record_id": "uuid-here",
  "original_name": "filename.pdf",
  "vclaimFormat": { /* 60 kolom vClaim format */ },
  "validation_status": "error|pending|valid",
  "validation_errors": [
    {
      "rule_id": "RV-01",
      "field_name": "sep",
      "error_message": "SEP mengandung huruf kecil. Harus uppercase semua.",
      "expected_value": "0170R0110626V000314",
      "actual_value": "0170r0110626v000314",
      "severity": "critical"
    },
    ...
  ],
  "metadata": { /* metadata ekstraksi */ }
}
```

#### Endpoint: `GET /api/v1/claim-files/:record_id/validation-errors`

Fetch semua validation errors untuk satu record, grouped by field name.

**Request:**
```
GET /api/v1/claim-files/uuid-record-id/validation-errors
Header: Authorization: Bearer ...
```

**Response:**
```json
{
  "validation_status": "error",
  "error_count": 3,
  "errors_by_field": {
    "sep": [
      {
        "rule_id": "RV-01",
        "error_message": "SEP mengandung huruf kecil.",
        "expected_value": "0170R0110626V000314",
        "actual_value": "0170r0110626v000314",
        "severity": "critical"
      }
    ],
    "diagnosa_list": [
      {
        "rule_id": "RV-05",
        "error_message": "Kode diagnosa ICD-10 tidak valid: INVALID",
        "expected_value": "Format ICD-10 (contoh: E11.9, I10, J18.0)",
        "actual_value": "INVALID",
        "severity": "major"
      }
    ],
    ...
  },
  "all_errors": [ /* array dari semua errors */ ]
}
```

---

## Database Schema

Tidak ada perubahan schema. Tabel yang digunakan:
- `claim_files` — existing, mencatat file upload metadata
- `claim_records` — existing, columns: `validation_status` (sudah ada), `error_count` (sudah ada), `raw_data`
- `validation_errors` — existing, columns: `id`, `record_id`, `rule_id`, `field_name`, `error_message`, `expected_value`, `actual_value`, `severity`, `created_at`
- `validation_rules` — existing, berisi RV-01 sampai RV-17

---

## Validation Rules (RV-01 s/d RV-17)

Semua rules sudah diimplementasikan di `ruleEngine.js`. Rule validation otomatis berjalan saat upload PDF:

| Rule | Fokus | Severity |
|------|-------|----------|
| RV-01 | SEP format (uppercase) | CRITICAL |
| RV-02 | NOKARTU (13 digit) | CRITICAL |
| RV-03 | Admission ≤ Discharge date | CRITICAL |
| RV-04 | Age cross-check dengan birth_date | MAJOR |
| RV-05 | ICD-10 diagnosis code format | MAJOR |
| RV-06 | ICD-9-CM procedure code format | MAJOR |
| RV-07 | KELAS_RAWAT (1/2/3) | MAJOR |
| RV-08 | DISCHARGE_STATUS (1-5) | MAJOR |
| RV-09 | NAMA_PASIEN not empty | CRITICAL |
| RV-10 | Tarif RS vs INACBG discrepancy | MINOR |
| RV-11 | Rehabilitasi Medik (BA 1247/2024) | MAJOR |
| RV-12 | Eksisi tumor & PA (BA 1247/2024) | MAJOR |
| RV-13 | Konsul internal gabung episode (BA 1247/2024) | MAJOR |
| RV-14 | Rujukan internal RJTL (BA 1247/2024) | MAJOR |
| RV-15 | Program Rujuk Balik (BA 1247/2024) | MAJOR |
| RV-16 | Iterasi obat kronis (BA 1247/2024) | MAJOR |
| RV-17 | Odontektomi rawat jalan (PMK 3/2023) | MAJOR |

---

## Alur Data (Flow)

```
1. User upload PDF
   ↓
2. extractFromPDF() → extract 60 kolom vClaim format
   ↓
3. vclaimToDbFormat() → konversi ke database format
   ↓
4. validateRecord() → jalankan RV-01 s/d RV-17
   ↓
5. Save dalam transaction:
   - Insert ke claim_records (dengan validation_status, error_count)
   - Insert validation errors ke validation_errors table
   ↓
6. Return response dengan validation results
   ↓
7. Frontend fetch full validation errors via GET /validation-errors
   ↓
8. Frontend display form verifikasi (hanya field dengan error)
```

---

## Testing

File test: `be/src/__tests__/unit/pdfExtraction.test.js`

Test coverage:
- ✅ Valid extracted record passes all validation
- ✅ Missing critical fields caught
- ✅ Date format validation (admission ≤ discharge)
- ✅ Diagnosis code format validation
- ✅ Kelas rawat range validation
- ✅ Error status determination

**Jalankan test (jika Jest dikonfigurasi):**
```bash
npm test -- pdfExtraction.test.js
```

---

## Frontend Integration (Belum implementasi — user fokus backend)

Frontend perlu:

1. **Upload PDF → display extraction + validation result**
   ```javascript
   POST /api/v1/claim-files/upload-pdf
   → handle response.validation_errors
   ```

2. **Fetch full validation errors**
   ```javascript
   GET /api/v1/claim-files/{record_id}/validation-errors
   → display errors_by_field grouped
   ```

3. **Form verifikasi UI:**
   - Display 52 kolom (hide 8 system-only columns)
   - Mark field RED (error) / GREEN (pass) / HIDDEN (system-filled)
   - Show error detail: message, expected, actual, severity
   - Allow user to edit field value
   - Option "Tampilkan semua" toggle to show/hide green fields

4. **Example UI:**
   ```
   Validasi Ekstraksi
   ─────────────────────
   
   ❌ SEP: 0170r0110626v000314
      Error: SEP mengandung huruf kecil
      Expected: 0170R0110626V000314
      Severity: CRITICAL
   
   ❌ DIAGLIST: INVALID;O42.1
      Error: Kode diagnosa ICD-10 tidak valid: INVALID
      Expected: Format ICD-10
      Severity: MAJOR
   
   ✅ NAMA_PASIEN: PASIEN TEST (pass, hidden)
   ✅ BIRTH_DATE: 15/05/1990 (pass, hidden)
   
   [Tampilkan semua] button
   ```

---

## Edge Cases & Notes

1. **Field yang tidak ada di PDF (system-only):**
   - `CODER_ID`, `VERSI_INACBG`, `VERSI_GROUPER`, `C1`, `C2`, `C3`, `C4`, `TARIF_RS` (tarif RS sendiri)
   - Tidak pernah diekstrak, jadi tidak akan ada di validasi
   - Frontend sebaiknya tandai "akan diisi sistem saat submit"

2. **Date parsing:**
   - vClaim: DD/MM/YYYY (e.g., "15/05/1990")
   - Database: YYYY-MM-DD (e.g., "1990-05-15")
   - Konversi otomatis di `vclaimToDbFormat()`

3. **Numeric fields:**
   - Automtically parsed dari string ke number (int/float)
   - Jika parse fail → null, validation rule akan tangkap

4. **Validation status:**
   - `valid`: 0 errors
   - `error`: ada critical atau major error
   - `pending`: hanya minor errors

5. **Error message customization:**
   - Default message di ruleEngine.js
   - Bisa override di database (kolom `validation_rules.error_message`)

---

## Deployment Checklist

- [ ] Merge branch `feat/ai-ekstraksi-pdf` ke `master`
- [ ] Backup DB produksi
- [ ] Deploy backend (new endpoints + validation logic)
- [ ] Verify PDF upload + validation works
- [ ] Frontend update: implement form verifikasi
- [ ] User testing dengan real PDF samples
- [ ] Monitor error logs

---

## Kontak & Troubleshooting

**Jika validation tidak berjalan:**
1. Check: `validation_rules` table ada rules dengan `is_active = 1`
2. Check: `claim_records` table punya kolom `validation_status`, `error_count`
3. Check: Backend logs untuk error messages saat upload PDF

**Jika vclaimToDbFormat tidak handle field tertentu:**
- Add ke MAPPING object di `vclaimToDbFormat()`
- Determine data type (date/int/float/string)
- Add parsing logic di else-if chain

---

_Dokumentasi ini menerangkan implementasi backend Tahap 2. Frontend masih perlu dikerjakan di sesi selanjutnya._
