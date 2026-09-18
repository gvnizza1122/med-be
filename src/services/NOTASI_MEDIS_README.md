# Notasi Medis & Singkatan Parser

Parser untuk menerjemahkan notasi klinis dan singkatan medis dari teks resume medis menjadi format JSON terstruktur.

## Overview

Implementasi terdiri dari 3 komponen utama:

### 1. Kamus Singkatan Medis (`src/data/singkatan_medis.json`)
- **241 singkatan medis** dari bahasa klinis RS Lestari Raharja
- Contoh: CA → "konjungtiva anemis", SI → "sklera ikterik", KU → "keadaan umum"
- Format: JSON key-value dengan uppercase keys

### 2. Notation Parser (`src/services/notasiMedisParser.js`)
- **Parse notasi bilateral**: +/+, −/−, +/−, −/+
- **Parse notasi tunggal**: +, −
- **Translasi singkatan**: otomatis ke bentuk lengkap
- **Struktur output**: JSON terstruktur dengan status ada/tidak dan informasi sisi

### 3. Integration (`src/services/pdfExtractionPipeline.js`)
- Dijalankan **setelah OCR text extraction** 
- Menambahkan field `physical_exam_findings` ke record vClaim
- Non-blocking: parsing error tidak menghentikan pipeline

## Fitur Utama

### Parsing Notasi Bilateral

Mendukung 4 tipe notasi bilateral:

| Notasi | Makna | Output |
|--------|-------|--------|
| `+/+` | Bilateral positif | `{ada: true, sisi: 'bilateral', kanan: true, kiri: true}` |
| `−/−` | Bilateral negatif | `{ada: false, sisi: 'negatif', kanan: false, kiri: false}` |
| `+/−` | Kanan positif, kiri negatif | `{ada: true, sisi: 'kanan', kanan: true, kiri: false}` |
| `−/+` | Kanan negatif, kiri positif | `{ada: true, sisi: 'kiri', kanan: false, kiri: true}` |

### Contoh Penggunaan

#### Contoh 1: Parse Firdan Resume Medis
```javascript
const { parsePhysicalExam } = require('./notasiMedisParser');

const text = 'ronchi +/+ whezing +/+';
const result = parsePhysicalExam(text);
```

**Output:**
```json
{
  "ronchi": {
    "ada": true,
    "sisi": "bilateral",
    "kanan": true,
    "kiri": true,
    "notasi_asli": "+/+",
    "translasi": "suara napas tambahan kasar"
  },
  "whezing": {
    "ada": true,
    "sisi": "bilateral",
    "kanan": true,
    "kiri": true,
    "notasi_asli": "+/+",
    "translasi": "suara napas berbunyi bersiul"
  }
}
```

#### Contoh 2: Parse Notasi Campuran
```javascript
const text = 'murmur +/− edema bilateral − hepatomegali +';
const result = parsePhysicalExam(text);
```

**Output:**
```json
{
  "murmur": {
    "ada": true,
    "sisi": "kanan",
    "kanan": true,
    "kiri": false,
    "notasi_asli": "+/−"
  },
  "edema bilateral": {
    "ada": false,
    "notasi_asli": "−",
    "translasi": "pembengkakan bilateral"
  },
  "hepatomegali": {
    "ada": true,
    "notasi_asli": "+",
    "translasi": "pembesaran hati"
  }
}
```

#### Contoh 3: Terjemahkan Singkatan
```javascript
const { translateClinicalText } = require('./notasiMedisParser');

const text = 'Pemeriksaan: CA +/+ dengan SI −. KU baik, CM.';
const translated = translateClinicalText(text);
```

**Output:**
```
Pemeriksaan: konjungtiva anemis +/+ dengan sklera ikterik −. keadaan umum baik, compos mentis.
```

## API Reference

### `parsePhysicalExam(text: string): Object`
Parse temuan pemeriksaan fisik dari teks klinis.

**Parameters:**
- `text` (string): Teks pemeriksaan fisik dengan notasi medis

**Returns:**
```javascript
{
  temuan_name: {
    ada: boolean,           // true = positif/ada, false = negatif/tidak ada
    sisi: string,          // 'bilateral'|'kanan'|'kiri'|'negatif'|null
    kanan: boolean|null,   // status sisi kanan (jika bilateral)
    kiri: boolean|null,    // status sisi kiri (jika bilateral)
    notasi_asli: string,   // notasi asli dari input (+, −, +/+, dst)
    translasi: string      // [optional] translasi singkatan ke bentuk lengkap
  }
}
```

### `parsePhysicalExamStructured(text: string): Object`
Wrapper yang mengembalikan hasil dengan metadata.

**Returns:**
```javascript
{
  success: boolean,
  findings: Object,      // sama seperti parsePhysicalExam()
  raw_input: string,
  parsed_at: string      // ISO timestamp
}
```

### `parseBilateralNotation(notasi: string): Object|null`
Parse notasi bilateral tunggal.

**Supported formats:** `+/+`, `−/−`, `+/−`, `−/+` dan variasinya dengan spasi

### `parseSingleNotation(notasi: string): Object|null`
Parse notasi tunggal.

**Supported formats:** `+`, `−`, `-`

### `translateAbbreviation(text: string): string`
Terjemahkan satu atau lebih singkatan dalam teks.

**Example:**
```javascript
translateAbbreviation('CA') // → 'konjunktiva anemis'
translateAbbreviation('KU baik') // → 'keadaan umum baik'
```

### `translateClinicalText(text: string): string`
Terjemahkan semua singkatan dalam sebuah teks panjang.

### `getSingkatanDict(): Object`
Dapatkan dictionary lengkap singkatan medis (241 entries).

## Format Data Output

### Untuk Tabel 2 Kegawatdaruratan

Output parser dapat langsung dipetakan ke Tabel 2 struktur:

```javascript
const temuanParu = parsePhysicalExam('ronchi +/+ whezing +/+');

const table2Data = {
  findings: temuanParu,
  mapping: {
    respiratory: [
      {
        temuan: 'ronchi',
        ada: temuanParu.ronchi.ada,
        sisi: temuanParu.ronchi.sisi,
        translasi: temuanParu.ronchi.translasi
      },
      {
        temuan: 'whezing',
        ada: temuanParu.whezing.ada,
        sisi: temuanParu.whezing.sisi,
        translasi: temuanParu.whezing.translasi
      }
    ]
  }
};
```

## Integrasi dengan PDF Extraction Pipeline

Parser sudah terintegrasi di `pdfExtractionPipeline.js`:

```javascript
// Di dalam extractFromPDF()
const physicalExamFindings = parsePhysicalExam(clinicalText);
if (Object.keys(physicalExamFindings).length > 0) {
  result.record.physical_exam_findings = physicalExamFindings;
}
```

**Record output tambahan:**
- `result.record.physical_exam_findings`: JSON temuan terstruktur
- `result.record.OBJECTIVE_FINDINGS_TRANSLATED`: [optional] teks objektif dengan singkatan terjemahkan

## Supported Abbreviations (Sampel)

| Kategori | Singkatan | Translasi |
|----------|-----------|-----------|
| **Umum** | KU | keadaan umum |
| | CM | compos mentis |
| **Mata** | CA | konjungtiva anemis |
| | SI | sklera ikterik |
| **Paru** | RR | respiratory rate/frekuensi napas |
| | Ronchi | suara napas tambahan kasar |
| | Whezing | suara napas berbunyi bersiul |
| | Crackles | suara napas berderik halus |
| **Jantung** | HR | heart rate |
| | S1, S2, S3, S4 | bunyi jantung |
| **Perut** | Abd | abdomen |
| | Hepatomegali | pembesaran hati |
| | Splenomegali | pembesaran limpa |
| | Ascites | penumpukan cairan di perut |
| **Lab** | WBC | white blood cell/sel darah putih |
| | Hb | hemoglobin |
| | Plt | platelet/trombosit |
| **Imaging** | EKG | electrocardiogram |
| | USG | ultrasonography |
| | CT | computed tomography |

**Total: 241 singkatan medis**

## Testing

### Unit Tests
```bash
npm test -- src/__tests__/unit/notasiMedisParser.test.js
```

### Manual Test
```bash
node test-notasi-parser.js
```

Tes manual mencakup:
1. Parse Firdan Resume Medis example
2. Parse dengan notasi campuran
3. Parse dengan singkatan
4. Structured output format
5. Translate clinical text
6. Complete clinical resume excerpt

## Error Handling

Parser menggunakan **non-blocking error handling**:

```javascript
try {
  const findings = parsePhysicalExam(clinicalText);
  result.record.physical_exam_findings = findings;
} catch (parseErr) {
  console.warn('[Pipeline] Parsing notasi medis gagal:', parseErr.message);
  // Continue tanpa error — parsing notasi bukan blocking operation
}
```

Jika parsing gagal:
- Pipeline **tetap lanjut** (tidak crash)
- Field `physical_exam_findings` tidak ditambahkan ke record
- Error di-log untuk debugging

## Performance Notes

- **Dictionary loading**: Sekali saat startup (cached di memory)
- **Parse per dokumen**: ~1-5ms untuk 100+ temuan
- **Regex compile**: Sekali per operasi (tidak di-cache)

Tidak ada blocking I/O atau network call.

## Future Enhancements

1. **Context-aware parsing**: Deteksi bagian dokumen (Thorax, Abdomen, dll)
2. **Confidence scoring**: Ukur seberapa yakin parser terhadap hasil
3. **Mapping ke vClaim codes**: Otomatis mapping ke kode ICD/tabel referensi
4. **Machine learning**: Improve accuracy dengan training data lebih banyak

## References

- **Dokumentasi RS Lestari Raharja**: Resume Medis format standar
- **Tabel 2 Kegawatdaruratan**: Struktur output untuk emergency severity
- **vClaim Schema**: Field mapping ke kolom vClaim (60 kolom)

## Maintenance

### Menambah Singkatan Baru
Edit `src/data/singkatan_medis.json`:

```json
{
  "singkatan": {
    "SINGKAT_BARU": "Bentuk lengkap baru",
    ...
  }
}
```

### Menambah Notasi Baru
Jika ada format notasi baru selain +, −, +/+, −/−, +/−, −/+:
1. Update regex pattern di `notasiMedisParser.js`
2. Tambah test case di `notasiMedisParser.test.js`
3. Update dokumentasi

## Contact & Support

Untuk bugs, feature requests, atau clarifications:
- Lihat kode di `src/services/notasiMedisParser.js`
- Jalankan test: `npm test`
- Check logs dari pdfExtractionPipeline
