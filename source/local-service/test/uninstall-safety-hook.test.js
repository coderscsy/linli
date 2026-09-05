import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));

test("Inno uninstall blocks deletion on synchronous restore failure and only then disables app autostart", async () => {
  const source = await readFile(`${project}/packaging/OliviaSoul.iss`, "utf8");
  assert.match(source, /function\s+InitializeUninstall\s*\(\s*\)\s*:\s*Boolean/u);
  assert.match(source, /ShellExec\('runas',[^\n]+uninstall-restore\.js[^\n]+ewWaitUntilTerminated[^\n]+ResultCode/u);
  assert.doesNotMatch(source, /RestoreSucceeded\s*:=\s*Exec\(/u);
  assert.match(source, /uninstall-restore\.js[^\n]+--user-data[^\n]+--result-file[^\n]+ewWaitUntilTerminated/u);
  assert.match(source, /Result\s*:=\s*False[\s\S]+if\s+\(not\s+RestoreSucceeded\)\s+then[\s\S]+exit/u);
  assert.match(source, /--result-file[\s\S]+LoadStringFromFile\(RestoreResultPath,\s*RestoreDetail\)/u);
  assert.match(source, /function\s+RestoreFailureHint[\s\S]+GAME_RUNNING[\s\S]+STEAM_RUNNING[\s\S]+BACKUP_INVALID[\s\S]+PATH_INVALID[\s\S]+TARGET_CHANGED/u);
  assert.match(source, /RestoreFailureHint\(RestoreDetail\)/u);
  assert.doesNotMatch(source, /#13#10\s*\+\s*#13#10\s*\+\s*RestoreDetail/u);
  assert.match(source, /RestoreSucceeded[\s\S]+startup-task\.ps1[\s\S]+-Mode Disable/u);
  assert.ok(source.indexOf("uninstall-restore.js") < source.indexOf("startup-task.ps1"));
  assert.match(source, /所有已登记且仍启用的客户端补丁（FE\/WebPlayer\/支持的 DLL）/u);
  assert.match(source, /严格匹配的 Steam 启动项/u);
  assert.match(source, /源视频和 usersettings\.dat 不会被删除或修改/u);
  assert.match(source, /开机启动任务清理失败[\s\S]+UserData/u);
});

test("legacy restore helper never restores usersettings.dat", async () => {
  const source = await readFile(fileURLToPath(new URL("../../tools/restore-feapp-original.ps1", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /usersettings(?:Path|Backup|\.dat)/iu);
});

test("direct FE restore preflights every requested optional source and target before its first copy", async () => {
  const source = await readFile(fileURLToPath(new URL("../../tools/restore-feapp-original.ps1", import.meta.url)), "utf8");
  const firstCopy = source.indexOf("Copy-Item");
  assert.ok(firstCopy > 0);
  for (const requiredCheck of [
    "Test-Path -LiteralPath $OriginalFile",
    "Test-Path -LiteralPath $studioBackup -PathType Leaf",
    "Test-Path -LiteralPath $studioUiPath -PathType Leaf",
    "Test-Path -LiteralPath $containerPluginBackup -PathType Leaf",
    "Test-Path -LiteralPath $containerPluginPath -PathType Leaf",
  ]) assert.ok(source.indexOf(requiredCheck) < firstCopy, `${requiredCheck} must precede the first copy`);
});
