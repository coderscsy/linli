# R10.6 桌面歌词与曲库累计更新

更新标识：`2008.2.7-linli.8`；程序版本：`2008.2.7`；FE v44 / WebPlayer v18；日期：2026-09-10。

从 [R10.6 Release](https://github.com/coderscsy/linli/releases/tag/2008.2.7-linli.8) 下载完整安装包、便携包和对应的 `SHA256SUMS.txt`。可执行文件不提交进 Git。

- 新增桌面歌词、独立设置、多版本共用 LRC/独立偏移、歌词播放控制及曲库移除。
- 修复导入后前后台列表刷新、移除播放中作品后续播和进度异常、多目录来源与单作品多视频识别。
- 升级前退出游戏和托盘程序并备份 UserData；升级后更新游戏补丁至 FE v44 / WebPlayer v18。
- [更新说明](../source/local-service/packaging/发布说明.md) · [构建验证记录](linli.8-build.md) · [本版校验值](linli.8-SHA256SUMS.txt)。
- 本目录原有 `SHA256SUMS.txt` 是历史版本记录，不能用于校验 linli.8；下载时以对应 Release 附件为准。

## R10.5 历史更新：曲目路径识别修复

更新标识：`2008.2.7-linli.7`；程序版本：`2008.2.7`；发布日期：2026-09-08。

从 [R10.5 Release](https://github.com/coderscsy/linli/releases/tag/2008.2.7-linli.7) 获取完整安装包、便携包与 SHA-256 校验。本次修复 Issue #2 的游戏曲目路径解析失败，包含此前发布功能。升级后点击“客户端与桌面 → 重新读取路径”，再扫描导入曲库。程序包只作为 Release 附件发布。

## R10.3 历史累计更新

更新标识：`2008.2.7-linli.5`；程序版本：`2008.2.7`；发布日期：2026-09-06。从 [R10.3 Release](https://github.com/coderscsy/linli/releases/tag/2008.2.7-linli.5) 下载安装包、便携包、使用与反馈说明及 SHA-256 校验。

本次合并播放及入口修复、下载暂停/续传/取消与旧任务保护、中英文安装、客户端只读检查、AI 状态保留和管理页提醒圆点。详见[合并更新说明](../source/local-service/packaging/发布说明.md)。程序包不提交进 Git；本目录 SHA256SUMS.txt 为 R10.3 两个程序包的哈希，Release 同名附件另含三个说明文件的哈希。审核阶段完整测试 559 项：544 通过、15 按条件跳过、0 失败。安装包沿用审核通过的文件，包内审核阶段字样为构建时记录。

## R10.1 历史发布文件

发布标识：`2008.2.7-linli.3`，日期：2026-09-05，程序版本：`2008.2.7`。

安装包不存放在 Git 源码目录，请从 [R10.1 Release](https://github.com/coderscsy/linli/releases/tag/2008.2.7-linli.3) 下载。

- `OliviaSoul-2008.2.7-Setup.exe`：Windows x64 安装版。
- `OliviaSoul-2008.2.7-Portable.zip`：Windows x64 便携版，需完整解压。
- `USAGE.txt`：中文使用说明。
- `RELEASE_NOTES.md`：中文更新说明。
- `FEEDBACK.md`：Bug 和功能建议模板。
- `SHA256SUMS.txt`：本次下载附件的 SHA-256。

历史 R10.1 的校验值请以其 Release 附件为准，不要用本目录的 R10.3 校验值验证旧包。R10.1 仅替换播单修复相关脚本、升级识别、更新标识及说明文档，其余程序文件保持 R10 内容。

源码自动生成的 ZIP 不包含可直接运行的安装程序。使用和升级前请阅读[完整使用说明](../source/local-service/packaging/使用说明.txt)，尤其是关闭游戏、备份 UserData、重新挂载客户端补丁及卸载恢复的步骤。

历史 R10.1 包含新增播单交接及更新识别回归测试；当时完整自动测试共 508 项：493 通过，15 项按条件跳过，0 失败。测试与本机验收不能保证所有电脑及后续游戏版本兼容，遇到问题欢迎提交脱敏反馈。
