# API Validation Endpoints — Tahap 2

**Base URL:** `http://localhost:60131/api/v1` (development)  
**Authentication:** Bearer token in Authorization header

---

## Endpoint 1: Upload & Extract PDF dengan Validasi

### POST `/claim-files/upload-pdf`

Upload PDF klaim, ekstrak data vClaim, dan jalankan validasi otomatis.

**Request:**
```
POST /api/v1/claim-files/upload-pdf HTTP/1.1
Authorization: Bearer <token>
Content-Type: multipart/form-data

file=<binary PDF>
```

**Response (Success):**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "success",
  "file_id": "550e8400-e29b-41d4-a716-446655440000",
  "record_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "original_name": "claim_patient_123.pdf",
  "validation_status": "error",
  "error_count": 3,
  "validation_errors": [
    {
      "rule_id": "RV-01",
      "field_name": "sep",
      "error_message": "SEP mengandung huruf kecil. Harus uppercase semua (contoh: huruf \"v\" harus \"V\").",
      "expected_value": "0170R0110626V000314",
      "actual_value": "0170r0110626v000314",
      "severity": "critical"
    },
    {
      "rule_id": "RV-05",
      "field_name": "diagnosa_list",
      "error_message": "Kode diagnosa ICD-10 tidak valid: INVALID",
      "expected_value": "Format ICD-10 (contoh: E11.9, I10, J18.0)",
      "actual_value": "INVALID",
      "severity": "major"
    },
    {
      "rule_id": "RV-09",
      "field_name": "nama_pasien",
      "error_message": "Nama pasien wajib diisi.",
      "expected_value": "Nama pasien",
      "actual_value": "(kosong)",
      "severity": "critical"
    }
  ],
  "vclaimFormat": {
    "KODE_RS": "3371084",
    "KELAS_RS": "RSU",
    "KELAS_RAWAT": "2",
    "KODE_TARIF": "...",
    "PTD": "1",
    "ADMISSION_DATE": "10/03/2026",
    "DISCHARGE_DATE": "15/03/2026",
    "BIRTH_DATE": "15/05/1990",
    "BIRTH_WEIGHT": "3500",
    "SEX": "P",
    "DISCHARGE_STATUS": "1",
    "DIAGLIST": "INVALID",
    "PROCLIST": "88.72;90.59",
    "ADL1": "-",
    "ADL2": "-",
    ...60 kolom total...
  },
  "metadata": {
    "extracted_at": "2026-07-21T10:30:00Z",
    "pages_classified": 5,
    "scan_pages": 0,
    "native_pages": 5,
    "extraction_model": "google/gemini-2.5-flash-lite"
  }
}
```

**Response (Extraction Failed):**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "File ini bukan PDF atau PDF rusak. Silakan gunakan file PDF yang valid dan coba lagi."
}
```

**Status Codes:**
- `200 OK` — Ekstraksi berhasil (bisa ada validasi error)
- `400 Bad Request` — PDF invalid atau error ekstraksi
- `500 Internal Server Error` — Server error

**Validation Status Values:**
- `valid` — 0 errors
- `error` — Ada critical atau major error
- `pending` — Hanya minor errors

**Severity Levels:**
- `critical` — Harus diperbaiki (RV-01, RV-02, RV-03, RV-09)
- `major` — Sebaiknya diperiksa (RV-04 s/d RV-17)
- `minor` — Untuk info (RV-10)

---

## Endpoint 2: Fetch Validation Errors (Full)

### GET `/claim-files/{record_id}/validation-errors`

Fetch semua validation errors untuk satu record, grouped by field.

**Request:**
```
GET /api/v1/claim-files/6ba7b810-9dad-11d1-80b4-00c04fd430c8/validation-errors HTTP/1.1
Authorization: Bearer <token>
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
        "error_message": "SEP mengandung huruf kecil. Harus uppercase semua (contoh: huruf \"v\" harus \"V\").",
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
    "nama_pasien": [
      {
        "rule_id": "RV-09",
        "error_message": "Nama pasien wajib diisi.",
        "expected_value": "Nama pasien",
        "actual_value": "(kosong)",
        "severity": "critical"
      }
    ]
  },
  "all_errors": [
    {
      "rule_id": "RV-01",
      "field_name": "sep",
      "error_message": "SEP mengandung huruf kecil. Harus uppercase semua (contoh: huruf \"v\" harus \"V\").",
      "expected_value": "0170R0110626V000314",
      "actual_value": "0170r0110626v000314",
      "severity": "critical"
    },
    {
      "rule_id": "RV-05",
      "field_name": "diagnosa_list",
      "error_message": "Kode diagnosa ICD-10 tidak valid: INVALID",
      "expected_value": "Format ICD-10 (contoh: E11.9, I10, J18.0)",
      "actual_value": "INVALID",
      "severity": "major"
    },
    {
      "rule_id": "RV-09",
      "field_name": "nama_pasien",
      "error_message": "Nama pasien wajib diisi.",
      "expected_value": "Nama pasien",
      "actual_value": "(kosong)",
      "severity": "critical"
    }
  ]
}
```

**Status Codes:**
- `200 OK` — Success
- `404 Not Found` — Record tidak ditemukan
- `500 Internal Server Error` — Server error

---

## Field Mapping Reference

Ketika frontend display extracted data, gunakan nama field database (lowercase snake_case):

| vClaim Format | Database Format | Tipe | Contoh |
|---|---|---|---|
| KODE_RS | kode_rs | string | "3371084" |
| SEP | sep | string | "0170R0110626V000314" |
| NOKARTU | nokartu | string | "0000000000001" |
| NAMA_PASIEN | nama_pasien | string | "PASIEN TEST" |
| BIRTH_DATE | birth_date | date (YYYY-MM-DD) | "1990-05-15" |
| ADMISSION_DATE | admission_date | date (YYYY-MM-DD) | "2026-03-10" |
| DISCHARGE_DATE | discharge_date | date (YYYY-MM-DD) | "2026-03-15" |
| SEX | gender | string | "L" atau "P" |
| UMUR_TAHUN | umur_tahun | int | 36 |
| KELAS_RAWAT | kelas_rawat | int (1-3) | 2 |
| DISCHARGE_STATUS | discharge_status | int (1-5) | 1 |
| DIAGLIST | diagnosa_list | string (semicolon-separated) | "O42.1;O68.0;O82.1" |
| PROCLIST | prosedur_list | string (semicolon-separated) | "74.1;75.32;90.59" |
| DPJP | dpjp_name | string | "dr. Ronald Sp.OT" |
| TARIF_RS | tarif_rs | float | 50000000 |
| LOS | los | int | 5 |
| JENIS_KLAIM | jenis_klaim | string | "RAWAT_INAP" |

---

## Frontend Integration Guide

### 1. Upload PDF & Display Initial Results

```typescript
async function uploadPDF(file: File) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(
    'http://localhost:60131/api/v1/claim-files/upload-pdf',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    }
  );

  const data = await response.json();
  
  if (!response.ok) {
    // Handle error: data.error
    showError(data.error);
    return;
  }

  // Success: data.status === 'success'
  const recordId = data.record_id;
  const validationStatus = data.validation_status; // 'error' | 'pending' | 'valid'
  const errors = data.validation_errors; // array

  // Display form verifikasi with errors
  displayVerificationForm(recordId, data.vclaimFormat, errors);
}
```

### 2. Fetch Full Validation Details

```typescript
async function fetchValidationErrors(recordId: string) {
  const response = await fetch(
    `http://localhost:60131/api/v1/claim-files/${recordId}/validation-errors`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );

  const data = await response.json();
  // data.validation_status
  // data.error_count
  // data.errors_by_field[fieldName]
  // data.all_errors

  return data;
}
```

### 3. Display Form Verifikasi

```typescript
interface VerificationField {
  name: string;
  label: string;
  value: string;
  hasError: boolean;
  errors: Array<{
    rule_id: string;
    error_message: string;
    expected_value: string;
    actual_value: string;
    severity: 'critical' | 'major' | 'minor';
  }>;
}

function renderVerificationForm(
  recordId: string,
  extractedData: Record<string, any>,
  validationErrors: Record<string, any>
) {
  // 1. Build fields from extracted data (52 important fields)
  const fields: VerificationField[] = [
    {
      name: 'sep',
      label: 'No. SEP',
      value: extractedData.SEP,
      hasError: validationErrors.sep?.length > 0,
      errors: validationErrors.sep || []
    },
    // ... more fields
  ];

  // 2. Render with conditional styling
  fields.forEach(field => {
    if (field.hasError) {
      // Show in RED with error details
      renderErrorField(field);
    } else {
      // Show in GREEN but in collapsible "Tampilkan semua"
      storeGreenField(field);
    }
  });

  // 3. Add "Tampilkan semua" toggle
  renderToggleButton(() => {
    toggleGreenFields();
  });

  // 4. Allow editing and re-submit
  attachFieldChangeHandlers((fieldName, newValue) => {
    // Update extracted data in-memory
    extractedData[fieldName] = newValue;
  });
}
```

### 4. Error Display Example

```
Validasi Ekstraksi Data
══════════════════════════════════

Status: ❌ ADA KESALAHAN (3 field perlu diperbaiki)

[Field dengan Kesalahan]

❌ SEP: 0170r0110626v000314
   ├─ Error: SEP mengandung huruf kecil. Harus uppercase.
   ├─ Expected: 0170R0110626V000314
   ├─ Severity: CRITICAL (🔴 Harus diperbaiki)

❌ Diagnosa: INVALID;O42.1
   ├─ Error: Kode diagnosa ICD-10 tidak valid: INVALID
   ├─ Expected: Format ICD-10 (contoh: E11.9, I10, J18.0)
   ├─ Severity: MAJOR (🟡 Sebaiknya diperiksa)

❌ Nama Pasien: [kosong]
   ├─ Error: Nama pasien wajib diisi.
   ├─ Expected: Nama pasien
   ├─ Severity: CRITICAL (🔴 Harus diperbaiki)

[✅ Tampilkan semua field] ← Toggle untuk lihat field yang lolos

─────────────────────────────────────

[Edit Data] [Simpan & Lanjut] [Batalkan]
```

---

## Error Response Formats

### PDF Upload Error

```json
{
  "error": "Terjadi gangguan saat memproses berkas. Silakan coba lagi."
}
```

### Validation Error (Record Not Found)

```json
{
  "error": "Record tidak ditemukan"
}
```

### Server Error

```json
{
  "error": "Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit."
}
```

---

## Field Validation Rules Reference

| Rule | Field | Condition | Error Type |
|------|-------|-----------|-----------|
| RV-01 | sep | Must be uppercase | critical |
| RV-02 | nokartu | Must be 13 digits | critical |
| RV-03 | admission_date, discharge_date | admission ≤ discharge | critical |
| RV-04 | umur_tahun, birth_date | Age must match (tolerance 1 year) | major |
| RV-05 | diagnosa_list | Valid ICD-10 format | major |
| RV-06 | prosedur_list | Valid ICD-9-CM format | major |
| RV-07 | kelas_rawat | Must be 1, 2, or 3 | major |
| RV-08 | discharge_status | Must be 1-5 | major |
| RV-09 | nama_pasien | Not empty | critical |
| RV-10 | tarif_rs, total_tarif | Tariff discrepancy <50% | minor |
| RV-11-17 | (various) | Complex rules (rehab, tumor, etc.) | major |

---

## Testing API dengan cURL

```bash
# Upload PDF
curl -X POST http://localhost:60131/api/v1/claim-files/upload-pdf \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/file.pdf"

# Fetch validation errors
curl -X GET http://localhost:60131/api/v1/claim-files/RECORD_ID/validation-errors \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

**Last Updated:** 21 Jul 2026  
**Implementation Status:** ✅ Backend Complete, Frontend Ready for Integration
