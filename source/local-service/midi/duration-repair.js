export class DurationRepair {
  constructor({ store, probeVideoDurationUs, concurrency = 2 }) {
    if (!store) throw new TypeError("DurationRepair requires a store");
    if (typeof probeVideoDurationUs !== "function")
      throw new TypeError("DurationRepair requires a video duration probe");
    this.store = store;
    this.probeVideoDurationUs = probeVideoDurationUs;
    this.concurrency = Math.max(1, Math.trunc(concurrency));
    this.current = {
      state: "idle",
      total: 0,
      completed: 0,
      failed: 0,
      lastError: null,
    };
    this.runningPromise = null;
  }

  status() {
    return { ...this.current };
  }

  start() {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.#run().finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  async #run() {
    const songs = this.store.listUserSongsMissingDuration();
    this.current = {
      state: "running",
      total: songs.length,
      completed: 0,
      failed: 0,
      lastError: null,
    };
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < songs.length) {
        const song = songs[nextIndex];
        nextIndex += 1;
        try {
          const path = this.store.resolvePath(song.videoPath);
          const durationUs = await this.probeVideoDurationUs(path);
          this.store.updateUserSongDuration(song.id, durationUs);
          this.current.completed += 1;
        } catch (error) {
          this.current.failed += 1;
          this.current.lastError = error instanceof Error ? error.message : String(error);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.concurrency, Math.max(1, songs.length)) },
      () => worker(),
    ));
    this.current.state = this.current.failed ? "complete_with_errors" : "complete";
    return this.status();
  }
}
