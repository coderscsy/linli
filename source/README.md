# 工程源码

本目录保留生成 2008.2.7 正式发布包所需的源码快照。

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

原生渲染器的 Stage 1A 只读探测说明见 [renderer-probe/README.md](renderer-probe/README.md)。它与 `local-service` 分离，仅建立资产证据、哈希和后续决策；目前尚不能生成 MIDI 视频。

源码快照不包含：

- `node_modules`
- 编译产物与下载缓存
- 本地 SQLite 数据库
- 日志和临时文件
- API 密钥
- 私密往来语料
- 拟合阶段的 `_probe` 产物
