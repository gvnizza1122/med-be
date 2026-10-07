/**
 * Pool worker_threads generik — beda fundamental dari semaphore Promise biasa
 * (lihat riwayat perbaikan gagal di ocrService.js/pdfPageClassifier.js
 * sebelumnya): worker_threads jalan di THREAD OS TERPISAH, jadi kerja CPU
 * sinkron di dalamnya (pdf-parse, mupdf) TIDAK memblokir event-loop utama
 * Node.js — beda dengan Promise.all/semaphore yang cuma mengatur urutan
 * eksekusi tapi tetap satu thread yang sama. Ini akar masalah kenapa 2 fix
 * sebelumnya (OCR_JOB_CONCURRENCY, CLASSIFY_JOB_CONCURRENCY) terbukti gagal
 * di testing production 26 Aug 2026 — keduanya tidak memindahkan kerja CPU
 * ke thread lain, cuma mengatur giliran di thread yang sama.
 */
const { Worker } = require('worker_threads');

function createWorkerPool(workerScriptPath, poolSize, options = {}) {
  const size = Number.isFinite(Number(poolSize)) ? Math.max(1, Math.floor(Number(poolSize))) : 1;
  const timeoutMs = Number(options.taskTimeoutMs) > 0 ? Number(options.taskTimeoutMs) : 600000;
  const idle = [], waitingTasks = [], workers = new Set(), pending = new Map();
  let nextTaskId = 1, closing = false;

  function settle(taskId, error, result) {
    const entry = pending.get(taskId);
    if (!entry) return;
    pending.delete(taskId);
    clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(result);
  }

  function failed(worker, error) {
    if (!workers.delete(worker)) return; // error dan exit bisa muncul untuk worker yang sama.
    const index = idle.indexOf(worker);
    if (index !== -1) idle.splice(index, 1);
    for (const [id, entry] of pending) if (entry.worker === worker) settle(id, error);
    worker.terminate().catch(() => {});
    if (!closing && waitingTasks.length) fill();
  }

  function makeWorker() {
    const worker = new Worker(workerScriptPath);
    workers.add(worker);
    worker.on('message', (msg) => {
      const entry = msg && pending.get(msg.taskId);
      if (!entry || entry.worker !== worker) return;
      settle(msg.taskId, msg.error ? new Error(msg.error) : null, msg.result);
      checkin(worker);
    });
    worker.on('error', (error) => failed(worker, error));
    worker.on('exit', (code) => failed(worker, new Error(`Pembaca PDF berhenti sebelum selesai (exit ${code}).`)));
    return worker;
  }

  function checkin(worker) {
    if (closing || !workers.has(worker)) return;
    const next = waitingTasks.shift();
    if (next) dispatch(worker, next); else { worker.unref(); idle.push(worker); }
  }

  function dispatch(worker, task) {
    worker.ref();
    const timer = setTimeout(() => failed(worker, new Error('Pembacaan PDF melewati batas waktu; file perlu dicoba kembali.')), timeoutMs);
    timer.unref?.();
    pending.set(task.taskId, { ...task, worker, timer });
    try { worker.postMessage({ taskId: task.taskId, payload: task.payload }); }
    catch (error) { settle(task.taskId, error); checkin(worker); }
  }

  function fill() {
    while (!closing && waitingTasks.length && (idle.length || workers.size < size)) {
      let worker;
      try { worker = idle.pop() || makeWorker(); }
      catch (error) {
        // Jalur worker tidak sah: seluruh antrean harus mendapat hasil gagal, bukan menggantung.
        for (const task of waitingTasks.splice(0)) task.reject(error);
        return;
      }
      dispatch(worker, waitingTasks.shift());
    }
  }

  // Worker disiapkan sesuai kebutuhan; tidak melakukan loop respawn saat worker gagal saat startup.
  function run(payload) {
    return new Promise((resolve, reject) => {
      if (closing) return reject(new Error('Antrean pembaca PDF sudah ditutup.'));
      waitingTasks.push({ taskId: nextTaskId++, payload, resolve, reject });
      fill();
    });
  }

  async function shutdown() {
    closing = true;
    const error = new Error('Antrean pembaca PDF ditutup sebelum pemrosesan selesai.');
    for (const task of waitingTasks.splice(0)) task.reject(error);
    for (const id of [...pending.keys()]) settle(id, error);
    const all = [...workers];
    workers.clear(); idle.length = 0;
    await Promise.all(all.map(worker => worker.terminate().catch(() => {})));
  }

  return { run, shutdown };
}

module.exports = { createWorkerPool };
