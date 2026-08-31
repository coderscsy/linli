import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { validateRendererCandidate } from "../src/candidate.js";
import * as candidateModule from "../src/candidate.js";
import { validateRendererCandidateForTest } from "../test-support/internal/candidate-test-seam.js";

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function reliableLstat(path) {
  return lstat(path, { bigint: true });
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
    lstat: reliableLstat,
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
    lstat: reliableLstat,
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
      const stats = await reliableLstat(path);
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

test("accepts a complete candidate whose Windows path components use mixed case", async () => {
  const fixture = await createCandidate();
  const mixedRoot = join(fixture.root, "wallpaper", "tPrEnDeR");
  const fsPromises = await import("node:fs/promises");
  try {
    await fsPromises.rename(fixture.renderer, mixedRoot);
    await fsPromises.rename(join(mixedRoot, "Binaries"), join(mixedRoot, "bInArIeS"));
    await fsPromises.rename(join(mixedRoot, "bInArIeS", "Win64"), join(mixedRoot, "bInArIeS", "wIn64"));
    await fsPromises.rename(join(mixedRoot, "Content"), join(mixedRoot, "cOnTeNt"));
    await fsPromises.rename(join(mixedRoot, "cOnTeNt", "Paks"), join(mixedRoot, "cOnTeNt", "pAkS"));
    await fsPromises.rename(join(mixedRoot, "Config"), join(mixedRoot, "cOnFiG"));
    await fsPromises.rename(join(mixedRoot, "bInArIeS", "wIn64", "TPRender-Win64-Shipping.dll"), join(mixedRoot, "bInArIeS", "wIn64", "tPrEnDeR-Win64-Shipping.DLL"));
    await fsPromises.rename(join(mixedRoot, "cOnTeNt", "pAkS", "TPRender-Windows.pak"), join(mixedRoot, "cOnTeNt", "pAkS", "TPRender-Windows.PAK"));
    await fsPromises.rename(join(mixedRoot, "cOnFiG", "DefaultEngine.ini"), join(mixedRoot, "cOnFiG", "dEfAuLtEnGiNe.InI"));
    const executable = join(mixedRoot, "bInArIeS", "wIn64", "Olivia.exe");
    const result = await validateRendererCandidate(executable);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.missing, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects the aggregate metadata limit before opening any candidate file", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let openCalls = 0;
  const fsAdapter = {
    lstat: reliableLstat,
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async () => { openCalls += 1; throw new Error("must not open"); },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter, { maxTotalBytes: 1 });
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.missing, ["candidate byte limit exceeded"]);
    assert.equal(openCalls, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not start a stream when the path escapes after open and before handle validation", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let opened = false;
  let readStarted = false;
  const fsAdapter = {
    lstat: reliableLstat,
    readdir: fsPromises.readdir,
    realpath: async path => opened && path === fixture.executable ? join(fixture.root, "outside", "Olivia.exe") : fsPromises.realpath(path),
    open: async path => {
      opened = true;
      const handle = await fsPromises.open(path, "r");
      return {
        stat: () => handle.stat({ bigint: true }),
        close: () => handle.close(),
        createReadStream: () => {
          readStarted = true;
          return handle.createReadStream({ autoClose: false });
        },
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.equal(readStarted, false);
    assert.ok(result.missing.includes("candidate path escapes renderer root"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not open a file when it is replaced before open validation", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let executableStats = 0;
  let openCalls = 0;
  const fsAdapter = {
    lstat: async path => {
      if (path === fixture.executable) executableStats += 1;
      return reliableLstat(path);
    },
    readdir: fsPromises.readdir,
    realpath: async path => path === fixture.executable && executableStats >= 7 ? join(fixture.root, "outside", "Olivia.exe") : fsPromises.realpath(path),
    open: async () => { openCalls += 1; throw new Error("must not open replaced path"); },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.equal(openCalls, 0);
    assert.ok(result.missing.includes("candidate path escapes renderer root"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uses one verified FileHandle stream for MZ, SHA-256, and byte count", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let handleStreams = 0;
  const fsAdapter = {
    lstat: reliableLstat,
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async (path, flags) => {
      const handle = await fsPromises.open(path, flags);
      return {
        stat: () => handle.stat({ bigint: true }),
        close: () => handle.close(),
        createReadStream: options => {
          handleStreams += 1;
          return handle.createReadStream(options);
        },
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    const executable = result.files.find(file => file.path === "Binaries/Win64/Olivia.exe");
    assert.equal(result.status, "complete");
    assert.equal(handleStreams, result.files.length);
    assert.equal(executable.sha256, await sha256(fixture.executable));
    assert.equal(executable.size, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("drops all output when a handle changes size after its stream completes", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  const fsAdapter = {
    lstat: reliableLstat,
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async (path, flags) => {
      const handle = await fsPromises.open(path, flags);
      let statCalls = 0;
      return {
        stat: async () => {
          const stats = await handle.stat({ bigint: true });
          statCalls += 1;
          if (path === fixture.executable && statCalls > 1) {
            const changed = Object.create(stats);
            Object.defineProperty(changed, "size", { value: typeof stats.size === "bigint" ? stats.size + 1n : stats.size + 1 });
            return changed;
          }
          return stats;
        },
        close: () => handle.close(),
        createReadStream: options => {
          const stream = handle.createReadStream(options);
          return stream;
        },
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.missing, ["candidate changed during validation"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("caps the final file stream at the remaining aggregate byte budget", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  const highWaterMarks = [];
  const total = 3 + 3 + Buffer.byteLength("[/Script/Engine.Engine]\n") + Buffer.byteLength("pak-fixture");
  const fsAdapter = {
    lstat: reliableLstat,
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async (path, flags) => {
      const handle = await fsPromises.open(path, flags);
      return {
        stat: () => handle.stat({ bigint: true }),
        close: () => handle.close(),
        createReadStream: options => {
          highWaterMarks.push(options.highWaterMark);
          return handle.createReadStream(options);
        },
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter, { maxTotalBytes: total });
    assert.equal(result.status, "complete");
    assert.equal(highWaterMarks.at(-1), Buffer.byteLength("pak-fixture"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("falls back to readonly open only when O_NOFOLLOW is unsupported", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let rejectedNoFollow = false;
  const fsAdapter = {
    lstat: reliableLstat,
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    openFlags: 0x20000,
    open: async (path, flags) => {
      if (flags === 0x20000) {
        rejectedNoFollow = true;
        const error = new Error("unsupported");
        error.code = "EINVAL";
        throw error;
      }
      assert.equal(flags, 0);
      return fsPromises.open(path, flags);
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(rejectedNoFollow, true);
    assert.equal(result.status, "complete");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function withIdentity(stats, dev, ino) {
  const copy = Object.create(stats);
  Object.defineProperties(copy, { dev: { value: dev }, ino: { value: ino } });
  return copy;
}

test("fails closed without reading when zero file IDs could hide a same-size replacement", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let streams = 0;
  const fsAdapter = {
    lstat: async path => withIdentity(await lstat(path), 0, 0),
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async (path, flags) => {
      const handle = await fsPromises.open(path, flags);
      return {
        stat: async () => withIdentity(await handle.stat(), 0, 0),
        close: () => handle.close(),
        createReadStream: options => { streams += 1; return handle.createReadStream(options); },
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.missing, ["identity_unavailable"]);
    assert.equal(streams, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed without reading when numeric file IDs are not safe integers", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  let streams = 0;
  const fsAdapter = {
    lstat: async path => withIdentity(await lstat(path), Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1),
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async (path, flags) => {
      const handle = await fsPromises.open(path, flags);
      return {
        stat: async () => withIdentity(await handle.stat(), Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1),
        close: () => handle.close(),
        createReadStream: options => { streams += 1; return handle.createReadStream(options); },
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.missing, ["identity_unavailable"]);
    assert.equal(streams, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("accepts matching nonzero bigint file IDs", async () => {
  const fixture = await createCandidate();
  const fsPromises = await import("node:fs/promises");
  const fsAdapter = {
    lstat: path => fsPromises.lstat(path, { bigint: true }),
    realpath: fsPromises.realpath,
    readdir: fsPromises.readdir,
    open: async (path, flags) => {
      const handle = await fsPromises.open(path, flags);
      return {
        stat: () => handle.stat({ bigint: true }),
        close: () => handle.close(),
        createReadStream: options => handle.createReadStream(options),
      };
    },
  };
  try {
    const result = await validateRendererCandidateForTest(fixture.executable, fsAdapter);
    assert.equal(result.status, "complete");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exports only the validation API and has no child-process or launch capability", async () => {
  assert.deepEqual(Object.keys(candidateModule).sort(), ["validateRendererCandidate"]);
  const source = await readFile(new URL("../src/candidate.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawn|execFile|Start-Process|ShellExecute|powershell/iu);
});
