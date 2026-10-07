/** Batas pada pesan penolakan harus mengikuti endpoint yang menerima berkas. */
function uploadLimitError(error, req, res, next) {
  const route = (req.originalUrl || req.path || '').split('?')[0];
  const batchPdf = /\/claim-files\/upload-pdf-(?:antre|batch)$/.test(route);
  if (error.code === 'LIMIT_FILE_SIZE') {
    const maxMb = batchPdf ? 70 : route.includes('/upload-pdf') ? 20 : route.includes('/upload-batch') ? 50 : 10;
    return res.status(400).json({ error: `File terlalu besar. Maksimum ${maxMb}MB.` });
  }
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    const jumlah = batchPdf ? 300 : 10;
    return res.status(400).json({ error: `Jumlah berkas melebihi batas atau nama kolom berkas tidak sesuai. Kirim maksimal ${jumlah} berkas per permintaan.` });
  }
  next(error);
}

module.exports = uploadLimitError;
