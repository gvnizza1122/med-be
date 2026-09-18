const { aggregateKriteria } = require('../../services/kegawatdaruratanAggregation');

const emptyVitals = {};

describe('aggregateKriteria — K5 (fix item 5: YA/BORDERLINE/TIDAK)', () => {
  test('kode PROCLIST resmi ditemukan -> YA (perilaku lama TIDAK berubah)', () => {
    const kriteria = aggregateKriteria([], emptyVitals, null, ['99.60'], [], null);
    const k5 = kriteria.find(k => k.kriteria === 'K5');
    expect(k5.status).toBe('ya');
    expect(k5.evidence.some(e => e.sumber === 'proclist' && e.kode === '99.60')).toBe(true);
  });

  test('PROCLIST kosong TAPI tindakan segera teks bebas ditemukan -> BORDERLINE (default rules)', () => {
    const tindakanSegera = [{ id: 'resusitasi_cairan_iv', label: 'Resusitasi cairan IV (loading/bolus/guyur)', page_number: 3, kutipan: 'IVFD asering loading 250cc lanjut 20tpm' }];
    const kriteria = aggregateKriteria([], emptyVitals, null, ['88.78', '90.59'], tindakanSegera, null);
    const k5 = kriteria.find(k => k.kriteria === 'K5');
    expect(k5.status).toBe('borderline');
    expect(k5.evidence.some(e => e.sumber === 'tindakan_segera' && e.kutipan.includes('IVFD asering loading 250cc lanjut 20tpm'))).toBe(true);
    expect(k5.catatan).toMatch(/BORDERLINE/);
  });

  test('PROCLIST kosong DAN tidak ada tindakan segera -> TIDAK', () => {
    const kriteria = aggregateKriteria([], emptyVitals, null, ['88.78', '90.59'], [], null);
    const k5 = kriteria.find(k => k.kriteria === 'K5');
    expect(k5.status).toBe('tidak');
  });

  test('skor ESI ditampilkan sebagai sinyal pendukung, TIDAK mengubah status K5 otomatis', () => {
    const esi = { skor: 2, page_number: 3, kutipan: 'ESI: 2' };
    const kriteria = aggregateKriteria([], emptyVitals, null, [], [], esi);
    const k5 = kriteria.find(k => k.kriteria === 'K5');
    expect(k5.status).toBe('tidak'); // tidak ada PROCLIST/tindakan sama sekali -- ESI saja tidak cukup
    const esiEvidence = k5.evidence.find(e => e.sumber === 'esi');
    expect(esiEvidence).toBeDefined();
    expect(esiEvidence.skor).toBe(2);
    expect(k5.catatan).toContain('ESI');
  });

  test('PROCLIST match SEKALIGUS tindakan segera -> tetap YA (PROCLIST prioritas), evidence gabungan', () => {
    const tindakanSegera = [{ id: 'oksigenasi_segera', label: 'Pemberian oksigen segera', page_number: 3, kutipan: 'Oksigen 3 lpm nasal kanul' }];
    const kriteria = aggregateKriteria([], emptyVitals, null, ['99.60'], tindakanSegera, null);
    const k5 = kriteria.find(k => k.kriteria === 'K5');
    expect(k5.status).toBe('ya');
    expect(k5.evidence.some(e => e.sumber === 'proclist')).toBe(true);
    expect(k5.evidence.some(e => e.sumber === 'tindakan_segera')).toBe(true);
  });
});
