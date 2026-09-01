# Manual Model Provider Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing DeepSeek integration while adding a separately persisted local Gemma profile that the user selects manually, with no automatic provider fallback.

**Architecture:** A focused `model-config.js` module owns the two provider profiles, migration from `deepseek.env`, validation, request construction, and redaction. The Node service exposes provider-neutral admin APIs while keeping the old DeepSeek APIs as compatibility aliases. The PowerShell reply/memory pipeline and the management page both read the same active provider, so every model-backed workflow switches together.

**Tech Stack:** Node.js 22 ESM, `node:test`, PowerShell 5.1, HTML/CSS/JavaScript, OpenAI-compatible `/chat/completions` APIs.

## Global Constraints

- Work only in `I:\Tools\OliviaSoul-reference-2b56a78e\.worktrees\native-renderer-recovery` on `feature/native-renderer-recovery`.
- Keep `Z:\SteamLibrary\steamapps\common\BSide Olivia Lin Test` and `I:\Backups\BSide-Olivia-Lin-2026-08-31` read-only.
- Persist `activeProvider=deepseek|local`; only an explicit user action may change it.
- Never call the unselected provider after a failure.
- Preserve existing `deepseek.env` unchanged and import its values only as a compatibility source.
- Default DeepSeek profile: `https://api.deepseek.com`, `deepseek-v4-pro`, `authMode=bearer`.
- Default local profile: `https://m4.tailf0d018.ts.net/v1`, `gemma-4-26b-a4b-it-ultra-uncensored-heretic`, `authMode=none`.
- Do not log API keys, Authorization headers, letter bodies, or full model responses.
- Keep the existing video-reply read/play/upload/Range path unchanged and covered by regression tests.

---

## File Structure

- Create `source/local-service/model-config.js`: two-profile persistence, migration, validation, active-profile selection, OpenAI request construction, and safe error labels.
- Create `source/local-service/test/model-config.test.js`: focused profile, migration, validation, request-shape, and no-fallback tests.
- Create `source/.cursor/skills/fit-letters/scripts/model-call.ps1`: provider-neutral PowerShell request helper used by replies and memory work.
- Modify `source/local-service/server.js`: provider-neutral admin APIs, compatibility aliases, and active-provider generation.
- Modify `source/local-service/transcription.js`: use the active provider for transcript organization.
- Modify `source/.cursor/skills/fit-letters/scripts/ds-call.ps1`: delegate model requests to `model-call.ps1` without changing higher-level Harness behavior.
- Modify `source/.cursor/skills/fit-letters/scripts/deepseek-reply.ps1`: read the active profile through the shared helper.
- Modify `source/local-service/public/index.html`: add the manual provider selector and separate DeepSeek/local profile fields.
- Modify `source/local-service/public/app.js`: load, save, test, and explicitly activate profiles without overwriting the other profile.
- Modify `source/local-service/public/styles.css`: style the provider selector using the existing settings theme.
- Modify `source/local-service/test/api.test.js`: service/API/UI compatibility and video-reply regression assertions.

### Task 1: Add two-profile configuration and request construction

**Files:**
- Create: `source/local-service/model-config.js`
- Create: `source/local-service/test/model-config.test.js`

**Interfaces:**
- `readModelConfig({ root, env }) -> Promise<{ activeProvider, profiles }>`
- `writeModelProfile({ root, provider, profile }) -> Promise<ModelConfig>`
- `setActiveProvider({ root, provider }) -> Promise<ModelConfig>`
- `activeModelProfile(config) -> ModelProfile`
- `buildChatRequest(profile, payload) -> { url, headers, body }`
- Persistent file: `.cursor/secrets/model.env` with `MODEL_ACTIVE_PROVIDER`, `MODEL_DEEPSEEK_*`, and `MODEL_LOCAL_*` keys.

- [ ] **Step 1: Write failing migration and independence tests**

Create a temporary root with `.cursor/secrets/deepseek.env`, call `readModelConfig`, and assert the DeepSeek profile imports the old key/model/base while the local profile receives the confirmed defaults. Save a changed local profile and assert the DeepSeek profile and original `deepseek.env` bytes are unchanged.

```js
assert.equal(config.activeProvider, "deepseek");
assert.equal(config.profiles.deepseek.apiKey, "legacy-key");
assert.equal(config.profiles.local.model, "gemma-4-26b-a4b-it-ultra-uncensored-heretic");
assert.deepEqual(after.profiles.deepseek, before.profiles.deepseek);
assert.deepEqual(await readFile(legacyPath), legacyBytes);
```

- [ ] **Step 2: Write failing request-shape and validation tests**

Assert local/no-auth emits no `Authorization`, `thinking`, or `reasoning_effort`; DeepSeek/bearer emits `Authorization: Bearer ...`; `/v1/` produces exactly `/v1/chat/completions`; CR/LF values, invalid providers, invalid URLs, and bearer-without-key are rejected.

```js
assert.equal(local.headers.Authorization, undefined);
assert.equal(local.url, "https://m4.tailf0d018.ts.net/v1/chat/completions");
assert.equal(deepseek.headers.Authorization, "Bearer ds-key");
assert.throws(() => buildChatRequest(badProfile, payload), /API Key/u);
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `node --test test/model-config.test.js`

Expected: FAIL because `model-config.js` does not exist.

- [ ] **Step 4: Implement the minimal model configuration module**

Parse simple `KEY=value` files without executing them. Normalize base URLs by removing trailing slashes, allow only `http:` or `https:`, allow only `deepseek|local` and `bearer|none`, reject CR/LF in all persisted values, and write UTF-8 without BOM. `buildChatRequest` must construct one request for the supplied profile and must not contain fallback or retry-provider logic.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test test/model-config.test.js`

Expected: all focused tests PASS.

```powershell
git add source/local-service/model-config.js source/local-service/test/model-config.test.js
git commit -m "feat: persist switchable model profiles"
```

### Task 2: Route every Node model workflow through the active profile

**Files:**
- Modify: `source/local-service/server.js`
- Modify: `source/local-service/transcription.js`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- Add `GET /admin/api/model` returning both profiles plus `activeProvider`.
- Add `POST /admin/api/model/profile` saving exactly one named profile without activation.
- Add `POST /admin/api/model/activate` accepting `{ provider: "deepseek"|"local" }`.
- Add `POST /admin/api/model/test` accepting `{ provider }` and testing that profile without activation.
- Keep `/admin/api/deepseek` and `/admin/api/deepseek/test` as compatibility aliases for the DeepSeek profile.

- [ ] **Step 1: Write failing API tests for independent save and manual activation**

Save the local profile, verify DeepSeek remains unchanged, activate local, restart the fixture, and verify local remains active. Test DeepSeek without changing `activeProvider`.

```js
assert.equal(saved.activeProvider, "deepseek");
assert.equal(saved.profiles.local.baseUrl, localBase);
assert.equal(activated.activeProvider, "local");
assert.equal(reloaded.activeProvider, "local");
```

- [ ] **Step 2: Write failing routing and no-fallback tests**

Inject a request spy, activate local, send one generation request, and assert exactly one call targets the local URL with no Authorization header. Make that call return 503 and assert the response names `local` while the spy still contains exactly one call and no DeepSeek URL.

```js
assert.equal(calls.length, 1);
assert.match(calls[0].url, /m4\.tailf0d018\.ts\.net\/v1\/chat\/completions$/u);
assert.equal(calls[0].options.headers.Authorization, undefined);
assert.doesNotMatch(calls.map(call => call.url).join("\n"), /api\.deepseek\.com/u);
```

- [ ] **Step 3: Run the API tests and confirm RED**

Run: `node --test --test-name-pattern="模型档案|手动切换|模型失败不回退" test/api.test.js`

Expected: FAIL because the provider-neutral endpoints do not exist.

- [ ] **Step 4: Implement provider-neutral Node routing**

Replace direct `readDeepSeekConfig` use in generation, AI import, summary, and transcription organization with `activeModelProfile(await readModelConfig(...))`. Use `buildChatRequest` once per model attempt. Existing retry behavior may repeat the same current profile for transient errors but must never substitute the other provider. Redact bearer values and response bodies from thrown errors.

- [ ] **Step 5: Preserve compatibility aliases**

Map the old DeepSeek GET/POST/test routes to only the DeepSeek profile. Saving or testing through an old route must not change `activeProvider`. Keep the old response fields `{ apiKey, keyConfigured, custom, model, baseUrl }` so an older management UI continues to work.

- [ ] **Step 6: Run focused and full tests, then commit**

Run:

```powershell
node --test --test-name-pattern="模型档案|手动切换|模型失败不回退|DeepSeek 设置" test/api.test.js
npm test
```

Expected: all tests PASS.

```powershell
git add source/local-service/server.js source/local-service/transcription.js source/local-service/test/api.test.js
git commit -m "feat: route model work through selected provider"
```

### Task 3: Switch the PowerShell Harness and management UI manually

**Files:**
- Create: `source/.cursor/skills/fit-letters/scripts/model-call.ps1`
- Modify: `source/.cursor/skills/fit-letters/scripts/ds-call.ps1`
- Modify: `source/.cursor/skills/fit-letters/scripts/deepseek-reply.ps1`
- Modify: `source/local-service/public/index.html`
- Modify: `source/local-service/public/app.js`
- Modify: `source/local-service/public/styles.css`
- Modify: `source/local-service/test/api.test.js`

**Interfaces:**
- `Import-ModelConfig -Root <path>` loads `.cursor/secrets/model.env`, with legacy DeepSeek fallback.
- `Invoke-ModelChat -Messages <array> [-Temperature <double>] [-MaxTokens <int>]` calls only the loaded active profile.
- UI controls: `#modelProvider`, `#activateModelProvider`, per-profile inputs, and per-profile connectivity-test buttons.

- [ ] **Step 1: Write failing PowerShell contract tests**

Add static and executable tests proving `ds-call.ps1` and `deepseek-reply.ps1` import `model-call.ps1`, local/no-auth omits Authorization and DeepSeek-only fields, and a local 503 never invokes the fake DeepSeek listener.

- [ ] **Step 2: Write failing management UI tests**

Assert the page contains a two-option selector, separate DeepSeek/local panels, an explicit activation button, the confirmed Gemma default, and no checkbox that implicitly overwrites the active profile. Assert UI save/test requests include an explicit provider.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `node --test --test-name-pattern="PowerShell 模型切换|管理页手动切换模型" test/api.test.js`

Expected: FAIL because the shared helper and controls do not exist.

- [ ] **Step 4: Implement the shared PowerShell caller**

Move only transport/config selection into `model-call.ps1`. Keep prompt construction and Harness validation in their existing scripts. Load one active profile per invocation, build one URL, add Authorization only for bearer mode, and keep retries on that same profile.

- [ ] **Step 5: Implement the management UI**

Render the active provider prominently. Editing, saving, or testing a profile must not activate it. The activation button must send `/admin/api/model/activate`, refresh the active badge, and leave both forms populated with their saved values. Display provider-specific errors without exposing keys.

- [ ] **Step 6: Run full regression tests including video reply**

Run:

```powershell
node --test --test-name-pattern="PowerShell 模型切换|管理页手动切换模型|视频附件支持校验" test/api.test.js
npm test
```

Expected: provider-switch and existing MP4 upload/detail/Range tests PASS; the full suite has zero failures.

- [ ] **Step 7: Perform a safe live local connectivity check and commit**

Call `GET https://m4.tailf0d018.ts.net/v1/models`, verify HTTP 200 and the configured Gemma model ID, then use the local admin connectivity endpoint with a synthetic prompt only. Do not send archived letters or memory content.

```powershell
git add source/.cursor/skills/fit-letters/scripts/model-call.ps1 source/.cursor/skills/fit-letters/scripts/ds-call.ps1 source/.cursor/skills/fit-letters/scripts/deepseek-reply.ps1 source/local-service/public/index.html source/local-service/public/app.js source/local-service/public/styles.css source/local-service/test/api.test.js
git commit -m "feat: add manual DeepSeek and Gemma switch"
```

## Acceptance Checklist

- [ ] Existing DeepSeek settings migrate without modifying `deepseek.env`.
- [ ] DeepSeek and local Gemma values remain independent across save, activation, and restart.
- [ ] Only explicit activation changes `activeProvider`.
- [ ] Local requests omit Authorization by default and use the exact confirmed Gemma model.
- [ ] Provider failure never triggers a request to the other provider.
- [ ] Reply, memory, AI import, and transcript organization share the active provider.
- [ ] Existing video-reply upload, playback, and Range tests still pass.
- [ ] Full Node test suite passes with zero failures.
- [ ] No game or backup directory is modified by this feature.
