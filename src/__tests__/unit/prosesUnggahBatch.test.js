test('antrean baru ditolak bila status hanya dapat disimpan di memori', async () => {
  let service;
  jest.isolateModules(() => { service = require('../../services/prosesUnggahService'); });
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const db = { query: async () => { throw Error('Tidak ada akses tabel'); }, transaction: jest.fn() };
  try {
    await expect(service.buatBatch(db, { batchId: 'b', hospitalCode: 'TEST', userId: 'u',
      files: [{ path: '/tmp/test.pdf', originalname: 'test.pdf' }], allowedJenisKlaim: ['RAWAT_INAP'] }))
      .rejects.toMatchObject({ code: 'ANTREAN_TIDAK_TERSEDIA' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(service._memori.size).toBe(0);
  } finally { warning.mockRestore(); }
});
