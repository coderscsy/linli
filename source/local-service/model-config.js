import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_DEEPSEEK_PROFILE = Object.freeze({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  authMode: "bearer",
  apiKey: "",
});

export const DEFAULT_LOCAL_PROFILE = Object.freeze({
  provider: "local",
  baseUrl: "https://m4.tailf0d018.ts.net/v1",
  model: "gemma-4-26b-a4b-it-ultra-uncensored-heretic",
  authMode: "none",
  apiKey: "",
});

const PROVIDERS = new Set(["deepseek", "local"]);
const AUTH_MODES = new Set(["bearer", "none"]);

function assertSingleLine(value, label) {
  const text = String(value ?? "");
  if (/[\r\n]/u.test(text)) throw new Error(`${label} 不能包含换行`);
  return text.trim();
}

function normalizeProvider(provider) {
  const value = assertSingleLine(provider, "provider");
  if (!PROVIDERS.has(value)) throw new Error("provider 只能是 deepseek 或 local");
  return value;
}

function normalizeBaseUrl(value) {
  const text = assertSingleLine(value, "模型地址").replace(/\/+$/u, "");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("请填写有效的模型地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("请填写有效的模型地址");
  return text;
}

function normalizeProfile(provider, profile, { requireBearerKey = false } = {}) {
  const selected = normalizeProvider(provider);
  const authMode = assertSingleLine(profile.authMode, "鉴权方式") || (selected === "deepseek" ? "bearer" : "none");
  if (!AUTH_MODES.has(authMode)) throw new Error("鉴权方式只能是 bearer 或 none");
  const apiKey = assertSingleLine(profile.apiKey, "API Key");
  if (requireBearerKey && authMode === "bearer" && !apiKey) throw new Error("Bearer 鉴权需要填写 API Key");
  const model = assertSingleLine(profile.model, "模型名");
  if (!model) throw new Error("请填写模型名");
  return {
    provider: selected,
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    model,
    authMode,
    apiKey,
    keyConfigured: Boolean(apiKey),
  };
}

async function readEnvFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const values = {};
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return values;
}

function persistedProfile(provider, values, legacy, env) {
  const prefix = provider === "deepseek" ? "MODEL_DEEPSEEK" : "MODEL_LOCAL";
  const defaults = provider === "deepseek" ? DEFAULT_DEEPSEEK_PROFILE : DEFAULT_LOCAL_PROFILE;
  const legacyValues = provider === "deepseek" ? {
    apiKey: legacy.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY,
    model: legacy.DEEPSEEK_MODEL ?? env.DEEPSEEK_MODEL,
    baseUrl: legacy.DEEPSEEK_BASE ?? env.DEEPSEEK_BASE,
  } : {};
  return normalizeProfile(provider, {
    baseUrl: values[`${prefix}_BASE`] ?? legacyValues.baseUrl ?? defaults.baseUrl,
    model: values[`${prefix}_MODEL`] ?? legacyValues.model ?? defaults.model,
    authMode: values[`${prefix}_AUTH_MODE`] ?? defaults.authMode,
    apiKey: values[`${prefix}_API_KEY`] ?? legacyValues.apiKey ?? defaults.apiKey,
  });
}

function serialize(config) {
  const deepseek = config.profiles.deepseek;
  const local = config.profiles.local;
  return [
    `MODEL_ACTIVE_PROVIDER=${config.activeProvider}`,
    `MODEL_DEEPSEEK_BASE=${deepseek.baseUrl}`,
    `MODEL_DEEPSEEK_MODEL=${deepseek.model}`,
    `MODEL_DEEPSEEK_AUTH_MODE=${deepseek.authMode}`,
    `MODEL_DEEPSEEK_API_KEY=${deepseek.apiKey}`,
    `MODEL_LOCAL_BASE=${local.baseUrl}`,
    `MODEL_LOCAL_MODEL=${local.model}`,
    `MODEL_LOCAL_AUTH_MODE=${local.authMode}`,
    `MODEL_LOCAL_API_KEY=${local.apiKey}`,
    "",
  ].join("\n");
}

async function persist(root, config) {
  const secrets = join(root, ".cursor", "secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "model.env"), serialize(config), "utf8");
  return config;
}

export async function readModelConfig({ root, env = process.env }) {
  const secrets = join(root, ".cursor", "secrets");
  const [values, legacy] = await Promise.all([
    readEnvFile(join(secrets, "model.env")),
    readEnvFile(join(secrets, "deepseek.env")),
  ]);
  const activeProvider = normalizeProvider(values.MODEL_ACTIVE_PROVIDER ?? "deepseek");
  return {
    activeProvider,
    profiles: {
      deepseek: persistedProfile("deepseek", values, legacy, env),
      local: persistedProfile("local", values, legacy, env),
    },
  };
}

export async function writeModelProfile({ root, provider, profile }) {
  const selected = normalizeProvider(provider);
  const config = await readModelConfig({ root });
  config.profiles[selected] = normalizeProfile(selected, profile, { requireBearerKey: true });
  return persist(root, config);
}

export async function setActiveProvider({ root, provider }) {
  const selected = normalizeProvider(provider);
  const config = await readModelConfig({ root });
  config.activeProvider = selected;
  return persist(root, config);
}

export function activeModelProfile(config) {
  const provider = normalizeProvider(config.activeProvider);
  return config.profiles[provider];
}

export function buildChatRequest(profile, payload = {}) {
  const selected = normalizeProfile(profile.provider, profile, { requireBearerKey: true });
  const body = {
    model: selected.model,
    messages: payload.messages ?? [],
  };
  if (payload.temperature !== undefined) body.temperature = payload.temperature;
  if (payload.maxTokens !== undefined) body.max_tokens = payload.maxTokens;
  if (selected.provider === "deepseek") {
    if (payload.thinking !== undefined) body.thinking = payload.thinking;
    if (payload.reasoning_effort !== undefined) body.reasoning_effort = payload.reasoning_effort;
  }
  const headers = { "Content-Type": "application/json" };
  if (selected.authMode === "bearer") headers.Authorization = `Bearer ${selected.apiKey}`;
  return {
    url: `${selected.baseUrl}/chat/completions`,
    headers,
    body,
  };
}
