import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOliviaService } from "../server.js";
import { resolveClientBackups } from "./client-backups.js";
import {
  assertRegisteredFilePaths,
  discoverVerifiedOptionalClientPatches,
  hasNativeWidgetPatch,
  markRegisteredClientRestored,
  readClientPatchRegistry,
  registerMountedClientPatch,
} from "./client-patch-registry.js";
import { clientPathProbe, networkClosedGamePreflight } from "./client-execution.js";

const DEFAULT_PORT = 27149;
const AUTO_START_TASK = "OliviaSoulAutoStart";
const here = dirname(fileURLToPath(import.meta.url));

function assertPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("端口必须是 1024–65535 的整数");
  return port;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function powershellCommand(command) {
  const utf8Command = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; ${command}`;
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from(utf8Command, "utf16le").toString("base64")];
}

function runProcess(command, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let outputText = "";
    let errorText = "";
    // Only read-only status calls opt into this deadline. Elevated writes must
    // retain their operation lock until the helper actually finishes.
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("客户端只读状态检查超时，请确认后重试"), {
        code: "CLIENT_SERVICE_STATUS_TIMEOUT",
      }));
    }, timeoutMs) : null;
    child.stdout.on("data", chunk => outputText += chunk.toString());
    child.stderr.on("data", chunk => errorText += chunk.toString());
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise(outputText.trim());
      else reject(new Error(errorText.trim() || `命令执行失败：${code}`));
    });
  });
}

function assertPortAvailable(port) {
  return new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.once("error", error => {
      if (error.code === "EADDRINUSE") reject(new Error(`端口 ${port} 已被其他程序占用`));
      else reject(error);
    });
    probe.listen(port, "127.0.0.1", () => probe.close(resolvePromise));
  });
}

export class DesktopController {
  constructor({ root, dataDir, appData, usersettingsPath, executable, onPortChanged }) {
    this.root = root;
    this.dataDir = dataDir;
    this.appData = appData;
    this.usersettingsPath = usersettingsPath;
    this.executable = executable;
    this.onPortChanged = onPortChanged;
    this.settingsPath = join(appData, "desktop-settings.json");
    this.currentPort = DEFAULT_PORT;
    this.clientExePath = "";
    this.service = null;
    this.clientOperation = null;
    this.mountRollbackContext = null;
  }

  async initialize() {
    const settings = await this.readRuntimeSettings();
    this.currentPort = settings.port;
    this.clientExePath = settings.clientExe;
    await this.createOwnedBackend(this.currentPort);
    return this.currentPort;
  }

  async readRuntimeSettings() {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, "utf8"));
      return {
        port: assertPort(settings.port),
        clientExe: typeof settings.clientExe === "string" ? settings.clientExe : "",
      };
    } catch (error) {
      if (error.code === "ENOENT") return { port: DEFAULT_PORT, clientExe: "" };
      throw error;
    }
  }

  async writeRuntimeSettings() {
    await writeFile(this.settingsPath, `${JSON.stringify({
      port: this.currentPort,
      clientExe: this.clientExePath,
    }, null, 2)}\n`, "utf8");
  }

  async queryAutoStart() {
    try {
      await runProcess("schtasks.exe", ["/Query", "/TN", AUTO_START_TASK]);
      return true;
    } catch {
      return false;
    }
  }

  async setAutoStart(enabled) {
    const script = join(here, "startup-task.ps1");
    const helperCommand = [
      `& ${powershellLiteral(script)}`,
      `-Mode '${enabled ? "Enable" : "Disable"}'`,
      `-Executable ${powershellLiteral(this.executable)}`,
      "-Arguments '--hidden'",
    ].join(" ");
    const encoded = Buffer.from(helperCommand, "utf16le").toString("base64");
    const elevate = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
    await runProcess("powershell.exe", powershellCommand(elevate));
    return { autoStart: enabled };
  }

  async runElevatedScript(script, args = [], executionMode = "local") {
    if (args.length % 2 !== 0) throw new Error("提权脚本参数必须成对传入");
    const formattedArgs = [];
    for (let index = 0; index < args.length; index += 2) {
      const parameter = args[index], value = args[index + 1];
      if (!/^-[A-Za-z][A-Za-z0-9]*$/u.test(parameter)) throw new Error(`非法脚本参数：${parameter}`);
      if (["-RefreshOriginal", "-RestoreStudioUi", "-RestoreContainerPlugin", "-PatchNativeOfflineChecks"].includes(parameter)) {
        if (![true, false, "true", "false"].includes(value)) throw new Error("RefreshOriginal 必须是布尔值");
        formattedArgs.push(`${parameter}:$${value === true || value === "true" ? "true" : "false"}`);
      } else formattedArgs.push(parameter, powershellLiteral(value));
    }
    const errorFile = join(this.appData, `elevated-${randomUUID()}.txt`);
    const invoke = [`& ${powershellLiteral(script)}`, ...formattedArgs].join(" ");
    const preflight = executionMode === "network"
      ? networkClosedGamePreflight(args[args.indexOf("-GameRoot") + 1], this.clientExePath) : "";
    const command = `$ErrorActionPreference = 'Stop'; try { ${preflight} ${invoke} } catch { [IO.File]::WriteAllText(${powershellLiteral(errorFile)}, $_.Exception.Message, (New-Object Text.UTF8Encoding $false)); exit 1 }`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const elevate = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
    try {
      await runProcess("powershell.exe", powershellCommand(executionMode === "network" ? command : elevate));
    } catch (error) {
      try {
        const detail = (await readFile(errorFile, "utf8")).trim();
        if (detail) throw new Error(detail);
      } catch (detailError) {
        if (detailError.code !== "ENOENT") throw detailError;
      }
      throw error;
    } finally {
      await rm(errorFile, { force: true });
    }
  }

  async selectedClientLayout() {
    if (!this.clientExePath) return null;
    if (extname(this.clientExePath).toLowerCase() !== ".exe") throw new Error("请选择游戏 exe 文件");
    await access(this.clientExePath);
    const gameRoot = dirname(this.clientExePath);
    const candidates = [];
    for (const entry of await readdir(gameRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const feappPath = join(gameRoot, entry.name, "resources", "feapp.dat");
      const webplayerPath = join(gameRoot, entry.name, "resources", "webplayer.dat");
      try {
        await access(feappPath);
        await access(webplayerPath);
        candidates.push({ version: entry.name, feappPath, webplayerPath });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (candidates.length !== 1) throw new Error(`所选 exe 目录应包含一个客户端版本，当前找到 ${candidates.length} 个`);
    return { gameRoot, ...candidates[0] };
  }

  async readFeappStatus(feappPath) {
    const script = join(this.root, "tools", "get-feapp-status.ps1");
    const output = await runProcess("powershell.exe", powershellCommand(
      `& ${powershellLiteral(script)} -FeappPath ${powershellLiteral(feappPath)}`), { timeoutMs: 15_000 });
    return JSON.parse(output);
  }

  async readWebplayerStatus(webplayerPath) {
    const script = join(this.root, "tools", "get-webplayer-status.ps1");
    const output = await runProcess("powershell.exe", powershellCommand(
      `& ${powershellLiteral(script)} -WebplayerPath ${powershellLiteral(webplayerPath)}`), { timeoutMs: 15_000 });
    return JSON.parse(output);
  }

  async getClientStatus(fixedLayout = null, fixedClientExe = this.clientExePath) {
    const layout = fixedLayout ?? await this.selectedClientLayout();
    if (!layout) return {
      clientSelected: false,
      clientExe: "",
      mounted: false,
      feappMounted: false,
      webplayerMounted: false,
      port: null,
      servicePort: this.currentPort,
    };
    const [feapp, webplayer, widgets] = await Promise.all([
      this.readFeappStatus(layout.feappPath),
      this.readWebplayerStatus(layout.webplayerPath),
      this.readNativeWidgetStatus(layout),
    ]);
    return {
      clientSelected: true,
      clientExe: fixedClientExe,
      ...feapp,
      mounted: Boolean(feapp.mounted && webplayer.mounted && (!widgets.required || widgets.ready)),
      nativeWidgetsReady: widgets.ready,
      updateAvailable: Boolean(feapp.updateAvailable || (feapp.mounted && widgets.required && !widgets.ready)),
      feappMounted: Boolean(feapp.mounted || feapp.managed || feapp.updateAvailable),
      webplayerFound: webplayer.clientFound,
      webplayerMounted: Boolean(webplayer.mounted || webplayer.managed || webplayer.updateAvailable),
      servicePort: this.currentPort,
    };
  }

  async setClient(path) {
    if (this.clientOperation) throw Object.assign(new Error("客户端启停操作仍在执行，请等待完成"), {
      code: "CLIENT_SERVICE_BUSY", stage: "busy",
    });
    const previous = this.clientExePath;
    this.clientExePath = String(path ?? "");
    try {
      await this.selectedClientLayout();
      await this.writeRuntimeSettings();
    } catch (error) {
      this.clientExePath = previous;
      throw error;
    }
    return { ...(await this.getClientStatus()), selectionChanged: true };
  }

  async originalClientBackups(layout, createOnMount = false) {
    return resolveClientBackups({
      layout, dataDir: this.dataDir, appData: this.appData, createOnMount,
      readFeappStatus: path => this.readFeappStatus(path),
      readWebplayerStatus: path => this.readWebplayerStatus(path),
    });
  }

  async readNativeWidgetStatus(layout) {
    if (layout.version !== "0.0.9.627") return { required: false, ready: false };
    const targets = [["studioUi", "Studio", "NutStudioUI.dll"], ["containerPlugin", "Container", "NutContainerPlugin.dll"]];
    const results = await Promise.all(targets.map(async ([kind, dir, name]) => {
      try { return hasNativeWidgetPatch(kind, await readFile(join(layout.gameRoot, layout.version, "plugins", dir, name))); }
      catch { return false; }
    }));
    return { required: true, ready: results.every(Boolean) };
  }

  async originalFeapp(layout, createOnMount = false) {
    return (await this.originalClientBackups(layout, createOnMount)).feapp;
  }

  async originalWebplayer(layout, createOnMount = false) {
    return (await this.originalClientBackups(layout, createOnMount)).webplayer;
  }

  async registerCurrentClientPatch() {
    const layout = await this.selectedClientLayout();
    if (!layout) throw new Error("cannot register an unselected client");
    const originals = await this.originalClientBackups(layout);
    const optionalFiles = await discoverVerifiedOptionalClientPatches({
      clientRoot: layout.gameRoot, version: layout.version, feappBackup: originals.feapp,
    });
    return registerMountedClientPatch({
      userData: this.appData,
      clientRoot: layout.gameRoot,
      version: layout.version,
      files: [
        { kind: "feapp", target: layout.feappPath, backup: originals.feapp },
        { kind: "webplayer", target: layout.webplayerPath, backup: originals.webplayer },
        ...optionalFiles,
      ],
    });
  }

  async markCurrentClientRestored() {
    const layout = await this.selectedClientLayout();
    if (!layout) return false;
    return markRegisteredClientRestored({ userData: this.appData, clientRoot: layout.gameRoot, version: layout.version });
  }

  async clientStage(stage, run) {
    const operation = this.clientOperation ?? "status";
    console.log(`[client-service] operation=${operation} stage=${stage} status=start`);
    try {
      const result = await run();
      console.log(`[client-service] operation=${operation} stage=${stage} status=complete`);
      return result;
    } catch (error) {
      console.error(`[client-service] operation=${operation} stage=${stage} status=failed`);
      if (error.stage) throw error;
      throw Object.assign(new Error(`客户端服务 ${stage} 失败：${error.message}`, { cause: error }), {
        code: error.code ?? "CLIENT_SERVICE_FAILED", stage,
      });
    }
  }

  async clientWrite(script, args) {
    return this.clientStage(basename(script, ".ps1").replace(/[^a-z0-9-]/gu, ""),
      async () => {
        const index = args.indexOf("-GameRoot");
        if (index < 0 || typeof args[index + 1] !== "string" || !args[index + 1])
          throw new Error("缺少游戏目录参数");
        const mode = await runProcess("powershell.exe", powershellCommand(clientPathProbe(args[index + 1])),
          { timeoutMs: 15_000 });
        if (mode !== "network" && mode !== "local") throw new Error("无法确认游戏目录执行环境");
        return this.runElevatedScript(script, args, mode);
      });
  }

  async clientOperationGuard(operation, run) {
    if (this.clientOperation) throw Object.assign(new Error("客户端启停操作仍在执行，请等待完成"), {
      code: "CLIENT_SERVICE_BUSY", stage: "busy",
    });
    this.clientOperation = operation;
    try {
      return await this.clientStage(operation, async () => {
        const status = await run();
        const verified = await this.clientStage(operation === "restore" ? "verify-restored" : "verify-mounted", async () => {
          if (operation === "restore") {
            if (!status.clientSelected || !status.clientFound || !status.webplayerFound
              || status.feappMounted !== false || status.webplayerMounted !== false)
              throw new Error("未确认客户端和桌面播放器均已恢复原版");
          } else if (!status.mounted) throw new Error("未确认客户端和桌面播放器均已完成挂载");
          return status;
        });
        if (operation === "restore") {
          const fixed = this.restoreOperationContext;
          await this.clientStage("mark-restored", () => fixed?.record
            ? markRegisteredClientRestored({ userData: this.appData, clientRoot: fixed.layout.gameRoot, version: fixed.layout.version })
            : this.markCurrentClientRestored());
        } else {
          try { await this.clientStage("register", () => this.registerCurrentClientPatch()); }
          catch (error) {
            try {
              const rolledBack = await this.clientStage("registration-rollback", () => this.restoreClientResources({
                allowUnverifiedOptionals: true, rollbackContext: this.mountRollbackContext,
              }));
              if (!rolledBack.clientSelected || !rolledBack.clientFound || !rolledBack.webplayerFound
                || rolledBack.feappMounted !== false || rolledBack.webplayerMounted !== false)
                throw new Error("registration rollback was not verified restored");
            } catch (rollbackError) {
              throw new Error(`${error.message}; client registration rollback failed: ${rollbackError.message}`, { cause: error });
            }
            throw error;
          }
        }
        return verified;
      });
    } finally {
      this.clientOperation = null;
      this.mountRollbackContext = null;
      this.restoreOperationContext = null;
    }
  }

  async mountClient(value) {
    return this.clientOperationGuard("mount", () => this.mountClientResources(value));
  }

  async nativeRestoreArgs(layout, originalFile) {
    if (layout.version !== "0.0.9.627") return [];
    const files = await discoverVerifiedOptionalClientPatches({
      clientRoot: layout.gameRoot, version: layout.version, feappBackup: originalFile,
    });
    return files.flatMap(file => file.kind === "studioUi" ? ["-RestoreStudioUi", true]
      : file.kind === "containerPlugin" ? ["-RestoreContainerPlugin", true] : []);
  }

  async mountClientResources(value) {
    const port = assertPort(value);
    const layout = await this.clientStage("layout", () => this.selectedClientLayout());
    if (!layout) throw new Error("请先选择游戏 exe");
    const [current, currentWebplayer] = await this.clientStage("read-current", () => Promise.all([
      this.readFeappStatus(layout.feappPath), this.readWebplayerStatus(layout.webplayerPath),
    ]));
    const originals = await this.clientStage("originals", () => this.originalClientBackups(layout, true));
    this.mountRollbackContext = { layout, originals };
    if (current.updateAvailable || (current.mounted && ["v31", "v32"].includes(current.revision) && layout.version === "0.0.9.627")) {
      if (["v24", "v25", "v26", "v27", "v28", "v29", "v30", "v31", "v32"].includes(current.revision)) {
        const originalFile = originals.feapp;
        // FE-only v28/v29/v30 upgrades must not disturb a current same-port player.
        const keepWebplayer = ["v28", "v29", "v30", "v31", "v32"].includes(current.revision)
          && currentWebplayer.mounted && currentWebplayer.port === port;
        const originalWebplayer = keepWebplayer ? null : originals.webplayer;
        if (port !== this.currentPort) await assertPortAvailable(port);
        const patchScript = join(this.root, "tools", "patch-feapp-local.ps1");
        const webplayerPatchScript = join(this.root, "tools", "patch-webplayer-local.ps1");
        const patchArgs = [
          "-GameRoot", layout.gameRoot,
          "-Version", layout.version,
          "-OriginalFile", originalFile,
          ...(layout.version === "0.0.9.627" ? ["-PatchNativeOfflineChecks", true] : []),
          "-ServiceUrl", `http://127.0.0.1:${port}`,
        ];
        const webplayerPatchArgs = [
          "-GameRoot", layout.gameRoot,
          "-Version", layout.version,
          "-OriginalFile", originalWebplayer,
          "-ServiceUrl", `http://127.0.0.1:${port}`,
        ];
        try {
          await this.clientWrite(patchScript, patchArgs);
          if (!keepWebplayer) await this.clientWrite(webplayerPatchScript, webplayerPatchArgs);
        } catch (error) {
          await this.clientWrite(join(this.root, "tools", "restore-feapp-original.ps1"), [
            "-GameRoot", layout.gameRoot, "-Version", layout.version, "-OriginalFile", originalFile,
            ...await this.nativeRestoreArgs(layout, originalFile),
          ]);
          if (!keepWebplayer) await this.clientWrite(join(this.root, "tools", "restore-webplayer-original.ps1"), [
            "-GameRoot", layout.gameRoot, "-Version", layout.version, "-OriginalFile", originalWebplayer,
          ]);
          throw error;
        }
        await this.changeServicePort(port);
        return this.clientStage("read-after", () => this.getClientStatus());
      }
      if (port !== this.currentPort) await assertPortAvailable(port);
      const upgradeScript = join(this.root, "tools", ["v22", "v23"].includes(current.revision)
        ? "upgrade-feapp-v22-v23.ps1"
        : "upgrade-feapp-v16-v17.ps1");
      const upgradeArgs = [
        "-GameRoot", layout.gameRoot,
        "-Version", layout.version,
        "-ServiceUrl", `http://127.0.0.1:${port}`,
      ];
      await this.clientWrite(upgradeScript, upgradeArgs);
      if (currentWebplayer.updateAvailable) {
        await this.clientWrite(join(this.root, "tools", "upgrade-webplayer-v6-v7.ps1"), [
          "-GameRoot", layout.gameRoot,
          "-Version", layout.version,
          "-ServiceUrl", `http://127.0.0.1:${port}`,
        ]);
      } else if (!currentWebplayer.mounted) {
        const originalWebplayer = originals.webplayer;
        await this.clientWrite(join(this.root, "tools", "patch-webplayer-local.ps1"), [
          "-GameRoot", layout.gameRoot,
          "-Version", layout.version,
          "-OriginalFile", originalWebplayer,
          "-ServiceUrl", `http://127.0.0.1:${port}`,
        ]);
      }
      try {
        await this.changeServicePort(port);
      } catch (error) {
        if (port !== this.currentPort) {
          upgradeArgs[upgradeArgs.length - 1] = `http://127.0.0.1:${this.currentPort}`;
          await this.clientWrite(upgradeScript, upgradeArgs);
        }
        throw error;
      }
      return this.clientStage("read-after", () => this.getClientStatus());
    }
    const originalFile = originals.feapp;
    const originalWebplayer = originals.webplayer;
    if (port !== this.currentPort) await assertPortAvailable(port);
    const patchScript = join(this.root, "tools", "patch-feapp-local.ps1");
    const patchArgs = [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-OriginalFile", originalFile,
      ...(layout.version === "0.0.9.627" ? ["-PatchNativeOfflineChecks", true] : []),
    ];
    // The paired resolver already owns the verified originals. Never ask a
    // patch or port rollback to refresh them from a potentially patched game.
    patchArgs.push("-ServiceUrl", `http://127.0.0.1:${port}`);
    const webplayerPatchScript = join(this.root, "tools", "patch-webplayer-local.ps1");
    const webplayerPatchArgs = [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-OriginalFile", originalWebplayer,
    ];
    webplayerPatchArgs.push("-ServiceUrl", `http://127.0.0.1:${port}`);
    try {
      await this.clientWrite(patchScript, patchArgs);
      await this.clientWrite(webplayerPatchScript, webplayerPatchArgs);
    } catch (error) {
      try {
        await this.clientWrite(join(this.root, "tools", "restore-feapp-original.ps1"), [
          "-GameRoot", layout.gameRoot, "-Version", layout.version, "-OriginalFile", originalFile,
          ...await this.nativeRestoreArgs(layout, originalFile),
        ]);
        await this.clientWrite(join(this.root, "tools", "restore-webplayer-original.ps1"), [
          "-GameRoot", layout.gameRoot, "-Version", layout.version, "-OriginalFile", originalWebplayer,
        ]);
      } catch (rollbackError) {
        throw new Error(`${error.message}；客户端资源回滚失败：${rollbackError.message}`);
      }
      throw error;
    }
    try {
      await this.changeServicePort(port);
    } catch (error) {
      if (port !== this.currentPort) {
        patchArgs[patchArgs.length - 1] = `http://127.0.0.1:${this.currentPort}`;
        webplayerPatchArgs[webplayerPatchArgs.length - 1] = `http://127.0.0.1:${this.currentPort}`;
        try {
          await this.clientWrite(patchScript, patchArgs);
          await this.clientWrite(webplayerPatchScript, webplayerPatchArgs);
        } catch (rollbackError) {
          throw new Error(`${error.message}；客户端端口回滚失败：${rollbackError.message}`);
        }
      }
      throw error;
    }
    return this.clientStage("read-after", () => this.getClientStatus());
  }

  async restoreClient() {
    return this.clientOperationGuard("restore", async () => {
      const layout = await this.clientStage("layout", () => this.selectedClientLayout());
      if (!layout) throw new Error("请先选择游戏 exe");
      const fixedClientExe = this.clientExePath;
      const registry = await this.clientStage("registry", () => readClientPatchRegistry({ userData: this.appData }));
      const found = registry.clients.find(client => client.state === "active"
        && resolve(client.clientRoot).toLowerCase() === resolve(layout.gameRoot).toLowerCase()
        && client.version.toLowerCase() === layout.version.toLowerCase());
      this.restoreOperationContext = {
        layout: { ...layout }, fixedClientExe,
        record: found ? structuredClone(found) : null,
      };
      return this.restoreClientResources({ restoreContext: this.restoreOperationContext });
    });
  }

  async restoreClientResources({ allowUnverifiedOptionals = false, rollbackContext = null, restoreContext = null } = {}) {
    const layout = await this.clientStage("layout", () => restoreContext?.layout ?? rollbackContext?.layout ?? this.selectedClientLayout());
    if (!layout) throw new Error("请先选择游戏 exe");
    const fixedRecord = restoreContext?.record;
    const registeredFe = fixedRecord?.files.find(file => file.kind === "feapp");
    const registeredWebplayer = fixedRecord?.files.find(file => file.kind === "webplayer");
    const { feapp: originalFile, webplayer: originalWebplayer } = await this.clientStage("originals", () => {
      if (fixedRecord) {
        if (!registeredFe || !registeredWebplayer) throw new Error("active client registration is missing FE or WebPlayer");
        return { feapp: registeredFe.backup, webplayer: registeredWebplayer.backup };
      }
      return rollbackContext?.originals ?? this.originalClientBackups(layout);
    });
    const registeredFiles = fixedRecord ? await this.clientStage("registered-preflight", async () => {
      const verified = [];
      for (const file of fixedRecord.files) {
        await assertRegisteredFilePaths({ userData: this.appData, clientRoot: layout.gameRoot, version: layout.version, file });
        let original, current;
        try { [original, current] = await Promise.all([readFile(file.backup), readFile(file.target)]); }
        catch (error) { throw new Error(`registered ${file.kind} backup or target is missing`, { cause: error }); }
        if (original.includes(Buffer.from("OliviaSoulPatch"))) throw new Error(`registered ${file.kind} backup contains patch data`);
        const originalHash = createHash("sha256").update(original).digest("hex");
        const currentHash = createHash("sha256").update(current).digest("hex");
        if (originalHash !== file.originalSha256) throw new Error(`registered ${file.kind} backup hash mismatch`);
        if (currentHash !== file.patchedSha256 && currentHash !== file.originalSha256)
          throw new Error(`registered ${file.kind} target changed`);
        verified.push({ ...file, needsWrite: currentHash === file.patchedSha256 });
      }
      return verified;
    }) : null;
    const optionalFiles = await this.clientStage("optional-originals", async () => {
      if (!allowUnverifiedOptionals) {
        const registry = fixedRecord ? null : await readClientPatchRegistry({ userData: this.appData });
        const record = fixedRecord ?? registry.clients.find(client => client.state === "active"
          && resolve(client.clientRoot).toLowerCase() === resolve(layout.gameRoot).toLowerCase()
          && client.version.toLowerCase() === layout.version.toLowerCase());
        if (record) {
          const names = { studioUi: `NutStudioUI-${layout.version}.dll`, containerPlugin: `NutContainerPlugin-${layout.version}.dll` };
          const registered = [];
          for (const file of (registeredFiles ?? record.files).filter(item => !["feapp", "webplayer"].includes(item.kind))) {
            if (!names[file.kind] || resolve(file.backup).toLowerCase() !== resolve(dirname(originalFile), names[file.kind]).toLowerCase())
              throw new Error(`registered optional ${file.kind} backup path is not the exact staged sidecar`);
            await assertRegisteredFilePaths({ userData: this.appData, clientRoot: layout.gameRoot, version: layout.version, file });
            if (registeredFiles) registered.push(file);
            else {
              let original, current;
              try { [original, current] = await Promise.all([readFile(file.backup), readFile(file.target)]); }
              catch (error) { throw new Error(`registered optional ${file.kind} backup or target is missing`, { cause: error }); }
              const originalHash = createHash("sha256").update(original).digest("hex");
              const currentHash = createHash("sha256").update(current).digest("hex");
              if (originalHash !== file.originalSha256) throw new Error(`registered optional ${file.kind} backup hash mismatch`);
              const expectedCurrent = file.state === "restored" ? file.originalSha256 : file.patchedSha256;
              if (currentHash !== expectedCurrent && !(file.state === "active" && currentHash === file.originalSha256))
                throw new Error(`registered optional ${file.kind} target changed`);
              registered.push({ ...file, needsWrite: currentHash === file.patchedSha256 });
            }
          }
          return registered;
        }
      }
      try {
        return (await discoverVerifiedOptionalClientPatches({
          clientRoot: layout.gameRoot, version: layout.version, feappBackup: originalFile,
        })).map(file => ({ ...file, needsWrite: true }));
      } catch (error) {
        if (!allowUnverifiedOptionals) throw error;
        return [];
      }
    });
    const restoreArgs = [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-OriginalFile", originalFile,
    ];
    if (optionalFiles.some(file => file.kind === "studioUi" && file.needsWrite)) restoreArgs.push("-RestoreStudioUi", true);
    if (optionalFiles.some(file => file.kind === "containerPlugin" && file.needsWrite)) restoreArgs.push("-RestoreContainerPlugin", true);
    await this.clientWrite(join(this.root, "tools", "restore-feapp-original.ps1"), restoreArgs);
    await this.clientWrite(join(this.root, "tools", "restore-webplayer-original.ps1"), [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-OriginalFile", originalWebplayer,
    ]);
    await this.clientStage("verify-optional-restored", async () => {
      for (const file of optionalFiles) {
        if (!(await readFile(file.target)).equals(await readFile(file.backup)))
          throw new Error(`未确认 ${file.kind} 已恢复原版`);
      }
    });
    return this.clientStage("read-after", () => this.getClientStatus(layout, restoreContext?.fixedClientExe ?? this.clientExePath));
  }

  async assertSoulExport() {
    const response = await fetch(`http://127.0.0.1:${this.currentPort}/admin/api/memory/export/soul`, {
      method: "HEAD",
    });
    if (response.ok) return { available: true };
    if (response.status === 409) throw new Error("暂无记忆");
    throw new Error(`导出检查失败：HTTP ${response.status}`);
  }

  async exportSoul(path) {
    const target = String(path ?? "");
    if (!target.toLowerCase().endsWith(".soul")) throw new Error("导出路径必须以 .soul 结尾");
    const response = await fetch(`http://127.0.0.1:${this.currentPort}/admin/api/memory/export/soul`);
    if (!response.ok) throw new Error(response.headers.get("content-type")?.includes("application/json")
      ? (await response.json()).message
      : `导出失败：HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
      return { cancelled: false, path: target };
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  async assertRemoteSoulExport(jobId) {
    const response = await fetch(`http://127.0.0.1:${this.currentPort}/admin/api/remote-memory/${encodeURIComponent(jobId)}/soul`, {
      method: "HEAD",
    });
    if (response.ok) return { available: true };
    throw new Error(`远端导出检查失败：HTTP ${response.status}`);
  }

  async exportRemoteSoul(jobId, path) {
    const target = String(path ?? "");
    if (!target.toLowerCase().endsWith(".soul")) throw new Error("导出路径必须以 .soul 结尾");
    const response = await fetch(`http://127.0.0.1:${this.currentPort}/admin/api/remote-memory/${encodeURIComponent(jobId)}/soul`);
    if (!response.ok) throw new Error(response.headers.get("content-type")?.includes("application/json")
      ? (await response.json()).message
      : `远端导出失败：HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
      return { cancelled: false, path: target };
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }

  async createOwnedBackend(port) {
    const transcriptionRoot = resolve(this.dataDir, "..");
    const installDrive = parse(resolve(this.executable)).root;
    const legacyDatabasePaths = [
      process.env.APPDATA ? join(process.env.APPDATA, "OliviaSoul", "data", "olivia-local.sqlite") : "",
      installDrive ? join(installDrive, "OliviaSoulData", "OliviaSoul", "data", "olivia-local.sqlite") : "",
    ].filter(Boolean);
    const legacyArchiveDirs = [
      process.env.APPDATA ? join(process.env.APPDATA, "OliviaSoul", "信件往来") : "",
      process.env.APPDATA ? join(process.env.APPDATA, "OliviaSoul", "workspace", "信件往来") : "",
      installDrive ? join(installDrive, "OliviaSoulData", "OliviaSoul", "信件往来") : "",
      installDrive ? join(installDrive, "OliviaSoulData", "OliviaSoul", "workspace", "信件往来") : "",
    ].filter(Boolean);
    const legacyWorkspaceRoots = [
      process.env.APPDATA ? join(process.env.APPDATA, "OliviaSoul") : "",
      process.env.APPDATA ? join(process.env.APPDATA, "OliviaSoul", "workspace") : "",
      installDrive ? join(installDrive, "OliviaSoulData", "OliviaSoul") : "",
      installDrive ? join(installDrive, "OliviaSoulData", "OliviaSoul", "workspace") : "",
    ].filter(Boolean);
    const nextService = await createOliviaService({
      root: this.root,
      dataDir: this.dataDir,
      appData: this.appData,
      usersettingsPath: this.usersettingsPath,
      deferStorageRefresh: true,
      legacyDatabasePaths,
      legacyArchiveDirs,
      legacyWorkspaceRoots,
      runtimeDir: join(dirname(this.executable), "runtime"),
      transcriptionModelsDir: join(transcriptionRoot, "models"),
      transcriptionTempDir: join(transcriptionRoot, "transcription"),
    });
    try {
      await nextService.listen(port, "127.0.0.1");
    } catch (error) {
      await nextService.close();
      if (error.code === "EADDRINUSE") throw new Error(`端口 ${port} 已被其他程序占用`);
      throw error;
    }
    this.service = nextService;
  }

  async changeServicePort(value) {
    const port = assertPort(value);
    if (port === this.currentPort) return port;
    await assertPortAvailable(port);
    const oldPort = this.currentPort;
    await this.service.close();
    this.service = null;
    try {
      await this.createOwnedBackend(port);
    } catch (error) {
      await this.createOwnedBackend(oldPort);
      throw error;
    }
    this.currentPort = port;
    try {
      await this.writeRuntimeSettings();
    } catch (error) {
      await this.service.close();
      this.service = null;
      this.currentPort = oldPort;
      await this.createOwnedBackend(oldPort);
      throw error;
    }
    if (this.onPortChanged) this.onPortChanged(port);
    return port;
  }

  async getSettings() {
    return {
      autoStart: await this.queryAutoStart(),
      port: this.currentPort,
      clientExe: this.clientExePath,
    };
  }

  async prepareUpdateInstall(path) {
    const target = resolve(String(path ?? ""));
    const updatesRoot = resolve(this.dataDir, "updates");
    const childPath = relative(updatesRoot, target);
    if (!childPath || childPath.startsWith("..") || isAbsolute(childPath))
      throw new Error("只能安装由 Olivia Soul 下载到本地数据目录的更新包");
    if (extname(target).toLowerCase() !== ".exe") throw new Error("更新包必须是 .exe 安装程序");
    await access(target);
    return { path: target };
  }

  async close() {
    if (!this.service) return;
    await this.service.close();
    this.service = null;
  }
}
