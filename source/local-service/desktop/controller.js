import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOliviaService } from "../server.js";

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

function runProcess(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let outputText = "";
    let errorText = "";
    child.stdout.on("data", chunk => outputText += chunk.toString());
    child.stderr.on("data", chunk => errorText += chunk.toString());
    child.once("error", reject);
    child.once("close", code => {
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
  constructor({ root, dataDir, appData, executable, onPortChanged }) {
    this.root = root;
    this.dataDir = dataDir;
    this.appData = appData;
    this.executable = executable;
    this.onPortChanged = onPortChanged;
    this.settingsPath = join(appData, "desktop-settings.json");
    this.currentPort = DEFAULT_PORT;
    this.clientExePath = "";
    this.service = null;
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

  async runElevatedScript(script, args = []) {
    if (args.length % 2 !== 0) throw new Error("提权脚本参数必须成对传入");
    const formattedArgs = args.map((value, index) => {
      if (index % 2 === 1) return powershellLiteral(value);
      if (!/^-[A-Za-z][A-Za-z0-9]*$/u.test(value)) throw new Error(`非法脚本参数：${value}`);
      return value;
    });
    const errorFile = join(this.appData, `elevated-${randomUUID()}.txt`);
    const invoke = [`& ${powershellLiteral(script)}`, ...formattedArgs].join(" ");
    const command = `try { ${invoke} } catch { [IO.File]::WriteAllText(${powershellLiteral(errorFile)}, $_.Exception.Message, (New-Object Text.UTF8Encoding $false)); exit 1 }`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const elevate = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
    try {
      await runProcess("powershell.exe", powershellCommand(elevate));
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
      try {
        await access(feappPath);
        candidates.push({ version: entry.name, feappPath });
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
      `& ${powershellLiteral(script)} -FeappPath ${powershellLiteral(feappPath)}`));
    return JSON.parse(output);
  }

  async getClientStatus() {
    const layout = await this.selectedClientLayout();
    if (!layout) return {
      clientSelected: false,
      clientExe: "",
      mounted: false,
      port: null,
      servicePort: this.currentPort,
    };
    return {
      clientSelected: true,
      clientExe: this.clientExePath,
      ...(await this.readFeappStatus(layout.feappPath)),
      servicePort: this.currentPort,
    };
  }

  async setClient(path) {
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

  async originalFeapp(layout, createOnMount = false) {
    const key = createHash("md5")
      .update(`${layout.gameRoot.toLowerCase()}\n${layout.version.toLowerCase()}`, "utf8")
      .digest("hex");
    const managedBackup = join(this.appData, "client-backups", `${key}.feapp.dat`);
    try {
      await access(managedBackup);
      if ((await this.readFeappStatus(managedBackup)).mounted) throw new Error("本机保存的客户端原版备份无效");
      return managedBackup;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const current = await this.readFeappStatus(layout.feappPath);
    if (current.mounted) {
      const legacyKey = createHash("md5").update(layout.gameRoot.toLowerCase(), "utf8").digest("hex");
      const legacyBackup = join(this.appData, "client-backups", `${legacyKey}.feapp.dat`);
      try {
        await access(legacyBackup);
        if ((await this.readFeappStatus(legacyBackup)).mounted)
          throw new Error("本机保存的客户端原版备份无效");
        return legacyBackup;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      throw new Error("当前客户端已挂载，但没有挂载前的原版备份");
    }
    if (!createOnMount) throw new Error("未找到当前游戏版本的客户端原版备份");
    return managedBackup;
  }

  async mountClient(value) {
    const port = assertPort(value);
    const layout = await this.selectedClientLayout();
    if (!layout) throw new Error("请先选择游戏 exe");
    const originalFile = await this.originalFeapp(layout, true);
    if (port !== this.currentPort) await assertPortAvailable(port);
    const patchScript = join(this.root, "tools", "patch-feapp-local.ps1");
    const patchArgs = [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-OriginalFile", originalFile,
      "-ServiceUrl", `http://127.0.0.1:${port}`,
    ];
    await this.runElevatedScript(patchScript, patchArgs);
    try {
      await this.changeServicePort(port);
    } catch (error) {
      if (port !== this.currentPort) {
        patchArgs[patchArgs.length - 1] = `http://127.0.0.1:${this.currentPort}`;
        try {
          await this.runElevatedScript(patchScript, patchArgs);
        } catch (rollbackError) {
          throw new Error(`${error.message}；客户端端口回滚失败：${rollbackError.message}`);
        }
      }
      throw error;
    }
    return this.getClientStatus();
  }

  async restoreClient() {
    const layout = await this.selectedClientLayout();
    if (!layout) throw new Error("请先选择游戏 exe");
    const originalFile = await this.originalFeapp(layout);
    await this.runElevatedScript(join(this.root, "tools", "restore-feapp-original.ps1"), [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-OriginalFile", originalFile,
    ]);
    return this.getClientStatus();
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
    const transcriptionRoot = process.env.PROGRAMDATA
      ? join(process.env.PROGRAMDATA, "OliviaSoul")
      : this.appData;
    const nextService = await createOliviaService({
      root: this.root,
      dataDir: this.dataDir,
      appData: this.appData,
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

  async close() {
    if (!this.service) return;
    await this.service.close();
    this.service = null;
  }
}
