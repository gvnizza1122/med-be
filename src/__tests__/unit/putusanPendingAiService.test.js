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
});
