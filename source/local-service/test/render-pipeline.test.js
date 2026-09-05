import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { MidiRenderPipeline } from "../midi/render-pipeline.js";
import { runProcess } from "../midi/process-runner.js";
import { MidiStore } from "../midi/store.js";
import { endOfTrack, midiFile, noteOff, noteOn, track } from "./fixtures/midi-fixtures.js";

async function pipelineFixture(runOverride) {
  const root = await mkdtemp(join(tmpdir(), "olivia-render-pipeline-"));
  const db = new DatabaseSync(join(root, "test.sqlite"));
  const store = new MidiStore({ db, root });
  const inputPath = join(root, "inputs", "fixture.mid");
  await mkdir(join(root, "inputs"), { recursive: true });
  const input = midiFile({ tracks: [track(noteOn(0, 60, 90), noteOff(480, 60), endOfTrack())] });
  await writeFile(inputPath, input);
  const token = store.createUploadToken({ originalFilename: "unsafe $(title).mid" });
  store.consumeUploadToken(token.token, {
    inputPath,
    sha256: "a".repeat(64),
    sizeBytes: input.length,
  });
  const job = store.createJob({ uploadKey: token.key, title: "unsafe $(title)" });
  const calls = [];
  const fakeRun = runOverride ?? (async (command, args) => {
    calls.push({ command, args });
    if (command === "fluidsynth") await writeFile(args[args.indexOf("-F") + 1], "wav");
    if (command === "godot") await writeFile(args[args.indexOf("--write-movie") + 1], "avi");
    if (command === "ffmpeg") await writeFile(args.at(-1), "mp4");
    if (command === "ffprobe") {
      return {
        stdout: JSON.stringify({
          streams: [
            { codec_type: "video", codec_name: "h264" },
            { codec_type: "audio", codec_name: "aac" },
          ],
          format: { duration: "0.500000" },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
  const pipeline = new MidiRenderPipeline({
    store,
    runProcess: fakeRun,
    commands: { fluidsynth: "fluidsynth", godot: "godot", ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
    soundFont: join(root, "soundfonts", "MuseScore_General.sf3"),
    godotProject: join(root, "godot"),
  });
  return {
    root,
    db,
    store,
    job,
    calls,
    pipeline,
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("MIDI render pipeline runs deterministic stages and registers My Upload", async () => {
  const ctx = await pipelineFixture();
  try {
    const completed = await ctx.pipeline.render(ctx.job.id);

    assert.equal(completed.state, "completed");
    assert.equal(completed.progress, 100);
    assert.deepEqual(ctx.calls.map(call => call.command), ["fluidsynth", "godot", "ffmpeg", "ffprobe"]);
    assert.equal(ctx.calls[1].args.includes("--headless"), false, "Movie Maker must retain a real rendering driver");
    assert.ok(ctx.calls[1].args.includes("--write-movie"));
    assert.ok(ctx.calls[1].args.includes("unsafe $(title)"), "title remains one literal process argument");
    assert.equal(ctx.store.listUserSongs()[0].name, "unsafe $(title)");
    assert.equal(ctx.store.listUserSongs()[0].jobId, ctx.job.id);
    assert.equal(await readFile(ctx.store.resolvePath(completed.videoPath), "utf8"), "mp4");
    await assert.rejects(access(join(ctx.root, "jobs", ctx.job.id, "raw.avi")));

    const timeline = JSON.parse(await readFile(ctx.store.resolvePath(completed.timelinePath), "utf8"));
    assert.equal(timeline.notes.length, 1);
    assert.equal(timeline.durationUs, 500_000);
  } finally {
    await ctx.close();
  }
});

test("MIDI render pipeline marks external failures and removes partial output", async () => {
  let root;
  const calls = [];
  const ctx = await pipelineFixture(async (command, args) => {
    calls.push(command);
    if (command === "fluidsynth") await writeFile(args[args.indexOf("-F") + 1], "wav");
    if (command === "godot") await writeFile(args[args.indexOf("--write-movie") + 1], "avi");
    if (command === "ffmpeg") {
      root = args.at(-1);
      await writeFile(root, "partial");
      throw Object.assign(new Error("encoder failed"), { code: "PROCESS_EXIT_FAILED" });
    }
    return { stdout: "", stderr: "" };
  });
  try {
    await assert.rejects(ctx.pipeline.render(ctx.job.id), /encoder failed/u);
    const failed = ctx.store.getJob(ctx.job.id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /encoder failed/u);
    await assert.rejects(access(root));
    assert.deepEqual(calls, ["fluidsynth", "godot", "ffmpeg"]);
  } finally {
    await ctx.close();
  }
});

test("process runner uses argument arrays, captures output, and supports timeout and abort", async () => {
  const success = await runProcess(process.execPath, ["-e", "console.log(process.argv[1])", "literal $(value)"], {
    timeoutMs: 5_000,
  });
  assert.equal(success.stdout.trim(), "literal $(value)");

  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }),
    { code: "PROCESS_TIMEOUT" },
  );

  const controller = new AbortController();
  const pending = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "PROCESS_ABORTED" });
});
