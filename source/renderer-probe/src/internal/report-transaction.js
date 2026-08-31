import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { assertContained } from "../layout.js";

const LOCK_NAME = ".stage1a-transaction.lock";
const CREDENTIAL_SIGNAL = /\b(?:authorization|cookie|set-cookie|x-token|model_gateway_token)\b|\bBearer\b|[?&](?:token|access_token|api_key|x-token)=|\b(?:token|access_token|api_key)\s*[:=]/iu;
const EMBEDDED_ABSOLUTE_PATH = /(?:(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])|(?<![A-Za-z0-9_>/])\/[^/\s]+(?:\/[^/\s]*)*)/u;
const JWT = /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/u;
const MOBILE = /\b1\d{10}\b/u;
const DECIMAL_ID = /^\d{1,20}$/u;
const FIXED_HEX = /^[A-Fa-f0-9]{64}$/u;
const CANDIDATE_LABEL = /^candidate-[1-9]\d*$/u;
const INVENTORY_CANDIDATE_EXECUTABLE = /^<candidate-[1-9]\d*>\/TPRender\/Binaries\/Win64\/Olivia\.exe$/u;
const VALIDATION_EXECUTABLE = /^(?:<candidate(?:-[1-9]\d*)?>\/)?TPRender\/Binaries\/Win64\/Olivia\.exe$/u;
const CANDIDATE_RENDERER_ROOT = /^(?:<candidate(?:-[1-9]\d*)?>\/)?TPRender$/u;
const GENERATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REPORT_STATUS = new Set(["candidate_ready", "blocked_missing_renderer"]);
const VALIDATION_STATUS = new Set(["complete", "incomplete", "invalid_pe"]);
const MAX_ARRAY_ITEMS = 100_000;

export const DEFAULT_TRANSACTION_FS = Object.freeze({ link, lstat, mkdir, open, randomUUID, realpath, unlink });

export function discoverStage1APrincipals(value) {
  const principals = new Set();
  collectStage1APrincipals(value, principals, new WeakSet());
  return principals;
}

export function canonicalizeStage1AReportForPersistence(report, principals = discoverStage1APrincipals(report)) {
  return normalizeStage1AReport(report, principals);
}

export function createStage1AReportArtifacts(layout, report, principals = discoverStage1APrincipals(report)) {
  const safeReport = canonicalizeStage1AReportForPersistence(report, principals);
  const json = `${JSON.stringify(safeReport, null, 2)}\n`;
  const markdown = [
    "# Stage 1A Renderer Recovery Decision",
    "",
    `- Status: \`${safeReport.status}\``,
    `- Generated at: \`${safeReport.generatedAt}\``,
    `- Next action: ${safeReport.nextAction}`,
    "",
    "## Sanitized evidence",
    "",
    "```json",
    json.trimEnd(),
    "```",
    "",
  ].join("\n");
  return [
    { target: layout.reportJson, expectedBasename: "stage1a-report.json", contents: json },
    { target: layout.reportMarkdown, expectedBasename: "stage1a-report.md", contents: markdown },
  ];
}

export function createStage1ABundleArtifacts(layout, protocolEvidence, report) {
  const principals = discoverStage1APrincipals(report);
  collectProtocolEvidencePrincipals(protocolEvidence, principals, new WeakSet());
  const protocol = canonicalizeTrusted(normalizeProtocolEvidence(protocolEvidence, principals));
  return [
    { target: layout.binaryEvidenceJson, expectedBasename: "binary-protocol-evidence.json", contents: `${JSON.stringify(protocol, null, 2)}\n` },
    ...createStage1AReportArtifacts(layout, report, principals),
  ];
}

export async function writeStage1AReportTransaction(layout, report, fsAdapter = DEFAULT_TRANSACTION_FS) {
  return writeArtifactTransaction(layout, createStage1AReportArtifacts(layout, report), fsAdapter);
}

export async function writeStage1ABundleTransaction(layout, bundle, fsAdapter = DEFAULT_TRANSACTION_FS) {
  const source = recordOrEmpty(bundle);
  return writeArtifactTransaction(layout, createStage1ABundleArtifacts(
    layout,
    ownData(source, "protocolEvidence"),
    ownData(source, "report"),
  ), fsAdapter);
}

async function writeArtifactTransaction(layout, artifacts, fsAdapter) {
  const validated = validateLayout(layout, artifacts);
  await assertNoSymlinkChain(validated.root, fsAdapter);
  await fsAdapter.mkdir(validated.evidenceDir, { recursive: true });
  await assertNoSymlinkChain(validated.evidenceDir, fsAdapter);
  const directory = await snapshotDirectory(validated.root, validated.evidenceDir, fsAdapter);
  const transactionId = fsAdapter.randomUUID();
  if (typeof transactionId !== "string" || !/^[A-Za-z0-9-]{8,}$/u.test(transactionId)) throw new Error("事务标识无效");

  const lockPath = assertContained(validated.root, resolve(validated.evidenceDir, LOCK_NAME));
  const lock = await createExclusiveFile(lockPath, `${transactionId}\n`, fsAdapter);
  const staged = [];
  const originals = [];
  const installs = [];
  let committed = false;
  try {
    await assertDirectoryStable(directory, fsAdapter);
    for (const [index, artifact] of validated.artifacts.entries()) {
      const stagePath = assertContained(validated.root, resolve(validated.evidenceDir, `.${artifact.expectedBasename}.${transactionId}.${index}.stage`));
      staged.push({ ...(await createExclusiveFile(stagePath, artifact.contents, fsAdapter)), target: artifact.target, installed: false });
      await assertDirectoryStable(directory, fsAdapter);
    }

    for (const [index, artifact] of validated.artifacts.entries()) {
      await assertDirectoryStable(directory, fsAdapter);
      await backupExistingTarget(artifact, validated, transactionId, index, directory, lock, originals, fsAdapter);
    }

    for (const item of staged) {
      await installStagedTarget(item, directory, lock, installs, fsAdapter);
    }

    await assertLockOwned(lock, fsAdapter);
    await syncDirectoryBestEffort(validated.evidenceDir, fsAdapter);
    await assertLockOwned(lock, fsAdapter);
    committed = true;
    for (const original of originals) {
      if (original.exists && original.linked) await unlinkIdentityMatched(original.backupPath, original.identity, fsAdapter);
    }
    await syncDirectoryBestEffort(validated.evidenceDir, fsAdapter);
  } catch (error) {
    await rollbackTransaction({ directory, installs, originals, staged, fsAdapter });
    throw error;
  } finally {
    if (!committed) {
      for (const item of staged) {
        await unlinkIdentityMatched(item.path, item.identity, fsAdapter);
      }
    }
    await unlinkIdentityMatched(lock.path, lock.identity, fsAdapter);
  }
}

function validateLayout(layout, artifacts) {
  if (!layout || typeof layout !== "object" || typeof layout.root !== "string" || typeof layout.evidenceDir !== "string") {
    throw new TypeError("报告布局无效");
  }
  const root = resolve(layout.root);
  const evidenceDir = assertContained(root, resolve(layout.evidenceDir));
  const validatedArtifacts = artifacts.map(artifact => {
    if (!artifact || typeof artifact.target !== "string" || typeof artifact.contents !== "string") throw new TypeError("报告目标无效");
    const target = assertContained(root, resolve(artifact.target));
    if (!samePath(dirname(target), evidenceDir) || basename(target) !== artifact.expectedBasename) throw new Error("报告目标名称无效");
    return { ...artifact, target };
  });
  return { root, evidenceDir, artifacts: validatedArtifacts };
}

async function assertNoSymlinkChain(path, fsAdapter) {
  const chain = [];
  for (let current = resolve(path);;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const current of chain.reverse()) {
    try {
      const stats = await fsAdapter.lstat(current, { bigint: true });
      if (stats.isSymbolicLink()) throw new Error("路径链包含符号链接");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function snapshotDirectory(root, evidenceDir, fsAdapter) {
  const stats = await fsAdapter.lstat(evidenceDir, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !reliableIdentity(stats)) throw new Error("evidence 目录身份无效");
  const canonicalRoot = await fsAdapter.realpath(root);
  const canonical = await fsAdapter.realpath(evidenceDir);
  assertContained(canonicalRoot, canonical);
  if (!samePath(canonical, evidenceDir)) throw new Error("evidence 目录解析发生跳转");
  return { path: evidenceDir, canonical, identity: stats };
}

async function assertDirectoryStable(snapshot, fsAdapter) {
  const stats = await fsAdapter.lstat(snapshot.path, { bigint: true });
  const canonical = await fsAdapter.realpath(snapshot.path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(snapshot.identity, stats) || !samePath(snapshot.canonical, canonical)) {
    throw new Error("evidence 目录在事务期间发生变化");
  }
}

async function createExclusiveFile(path, contents, fsAdapter) {
  let handle;
  let identity;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await fsAdapter.open(path, flags, 0o600);
    identity = await handle.stat({ bigint: true });
    if (!reliableIdentity(identity) || !identity.isFile()) throw new Error("事务文件身份无效");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!await pathHasIdentity(path, identity, fsAdapter)) throw new Error("事务文件在关闭后发生变化");
    return { path, identity };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (identity) await unlinkIdentityMatched(path, identity, fsAdapter);
    throw error;
  }
}

async function backupExistingTarget(artifact, validated, transactionId, index, directory, lock, originals, fsAdapter) {
  let identity;
  try {
    const stats = await fsAdapter.lstat(artifact.target, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || !reliableIdentity(stats)) throw new Error("正式报告目标类型无效");
    identity = stats;
  } catch (error) {
    if (error?.code === "ENOENT") {
      originals.push({ exists: false, target: artifact.target, linked: false, targetRemoved: false });
      return;
    }
    throw error;
  }
  const backupPath = assertContained(validated.root, resolve(validated.evidenceDir, `.${artifact.expectedBasename}.${transactionId}.${index}.backup`));
  await assertPathMissing(backupPath, fsAdapter);
  const original = {
    exists: true,
    target: artifact.target,
    backupPath,
    identity,
    linkIntent: true,
    linked: false,
    unlinkIntent: false,
    targetRemoved: false,
  };
  originals.push(original);
  await assertLockOwned(lock, fsAdapter);
  await createIdentityLink(artifact.target, backupPath, identity, fsAdapter);
  original.linked = true;
  await assertLockOwned(lock, fsAdapter);
  await assertDirectoryStable(directory, fsAdapter);
  if (!await pathHasIdentity(backupPath, identity, fsAdapter)) throw new Error("backup identity changed");
  if (!await pathHasIdentity(artifact.target, identity, fsAdapter)) throw new Error("formal target changed before backup removal");
  original.unlinkIntent = true;
  await assertLockOwned(lock, fsAdapter);
  await removeIdentityPath(artifact.target, identity, fsAdapter);
  original.targetRemoved = true;
  await assertLockOwned(lock, fsAdapter);
  await assertDirectoryStable(directory, fsAdapter);
}

async function installStagedTarget(item, directory, lock, installs, fsAdapter) {
  await assertDirectoryStable(directory, fsAdapter);
  if (!await pathHasIdentity(item.path, item.identity, fsAdapter)) throw new Error("stage identity changed");
  item.linkIntent = true;
  item.installed = false;
  item.stageUnlinkIntent = false;
  item.stageRemoved = false;
  installs.push(item);
  await assertLockOwned(lock, fsAdapter);
  await createIdentityLink(item.path, item.target, item.identity, fsAdapter);
  item.installed = true;
  await assertLockOwned(lock, fsAdapter);
  await assertDirectoryStable(directory, fsAdapter);
  if (!await pathHasIdentity(item.target, item.identity, fsAdapter)) throw new Error("installed identity changed");
  item.stageUnlinkIntent = true;
  await assertLockOwned(lock, fsAdapter);
  await removeIdentityPath(item.path, item.identity, fsAdapter);
  item.stageRemoved = true;
  await assertLockOwned(lock, fsAdapter);
  await assertDirectoryStable(directory, fsAdapter);
  if (!await pathHasIdentity(item.target, item.identity, fsAdapter)) throw new Error("installed identity changed");
}

async function assertLockOwned(lock, fsAdapter) {
  if (!await pathHasIdentity(lock.path, lock.identity, fsAdapter)) throw new Error("transaction_lock_lost");
}

async function rollbackTransaction({ directory, installs, originals, staged, fsAdapter }) {
  let rollbackFailed = false;
  for (const item of [...installs].reverse()) {
    const state = await inspectIdentity(item.target, item.identity, fsAdapter);
    if (state === "matching") {
      try {
        await removeIdentityPath(item.target, item.identity, fsAdapter);
        item.installed = false;
      } catch {
        rollbackFailed = true;
      }
    } else if (state === "foreign") {
      rollbackFailed = true;
    }
  }
  for (const original of [...originals].reverse()) {
    if (!original.exists || !original.linked) continue;
    let restored = false;
    try {
      await assertDirectoryStable(directory, fsAdapter);
      if (!await pathHasIdentity(original.backupPath, original.identity, fsAdapter)) { rollbackFailed = true; continue; }
      const targetState = await inspectIdentity(original.target, original.identity, fsAdapter);
      if (targetState === "matching") {
        restored = true;
      } else if (targetState === "missing") {
        await createIdentityLink(original.backupPath, original.target, original.identity, fsAdapter);
        restored = true;
      } else {
        rollbackFailed = true;
      }
      if (restored && !await unlinkIdentityMatched(original.backupPath, original.identity, fsAdapter)) rollbackFailed = true;
    } catch {
      rollbackFailed = true;
    }
  }
  for (const item of staged) {
    if (!item.installed) await unlinkIdentityMatched(item.path, item.identity, fsAdapter);
  }
  await syncDirectoryBestEffort(directory.path, fsAdapter);
  if (rollbackFailed) throw new Error("transaction_rollback_failed");
}

async function createIdentityLink(source, target, identity, fsAdapter) {
  let operationError;
  try {
    await fsAdapter.link(source, target);
  } catch (error) {
    operationError = error;
  }
  const state = await inspectIdentity(target, identity, fsAdapter);
  if (state === "matching") return;
  if (operationError) throw operationError;
  throw new Error(state === "foreign" ? "transaction target occupied" : "hard link was not created");
}

async function removeIdentityPath(path, identity, fsAdapter) {
  if (await inspectIdentity(path, identity, fsAdapter) !== "matching") throw new Error("unlink identity mismatch");
  let operationError;
  try {
    await fsAdapter.unlink(path);
  } catch (error) {
    operationError = error;
  }
  const state = await inspectIdentity(path, identity, fsAdapter);
  if (state === "missing") return;
  if (operationError) throw operationError;
  throw new Error(state === "foreign" ? "unlink target replaced" : "unlink did not remove target");
}

async function assertPathMissing(path, fsAdapter) {
  try {
    await fsAdapter.lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("事务备份目标已存在");
}

async function pathHasIdentity(path, identity, fsAdapter) {
  return await inspectIdentity(path, identity, fsAdapter) === "matching";
}

async function inspectIdentity(path, identity, fsAdapter) {
  try {
    const stats = await fsAdapter.lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || !reliableIdentity(stats)) return "foreign";
    return sameIdentity(identity, stats) ? "matching" : "foreign";
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "foreign";
  }
}

async function unlinkIdentityMatched(path, identity, fsAdapter) {
  if (!await pathHasIdentity(path, identity, fsAdapter)) return false;
  try {
    await fsAdapter.unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function syncDirectoryBestEffort(path, fsAdapter) {
  let handle;
  try {
    handle = await fsAdapter.open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not supported by every Windows filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeStage1AReport(report, principals) {
  const source = recordOrEmpty(report);
  const generatedAt = ownData(source, "generatedAt");
  if (!validGeneratedAt(generatedAt)) {
    throw new Error("invalid_stage1a_report");
  }
  const rawStatus = ownData(source, "status");
  const status = REPORT_STATUS.has(rawStatus) ? rawStatus : "blocked_missing_renderer";
  const sanitized = {
    generatedAt,
    inventory: normalizeInventory(ownData(source, "inventory"), principals),
    protocolEvidence: normalizeProtocolEvidence(ownData(source, "protocolEvidence"), principals),
    validations: normalizeValidations(ownData(source, "validations"), principals),
  };
  const finalReport = {
    generatedAt: sanitized.generatedAt,
    inventory: sanitized.inventory,
    nextAction: stage1ANextAction(status),
    protocolEvidence: sanitized.protocolEvidence,
    status,
    validations: sanitized.validations,
  };
  return canonicalizeTrusted(finalReport);
}

function validGeneratedAt(value) {
  if (typeof value !== "string" || !GENERATED_AT.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeInventory(value, principals) {
  const source = recordOrEmpty(value);
  return {
    candidates: arrayValues(ownData(source, "candidates")).filter(isRecord).map(normalizeCandidate),
    markerHits: normalizeFreeStringArray(ownData(source, "markerHits"), principals),
    roots: normalizeFreeStringArray(ownData(source, "roots"), principals),
    steam: normalizeSteam(ownData(source, "steam"), principals),
    warnings: normalizeFreeStringArray(ownData(source, "warnings"), principals),
  };
}

function normalizeCandidate(value) {
  const source = recordOrEmpty(value);
  const output = {};
  copySafeCandidateString(source, output, "executable", INVENTORY_CANDIDATE_EXECUTABLE);
  copyCandidateLabel(source, output, "sourceCandidateId");
  return output;
}

function normalizeSteam(value, principals) {
  const source = recordOrEmpty(value);
  const output = {};
  copyDecimalId(source, output, "appId");
  copyDecimalId(source, output, "buildId");
  const depots = ownData(source, "depots");
  if (Array.isArray(depots)) output.depots = arrayValues(depots).filter(isRecord).map(item => normalizeDepot(item));
  copyFreeString(source, output, "installDir", principals);
  copyFreeString(source, output, "name", principals);
  return output;
}

function normalizeDepot(value) {
  const source = recordOrEmpty(value);
  const output = {};
  copyDecimalId(source, output, "depotId");
  copyDecimalId(source, output, "manifestId");
  copySafeInteger(source, output, "size");
  return output;
}

function normalizeProtocolEvidence(value, principals) {
  const source = recordOrEmpty(value);
  return {
    files: arrayValues(ownData(source, "files")).filter(isRecord).map(item => normalizeProtocolFile(item, principals)),
    markers: normalizeProtocolEntries(ownData(source, "markers"), principals),
    messages: normalizeProtocolEntries(ownData(source, "messages"), principals),
    paths: normalizeProtocolEntries(ownData(source, "paths"), principals),
  };
}

function normalizeProtocolFile(value, principals) {
  const source = recordOrEmpty(value);
  const output = {};
  copyFreeString(source, output, "error", principals);
  const matches = ownData(source, "matches");
  if (Array.isArray(matches)) output.matches = normalizeProtocolEntries(matches, principals);
  copyFreeString(source, output, "path", principals);
  copyFixedHex(source, output, "sha256");
  copySafeInteger(source, output, "size");
  return output;
}

function normalizeProtocolEntries(value, principals) {
  return arrayValues(value).map(item => {
    if (typeof item === "string") return sanitizeString(item, principals);
    if (!isRecord(item)) return undefined;
    const source = recordOrEmpty(item);
    const output = {};
    copyFreeString(source, output, "encoding", principals);
    copyFreeString(source, output, "file", principals);
    copySafeInteger(source, output, "offset");
    copyFreeString(source, output, "value", principals);
    return output;
  }).filter(item => item !== undefined);
}

function normalizeValidations(value, principals) {
  return arrayValues(value).filter(isRecord).map(item => {
    const source = recordOrEmpty(item);
    const rawStatus = ownData(source, "status");
    const status = VALIDATION_STATUS.has(rawStatus) ? rawStatus : "incomplete";
    const output = {};
    copySafeCandidateString(source, output, "executable", VALIDATION_EXECUTABLE);
    const files = ownData(source, "files");
    if (Array.isArray(files)) output.files = arrayValues(files).filter(isRecord).map(file => normalizeValidationFile(file, principals));
    const missing = ownData(source, "missing");
    if (Array.isArray(missing)) output.missing = normalizeFreeStringArray(missing, principals);
    copySafeCandidateString(source, output, "rendererRoot", CANDIDATE_RENDERER_ROOT);
    copyCandidateLabel(source, output, "sourceCandidateId");
    output.status = status;
    copySafeInteger(source, output, "totalBytes");
    return output;
  });
}

function normalizeValidationFile(value, principals) {
  const source = recordOrEmpty(value);
  const output = {};
  copyFreeString(source, output, "error", principals);
  copyFreeString(source, output, "path", principals);
  copyFixedHex(source, output, "sha256");
  copySafeInteger(source, output, "size");
  return output;
}

function copyFreeString(source, target, key, principals) {
  const value = ownData(source, key);
  if (typeof value === "string") target[key] = sanitizeString(value, principals);
}

function copySafeCandidateString(source, target, key, pattern) {
  const value = ownData(source, key);
  if (typeof value !== "string") return;
  const normalized = value.replaceAll("\\", "/");
  if (pattern.test(normalized)) target[key] = normalized;
}

function copyCandidateLabel(source, target, key) {
  const value = ownData(source, key);
  if (typeof value === "string" && CANDIDATE_LABEL.test(value)) target[key] = value;
}

function copyDecimalId(source, target, key) {
  const value = ownData(source, key);
  if (typeof value === "string" && DECIMAL_ID.test(value)) target[key] = value;
}

function copyFixedHex(source, target, key) {
  const value = ownData(source, key);
  if (typeof value === "string" && FIXED_HEX.test(value)) target[key] = value;
}

function copySafeInteger(source, target, key) {
  const value = ownData(source, key);
  if (Number.isSafeInteger(value) && value >= 0) target[key] = value;
}

function normalizeFreeStringArray(value, principals) {
  return arrayValues(value).filter(item => typeof item === "string").map(item => sanitizeString(item, principals));
}

function canonicalizeTrusted(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeTrusted).sort((left, right) => compareText(canonicalBytes(left), canonicalBytes(right)));
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort(compareText)) output[key] = canonicalizeTrusted(value[key]);
  return output;
}

function stage1ANextAction(status) {
  return status === "candidate_ready"
    ? "已找到结构完整且已验证的候选；可单独规划 Stage 1B，但本阶段仍不得启动候选。"
    : "未找到结构完整且已验证的候选；不得进入 Stage 1B。";
}

const EMPTY_RECORD = Object.freeze({});

function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : EMPTY_RECORD;
}

function isRecord(value) { return value && typeof value === "object" && !Array.isArray(value); }

function ownData(value, key) {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function arrayValues(value) {
  if (!Array.isArray(value)) return [];
  let length;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    length = Object.hasOwn(descriptor ?? {}, "value") ? descriptor.value : undefined;
  } catch {
    return [];
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_ITEMS) return [];
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const item = ownData(value, String(index));
    if (item !== undefined) output.push(item);
  }
  return output;
}

function sanitizeString(value, principals) {
  if (value === "[REDACTED]" || CREDENTIAL_SIGNAL.test(value) || JWT.test(value) || MOBILE.test(value)) return "[REDACTED]";
  if (EMBEDDED_ABSOLUTE_PATH.test(value)) return "[PATH_REDACTED]";
  if (containsSensitivePrincipal(value, principals)) return "[PRINCIPAL_REDACTED]";
  return value;
}

function collectStage1APrincipals(value, principals, active) {
  const source = recordOrEmpty(value);
  if (!beginVisit(source, active)) return;
  try {
    collectKnownStrings(source, ["generatedAt", "nextAction", "status"], principals);
    collectInventoryPrincipals(ownData(source, "inventory"), principals, active);
    collectProtocolEvidencePrincipals(ownData(source, "protocolEvidence"), principals, active);
    collectValidationPrincipals(ownData(source, "validations"), principals, active);
  } finally {
    active.delete(source);
  }
}

function collectInventoryPrincipals(value, principals, active) {
  const source = recordOrEmpty(value);
  if (!beginVisit(source, active)) return;
  try {
    for (const key of ["markerHits", "roots", "warnings"]) collectStringArrayPrincipals(ownData(source, key), principals);
    for (const item of arrayValues(ownData(source, "candidates"))) {
      if (typeof item === "string") addStringPrincipals(item, principals);
      else collectKnownStrings(recordOrEmpty(item), ["executable", "sourceCandidateId"], principals);
    }
    const steam = recordOrEmpty(ownData(source, "steam"));
    collectKnownStrings(steam, ["appId", "buildId", "installDir", "name"], principals);
    for (const depot of arrayValues(ownData(steam, "depots"))) {
      collectKnownStrings(recordOrEmpty(depot), ["depotId", "manifestId"], principals);
    }
  } finally {
    active.delete(source);
  }
}

function collectProtocolEvidencePrincipals(value, principals, active) {
  const source = recordOrEmpty(value);
  if (!beginVisit(source, active)) return;
  try {
    for (const file of arrayValues(ownData(source, "files"))) {
      const record = recordOrEmpty(file);
      collectKnownStrings(record, ["error", "path", "sha256"], principals);
      collectProtocolEntryPrincipals(ownData(record, "matches"), principals, active);
    }
    for (const key of ["markers", "messages", "paths"]) {
      collectProtocolEntryPrincipals(ownData(source, key), principals, active);
    }
  } finally {
    active.delete(source);
  }
}

function collectProtocolEntryPrincipals(value, principals, active) {
  if (!Array.isArray(value) || active.has(value)) return;
  active.add(value);
  try {
    for (const item of arrayValues(value)) {
      if (typeof item === "string") addStringPrincipals(item, principals);
      else collectKnownStrings(recordOrEmpty(item), ["encoding", "file", "value"], principals);
    }
  } finally {
    active.delete(value);
  }
}

function collectValidationPrincipals(value, principals, active) {
  if (!Array.isArray(value) || active.has(value)) return;
  active.add(value);
  try {
    for (const item of arrayValues(value)) {
      const record = recordOrEmpty(item);
      collectKnownStrings(record, ["executable", "rendererRoot", "sourceCandidateId", "status"], principals);
      collectStringArrayPrincipals(ownData(record, "missing"), principals);
      for (const file of arrayValues(ownData(record, "files"))) {
        collectKnownStrings(recordOrEmpty(file), ["error", "path", "sha256"], principals);
      }
    }
  } finally {
    active.delete(value);
  }
}

function collectKnownStrings(source, keys, principals) {
  for (const key of keys) {
    const value = ownData(source, key);
    if (typeof value === "string") addStringPrincipals(value, principals);
  }
}

function collectStringArrayPrincipals(value, principals) {
  for (const item of arrayValues(value)) if (typeof item === "string") addStringPrincipals(item, principals);
}

function addStringPrincipals(value, principals) {
  for (const principal of principalsFromPath(value)) principals.add(principal.toLowerCase());
}

function beginVisit(value, active) {
  if (value === EMPTY_RECORD || active.has(value)) return false;
  active.add(value);
  return true;
}

function principalsFromPath(value) {
  const found = [];
  const patterns = [
    /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])(?:Users|home)[\\/]([^\\/\s"'?&#]+)/giu,
    /\/(?:home|Users)\/([^/\s"'?&#]+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

function containsSensitivePrincipal(value, principals) {
  const lower = value.toLowerCase();
  for (const principal of principals) {
    let index = lower.indexOf(principal);
    while (index !== -1) {
      const before = index === 0 ? "" : lower[index - 1];
      const afterIndex = index + principal.length;
      const after = afterIndex === lower.length ? "" : lower[afterIndex];
      if (!/[A-Za-z0-9_.-]/u.test(before) && !/[A-Za-z0-9_.-]/u.test(after)) return true;
      index = lower.indexOf(principal, index + 1);
    }
  }
  return false;
}

function reliableIdentity(stats) {
  if (!stats || typeof stats.dev !== typeof stats.ino) return false;
  if (typeof stats.dev === "bigint") return stats.dev !== 0n && stats.ino !== 0n;
  return typeof stats.dev === "number" && Number.isSafeInteger(stats.dev) && Number.isSafeInteger(stats.ino) && stats.dev !== 0 && stats.ino !== 0;
}

function sameIdentity(left, right) {
  return reliableIdentity(left) && reliableIdentity(right) && typeof left.dev === typeof right.dev
    && left.dev === right.dev && left.ino === right.ino;
}
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function canonicalBytes(value) { return JSON.stringify(value); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
