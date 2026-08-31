import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { validateRendererCandidate } from "../src/candidate.js";
import * as candidateModule from "../src/candidate.js";
import { validateRendererCandidateForTest } from "../test-support/candidate-test-seam.js";

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function createCandidate({ includePak = true, executableBytes = Buffer.from([0x4d, 0x5a, 0x01]), dllBytes = Buffer.from([0x4d, 0x5a, 0x02]) } = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-renderer-candidate-"));
  const renderer = join(root, "wallpaper", "TPRender");
  const bin = join(renderer, "Binaries", "Win64");
  const pak = join(renderer, "Content", "Paks", "TPRender-Windows.pak");
  const config = join(renderer, "Config", "DefaultEngine.ini");
  const executable = join(bin, "Olivia.exe");
  const dll = join(bin, "TPRender-Win64-Shipping.dll");
  await mkdir(dirname(pak), { recursive: true });
  await mkdir(dirname(config), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(executable, executableBytes);
  await writeFile(dll, dllBytes);
  await writeFile(config, "[/Script/Engine.Engine]\n");
  if (includePak) await writeFile(pak, "pak-fixture");
  return { root, renderer, executable, dll, pak, config };
}

test("accepts a complete TPRender candidate with streaming hashes and stable file order", async () => {
  const fixture = await createCandidate();
  const inputs = [fixture.executable, fixture.dll, fixture.pak, fixture.config];
  const before = await Promise.all(inputs.map(sha256));
  try {
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "complete");
    assert.equal(result.rendererRoot, "<candidate>/TPRender");
    assert.equal(result.executable, "<candidate>/TPRender/Binaries/Win64/Olivia.exe");
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.files.map(file => file.path), [
      "Binaries/Win64/Olivia.exe",
      "Binaries/Win64/TPRender-Win64-Shipping.dll",
      "Config/DefaultEngine.ini",
      "Content/Paks/TPRender-Windows.pak",
    ]);
    assert.ok(result.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256)));
    assert.equal(result.totalBytes, 3 + 3 + Buffer.byteLength("[/Script/Engine.Engine]\n") + Buffer.byteLength("pak-fixture"));
  } finally {
    assert.deepEqual(await Promise.all(inputs.map(sha256)), before, "validator must not modify fixtures");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports a missing PAK as incomplete without emitting the fixture path", async () => {
  const fixture = await createCandidate({ includePak: false });
  try {
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "incomplete");
    assert.ok(result.missing.includes("Content/Paks/*.pak"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.root.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("marks a candidate invalid_pe when Olivia.exe does not begin with MZ", async () => {
  const fixture = await createCandidate({ executableBytes: Buffer.from("not a PE") });
  try {
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "invalid_pe");
    assert.ok(result.missing.includes("Binaries/Win64/Olivia.exe:MZ"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("marks a candidate invalid_pe when a sibling DLL does not begin with MZ", async () => {
  const fixture = await createCandidate({ dllBytes: Buffer.from("not a PE") });
  try {
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "invalid_pe");
    assert.ok(result.missing.includes("Binaries/Win64/TPRender-Win64-Shipping.dll:MZ"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an executable outside the exact TPRender suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-wrong-suffix-"));
  const executable = join(root, "other", "Binaries", "Win64", "Olivia.exe");
  try {
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, Buffer.from([0x4d, 0x5a]));
    const result = await validateRendererCandidate(executable);
    assert.equal(result.status, "invalid_pe");
    assert.ok(result.missing.includes("TPRender/Binaries/Win64/Olivia.exe"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symbolic link or junction in the candidate set instead of following it", async (t) => {
  const fixture = await createCandidate();
  const outside = await mkdtemp(join(tmpdir(), "olivia-candidate-outside-"));
  const linkedPak = join(fixture.renderer, "Content", "Paks", "linked.pak");
  try {
    await writeFile(join(outside, "outside.pak"), "outside");
    try {
      await symlink(join(outside, "outside.pak"), linkedPak, "file");
    } catch (error) {
      t.skip(`Windows denied symbolic-link fixture: ${error.code}`);
      return;
    }
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "incomplete");
    assert.ok(result.missing.includes("candidate contains symbolic link"));
    assert.equal(result.files.some(file => file.path.includes("linked.pak")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("fails safely when canonical validation reports a candidate path replacement", async () => {
  const fixture = await createCandidate();
  let executableRealpathCalls = 0;
  const fsAdapter = {
    lstat,
    realpath: async path => {
      if (path === fixture.executable && ++executableRealpathCalls > 2) return join(fixture.root, "outside", "Olivia.exe");
      return (await import("node:fs/promises")).realpath(path);
    },
    readdir: (await import("node:fs/promises")).readdir,
    open: (await import("node:fs/promises")).open,
    createReadStream: (await import("node:fs")).createReadStream,
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.ok(result.missing.some(item => item === "candidate changed during validation" || item === "candidate path escapes renderer root"));
    assert.deepEqual(result.files, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails safely when the renderer root changes after collection and before hashing", async () => {
  const fixture = await createCandidate();
  let rendererRealpathCalls = 0;
  const fsPromises = await import("node:fs/promises");
  const fsAdapter = {
    lstat,
    realpath: async path => {
      if (path === fixture.renderer && ++rendererRealpathCalls > 6) return join(fixture.root, "outside", "TPRender");
      return fsPromises.realpath(path);
    },
    readdir: fsPromises.readdir,
    open: fsPromises.open,
    createReadStream: (await import("node:fs")).createReadStream,
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.ok(result.missing.some(item => item === "candidate changed during validation" || item === "candidate path escapes renderer root"));
    assert.deepEqual(result.files, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an over-limit candidate from metadata before streaming its PAK", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  const fs = await import("node:fs");
  let pakStreamOpened = false;
  const fsAdapter = {
    lstat: async path => {
      const stats = await lstat(path);
      if (path !== fixture.pak) return stats;
      const oversized = Object.create(stats);
      Object.defineProperty(oversized, "size", { value: 17 * 1024 * 1024 * 1024 });
      return oversized;
    },
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: fsPromises.open,
    createReadStream: path => {
      if (path === fixture.pak) pakStreamOpened = true;
      return fs.createReadStream(path);
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.ok(result.missing.includes("candidate byte limit exceeded"));
    assert.equal(pakStreamOpened, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exports only the validation API and has no child-process or launch capability", async () => {
  assert.deepEqual(Object.keys(candidateModule).sort(), ["validateRendererCandidate"]);
  const source = await readFile(new URL("../src/candidate.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawn|execFile|Start-Process|ShellExecute|powershell/iu);
});
