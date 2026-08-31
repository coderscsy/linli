import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import * as reportModule from "../src/report.js";
import { buildStage1AReport, writeStage1AReport } from "../src/report.js";
import { writeStage1ABundleForTest } from "../test-support/internal/report-test-seam.js";

const steam = {
  appId: "4532590",
  name: "BSide: Olivia Lin",
  installDir: "BSide Olivia Lin Test",
  buildId: "24943426",
  depots: [{ depotId: "4532591", manifestId: "3483511100282414030", size: 3690442569 }],
};

function blockedInput(overrides = {}) {
  return {
    inventory: {
      roots: ["Z:\\game"],
      steam,
      candidates: [],
      markerHits: ["Z:\\game\\version.json"],
      warnings: [],
    },
    protocolEvidence: { files: [], markers: ["LivePlayerStartNotify"], messages: [], paths: [] },
    validations: [],
    generatedAt: "2026-08-31T10:00:00.000Z",
    ...overrides,
  };
}

function sourceCandidateId(path) {
  const normalized = win32.resolve(path).replaceAll("/", "\\").toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

async function createLayout() {
  const root = await mkdtemp(join(tmpdir(), "olivia-report-"));
  const evidenceDir = join(root, "evidence");
  return {
    root,
    evidenceDir,
    reportJson: join(evidenceDir, "stage1a-report.json"),
    reportMarkdown: join(evidenceDir, "stage1a-report.md"),
    binaryEvidenceJson: join(evidenceDir, "binary-protocol-evidence.json"),
  };
}

test("blocks honestly when no complete renderer exists", () => {
  const report = buildStage1AReport(blockedInput());

  assert.equal(report.status, "blocked_missing_renderer");
  assert.match(report.nextAction, /不得进入 Stage 1B/u);
});

test("marks ready only when at least one validation is complete", () => {
  for (const validations of [
    [],
    [{ status: "incomplete" }],
    [{ status: "invalid_pe" }],
    [{ status: "ready" }],
  ]) {
    assert.equal(buildStage1AReport(blockedInput({ validations })).status, "blocked_missing_renderer");
  }

  const candidate = "I:\\candidate\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe";
  const validations = [
    { status: "incomplete" },
    { status: "complete", executable: candidate },
  ];
  const inventory = { ...blockedInput().inventory, candidates: [candidate] };
  const report = buildStage1AReport(blockedInput({ inventory, validations }));
  assert.equal(report.status, "candidate_ready");
  assert.equal(report.inventory.candidates[0].sourceCandidateId, sourceCandidateId(candidate));
  assert.equal(report.validations.find(item => item.status === "complete").sourceCandidateId, sourceCandidateId(candidate));
});

test("principal discovery never changes readiness enums or Steam identities but still redacts free evidence", () => {
  const candidate = "C:\\Users\\complete\\game\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe";
  const report = buildStage1AReport(blockedInput({
    inventory: {
      ...blockedInput().inventory,
      roots: [
        "C:\\Users\\candidate_ready\\scan",
        "C:\\Users\\4532590\\scan",
        "C:\\Users\\messages\\scan",
      ],
      candidates: [candidate],
    },
    protocolEvidence: {
      files: [],
      markers: [],
      messages: [{ value: "complete", encoding: "ascii", offset: 1 }],
      paths: [],
    },
    validations: [{ status: "complete", executable: candidate, files: [], missing: [], totalBytes: 1 }],
  }));

  assert.equal(report.status, "candidate_ready");
  assert.equal(report.validations[0].status, "complete");
  assert.equal(report.inventory.steam.appId, "4532590");
  assert.equal(report.inventory.steam.depots[0].depotId, "4532591");
  assert.equal(report.protocolEvidence.messages[0].value, "[PRINCIPAL_REDACTED]");
});

test("rejects forged complete validations without a matching inventory candidate", () => {
  const candidate = "I:\\candidate-a\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe";
  const other = "I:\\candidate-b\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe";
  const baseInventory = { ...blockedInput().inventory, candidates: [candidate] };

  const cases = [
    blockedInput({ validations: [{ status: "complete", executable: candidate }] }),
    blockedInput({ inventory: baseInventory, validations: [{ status: "complete", executable: other }] }),
    blockedInput({ inventory: baseInventory, validations: [{ status: "complete", sourceCandidateId: sourceCandidateId(other) }] }),
    blockedInput({ inventory: baseInventory, validations: [{ status: "complete", executable: other, sourceCandidateId: sourceCandidateId(candidate) }] }),
  ];
  for (const input of cases) {
    const report = buildStage1AReport(input);
    assert.equal(report.status, "blocked_missing_renderer");
    assert.match(report.nextAction, /不得进入 Stage 1B/u);
  }
});

test("deep-sorts object keys and arrays for byte-identical JSON and Markdown", async () => {
  const firstLayout = await createLayout();
  const secondLayout = await createLayout();
  const first = buildStage1AReport(blockedInput({
    validations: [
      { status: "complete", executable: "Z:\\z\\TPRender\\Binaries\\Win64\\Olivia.exe", missing: [] },
      { executable: "Z:\\a\\TPRender\\Binaries\\Win64\\Olivia.exe", missing: ["Config/*.ini"], status: "incomplete" },
    ],
    inventory: {
      warnings: ["scan: z", "scan: a"],
      markerHits: ["Z:\\z\\version.json", "Z:\\a\\version.json"],
      candidates: [],
      steam: { ...steam, depots: [
        { size: 2, manifestId: "b", depotId: "2" },
        { manifestId: "a", depotId: "1", size: 1 },
      ] },
      roots: ["Z:\\z", "Z:\\a"],
    },
    protocolEvidence: {
      paths: [{ value: "Z:\\two", offset: 2 }, { offset: 1, value: "Z:\\one" }],
      messages: [],
      markers: [{ value: "z", offset: 2 }, { offset: 1, value: "a" }],
      files: [],
    },
  }));
  const second = buildStage1AReport(blockedInput({
    validations: [
      { missing: ["Config/*.ini"], status: "incomplete", executable: "Z:\\a\\TPRender\\Binaries\\Win64\\Olivia.exe" },
      { missing: [], executable: "Z:\\z\\TPRender\\Binaries\\Win64\\Olivia.exe", status: "complete" },
    ],
    protocolEvidence: {
      files: [],
      markers: [{ offset: 1, value: "a" }, { offset: 2, value: "z" }],
      messages: [],
      paths: [{ offset: 1, value: "Z:\\one" }, { value: "Z:\\two", offset: 2 }],
    },
    inventory: {
      roots: ["Z:\\a", "Z:\\z"],
      steam: { depots: [
        { depotId: "1", size: 1, manifestId: "a" },
        { depotId: "2", manifestId: "b", size: 2 },
      ], buildId: steam.buildId, installDir: steam.installDir, name: steam.name, appId: steam.appId },
      candidates: [],
      markerHits: ["Z:\\a\\version.json", "Z:\\z\\version.json"],
      warnings: ["scan: a", "scan: z"],
    },
  }));

  try {
    assert.deepEqual(first, second);
    await writeStage1AReport(firstLayout, first);
    await writeStage1AReport(secondLayout, second);
    assert.equal(await readFile(firstLayout.reportJson, "utf8"), await readFile(secondLayout.reportJson, "utf8"));
    assert.equal(await readFile(firstLayout.reportMarkdown, "utf8"), await readFile(secondLayout.reportMarkdown, "utf8"));
  } finally {
    await rm(firstLayout.root, { recursive: true, force: true });
    await rm(secondLayout.root, { recursive: true, force: true });
  }
});

test("redacts credentials and replaces every input absolute path with stable labels", async () => {
  const layout = await createLayout();
  const secret = ["aaa", "bbb", "ccc"].join(".");
  const report = buildStage1AReport(blockedInput({
    inventory: {
      roots: ["C:\\Users\\private-user\\game"],
      steam: { ...steam, name: "https://example.invalid/?token=top-secret" },
      candidates: ["C:\\Users\\private-user\\candidate\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe"],
      markerHits: ["C:\\Users\\private-user\\game\\version.json"],
      warnings: [],
      authorization: "Bearer top-secret",
    },
    protocolEvidence: {
      files: [{ path: "C:\\Users\\private-user\\game\\NutLivePlayer.dll", cookie: "top-secret" }],
      markers: [{ file: "C:\\Users\\private-user\\game\\NutLivePlayer.dll", value: secret }],
      messages: [],
      paths: [{ file: "C:\\Users\\private-user\\game\\NutLivePlayer.dll", value: "C:\\Users\\private-user\\renderer.pdb" }],
      model_gateway_token: "top-secret",
    },
    validations: [{ status: "incomplete", executable: "C:\\Users\\private-user\\candidate\\Olivia.exe", "x-token": "top-secret" }],
  }));

  try {
    await writeStage1AReport(layout, report);
    const output = `${await readFile(layout.reportJson, "utf8")}\n${await readFile(layout.reportMarkdown, "utf8")}`;
    assert.doesNotMatch(output, /private-user|top-secret|aaa\.bbb\.ccc|authorization|cookie|model_gateway_token|x-token/ui);
    assert.doesNotMatch(output, /[A-Z]:\\/u);
    assert.match(output, /<scan-root-1>|<protocol-input-1>|<candidate-1>/u);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("keeps protocol record references aligned with their stable file labels", () => {
  const file = "Z:\\game\\NutLivePlayer.dll";
  const report = buildStage1AReport(blockedInput({
    protocolEvidence: {
      files: [{ path: file, size: 12, sha256: "a".repeat(64), matches: [] }],
      markers: [{ file, encoding: "ascii", offset: 0, value: "LivePlayerStartNotify" }],
      messages: [{ file, encoding: "ascii", offset: 0, value: "LivePlayerStartNotify" }],
      paths: [],
    },
  }));

  assert.equal(report.protocolEvidence.files[0].path, "<protocol-input-1>");
  assert.equal(report.protocolEvidence.markers[0].file, "<protocol-input-1>");
  assert.equal(report.protocolEvidence.messages[0].file, "<protocol-input-1>");
});

test("removes embedded Windows, UNC, Unix, user, and credential-bearing paths from every persisted string", async () => {
  const layout = await createLayout();
  const file = "Z:\\game\\NutLivePlayer.dll";
  const report = buildStage1AReport(blockedInput({
    protocolEvidence: {
      files: [{
        path: file,
        matches: [
          { value: "LivePlayerStartNotify build=Z:\\Secret\\renderer.pdb", encoding: "ascii", offset: 1 },
          { value: "LivePlayerReply asset=\\\\server\\private\\renderer.pdb", encoding: "ascii", offset: 2 },
          { value: "/secret", encoding: "ascii", offset: 3 },
          { value: "file=/secret", encoding: "ascii", offset: 4 },
        ],
      }],
      markers: [{ file, value: "prefix file=/home/private/renderer.pdb suffix", offset: 1 }],
      messages: [{ file, value: "prefix user=C:\\Users\\private-user\\renderer.pdb suffix", offset: 2 }],
      paths: [{ file, value: "https://example.invalid/render?token=top-secret", offset: 3 }],
    },
  }));

  try {
    await writeStage1AReport(layout, report);
    const persisted = `${await readFile(layout.reportJson, "utf8")}\n${await readFile(layout.reportMarkdown, "utf8")}`;
    assert.doesNotMatch(persisted, /Z:\\Secret|\\\\server\\private|\/home\/private|C:\\Users|private-user|top-secret|token=|\/secret/ui);
    assert.match(persisted, /\[(?:PATH_)?REDACTED\]|<absolute-path>/u);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("discovers path principals before removing them from report keys, values, and binary evidence", async () => {
  const layout = await createLayout();
  const username = "sycan";
  const unixUsername = "linux-user";
  const uncUsername = "unc-user";
  const sensitiveKey = "Z:\\Secret\\token";
  const report = buildStage1AReport(blockedInput({
    inventory: {
      ...blockedInput().inventory,
      roots: [
        `C:\\Users\\${username}\\game`,
        `/home/${unixUsername}/game`,
        `\\\\server\\Users\\${uncUsername}\\game`,
      ],
      steam: {
        ...steam,
        metadata: {
          [username]: "standalone-key",
          [sensitiveKey]: "sensitive-path-key",
          owner: username,
          unixOwner: unixUsername,
          uncOwner: uncUsername,
          token: "token-field-value",
          "https://example.invalid/?token=secret": "query-key",
          "aaa.bbb.ccc": "jwt-key",
        },
      },
    },
  }));

  try {
    await writeStage1ABundleForTest(layout, {
      protocolEvidence: {
        files: [{
          path: `C:\\Users\\${username}\\NutLivePlayer.dll`,
          matches: [{ value: username, [sensitiveKey]: "hidden" }],
        }],
        markers: [],
        messages: [],
        paths: [],
      },
      report,
    });
    const persisted = [layout.binaryEvidenceJson, layout.reportJson, layout.reportMarkdown]
      .map(path => readFile(path, "utf8"));
    const combined = (await Promise.all(persisted)).join("\n");
    assert.doesNotMatch(combined, /sycan|linux-user|unc-user|Z:\\Secret|sensitive-path-key|standalone-key|query-key|jwt-key|token-field-value|token=secret/ui);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("canonical ordering ignores adversarial object-key insertion order", async () => {
  const firstLayout = await createLayout();
  const secondLayout = await createLayout();
  const candidateA = "I:\\a\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe";
  const candidateB = "I:\\b\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe";
  const inventory = { ...blockedInput().inventory, candidates: [candidateA, candidateB] };
  const first = buildStage1AReport(blockedInput({
    inventory,
    validations: [
      { status: "incomplete", executable: candidateA, files: [{ path: "b", size: 2, sha256: "b" }] },
      { executable: candidateB, files: [{ sha256: "a", size: 1, path: "a" }], status: "complete" },
    ],
  }));
  const second = buildStage1AReport(blockedInput({
    inventory: { candidates: [candidateB, candidateA], warnings: [], markerHits: blockedInput().inventory.markerHits, steam, roots: blockedInput().inventory.roots },
    validations: [
      { files: [{ size: 1, path: "a", sha256: "a" }], status: "complete", executable: candidateB },
      { files: [{ sha256: "b", path: "b", size: 2 }], executable: candidateA, status: "incomplete" },
    ],
  }));
  try {
    await writeStage1AReport(firstLayout, first);
    await writeStage1AReport(secondLayout, second);
    assert.equal(await readFile(firstLayout.reportJson, "utf8"), await readFile(secondLayout.reportJson, "utf8"));
    assert.equal(await readFile(firstLayout.reportMarkdown, "utf8"), await readFile(secondLayout.reportMarkdown, "utf8"));
  } finally {
    await rm(firstLayout.root, { recursive: true, force: true });
    await rm(secondLayout.root, { recursive: true, force: true });
  }
});

test("canonicalization never calls getters or toJSON and stringifies BigInt and cycles safely", async () => {
  const layout = await createLayout();
  let getterCalls = 0;
  let toJsonCalls = 0;
  const metadata = { bytes: 9007199254740993n };
  metadata.self = metadata;
  Object.defineProperty(metadata, "danger", { enumerable: true, get() { getterCalls += 1; throw new Error("must not run"); } });
  Object.defineProperty(metadata, "toJSON", { enumerable: true, value() { toJsonCalls += 1; throw new Error("must not run"); } });
  const input = blockedInput({ inventory: { ...blockedInput().inventory, steam: { ...steam, metadata } } });
  try {
    const report = buildStage1AReport(input);
    await writeStage1AReport(layout, report);
    const persisted = await readFile(layout.reportJson, "utf8");
    assert.equal(getterCalls, 0);
    assert.equal(toJsonCalls, 0);
    assert.match(persisted, /9007199254740993/u);
    assert.match(persisted, /\[CIRCULAR\]|\[UNREADABLE\]/u);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("public writer coerces arbitrary control fields and preserves only valid schema enums", async () => {
  const layout = await createLayout();
  try {
    await writeStage1AReport(layout, {
      generatedAt: "2026-08-31T10:00:00.000Z",
      status: "launch_now",
      nextAction: "launch a renderer",
      inventory: { roots: ["C:\\Users\\candidate_ready\\scan"], steam },
      protocolEvidence: { files: [], markers: [], messages: [{ value: "candidate_ready" }], paths: [] },
      validations: [{ status: "launch_now" }],
    });
    const persisted = JSON.parse(await readFile(layout.reportJson, "utf8"));
    assert.equal(persisted.status, "blocked_missing_renderer");
    assert.equal(persisted.nextAction, "未找到结构完整且已验证的候选；不得进入 Stage 1B。");
    assert.equal(persisted.validations[0].status, "incomplete");
    assert.equal(persisted.inventory.steam.appId, "4532590");
    assert.equal(persisted.protocolEvidence.messages[0].value, "[PRINCIPAL_REDACTED]");
    assert.doesNotMatch(JSON.stringify(persisted), /launch_now|launch a renderer/u);

    await writeStage1AReport(layout, {
      generatedAt: "2026-08-31T10:00:00.000Z",
      status: "candidate_ready",
      nextAction: "untrusted action",
      inventory: { roots: ["C:\\Users\\candidate_ready\\scan"], steam },
      protocolEvidence: { files: [], markers: [], messages: [{ value: "candidate_ready" }], paths: [] },
      validations: [{ status: "complete" }],
    });
    const ready = JSON.parse(await readFile(layout.reportJson, "utf8"));
    assert.equal(ready.status, "candidate_ready");
    assert.equal(ready.nextAction, "已找到结构完整且已验证的候选；可单独规划 Stage 1B，但本阶段仍不得启动候选。");
    assert.equal(ready.validations[0].status, "complete");
    assert.equal(ready.protocolEvidence.messages[0].value, "[PRINCIPAL_REDACTED]");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("uses unique staging files and never touches pre-existing fixed partial paths", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  await writeFile(layout.reportJson, "old-json");
  await writeFile(layout.reportMarkdown, "old-markdown");
  await mkdir(`${layout.reportJson}.partial`);
  await mkdir(`${layout.reportMarkdown}.partial`);

  try {
    await writeStage1AReport(layout, buildStage1AReport(blockedInput()));
    assert.equal(JSON.parse(await readFile(layout.reportJson, "utf8")).status, "blocked_missing_renderer");
    assert.match(await readFile(layout.reportMarkdown, "utf8"), /blocked_missing_renderer/u);
    assert.equal((await lstat(`${layout.reportJson}.partial`)).isDirectory(), true);
    assert.equal((await lstat(`${layout.reportMarkdown}.partial`)).isDirectory(), true);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("atomically replaces existing report files without leaving partials", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  await writeFile(layout.reportJson, "old-json");
  await writeFile(layout.reportMarkdown, "old-markdown");

  try {
    await writeStage1AReport(layout, buildStage1AReport(blockedInput()));
    assert.equal(JSON.parse(await readFile(layout.reportJson, "utf8")).status, "blocked_missing_renderer");
    assert.match(await readFile(layout.reportMarkdown, "utf8"), /blocked_missing_renderer/u);
    assert.deepEqual((await readdir(layout.evidenceDir)).sort(), ["stage1a-report.json", "stage1a-report.md"]);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("rejects forged report basenames before touching unrelated files", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  const unrelated = join(layout.evidenceDir, "unrelated.json");
  await writeFile(unrelated, "keep-me");
  const forged = { ...layout, reportJson: unrelated };
  try {
    await assert.rejects(writeStage1AReport(forged, buildStage1AReport(blockedInput())));
    assert.equal(await readFile(unrelated, "utf8"), "keep-me");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("bundle rejects a forged binary evidence basename before touching unrelated files", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  const unrelated = join(layout.evidenceDir, "unrelated-binary.json");
  await writeFile(unrelated, "keep-me");
  try {
    await assert.rejects(writeStage1ABundleForTest({ ...layout, binaryEvidenceJson: unrelated }, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }));
    assert.equal(await readFile(unrelated, "utf8"), "keep-me");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("exclusive transaction lock prevents a concurrent report writer", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  const lock = join(layout.evidenceDir, ".stage1a-transaction.lock");
  await writeFile(lock, "other-writer");
  try {
    await assert.rejects(writeStage1AReport(layout, buildStage1AReport(blockedInput())));
    assert.equal(await readFile(lock, "utf8"), "other-writer");
    assert.deepEqual((await readdir(layout.evidenceDir)).sort(), [".stage1a-transaction.lock"]);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

for (const replaceAtInstall of [1, 2, 3]) {
  test(`lock replacement during install ${replaceAtInstall} aborts commit and restores the old bundle`, async () => {
    const layout = await createLayout();
    await mkdir(layout.evidenceDir, { recursive: true });
    const old = new Map([
      [layout.binaryEvidenceJson, "old-binary"],
      [layout.reportJson, "old-json"],
      [layout.reportMarkdown, "old-markdown"],
    ]);
    for (const [file, contents] of old) await writeFile(file, contents);
    const lockPath = join(layout.evidenceDir, ".stage1a-transaction.lock");
    let installLinks = 0;
    const linkWithLockReplacement = async (source, target) => {
      await link(source, target);
      if (/\.stage$/u.test(source) && ++installLinks === replaceAtInstall) {
        await unlink(lockPath);
        await writeFile(lockPath, `replacement-lock-${replaceAtInstall}`);
      }
    };
    try {
      await assert.rejects(writeStage1ABundleForTest(layout, {
        protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
        report: buildStage1AReport(blockedInput()),
      }, { link: linkWithLockReplacement }), /transaction_lock_lost/u);
      for (const [file, contents] of old) assert.equal(await readFile(file, "utf8"), contents);
      assert.equal(await readFile(lockPath, "utf8"), `replacement-lock-${replaceAtInstall}`);
      assert.deepEqual((await readdir(layout.evidenceDir)).sort(), [
        ".stage1a-transaction.lock",
        "binary-protocol-evidence.json",
        "stage1a-report.json",
        "stage1a-report.md",
      ]);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });
}

test("a lock write failure removes only the lock file created by this transaction", async () => {
  const layout = await createLayout();
  let injected = false;
  const openWithFailure = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (injected || !path.endsWith(".stage1a-transaction.lock")) return handle;
    injected = true;
    return {
      stat: options => handle.stat(options),
      writeFile: async () => { throw new Error("injected lock write failure"); },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  };
  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { open: openWithFailure }));
    assert.deepEqual(await readdir(layout.evidenceDir), []);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("stage replacement aborts without unlinking the replacement and restores old reports", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  await writeFile(layout.binaryEvidenceJson, "old-binary");
  await writeFile(layout.reportJson, "old-json");
  await writeFile(layout.reportMarkdown, "old-markdown");
  let replacedPath;
  const stageChecks = new Map();
  const lstatWithReplacement = async (path, options) => {
    if (/\.stage$/u.test(path)) {
      const checks = (stageChecks.get(path) ?? 0) + 1;
      stageChecks.set(path, checks);
      if (checks === 2 && !replacedPath) {
        await unlink(path);
        await writeFile(path, "attacker-replacement");
        replacedPath = path;
      }
    }
    return lstat(path, options);
  };
  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { lstat: lstatWithReplacement }));
    assert.equal(await readFile(layout.binaryEvidenceJson, "utf8"), "old-binary");
    assert.equal(await readFile(layout.reportJson, "utf8"), "old-json");
    assert.equal(await readFile(layout.reportMarkdown, "utf8"), "old-markdown");
    assert.equal(await readFile(replacedPath, "utf8"), "attacker-replacement");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("evidence directory identity change aborts before formal installation", async () => {
  const layout = await createLayout();
  let evidenceRealpaths = 0;
  const realpathWithChange = async path => {
    if (path === layout.evidenceDir && ++evidenceRealpaths >= 3) return join(layout.root, "replacement-evidence");
    return realpath(path);
  };
  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { realpath: realpathWithChange }));
    for (const target of [layout.binaryEvidenceJson, layout.reportJson, layout.reportMarkdown]) {
      await assert.rejects(readFile(target, "utf8"));
    }
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("a target resurrected after backup is preserved and never overwritten by install or rollback", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  await writeFile(layout.binaryEvidenceJson, "old-binary");
  await writeFile(layout.reportJson, "old-json");
  await writeFile(layout.reportMarkdown, "old-markdown");
  let replacementCreated = false;
  const unlinkWithResurrection = async path => {
    await unlink(path);
    if (path === layout.reportMarkdown && !replacementCreated) {
      replacementCreated = true;
      await writeFile(layout.binaryEvidenceJson, "attacker-replacement");
    }
    return undefined;
  };

  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { unlink: unlinkWithResurrection }), /transaction_rollback_failed/u);
    assert.equal(await readFile(layout.binaryEvidenceJson, "utf8"), "attacker-replacement");
    const backups = (await readdir(layout.evidenceDir)).filter(name => name.endsWith(".backup"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(layout.evidenceDir, backups[0]), "utf8"), "old-binary");
    assert.equal(await readFile(layout.reportJson, "utf8"), "old-json");
    assert.equal(await readFile(layout.reportMarkdown, "utf8"), "old-markdown");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("hard-link unavailability fails closed without moving or deleting old formal artifacts", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  const old = new Map([
    [layout.binaryEvidenceJson, "old-binary"],
    [layout.reportJson, "old-json"],
    [layout.reportMarkdown, "old-markdown"],
  ]);
  for (const [file, contents] of old) await writeFile(file, contents);
  const unavailableLink = async () => {
    const error = new Error("hard links unavailable");
    error.code = "EPERM";
    throw error;
  };
  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { link: unavailableLink }));
    for (const [file, contents] of old) assert.equal(await readFile(file, "utf8"), contents);
    assert.deepEqual((await readdir(layout.evidenceDir)).sort(), [
      "binary-protocol-evidence.json",
      "stage1a-report.json",
      "stage1a-report.md",
    ]);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

for (const failInstallAt of [2, 3]) {
  test(`bundle rollback restores all three old files when install link ${failInstallAt} fails`, async () => {
    const layout = await createLayout();
    await mkdir(layout.evidenceDir, { recursive: true });
    const old = new Map([
      [layout.binaryEvidenceJson, "old-binary"],
      [layout.reportJson, "old-json"],
      [layout.reportMarkdown, "old-markdown"],
    ]);
    for (const [file, contents] of old) await writeFile(file, contents);
    let installLinks = 0;
    const linkWithFailure = async (source, target) => {
      if (/\.stage$/u.test(source) && ++installLinks === failInstallAt) {
        const error = new Error("injected install failure");
        error.code = "EIO";
        throw error;
      }
      return link(source, target);
    };
    try {
      await assert.rejects(writeStage1ABundleForTest(layout, {
        protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
        report: buildStage1AReport(blockedInput()),
      }, { link: linkWithFailure }));
      for (const [file, contents] of old) assert.equal(await readFile(file, "utf8"), contents);
      assert.deepEqual((await readdir(layout.evidenceDir)).sort(), [
        "binary-protocol-evidence.json",
        "stage1a-report.json",
        "stage1a-report.md",
      ]);
    } finally {
      await rm(layout.root, { recursive: true, force: true });
    }
  });
}

test("perform-then-reject link and unlink operations are reconciled to an all-old rollback", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  const old = new Map([
    [layout.binaryEvidenceJson, "old-binary"],
    [layout.reportJson, "old-json"],
    [layout.reportMarkdown, "old-markdown"],
  ]);
  for (const [file, contents] of old) await writeFile(file, contents);

  let backupLinkRejected = false;
  let installLinks = 0;
  let secondInstallFailed = false;
  const linkWithAmbiguousResults = async (source, target) => {
    if (source === layout.binaryEvidenceJson && /\.backup$/u.test(target) && !backupLinkRejected) {
      backupLinkRejected = true;
      await link(source, target);
      throw new Error("backup link performed then rejected");
    }
    if (/\.stage$/u.test(source)) {
      installLinks += 1;
      if (installLinks === 1) {
        await link(source, target);
        throw new Error("install link performed then rejected");
      }
      if (installLinks === 2) {
        secondInstallFailed = true;
        throw new Error("second install failed");
      }
    }
    return link(source, target);
  };
  let backupUnlinkRejected = false;
  let rollbackUnlinkRejected = false;
  const unlinkWithAmbiguousResults = async path => {
    if (path === layout.binaryEvidenceJson && !backupUnlinkRejected) {
      backupUnlinkRejected = true;
      await unlink(path);
      throw new Error("backup unlink performed then rejected");
    }
    if (path === layout.binaryEvidenceJson && secondInstallFailed && !rollbackUnlinkRejected) {
      rollbackUnlinkRejected = true;
      await unlink(path);
      throw new Error("rollback unlink performed then rejected");
    }
    return unlink(path);
  };

  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { link: linkWithAmbiguousResults, unlink: unlinkWithAmbiguousResults }));
    for (const [file, contents] of old) assert.equal(await readFile(file, "utf8"), contents);
    assert.deepEqual((await readdir(layout.evidenceDir)).sort(), [
      "binary-protocol-evidence.json",
      "stage1a-report.json",
      "stage1a-report.md",
    ]);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("rollback unlink failure never overwrites the installed identity and preserves the old backup", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  await writeFile(layout.binaryEvidenceJson, "old-binary");
  await writeFile(layout.reportJson, "old-json");
  await writeFile(layout.reportMarkdown, "old-markdown");
  let installLinks = 0;
  let rollbackStarted = false;
  const linkWithSecondInstallFailure = async (source, target) => {
    if (/\.stage$/u.test(source) && ++installLinks === 2) {
      rollbackStarted = true;
      throw new Error("second install failed");
    }
    return link(source, target);
  };
  const unlinkWithRollbackFailure = async path => {
    if (rollbackStarted && path === layout.binaryEvidenceJson) throw new Error("rollback unlink failed");
    return unlink(path);
  };

  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { link: linkWithSecondInstallFailure, unlink: unlinkWithRollbackFailure }), /transaction_rollback_failed/u);
    assert.notEqual(await readFile(layout.binaryEvidenceJson, "utf8"), "old-binary");
    const backups = (await readdir(layout.evidenceDir)).filter(name => name.startsWith(".binary-protocol-evidence.json.") && name.endsWith(".backup"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(layout.evidenceDir, backups[0]), "utf8"), "old-binary");
    assert.equal(await readFile(layout.reportJson, "utf8"), "old-json");
    assert.equal(await readFile(layout.reportMarkdown, "utf8"), "old-markdown");
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("rollback restores an old target when the post-backup stability check fails", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  const old = new Map([
    [layout.binaryEvidenceJson, "old-binary"],
    [layout.reportJson, "old-json"],
    [layout.reportMarkdown, "old-markdown"],
  ]);
  for (const [file, contents] of old) await writeFile(file, contents);

  let backedUp = false;
  let injected = false;
  const linkThenSignal = async (source, target) => {
    await link(source, target);
    if (source === layout.binaryEvidenceJson && /\.backup$/u.test(target)) backedUp = true;
  };
  const realpathWithOneFailure = async path => {
    if (path === layout.evidenceDir && backedUp && !injected) {
      injected = true;
      return join(layout.root, "replacement-evidence");
    }
    return realpath(path);
  };

  try {
    await assert.rejects(writeStage1ABundleForTest(layout, {
      protocolEvidence: { files: [], markers: [], messages: [], paths: [] },
      report: buildStage1AReport(blockedInput()),
    }, { realpath: realpathWithOneFailure, link: linkThenSignal }));
    for (const [file, contents] of old) assert.equal(await readFile(file, "utf8"), contents);
    assert.deepEqual((await readdir(layout.evidenceDir)).sort(), [
      "binary-protocol-evidence.json",
      "stage1a-report.json",
      "stage1a-report.md",
    ]);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("report module exposes only the documented Task 5 APIs", () => {
  assert.deepEqual(Object.keys(reportModule).sort(), ["buildStage1AReport", "writeStage1AReport"]);
});
