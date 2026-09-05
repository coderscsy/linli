import assert from "node:assert/strict";
import test from "node:test";

import { MidiRenderQueue } from "../midi/render-queue.js";

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

test("MIDI render queue processes jobs one at a time and deduplicates pending IDs", async () => {
  let active = 0;
  let maximum = 0;
  const rendered = [];
  const pipeline = {
    async render(id) {
      active += 1;
      maximum = Math.max(maximum, active);
      rendered.push(id);
      await delay(20);
      active -= 1;
    },
  };
  const queue = new MidiRenderQueue({ pipeline });

  queue.enqueue("one");
  queue.enqueue("two");
  queue.enqueue("two");
  await queue.waitForIdle();

  assert.equal(maximum, 1);
  assert.deepEqual(rendered, ["one", "two"]);
});

test("MIDI render queue aborts its active job and closes without starting pending work", async () => {
  const events = [];
  const pipeline = {
    render(id, { signal }) {
      events.push(`start:${id}`);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push(`abort:${id}`);
          reject(Object.assign(new Error("cancelled"), { code: "PROCESS_ABORTED" }));
        }, { once: true });
      });
    },
  };
  const queue = new MidiRenderQueue({ pipeline });

  queue.enqueue("one");
  queue.enqueue("two");
  await delay(10);
  await queue.close();

  assert.deepEqual(events, ["start:one", "abort:one"]);
  assert.equal(queue.pendingCount, 0);
});

