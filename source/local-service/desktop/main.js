import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createOliviaService } from "../server.js";
import { prepareWorkspaceIncrementally } from "./workspace-template.js";

const here = dirname(fileURLToPath(import.meta.url));
const developmentRoot = resolve(here, "..", "..");
const DEFAULT_PORT = 27149;
const hiddenAtLaunch = process.argv.includes("--hidden");
let mainWindow;
let tray;
let service;
let quitting = false;
let backendClosed = false;
let trayNoticeShown = false;
let autoStart = false;
let currentPort = DEFAULT_PORT;
let clientExePath = "";

function assertPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("端口必须是 1024–65535 的整数");
  return port;
}

function adminUrl(port = currentPort) {
  return `http://127.0.0.1:${port}/admin`;
}

function loadingDocumentUrl(message = "正在启动本地服务，请稍候……") {
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0;background:#111114;color:#eeeae4;font-family:Segoe UI,Microsoft YaHei UI,sans-serif}body{display:grid;place-items:center}.box{text-align:center}.mark{font-size:28px;letter-spacing:.08em}p{color:#85858b;font-size:13px}</style><body><div class="box"><div class="mark">OLIVIA SOUL</div><p>${message}</p></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function runtimeSettingsPath() {
  return join(app.getPath("userData"), "desktop-settings.json");
}

function desktopDataDir() {
  return app.isPackaged ? join(app.getPath("userData"), "data") : join(resolve(here, ".."), "data");
}

async function installDownloadedUpdate(path) {
  const target = resolve(String(path ?? ""));
  const updatesRoot = resolve(desktopDataDir(), "updates");
  const childPath = relative(updatesRoot, target);
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath))
    throw new Error("只能安装由 Olivia Soul 下载到本地数据目录的更新包");
  if (extname(target).toLowerCase() !== ".exe") throw new Error("更新包必须是 .exe 安装程序");
  await access(target);
  const errorMessage = await shell.openPath(target);
  if (errorMessage) throw new Error(errorMessage);
  setTimeout(() => app.quit(), 600);
  return { started: true, path: target };
}

async function readRuntimeSettings() {
  try {
    const settings = JSON.parse(await readFile(runtimeSettingsPath(), "utf8"));
    return {
      port: assertPort(settings.port),
      clientExe: typeof settings.clientExe === "string" ? settings.clientExe : "",
    };
  } catch (error) {
    if (error.code === "ENOENT") return { port: DEFAULT_PORT, clientExe: "" };
    throw error;
  }
}

async function writeRuntimeSettings() {
  const settings = { port: currentPort, clientExe: clientExePath };
  await writeFile(runtimeSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function desktopAsset(name) {
  return app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked", "desktop", name) : join(here, name);
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

function queryAutoStart() {
  return new Promise(resolvePromise => {
    const command = "if (Get-ScheduledTask | Where-Object { $_.TaskName -eq 'OliviaLocalLettersAutoStart' -or $_.TaskName -like 'Olivia *' }) { exit 0 } else { exit 1 }";
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolvePromise(false));
    child.once("close", code => resolvePromise(code === 0));
  });
}

async function refreshAutoStart() {
  autoStart = await queryAutoStart();
  rebuildTrayMenu();
  return autoStart;
}

async function setAutoStart(enabled) {
  const executable = process.execPath;
  const argumentsValue = app.isPackaged ? "--hidden" : `"${resolve(here, "..")}" --hidden`;
  const helperCommand = [
    `& '${desktopAsset("startup-task.ps1").replaceAll("'", "''")}'`,
    `-Mode '${enabled ? "Enable" : "Disable"}'`,
    `-Executable '${executable.replaceAll("'", "''")}'`,
    `-Arguments '${argumentsValue.replaceAll("'", "''")}'`,
  ].join(" ");
  const encoded = Buffer.from(helperCommand, "utf16le").toString("base64");
  const elevate = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
  await runProcess("powershell.exe", ["-NoProfile", "-Command", elevate]);
  return refreshAutoStart();
}

function workspacePath() {
  return app.isPackaged ? join(app.getPath("userData"), "workspace") : developmentRoot;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runElevatedScript(script, args = []) {
  if (args.length % 2 !== 0) throw new Error("提权脚本参数必须成对传入");
  const formattedArgs = args.map((value, index) => {
    if (index % 2 === 1) return powershellLiteral(value);
    if (!/^-[A-Za-z][A-Za-z0-9]*$/u.test(value)) throw new Error(`非法脚本参数：${value}`);
    return value;
  });
  const errorFile = join(app.getPath("temp"), `olivia-elevated-${randomUUID()}.txt`);
  const invoke = [`& ${powershellLiteral(script)}`, ...formattedArgs].join(" ");
  const command = `try { ${invoke} } catch { [IO.File]::WriteAllText(${powershellLiteral(errorFile)}, $_.Exception.Message, (New-Object Text.UTF8Encoding $false)); exit 1 }`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const elevate = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
  try {
    await runProcess("powershell.exe", ["-NoProfile", "-Command", elevate]);
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

async function selectedClientLayout() {
  if (!clientExePath) return null;
  if (extname(clientExePath).toLowerCase() !== ".exe") throw new Error("请选择游戏 exe 文件");
  await access(clientExePath);
  const gameRoot = dirname(clientExePath);
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

async function readFeappStatus(feappPath) {
  const script = join(workspacePath(), "tools", "get-feapp-status.ps1");
  const output = await runProcess("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-FeappPath", feappPath,
  ]);
  return JSON.parse(output);
}

async function readWebplayerStatus(webplayerPath) {
  const script = join(workspacePath(), "tools", "get-webplayer-status.ps1");
  const output = await runProcess("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-WebplayerPath", webplayerPath,
  ]);
  return JSON.parse(output);
}

async function getClientMountStatus() {
  const layout = await selectedClientLayout();
  if (!layout) {
    return {
      clientSelected: false,
      clientExe: "",
      mounted: false,
      port: null,
      servicePort: currentPort,
    };
  }
  const [feapp, webplayer] = await Promise.all([
    readFeappStatus(layout.feappPath),
    readWebplayerStatus(layout.webplayerPath),
  ]);
  return {
    clientSelected: true,
    clientExe: clientExePath,
    ...feapp,
    mounted: Boolean(feapp.mounted && webplayer.mounted),
    webplayerFound: webplayer.clientFound,
    webplayerMounted: webplayer.mounted,
    servicePort: currentPort,
  };
}

async function selectClientExe() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择游戏客户端",
    defaultPath: clientExePath || undefined,
    properties: ["openFile"],
    filters: [{ name: "Windows 可执行文件", extensions: ["exe"] }],
  });
  if (result.canceled) return { ...(await getClientMountStatus()), selectionChanged: false };
  const previous = clientExePath;
  clientExePath = result.filePaths[0];
  try {
    await selectedClientLayout();
    await writeRuntimeSettings();
  } catch (error) {
    clientExePath = previous;
    throw error;
  }
  return { ...(await getClientMountStatus()), selectionChanged: true };
}

async function nearestExistingDirectory(value) {
  let candidate = String(value ?? "").trim();
  if (!candidate) return "";
  candidate = resolve(candidate);
  while (candidate) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
      candidate = dirname(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return "";
      const parent = dirname(candidate);
      if (parent === candidate) return "";
      candidate = parent;
    }
  }
  return "";
}

async function selectMidiLibraryFolder(initialPath = "") {
  initialPath = await nearestExistingDirectory(initialPath);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 MIDI / MP4 曲库文件夹",
    defaultPath: initialPath || undefined,
    properties: ["openDirectory"],
  });
  if (result.canceled) return { cancelled: true };
  return { cancelled: false, path: result.filePaths[0] };
}

async function openDirectory(value) {
  const requested = resolve(String(value ?? "").trim());
  const directory = await nearestExistingDirectory(requested);
  if (!directory || directory !== requested) throw new Error("目录不存在或当前无法访问");
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
  return { opened: true, path: directory };
}

async function originalFeapp(layout, createOnMount = false) {
  const key = createHash("md5").update(layout.gameRoot.toLowerCase(), "utf8").digest("hex");
  const backupDir = join(app.getPath("userData"), "client-backups");
  const managedBackup = join(backupDir, `${key}.feapp.dat`);
  try {
    await access(managedBackup);
    if ((await readFeappStatus(managedBackup)).mounted) throw new Error("本机保存的客户端原版备份无效");
    return managedBackup;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!createOnMount) throw new Error("未找到挂载前保存的客户端原版备份");
  const current = await readFeappStatus(layout.feappPath);
  if (current.mounted) throw new Error("当前客户端已挂载，但没有挂载前的原版备份");
  return managedBackup;
}

async function originalWebplayer(layout, createOnMount = false) {
  const key = createHash("md5").update(`${layout.gameRoot.toLowerCase()}\n${layout.version.toLowerCase()}`, "utf8").digest("hex");
  const backupDir = join(app.getPath("userData"), "client-backups");
  const managedBackup = join(backupDir, `${key}.webplayer.dat`);
  try {
    await access(managedBackup);
    if ((await readWebplayerStatus(managedBackup)).mounted) throw new Error("本机保存的桌面播放器原版备份无效");
    return managedBackup;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!createOnMount) throw new Error("未找到当前游戏版本的桌面播放器原版备份");
  const current = await readWebplayerStatus(layout.webplayerPath);
  if (current.mounted) throw new Error("当前桌面播放器已挂载，但没有挂载前的原版备份");
  return managedBackup;
}

async function mountClientService(value) {
  const port = assertPort(value);
  const changed = port !== currentPort;
  const layout = await selectedClientLayout();
  if (!layout) throw new Error("请先选择游戏 exe");
  const current = await readFeappStatus(layout.feappPath);
  const currentWebplayer = await readWebplayerStatus(layout.webplayerPath);
  if (current.updateAvailable) {
    if (port !== currentPort) await assertPortAvailable(port);
    const upgradeScript = join(workspacePath(), "tools", ["v22", "v23"].includes(current.revision)
      ? "upgrade-feapp-v22-v23.ps1"
      : "upgrade-feapp-v16-v17.ps1");
    const upgradeArgs = [
      "-GameRoot", layout.gameRoot,
      "-Version", layout.version,
      "-ServiceUrl", `http://127.0.0.1:${port}`,
    ];
    await runElevatedScript(upgradeScript, upgradeArgs);
    if (currentWebplayer.updateAvailable) {
      await runElevatedScript(join(workspacePath(), "tools", "upgrade-webplayer-v6-v7.ps1"), [
        "-GameRoot", layout.gameRoot,
        "-Version", layout.version,
        "-ServiceUrl", `http://127.0.0.1:${port}`,
      ]);
    } else if (!currentWebplayer.mounted) {
      const originalWebplayerFile = await originalWebplayer(layout, true);
      await runElevatedScript(join(workspacePath(), "tools", "patch-webplayer-local.ps1"), [
        "-GameRoot", layout.gameRoot,
        "-Version", layout.version,
        "-OriginalFile", originalWebplayerFile,
        "-RefreshOriginal", "true",
      ]);
    }
    try {
      await changeServicePort(port);
    } catch (error) {
      if (port !== currentPort) {
        upgradeArgs[upgradeArgs.length - 1] = `http://127.0.0.1:${currentPort}`;
        await runElevatedScript(upgradeScript, upgradeArgs);
      }
      throw error;
    }
    const status = await getClientMountStatus();
    if (changed) setTimeout(() => mainWindow.loadURL(adminUrl()), 250);
    return status;
  }
  const originalFile = await originalFeapp(layout, true);
  const originalWebplayerFile = await originalWebplayer(layout, true);
  if (port !== currentPort) await assertPortAvailable(port);
  const patchScript = join(workspacePath(), "tools", "patch-feapp-local.ps1");
  const patchArgs = [
    "-GameRoot", layout.gameRoot,
    "-Version", layout.version,
    "-OriginalFile", originalFile,
    "-ServiceUrl", `http://127.0.0.1:${port}`,
  ];
  await runElevatedScript(patchScript, patchArgs);
  await runElevatedScript(join(workspacePath(), "tools", "patch-webplayer-local.ps1"), [
    "-GameRoot", layout.gameRoot,
    "-Version", layout.version,
    "-OriginalFile", originalWebplayerFile,
  ]);
  try {
    await changeServicePort(port);
  } catch (error) {
    if (port !== currentPort) {
      try {
        patchArgs[patchArgs.length - 1] = `http://127.0.0.1:${currentPort}`;
        await runElevatedScript(patchScript, patchArgs);
      } catch (rollbackError) {
        throw new Error(`${error.message}；客户端端口回滚失败：${rollbackError.message}`);
      }
    }
    throw error;
  }
  const status = await getClientMountStatus();
  if (changed) setTimeout(() => mainWindow.loadURL(adminUrl()), 250);
  return status;
}

async function restoreClient() {
  const layout = await selectedClientLayout();
  if (!layout) throw new Error("请先选择游戏 exe");
  const originalFile = await originalFeapp(layout);
  const originalWebplayerFile = await originalWebplayer(layout);
  const restoreScript = join(workspacePath(), "tools", "restore-feapp-original.ps1");
  await runElevatedScript(restoreScript, [
    "-GameRoot", layout.gameRoot,
    "-Version", layout.version,
    "-OriginalFile", originalFile,
  ]);
  await runElevatedScript(join(workspacePath(), "tools", "restore-webplayer-original.ps1"), [
    "-GameRoot", layout.gameRoot,
    "-Version", layout.version,
    "-OriginalFile", originalWebplayerFile,
  ]);
  return getClientMountStatus();
}

async function executableWindowIcon() {
  const command = `Add-Type -AssemblyName System.Drawing; $icon = [Drawing.Icon]::ExtractAssociatedIcon(${powershellLiteral(process.execPath)}); $bitmap = $icon.ToBitmap(); $stream = New-Object IO.MemoryStream; try { $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose(); $bitmap.Dispose(); $icon.Dispose() }`;
  const base64 = await runProcess("powershell.exe", ["-NoProfile", "-Command", command]);
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${base64}`);
  if (icon.isEmpty()) throw new Error("无法读取窗口图标");
  return icon;
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开管理窗口", click: showWindow },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: autoStart,
      click: item => setAutoStart(item.checked).catch(error => {
        dialog.showErrorBox("开机自启设置失败", error.message);
        refreshAutoStart();
      }),
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
}

function createTray(windowIcon) {
  tray = new Tray(windowIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Olivia 本机信件");
  tray.on("click", showWindow);
  rebuildTrayMenu();
}

function createWindow(windowIcon) {
  const workAreaSize = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1120, Math.max(820, workAreaSize.width - 160)),
    height: Math.min(720, Math.max(620, workAreaSize.height - 160)),
    minWidth: 820,
    minHeight: 620,
    show: false,
    icon: windowIcon,
    backgroundColor: "#111114",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadURL(loadingDocumentUrl());
  mainWindow.webContents.on("context-menu", (event, params) => {
    event.preventDefault();
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" },
      { role: "paste", label: "粘贴" },
      { type: "separator" },
      { role: "selectAll", label: "全选" },
    ]).popup({ window: mainWindow });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", event => event.preventDefault());
  mainWindow.on("minimize", event => {
    event.preventDefault();
    mainWindow.hide();
    if (!trayNoticeShown) {
      tray.displayBalloon({
        title: "Olivia 本机信件",
        content: "应用仍在托盘运行，信件服务不会中断。",
      });
      trayNoticeShown = true;
    }
  });
  mainWindow.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.once("ready-to-show", () => {
    if (!hiddenAtLaunch) showWindow();
  });
}

async function packagedWorkspace() {
  const root = join(app.getPath("userData"), "workspace");
  const template = join(process.resourcesPath, "workspace-template");
  await prepareWorkspaceIncrementally({
    template,
    root,
    settings: join(app.getPath("userData"), "settings"),
  });
  return root;
}

async function createOwnedBackend(port) {
  const root = app.isPackaged ? await packagedWorkspace() : developmentRoot;
  const dataDir = desktopDataDir();
  const nextService = await createOliviaService({ root, dataDir });
  try {
    await nextService.listen(port, "127.0.0.1");
  } catch (error) {
    await nextService.close();
    throw error;
  }
  service = nextService;
}

async function startBackend(port) {
  const running = await fetch(`${adminUrl(port)}/api/status`).catch(() => null);
  if (running?.ok) return;
  try {
    await createOwnedBackend(port);
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error(`端口 ${port} 已被其他程序占用`);
    throw error;
  }
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

async function changeServicePort(value) {
  const port = assertPort(value);
  if (port === currentPort) return currentPort;
  if (!service) throw new Error("当前本机服务不是由此应用启动，无法安全切换端口");
  await assertPortAvailable(port);
  const oldPort = currentPort;
  await service.close();
  service = null;
  try {
    await createOwnedBackend(port);
  } catch (error) {
    await createOwnedBackend(oldPort);
    throw error;
  }
  currentPort = port;
  try {
    await writeRuntimeSettings();
  } catch (error) {
    await service.close();
    service = null;
    currentPort = oldPort;
    await createOwnedBackend(oldPort);
    throw error;
  }
  return currentPort;
}

async function exportSoul() {
  const url = `${adminUrl()}/api/memory/export/soul`;
  const check = await fetch(url, { method: "HEAD" });
  if (check.status === 409) throw new Error("暂无记忆");
  if (!check.ok) throw new Error(`导出检查失败：HTTP ${check.status}`);
  const selected = await dialog.showSaveDialog(mainWindow, {
    title: "导出 Olivia Soul 记忆",
    defaultPath: `OliviaSoul-memory-${new Date().toISOString().slice(0, 10)}.soul`,
    filters: [{ name: "Olivia Soul 记忆", extensions: ["soul"] }],
  });
  if (selected.canceled) return { cancelled: true };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(selected.filePath));
    return { cancelled: false, path: selected.filePath };
  } catch (error) {
    await rm(selected.filePath, { force: true });
    throw error;
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.setAppUserModelId("study.olivia.localletters");
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.includes("--quit")) app.quit();
    else showWindow();
  });
  app.on("before-quit", event => {
    if (backendClosed) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (!service) {
      backendClosed = true;
      app.quit();
      return;
    }
    service.close().finally(() => {
      service = null;
      backendClosed = true;
      app.quit();
    });
  });
  app.on("window-all-closed", () => {});
  ipcMain.handle("desktop:get-settings", async () => ({
    autoStart: await refreshAutoStart(),
    port: currentPort,
    clientExe: clientExePath,
  }));
  ipcMain.handle("desktop:set-auto-start", async (_event, enabled) => ({ autoStart: await setAutoStart(enabled === true) }));
  ipcMain.handle("client:select", () => selectClientExe());
  ipcMain.handle("midi:select-library", (_event, initialPath) => selectMidiLibraryFolder(initialPath));
  ipcMain.handle("desktop:open-directory", (_event, path) => openDirectory(path));
  ipcMain.handle("client:get-status", () => getClientMountStatus());
  ipcMain.handle("client:mount", (_event, port) => mountClientService(port));
  ipcMain.handle("client:restore", () => restoreClient());
  ipcMain.handle("desktop:export-soul", () => exportSoul());
  ipcMain.handle("desktop:install-update", (_event, path) => installDownloadedUpdate(path));
  ipcMain.handle("desktop:hide", () => mainWindow.hide());
  app.whenReady().then(async () => {
    try {
      app.setLoginItemSettings({ openAtLogin: false });
      const settings = await readRuntimeSettings();
      currentPort = settings.port;
      clientExePath = settings.clientExe;
      const windowIcon = await executableWindowIcon();
      createTray(windowIcon);
      createWindow(windowIcon);
      await startBackend(currentPort);
      await refreshAutoStart();
      await mainWindow.loadURL(adminUrl());
    } catch (error) {
      backendClosed = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(loadingDocumentUrl(`本地服务启动失败：${error.message}`));
        if (!hiddenAtLaunch) showWindow();
      } else {
        dialog.showErrorBox("Olivia 本机信件启动失败", error.message);
        app.quit();
      }
    }
  });
}
