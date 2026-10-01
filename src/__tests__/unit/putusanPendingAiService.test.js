const { bentukPutusan, putuskanDenganAi } = require('../../services/putusanPendingAiService');

const kandidat = {
  status: 'berisiko_pending',
  ringkasan: 'Ada kandidat awal.',
  catatan_keandalan: 'Belum terukur.',
  alasan: [
    { ringkas: 'Kandidat A', keparahan: 'tinggi', bukti: 'kutipan A', dari_rekap_pending: true },
    { ringkas: 'Kandidat B', keparahan: 'sedang', bukti: 'kutipan B', dari_rekap_pending: false },
  ],
  jumlah: { total: 2, berat: 1, dari_rekap_pending: 1 },
};

describe('putusanPendingAiService', () => {
  test('status dan alasan final hanya dipilih AI dari kandidat yang telah tersedia', () => {
    const hasil = bentukPutusan(kandidat, {
      status: 'perlu_dicek',
      alasan_ids: ['kandidat-2'],
    }, { model: 'model-uji', penyedia: 'openai_compat' });

    expect(hasil.ok).toBe(true);
    expect(hasil.putusan.status).toBe('perlu_dicek');
    expect(hasil.putusan.alasan).toEqual([kandidat.alasan[1]]);
    expect(hasil.putusan.sumber_keputusan).toBe('ai');
    expect(hasil.putusan.model).toBe('model-uji');
    expect(hasil.putusan.alasan[0].bukti).toBe('kutipan B');
  });

  test('menolak alasan yang dikarang atau putusan risiko tanpa kandidat alasan', () => {
    expect(bentukPutusan(kandidat, {
      status: 'berisiko_pending', alasan_ids: ['alasan-baru'],
    }).ok).toBe(false);
    expect(bentukPutusan(kandidat, {
      status: 'berisiko_pending', alasan_ids: [],
    }).ok).toBe(false);
  });

  test('panggilan memakai gateway, tugas putuskan_pending, JSON, dan identitas dikenal untuk masking', async () => {
    const panggilModel = jest.fn().mockResolvedValue({
      ok: true,
      hasil: { status: 'berisiko_pending', alasan_ids: ['kandidat-1'] },
      model: 'model-uji', penyedia: 'openai_compat', penggunaan: { total_tokens: 9 },
    });
    const hasil = await putuskanDenganAi(kandidat, {
      dikenal: { nama: 'SUMIDAH', sep: 'SEP-UJI' },
      db: { id: 'db' },
      gateway: { panggilModel },
    });

    expect(hasil.ok).toBe(true);
    expect(hasil.putusan.status).toBe('berisiko_pending');
    expect(panggilModel).toHaveBeenCalledWith('putuskan_pending', expect.objectContaining({
      json: true,
      dikenal: { nama: 'SUMIDAH', sep: 'SEP-UJI' },
    }), { db: { id: 'db' } });
  });
  test('bukti tinjauan multi diagnosis menjadi konteks putusan tanpa membuat atau menulis ulang alasan', async () => {
    const tinjauanDiagnosis = { versi: 1, status: 'perlu_klarifikasi', ringkasan: 'Dua diagnosis didukung; urutan utama perlu klarifikasi.',
      kandidat: [{ kode: 'J44.9', status: 'didukung', alasan: 'Diagnosis pada resume dan riwayat sesak.', bukti: [{ halaman: 2, kutipan: 'PPOK' }] },
        { kode: 'J18.9', status: 'didukung', alasan: 'Diagnosis pada resume.', bukti: [{ halaman: 2, kutipan: 'Pneumonia' }] }], klarifikasi: ['Periksa diagnosis utama.'] };
    const panggilModel = jest.fn(async () => ({ ok: true, hasil: { status: 'perlu_dicek', alasan_ids: ['kandidat-2'] } }));
    const hasil = await putuskanDenganAi(kandidat, { tinjauanDiagnosis, gateway: { panggilModel } });
    const payload = panggilModel.mock.calls[0][1];
    expect(payload.prompt).toContain('TINJAUAN_DIAGNOSIS_TERVERIFIKASI');
    expect(payload.prompt).toContain('PPOK');
    expect(payload.prompt).toContain('Pneumonia');
    expect(payload.system).toContain('Jumlah diagnosis saja bukan alasan pending');
    expect(hasil.putusan.alasan).toEqual([kandidat.alasan[1]]);
  });
  test('kegagalan tinjauan tidak dijadikan bukti keputusan pending', async () => {
    const panggilModel = jest.fn(async () => ({ ok: true, hasil: { status: 'perlu_dicek', alasan_ids: ['kandidat-2'] } }));
    await putuskanDenganAi(kandidat, { tinjauanDiagnosis: { versi: 1, status: 'belum_dinilai', ringkasan: 'Bukti rekaan' }, gateway: { panggilModel } });
    expect(panggilModel.mock.calls[0][1].prompt).not.toContain('Bukti rekaan');
  });
});
