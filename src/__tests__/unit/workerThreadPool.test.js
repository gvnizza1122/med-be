const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkerPool } = require('../../services/workerThreadPool');
let directory, script, pools;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eclaim-pool-'));
  script = path.join(directory, 'worker.cjs');
  fs.writeFileSync(script, `const { parentPort } = require('worker_threads');
    parentPort.on('message', ({ taskId, payload }) => {
      if (payload === 'exit') process.exit(0);
      if (payload === 'crash') throw new Error('crash acuan');
      if (payload === 'hang') return;
      parentPort.postMessage({ taskId, result: payload });
    });`);
});
beforeEach(() => { pools = []; });
afterEach(async () => { await Promise.all(pools.map(p => p.shutdown())); });
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
function pool(size = 1, timeout = 2000) {
  const p = createWorkerPool(script, size, { taskTimeoutMs: timeout }); pools.push(p); return p;
}
test('batch antrean selesai seluruhnya dengan urutan hasil sesuai file', async () => {
  const p = pool(2);
  expect(await Promise.all(Array.from({ length: 30 }, (_, i) => p.run(i)))).toEqual(Array.from({ length: 30 }, (_, i) => i));
});
test.each(['exit', 'crash'])('worker %s menolak file aktif dan melanjutkan file berikutnya', async event => {
  const p = pool();
  const first = expect(p.run(event)).rejects.toThrow();
  const second = p.run('berikutnya');
  await first; await expect(second).resolves.toBe('berikutnya');
});
test('batas waktu menutup pembaca yang macet dan melanjutkan antrean', async () => {
  const p = pool(1, 400);
  const first = expect(p.run('hang')).rejects.toThrow(/batas waktu/);
  const second = p.run('berikutnya');
  await first; await expect(second).resolves.toBe('berikutnya');
});
test('muatan tidak bisa dikirim tidak meninggalkan tugas menggantung', async () => {
  const p = pool();
  await expect(p.run(() => {})).rejects.toThrow();
  await expect(p.run('valid')).resolves.toBe('valid');
});
test('shutdown menolak tugas aktif dan antrean serta tidak menyalakan worker baru', async () => {
  const p = pool();
  const a = expect(p.run('hang')).rejects.toThrow(/ditutup/);
  const b = expect(p.run('menunggu')).rejects.toThrow(/ditutup/);
  await p.shutdown(); await Promise.all([a, b]);
  await expect(p.run('baru')).rejects.toThrow(/ditutup/);
});
test('ukuran pool tidak sah tetap memiliki satu pembaca', async () => {
  await expect(pool(NaN).run('selesai')).resolves.toBe('selesai');
});
