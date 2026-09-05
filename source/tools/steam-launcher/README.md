# Steam 启动衔接修复

仅用于官方 `launcher.exe` 提前退出、Steam 过早结束运行状态的情况。保留原启动器，等待它启动的实际 `Olivia.exe` 退出，不修改游戏 EXE、数据库、歌曲或客户端补丁。不会消除游戏自身的网络等待。

## 编译与安装

使用 Windows 自带 .NET Framework 编译器，无需下载运行时。在源目录执行 `build.ps1 -OutputDirectory <输出目录>`。将生成的 `OliviaSteamWaiter.exe` 和本目录的 `configure.ps1`、`steam-launch-options.mjs` 放入：

```text
<OliviaSoul安装目录>/UserData/tools/steam-launcher/
```

先完全退出 Steam，再运行配置脚本。默认只预览；必须显式选择 `install` 才修改启动项。`SteamUserId` 是当前账号的 Steam userdata 数字目录名，不能填别人的目录。

```powershell
.\configure.ps1 -Mode preview -InstallDirectory '<OliviaSoul安装目录>' -SteamUserId <当前账号目录数字>
.\configure.ps1 -Mode install -InstallDirectory '<OliviaSoul安装目录>' -SteamUserId <当前账号目录数字>
```

脚本可从注册表读取 Steam 安装位置和非零当前账号；无法确认账号时要求显式指定，不猜测。请把 `-InstallDirectory` 显式设为实际 OliviaSoul 安装目录，不是 UserData 目录；需要时可另用 `-NodePath` 指定内置 Node。尖括号内容是占位说明，运行前须替换，不能照抄。已有自定义命令包装、特殊字符或异常配置时拒绝覆盖，请先审核。

成功后，这款游戏的启动项形如：

```text
"<OliviaSoul安装目录>\UserData\tools\steam-launcher\OliviaSteamWaiter.exe" %command%
```

之前保存的普通游戏参数会保留在末尾。游戏版本由原启动器的数字 ProductVersion 动态决定，不写死版本目录。移动或卸载 OliviaSoul 前应先恢复启动项，避免引用不存在的 helper。

## 恢复

每次修改都会在 `<OliviaSoul安装目录>/UserData/Backups/steam-launcher/` 留下原配置副本及 JSON 恢复清单。清单和备份包含本机配置，**不要上传到公开仓库**。

完全退出 Steam，使用安装时返回的清单路径：

```powershell
.\configure.ps1 -Mode restore -InstallDirectory '<OliviaSoul安装目录>' -SteamUserId <当前账号目录数字> -ManifestPath '<安装清单.json>'
```

恢复只还原这款游戏的 `LaunchOptions`，不覆盖其他后续设置。若用户已手动修改此启动项，工具会拒绝丢弃新值。备份和源文件不会被删除。

## 验收边界

隔离测试使用假启动器与假游戏，不启动真实 Steam/游戏。最终请在 Steam 单击“开始”，确认初始化期间保持运行，并在游戏退出后恢复“开始”。启动衔接不代表游戏自身远端等待已解决。
