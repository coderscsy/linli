# 工程源码

本目录为 R10.4 稳定性更新源码（更新标识：2008.2.7-linli.6，程序版本：2008.2.7）。用户请先阅读[仓库 README](../README.md)及[完整使用说明](local-service/packaging/使用说明.txt)。

```text
source/
├─ local-service/  Node.js 服务、桌面宿主、管理界面、测试与构建脚本
├─ renderer-probe/ 原生渲染器 Stage 1A 只读取证工具与取证说明
├─ harness/        v18 正式 Prompt
├─ tools/          客户端检测、挂载与恢复脚本
├─ .cursor/skills/fit-letters/scripts/
│                   产品当前使用的 PowerShell 运行时
└─ 林离人设.md      正式人格事实文件
```

构建：

```powershell
Set-Location .\local-service
npm install
npm test
npm run build:win
```

构建脚本会把成品写入 `source/build/`。版本号固定为 `2008.2.7`。

## 原生渲染器可行性探测

`renderer-probe` 与 `midi-renderer` 属于历史实验代码，不是 R10 的用户功能，也不随当前安装包提供琴键视频运行时。MIDI 视频生成与自动人物演奏已退出开发范围；当前只导入已生成完成的有效演奏 MP4。

源码快照不包含：

- `node_modules`
- 编译产物与下载缓存
- 本地 SQLite 数据库
- 日志和临时文件
- API 密钥
- 私密往来语料
- 拟合阶段的 `_probe` 产物
