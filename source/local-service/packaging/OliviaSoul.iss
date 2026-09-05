#define AppVersion GetEnv("OLIVIA_SOUL_VERSION")
#define StageDir GetEnv("OLIVIA_SOUL_STAGE")
#define OutputDir GetEnv("OLIVIA_SOUL_OUTPUT")

[Setup]
AppId={{70CB4313-7339-4EF0-87ED-E9D45A67B952}
AppName=Olivia Soul
AppVersion={#AppVersion}
AppPublisher=Olivia Soul
DefaultDirName={localappdata}\Programs\OliviaSoul
DefaultGroupName=Olivia Soul
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=OliviaSoul-{#AppVersion}-Setup
SetupIconFile={#StageDir}\app-v9.ico
UninstallDisplayIcon={app}\app-v9.ico
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
ShowLanguageDialog=yes
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=yes
DisableDirPage=no
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no
AppMutex=Local\OliviaSoul.SingleInstance

[Languages]
Name: "english"; MessagesFile: "{#StageDir}\installer\English.isl"
Name: "chinesesimplified"; MessagesFile: "{#StageDir}\installer\ChineseSimplified.isl"

[Messages]
chinesesimplified.WelcomeLabel2=此向导将安装 [name/ver]。%n%n安装前请退出游戏和 OliviaSoul。升级时建议先备份 UserData，并选择原安装目录；无需先卸载旧版。%n%n请勿将本软件安装到游戏目录或盘符根目录。
english.WelcomeLabel2=This wizard will install [name/ver].%n%nClose the game and OliviaSoul first. When upgrading, back up UserData and use the existing installation folder; uninstalling the old version is not required.%n%nDo not install into the game folder or a drive root.
chinesesimplified.SelectDirDesc=选择 OliviaSoul 的安装位置。
english.SelectDirDesc=Choose where to install OliviaSoul.
chinesesimplified.SelectDirLabel3=请选择独立、可写的安装目录。升级时请沿用原安装目录。
english.SelectDirLabel3=Choose a separate, writable folder. For upgrades, use the existing installation folder.
chinesesimplified.FinishedLabel=OliviaSoul 已安装完成。%n%n首次使用请先启动 OliviaSoul，在“客户端与桌面”选择游戏并启用服务，再启动游戏。
english.FinishedLabel=OliviaSoul has been installed.%n%nBefore first use, start OliviaSoul, select the game and enable the service under Client & Desktop, then start the game.

[CustomMessages]
chinesesimplified.RestoreGameRunning=请先完全退出游戏后重试。
english.RestoreGameRunning=Fully exit the game, then try again.
chinesesimplified.RestoreSteamRunning=请先完全退出 Steam 后重试。
english.RestoreSteamRunning=Fully exit Steam, then try again.
chinesesimplified.RestoreBackupInvalid=客户端原始备份缺失或无法验证。请保留 UserData 和备份并联系支持。
english.RestoreBackupInvalid=The original client backup is missing or could not be verified. Keep UserData and backups, and contact support.
chinesesimplified.RestorePathInvalid=已登记的客户端路径不可访问。请恢复原安装路径后重试。
english.RestorePathInvalid=The registered client path is inaccessible. Restore the original installation path, then try again.
chinesesimplified.RestoreTargetChanged=客户端文件或 Steam 启动项后来发生了变化。为避免覆盖您的修改，卸载已停止。
english.RestoreTargetChanged=Client files or Steam launch options have changed. Uninstall was stopped to avoid overwriting your changes.
chinesesimplified.RestoreIncomplete=安全恢复未完成。请保留 Olivia Soul、UserData 和备份并联系支持。
english.RestoreIncomplete=Safe restoration did not complete. Keep Olivia Soul, UserData and backups, and contact support.
chinesesimplified.RestoreRequired=卸载前必须恢复所有已登记且仍启用的客户端补丁（FE/WebPlayer/支持的 DLL）以及严格匹配的 Steam 启动项。任一项失败都会中止卸载；Olivia Soul、UserData、恢复工具和备份均会保留，源视频和 usersettings.dat 不会被删除或修改。
english.RestoreRequired=All registered active client patches (FE/WebPlayer/supported DLLs) and exactly matching Steam launch options must be restored before uninstalling. Any failure stops uninstall. Olivia Soul, UserData, recovery tools and backups are retained; source videos and usersettings.dat are not deleted or modified.
chinesesimplified.RestoreNoResult=卸载前必须恢复所有已登记且仍启用的客户端补丁（FE/WebPlayer/支持的 DLL）以及严格匹配的 Steam 启动项。安全恢复失败，卸载已中止；Olivia Soul、UserData、恢复工具和备份均会保留，源视频和 usersettings.dat 不会被删除或修改。请查看卸载日志后重试。
english.RestoreNoResult=Client patches and exactly matching Steam launch options must be restored before uninstalling. Safe restoration failed and uninstall was stopped. Olivia Soul, UserData, recovery tools and backups are retained; source videos and usersettings.dat are not deleted or modified. Check the uninstall log and try again.
chinesesimplified.StartupCleanupFailed=客户端资源已恢复，但 Olivia Soul 开机启动任务清理失败。卸载已中止；Olivia Soul、UserData、恢复工具和备份尚未删除，源视频和 usersettings.dat 不会被删除或修改。请重试。
english.StartupCleanupFailed=Client resources were restored, but removing the Olivia Soul startup task failed. Uninstall was stopped. Olivia Soul, UserData, recovery tools and backups are retained; source videos and usersettings.dat are not deleted or modified. Please try again.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
Type: filesandordirs; Name: "{app}\resources\workspace-template\.cursor\rules"
Type: files; Name: "{app}\resources\workspace-template\harness\00-strict-precheck.md"
Type: files; Name: "{app}\resources\workspace-template\harness\00-脚本算术.md"
Type: files; Name: "{app}\resources\workspace-template\harness\02-读信感.md"
Type: files; Name: "{app}\resources\workspace-template\harness\06-实时回信.md"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Olivia Soul"; Filename: "{app}\OliviaSoul.exe"; IconFilename: "{app}\app-v9.ico"; AppUserModelID: "OliviaSoul.Desktop.9"
Name: "{autodesktop}\Olivia Soul"; Filename: "{app}\OliviaSoul.exe"; IconFilename: "{app}\app-v9.ico"; AppUserModelID: "OliviaSoul.Desktop.9"; Tasks: desktopicon

[Run]
Filename: "{app}\OliviaSoul.exe"; Description: "{cm:LaunchProgram,Olivia Soul}"; Flags: nowait postinstall skipifsilent

[Code]
function IsDriveRoot(Path: String): Boolean;
var
  Drive: String;
  Normalized: String;
begin
  Drive := ExtractFileDrive(Path);
  Normalized := RemoveBackslashUnlessRoot(Path);
  Result := (Drive <> '') and (CompareText(Normalized, AddBackslash(Drive)) = 0);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Selected: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then
    exit;
  Selected := WizardDirValue;
  if Length(Selected) = 1 then
    Selected := Selected + ':\'
  else if (Length(Selected) = 2) and (Selected[2] = ':') then
    Selected := Selected + '\';
  if IsDriveRoot(Selected) then
    WizardForm.DirEdit.Text := AddBackslash(Selected) + 'OliviaSoul';
end;

function RestoreFailureHint(Code: AnsiString): String;
begin
  if Code = 'GAME_RUNNING' then
    Result := CustomMessage('RestoreGameRunning')
  else if Code = 'STEAM_RUNNING' then
    Result := CustomMessage('RestoreSteamRunning')
  else if Code = 'BACKUP_INVALID' then
    Result := CustomMessage('RestoreBackupInvalid')
  else if Code = 'PATH_INVALID' then
    Result := CustomMessage('RestorePathInvalid')
  else if Code = 'TARGET_CHANGED' then
    Result := CustomMessage('RestoreTargetChanged')
  else
    Result := CustomMessage('RestoreIncomplete');
end;

function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
  RestoreSucceeded: Boolean;
  DisableSucceeded: Boolean;
  RestoreResultPath: String;
  RestoreDetail: AnsiString;
begin
  Result := False;
  RestoreResultPath := ExpandConstant('{tmp}\OliviaSoul-uninstall-restore.json');
  DeleteFile(RestoreResultPath);
  { Client files may have been patched by an earlier elevated mount. Request }
  { elevation only for the synchronous, fail-closed restore helper. }
  RestoreSucceeded := ShellExec('runas', ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\app\desktop\uninstall-restore.js') + '" --user-data "' + ExpandConstant('{app}\UserData') + '" --result-file "' + RestoreResultPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if (not RestoreSucceeded) then
  begin
    if LoadStringFromFile(RestoreResultPath, RestoreDetail) then
      MsgBox(CustomMessage('RestoreRequired') + #13#10 + #13#10 + RestoreFailureHint(RestoreDetail), mbError, MB_OK)
    else
      MsgBox(CustomMessage('RestoreNoResult'), mbError, MB_OK);
    exit;
  end;
  DeleteFile(RestoreResultPath);
  DisableSucceeded := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\desktop\startup-task.ps1') + '" -Mode Disable', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if (not DisableSucceeded) then
  begin
    MsgBox(CustomMessage('StartupCleanupFailed'), mbError, MB_OK);
    exit;
  end;
  Result := True;
end;
