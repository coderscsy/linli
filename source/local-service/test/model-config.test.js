import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeModelProfile,
  buildChatRequest,
  readModelConfig,
  setActiveProvider,
  writeModelProfile,
} from "../model-config.js";

test("模型档案从旧 DeepSeek 配置迁移且两套配置互不覆盖", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-model-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = join(root, ".cursor", "secrets");
  await mkdir(secrets, { recursive: true });
  const legacyPath = join(secrets, "deepseek.env");
  const legacyBytes = Buffer.from([
    "DEEPSEEK_API_KEY=legacy-key",
    "DEEPSEEK_CUSTOM=1",
    "DEEPSEEK_MODEL=legacy-model",
    "DEEPSEEK_BASE=https://legacy.example/v1/",
    "",
  ].join("\n"), "utf8");
  await writeFile(legacyPath, legacyBytes);

  const before = await readModelConfig({ root, env: {} });
  assert.equal(before.activeProvider, "deepseek");
  assert.deepEqual(before.profiles.deepseek, {
    provider: "deepseek",
    baseUrl: "https://legacy.example/v1",
    model: "legacy-model",
    authMode: "bearer",
    apiKey: "legacy-key",
    keyConfigured: true,
  });
  assert.deepEqual(before.profiles.local, {
    provider: "local",
    baseUrl: "https://m4.tailf0d018.ts.net/v1",
    model: "gemma-4-26b-a4b-it-ultra-uncensored-heretic",
    authMode: "none",
    apiKey: "",
    keyConfigured: false,
  });

  const after = await writeModelProfile({
    root,
    provider: "local",
    profile: {
      baseUrl: "http://127.0.0.1:8000/v1/",
      model: "gemma-local",
      authMode: "none",
      apiKey: "",
    },
  });
  assert.equal(after.activeProvider, "deepseek");
  assert.deepEqual(after.profiles.deepseek, before.profiles.deepseek);
  assert.equal(after.profiles.local.baseUrl, "http://127.0.0.1:8000/v1");
  assert.deepEqual(await readFile(legacyPath), legacyBytes);

  const activated = await setActiveProvider({ root, provider: "local" });
  assert.equal(activated.activeProvider, "local");
  assert.equal(activeModelProfile(activated).model, "gemma-local");
  assert.equal((await readModelConfig({ root, env: {} })).activeProvider, "local");
});

test("模型请求按当前档案构造且本地无鉴权不携带 DeepSeek 字段", () => {
  const messages = [{ role: "user", content: "只回复 OK" }];
  const local = buildChatRequest({
    provider: "local",
    baseUrl: "https://m4.tailf0d018.ts.net/v1/",
    model: "gemma-local",
    authMode: "none",
    apiKey: "",
  }, {
    messages,
    temperature: 0.2,
    maxTokens: 64,
    thinking: { type: "disabled" },
    reasoning_effort: "low",
  });
  assert.equal(local.url, "https://m4.tailf0d018.ts.net/v1/chat/completions");
  assert.deepEqual(local.headers, { "Content-Type": "application/json" });
  assert.deepEqual(local.body, {
    model: "gemma-local",
    messages,
    temperature: 0.2,
    max_tokens: 64,
  });

  const deepseek = buildChatRequest({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-pro",
    authMode: "bearer",
    apiKey: "ds-key",
  }, {
    messages,
    temperature: 0.3,
    maxTokens: 128,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.equal(deepseek.url, "https://api.deepseek.com/chat/completions");
  assert.equal(deepseek.headers.Authorization, "Bearer ds-key");
  assert.deepEqual(deepseek.body.thinking, { type: "enabled" });
  assert.equal(deepseek.body.reasoning_effort, "high");
});

test("模型档案拒绝非法 provider 地址换行和缺失的 Bearer 密钥", async t => {
  const root = await mkdtemp(join(tmpdir(), "olivia-model-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    setActiveProvider({ root, provider: "automatic" }),
    /provider/u,
  );
  await assert.rejects(
    writeModelProfile({
      root,
      provider: "local",
      profile: { baseUrl: "file:///tmp/model", model: "gemma", authMode: "none", apiKey: "" },
    }),
    /地址/u,
  );
  await assert.rejects(
    writeModelProfile({
      root,
      provider: "local",
      profile: { baseUrl: "http://127.0.0.1:8000/v1", model: "gemma\nunsafe", authMode: "none", apiKey: "" },
    }),
    /换行/u,
  );
  assert.throws(() => buildChatRequest({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    authMode: "bearer",
    apiKey: "",
  }, { messages: [] }), /API Key/u);
});
