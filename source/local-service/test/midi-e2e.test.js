import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { blockedFetchPorts } from "./fixtures/fetch-ports.js";

import { createOliviaService } from "../server.js";
import { endOfTrack, midiFile, noteOff, noteOn, track } from "./fixtures/midi-fixtures.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.OLIVIA_MIDI_E2E === "1";
const runtimeRoot = "I:\\OliviaSoulData\\MidiRenderer";
async function listen(service) {
  let address = await service.listen(0);
  while (blockedFetchPorts.has(address.port)) {
    await new Promise(resolveClose => service.server.close(resolveClose));
    address = await service.listen(0);
  }
  return `http://127.0.0.1:${address.port}`;
}

async function json(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  return { status: response.status, body: await response.json() };
}

test("real local MIDI pipeline survives restart and can become a video reply", { skip: !enabled }, async t => {
  await mkdir("I:\\CodexTemp", { recursive: true });
  const root = await mkdtemp("I:\\CodexTemp\\olivia-midi-e2e-");
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const midiDataRoot = join(root, "MidiRenderer");
  const ffmpeg = join(runtimeRoot, "runtime", "ffmpeg", "bin", "ffmpeg.exe");
  const ffprobe = join(runtimeRoot, "runtime", "ffmpeg", "bin", "ffprobe.exe");
  const serviceOptions = {
    root: workspace,
    dataDir,
    appData: join(root, "appdata"),
    midiDataRoot,
    worker: false,
    runMemoryRefresh: false,
    midiCommands: {
      fluidsynth: join(runtimeRoot, "runtime", "fluidsynth", "bin", "fluidsynth.exe"),
      godot: join(runtimeRoot, "runtime", "godot", "godot.exe"),
      ffmpeg,
      ffprobe,
    },
    midiSoundFont: join(runtimeRoot, "soundfonts", "MuseScore_General.sf3"),
    midiGodotProject: join(runtimeRoot, "renderer", "godot"),
    midiWidth: 1280,
    midiHeight: 720,
    midiFps: 30,
  };

  let service;
  t.after(async () => {
    await service?.close();
    if (process.env.OLIVIA_MIDI_E2E_KEEP !== "1") await rm(root, { recursive: true, force: true });
  });

  service = await createOliviaService(serviceOptions);
  assert.equal(service.midiPipeline.width, 1280);
  assert.equal(service.midiPipeline.height, 720);
  assert.equal(service.midiPipeline.fps, 30);
  let base = await listen(service);

  const signed = await json(base, "/toy/genObjectUploadUrl", {
    method: "POST",
    body: JSON.stringify({ type: "midi", filename: "e2e-scale.midi" }),
  });
  assert.equal(signed.body.code, 0);
  const input = midiFile({
    tracks: [track(
      noteOn(0, 60, 100), noteOff(240, 60),
      noteOn(0, 64, 100), noteOff(240, 64),
      noteOn(0, 67, 100), noteOff(480, 67),
      endOfTrack(),
    )],
  });
  const upload = await fetch(signed.body.data.url, { method: "PUT", body: input });
  assert.equal(upload.status, 200);
  const generated = await json(base, "/toy/midi/generate", {
    method: "POST",
    body: JSON.stringify({ midiUrl: signed.body.data.key, fileName: "E2E 本地演奏" }),
  });
  assert.equal(generated.body.code, 0);
  const jobId = generated.body.data.jobId;
  await service.midiQueue.waitForIdle();
  const job = service.midiStore.getJob(jobId);
  assert.equal(job.state, "completed", job.error || "render did not complete");
  const videoPath = service.midiStore.resolvePath(job.videoPath);
  assert.ok(resolve(videoPath).startsWith("I:\\"));
  assert.ok((await stat(videoPath)).size > 10_000);

  const listed = await json(base, "/toy/searchUserSongs?pageSize=20&cursor=0");
  assert.equal(listed.body.data.total, 1);
  assert.equal(listed.body.data.list[0].name, "E2E 本地演奏");
  const ranged = await fetch(listed.body.data.list[0].videoUrl, { headers: { Range: "bytes=0-1023" } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 1024);

  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name:format=duration",
    "-of", "json",
    videoPath,
  ]);
  const probe = JSON.parse(stdout);
  assert.ok(probe.streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264"));
  assert.ok(probe.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac"));
  assert.ok(Number(probe.format.duration) > 0);
  const framePath = join(root, "representative-frame.png");
  await execFileAsync(ffmpeg, ["-y", "-i", videoPath, "-frames:v", "1", framePath]);
  assert.ok((await stat(framePath)).size > 1_000);

  const imported = await json(base, "/admin/api/memory/import", {
    method: "POST",
    body: JSON.stringify({
      exchanges: [{ date: "2026-09-01", incoming: "请弹一首短曲", reply: "我已经为你弹好了。" }],
    }),
  });
  assert.equal(imported.body.code, 0);
  const memory = await json(base, "/admin/api/memory");
  const letterId = memory.body.data.exchanges[0].letterId;
  const mp4 = await readFile(videoPath);
  const attached = await fetch(`${base}/admin/api/letters/${letterId}/video`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: mp4,
  });
  assert.equal(attached.status, 200);
  const attachedBody = await attached.json();
  assert.equal(attachedBody.code, 0);
  assert.match(attachedBody.data.replyVideoUrl, new RegExp(`/toy/letter/video/${letterId}$`, "u"));

  await service.close();
  service = null;
  service = await createOliviaService(serviceOptions);
  base = await listen(service);
  const afterRestart = await json(base, "/toy/searchUserSongs?pageSize=20&cursor=0");
  assert.equal(afterRestart.body.data.total, 1);
  const replay = await fetch(afterRestart.body.data.list[0].videoUrl, { headers: { Range: "bytes=-128" } });
  assert.equal(replay.status, 206);
  assert.equal((await replay.arrayBuffer()).byteLength, 128);
  const detail = await json(base, `/toy/letter/detail?letterId=${letterId}`);
  assert.equal(detail.body.data.replyType, 2);
  const replyReplay = await fetch(detail.body.data.replyVideoUrl, { headers: { Range: "bytes=4-7" } });
  assert.equal(replyReplay.status, 206);
  assert.equal(Buffer.from(await replyReplay.arrayBuffer()).toString("ascii"), "ftyp");

  console.log(`[midi-e2e] root=${root}`);
  console.log(`[midi-e2e] video=${videoPath}`);
  console.log(`[midi-e2e] frame=${framePath}`);
});
