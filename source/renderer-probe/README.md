# 原生渲染器恢复探测

> 历史实验文档，不是 R10 的安装或使用指南。MIDI 视频生成与自动人物演奏已退出当前开发范围；以下路径均为占位符，不可直接照抄执行。用户说明见[仓库 README](../../README.md)。

`renderer-probe` 是 Stage 1A 的只读资产证据工具：它扫描已存在的游戏、备份和配置目录，记录可验证的文件身份，并生成下一阶段的决策。它不会运行任何被扫描的 EXE 或 DLL，也不会下载或修改输入目录。

> 本工具不会下载、移动、删除、修补或启动任何游戏/渲染器文件。它只建立资产证据、哈希和下一阶段决策。blocked_missing_renderer 是有效且诚实的完成状态。

## 前置条件

- Windows PowerShell。
- Node.js `>=22.5`（可用 `node --version` 确认）。
- 以下来源均已在本机存在，且操作者有权只读访问：
  - 游戏根目录：`<游戏安装目录>`
  - Steam 库元数据根目录：`<Steam库目录>`
  - 备份根目录：`<用户备份目录>`
  - 游戏 AppData 根目录：`C:\Users\YOUR_NAME\AppData\Roaming\miHoYo\Olivia-steam`

输入根目录始终只读；工具不会移动、删除、重命名、修补或启动其中任何文件。扫描仅以字节方式读取候选文件，不执行未知 EXE/DLL，不进行 DRM 绕过。

## 执行精确命令

以下命令仅保留历史实验的结构；所有尖括号路径均须替换为经过用户授权的实际位置，不能照抄执行：

```powershell
Set-Location '<源码目录>\source\renderer-probe'
node src/cli.js scan `
  --data-root '<用户指定的探测数据目录>' `
  --game-root '<游戏安装目录>' `
  --backup-root '<用户备份目录>' `
  --appdata-root 'C:\Users\YOUR_NAME\AppData\Roaming\miHoYo\Olivia-steam' `
  --steamapps-root '<Steam库目录>'
```

唯一允许的运行时写入根目录是 `<用户指定的探测数据目录>`。扫描会在其下写入且只写入：

- `<用户指定的探测数据目录>\evidence\stage1a-report.json`
- `<用户指定的探测数据目录>\evidence\stage1a-report.md`
- `<用户指定的探测数据目录>\evidence\binary-protocol-evidence.json`

## 退出码与决策门

| 退出码 | 含义 | 操作 |
| --- | --- | --- |
| `0` | `candidate_ready`：找到结构完整的 `TPRender` 候选。 | 仅停止并审阅证据；Stage 1B 仍须另行计划和批准。 |
| `1` | 参数、输入清单、库存扫描或报告写入失败。 | 不进入 Stage 1B；修复可验证的环境问题后重新运行。 |
| `2` | `blocked_missing_renderer`：未找到结构完整的合法渲染器。 | 这是有效、诚实的完成状态；不开始 MIDI endpoint、client patch 或视频生成。 |

Stage 1B 被严格禁止，除非 `stage1a-report.json` 的 `status` 为 `candidate_ready`，且操作者已审阅候选的真实哈希、可执行布局、消息名和观察到的配置。即使退出码为 `0`，本工具也不会启动 Stage 1B。

## 脱敏和审阅

生成的证据在持久化前会做凭据脱敏：不得保留 token、JWT、`Authorization`、`Cookie`、`x-token` 或 `model_gateway_token` 的原始值。审阅时如凭据模式检测命中，应只报告“redaction failed”并停止，不显示命中行或内容。

`renderer-probe` 与 `source/local-service` 完全分离：前者只负责 Stage 1A 取证与决策，后者是本地服务/桌面宿主。该探测器目前尚不能生成 MIDI 视频。
