import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { collectProtocolEvidence } from "../binary-evidence.js";
import { validateRendererCandidate } from "../candidate.js";
import { scanRendererInventory } from "../inventory.js";
import { assertContained, resolveProbeLayout } from "../layout.js";
import { buildStage1AReport } from "../report.js";
import { writeStage1ABundleTransaction } from "./report-transaction.js";

const FLAGS = Object.freeze(["--data-root", "--game-root", "--backup-root", "--appdata-root", "--steamapps-root"]);
const FLAG_SET = new Set(FLAGS);
const APP_MANIFEST = "appmanifest_4532590.acf";
const MARKER = "ovilia_Win64_Development_15918";
const PRODUCTION_DATA_ROOT = win32.resolve("I:\\OliviaSoulData\\MidiRenderer");

export function createProductionCliDependencies() {
  return Object.freeze({
    collectProtocolEvidence,
    lstat,
    now: () => new Date(),
    resolveLayout: dataRoot => resolveProbeLayout(dataRoot),
    scanRendererInventory,
    stderr: process.stderr,
    stdout: process.stdout,
    validateRendererCandidate,
    writeEvidenceBundle: (layout, bundle) => writeStage1ABundleTransaction(layout, bundle),
  });
}

export async function runCliCore(args, dependencies) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch {
    dependencies.stderr.write("renderer-probe: invalid scan arguments\n");
    return 1;
  }

  let layout;
  try {
    layout = dependencies.resolveLayout(parsed.dataRoot);
  } catch {
    dependencies.stderr.write("renderer-probe: unsafe data root\n");
    return 1;
  }

  const manifestPath = join(parsed.steamAppsRoot, APP_MANIFEST);
  try {
    const manifestStats = await dependencies.lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
      dependencies.stderr.write(`renderer-probe: missing ${APP_MANIFEST}\n`);
      return 1;
    }
  } catch (error) {
    dependencies.stderr.write(error?.code === "ENOENT"
      ? `renderer-probe: missing ${APP_MANIFEST}\n`
      : "renderer-probe: inventory scan failed\n");
    return 1;
  }

  let inventory;
  try {
    inventory = await dependencies.scanRendererInventory({
      roots: [parsed.gameRoot, parsed.backupRoot, parsed.appdataRoot],
      steamAppsRoot: parsed.steamAppsRoot,
      marker: MARKER,
    });
  } catch {
    dependencies.stderr.write("renderer-probe: inventory scan failed\n");
    return 1;
  }

  const binaryInputs = [
    join(parsed.gameRoot, "0.0.9.627", "plugins", "Studio", "NutLivePlayer.dll"),
    join(parsed.gameRoot, "0.0.9.627", "plugins", "Studio", "NutStudioPlugin.dll"),
    join(parsed.gameRoot, "version.json"),
  ];
  let protocolEvidence;
  try {
    protocolEvidence = await dependencies.collectProtocolEvidence(binaryInputs);
  } catch {
    protocolEvidence = { files: binaryInputs.map(path => ({ path, error: "collection_failed" })), markers: [], messages: [], paths: [] };
  }

  const validations = [];
  for (const executable of inventory.candidates) {
    const sourceCandidateId = sourceCandidateIdForPath(executable);
    try {
      validations.push({ ...(await dependencies.validateRendererCandidate(executable)), sourceCandidateId });
    } catch {
      validations.push({
        status: "incomplete",
        rendererRoot: "<candidate>/TPRender",
        executable: "<candidate>/TPRender/Binaries/Win64/Olivia.exe",
        files: [],
        missing: ["candidate_validation_failed"],
        sourceCandidateId,
        totalBytes: 0,
      });
    }
  }

  const now = dependencies.now();
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const report = buildStage1AReport({ inventory, protocolEvidence, validations, generatedAt });
  try {
    await dependencies.writeEvidenceBundle(layout, { protocolEvidence: report.protocolEvidence, report });
  } catch {
    dependencies.stderr.write("renderer-probe: report bundle write failed\n");
    return 1;
  }

  const summary = {
    counts: {
      candidates: inventory.candidates.length,
      completeValidations: validations.filter(validation => validation.status === "complete").length,
      protocolFiles: report.protocolEvidence.files.length,
    },
    reportJson: publicReportPath(layout),
    status: report.status,
  };
  dependencies.stdout.write(`${JSON.stringify(summary)}\n`);
  return report.status === "candidate_ready" ? 0 : 2;
}

export function resolveTemporaryTestLayout(dataRoot, requiredDrive) {
  if (typeof requiredDrive !== "string" || !/^[A-Za-z]:$/u.test(requiredDrive)) throw new Error("invalid test drive");
  const expectedRoot = resolve(dataRoot);
  const temporaryRoot = resolve(tmpdir());
  const pathRelative = relative(temporaryRoot, expectedRoot);
  if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) throw new Error("unsafe test root");
  if (!pathRelative.split(sep)[0].startsWith("olivia-renderer-cli-")) throw new Error("unsafe test root");
  if (win32.parse(expectedRoot).root.slice(0, 2).toUpperCase() !== requiredDrive.toUpperCase()) throw new Error("wrong test drive");
  const evidenceDir = assertContained(expectedRoot, join(expectedRoot, "evidence"));
  return Object.freeze({
    root: expectedRoot,
    evidenceDir,
    reportJson: assertContained(expectedRoot, join(evidenceDir, "stage1a-report.json")),
    reportMarkdown: assertContained(expectedRoot, join(evidenceDir, "stage1a-report.md")),
    binaryEvidenceJson: assertContained(expectedRoot, join(evidenceDir, "binary-protocol-evidence.json")),
  });
}

function parseArgs(args) {
  if (!Array.isArray(args) || !args.every(value => typeof value === "string")) throw new TypeError("invalid args");
  if (args[0] !== "scan" || args.length !== 1 + FLAGS.length * 2) throw new Error("invalid args");
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!FLAG_SET.has(flag) || values.has(flag) || !value || value.startsWith("--")) throw new Error("invalid args");
    values.set(flag, value);
  }
  if (values.size !== FLAGS.length) throw new Error("invalid args");
  return Object.freeze({
    dataRoot: values.get("--data-root"),
    gameRoot: values.get("--game-root"),
    backupRoot: values.get("--backup-root"),
    appdataRoot: values.get("--appdata-root"),
    steamAppsRoot: values.get("--steamapps-root"),
  });
}

function sourceCandidateIdForPath(path) {
  const normalized = win32.resolve(path).replaceAll("/", "\\").toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function publicReportPath(layout) {
  return layout.root.toLowerCase() === PRODUCTION_DATA_ROOT.toLowerCase()
    ? layout.reportJson
    : "<data-root>\\evidence\\stage1a-report.json";
}
