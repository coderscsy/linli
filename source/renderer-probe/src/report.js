import { createHash } from "node:crypto";
import { win32 } from "node:path";

import {
  canonicalizeStage1AReportForPersistence,
  discoverStage1APrincipals,
  writeStage1AReportTransaction,
} from "./internal/report-transaction.js";

const CANDIDATE_ID = /^[A-Fa-f0-9]{64}$/u;
const DECIMAL_ID = /^\d{1,20}$/u;
const FIXED_HEX = /^[A-Fa-f0-9]{64}$/u;
const VALIDATION_STATUS = new Set(["complete", "incomplete", "invalid_pe"]);
const MAX_ARRAY_ITEMS = 100_000;

export function buildStage1AReport(input) {
  const source = recordOrEmpty(input);
  const generatedAt = ownData(source, "generatedAt");
  if (typeof generatedAt !== "string") throw new TypeError("generatedAt 必须是字符串");

  const principals = discoverStage1APrincipals(input);
  const inventorySource = recordOrEmpty(ownData(source, "inventory"));
  const candidates = normalizeCandidates(ownData(inventorySource, "candidates"));
  const candidateIds = new Set(candidates.entries.map(candidate => candidate.sourceCandidateId));
  const validations = normalizeValidations(ownData(source, "validations"), candidates.byNormalizedPath);
  const ready = candidates.entries.length > 0 && validations.some(validation => (
    validation.status === "complete"
    && typeof validation.sourceCandidateId === "string"
    && candidateIds.has(validation.sourceCandidateId)
  ));

  return canonicalizeStage1AReportForPersistence({
    generatedAt,
    inventory: normalizeInventory(inventorySource, candidates.entries),
    protocolEvidence: normalizeProtocolEvidence(ownData(source, "protocolEvidence")),
    status: ready ? "candidate_ready" : "blocked_missing_renderer",
    validations,
  }, principals);
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

function normalizeInventory(inventory, candidates) {
  return {
    candidates,
    markerHits: stringArray(ownData(inventory, "markerHits")).sort(compareText).map((_, index) => `<marker-hit-${index + 1}>/version.json`),
    roots: stringArray(ownData(inventory, "roots")).sort(compareText).map((_, index) => `<scan-root-${index + 1}>`),
    steam: copySteamRaw(ownData(inventory, "steam")),
    warnings: stringArray(ownData(inventory, "warnings")),
  };
}

function copySteamRaw(value) {
  const source = recordOrEmpty(value);
  const output = {};
  copyDecimalId(source, output, "appId");
  copyDecimalId(source, output, "buildId");
  copyString(source, output, "installDir");
  copyString(source, output, "name");
  const rawDepots = ownData(source, "depots");
  if (Array.isArray(rawDepots)) {
    output.depots = arrayValues(rawDepots).filter(isRecord).map(item => {
      const depot = recordOrEmpty(item);
      const copied = {};
      copyDecimalId(depot, copied, "depotId");
      copyDecimalId(depot, copied, "manifestId");
      copySafeInteger(depot, copied, "size");
      return copied;
    });
  }
  return output;
}

function normalizeProtocolEvidence(value) {
  const evidence = recordOrEmpty(value);
  const sourceFiles = arrayValues(ownData(evidence, "files"))
    .map(copyProtocolFileRaw)
    .filter(Boolean)
    .sort((left, right) => compareText(stringOrEmpty(left.path), stringOrEmpty(right.path)) || compareRaw(left, right));
  const labels = new Map();
  for (const [index, file] of sourceFiles.entries()) {
    const path = stringOrEmpty(file.path);
    if (!labels.has(path)) labels.set(path, `<protocol-input-${index + 1}>`);
  }

  const files = sourceFiles.map((file, index) => {
    const output = { path: `<protocol-input-${index + 1}>` };
    copyString(file, output, "error");
    const matches = ownData(file, "matches");
    if (Array.isArray(matches)) output.matches = matches;
    copyFixedHex(file, output, "sha256");
    copySafeInteger(file, output, "size");
    return output;
  });
  return {
    files,
    markers: normalizeProtocolRecords(ownData(evidence, "markers"), labels, false),
    messages: normalizeProtocolRecords(ownData(evidence, "messages"), labels, false),
    paths: normalizeProtocolRecords(ownData(evidence, "paths"), labels, true),
  };
}

function copyProtocolFileRaw(value) {
  const source = recordOrEmpty(value);
  if (source === EMPTY_RECORD) return undefined;
  const output = {};
  copyString(source, output, "error");
  copyString(source, output, "path");
  copyFixedHex(source, output, "sha256");
  copySafeInteger(source, output, "size");
  const matches = ownData(source, "matches");
  if (Array.isArray(matches)) output.matches = normalizeProtocolRecords(matches, new Map(), false);
  return output;
}

function normalizeProtocolRecords(values, labels, pathValues) {
  const normalized = arrayValues(values).map(item => {
    if (typeof item === "string") return item;
    const source = recordOrEmpty(item);
    if (source === EMPTY_RECORD) return undefined;
    const record = {};
    copyString(source, record, "encoding");
    copySafeInteger(source, record, "offset");
    copyString(source, record, "value");
    const file = ownData(source, "file");
    if (typeof file === "string") record.file = labels.get(file) ?? (labels.size > 0 ? "<protocol-input-unknown>" : file);
    return record;
  }).filter(item => item !== undefined).sort(compareRaw);
  return normalized.map((record, index) => (
    pathValues && record && typeof record === "object" && Object.hasOwn(record, "value")
      ? { ...record, value: `<binary-path-${index + 1}>` }
      : record
  ));
}

function normalizeValidations(values, candidateByPath) {
  return arrayValues(values).filter(isRecord).map(value => {
    const validation = recordOrEmpty(value);
    const rawStatus = ownData(validation, "status");
    const output = { status: VALIDATION_STATUS.has(rawStatus) ? rawStatus : "incomplete" };
    const files = ownData(validation, "files");
    if (Array.isArray(files)) output.files = arrayValues(files).filter(isRecord).map(copyValidationFileRaw);
    const missing = ownData(validation, "missing");
    if (Array.isArray(missing)) output.missing = stringArray(missing);
    const totalBytes = ownData(validation, "totalBytes");
    if (Number.isSafeInteger(totalBytes) && totalBytes >= 0) output.totalBytes = totalBytes;

    const executable = ownData(validation, "executable");
    const exactPath = normalizeAbsoluteCandidate(executable);
    const exactId = exactPath ? candidateByPath.get(exactPath) : undefined;
    const rawSuppliedId = ownData(validation, "sourceCandidateId");
    const suppliedId = typeof rawSuppliedId === "string" && CANDIDATE_ID.test(rawSuppliedId)
      ? rawSuppliedId.toLowerCase()
      : undefined;
    const sourceCandidateId = exactPath ? exactId : suppliedId;
    if (sourceCandidateId) output.sourceCandidateId = sourceCandidateId;

    const rendererRoot = ownData(validation, "rendererRoot");
    if (typeof rendererRoot === "string") output.rendererRoot = rendererRoot;
    if (typeof executable === "string") output.executable = exactId
      ? "<matched-candidate>/TPRender/Binaries/Win64/Olivia.exe"
      : executable;
    return output;
  }).sort(compareRaw);
}

function copyValidationFileRaw(value) {
  const source = recordOrEmpty(value);
  if (source === EMPTY_RECORD) return undefined;
  const output = {};
  copyString(source, output, "error");
  copyString(source, output, "path");
  copyFixedHex(source, output, "sha256");
  copySafeInteger(source, output, "size");
  return output;
}

function normalizeAbsoluteCandidate(value) {
  if (typeof value !== "string" || !win32.isAbsolute(value)) return undefined;
  return win32.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function hashCandidatePath(normalized) {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
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

function copyString(source, target, key) {
  const value = ownData(source, key);
  if (typeof value === "string") target[key] = value;
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

function stringArray(value) { return arrayValues(value).filter(item => typeof item === "string"); }
function stringOrEmpty(value) { return typeof value === "string" ? value : ""; }
function compareRaw(left, right) { return compareText(JSON.stringify(left), JSON.stringify(right)); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
