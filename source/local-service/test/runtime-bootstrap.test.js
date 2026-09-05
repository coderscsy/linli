import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows 安装包不再包含 MIDI 演奏视频生成运行时", async () => {
  const [buildScript, installer] = await Promise.all([
    readFile(new URL("../packaging/build-release.ps1", import.meta.url), "utf8"),
    readFile(new URL("../packaging/OliviaSoul.iss", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(buildScript, /midi-renderer\\godot|runtime-manifest\.json|install-midi-renderer\.ps1/u);
  assert.doesNotMatch(installer, /安装本地演奏运行时|install-midi-renderer\.ps1|MidiRenderer/u);
  assert.match(buildScript, /Copy-Item[^\n]*\$project "midi"[^\n]*\$stage "app\\midi"/u,
    "官方成品作品导入与旧只读接口仍需要媒体库模块");
  for (const moduleName of ["data-migration.js", "storage-paths.js", "storage-migration.js"]) {
    assert.match(buildScript, new RegExp(`"${moduleName.replace(".", "\\.")}"`, "u"),
      `发布包必须包含 ${moduleName}`);
  }
  assert.doesNotMatch(buildScript, /"local-ai-process\.js"/u);
});

test("Windows 宿主将耐久数据固定在安装目录 UserData 并传入游戏设置文件", async () => {
  const [appPaths, backend, nodeHost, controller, installer] = await Promise.all([
    readFile(new URL("../native-host/AppPaths.cs", import.meta.url), "utf8"),
    readFile(new URL("../native-host/NodeBackend.cs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/node-host.js", import.meta.url), "utf8"),
    readFile(new URL("../desktop/controller.js", import.meta.url), "utf8"),
    readFile(new URL("../packaging/OliviaSoul.iss", import.meta.url), "utf8"),
  ]);

  assert.match(appPaths, /var userData = Path\.Combine\(baseDirectory, "UserData"\)/u);
  assert.match(appPaths, /Workspace\s*=\s*userData/u);
  assert.match(appPaths, /Data\s*=\s*Path\.Combine\(userData, "database"\)/u);
  assert.match(appPaths, /GameUserSettings\s*=\s*Path\.Combine\([\s\S]*"miHoYo"[\s\S]*"usersettings\.dat"/u);
  assert.doesNotMatch(appPaths, /OliviaSoulData/u);
  assert.match(backend, /"--usersettings", Quote\(_paths\.GameUserSettings\)/u);
  assert.match(nodeHost, /argument\("--usersettings"\)/u);
  assert.match(controller, /usersettingsPath:\s*this\.usersettingsPath/u);
  assert.match(controller, /deferStorageRefresh:\s*true/u,
    "大型官方作品迁移必须在服务开始监听后执行，不能触发桌面宿主启动超时");
  assert.doesNotMatch(installer, /UserData[^\n]*(delete|del)/iu);
});

test("WebView2 与 Electron 仅在可编辑文本中提供右键编辑菜单并保留托盘菜单", async () => {
  const [nativeMain, desktopMain] = await Promise.all([
    readFile(new URL("../native-host/MainForm.cs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.js", import.meta.url), "utf8"),
  ]);

  assert.match(nativeMain, /ContextMenuRequested\s*\+=/u);
  assert.match(nativeMain, /ContextMenuTarget\.IsEditable/u);
  assert.match(nativeMain, /args\.Handled\s*=\s*!args\.ContextMenuTarget\.IsEditable/u);
  assert.match(desktopMain, /webContents\.on\("context-menu",\s*\(event,\s*params\)/u);
  assert.match(desktopMain, /params\.isEditable/u);
  assert.match(desktopMain, /role:\s*"(cut|copy|paste|selectAll)"/u);
  assert.match(desktopMain, /new Menu\(\)|Menu\.buildFromTemplate/u, "托盘菜单必须继续可用");
});

test("原生宿主显示窗口后才初始化 WebView，避免隐藏预热触发图形内核异常", async () => {
  const [nativeMain, startupContext, splash] = await Promise.all([
    readFile(new URL("../native-host/MainForm.cs", import.meta.url), "utf8"),
    readFile(new URL("../native-host/StartupContext.cs", import.meta.url), "utf8"),
    readFile(new URL("../native-host/SplashForm.cs", import.meta.url), "utf8"),
  ]);

  assert.match(nativeMain, /var\s+uiTask\s*=\s*EnsureUiShellAsync\(\);[\s\S]*var\s+backendTask\s*=\s*InitializeBackendAsync\(\);/u);
  assert.match(nativeMain, /NavigateToString\(BuildLoadingDocument\(\)\)/u);
  assert.match(nativeMain, /Load \+= async delegate[\s\S]{0,120}_startupInitialization = InitializeAsync\(\)/u);
  assert.doesNotMatch(nativeMain, /public\s+void\s+StartInitialization\(\)/u);
  assert.doesNotMatch(nativeMain, /public\s+bool\s+IsUiShellReady/u);
  assert.match(nativeMain, /await\s+uiTask;[\s\S]*await\s+backendTask;/u);
  assert.match(nativeMain, /RenderStartupError/u);
  assert.match(nativeMain, /startup-stage=/u);
  assert.doesNotMatch(nativeMain, /private async Task InitializeAsync\(\)[\s\S]{0,400}await\s+_backend\.StartAsync\(\)/u);
  assert.doesNotMatch(startupContext, /_mainForm\.StartInitialization\(\)/u);
  assert.match(splash, /BeginAnimation\(Action fadeOutStarted\)/u);
  assert.doesNotMatch(splash, /Func<bool>\s+isMainWindowReady/u);
});

test("原生托盘左键立即打开窗口且右键只交给菜单", async () => {
  const nativeMain = await readFile(new URL("../native-host/MainForm.cs", import.meta.url), "utf8");

  assert.doesNotMatch(nativeMain, /_tray\.Click\s*\+=/u);
  assert.match(nativeMain, /_tray\.MouseClick\s*\+=/u);
  assert.match(nativeMain, /args\.Button\s*!=\s*MouseButtons\.Left/u);
  assert.match(nativeMain, /public\s+void\s+ShowFromTray\(\)[\s\S]{0,400}Show\(\)/u);
  assert.doesNotMatch(nativeMain, /public\s+async\s+void\s+ShowFromTray\(\)[\s\S]{0,220}await\s+_startupInitialization/u);
  assert.match(nativeMain, /_\s*=\s*FinishShowFromTrayAsync\(\)/u);
});

test("Electron 备用宿主先创建加载窗口再等待后台", async () => {
  const desktopMain = await readFile(new URL("../desktop/main.js", import.meta.url), "utf8");

  assert.match(desktopMain, /function loadingDocumentUrl/u);
  assert.match(desktopMain, /mainWindow\.loadURL\(loadingDocumentUrl\(\)\)/u);
  assert.match(desktopMain, /createWindow\(windowIcon\);[\s\S]*await startBackend\(currentPort\);[\s\S]*mainWindow\.loadURL\(adminUrl\(\)\)/u);
});
