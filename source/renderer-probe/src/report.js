import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { assertContained } from "./layout.js";
import { redactSecrets } from "./redaction.js";

const SECRET_KEY = /^(authorization|cookie|set-cookie|x-token|model_gateway_token)$/iu;
const CREDENTIAL_SIGNAL = /\b(?:authorization|cookie|set-cookie|x-token|model_gateway_token)\b|\bBearer\b|[?&](?:token|access_token|api_key|x-token)=|\b(?:token|access_token|api_key)\s*[:=]/iu;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;
const PARTIAL_SUFFIX = ".partial";

export function buildStage1AReport({ inventory, protocolEvidence, validations, generatedAt }) {
  const input = redactSecrets({ inventory, protocolEvidence, validations, generatedAt });
  if (typeof input.generatedAt !== "string") throw new TypeError("generatedAt 必须是字符串");

  const normalizedValidations = normalizeValidations(input.validations);
  const ready = normalizedValidations.some(validation => validation?.status === "complete");
  const report = {
    generatedAt: sanitizeString(input.generatedAt),
    inventory: normalizeInventory(input.inventory),
    nextAction: ready
      ? "已找到结构完整且已验证的候选；可单独规划 Stage 1B，但本阶段仍不得启动候选。"
      : "未找到结构完整且已验证的候选；不得进入 Stage 1B。",
    protocolEvidence: normalizeProtocolEvidence(input.protocolEvidence),
    status: ready ? "candidate_ready" : "blocked_missing_renderer",
    validations: normalizedValidations,
  };
  return canonicalize(sanitizeObject(redactSecrets(report)));
}

export async function writeStage1AReport(layout, report) {
  const safeReport = canonicalize(sanitizeObject(redactSecrets(report)));
  const json = `${JSON.stringify(safeReport, null, 2)}\n`;
  const markdown = renderMarkdown(safeReport, json);
  const targets = validateLayout(layout, [layout?.reportJson, layout?.reportMarkdown]);
  await prepareOutputDirectory(layout.root, layout.evidenceDir, targets);

  const prepared = [];
  try {
    prepared.push(await prepareAtomicWrite(layout.root, targets[0], json));
    prepared.push(await prepareAtomicWrite(layout.root, targets[1], markdown));
    for (const item of prepared) await commitAtomicWrite(item);
  } catch (error) {
    await Promise.all(prepared.map(cleanOwnedPartial));
    throw error;
  }
}

function normalizeInventory(value) {
  const inventory = recordOrEmpty(value);
  const roots = stringArray(inventory.roots).sort(compareText);
  const candidates = stringArray(inventory.candidates).sort(compareText);
  const markerHits = stringArray(inventory.markerHits).sort(compareText);
  return {
    candidates: candidates.map((_, index) => `<candidate-${index + 1}>/TPRender/Binaries/Win64/Olivia.exe`),
    markerHits: markerHits.map((_, index) => `<marker-hit-${index + 1}>/version.json`),
    roots: roots.map((_, index) => `<scan-root-${index + 1}>`),
    steam: sanitizeObject(inventory.steam ?? {}),
    warnings: arrayOrEmpty(inventory.warnings).map(sanitizeObject),
  };
}

function normalizeProtocolEvidence(value) {
  const evidence = recordOrEmpty(value);
  const sourceFiles = arrayOrEmpty(evidence.files)
    .map(item => recordOrEmpty(item))
    .sort((left, right) => compareText(stringOrEmpty(left.path), stringOrEmpty(right.path)) || compareCanonical(left, right));
  const labels = new Map();
  for (const [index, file] of sourceFiles.entries()) labels.set(stringOrEmpty(file.path), `<protocol-input-${index + 1}>`);

  const files = sourceFiles.map((file, index) => {
    const output = { path: `<protocol-input-${index + 1}>` };
    for (const key of ["error", "matches", "sha256", "size"]) {
      if (Object.hasOwn(file, key)) output[key] = sanitizeObject(file[key]);
    }
    return output;
  });
  return {
    files,
    markers: normalizeProtocolRecords(evidence.markers, labels, false),
    messages: normalizeProtocolRecords(evidence.messages, labels, false),
    paths: normalizeProtocolRecords(evidence.paths, labels, true),
  };
}

function normalizeProtocolRecords(values, labels, pathValues) {
  const ordered = arrayOrEmpty(values).sort(compareCanonical);
  return ordered.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return sanitizeObject(item);
    const record = {};
    for (const key of ["encoding", "offset", "value"]) {
      if (!Object.hasOwn(item, key)) continue;
      record[key] = key === "value" && pathValues ? `<binary-path-${index + 1}>` : sanitizeObject(item[key]);
    }
    if (Object.hasOwn(item, "file")) record.file = labels.get(stringOrEmpty(item.file)) ?? "<protocol-input-unknown>";
    return record;
  });
}

function normalizeValidations(values) {
  return arrayOrEmpty(values).sort(compareCanonical).map((value, index) => {
    const validation = recordOrEmpty(value);
    const output = {};
    for (const key of ["files", "missing", "status", "totalBytes"]) {
      if (Object.hasOwn(validation, key)) output[key] = sanitizeObject(validation[key]);
    }
    if (Object.hasOwn(validation, "rendererRoot")) {
      output.rendererRoot = ABSOLUTE_PATH.test(stringOrEmpty(validation.rendererRoot))
        ? `<candidate-validation-${index + 1}>/TPRender`
        : sanitizeObject(validation.rendererRoot);
    }
    if (Object.hasOwn(validation, "executable")) {
      output.executable = ABSOLUTE_PATH.test(stringOrEmpty(validation.executable))
        ? `<candidate-validation-${index + 1}>/TPRender/Binaries/Win64/Olivia.exe`
        : sanitizeObject(validation.executable);
    }
    return output;
  });
}

function sanitizeObject(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    output[key] = sanitizeObject(item);
  }
  return output;
}

function sanitizeString(value) {
  if (value === "[REDACTED]" || CREDENTIAL_SIGNAL.test(value)) return "[REDACTED]";
  if (ABSOLUTE_PATH.test(value) || /[A-Za-z]:[\\/]Users[\\/]/iu.test(value)) return "<absolute-path>";
  return value;
}

function canonicalize(value) {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return null;
  if (Array.isArray(value)) return value.map(canonicalize).sort(compareCanonical);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort(compareText)) output[key] = canonicalize(value[key]);
  return output;
}

function renderMarkdown(report, json) {
  return [
    "# Stage 1A Renderer Recovery Decision",
    "",
    `- Status: \`${report.status}\``,
    `- Generated at: \`${report.generatedAt}\``,
    `- Next action: ${report.nextAction}`,
    "",
    "## Sanitized evidence",
    "",
    "```json",
    json.trimEnd(),
    "```",
    "",
  ].join("\n");
}

function validateLayout(layout, targets) {
  if (!layout || typeof layout !== "object" || typeof layout.root !== "string" || typeof layout.evidenceDir !== "string") {
    throw new TypeError("报告布局无效");
  }
  const root = layout.root;
  const evidenceDir = assertContained(root, layout.evidenceDir);
  return targets.map(target => {
    if (typeof target !== "string") throw new TypeError("报告目标无效");
    const contained = assertContained(root, target);
    assertContained(evidenceDir, contained);
    if (dirname(contained) !== evidenceDir) throw new Error("报告目标必须直接位于 evidence 目录");
    assertContained(root, `${contained}${PARTIAL_SUFFIX}`);
    return contained;
  });
}

async function prepareOutputDirectory(root, evidenceDir, targets) {
  const containedEvidence = assertContained(root, evidenceDir);
  await mkdir(containedEvidence, { recursive: true });
  const rootCanonical = await realpath(root);
  const evidenceStats = await lstat(containedEvidence);
  if (evidenceStats.isSymbolicLink() || !evidenceStats.isDirectory()) throw new Error("evidence 目录无效");
  const evidenceCanonical = await realpath(containedEvidence);
  assertContained(rootCanonical, evidenceCanonical);
  for (const target of targets) await rejectUnsafeExistingTarget(target);
}

async function rejectUnsafeExistingTarget(target) {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("报告目标类型无效");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function prepareAtomicWrite(root, target, contents) {
  const partial = assertContained(root, `${target}${PARTIAL_SUFFIX}`);
  let handle;
  let owned = false;
  const item = { target, partial, owned: false, identity: undefined };
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await open(partial, flags, 0o600);
    owned = true;
    item.owned = true;
    item.identity = await handle.stat({ bigint: true });
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return item;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (owned) await cleanOwnedPartial(item);
    throw error;
  }
}

async function commitAtomicWrite(item) {
  if (!item.owned || !await stillOwned(item)) throw new Error("报告 partial 在提交前发生变化");
  await rejectUnsafeExistingTarget(item.target);
  await rename(item.partial, item.target);
  item.owned = false;
}

async function cleanOwnedPartial(item) {
  if (!item.owned || !await stillOwned(item)) return;
  try {
    await unlink(item.partial);
    item.owned = false;
  } catch {
    // Best effort only: never broaden cleanup beyond the exact partial created here.
  }
}

async function stillOwned(item) {
  try {
    const current = await lstat(item.partial, { bigint: true });
    return sameIdentity(item.identity, current) && current.isFile() && !current.isSymbolicLink();
  } catch {
    return false;
  }
}

function sameIdentity(left, right) {
  if (!left || !right || typeof left.dev !== typeof right.dev || typeof left.ino !== typeof right.ino) return false;
  return left.dev === right.dev && left.ino === right.ino;
}

function arrayOrEmpty(value) { return Array.isArray(value) ? value : []; }
function stringArray(value) { return arrayOrEmpty(value).filter(item => typeof item === "string"); }
function recordOrEmpty(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function stringOrEmpty(value) { return typeof value === "string" ? value : ""; }
function compareCanonical(left, right) { return compareText(JSON.stringify(left), JSON.stringify(right)); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
