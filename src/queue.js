/**
 * queue.js – FIFO async queue with configurable concurrency.
 * Used by the proxy to serialize Anthropic API requests.
 */

export class AsyncQueue {
  constructor(maxConcurrency = 1) {
    this.maxConcurrency = maxConcurrency;
    this._running = 0;
    this._queue   = [];
  }

  get length() { return this._queue.length; }

  /**
   * Enqueue a task function () => Promise.
   * Returns a Promise that resolves/rejects when the task completes.
   */
  push(task) {
    return new Promise((resolve, reject) => {
      this._queue.push({ task, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._running < this.maxConcurrency && this._queue.length > 0) {
      const { task, resolve, reject } = this._queue.shift();
      this._running++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          this._running--;
          this._drain();
        });
    }
  }
}
