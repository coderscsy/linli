# OliviaSoul 本机服务与桌面宿主

当前用户说明以[完整使用说明](packaging/使用说明.txt)和[仓库 README](../../README.md)为准；本次为 R10.3 累计更新，更新标识 `2008.2.7-linli.5`，程序版本 `2008.2.7`。[合并更新说明](packaging/发布说明.md)。

## 当前架构

WinForms + WebView2 管理窗口启动随包 Node.js 后端，默认监听 127.0.0.1:27149。普通关闭隐藏到托盘；托盘退出立即收起管理窗口，再收尾后台。模型仅手动启用，不管理外部 AI 进程。

支持信件/记忆、官方已完成 MP4 的导入与游戏播放、前后台共用的作品名称/时段编辑、永久曲名纠错、Whisper 音视频转写。MIDI 上传和视频生成已禁用；midi 目录保留兼容媒体库模块名称，不代表继续提供 MIDI 渲染。

## 数据与媒体

桌面安装的数据根目录是 <安装目录>/UserData；SQLite 位于 database/olivia-local.sqlite，可读档案位于信件往来/。settings/song-name-corrections.json 保存永久曲名纠错投影。停止应用后备份整个 UserData，并另行备份仍在外部引用的媒体。

官方视频导入默认 mode=reference，保留源路径，只有用户确认迁移才复制到目标位置。游戏 usersettings.dat 只读解析。不要把旧版 AppData 示例路径或开发机媒体目录当作新用户默认值。

每日额度新安装默认 3，允许整数 0–999；0 表示不能写信。模型保存/测试不等于启用。.soul 导入会覆盖当前记忆、摘要和视频，请先导出备份；它不替代整份 UserData/外部作品备份。

## 开发与测试

```powershell
Set-Location .\source\local-service
npm.cmd install
npm.cmd test
npm.cmd run build:win
```

使用 Node.js >=22.5（安装包固定携带经校验版本）、.NET Framework net462 目标与 Inno Setup。npm.cmd 可避开 PowerShell 对 npm.ps1 的执行策略限制。不要修改系统全局执行策略来运行开发命令。

构建必须使用新的空输出目录；安装包从白名单生成，不从现有安装的 UserData 打包。检查动态导入/模板工具是否齐全，保留第三方许可证，并审查最终产物是否含密钥、日志、数据库或用户媒体。公开发行与本地构建是不同动作。

## 用户反馈

[Bug 与功能建议入口](https://github.com/coderscsy/linli/issues)；[反馈模板与隐私提示](packaging/反馈指南.md)。

客户端版本适配、实际播放、Steam 启动以及不同磁盘路径仍需用户环境验收。完整源测试的通过情况和最终包校验记录应单独报告，不用 HTTP 200 或单纯编译成功替代游戏端验收。
