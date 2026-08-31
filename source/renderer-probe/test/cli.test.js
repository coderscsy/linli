import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import test from "node:test";

import * as cliModule from "../src/cli.js";
import { runCli } from "../src/cli.js";
import { runCliForTest } from "../test-support/internal/cli-test-seam.js";
import { writeStage1ABundleForTest } from "../test-support/internal/report-test-seam.js";

const marker = "ovilia_Win64_Development_15918";
const manifest = `"AppState" { "appid" "4532590" "name" "BSide: Olivia Lin" "installdir" "BSide Olivia Lin Test" "buildid" "24943426" "InstalledDepots" { "4532591" { "manifest" "3483511100282414030" "size" "3690442569" } } }`;

async function createFixture({ candidate = "complete", includeManifest = true, backupName = "backup root" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-renderer-cli-"));
  const dataRoot = join(root, "data root");
  const gameRoot = join(root, "game root");
  const backupRoot = join(root, backupName);
  const appDataRoot = join(root, "appdata root");
  const steamAppsRoot = join(root, "steamapps root");
  const version = join(gameRoot, "0.0.9.627", "plugins", "Studio", "..", "..", "..", "version.json");
  const livePlayer = join(gameRoot, "0.0.9.627", "plugins", "Studio", "NutLivePlayer.dll");
  const studioPlugin = join(gameRoot, "0.0.9.627", "plugins", "Studio", "NutStudioPlugin.dll");
  const appManifest = join(steamAppsRoot, "appmanifest_4532590.acf");
  const executable = join(backupRoot, "wallpaper", "TPRender", "Binaries", "Win64", "Olivia.exe");
  const dll = join(dirname(executable), "TPRender-Win64-Shipping.dll");
  const pak = join(backupRoot, "wallpaper", "TPRender", "Content", "Paks", "TPRender-Windows.pak");
  const config = join(backupRoot, "wallpaper", "TPRender", "Config", "DefaultEngine.ini");

  await Promise.all([
    mkdir(dirname(livePlayer), { recursive: true }),
    mkdir(appDataRoot, { recursive: true }),
    mkdir(steamAppsRoot, { recursive: true }),
  ]);
  await writeFile(version, `{"marker":"${marker}"}`);
  await writeFile(livePlayer, "LivePlayerStartNotify\0Authorization: Bearer never-report-this\0");
  await writeFile(studioPlugin, "render_ready\0");
  if (includeManifest) await writeFile(appManifest, manifest);

  const inputs = [version, livePlayer, studioPlugin];
  if (includeManifest) inputs.push(appManifest);
  if (candidate !== "none") {
    await mkdir(dirname(pak), { recursive: true });
    await mkdir(dirname(config), { recursive: true });
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, Buffer.from(candidate === "complete" ? [0x4d, 0x5a, 0x01] : [0x00, 0x01]));
    await writeFile(dll, Buffer.from([0x4d, 0x5a, 0x02]));
    await writeFile(pak, "pak-fixture");
    await writeFile(config, "[/Script/Engine.Engine]\n");
    inputs.push(executable, dll, pak, config);
  }

  const args = [
    "scan",
    "--data-root", dataRoot,
    "--game-root", gameRoot,
    "--backup-root", backupRoot,
    "--appdata-root", appDataRoot,
    "--steamapps-root", steamAppsRoot,
  ];
  const requiredDrive = win32.parse(root).root.slice(0, 2);
  return { root, dataRoot, gameRoot, backupRoot, appDataRoot, steamAppsRoot, appManifest, inputs, args, requiredDrive };
}

async function hashFiles(files) {
  return Promise.all(files.map(async file => createHash("sha256").update(await readFile(file)).digest("hex")));
}

async function captureRun(args, options) {
  let stdout = "";
  let stderr = "";
  const result = await runCliForTest(args, {
    ...options,
    stdout: { write(chunk) { stdout += String(chunk); return true; } },
    stderr: { write(chunk) { stderr += String(chunk); return true; } },
    now: () => new Date("2026-08-31T10:00:00.000Z"),
  });
  return { code: result, stdout, stderr };
}

async function capturePublicRun(args, ignoredOptions) {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  process.stderr.write = chunk => { stderr += String(chunk); return true; };
  try {
    const code = await runCli(args, ignoredOptions);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test("complete candidate exits 0, writes sanitized evidence, and leaves every scan input unchanged", async () => {
  const fixture = await createFixture();
  const before = await hashFiles(fixture.inputs);
  try {
    const result = await captureRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    const reportPath = join(fixture.dataRoot, "evidence", "stage1a-report.json");
    const evidencePath = join(fixture.dataRoot, "evidence", "binary-protocol-evidence.json");
    const markdownPath = join(fixture.dataRoot, "evidence", "stage1a-report.md");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const evidenceText = await readFile(evidencePath, "utf8");
    const lines = result.stdout.trim().split(/\r?\n/u);
    const summary = JSON.parse(lines[0]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(report.status, "candidate_ready");
    assert.equal(report.generatedAt, "2026-08-31T10:00:00.000Z");
    assert.match(report.inventory.candidates[0].sourceCandidateId, /^[a-f0-9]{64}$/u);
    assert.equal(report.validations.find(item => item.status === "complete").sourceCandidateId, report.inventory.candidates[0].sourceCandidateId);
    assert.match(await readFile(markdownPath, "utf8"), /candidate_ready/u);
    assert.deepEqual((await readdir(join(fixture.dataRoot, "evidence"))).sort(), [
      "binary-protocol-evidence.json",
      "stage1a-report.json",
      "stage1a-report.md",
    ]);
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(summary).sort(), ["counts", "reportJson", "status"]);
    assert.equal(summary.reportJson, "evidence/stage1a-report.json");
    assert.equal(summary.status, "candidate_ready");
    assert.deepEqual(Object.keys(summary.counts).sort(), ["candidates", "completeValidations", "protocolFiles"]);
    assert.doesNotMatch(`${result.stdout}\n${evidenceText}\n${JSON.stringify(report)}`, /never-report-this|authorization|Bearer |sycan|olivia-renderer-cli-/ui);
    assert.equal(await hashFiles(fixture.inputs).then(after => JSON.stringify(after)), JSON.stringify(before));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate path with phone and JWT-like segments remains ready without leaking raw segments", async () => {
  const phone = "13800138000";
  const jwtLike = "aaa.bbb.ccc";
  const fixture = await createFixture({ backupName: `backup ${phone} ${jwtLike}` });
  try {
    const result = await captureRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    const reportText = await readFile(join(fixture.dataRoot, "evidence", "stage1a-report.json"), "utf8");
    const markdownText = await readFile(join(fixture.dataRoot, "evidence", "stage1a-report.md"), "utf8");
    const evidenceText = await readFile(join(fixture.dataRoot, "evidence", "binary-protocol-evidence.json"), "utf8");
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(reportText).status, "candidate_ready");
    assert.doesNotMatch(`${result.stdout}\n${reportText}\n${markdownText}\n${evidenceText}`, /13800138000|aaa\.bbb\.ccc|backup 138/ui);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("no candidate is an honest report-complete exit 2", async () => {
  const fixture = await createFixture({ candidate: "none" });
  try {
    const result = await captureRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    const report = JSON.parse(await readFile(join(fixture.dataRoot, "evidence", "stage1a-report.json"), "utf8"));
    assert.equal(result.code, 2);
    assert.equal(report.status, "blocked_missing_renderer");
    assert.match(report.nextAction, /不得进入 Stage 1B/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid candidate remains blocked while binary read failures are fixed safe evidence", async () => {
  const fixture = await createFixture({ candidate: "invalid" });
  try {
    await rm(join(fixture.gameRoot, "0.0.9.627", "plugins", "Studio", "NutStudioPlugin.dll"));
    const result = await captureRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    const report = JSON.parse(await readFile(join(fixture.dataRoot, "evidence", "stage1a-report.json"), "utf8"));
    const evidence = JSON.parse(await readFile(join(fixture.dataRoot, "evidence", "binary-protocol-evidence.json"), "utf8"));
    assert.equal(result.code, 2);
    assert.equal(report.status, "blocked_missing_renderer");
    assert.ok(report.validations.some(item => item.status === "invalid_pe"));
    assert.ok(evidence.files.some(item => item.error === "read_failed"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing appmanifest exits 1 with only its safe basename", async () => {
  const fixture = await createFixture({ candidate: "none", includeManifest: false });
  try {
    const result = await captureRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "renderer-probe: missing appmanifest_4532590.acf\n");
    assert.doesNotMatch(result.stderr, /[A-Z]:\\|sycan|token|Bearer/ui);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("default production boundary rejects a C drive data root before creating reports", async () => {
  const fixture = await createFixture({ candidate: "none" });
  try {
    const result = await capturePublicRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "renderer-probe: unsafe data root\n");
    await assert.rejects(readFile(join(fixture.dataRoot, "evidence", "stage1a-report.json"), "utf8"));
    await assert.rejects(readFile(join(fixture.dataRoot, "evidence", "binary-protocol-evidence.json"), "utf8"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects unknown, duplicate, missing, and flag-shaped values without echoing arguments", async () => {
  const fixture = await createFixture({ candidate: "none" });
  const secretFlag = "--Authorization=Bearer-secret";
  const cases = [
    [...fixture.args, secretFlag],
    [...fixture.args, "--game-root", fixture.gameRoot],
    fixture.args.slice(0, -1),
    fixture.args.map(value => value === fixture.gameRoot ? "--backup-root" : value),
    fixture.args.filter((_, index) => ![1, 2].includes(index)),
    ["probe", ...fixture.args.slice(1)],
  ];
  try {
    for (const args of cases) {
      const result = await captureRun(args, { requiredDrive: fixture.requiredDrive });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "renderer-probe: invalid scan arguments\n");
      assert.doesNotMatch(result.stderr, /Authorization|Bearer|secret|backup root/ui);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("requiredDrive is test-support only and public runCli cannot be weakened", async () => {
  const fixture = await createFixture({ candidate: "none" });
  try {
    const flagResult = await captureRun([...fixture.args, "--required-drive", fixture.requiredDrive], { requiredDrive: fixture.requiredDrive });
    assert.equal(flagResult.code, 1);
    assert.equal(flagResult.stderr, "renderer-probe: invalid scan arguments\n");

    const unsafeArgs = [...fixture.args];
    unsafeArgs[unsafeArgs.indexOf("--data-root") + 1] = `${fixture.requiredDrive}\\not-a-test-temp-root`;
    const injectionResult = await captureRun(unsafeArgs, { requiredDrive: fixture.requiredDrive });
    assert.equal(injectionResult.code, 1);
    assert.equal(injectionResult.stderr, "renderer-probe: unsafe data root\n");

    const publicResult = await capturePublicRun(fixture.args, { requiredDrive: fixture.requiredDrive });
    assert.equal(publicResult.code, 1);
    assert.equal(publicResult.stderr, "renderer-probe: unsafe data root\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a CLI bundle-write failure leaves no current-run formal evidence or reports", async () => {
  const fixture = await createFixture({ candidate: "none" });
  const evidenceDir = join(fixture.dataRoot, "evidence");
  let installLinks = 0;
  try {
    const result = await captureRun(fixture.args, {
      requiredDrive: fixture.requiredDrive,
      dependencies: {
        writeEvidenceBundle: (layout, bundle) => writeStage1ABundleForTest(layout, bundle, {
          link: async (source, target) => {
            if (/\.stage$/u.test(source) && ++installLinks === 3) throw new Error("injected third install failure");
            return link(source, target);
          },
        }),
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "renderer-probe: report bundle write failed\n");
    for (const name of ["binary-protocol-evidence.json", "stage1a-report.json", "stage1a-report.md"]) {
      await assert.rejects(readFile(join(evidenceDir, name), "utf8"));
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI exports only runCli and has no network, shell, or child-process capability", async () => {
  assert.deepEqual(Object.keys(cliModule).sort(), ["runCli"]);
  const source = await readFile(new URL("../src/cli.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:(?:child_process|net|http|https|tls|dgram)|\b(?:spawn|execFile|fork|powershell|Start-Process|ShellExecute)\b/iu);
});
