import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { collectProtocolEvidence } from "./binary-evidence.js";
import { validateRendererCandidate } from "./candidate.js";
import { scanRendererInventory } from "./inventory.js";
import { assertContained, resolveProbeLayout } from "./layout.js";
import { redactSecrets } from "./redaction.js";
import { buildStage1AReport, writeStage1AReport } from "./report.js";

const FLAGS = Object.freeze(["--data-root", "--game-root", "--backup-root", "--appdata-root", "--steamapps-root"]);
const FLAG_SET = new Set(FLAGS);
const APP_MANIFEST = "appmanifest_4532590.acf";
const MARKER = "ovilia_Win64_Development_15918";
const DEFAULT_REQUIRED_DRIVE = "I:";
const PRODUCTION_DATA_ROOT = win32.resolve("I:\\OliviaSoulData\\MidiRenderer");
const PARTIAL_SUFFIX = ".partial";

export async function runCli(args, options) {
  let parsed;
  let injection;
  try {
    parsed = parseArgs(args);
    injection = parseTestDriveInjection(options);
  } catch {
    writeStderr("renderer-probe: invalid scan arguments\n");
    return 1;
  }

  let layout;
  try {
    layout = injection.injected
      ? resolveTemporaryTestLayout(parsed.dataRoot, injection.requiredDrive)
      : resolveProbeLayout(parsed.dataRoot);
  } catch {
    writeStderr("renderer-probe: unsafe data root\n");
    return 1;
  }

  const manifestPath = join(parsed.steamAppsRoot, APP_MANIFEST);
  try {
    const manifestStats = await lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
      writeStderr(`renderer-probe: missing ${APP_MANIFEST}\n`);
      return 1;
    }
  } catch (error) {
    writeStderr(error?.code === "ENOENT"
      ? `renderer-probe: missing ${APP_MANIFEST}\n`
      : "renderer-probe: inventory scan failed\n");
    return 1;
  }

  let inventory;
  try {
    inventory = await scanRendererInventory({
      roots: [parsed.gameRoot, parsed.backupRoot, parsed.appdataRoot],
      steamAppsRoot: parsed.steamAppsRoot,
      marker: MARKER,
    });
  } catch {
    writeStderr("renderer-probe: inventory scan failed\n");
    return 1;
  }

  const binaryInputs = [
    join(parsed.gameRoot, "0.0.9.627", "plugins", "Studio", "NutLivePlayer.dll"),
    join(parsed.gameRoot, "0.0.9.627", "plugins", "Studio", "NutStudioPlugin.dll"),
    join(parsed.gameRoot, "version.json"),
  ];
  let protocolEvidence;
  try {
    protocolEvidence = await collectProtocolEvidence(binaryInputs);
  } catch {
    protocolEvidence = {
      files: binaryInputs.map(path => ({ path, error: "collection_failed" })),
      markers: [],
      messages: [],
      paths: [],
    };
  }

  const validations = [];
  for (const executable of inventory.candidates) {
    try {
      validations.push(await validateRendererCandidate(executable));
    } catch {
      validations.push({
        status: "incomplete",
        rendererRoot: "<candidate>/TPRender",
        executable: "<candidate>/TPRender/Binaries/Win64/Olivia.exe",
        files: [],
        missing: ["candidate_validation_failed"],
        totalBytes: 0,
      });
    }
  }

  const report = buildStage1AReport({
    inventory,
    protocolEvidence,
    validations,
    generatedAt: new Date().toISOString(),
  });

  try {
    await writeAtomicJson(layout, layout.binaryEvidenceJson, report.protocolEvidence);
  } catch {
    writeStderr("renderer-probe: evidence write failed\n");
    return 1;
  }
  try {
    await writeStage1AReport(layout, report);
  } catch {
    writeStderr("renderer-probe: report write failed\n");
    return 1;
  }

  const summary = canonicalize({
    status: report.status,
    reportJson: publicReportPath(layout, injection.injected),
    counts: {
      candidates: inventory.candidates.length,
      completeValidations: validations.filter(validation => validation.status === "complete").length,
      protocolFiles: report.protocolEvidence.files.length,
    },
  });
  process.stdout.write(`${JSON.stringify(redactSecrets(summary))}\n`);
  return report.status === "candidate_ready" ? 0 : 2;
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

function parseTestDriveInjection(options) {
  if (options === undefined) return { injected: false, requiredDrive: DEFAULT_REQUIRED_DRIVE };
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("invalid options");
  const keys = Object.keys(options);
  if (keys.length !== 1 || keys[0] !== "requiredDrive") throw new TypeError("invalid options");
  const descriptor = Object.getOwnPropertyDescriptor(options, "requiredDrive");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string" || !/^[A-Za-z]:$/u.test(descriptor.value)) {
    throw new TypeError("invalid options");
  }
  return { injected: true, requiredDrive: descriptor.value.toUpperCase() };
}

function resolveTemporaryTestLayout(dataRoot, requiredDrive) {
  const expectedRoot = resolve(dataRoot);
  const temporaryRoot = resolve(tmpdir());
  const pathRelative = relative(temporaryRoot, expectedRoot);
  if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) throw new Error("unsafe test root");
  const firstSegment = pathRelative.split(sep)[0];
  if (!firstSegment.startsWith("olivia-renderer-cli-")) throw new Error("unsafe test root");
  if (win32.parse(expectedRoot).root.slice(0, 2).toUpperCase() !== requiredDrive) throw new Error("wrong test drive");

  const evidenceDir = assertContained(expectedRoot, join(expectedRoot, "evidence"));
  return Object.freeze({
    root: expectedRoot,
    evidenceDir,
    reportJson: assertContained(expectedRoot, join(evidenceDir, "stage1a-report.json")),
    reportMarkdown: assertContained(expectedRoot, join(evidenceDir, "stage1a-report.md")),
    binaryEvidenceJson: assertContained(expectedRoot, join(evidenceDir, "binary-protocol-evidence.json")),
  });
}

async function writeAtomicJson(layout, target, value) {
  const safeTarget = assertContained(layout.root, target);
  const safePartial = assertContained(layout.root, `${safeTarget}${PARTIAL_SUFFIX}`);
  const evidenceDir = assertContained(layout.root, layout.evidenceDir);
  assertContained(evidenceDir, safeTarget);
  assertContained(evidenceDir, safePartial);
  if (dirname(safeTarget) !== evidenceDir || basename(safeTarget) !== "binary-protocol-evidence.json") throw new Error("invalid evidence target");

  await mkdir(evidenceDir, { recursive: true });
  const canonicalRoot = await realpath(layout.root);
  const evidenceStats = await lstat(evidenceDir);
  if (evidenceStats.isSymbolicLink() || !evidenceStats.isDirectory()) throw new Error("invalid evidence directory");
  assertContained(canonicalRoot, await realpath(evidenceDir));
  await rejectUnsafeTarget(safeTarget);

  const contents = `${JSON.stringify(canonicalize(redactSecrets(value)), null, 2)}\n`;
  let handle;
  let identity;
  let owned = false;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await open(safePartial, flags, 0o600);
    owned = true;
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await lstat(safePartial, { bigint: true });
    if (!sameIdentity(identity, current) || !current.isFile() || current.isSymbolicLink()) throw new Error("evidence partial changed");
    await rejectUnsafeTarget(safeTarget);
    await rename(safePartial, safeTarget);
    owned = false;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (owned) await cleanExactPartial(safePartial, identity);
    throw error;
  }
}

async function rejectUnsafeTarget(target) {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("invalid output target");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanExactPartial(path, identity) {
  try {
    const current = await lstat(path, { bigint: true });
    if (sameIdentity(identity, current) && current.isFile() && !current.isSymbolicLink()) await unlink(path);
  } catch {
    // Best effort only for the exact file created by this invocation.
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && typeof left.dev === typeof right.dev && typeof left.ino === typeof right.ino
    && left.dev === right.dev && left.ino === right.ino);
}

function canonicalize(value) {
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return null;
  if (Array.isArray(value)) return value.map(canonicalize).sort(compareCanonical);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort(compareText)) output[key] = canonicalize(value[key]);
  return output;
}

function compareCanonical(left, right) { return compareText(JSON.stringify(left), JSON.stringify(right)); }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function writeStderr(message) { process.stderr.write(message); }
function publicReportPath(layout, injected) {
  return !injected && layout.root.toLowerCase() === PRODUCTION_DATA_ROOT.toLowerCase()
    ? layout.reportJson
    : "<data-root>\\evidence\\stage1a-report.json";
}

const executablePath = process.argv[1] ? resolve(process.argv[1]) : "";
if (executablePath && executablePath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
