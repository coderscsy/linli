# R10 发布文件

发布标识：`2008.2.7-linli.2`，日期：2026-09-05，程序版本：`2008.2.7`。

安装包不存放在 Git 源码目录，请从 [R10 Release](https://github.com/coderscsy/linli/releases/tag/2008.2.7-linli.2) 下载。

- `OliviaSoul-2008.2.7-Setup.exe`：Windows x64 安装版。
- `OliviaSoul-2008.2.7-Portable.zip`：Windows x64 便携版，需完整解压。
- `USAGE.txt`：中文使用说明。
- `RELEASE_NOTES.md`：中文更新说明。
- `FEEDBACK.md`：Bug 和功能建议模板。
- `SHA256SUMS.txt`：本次下载附件的 SHA-256。

本目录的 [SHA256SUMS.txt](SHA256SUMS.txt) 记录两个程序包的哈希；Release 附件中的同名文件还包含三个说明文档的哈希。公开包仅更新了 R10 验收包的说明文档，139 个非文档文件与验收版逐一哈希一致。重新打包后 Setup 和 ZIP 的整体哈希会改变，请勿使用之前本地审核包的校验值。

源码自动生成的 ZIP 不包含可直接运行的安装程序。使用和升级前请阅读[完整使用说明](../source/local-service/packaging/使用说明.txt)，尤其是关闭游戏、备份 UserData、重新挂载客户端补丁及卸载恢复的步骤。

本次源码自动测试共 500 项：485 通过，15 项按条件跳过，0 失败。测试与本机验收不能保证所有电脑及后续游戏版本兼容，遇到问题欢迎提交脱敏反馈。
