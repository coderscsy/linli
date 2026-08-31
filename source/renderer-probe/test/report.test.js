import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as reportModule from "../src/report.js";
import { buildStage1AReport, writeStage1AReport } from "../src/report.js";

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

  const validations = [
    { status: "incomplete" },
    { status: "complete", executable: "I:\\candidate\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe" },
  ];
  assert.equal(buildStage1AReport(blockedInput({ validations })).status, "candidate_ready");
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

test("prepares both partials before replacement and cleans only the partial it created", async () => {
  const layout = await createLayout();
  await mkdir(layout.evidenceDir, { recursive: true });
  await writeFile(layout.reportJson, "old-json");
  await writeFile(layout.reportMarkdown, "old-markdown");
  await mkdir(`${layout.reportMarkdown}.partial`);

  try {
    await assert.rejects(writeStage1AReport(layout, buildStage1AReport(blockedInput())));
    assert.equal(await readFile(layout.reportJson, "utf8"), "old-json");
    assert.equal(await readFile(layout.reportMarkdown, "utf8"), "old-markdown");
    await assert.rejects(readFile(`${layout.reportJson}.partial`, "utf8"));
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
    await assert.rejects(readFile(`${layout.reportJson}.partial`, "utf8"));
    await assert.rejects(readFile(`${layout.reportMarkdown}.partial`, "utf8"));
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
});

test("report module exposes only the documented Task 5 APIs", () => {
  assert.deepEqual(Object.keys(reportModule).sort(), ["buildStage1AReport", "writeStage1AReport"]);
});
