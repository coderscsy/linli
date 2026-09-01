# Linli README and Windows Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inherited README with an independent user guide and publish verified Windows installer and portable assets for `coderscsy/linli` release `2008.2.7-linli.1`.

**Architecture:** README and packaged usage text become the user-facing source of truth for this fork. The existing release script remains the single build entry point, but moves all writable build caches to repository-local I-drive paths and emits SHA-256 checksums automatically. GitHub receives the tested source commit first, then a release tag and four verified assets from the I-drive release directory.

**Tech Stack:** Markdown, Node.js 22 `node:test`, PowerShell 5.1, .NET Framework 4.6.2, Inno Setup 6, GitHub CLI.

## Global Constraints

- Repository: `https://github.com/coderscsy/linli`; default branch `main`.
- Release tag: `2008.2.7-linli.1`; application version stays `2008.2.7`.
- All build caches and artifacts must be written on I:; do not place large outputs on C:.
- Keep `Z:\SteamLibrary\steamapps\common\BSide Olivia Lin Test` and `I:\Backups\BSide-Olivia-Lin-2026-08-31` read-only.
- Do not publish secrets, `.env`, SQLite databases, logs, caches, personal letters, memories, or game assets.
- Video attachment replies remain supported; automatic Lin Li character voice-video generation must be described as unavailable.
- Do not force-push or overwrite an existing conflicting release tag.

---

### Task 1: Replace inherited user documentation

**Files:**
- Modify: `README.md`
- Modify: `source/local-service/packaging/使用说明.txt`

**Interfaces:**
- Produces: README download URLs under `https://github.com/coderscsy/linli/releases/download/2008.2.7-linli.1/`.
- Produces: packaged instructions covering manual `deepseek|local` selection and the local Gemma default.

- [ ] **Step 1: Rewrite README and packaged instructions**

Write a concise user guide with these exact sections:

```markdown
# 林离离线增强版
## 下载
## 主要功能
## 首次使用
## 视频回信说明
## 数据与隐私
## 开发与验证
## 来源与声明
```

Use exact release asset links, explain manual activation rather than implicit switching, keep the game-directory installation warning prominent, and retain only a brief upstream attribution in the final section.

- [ ] **Step 2: Review the human-facing documentation**

Read both rendered documents and verify every required section is present, all binary links use the exact fork release URL, the upstream release URL is absent, and the video-generation boundary is explicit. Human prose is not protected with source-text regression tests.

- [ ] **Step 3: Commit the documentation**

```powershell
git add README.md source/local-service/packaging/使用说明.txt source/local-service/test/api.test.js
git commit -m "docs: publish linli user guide"
```

### Task 2: Keep build writes on I and generate checksums

**Files:**
- Modify: `source/local-service/packaging/build-release.ps1`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Build command: `build-release.ps1 -OutputDirectory <I-drive path>`.
- Diagnostic command: `build-release.ps1 -OutputDirectory <I-drive path> -ResolvePathsOnly` outputs one JSON object without compiling or downloading.
- Checksum command: `build-release.ps1 -OutputDirectory <I-drive path> -ChecksumOnly` hashes existing setup and portable assets.
- Produces: installer, portable ZIP, `使用说明.txt`, and `SHA256SUMS.txt` in the chosen output directory.

- [ ] **Step 1: Add failing executable build-contract tests**

Create I-drive temporary directories. Execute the real PowerShell script in both diagnostic modes and assert observable output:

```js
const resolved = JSON.parse(paths.stdout);
assert.match(resolved.buildTools, /^I:[\\/]/u);
assert.equal(resolved.buildTools, join(project, "dist-native", "build-tools"));
assert.equal(resolved.outputDirectory, output);
assert.equal(await readFile(join(output, "SHA256SUMS.txt"), "utf8"), [
  "8FB6D5F37E8055CE720BD0B1D56587F88C0071F285966BA17E72B2B12672AA73  OliviaSoul-2008.2.7-Setup.exe",
  "01E782826AE5182220BD6158F883D01CEB1BCE659DC020E7C511F802A9AA7737  OliviaSoul-2008.2.7-Portable.zip",
  "",
].join("\n"));
```

- [ ] **Step 2: Run focused test and confirm RED**

Run:

```powershell
node --test --test-name-pattern="发布构建路径与校验和" test/api.test.js
```

Expected: FAIL because `-ResolvePathsOnly` and `-ChecksumOnly` do not exist.

- [ ] **Step 3: Implement repository-local build tooling and checksum output**

In `build-release.ps1`:

```powershell
param([switch]$ResolvePathsOnly, [switch]$ChecksumOnly)
$buildTools = Join-Path $project "dist-native\build-tools"
$downloadCache = Join-Path $buildTools "downloads"
$env:DOTNET_CLI_HOME = Join-Path $buildTools "dotnet-home"
$env:NUGET_PACKAGES = Join-Path $buildTools "nuget-packages"
```

Return the resolved paths as JSON and exit when `-ResolvePathsOnly` is supplied. Use `$buildTools\dotnet\dotnet.exe` as the optional bundled SDK location. Put checksum creation in one function used by both the normal successful build and `-ChecksumOnly`; hash the setup executable and portable ZIP in that order and write UTF-8 without BOM:

```powershell
$artifacts = @(
    (Join-Path $OutputDirectory "OliviaSoul-$version-Setup.exe"),
    $portable
)
$checksumLines = foreach ($artifact in $artifacts) {
    if (-not (Test-Path -LiteralPath $artifact)) { throw "发布产物缺失：$artifact" }
    $hash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
    "$hash  $([IO.Path]::GetFileName($artifact))"
}
[IO.File]::WriteAllText(
    (Join-Path $OutputDirectory "SHA256SUMS.txt"),
    ($checksumLines -join "`n") + "`n",
    $utf8NoBom
)
```

- [ ] **Step 4: Run focused and full tests**

Run:

```powershell
node --test --test-name-pattern="发布构建路径与校验和" test/api.test.js
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit build changes**

```powershell
git add source/local-service/packaging/build-release.ps1 source/local-service/test/api.test.js
git commit -m "build: keep linli release artifacts on i drive"
```

### Task 3: Build and inspect the Windows release

**Files:**
- Generated, ignored: `release/OliviaSoul-2008.2.7-Setup.exe`
- Generated, ignored: `release/OliviaSoul-2008.2.7-Portable.zip`
- Modified: `release/SHA256SUMS.txt`
- Modified: `release/使用说明.txt`

**Interfaces:**
- Consumes: the build command and documentation from Tasks 1-2.
- Produces: four GitHub Release assets.

- [ ] **Step 1: Check build prerequisites without installing to C**

Verify `node_modules`, `dotnet.exe`, and Inno Setup 6 are available. If a dependency is missing, place only downloadable build tooling under `source/local-service/dist-native/build-tools` on I:.

- [ ] **Step 2: Run the full Windows build**

```powershell
Set-Location source\local-service
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\build-release.ps1 -OutputDirectory "I:\Tools\OliviaSoul-reference-2b56a78e\.worktrees\native-renderer-recovery\release"
```

Expected: exit code 0 and `Olivia Soul release: ...\release`.

- [ ] **Step 3: Verify checksums independently**

Read `SHA256SUMS.txt`, recompute SHA-256 for the setup executable and portable ZIP, and require exact matches.

- [ ] **Step 4: Inspect portable ZIP contents**

List the ZIP entries without extracting to C. Require at least:

```text
OliviaSoul.exe
app/model-config.js
app/public/index.html
resources/workspace-template/.cursor/skills/fit-letters/scripts/model-call.ps1
runtime/node.exe
runtime/whisper/ggml-small.bin
```

Reject entries matching `.cursor/secrets`, `.env`, `.sqlite`, `.db`, `.log`, personal memory paths, or BSide game executables/resources.

- [ ] **Step 5: Verify installer metadata and artifact sizes**

Require both binary assets to be non-empty and record their size and hash. Use `Get-AuthenticodeSignature` only as informational evidence because the installer is not code-signed.

- [ ] **Step 6: Commit tracked release metadata**

```powershell
git add release/SHA256SUMS.txt release/使用说明.txt
git commit -m "release: prepare 2008.2.7-linli.1 assets"
```

### Task 4: Publish source and GitHub Release

**Files:**
- No new source files.
- Upload assets from `release/`.

**Interfaces:**
- Target branch: `coderscsy/linli:main`.
- Target tag: `2008.2.7-linli.1` at the verified source commit.

- [ ] **Step 1: Perform final pre-publish verification**

Run `npm test`, `git status -sb`, and confirm the worktree is clean. Confirm `gh auth status` is authenticated as `coderscsy`. Confirm the target tag and release do not already exist.

- [ ] **Step 2: Push the tested commit to target main without force**

Because this checkout originated as a partial clone, use the already verified full-history publishing method if a direct push again produces an incomplete thin pack. Push `HEAD:refs/heads/main` to the `linli` remote and compare `git ls-remote` SHA with local `HEAD`.

- [ ] **Step 3: Create the release**

Create a non-draft, non-prerelease GitHub Release titled `林离离线增强版 2008.2.7-linli.1` with the four assets. The body must summarize the feature set, installation warning, manual model switching, and video-generation limitation.

- [ ] **Step 4: Verify the published release**

Use `gh release view 2008.2.7-linli.1 --repo coderscsy/linli --json ...` and require:

- tag target equals local `HEAD`;
- release is published and not draft/prerelease;
- exactly four expected asset names are present;
- remote asset sizes equal the local files;
- README download links return the published asset URLs.

- [ ] **Step 5: Report delivery**

Provide the repository URL, release URL, commit SHA, asset names, sizes, SHA-256 values, test count, and the explicit limitation that automatic character voice-video generation is not included.
