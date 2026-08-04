const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolvePdfPath } = require('../../routes/claimFiles');

describe('resolvePdfPath', () => {
  test('returns null when file_path is missing or empty', () => {
    expect(resolvePdfPath(undefined)).toBeNull();
    expect(resolvePdfPath(null)).toBeNull();
    expect(resolvePdfPath({})).toBeNull();
    expect(resolvePdfPath({ file_path: null })).toBeNull();
    expect(resolvePdfPath({ file_path: '' })).toBeNull();
  });

  test('returns null when extension is not .pdf', () => {
    expect(resolvePdfPath({ file_path: './uploads/claim.txt' })).toBeNull();
    expect(resolvePdfPath({ file_path: './uploads/claim.pdf.backup' })).toBeNull();
  });

  test('returns null when file does not exist on disk', () => {
    expect(resolvePdfPath({ file_path: './uploads/does-not-exist.pdf' })).toBeNull();
  });

  test('returns resolved absolute path for an existing .pdf (extension case-insensitive)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclaim-pdf-test-'));
    const pdfPath = path.join(tmpDir, 'sample.PDF');
    fs.writeFileSync(pdfPath, '%PDF-1.4 dummy');
    try {
      expect(resolvePdfPath({ file_path: pdfPath })).toBe(path.resolve(process.cwd(), pdfPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
