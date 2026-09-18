# OCR Pipeline Enhancement Implementation

**Date**: 18 September 2026  
**Goal**: Enhance OCR pipeline untuk read semua halaman dengan detail tinggi, khususnya vital signs dan clinical findings

## Problem Statement

Current OCR pipeline missing vital information:
- **Vital Signs**: SpO2, HR, RR, BP, Temperature tidak terbaca padahal terlihat jelas di dokumen
- **Clinical Findings**: Resume medis detail findings (ronchi +/+, whezing +/+, etc) tidak terbaca
- **Resolution**: PDF render menggunakan scale factor 3.0 (~216 DPI), kurang detail untuk teks kecil/medis

## Solution Architecture

### 1. Increase OCR Resolution
**File**: `src/workers/pdfRenderWorker.js`

```javascript
// Before: scale factor 3.0 (~216 DPI)
// After: scale factor 4.0 (~288 DPI) — balanced tradeoff
const DEFAULT_SCALE = 4.0;
const HIGH_DETAIL_SCALE = 5.0; // Optional untuk critical pages
```

**Impact**: ~1.8x memory per page (scale²) tapi CPU masih manageable  
**Result**: Better readability untuk medical notation dan small text

### 2. Multi-Pass OCR Architecture
**File**: `src/services/ocrEnhancement.js`

**Pass 1: Standard Text Extraction**
- Existing OCR yang menghasilkan general text dari semua halaman
- Classify page type (Resume Medis IGD, Triage, Resep, SEP, etc)

**Pass 2: Structured Clinical Field Extraction**
- Specialized regex patterns untuk vital signs:
  - SpO2, HR, RR, BP, Temperature
  - Weight, Height
- Specialized patterns untuk clinical findings:
  - Ronchi, Whezing, Murmur, Crackles, Edema
  - Physical exam findings dengan notasi bilaterality (+/+, +/-)

```javascript
CLINICAL_PATTERNS = {
  SpO2: [/\bSpO2\s*[:=]\s*(\d{1,3})[\s%]?/i, ...],
  HeartRate: [/\bHR\s*[:=]\s*(\d{2,3})[\s/]?(?:bpm|x')/i, ...],
  Ronchi: [/\bronchi\s*[:\s]*\+[\s]*\+/i, ...],
  // etc
}
```

### 3. Page Classification Enhancement
**File**: `src/services/ocrEnhancement.js::classifyPageContent()`

Automatically detect specialized pages:
- **Resume Medis IGD**: Prioritize vital signs extraction
- **Triage Page**: Extract physical exam + vital signs
- **Resep Page**: Extract medications (Phase 2)
- **SEP**: Extract eligibility info

### 4. Validation & Sanity Checks
**File**: `src/services/ocrEnhancement.js::validateVitalSigns()`

Validate extracted values sebelum masuk ke AI processing:
```
HR: 40-200 bpm (warning jika <40, error jika >200)
RR: 8-50 x/min (error jika <8, warning jika >50)
SpO2: 80-100% (error jika <80, warning jika >100)
Temperature: 35-42°C (error jika outlier)
BP: Systolic 70-250, Diastolic 40-150
```

### 5. Integration into Pipeline
**File**: `src/services/ocrIntegration.js`

```javascript
applyOcrEnhancements(classification, filePath, options)
  ↓
  [Multi-pass OCR]
  ↓
  [Extract vital signs + clinical findings]
  ↓
  [Validate dengan sanity checks]
  ↓
  [Merge ke claimDataText untuk AI review]
```

**Example merged text for AI**:
```
[Original claim text from pdf-parse...]

[OCR ENHANCED - VITAL SIGNS]
Detak Jantung (HR): 77 bpm
Frekuensi Napas (RR): 18 x/menit
Saturasi Oksigen (SpO2): 95%
Suhu Badan (Temp): 37.2°C
Tekanan Darah (BP): 130/80 mmHg

[OCR ENHANCED - CLINICAL FINDINGS]
Ditemukan pada pemeriksaan fisik:
- Ronchi
- Whezing
```

## Environment Configuration

Add ke `.env`:
```bash
# Enable/disable OCR enhancement (default: true)
OCR_ENHANCEMENT_ENABLED=true

# Optional: Use high-detail scale untuk critical pages
OCR_HIGH_DETAIL_MODE=false

# PDF render worker pool size (adjust per CPU cores)
PDF_RENDER_WORKER_POOL_SIZE=3
```

## File Structure

### New Files Created
```
src/services/
├── ocrEnhancement.js          # Core enhancement logic
├── ocrIntegration.js          # Pipeline integration
├── __tests__/
│   └── unit/
│       └── ocrEnhancement.test.js
└── __tests__/
    └── integration/
        └── ocrEnhancementPipeline.test.js
```

### Modified Files
```
src/workers/
└── pdfRenderWorker.js         # Increased scale factor

src/services/
└── pdfExtractionPipeline.js   # Integrated enhancements
```

## Performance Impact

### Memory Usage
- Per page: ~1.8x dari scale 3.0 → 4.0 (scale²)
- 10-page document: ~50MB additional (dari ~28MB → ~50MB estimated)
- Manageable dengan 8GB+ server RAM

### Processing Time
- Enhancement pass: +10-15% per document (secondary pass)
- Regex extraction: <1s untuk 10 pages
- **Net impact**: ~15-20% slower overall, tapi higher accuracy

## Testing

### Unit Tests
```bash
npm test -- src/__tests__/unit/ocrEnhancement.test.js
```

### Integration Tests
```bash
# Test dengan Firdan Resume Medis sample
npm test -- src/__tests__/integration/ocrEnhancementPipeline.test.js
```

### Manual Test: Firdan Resume Medis
```bash
node scripts/testOcrEnhancement.js /path/to/firdan_resume_medis.pdf
```

Expected output:
```json
{
  "vital_signs": {
    "SpO2": { "value": "95", "confidence": "high" },
    "HeartRate": { "value": "77", "confidence": "high" },
    "RespiratoryRate": { "value": "18", "confidence": "high" }
  },
  "clinical_findings": ["Ronchi", "Whezing"],
  "validation": {
    "SpO2": { "valid": true },
    "HeartRate": { "valid": true }
  }
}
```

## Rollout Plan

### Phase 1: Testing (Week 1)
- Unit tests semua pattern + regex
- Manual testing dengan 5 sample dokumen
- Verify no regressions di standard OCR flow

### Phase 2: Staging (Week 2)
- Deploy ke staging dengan `OCR_ENHANCEMENT_ENABLED=true`
- Monitor processing time + memory usage
- Collect feedback dari verifikator

### Phase 3: Production (Week 3)
- Gradual rollout:
  - Day 1: 10% traffic
  - Day 2-3: 50% traffic
  - Day 4+: 100% traffic
- Kill switch: Set `OCR_ENHANCEMENT_ENABLED=false` jika ada issue

## Success Metrics

- **Vital Signs Detection Rate**: >95% untuk dokumen yang PUNYA vital signs tertulis
- **Clinical Findings Detection**: >90% untuk pemeriksaan fisik positif
- **False Positives**: <5% (validation catches most)
- **Processing Time Impact**: <20% slowdown acceptable
- **User Satisfaction**: Verifikator report fewer missing vital signs

## Known Limitations

1. **Handwritten notes**: OCR masih struggle dengan handwriting, validation error messages akan membantu
2. **Non-standard formatting**: Regex patterns optimized untuk format standard SIMRS output
3. **Multiple pages**: Enhancement runs on ALL pages, consider limiting untuk very large documents (>20 pages)
4. **Language variants**: Patterns untuk Indonesian — limited support untuk English/mix

## Future Enhancements

- [ ] Machine learning model untuk clinical finding detection (vs regex)
- [ ] Support untuk lebih banyak clinical parameters (lab values, etc)
- [ ] Adaptive resolution (high-detail hanya untuk tertentu pages)
- [ ] Caching OCR results untuk repeated processing
- [ ] Integration dengan EHR system untuk cross-validation

## References

- Original issues: eClaim GitHub Issues #45, #67
- Testing sample: `data/test-docs/firdan-resume-medis-igd.pdf`
- Related: `src/services/notasiMedisParser.js` untuk parsing clinical notation

---

**Implementation Date**: 18 Sep 2026  
**Author**: Claude Haiku 4.5  
**Status**: Ready for testing
