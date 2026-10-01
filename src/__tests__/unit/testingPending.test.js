const { prediksi, nilaiRingkasan, validasiInput } = require('../../services/testingPendingService');
test('sign kombinasi kode Munawir tetap pending tanpa mengubah klaim', () => {
  const record = { diagnosa_list: 'J44.9;J18.9', prosedur_list: '93.94', validation_status: 'valid', raw_data: '{}', ai_review: '{}' };
  const awal = JSON.stringify(record);
  const snapshot = prediksi(record);
  expect(snapshot.status).toBe('pending');
  expect(snapshot.alasan.some(a => a.kode === 'KMB-12')).toBe(true);
  expect(snapshot.diagnosa_list).toBe('J44.9;J18.9');
  expect(JSON.stringify(record)).toBe(awal);
});
test('data valid tanpa analisis belum dianggap prediksi tidak pending', () => {
  expect(prediksi({ validation_status: 'valid' }).status).toBe('belum_pasti');
  expect(prediksi({ validation_status: 'error' }).status).toBe('belum_pasti');
  expect(prediksi({ validation_status: 'pending' }).status).toBe('pending');
});
test('model yang masih meminta pemeriksaan tidak dipaksa menjadi benar/salah', () => {
  expect(prediksi({ validation_status: 'valid', ai_review: JSON.stringify({ putusan_pending: { status: 'perlu_dicek', alasan: [{ kode: 'TEST', keparahan: 'sedang', ringkas: 'Periksa bukti' }] } }) }).status).toBe('belum_pasti');
});
test('mengukur false negative, false positive dan kecocokan alasan pada pasangan yang dinilai', () => {
  const rows = [
    { prediction: 'pending', actual_result: 'pending', reason_match: 'sesuai' },
    { prediction: 'pending', actual_result: 'pending', reason_match: 'sebagian' },
    { prediction: 'tidak_pending', actual_result: 'diterima', reason_match: 'belum_dinilai' },
    { prediction: 'tidak_pending', actual_result: 'pending', reason_match: 'tidak_sesuai' },
    { prediction: 'pending', actual_result: 'diterima', reason_match: 'sesuai' },
    { prediction: 'belum_pasti', actual_result: 'pending', reason_match: 'sesuai' },
    { prediction: 'pending', actual_result: 'belum_diketahui', reason_match: 'sesuai' },
  ];
  const n = nilaiRingkasan(rows);
  expect(n).toMatchObject({ evaluated: 5, labeled: 6, uncertain: 1, correct: 3, missed_pending: 1, false_alarm: 1, true_pending: 2, true_clear: 1, accuracy: 60, reason_rated: 2, reason_accuracy: 50, reason_partial: 1 });
  expect(n.pending_recall).toBeCloseTo(2/3*100);
  expect(nilaiRingkasan([])).toMatchObject({ accuracy: null, pending_recall: null, reason_accuracy: null });
});
test('validasi nilai acuan dan panjang catatan; alasan tidak dinilai jika acuan tidak pending', () => {
  const input = { actual_result: 'diterima', reference_source: 'BPJS', reason_match: 'sesuai' };
  expect(validasiInput(input).reason_match).toBe('belum_dinilai');
  expect(() => validasiInput({ ...input, reference_source: 'TEBAKAN' })).toThrow('Pilih hasil acuan');
  expect(() => validasiInput({ ...input, notes: 'x'.repeat(4001) })).toThrow('4.000');
  expect(() => validasiInput({ ...input, actual_reason: {} })).toThrow('4.000');
});
