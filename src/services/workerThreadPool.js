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
const path = require('path');

function createWorkerPool(workerScriptPath, poolSize) {
  const size = Math.max(1, poolSize);
  const idle = [];
  const waitingTasks = [];
  let nextTaskId = 1;
  const pending = new Map(); // taskId -> {resolve, reject}

  function makeWorker() {
    const worker = new Worker(workerScriptPath);
    worker.on('message', (msg) => {
      const entry = pending.get(msg.taskId);
      if (!entry) return;
      pending.delete(msg.taskId);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
      checkin(worker);
    });
    worker.on('error', (err) => {
      // Worker crash: tolak semua task yang sedang dipegangnya, buat worker
      // pengganti supaya pool tidak menyusut permanen.
      for (const [taskId, entry] of pending) {
        if (entry.worker === worker) {
          pending.delete(taskId);
          entry.reject(err);
        }
      }
      replaceWorker(worker);
    });
    return worker;
  }

  function replaceWorker(oldWorker) {
    const idx = idle.indexOf(oldWorker);
    if (idx !== -1) idle.splice(idx, 1);
    const fresh = makeWorker();
    checkin(fresh);
  }

  function checkin(worker) {
    const next = waitingTasks.shift();
    if (next) {
      dispatch(worker, next);
    } else {
      idle.push(worker);
    }
  }

  function dispatch(worker, task) {
    pending.set(task.taskId, { resolve: task.resolve, reject: task.reject, worker });
    worker.postMessage({ taskId: task.taskId, payload: task.payload });
  }

  for (let i = 0; i < size; i++) idle.push(makeWorker());

  function run(payload) {
    return new Promise((resolve, reject) => {
      const task = { taskId: nextTaskId++, payload, resolve, reject };
      const worker = idle.pop();
      if (worker) dispatch(worker, task);
      else waitingTasks.push(task);
    });
  }

  async function shutdown() {
    const all = new Set(idle);
    for (const entry of pending.values()) all.add(entry.worker);
    await Promise.all([...all].map((w) => w.terminate().catch(() => {})));
  }

  return { run, shutdown };
}

module.exports = { createWorkerPool };
