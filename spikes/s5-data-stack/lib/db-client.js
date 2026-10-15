'use strict';
// Promise-based RPC wrapper around the data worker, as the main process would use it.
// Timestamps are taken with performance.now() on the calling side, so `call()` can report round-trip time.

const { Worker } = require('node:worker_threads');
const path = require('node:path');

class DbClient {
  /**
   * @param {{driver?: string, workerPath?: string}} [opts]
   */
  constructor({ driver = 'better-sqlite3', workerPath = path.join(__dirname, '..', 'db-worker.js') } = {}) {
    this.pending = new Map();
    this.nextId = 1;
    this.events = [];
    this.exited = null; // exit code once the worker has exited
    this.worker = new Worker(workerPath, { workerData: { driver } });
    this.ready = new Promise((resolve, reject) => {
      this.onReady = resolve;
      this.onStartError = reject;
    });
    this.worker.on('message', (msg) => {
      if (msg.event === 'ready') this.onReady(msg);
      else if (msg.event) {
        this.events.push(msg);
        this.pending.get(msg.id)?.onEvent?.(msg);
      } else {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      }
    });
    this.worker.on('error', (err) => {
      this.onStartError(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.exitPromise = new Promise((resolve) => {
      this.worker.on('exit', (code) => {
        this.exited = code;
        const err = new Error(`worker exited (code ${code}) with the request in flight`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        resolve(code);
      });
    });
  }

  /** Calls a worker op; resolves with the result. Pass `{ onEvent }` in `extra` to observe 'started' events. */
  call(op, args = {}, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, onEvent: extra.onEvent });
      this.worker.postMessage({ id, op, args });
    });
  }

  /** Same as call(), but also returns the main-side round-trip time in ms. */
  async timed(op, args = {}) {
    const t0 = performance.now();
    const result = await this.call(op, args);
    return { result, rttMs: performance.now() - t0 };
  }

  async close() {
    if (this.exited !== null) return this.exited;
    await this.call('close');
    return this.exitPromise;
  }

  terminate() {
    return this.worker.terminate();
  }
}

module.exports = { DbClient };
