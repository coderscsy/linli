import { createHash } from "node:crypto";
import { win32 } from "node:path";

import { canonicalizeForPersistence, discoverSensitivePrincipals, writeStage1AReportTransaction } from "./internal/report-transaction.js";
import { redactSecrets } from "./redaction.js";

const CANDIDATE_ID = /^[a-f0-9]{64}$/u;

export function buildStage1AReport(input) {
  const safeInput = redactSecrets(input);
  const principals = discoverSensitivePrincipals(input);
  const sanitize = value => canonicalizeForPersistence(value, principals);
  const source = recordOrEmpty(safeInput);
  if (typeof source.generatedAt !== "string") throw new TypeError("generatedAt 必须是字符串");

  const inventorySource = recordOrEmpty(source.inventory);
  const candidates = normalizeCandidates(inventorySource.candidates);
  const candidateIds = new Set(candidates.entries.map(candidate => candidate.sourceCandidateId));
  const validations = normalizeValidations(source.validations, candidates.byNormalizedPath, sanitize);
  const ready = candidates.entries.length > 0 && validations.some(validation => (
    validation.status === "complete"
    && typeof validation.sourceCandidateId === "string"
    && candidateIds.has(validation.sourceCandidateId)
  ));

  return sanitize({
    generatedAt: source.generatedAt,
    inventory: normalizeInventory(inventorySource, candidates.entries, sanitize),
    nextAction: ready
      ? "已找到结构完整且已验证的候选；可单独规划 Stage 1B，但本阶段仍不得启动候选。"
      : "未找到结构完整且已验证的候选；不得进入 Stage 1B。",
    protocolEvidence: normalizeProtocolEvidence(source.protocolEvidence, sanitize),
    status: ready ? "candidate_ready" : "blocked_missing_renderer",
    validations,
  });
}

export async function writeStage1AReport(layout, report) {
  return writeStage1AReportTransaction(layout, report);
}

function normalizeCandidates(values) {
  const normalized = stringArray(values)
    .map(path => ({ normalized: normalizeAbsoluteCandidate(path) }))
    .filter(candidate => candidate.normalized)
    .sort((left, right) => compareText(left.normalized, right.normalized));
  const byNormalizedPath = new Map();
  const entries = normalized.map((candidate, index) => {
    const sourceCandidateId = hashCandidatePath(candidate.normalized);
    byNormalizedPath.set(candidate.normalized, sourceCandidateId);
    return { executable: `<candidate-${index + 1}>/TPRender/Binaries/Win64/Olivia.exe`, sourceCandidateId };
  });
  return { entries, byNormalizedPath };
}

function normalizeInventory(inventory, candidates, sanitize) {
  return sanitize({
    candidates,
    markerHits: stringArray(inventory.markerHits).sort(compareText).map((_, index) => `<marker-hit-${index + 1}>/version.json`),
    roots: stringArray(inventory.roots).sort(compareText).map((_, index) => `<scan-root-${index + 1}>`),
    steam: inventory.steam ?? {},
    warnings: arrayOrEmpty(inventory.warnings),
  });
}

function normalizeProtocolEvidence(value, sanitize) {
  const evidence = recordOrEmpty(value);
  const sourceFiles = arrayOrEmpty(evidence.files)
    .map(item => recordOrEmpty(item))
    .sort((left, right) => compareText(stringOrEmpty(left.path), stringOrEmpty(right.path)) || compareCanonical(left, right, sanitize));
  const labels = new Map();
  for (const [index, file] of sourceFiles.entries()) labels.set(stringOrEmpty(file.path), `<protocol-input-${index + 1}>`);

  const files = sourceFiles.map((file, index) => {
    const output = { path: `<protocol-input-${index + 1}>` };
    for (const key of ["error", "matches", "sha256", "size"]) {
      if (Object.hasOwn(file, key)) output[key] = sanitize(file[key]);
    }
    return output;
  });
  return sanitize({
    files,
    markers: normalizeProtocolRecords(evidence.markers, labels, false, sanitize),
    messages: normalizeProtocolRecords(evidence.messages, labels, false, sanitize),
    paths: normalizeProtocolRecords(evidence.paths, labels, true, sanitize),
  });
}

function normalizeProtocolRecords(values, labels, pathValues, sanitize) {
  const normalized = arrayOrEmpty(values).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return sanitize(item);
    const record = {};
    for (const key of ["encoding", "offset", "value"]) {
      if (!Object.hasOwn(item, key)) continue;
      record[key] = sanitize(item[key]);
    }
    if (Object.hasOwn(item, "file")) record.file = labels.get(stringOrEmpty(item.file)) ?? "<protocol-input-unknown>";
    return sanitize(record);
  }).sort((left, right) => compareCanonical(left, right, sanitize));
  return normalized.map((record, index) => (
    pathValues && record && typeof record === "object" && !Array.isArray(record) && Object.hasOwn(record, "value")
      ? sanitize({ ...record, value: `<binary-path-${index + 1}>` })
      : record
  ));
}

function normalizeValidations(values, candidateByPath, sanitize) {
  return arrayOrEmpty(values).map(value => {
    const validation = recordOrEmpty(value);
    const output = {};
    for (const key of ["files", "missing", "status", "totalBytes"]) {
      if (Object.hasOwn(validation, key)) output[key] = sanitize(validation[key]);
    }
    const exactPath = normalizeAbsoluteCandidate(validation.executable);
    const exactId = exactPath ? candidateByPath.get(exactPath) : undefined;
    const suppliedId = typeof validation.sourceCandidateId === "string" && CANDIDATE_ID.test(validation.sourceCandidateId.toLowerCase())
      ? validation.sourceCandidateId.toLowerCase()
      : undefined;
    const sourceCandidateId = exactPath ? exactId : suppliedId;
    if (sourceCandidateId) output.sourceCandidateId = sourceCandidateId;
    if (Object.hasOwn(validation, "rendererRoot")) output.rendererRoot = sanitize(validation.rendererRoot);
    if (Object.hasOwn(validation, "executable")) output.executable = exactId
      ? "<matched-candidate>/TPRender/Binaries/Win64/Olivia.exe"
      : sanitize(validation.executable);
    return sanitize(output);
  }).sort((left, right) => compareCanonical(left, right, sanitize));
}

function normalizeAbsoluteCandidate(value) {
  if (typeof value !== "string" || !win32.isAbsolute(value)) return undefined;
  return win32.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function hashCandidatePath(normalized) {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function compareCanonical(left, right, sanitize) {
  return compareText(JSON.stringify(sanitize(left)), JSON.stringify(sanitize(right)));
}
function arrayOrEmpty(value) { return Array.isArray(value) ? value : []; }
function stringArray(value) { return arrayOrEmpty(value).filter(item => typeof item === "string"); }
function recordOrEmpty(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function stringOrEmpty(value) { return typeof value === "string" ? value : ""; }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
