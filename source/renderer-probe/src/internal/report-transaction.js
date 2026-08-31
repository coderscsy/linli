import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { assertContained } from "../layout.js";
import { redactSecrets } from "../redaction.js";

const LOCK_NAME = ".stage1a-transaction.lock";
const SECRET_KEY = /^(authorization|cookie|set-cookie|x-token|token|access_token|api_key|model_gateway_token)$/iu;
const CREDENTIAL_SIGNAL = /\b(?:authorization|cookie|set-cookie|x-token|model_gateway_token)\b|\bBearer\b|[?&](?:token|access_token|api_key|x-token)=|\b(?:token|access_token|api_key)\s*[:=]/iu;
const EMBEDDED_ABSOLUTE_PATH = /(?:(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])|(?<![A-Za-z0-9_>/])\/[^/\s]+(?:\/[^/\s]*)*)/u;
const JWT = /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/u;
const VALIDATION_STATUS = new Set(["complete", "incomplete", "invalid_pe"]);

export const DEFAULT_TRANSACTION_FS = Object.freeze({ link, lstat, mkdir, open, randomUUID, realpath, unlink });

export function discoverSensitivePrincipals(value) {
  const principals = new Set();
  collectSensitivePrincipals(value, new WeakSet(), principals);
  return principals;
}

export function canonicalizeForPersistence(value, principals = discoverSensitivePrincipals(value)) {
  return canonicalize(redactSecrets(value), new WeakSet(), principals, [], undefined);
}

export function canonicalizeStage1AReportForPersistence(report, principals = discoverSensitivePrincipals(report)) {
  const source = recordOrEmpty(redactSecrets(report));
  if (typeof source.generatedAt !== "string") throw new Error("invalid_stage1a_report");
  const status = source.status === "candidate_ready" ? "candidate_ready" : "blocked_missing_renderer";
  const validations = Array.isArray(source.validations) ? source.validations.map(item => {
    const validation = recordOrEmpty(item);
    return { ...validation, status: VALIDATION_STATUS.has(validation.status) ? validation.status : "incomplete" };
  }) : [];
  const coerced = {
    ...source,
    status,
    nextAction: stage1ANextAction(status),
    validations,
  };
  return canonicalize(redactSecrets(coerced), new WeakSet(), principals, [], STAGE1A_SCHEMA);
}

export function createStage1AReportArtifacts(layout, report, principals = discoverSensitivePrincipals(report)) {
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
  const principals = discoverSensitivePrincipals({ protocolEvidence, report });
  const protocol = canonicalizeForPersistence(protocolEvidence, principals);
  return [
    { target: layout.binaryEvidenceJson, expectedBasename: "binary-protocol-evidence.json", contents: `${JSON.stringify(protocol, null, 2)}\n` },
    ...createStage1AReportArtifacts(layout, report, principals),
  ];
}

export async function writeStage1AReportTransaction(layout, report, fsAdapter = DEFAULT_TRANSACTION_FS) {
  return writeArtifactTransaction(layout, createStage1AReportArtifacts(layout, report), fsAdapter);
}

export async function writeStage1ABundleTransaction(layout, { protocolEvidence, report }, fsAdapter = DEFAULT_TRANSACTION_FS) {
  return writeArtifactTransaction(layout, createStage1ABundleArtifacts(layout, protocolEvidence, report), fsAdapter);
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

function canonicalize(value, active, principals, path, schema) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return schema?.protectValue(path, value) ? value : sanitizeString(value, principals);
  if (typeof value === "function" || typeof value === "symbol") return "[UNSUPPORTED]";
  if (!value || typeof value !== "object") return value;
  if (active.has(value)) return "[CIRCULAR]";
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const items = Object.keys(descriptors)
        .filter(key => /^(0|[1-9]\d*)$/u.test(key) && descriptors[key].enumerable)
        .map(key => Object.hasOwn(descriptors[key], "value")
          ? canonicalize(descriptors[key].value, active, principals, [...path, "*"], schema)
          : "[UNREADABLE]");
      return items.sort((left, right) => compareText(canonicalBytes(left), canonicalBytes(right)));
    }
    const entries = [];
    for (const key of Object.keys(descriptors).filter(key => descriptors[key].enumerable).sort(compareText)) {
      const childPath = [...path, key];
      if (!schema?.protectKey(childPath) && isSensitiveKey(key, principals)) continue;
      const descriptor = descriptors[key];
      const item = Object.hasOwn(descriptor, "value")
        ? canonicalize(descriptor.value, active, principals, childPath, schema)
        : "[UNREADABLE]";
      entries.push([key, item]);
    }
    return Object.fromEntries(entries);
  } catch {
    return "[UNREADABLE]";
  } finally {
    active.delete(value);
  }
}

const STAGE1A_SCHEMA = Object.freeze({
  protectKey(path) {
    const signature = path.join(".");
    return /^(?:generatedAt|inventory|nextAction|protocolEvidence|status|validations)$/u.test(signature)
      || /^inventory\.(?:candidates|markerHits|roots|steam|warnings)$/u.test(signature)
      || /^inventory\.candidates\.\*\.(?:executable|sourceCandidateId)$/u.test(signature)
      || /^inventory\.steam\.(?:appId|buildId|depots|installDir|name)$/u.test(signature)
      || /^inventory\.steam\.depots\.\*\.(?:depotId|manifestId|size)$/u.test(signature)
      || /^validations\.\*\.(?:executable|files|missing|rendererRoot|sourceCandidateId|status|totalBytes)$/u.test(signature)
      || /^validations\.\*\.files\.\*\.(?:error|path|sha256|size)$/u.test(signature)
      || /^protocolEvidence\.(?:files|markers|messages|paths)$/u.test(signature)
      || /^protocolEvidence\.files\.\*\.(?:error|matches|path|sha256|size)$/u.test(signature)
      || /^protocolEvidence\.files\.\*\.matches\.\*\.(?:encoding|file|offset|value)$/u.test(signature)
      || /^protocolEvidence\.(?:markers|messages|paths)\.\*\.(?:encoding|file|offset|value)$/u.test(signature);
  },
  protectValue(path, value) {
    const signature = path.join(".");
    if (signature === "status") return value === "candidate_ready" || value === "blocked_missing_renderer";
    if (signature === "validations.*.status") return VALIDATION_STATUS.has(value);
    if (/^inventory\.steam\.(?:appId|buildId)$/u.test(signature)) return /^\d+$/u.test(value);
    if (/^inventory\.steam\.depots\.\*\.(?:depotId|manifestId)$/u.test(signature)) return /^\d+$/u.test(value);
    if (/^(?:inventory\.candidates|validations)\.\*\.sourceCandidateId$/u.test(signature)) return /^[a-f0-9]{64}$/u.test(value);
    if (/^(?:protocolEvidence\.files|validations\.\*\.files)\.\*\.sha256$/u.test(signature)) return /^[a-f0-9]{64}$/u.test(value);
    return false;
  },
});

function stage1ANextAction(status) {
  return status === "candidate_ready"
    ? "已找到结构完整且已验证的候选；可单独规划 Stage 1B，但本阶段仍不得启动候选。"
    : "未找到结构完整且已验证的候选；不得进入 Stage 1B。";
}

function recordOrEmpty(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

function sanitizeString(value, principals) {
  if (value === "[REDACTED]" || CREDENTIAL_SIGNAL.test(value)) return "[REDACTED]";
  if (EMBEDDED_ABSOLUTE_PATH.test(value)) return "[PATH_REDACTED]";
  if (containsSensitivePrincipal(value, principals)) return "[PRINCIPAL_REDACTED]";
  return value;
}

function collectSensitivePrincipals(value, active, principals) {
  if (typeof value === "string") {
    for (const principal of principalsFromPath(value)) principals.add(principal.toLowerCase());
    return;
  }
  if (!value || typeof value !== "object" || active.has(value)) return;
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      for (const principal of principalsFromPath(key)) principals.add(principal.toLowerCase());
      const descriptor = descriptors[key];
      if (Object.hasOwn(descriptor, "value")) collectSensitivePrincipals(descriptor.value, active, principals);
    }
  } catch {
    // Uninspectable objects contribute no principals and are later persisted as unreadable.
  } finally {
    active.delete(value);
  }
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

function isSensitiveKey(key, principals) {
  return SECRET_KEY.test(key) || CREDENTIAL_SIGNAL.test(key) || EMBEDDED_ABSOLUTE_PATH.test(key)
    || JWT.test(key) || containsSensitivePrincipal(key, principals);
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
