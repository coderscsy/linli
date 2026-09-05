import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { DesktopController } from "./controller.js";
import { prepareWorkspaceIncrementally } from "./workspace-template.js";

const PREFIX = "OLIVIA\t";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) throw new Error(`缺少参数 ${name}`);
  return process.argv[index + 1];
}

function send(message) {
  process.stdout.write(`${PREFIX}${JSON.stringify(message)}\n`);
}

const startupStartedAt = Date.now();
const root = argument("--root");
const dataDir = argument("--data-dir");
const template = argument("--template");
const appData = argument("--app-data");
const usersettingsPath = argument("--usersettings");
const executable = argument("--executable");
const parentPid = Number(argument("--parent-pid"));
if (!Number.isInteger(parentPid) || parentPid < 1) throw new Error("父进程 PID 无效");
await mkdir(appData, { recursive: true });
await mkdir(dataDir, { recursive: true });
const workspace = await prepareWorkspaceIncrementally({ template, root, settings: join(appData, "settings") });
console.log(`startup-stage=workspace-prepared elapsedMs=${Date.now() - startupStartedAt} changed=${workspace.changed}`);

const controller = new DesktopController({
  root,
  dataDir,
  appData,
  usersettingsPath,
  executable,
  onPortChanged: port => send({ type: "port", port }),
});
const port = await controller.initialize();
console.log(`startup-stage=service-ready elapsedMs=${Date.now() - startupStartedAt}`);
send({ type: "ready", port });
console.log(`[host] ready pid=${process.pid} parent=${parentPid} port=${port}`);

let closing = false;
async function close(reason) {
  if (closing) return;
  closing = true;
  clearInterval(parentWatch);
  console.log(`[host] closing reason=${reason}`);
  await controller.close();
  console.log("[host] backend closed");
}

const handlers = {
  getSettings: () => controller.getSettings(),
  setAutoStart: enabled => controller.setAutoStart(enabled === true),
  setClient: path => controller.setClient(path),
  getClientStatus: () => controller.getClientStatus(),
  mountClient: portValue => controller.mountClient(portValue),
  restoreClient: () => controller.restoreClient(),
  assertSoulExport: () => controller.assertSoulExport(),
  exportSoul: path => controller.exportSoul(path),
  assertRemoteSoulExport: jobId => controller.assertRemoteSoulExport(jobId),
  exportRemoteSoul: (jobId, path) => controller.exportRemoteSoul(jobId, path),
  prepareUpdateInstall: path => controller.prepareUpdateInstall(path),
  shutdown: async () => {
    await close("desktop-command");
    return { stopped: true };
  },
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    close("parent-missing").finally(() => process.exit(0));
  }
}, 1000);
parentWatch.unref();
lines.on("line", async line => {
  let command;
  try {
    command = JSON.parse(line);
    if (command.type !== "command" || typeof handlers[command.method] !== "function")
      throw new Error(`不支持的桌面命令：${command.method ?? ""}`);
    const data = await handlers[command.method](...(Array.isArray(command.args) ? command.args : []));
    send({ type: "response", id: command.id, ok: true, data });
    if (command.method === "shutdown") {
      lines.close();
      process.exit(0);
    }
  } catch (error) {
    send({
      type: "response",
      id: command?.id ?? "",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
lines.once("close", () => {
  if (closing) return;
  close("stdin-closed").finally(() => process.exit(0));
});
process.once("SIGINT", () => close("sigint").finally(() => process.exit(0)));
process.once("SIGTERM", () => close("sigterm").finally(() => process.exit(0)));
process.once("uncaughtException", error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  close("uncaught-exception").finally(() => process.exit(1));
});
