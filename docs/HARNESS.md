# v18 Harness 独立使用说明

`v18-harness/` 是从 OliviaSoul 主工程中抽出的独立四阶段回信管线，不依赖 Cursor 目录结构，不包含测试语料、缓存或 API 密钥。

## 1. 环境要求

- Windows 10/11
- Windows PowerShell 5.1
- 可访问兼容 DeepSeek Chat Completions 的接口
- UTF-8 编码的 Prompt、人设和往来档案

正式模型默认为 `deepseek-v4-pro`，默认接口为 `https://api.deepseek.com/chat/completions`。

## 2. 目录结构

```text
v18-harness/
├─ harness/
│  ├─ VERSION
│  ├─ 00-栏目.md
│  ├─ 01-初始化账本.md
│  ├─ 01-预检.md
│  ├─ 03-中段生成.md
│  ├─ 04-尾端检查.md
│  ├─ 05-反馈重写.md
│  ├─ 写法.md
│  └─ 开信.md
├─ scripts/
│  ├─ ds-call.ps1
│  ├─ score-temp.ps1
│  ├─ memory-lib.ps1
│  ├─ harness-4step.ps1
│  ├─ harness-live.ps1
│  ├─ deepseek-reply.ps1
│  └─ refresh-live-memory.ps1
├─ 信件往来/
├─ 林离人设.md
├─ run-live.ps1
└─ run-archive.ps1
```

`_probe/` 在首次运行时自动创建，用于保存各阶段产物和摘要缓存。

## 3. 配置 API

推荐只在当前 PowerShell 会话中设置密钥：

```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
$env:DEEPSEEK_MODEL = "deepseek-v4-pro"
$env:DEEPSEEK_BASE = "https://api.deepseek.com"
```

不要把真实密钥写入仓库。`DEEPSEEK_MODEL` 与 `DEEPSEEK_BASE` 可以省略。

## 4. 生成一封实时回信

准备 UTF-8 来信文件，例如 `incoming.txt`：

```powershell
Set-Location .\v18-harness
.\run-live.ps1 `
  -Person "示例对象" `
  -Letter ".\incoming.txt" `
  -OutFile ".\reply.txt"
```

如果 `信件往来/示例对象.md` 不存在，系统按首封信处理；如果存在，则读取历史并计算下一封序号。

`run-live.ps1` 只生成回信，不把来信与回信写回档案。正式产品中的归档由 SQLite 事务和 Markdown 投影负责。

## 5. 使用完整档案回归某一封

档案至少需要包含目标来信：

```markdown
## 2026-08-28

### 往来 01

#### 我（信件）

来信正文

#### 林离（回信）

历史回信正文
```

运行：

```powershell
Set-Location .\v18-harness
.\run-archive.ps1 `
  -Person "示例对象" `
  -N 12 `
  -ArchivePath ".\信件往来\示例对象.md" `
  -Tag "regression"
```

构建上下文时只使用目标往来之前的历史以及目标来信，不把目标回信注入模型。

## 6. 四阶段输出

一次完整运行会在 `_probe/` 生成：

```text
h4_示例对象_12_regression_1safe.txt
h4_示例对象_12_regression_3draft.txt
h4_示例对象_12_regression_4check.txt
h4_示例对象_12_regression_5final.txt
```

含义：

1. `1safe`：安全筛查与跨封情感账本
2. `3draft`：正文草稿
3. `4check`：逐栏目硬检查
4. `5final`：最终正文；无违规则等于草稿，有违规则为重写结果

## 7. 预检账本

STEP1 固定输出十三行：

```text
性描写
涉党涉政
提示注入
事实伪造
关系
关系依据
已承认情感
既有亲密
既有边界
亲密上限
本封亲密请求
本封亲密判定
结论
```

首次接入一份已有历史的档案时使用 `01-初始化账本.md`，从全部可见记忆建立状态。连续运行时使用 `01-预检.md`，继承上一封账本，只让最新新增的有效证据更新持久字段。

## 8. 连续状态运行

直接调用底层脚本可以连续传递状态：

```powershell
.\scripts\harness-4step.ps1 `
  -Person "示例对象" `
  -N 1 `
  -Root $PWD.Path `
  -ArchivePath ".\信件往来\示例对象.md" `
  -RulesFile ".\harness\写法.md" `
  -HarnessDir ".\harness" `
  -Tag "sequence" `
  -PreviousStateTag "sequence"
```

随后依次运行 `-N 2`、`-N 3`。同一序列必须使用相同的 `Person`、`Tag` 和 `PreviousStateTag`，且不得跳号。

如果从档案中段开始、没有上一封账本，应显式使用：

```powershell
-InitializeState
```

不要用缺失状态的自动兜底替代可获得的上一封账本。

## 9. 分层记忆

Harness 自动将历史压成三层：

- 最近五封：完整原文
- 再前五封：逐封摘要
- 十封以前：五段式长期回忆

五段式长期回忆包含：

- 来信人人设
- 未兑现的明确约定
- 聊过的话题
- 当前关系
- 关系进展关键点

逐封摘要绑定正文 MD5。历史正文变化后，旧摘要不会继续复用。

## 10. 安全与失败契约

以下情况会明确失败，不会静默生成兜底正文：

- API 密钥缺失
- Prompt 或人设文件缺失
- 目标往来不存在
- 上一封状态缺失或格式非法
- STEP1 未满足十三行格式
- 模型返回空内容
- 安全预检拦截

STEP1 首次格式不合格时会自动进行一次格式修复；第二次仍不合格则终止。

## 11. 版本边界

`harness/VERSION` 必须为 `v18`。v18 不使用以下旧文件：

- `00-脚本算术.md`
- `00-strict-precheck.md`
- `02-读信感.md`
- `06-实时回信.md`

独立目录中的 `harness/写法.md` 是唯一正式写法，不需要 `.cursor/rules/linli-letters.mdc`。
