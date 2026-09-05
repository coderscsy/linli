# Native Renderer Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested, read-only-first I-drive tool that inventories all legally available Olivia renderer evidence, validates a `TPRender` candidate, and emits a deterministic Stage 1A decision report without modifying Steam or backup files.

**Architecture:** Add a dependency-free Node.js ESM package under `source/renderer-probe`. Pure modules resolve the I-drive layout, parse Steam VDF metadata, scan bounded roots, extract sanitized binary strings, validate candidate renderer structure, and write JSON/Markdown evidence. A CLI composes those modules and returns exit code `0` for `candidate_ready`, `2` for an evidence-complete `blocked_missing_renderer`, and `1` for an unexpected error.

**Tech Stack:** Node.js 24 built-ins (`node:test`, `fs/promises`, `crypto`, `path`, `process`), PowerShell 7 for verification commands, Git.

## Global Constraints

- Repository changes stay under `<源码目录>`.
- Runtime evidence, renderer assets, caches, and outputs stay under `<用户指定的探测数据目录>`.
- The Steam install `<游戏安装目录>` and backup `<用户备份目录>` are read-only inputs during Stage 1A.
- Do not move, delete, rename, patch, or launch files discovered by the scanner.
- Do not write large files under `C:\Users\YOUR_NAME`; AppData is scan-only.
- Do not log request headers, `x-token`, model gateway tokens, JWTs, mobile numbers, or other credentials.
- Do not bypass DRM, account permissions, Steam ownership, or acquire renderer assets from untrusted redistribution sources.
- Stage 1A exits cleanly as `blocked_missing_renderer` when no complete renderer is found; it must not fabricate readiness.
- The current known Steam identity is app `4532590`, depot `4532591`, build `24943426`, manifest `3483511100282414030`.
- The expected renderer marker is `ovilia_Win64_Development_15918` and the expected executable suffix is `TPRender\Binaries\Win64\Olivia.exe`.

---

## File Structure

- Create `source/renderer-probe/package.json` — isolated dependency-free Node package and test/scan scripts.
- Create `source/renderer-probe/src/layout.js` — validate the I-drive output root and derive evidence/report paths.
- Create `source/renderer-probe/src/redaction.js` — recursively redact secrets before any evidence is serialized.
- Create `source/renderer-probe/src/steam-vdf.js` — parse the bounded subset of Valve KeyValues used by `appmanifest_4532590.acf`.
- Create `source/renderer-probe/src/inventory.js` — bounded, symlink-skipping scan and candidate classification.
- Create `source/renderer-probe/src/binary-evidence.js` — extract printable ASCII/UTF-16LE strings with byte offsets and retain protocol markers only.
- Create `source/renderer-probe/src/candidate.js` — validate `TPRender` structure and hash the candidate manifest without executing it.
- Create `source/renderer-probe/src/report.js` — deterministic JSON and Markdown Stage 1A reports.
- Create `source/renderer-probe/src/cli.js` — CLI parsing, orchestration, exit codes, and final console summary.
- Create `source/renderer-probe/test/*.test.js` — focused tests and temporary fixtures for every module.
- Create `source/renderer-probe/README.md` — exact safe scan and report-review commands.
- Modify `source/README.md` — link the probe and state its Stage 1A-only boundary.

Runtime-only output, never committed:

- `<用户指定的探测数据目录>\evidence\stage1a-report.json`
- `<用户指定的探测数据目录>\evidence\stage1a-report.md`
- `<用户指定的探测数据目录>\evidence\binary-protocol-evidence.json`

## Task 1: I-drive layout and secret redaction

**Files:**
- Create: `source/renderer-probe/package.json`
- Create: `source/renderer-probe/src/layout.js`
- Create: `source/renderer-probe/src/redaction.js`
- Create: `source/renderer-probe/test/layout.test.js`
- Create: `source/renderer-probe/test/redaction.test.js`

**Interfaces:**
- Produces: `resolveProbeLayout(dataRoot, options?) -> ProbeLayout`
- Produces: `assertContained(parent, child) -> string`
- Produces: `redactSecrets(value) -> unknown`
- `ProbeLayout` fields: `root`, `evidenceDir`, `reportJson`, `reportMarkdown`, `binaryEvidenceJson`.

- [ ] **Step 1: Create the isolated package manifest**

```json
{
  "name": "olivia-native-renderer-probe",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js",
    "scan": "node src/cli.js scan"
  },
  "engines": {
    "node": ">=22.5"
  }
}
```

- [ ] **Step 2: Write failing layout tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { assertContained, resolveProbeLayout } from "../src/layout.js";

test("default runtime layout stays on I drive", () => {
  const layout = resolveProbeLayout("I:\\OliviaSoulData\\MidiRenderer");
  assert.equal(layout.root, "I:\\OliviaSoulData\\MidiRenderer");
  assert.equal(layout.reportJson, "I:\\OliviaSoulData\\MidiRenderer\\evidence\\stage1a-report.json");
});

test("production layout rejects a C drive root", () => {
  assert.throws(() => resolveProbeLayout("C:\\temp\\MidiRenderer"), /必须位于 I 盘/u);
});

test("containment rejects path traversal", () => {
  assert.throws(
    () => assertContained("I:\\OliviaSoulData\\MidiRenderer", "I:\\OliviaSoulData\\outside.json"),
    /越过根目录/u,
  );
});
```

- [ ] **Step 3: Run layout tests and verify failure**

Run: `cd /d <源码目录>\source\renderer-probe && node --test test/layout.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/layout.js`.

- [ ] **Step 4: Implement layout validation**

```js
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";

export function assertContained(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${win32.sep}`) || isAbsolute(rel)) {
    throw new Error(`路径越过根目录: ${target}`);
  }
  return target;
}

export function resolveProbeLayout(dataRoot, { requiredDrive = "I:" } = {}) {
  const root = win32.resolve(dataRoot);
  if (win32.parse(root).root.slice(0, 2).toUpperCase() !== requiredDrive.toUpperCase()) {
    throw new Error(`运行数据根目录必须位于 ${requiredDrive.slice(0, 1)} 盘: ${root}`);
  }
  const evidenceDir = assertContained(root, win32.join(root, "evidence"));
  return Object.freeze({
    root,
    evidenceDir,
    reportJson: assertContained(root, win32.join(evidenceDir, "stage1a-report.json")),
    reportMarkdown: assertContained(root, win32.join(evidenceDir, "stage1a-report.md")),
    binaryEvidenceJson: assertContained(root, win32.join(evidenceDir, "binary-protocol-evidence.json")),
  });
}
```

- [ ] **Step 5: Write failing redaction tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/redaction.js";

test("redacts token fields and JWT-looking strings recursively", () => {
  const value = redactSecrets({
    headers: { "x-token": "toy_secret", authorization: "Bearer secret" },
    nested: ["aaa.bbb.ccc", "ovilia_Win64_Development_15918"],
  });
  assert.deepEqual(value, {
    headers: { "x-token": "[REDACTED]", authorization: "[REDACTED]" },
    nested: ["[REDACTED]", "ovilia_Win64_Development_15918"],
  });
});
```

- [ ] **Step 6: Implement recursive redaction**

```js
const SECRET_KEY = /^(authorization|cookie|set-cookie|x-token|model_gateway_token)$/iu;
const JWT = /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/u;
const MOBILE = /\b1\d{10}\b/u;

export function redactSecrets(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string" && (JWT.test(value) || MOBILE.test(value))) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSecrets(item, name)]));
  }
  return value;
}
```

- [ ] **Step 7: Run focused tests**

Run: `node --test --test-name-pattern="layout|redacts" test/layout.test.js test/redaction.test.js`

Expected: PASS with no files created outside the temporary test runner state.

- [ ] **Step 8: Commit Task 1**

```powershell
git add source/renderer-probe/package.json source/renderer-probe/src/layout.js source/renderer-probe/src/redaction.js source/renderer-probe/test/layout.test.js source/renderer-probe/test/redaction.test.js
git commit -m "feat: add safe renderer probe layout"
```

## Task 2: Steam manifest parsing and bounded inventory

**Files:**
- Create: `source/renderer-probe/src/steam-vdf.js`
- Create: `source/renderer-probe/src/inventory.js`
- Create: `source/renderer-probe/test/steam-vdf.test.js`
- Create: `source/renderer-probe/test/inventory.test.js`

**Interfaces:**
- Produces: `parseAppManifest(text) -> SteamAppIdentity`
- Produces: `scanRendererInventory({ roots, steamAppsRoot, marker }) -> Promise<InventoryResult>`
- `SteamAppIdentity` fields: `appId`, `name`, `installDir`, `buildId`, `depots[]`.
- `InventoryResult` fields: `roots[]`, `steam`, `candidates[]`, `markerHits[]`, `warnings[]`.

- [ ] **Step 1: Write failing Steam VDF tests**

```js
test("parses the installed Olivia app and depot identity", () => {
  const result = parseAppManifest(`"AppState"\n{\n"appid" "4532590"\n"name" "BSide: Olivia Lin"\n"installdir" "BSide Olivia Lin Test"\n"buildid" "24943426"\n"InstalledDepots"\n{\n"4532591"\n{\n"manifest" "3483511100282414030"\n"size" "3690442569"\n}\n}\n}`);
  assert.deepEqual(result.depots, [{ depotId: "4532591", manifestId: "3483511100282414030", size: 3690442569 }]);
  assert.equal(result.appId, "4532590");
});
```

- [ ] **Step 2: Run the Steam parser test and verify failure**

Run: `node --test test/steam-vdf.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/steam-vdf.js`.

- [ ] **Step 3: Implement a strict tokenizer and parser for the required VDF subset**

Implement `tokenizeVdf(text)` with `/"((?:\\.|[^"\\])*)"|([{}])/gu`, recursively parse string keys and brace objects, then map only `AppState.appid`, `name`, `installdir`, `buildid`, and `InstalledDepots`. Reject duplicate scalar keys and missing `AppState` instead of guessing.

```js
export function parseAppManifest(text) {
  const root = parseVdf(text);
  const app = root.AppState;
  if (!app || typeof app !== "object") throw new Error("Steam manifest 缺少 AppState");
  const depots = Object.entries(app.InstalledDepots ?? {}).map(([depotId, value]) => ({
    depotId,
    manifestId: String(value.manifest),
    size: Number(value.size),
  }));
  return {
    appId: String(app.appid),
    name: String(app.name),
    installDir: String(app.installdir),
    buildId: String(app.buildid),
    depots,
  };
}
```

- [ ] **Step 4: Write failing bounded-scan tests**

Create temporary fixtures containing:

- `game/version.json` with marker `ovilia_Win64_Development_15918`;
- `game/0.0.9.627/plugins/Studio/NutLivePlayer.dll` containing an ASCII protocol marker;
- `candidate/wallpaper/TPRender/Binaries/Win64/Olivia.exe` with `MZ` bytes;
- a symlink/junction fixture when Windows permits it, otherwise assert the scanner's explicit `isSymbolicLink()` branch using an injected directory reader.

Assert deterministic sorting, candidate classification, marker detection, and skipped symlinks.

- [ ] **Step 5: Implement the bounded scanner**

```js
export async function scanRendererInventory({ roots, steamAppsRoot, marker }) {
  const candidates = [];
  const markerHits = [];
  const warnings = [];
  for (const root of [...roots].sort()) {
    await walkFiles(root, async file => {
      const normalized = file.replaceAll("/", "\\");
      if (/TPRender\\Binaries\\Win64\\Olivia\.exe$/iu.test(normalized)) candidates.push(file);
      if (/version\.json$/iu.test(normalized) && (await readFile(file, "utf8")).includes(marker)) markerHits.push(file);
    }, warnings);
  }
  const manifestPath = join(steamAppsRoot, "appmanifest_4532590.acf");
  const steam = parseAppManifest(await readFile(manifestPath, "utf8"));
  return { roots: [...roots].sort(), steam, candidates: candidates.sort(), markerHits: markerHits.sort(), warnings };
}
```

`walkFiles` must use `opendir`, skip symbolic links/reparse-point-like entries, continue on access errors by appending a warning, and never follow paths outside the supplied root.

- [ ] **Step 6: Run inventory tests**

Run: `node --test test/steam-vdf.test.js test/inventory.test.js`

Expected: PASS; fixture files remain unchanged by pre/post SHA-256 assertions.

- [ ] **Step 7: Commit Task 2**

```powershell
git add source/renderer-probe/src/steam-vdf.js source/renderer-probe/src/inventory.js source/renderer-probe/test/steam-vdf.test.js source/renderer-probe/test/inventory.test.js
git commit -m "feat: inventory native renderer evidence"
```

## Task 3: Sanitized binary protocol evidence

**Files:**
- Create: `source/renderer-probe/src/binary-evidence.js`
- Create: `source/renderer-probe/test/binary-evidence.test.js`

**Interfaces:**
- Consumes: `redactSecrets(value)` from Task 1.
- Produces: `extractPrintableStrings(buffer, options?) -> BinaryString[]`
- Produces: `collectProtocolEvidence(files) -> Promise<ProtocolEvidence>`
- `BinaryString` fields: `encoding`, `offset`, `value`.
- `ProtocolEvidence` fields: `files[]`, `markers[]`, `messages[]`, `paths[]`.

- [ ] **Step 1: Write failing extraction and redaction tests**

```js
test("extracts ASCII and UTF-16LE markers with offsets", () => {
  const buffer = Buffer.concat([
    Buffer.from("xxxxLivePlayerStartNotify\0", "ascii"),
    Buffer.from("render_ready\0", "utf16le"),
  ]);
  const values = extractPrintableStrings(buffer).map(item => item.value);
  assert.ok(values.includes("xxxxLivePlayerStartNotify"));
  assert.ok(values.includes("render_ready"));
});

test("protocol evidence excludes credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "olivia-binary-evidence-"));
  try {
    const file = join(root, "NutLivePlayer.dll");
    await writeFile(file, "Cmd.LivePlayerCtrlNotify.event_name x-token=secret aaa.bbb.ccc");
    const evidence = await collectProtocolEvidence([file]);
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /secret|aaa\.bbb\.ccc/u);
    assert.match(serialized, /LivePlayerCtrlNotify/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the binary evidence test and verify failure**

Run: `node --test test/binary-evidence.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/binary-evidence.js`.

- [ ] **Step 3: Implement ordered ASCII and UTF-16LE extraction**

Scan bytes without decoding the entire binary twice. Emit strings of at least four printable characters, preserving the original byte offset. Filter retained values with this fixed allowlist:

```js
const PROTOCOL_MARKER = /LivePlayer|RenderPlay|PerformanceManager|startPlayingMusic|updatePlan|render_ready|switch_ready|event_(?:name|param)|Cmd\.|ProtoGen|TPRender|ovilia_Win64/iu;
const PATH_MARKER = /(?:[A-Z]:\\|wallpaper\\|TPRender\\|\.proto\b|\.pdb\b)/iu;
```

Pass every retained value through `redactSecrets`; omit any value that becomes `[REDACTED]` rather than preserving its surrounding secret text.

- [ ] **Step 4: Implement deterministic evidence grouping**

For each file, record its SHA-256, byte size, and sanitized matches. Deduplicate by `(value, encoding)` while keeping the lowest byte offset. Classify values containing `Notify`, `Reply`, `event_name`, or `event_param` as `messages`; classify filesystem-looking values as `paths`; sort all arrays by file then byte offset.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/binary-evidence.test.js test/redaction.test.js`

Expected: PASS and test output contains no fixture token value.

- [ ] **Step 6: Commit Task 3**

```powershell
git add source/renderer-probe/src/binary-evidence.js source/renderer-probe/test/binary-evidence.test.js
git commit -m "feat: extract sanitized renderer protocol evidence"
```

## Task 4: Non-executing renderer candidate validation

**Files:**
- Create: `source/renderer-probe/src/candidate.js`
- Create: `source/renderer-probe/test/candidate.test.js`

**Interfaces:**
- Produces: `validateRendererCandidate(executablePath) -> Promise<CandidateValidation>`
- `CandidateValidation` fields: `status`, `rendererRoot`, `executable`, `files[]`, `missing[]`, `totalBytes`.
- Valid `status` values: `complete`, `incomplete`, `invalid_pe`.

- [ ] **Step 1: Write failing candidate tests**

Create complete and incomplete fixtures with this helper. The executable and DLL begin with `MZ`; all files have known contents.

```js
async function createCandidate({ includePak = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "olivia-renderer-candidate-"));
  const renderer = join(root, "wallpaper", "TPRender");
  const bin = join(renderer, "Binaries", "Win64");
  await mkdir(bin, { recursive: true });
  await mkdir(join(renderer, "Content", "Paks"), { recursive: true });
  await mkdir(join(renderer, "Config"), { recursive: true });
  const executable = join(bin, "Olivia.exe");
  await writeFile(executable, Buffer.from([0x4d, 0x5a, 0x01]));
  await writeFile(join(bin, "TPRender-Win64-Shipping.dll"), Buffer.from([0x4d, 0x5a, 0x02]));
  await writeFile(join(renderer, "Config", "DefaultEngine.ini"), "[/Script/Engine.Engine]\n");
  if (includePak) await writeFile(join(renderer, "Content", "Paks", "TPRender-Windows.pak"), "pak-fixture");
  return { root, executable };
}

test("accepts a structurally complete non-executed TPRender candidate", async () => {
  const fixture = await createCandidate();
  try {
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "complete");
    assert.equal(result.missing.length, 0);
    assert.ok(result.files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports missing Paks without launching the executable", async () => {
  const fixture = await createCandidate({ includePak: false });
  try {
    const result = await validateRendererCandidate(fixture.executable);
    assert.equal(result.status, "incomplete");
    assert.ok(result.missing.includes("Content/Paks/*.pak"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run candidate tests and verify failure**

Run: `node --test test/candidate.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/candidate.js`.

- [ ] **Step 3: Implement structural validation**

Resolve the renderer root by walking exactly three parents from `Binaries/Win64/Olivia.exe`. Require:

- executable suffix `TPRender\Binaries\Win64\Olivia.exe`;
- `MZ` header on the executable and sibling DLLs;
- at least one `Content\Paks\*.pak`;
- a `Config` directory containing at least one `.ini`;
- no symlink in the candidate file set.

Hash files using streaming `createReadStream` and `createHash("sha256")`; do not load PAK files into memory and do not call `spawn`, `execFile`, `Start-Process`, or ShellExecute.

- [ ] **Step 4: Run candidate tests**

Run: `node --test test/candidate.test.js`

Expected: PASS; a spy that replaces `node:child_process` must observe zero process launches.

- [ ] **Step 5: Commit Task 4**

```powershell
git add source/renderer-probe/src/candidate.js source/renderer-probe/test/candidate.test.js
git commit -m "feat: validate native renderer candidates"
```

## Task 5: Deterministic Stage 1A decision report and CLI

**Files:**
- Create: `source/renderer-probe/src/report.js`
- Create: `source/renderer-probe/src/cli.js`
- Create: `source/renderer-probe/test/report.test.js`
- Create: `source/renderer-probe/test/cli.test.js`

**Interfaces:**
- Consumes: all Tasks 1–4 interfaces.
- Produces: `buildStage1AReport({ inventory, protocolEvidence, validations, generatedAt }) -> Stage1AReport`
- Produces: `writeStage1AReport(layout, report) -> Promise<void>`
- Produces: `runCli(args, { requiredDrive }?) -> Promise<number>`; the executable entry always uses the default `requiredDrive = "I:"`.
- `Stage1AReport.status`: `candidate_ready` or `blocked_missing_renderer`.

- [ ] **Step 1: Write failing report tests**

```js
const steam = {
  appId: "4532590",
  name: "BSide: Olivia Lin",
  installDir: "BSide Olivia Lin Test",
  buildId: "24943426",
  depots: [{ depotId: "4532591", manifestId: "3483511100282414030", size: 3690442569 }],
};

test("blocks honestly when no complete renderer exists", () => {
  const report = buildStage1AReport({
    inventory: { roots: ["Z:\\game"], steam, candidates: [], markerHits: ["Z:\\game\\version.json"], warnings: [] },
    protocolEvidence: { files: [], markers: ["LivePlayerStartNotify"], messages: [], paths: [] },
    validations: [],
    generatedAt: "2026-08-31T10:00:00.000Z",
  });
  assert.equal(report.status, "blocked_missing_renderer");
  assert.match(report.nextAction, /不得进入 Stage 1B/u);
});

test("marks ready only for a complete validated candidate", () => {
  const report = buildStage1AReport({
    inventory: { roots: ["I:\\candidate"], steam, candidates: ["I:\\candidate\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe"], markerHits: [], warnings: [] },
    protocolEvidence: { files: [], markers: ["LivePlayerStartNotify"], messages: [], paths: [] },
    validations: [{ status: "complete", executable: "I:\\candidate\\wallpaper\\TPRender\\Binaries\\Win64\\Olivia.exe" }],
    generatedAt: "2026-08-31T10:00:00.000Z",
  });
  assert.equal(report.status, "candidate_ready");
});
```

- [ ] **Step 2: Implement atomic, sanitized report writes**

Serialize `redactSecrets(report)` to `stage1a-report.json.partial`, flush/close it, then rename to `stage1a-report.json`. Generate Markdown from the sanitized object only; write its `.partial` and rename. Stable-sort arrays and object keys so identical evidence produces identical content except for the injected `generatedAt`.

- [ ] **Step 3: Write failing CLI tests**

Import `runCli` and invoke it against temporary fixture roots with the dependency argument `{ requiredDrive: win32.parse(fixtureRoot).root.slice(0, 2) }`. Do not expose `requiredDrive` as a command-line flag. Assert:

- complete candidate: exit `0`, JSON report status `candidate_ready`;
- no candidate: exit `2`, JSON report status `blocked_missing_renderer`;
- missing Steam appmanifest: exit `1`, stderr contains `appmanifest_4532590.acf` and no secrets;
- a `C:` production data root passed to `runCli(args)` without injection: exit `1`, no report files created.

- [ ] **Step 4: Implement exact CLI contract**

```text
node src/cli.js scan \
  --data-root <用户指定的探测数据目录> \
  --game-root "<游戏安装目录>" \
  --backup-root <用户备份目录> \
  --appdata-root "C:\Users\YOUR_NAME\AppData\Roaming\miHoYo\Olivia-steam" \
  --steamapps-root <Steam库目录>
```

Reject unknown flags and missing values. The fixed scan roots are `game-root`, `backup-root`, and `appdata-root`; the last is read-only. Binary evidence inputs are:

- `<game-root>\0.0.9.627\plugins\Studio\NutLivePlayer.dll`
- `<game-root>\0.0.9.627\plugins\Studio\NutStudioPlugin.dll`
- `<game-root>\version.json`

Write `protocolEvidence` atomically to `layout.binaryEvidenceJson` after applying `redactSecrets`, then write the decision report. Console output is one sanitized JSON line containing only `status`, `reportJson`, and counts. Never echo arguments containing headers or tokens.

- [ ] **Step 5: Run report and CLI tests**

Run: `node --test test/report.test.js test/cli.test.js`

Expected: PASS for all four exit-code cases.

- [ ] **Step 6: Run the complete package tests**

Run: `npm test`

Expected: all tests PASS with zero network calls and zero child renderer processes.

- [ ] **Step 7: Commit Task 5**

```powershell
git add source/renderer-probe/src/report.js source/renderer-probe/src/cli.js source/renderer-probe/test/report.test.js source/renderer-probe/test/cli.test.js
git commit -m "feat: report renderer recovery readiness"
```

## Task 6: Operator documentation and real read-only baseline scan

**Files:**
- Create: `source/renderer-probe/README.md`
- Modify: `source/README.md`
- Runtime create: `<用户指定的探测数据目录>\evidence\stage1a-report.json`
- Runtime create: `<用户指定的探测数据目录>\evidence\stage1a-report.md`
- Runtime create: `<用户指定的探测数据目录>\evidence\binary-protocol-evidence.json`

**Interfaces:**
- Consumes: CLI from Task 5.
- Produces: reviewed Stage 1A decision and the exact input hashes needed for the Stage 1B plan.

- [ ] **Step 1: Write the operator README**

Document prerequisites (`node >=22.5`, PowerShell), the exact scan command from Task 5, exit codes `0/1/2`, all read-only input roots, all I-drive output paths, credential-redaction guarantees, and the rule that Stage 1B is forbidden unless status is `candidate_ready`.

Include this recovery statement verbatim:

```text
本工具不会下载、移动、删除、修补或启动任何游戏/渲染器文件。它只建立资产证据、哈希和下一阶段决策。blocked_missing_renderer 是有效且诚实的完成状态。
```

- [ ] **Step 2: Link the tool from `source/README.md`**

Add a “原生渲染器可行性探测” paragraph pointing to `renderer-probe/README.md`, explicitly separating it from `local-service` and stating that it does not yet generate MIDI video.

- [ ] **Step 3: Capture immutable pre-scan hashes**

Run:

```powershell
$game = '<游戏安装目录>'
$backup = '<用户备份目录>'
Get-FileHash -Algorithm SHA256 -LiteralPath `
  "$game\version.json", `
  "$game\0.0.9.627\plugins\Studio\NutLivePlayer.dll", `
  "$game\0.0.9.627\plugins\Studio\NutStudioPlugin.dll", `
  "$backup\SHA256SUMS.csv" |
  Sort-Object Path |
  ConvertTo-Json -Depth 3
```

Save the console output in the implementation turn notes; do not write it into either input root.

- [ ] **Step 4: Run the real scan from the I-drive project**

```powershell
Set-Location '<源码目录>\source\renderer-probe'
node src/cli.js scan `
  --data-root '<用户指定的探测数据目录>' `
  --game-root '<游戏安装目录>' `
  --backup-root '<用户备份目录>' `
  --appdata-root 'C:\Users\YOUR_NAME\AppData\Roaming\miHoYo\Olivia-steam' `
  --steamapps-root '<Steam库目录>'
```

Expected: exit `0` with `candidate_ready` if a structurally complete `TPRender` is found; otherwise exit `2` with `blocked_missing_renderer`. Exit `2` is the expected result for the currently observed machine state and is not converted into a success claim.

- [ ] **Step 5: Verify report redaction and I-drive containment**

```powershell
$evidence = '<用户指定的探测数据目录>\evidence'
rg -n -i 'x-token|authorization|model_gateway_token|Bearer |eyJ[A-Za-z0-9_-]+\.' $evidence
if ($LASTEXITCODE -eq 0) { throw 'evidence contains a possible credential' }
Get-ChildItem -LiteralPath $evidence -File |
  ForEach-Object {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
    [pscustomobject]@{ FullName = $_.FullName; Length = $_.Length; LastWriteTime = $_.LastWriteTime; SHA256 = $hash.Hash }
  } |
  Format-Table -AutoSize
```

Expected: `rg` finds no credential pattern; all three report files resolve beneath the I-drive evidence directory.

- [ ] **Step 6: Re-run pre-scan hashes and compare**

Run the Step 3 command again and compare every SHA-256. Expected: all hashes exactly match; the scan changed no Steam or backup input.

- [ ] **Step 7: Run regression tests**

```powershell
Set-Location '<源码目录>\source\renderer-probe'
npm test
Set-Location '<源码目录>\source\local-service'
npm test
```

Expected: renderer-probe tests and the existing OliviaSoul local-service suite all PASS.

- [ ] **Step 8: Commit documentation**

```powershell
Set-Location '<源码目录>'
git add source/renderer-probe/README.md source/README.md
git commit -m "docs: document native renderer recovery probe"
```

- [ ] **Step 9: Enforce the Stage 1A decision gate**

If `stage1a-report.json.status` is `candidate_ready`, stop and write a new Stage 1B implementation plan using the candidate's real hashes, executable layout, extracted message names, and observed configuration. Do not launch it under this plan.

If status is `blocked_missing_renderer`, report the exact scanned roots, Steam app/depot/build/manifest identity, missing renderer structure, and protocol evidence already recovered. Do not begin MIDI endpoints, client patches, or video generation until the user supplies a legitimate renderer source or chooses design方案 B/C.

## Self-Review Record

- Spec coverage: This plan covers only the approved design's Stage 1A asset recovery, validation, I-drive storage, immutability, redaction, evidence, and decision gate. IPC launch and short-scale playback are intentionally split into Stage 1B because their exact implementation depends on the recovered renderer binary and configuration.
- Placeholder scan: No deferred implementation markers or undefined generic error-handling instructions remain. The two Stage 1A outcomes and their next actions are explicit.
- Type consistency: `ProbeLayout`, `SteamAppIdentity`, `InventoryResult`, `ProtocolEvidence`, `CandidateValidation`, and `Stage1AReport` producers/consumers use the same names throughout.
