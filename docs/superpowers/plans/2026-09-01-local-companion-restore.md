# Local Companion Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an I-drive independent BSide client that keeps the Steam installation and backups unchanged, restores the 129-song offline catalog including all 13 light-music songs, and provides local mailbox, Gemma replies, unlimited letters, and MP4 video replies.

**Architecture:** A verified PowerShell installer copies the owned game and clean front end into `I:\OliviaSoulLocal\BSide`. The existing Node service gains a read-only catalog adapter and generic OpenAI-compatible model configuration, while a hash-gated front-end patch uses the local catalog first and the native `getOfflineSongList` bridge as fallback. The native desktop host supports an explicit portable data root so new runtime data stays on I.

**Tech Stack:** PowerShell 5.1, Node.js 22 ESM with `node:test` and `node:sqlite`, .NET 8 WinForms/WebView2, HTML/CSS/JavaScript, ZIP-based `feapp.dat` patching.

## Global Constraints

- Treat `Z:\SteamLibrary\steamapps\common\BSide Olivia Lin Test`, Steam manifests, and `I:\Backups\BSide-Olivia-Lin-2026-08-31` as read-only inputs.
- Write the independent runtime only under `I:\OliviaSoulLocal\BSide`; do not place new media, databases, build caches, or models on C.
- I is exFAT and reports `Warning / Full Repair Needed`: do not use hard links, do not assume transactional rename, and stop on any new read/write/hash error.
- Do not delete or move the existing C-drive cache in this plan.
- Do not bypass Steam/DRM. If the copied client cannot start through the user's valid Steam session, stop at the documented fallback boundary.
- Patch only client `0.0.9.627`, front end `frontend-tp-beta_cn_b776ad35_455e162`, and the explicitly recorded clean/patched hashes.
- The local service listens only on `127.0.0.1`; never fall back to the retired official business API.
- Keep the catalog archive read-only and avoid duplicating its 59,365,972,637 bytes by default.
- Never log letter bodies, model credentials, Authorization/Cookie/JWT values, or complete signed catalog URLs.
- Every code task follows red-green-refactor and ends with a focused commit.

---

## File Structure

- Create `source/local-service/catalog.js`: validate the archived catalog, normalize the 129 songs, map signed URLs to local files, and serve byte ranges.
- Create `source/local-service/model-config.js`: read/write backward-compatible model settings and build auth-aware OpenAI-compatible requests.
- Create `source/tools/new-independent-client.ps1`: verify source layout, copy the game, install the clean front end, and emit hash manifests plus the launcher.
- Create `source/tools/test-independent-client.ps1`: validate an installed independent tree without modifying it.
- Create `.cursor/skills/fit-letters/scripts/model-call.ps1`: provider-neutral PowerShell model request used by both live replies and memory summaries.
- Modify `source/local-service/server.js`: wire catalog/model/quota endpoints without mixing their implementation into the existing large server file.
- Modify `source/local-service/test/api.test.js`: add focused integration tests for catalog, ranges, model auth, unlimited quota, patching, and portable install.
- Modify `source/tools/patch-feapp-local.ps1`: add hash gating, local catalog loading, mailbox visibility, and offline request exceptions.
- Modify `source/tools/get-feapp-status.ps1`: report patch revision, target build, service port, and catalog routing state.
- Modify `source/local-service/native-host/AppPaths.cs`: honor an explicit `OLIVIA_SOUL_HOME` portable data root.
- Modify `source/local-service/native-host/NodeBackend.cs`: pass catalog and runtime roots to the Node backend.
- Modify `source/local-service/desktop/controller.js`: expose independent-install status and reject a selected Z-drive client for independent mode.
- Modify `source/local-service/desktop/node-host.js`: accept `--catalog-root` and pass it to `createOliviaService`.
- Modify `source/local-service/public/index.html`, `public/app.js`, and `public/styles.css`: expose model provider, no-auth mode, catalog integrity, and independent-client status.
- Modify `source/local-service/packaging/build-release.ps1`: stage new modules/scripts without copying secrets or catalog media.
- Modify `source/local-service/README.md` and root `README.md`: document double-click start, catalog source, recovery, and verification boundaries.

### Task 1: Freeze the owned inputs and install contract

**Files:**
- Create: `source/tools/new-independent-client.ps1`
- Create: `source/tools/test-independent-client.ps1`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Consumes: `-GameRoot`, `-CleanFeapp`, `-CatalogRoot`, `-DestinationRoot`.
- Produces: `recovery/source-hashes.json`, `recovery/copy-hashes.json`, `recovery/install-state.json`, `recovery/feapp-original.dat`, and exit code 0 only after all hashes match.

- [x] **Step 1: Write the failing fixture test**

Add a test that creates a tiny fake `0.0.9.627` client, invokes `new-independent-client.ps1`, and asserts that source/copy SHA-256 values match and all output paths are under the temporary destination. Add a second assertion that a destination on the same path as `-GameRoot` is rejected.

```js
assert.equal(state.version, "0.0.9.627");
assert.equal(state.filesVerified, 3);
assert.equal(state.sourceManifestSha256, state.copyManifestSha256);
await assert.rejects(runInstaller({ destinationRoot: gameRoot }), /独立目录/u);
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `node --test --test-name-pattern="独立客户端复制" test/api.test.js`

Expected: FAIL because `new-independent-client.ps1` does not exist.

- [x] **Step 3: Implement the verified installer**

The script must resolve literal absolute paths, reject overlap, require the exact version layout, hash every source file before copying, copy with `Copy-Item -LiteralPath`, replace only the copied `feapp.dat` with `-CleanFeapp`, hash every destination file, and write JSON using UTF-8 without BOM. It must never remove an existing non-empty destination; a retry may continue only when `install-state.json` names the same sources and every existing file verifies.

- [x] **Step 4: Implement the read-only verifier and rerun the focused test**

`test-independent-client.ps1` must recalculate hashes and emit `{ valid, mismatches, version, catalogRoot }` as compact JSON. Run the focused test again and expect PASS.

- [x] **Step 5: Run the installer against the real inputs in manifest-only mode**

Run with `-WhatIfManifestOnly` against the Z client, clean front end `C:\Users\sycan\AppData\Roaming\OliviaSoul\client-backups\daa132980f27b2fa84165d5f74f582eb.feapp.dat`, and the I backup catalog. Expect no writes outside a temporary I-drive test directory and record the two known front-end hashes in the test fixture.

- [x] **Step 6: Commit**

```powershell
git add source/tools/new-independent-client.ps1 source/tools/test-independent-client.ps1 source/local-service/test/api.test.js
git commit -m "feat: add verified independent client installer"
```

### Task 2: Keep runtime data on I

**Files:**
- Modify: `source/local-service/native-host/AppPaths.cs`
- Modify: `source/local-service/native-host/NodeBackend.cs`
- Modify: `source/local-service/desktop/node-host.js`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Consumes: environment variables `OLIVIA_SOUL_HOME` and `OLIVIA_SOUL_CATALOG_ROOT`.
- Produces: `AppPaths.UserData`, `Workspace`, `Data`, and backend options rooted under the requested I directory.

- [ ] **Step 1: Write a failing portable-root test**

Compile a small test invocation of the native host path resolver with `OLIVIA_SOUL_HOME=I:\OliviaSoulLocal\BSide\runtime` and assert that no returned writable path begins with `%APPDATA%`.

```csharp
Assert.Equal(@"I:\OliviaSoulLocal\BSide\runtime", paths.UserData);
Assert.Equal(@"I:\OliviaSoulLocal\BSide\runtime\data", paths.Data);
```

- [ ] **Step 2: Run and confirm failure**

Run: `dotnet test` for the path-resolver test project created inside the test temporary directory.

Expected: FAIL because `AppPaths.Detect()` currently hardcodes ApplicationData.

- [ ] **Step 3: Implement explicit portable-path resolution**

Use `Path.GetFullPath`, reject relative/root-only paths, create no directories during detection, and fall back to current `%APPDATA%\OliviaSoul` behavior only when the environment variable is absent. Pass `--catalog-root` through `NodeBackend` and `node-host.js` without putting it in logs.

- [ ] **Step 4: Verify**

Run the focused native test, `dotnet build source/local-service/native-host/OliviaSoul.csproj -c Release`, and the Node host argument test. Expect PASS and zero errors.

- [ ] **Step 5: Commit**

```powershell
git add source/local-service/native-host/AppPaths.cs source/local-service/native-host/NodeBackend.cs source/local-service/desktop/node-host.js source/local-service/test/api.test.js
git commit -m "feat: support I-drive portable runtime data"
```

### Task 3: Load and verify the archived catalog

**Files:**
- Create: `source/local-service/catalog.js`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Produces: `loadCatalog({ root, resourceBaseUrl }) -> CatalogSnapshot` and `CatalogSnapshot.resolveResource(resourceId) -> { path, bytes, sha256, contentType }`.
- `CatalogSnapshot.index` has `{ performanceModes, musicStyles, songs, stats, integrity }` and exactly 129 songs on the real archive.

- [ ] **Step 1: Write failing parser tests with a small fixture**

Create test JSON for one light-music song and three resources. Assert query strings are removed before manifest lookup, every emitted media URL uses `/toy/catalog/resource/<sha256>`, and traversal file names are rejected.

```js
assert.equal(snapshot.index.stats.total, 1);
assert.match(snapshot.index.songs[0].audioUrl, /\/toy\/catalog\/resource\/[a-f0-9]{64}$/u);
assert.throws(() => snapshot.resolveResource("../secret"), /资源标识/u);
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="本地曲库清单" test/api.test.js`

Expected: FAIL because `catalog.js` does not exist.

- [ ] **Step 3: Implement strict catalog parsing**

Read only `music-type-info.json`, `song-stats.json`, the three `songs-*-items.json` files, and `catalog-resource-manifest.json`. Require `status === "saved"`, a 64-character SHA-256, non-negative byte size, a file name without separators, and a resolved resource path contained by `catalog-resources`. Convert snake_case fields to the camel-case contract already consumed by `y1` in the client.

- [ ] **Step 4: Add the real-archive integrity test**

When the known backup path exists, assert `13 + 48 + 68 = 129`, `1,218` saved resources, `0` failed resources, and `59,365,972,637` total bytes. Skip with an explicit reason only on machines without that user-owned backup.

- [ ] **Step 5: Run tests and commit**

Run: `node --test --test-name-pattern="本地曲库清单" test/api.test.js`

```powershell
git add source/local-service/catalog.js source/local-service/test/api.test.js
git commit -m "feat: index archived offline music catalog"
```

### Task 4: Serve the catalog and media locally

**Files:**
- Modify: `source/local-service/server.js`
- Modify: `source/local-service/catalog.js`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Adds `GET /toy/catalog/index`, `GET /toy/catalog/status`, and `GET|HEAD /toy/catalog/resource/:sha256`.
- `createOliviaService({ catalogRoot })` accepts the read-only archive root.

- [ ] **Step 1: Write failing HTTP and Range tests**

Assert the index is plain JSON suitable for direct `fetch`, status reports the three counts, a full GET returns correct MIME/length, `Range: bytes=2-5` returns 206 and `Content-Range`, HEAD returns headers without a body, and an invalid hash returns 404.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="曲库 HTTP|曲库 Range" test/api.test.js`

- [ ] **Step 3: Implement streaming service**

Reuse the proven video Range rules, open resources read-only, stream only the requested byte window, set `Accept-Ranges: bytes`, and never read a whole MP4/WAV into memory. Index responses must replace all retired signed URLs with loopback resource URLs.

- [ ] **Step 4: Verify no official fallback**

Inject a fetch spy and assert catalog loading performs zero requests to `*.miyoushe.com`; missing/corrupt archive data returns local status `unavailable` with the exact failing file, not remote URLs.

- [ ] **Step 5: Run tests and commit**

```powershell
npm test
git add source/local-service/server.js source/local-service/catalog.js source/local-service/test/api.test.js
git commit -m "feat: serve archived catalog over loopback"
```

### Task 5: Route the offline client to the local catalog

**Files:**
- Modify: `source/tools/patch-feapp-local.ps1`
- Modify: `source/tools/get-feapp-status.ps1`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Patch marker becomes `OliviaSoulPatch:local-companion-v1`.
- Offline load order is local `/toy/catalog/index`, then native `getOfflineSongList`; retired HTTP APIs are never a fallback.

- [ ] **Step 1: Write failing patch-contract tests**

The test must patch the clean 27,740,616-byte front end, reopen the ZIP, and assert exactly one local catalog URL, `N3=!0`, preserved `Xm()` native fallback, and unchanged unknown official endpoints. A wrong input SHA-256 and a second patch attempt must fail without changing the file.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="本地曲库前端补丁" test/api.test.js`

- [ ] **Step 3: Implement exact-string, hash-gated patching**

Patch only the single offline catalog loader expression. Use browser `fetch()` for loopback so the Axios offline interceptor remains intact. If local fetch fails or returns a non-OK status, call the existing `Xm()` bridge. Keep MIDI hidden in this phase (`Ss=!1`) and keep video-reply mapping.

- [ ] **Step 4: Extend status inspection**

Return `{ clientFound, mounted, revision, port, mailboxEnabled, catalogEnabled, nativeCatalogFallback }`. Require every boolean to be true before the desktop UI reports a valid mount.

- [ ] **Step 5: Verify and commit**

```powershell
npm test
git add source/tools/patch-feapp-local.ps1 source/tools/get-feapp-status.ps1 source/local-service/test/api.test.js
git commit -m "feat: connect offline client to local catalog"
```

### Task 6: Add a Gemma-compatible model provider

**Files:**
- Create: `source/local-service/model-config.js`
- Create: `.cursor/skills/fit-letters/scripts/model-call.ps1`
- Modify: `.cursor/skills/fit-letters/scripts/deepseek-reply.ps1`
- Modify: `.cursor/skills/fit-letters/scripts/ds-call.ps1`
- Modify: `source/local-service/server.js`
- Modify: `source/local-service/transcription.js`
- Modify: `source/local-service/public/index.html`
- Modify: `source/local-service/public/app.js`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Configuration fields: `{ provider, baseUrl, model, authMode, apiKey }` where `provider` is `deepseek|gemma|custom` and `authMode` is `bearer|none`.
- Backward compatibility: existing `DEEPSEEK_*` values are read once and projected to the new model config without deleting the old file.

- [ ] **Step 1: Write failing request-shape tests**

For Gemma/no-auth, assert no `Authorization`, `thinking`, or `reasoning_effort`. For DeepSeek/bearer, assert the current fields remain. Assert `baseUrl` ending in `/v1` produces exactly one `/chat/completions` suffix.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="Gemma 模型配置" test/api.test.js`

- [ ] **Step 3: Implement provider-neutral config and requests**

Keep secrets only in `workspace/.cursor/secrets/model.env`, reject CR/LF in every value, allow an empty key only for `authMode=none`, and redact credentials from thrown HTTP errors. The two PowerShell callers must import the same helper so live replies and memory summaries cannot drift.

- [ ] **Step 4: Update the management UI and connectivity test**

Add provider/auth selectors, label the model generically, and test `GET/POST /admin/api/model` plus `POST /admin/api/model/test`. Keep `/admin/api/deepseek` as a compatibility alias for one release.

- [ ] **Step 5: Verify against a local fake Gemma server and commit**

Run the fake server test with a `gemma-*` model response, then `npm test`.

```powershell
git add source/local-service/model-config.js source/local-service/server.js source/local-service/transcription.js source/local-service/public/index.html source/local-service/public/app.js source/local-service/test/api.test.js .cursor/skills/fit-letters/scripts/model-call.ps1 .cursor/skills/fit-letters/scripts/deepseek-reply.ps1 .cursor/skills/fit-letters/scripts/ds-call.ps1
git commit -m "feat: support local Gemma model providers"
```

### Task 7: Make the letter limit configurable and unlimited by default

**Files:**
- Modify: `source/local-service/server.js`
- Modify: `source/local-service/public/index.html`
- Modify: `source/local-service/public/app.js`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Setting `daily_letter_limit`: integer `0..999`, where `0` means unlimited.
- API responses add `dailyLimit` and use `remainingToday: null` when unlimited.

- [ ] **Step 1: Replace the old three-letter test with failing compatibility tests**

Assert four consecutive sends succeed by default, a configured limit of 3 rejects the fourth with `-10401`, failed generations do not consume quota, and reset still works for a finite limit.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="信件限额" test/api.test.js`

- [ ] **Step 3: Implement the setting and admin UI**

Centralize quota calculation in `letterQuota(userId, at) -> { limit, used, remaining }`. Do not use truthiness for unlimited state. Render “不限次数” instead of interpolating `null`.

- [ ] **Step 4: Run focused and full tests**

Run the focused test, then `npm test`; both must pass.

- [ ] **Step 5: Commit**

```powershell
git add source/local-service/server.js source/local-service/public/index.html source/local-service/public/app.js source/local-service/test/api.test.js
git commit -m "feat: make local letter quota unlimited by default"
```

### Task 8: Expose independent install, launch, and recovery

**Files:**
- Modify: `source/local-service/desktop/controller.js`
- Modify: `source/local-service/native-host/DesktopBridge.cs`
- Modify: `source/local-service/public/index.html`
- Modify: `source/local-service/public/app.js`
- Modify: `source/local-service/public/styles.css`
- Modify: `source/tools/new-independent-client.ps1`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Desktop bridge adds `installIndependentClient()`, `getIndependentClientStatus()`, `startIndependentClient()`, and `verifyIndependentClient()`.
- Launcher sets `OLIVIA_SOUL_HOME` and `OLIVIA_SOUL_CATALOG_ROOT`, starts the service first, checks `/admin/api/status`, then starts the copied game executable.

- [ ] **Step 1: Write failing controller tests**

Mock process spawning and assert install/launch uses the I destination, refuses Z as a destination, never passes secrets on the command line, and does not kill unrelated Node or game processes.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="独立版本启动" test/api.test.js`

- [ ] **Step 3: Implement bridge and UI**

Show source, destination, clean front-end hash, catalog counts, last verification, and a single “验证并启动独立版” action. Failure dialogs must distinguish copy/hash error, catalog error, service error, Steam launch rejection, and I-drive I/O error.

- [ ] **Step 4: Implement recovery**

Recovery replaces only the independent copy's `feapp.dat` from `recovery/feapp-original.dat` after hash verification. It must not touch the Z installation or the I backup catalog.

- [ ] **Step 5: Verify and commit**

```powershell
npm test
dotnet build source/local-service/native-host/OliviaSoul.csproj -c Release
git add source/local-service/desktop/controller.js source/local-service/native-host/DesktopBridge.cs source/local-service/public/index.html source/local-service/public/app.js source/local-service/public/styles.css source/tools/new-independent-client.ps1 source/local-service/test/api.test.js
git commit -m "feat: add independent client launch and recovery"
```

### Task 9: Package and perform final evidence-based verification

**Files:**
- Modify: `source/local-service/packaging/build-release.ps1`
- Modify: `source/local-service/packaging/使用说明.txt`
- Modify: `source/local-service/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces an installer/portable service package without game binaries, catalog media, credentials, databases, logs, or user letters.

- [ ] **Step 1: Write failing packaging allowlist tests**

Assert the staged package includes `catalog.js`, `model-config.js`, the provider-neutral PowerShell helper, and both installer/verifier scripts. Assert it excludes `.env`, SQLite files, catalog media, game EXEs, PAKs, logs, and letters.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test --test-name-pattern="发布白名单" test/api.test.js`

- [ ] **Step 3: Update packaging and user documentation**

Document the double-click path, the exact I/Z/backup boundaries, how to verify 13/48/68 counts, how to restore the independent front end, and that MIDI/TPRender remains a later phase.

- [ ] **Step 4: Run automated verification**

```powershell
Set-Location source/local-service
npm test
dotnet build native-host/OliviaSoul.csproj -c Release
npm run build:win
```

Expected: all Node tests pass; Release build has zero errors; package build emits hashes; the allowlist scan finds no private files.

- [ ] **Step 5: Run real-data read-only acceptance**

Verify the Z source hashes before and after are identical; verify the I independent copy; load 13 light-music, 48 classical, and 68 ACG songs; sample at least three songs per category for cover/audio/default-video/Range; send four letters through a fake/local Gemma endpoint; attach one MP4 and play it as a video reply; confirm no request targets retired official business/static domains.

- [ ] **Step 6: Record field limits and commit**

State whether the copied game launched through Steam, whether real Gemma was reachable, and that no TPRender/MIDI renderer was tested in this phase.

```powershell
git add source/local-service/packaging/build-release.ps1 source/local-service/packaging/使用说明.txt source/local-service/README.md README.md source/local-service/test/api.test.js
git commit -m "docs: ship local companion restore workflow"
```

## Self-Review Result

- Spec coverage: independent copy, I-only new runtime data, clean recovery, local catalog, 13 light-music songs, Gemma, mailbox, unlimited letters, MP4 replies, loopback-only service, and no DRM bypass each map to a task.
- Deferred by design: MIDI task APIs and TPRender integration remain separate sub-projects and are not falsely included in this phase.
- Placeholder scan: no implementation placeholder remains; every task names its files, interfaces, failing test, verification command, and commit boundary.
- Type consistency: catalog, model, quota, installer, and desktop interfaces are defined once and reused by later tasks.
