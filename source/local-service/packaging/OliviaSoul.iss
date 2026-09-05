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
CloseApplications=yes
RestartApplications=no
AppMutex=Local\OliviaSoul.SingleInstance

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
Name: "{autodesktop}\Olivia Soul"; Filename: "{app}\OliviaSoul.exe"; IconFilename: "{app}\app-v9.ico"; AppUserModelID: "OliviaSoul.Desktop.9"

[Run]
Filename: "{app}\OliviaSoul.exe"; Description: "启动 Olivia Soul"; Flags: nowait postinstall skipifsilent

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
    Result := '请先完全退出游戏后重试。'
  else if Code = 'STEAM_RUNNING' then
    Result := '请先完全退出 Steam 后重试。'
  else if Code = 'BACKUP_INVALID' then
    Result := '客户端原始备份缺失或无法验证。请保留 UserData 和备份并联系支持。'
  else if Code = 'PATH_INVALID' then
    Result := '已登记的客户端路径不可访问。请恢复原安装路径后重试。'
  else if Code = 'TARGET_CHANGED' then
    Result := '客户端文件或 Steam 启动项后来发生了变化。为避免覆盖您的修改，卸载已停止。'
  else
    Result := '安全恢复未完成。请保留 Olivia Soul、UserData 和备份并联系支持。';
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
      MsgBox('卸载前必须恢复所有已登记且仍启用的客户端补丁（FE/WebPlayer/支持的 DLL）以及严格匹配的 Steam 启动项。任一项失败都会中止卸载；Olivia Soul、UserData、恢复工具和备份均会保留，源视频和 usersettings.dat 不会被删除或修改。' + #13#10 + #13#10 + RestoreFailureHint(RestoreDetail), mbError, MB_OK)
    else
      MsgBox('卸载前必须恢复所有已登记且仍启用的客户端补丁（FE/WebPlayer/支持的 DLL）以及严格匹配的 Steam 启动项。安全恢复失败，卸载已中止；Olivia Soul、UserData、恢复工具和备份均会保留，源视频和 usersettings.dat 不会被删除或修改。请查看卸载日志后重试。', mbError, MB_OK);
    exit;
  end;
  DeleteFile(RestoreResultPath);
  DisableSucceeded := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\app\desktop\startup-task.ps1') + '" -Mode Disable', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if (not DisableSucceeded) then
  begin
    MsgBox('客户端资源已恢复，但 Olivia Soul 开机启动任务清理失败。卸载已中止；Olivia Soul、UserData、恢复工具和备份尚未删除，源视频和 usersettings.dat 不会被删除或修改。请重试。', mbError, MB_OK);
    exit;
  end;
  Result := True;
end;
