import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin UI imports completed performance videos without exposing keyboard-only MIDI generation", async () => {
  const [html, app, styles, bridge, preload, desktopMain, releaseGuide] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../native-host/DesktopBridge.cs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.js", import.meta.url), "utf8"),
    readFile(new URL("../packaging/使用说明.txt", import.meta.url), "utf8"),
  ]);

  assert.match(html, /data-tab="performances">官方作品</u);
  assert.doesNotMatch(html, /id="selectMidiFile"|id="midiFile"|accept="\.mid,\.midi/u);
  assert.match(html, /id="midiLibraryRoot"/u);
  assert.match(html, /id="openMidiLibraryFolder"/u);
  assert.match(html, /id="midiSongList"/u);
  assert.match(html, /id="midiSongSearch"/u);
  assert.doesNotMatch(html, /id="selectLocalAiExecutable"|id="selectLocalAiWorkingDirectory"/u);
  assert.doesNotMatch(html, /钢琴音频和演奏视频|id="midiJobList"/u);
  assert.match(html, /至少包含一个可播放的 MP4/u);
  assert.match(html, /id="checkUpdate"/u);
  assert.match(html, /id="downloadUpdate"/u);
  assert.match(html, /id="storageReferencedRoots"/u);
  assert.match(html, /<details[^>]*id="storageReferencedDetails"/u);
  assert.doesNotMatch(html, /<details[^>]*id="storageReferencedDetails"[^>]*\sopen(?:\s|>)/u);
  assert.match(html, /id="storageReferenceSummary"/u);
  assert.match(html, /id="storageMigrationProgress"/u);
  assert.match(html, /id="cancelStorageMigrationPreview"/u);
  assert.match(html, /id="previewStorageMigration"/u);
  assert.match(html, /id="confirmStorageMigration"/u);
  assert.match(html, /<select id="modelName"/u);
  assert.match(html, /<select id="localModelName"/u);
  assert.match(html, /id="queryRemoteModels"/u);
  assert.match(html, /id="queryLocalModels"/u);
  assert.doesNotMatch(html, /data-model-combobox|modelComboboxToggle|localAiExecutable|startLocalAi|本地 AI 进程/u);
  assert.match(html, /data-tab="update"/u);
  assert.match(html, /data-page="update"/u);
  assert.match(html, /class="settingsSubcard/u);
  assert.doesNotMatch(app, /\/toy\/genObjectUploadUrl|\/toy\/midi\/generate/u);
  assert.match(app, /\/admin\/api\/midi-library\/preview/u);
  assert.match(app, /\/admin\/api\/midi-library\/confirm/u);
  // Download requests are behavior-tested in update-download-ui.test.js after modularization.
  assert.match(app, /\/admin\/api\/storage\/migration\/preview/u);
  assert.match(app, /storageMigrationPreviewJobId/u);
  assert.match(app, /pollStorageMigrationPreview/u);
  assert.match(app, /cancelStorageMigrationPreview/u);
  assert.match(app, /\/admin\/api\/storage\/migration\/confirm/u);
  assert.match(app, /confirmed:\s*true/u);
  assert.match(app, /oliviaDesktop\.installUpdate/u);
  assert.doesNotMatch(app, /createModelCombobox|closeModelComboboxes|model-combobox\.js/u);
  assert.match(app, /replaceModelOptions/u);
  assert.match(app, /selectLibraryFolder/u);
  assert.match(app, /selectLibraryFolder\(\$\("#midiLibraryRoot"\)\.value\.trim\(\)\)/u);
  assert.match(app, /oliviaDesktop\.openDirectory/u);
  assert.doesNotMatch(app, /selectExecutableFile|selectWorkingDirectory|localAiProcess/u);
  assert.match(styles, /\.libraryPathRow/u);
  assert.match(styles, /\.performanceColumns/u);
  assert.match(styles, /\.storageSection/u);
  assert.match(styles, /\.storageReferenceDetails/u);
  assert.match(styles, /\.transcriptionCard[\s\S]*\.transcriptGrid/u);
  assert.match(bridge, /selectLibraryFolder/u);
  assert.doesNotMatch(bridge, /selectExecutableFile|selectWorkingDirectory/u);
  assert.match(bridge, /installUpdate/u);
  assert.match(bridge, /FolderBrowserDialog/u);
  assert.match(bridge, /SelectedPath\s*=\s*initialPath/u);
  assert.match(bridge, /openDirectory/u);
  assert.match(preload, /midi:select-library/u);
  assert.match(preload, /selectLibraryFolder:\s*initialPath\s*=>\s*ipcRenderer\.invoke\("midi:select-library",\s*initialPath\)/u);
  assert.match(preload, /openDirectory/u);
  assert.doesNotMatch(preload, /local-ai:select-executable|local-ai:select-working-directory/u);
  assert.match(preload, /desktop:install-update/u);
  assert.match(desktopMain, /installDownloadedUpdate/u);
  assert.match(desktopMain, /properties: \["openDirectory"\]/u);
  assert.match(desktopMain, /defaultPath:\s*initialPath/u);
  assert.match(desktopMain, /shell\.openPath/u);
  assert.doesNotMatch(desktopMain, /local-ai:select-executable|local-ai:select-working-directory/u);
  assert.match(desktopMain, /current\.updateAvailable/u);
  assert.match(desktopMain, /upgrade-feapp-v16-v17\.ps1/u);
  assert.match(releaseGuide, /本地兼容 API/u);
  assert.doesNotMatch(releaseGuide, /Gemma|gemma-4-26b|tailf0d018|100\.124\.216\.70/iu);
});

test("管理侧栏固定、AI 模块使用横线分隔且只在文本控件保留右键编辑菜单", async () => {
  const [styles, app] = await Promise.all([
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(styles, /\.sidebar\s*\{[^}]*position:\s*sticky[^}]*height:\s*100%/su);
  assert.match(styles, /\.content\s*\{[^}]*overflow-y:\s*auto/su);
  assert.match(styles, /\.settingsSubcard\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/su);
  assert.match(styles, /\.settingsSubcard\s*\+\s*\.settingsSubcard\s*\{[^}]*border-top:/su);
  assert.match(app, /function\s+isEditableTextTarget/u);
  assert.match(app, /addEventListener\("contextmenu"[\s\S]*!isEditableTextTarget\(event\.target\)[\s\S]*event\.preventDefault\(\)/u);
  assert.match(app, /async\s+function\s+runModelOperation/u);
  assert.match(app, /finally\s*\{[\s\S]*button\.disabled\s*=\s*false/u);
  assert.match(app, /测试失败/u);
});
