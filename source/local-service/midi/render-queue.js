export class MidiRenderQueue {
  constructor({ pipeline, onError = error => console.error(`[midi-render-error] ${error.message}`) }) {
    if (!pipeline) throw new TypeError("MidiRenderQueue requires a render pipeline");
    this.pipeline = pipeline;
    this.onError = onError;
    this.pending = [];
    this.pendingIds = new Set();
    this.active = null;
    this.closed = false;
    this.drainPromise = null;
    this.idleWaiters = [];
  }

  get pendingCount() {
    return this.pending.length;
  }

  enqueue(id) {
    if (this.closed) throw new Error("MIDI render queue is closed");
    if (this.pendingIds.has(id) || this.active?.id === id) return false;
    this.pending.push(id);
    this.pendingIds.add(id);
    queueMicrotask(() => this.#startDrain());
    return true;
  }

  cancel(id) {
    if (this.active?.id === id) {
      this.active.controller.abort();
      return true;
    }
    if (!this.pendingIds.has(id)) return false;
    this.pending = this.pending.filter(value => value !== id);
    this.pendingIds.delete(id);
    this.#notifyIdle();
    return true;
  }

  #startDrain() {
    if (this.drainPromise || this.closed) return;
    this.drainPromise = this.#drain().finally(() => {
      this.drainPromise = null;
      this.#notifyIdle();
      if (!this.closed && this.pending.length) this.#startDrain();
    });
  }

  async #drain() {
    while (!this.closed && this.pending.length) {
      const id = this.pending.shift();
      this.pendingIds.delete(id);
      const controller = new AbortController();
      this.active = { id, controller };
      try {
        await this.pipeline.render(id, { signal: controller.signal });
      } catch (error) {
        this.onError(error, id);
      } finally {
        this.active = null;
      }
    }
  }

  #notifyIdle() {
    if (this.active || this.pending.length || this.drainPromise) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  waitForIdle() {
    if (!this.active && !this.pending.length && !this.drainPromise) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.pendingIds.clear();
    this.active?.controller.abort();
    await this.drainPromise;
    this.#notifyIdle();
  }
}

