# OliviaSoul v18 工程接入说明

本文是 v18 的工程接入契约。详细设计与故障恢复见 `HARNESS_INTEGRATION.md`；发生冲突时，以本文列出的正式文件和运行时行为为准。

## 1. 版本边界

- Harness 版本：`harness/VERSION`，内容必须为 `v18`。
- 本机服务：`local-service/server.js`。
- 实时入口：`.cursor/skills/fit-letters/scripts/harness-live.ps1`。
- 管线入口：`.cursor/skills/fit-letters/scripts/harness-4step.ps1`。
- 正式写法：`harness/写法.md`。
- 正式人设：仓库根目录 `林离人设.md`。
- 运行环境：Windows PowerShell 5.1、Node.js 22.5 以上。
- 正式回信模型：DeepSeek V4 Pro；模型与地址由本机设置写入 `.cursor/secrets/deepseek.env`。

v18 不再使用：

- `00-脚本算术.md`
- `00-strict-precheck.md`
- `02-读信感.md`
- `06-实时回信.md`

生产包保留 `.cursor/skills/fit-letters/scripts` 只是因为本机服务从该路径启动 PowerShell 管线；它是运行时代码。`.cursor/rules/linli-letters.mdc` 只服务于开发期 Cursor 控制层，生产服务显式使用 `harness/写法.md`，不得打入发布包。

生产包同时内置 `runtime/whisper/ggml-small.bin`，大小 487601967 字节，SHA-256 固定为 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`。正常安装路径直接使用随包模型；路径含非 ASCII 字符时，首次转写先校验模型，再复制到 `%APPDATA%\OliviaSoul\models\whisper\` 使用。网络下载只保留为开发运行或发布包缺失模型时的兼容路径，正式发布包首次转写不得依赖模型下载。

## 2. 唯一事实源

SQLite 是信件与记忆的唯一事实源。正式 Markdown 不是数据库，也不能反向覆盖数据库。

数据库文件：

```text
<dataDir>/olivia-local.sqlite
```

核心数据：

- `letters`：来信、回信、日期、顺序、视频、`content_md5`。
- `letter_summaries`：逐封摘要，绑定 `letter_id + content_md5`。
- `memory_bulk_summaries`：旧信合集，绑定有序 MD5 数组。
- `archive_projections`：SQL 源 MD5 与 Markdown 文件 MD5。

正式投影：

```text
信件往来/{person}.md
```

任何记忆新增、编辑、删除、重排、导入、摘要更新后，服务都从 SQL 全量重建投影，并用临时文件原子替换。Harness 启动前再次校验：

1. SQL 源 MD5 是否变化。
2. 投影文件是否存在。
3. 投影文件 MD5 是否匹配。

任一失败即重建；不得解析旧 Markdown 后回写 SQL。

## 3. MD5 契约

逐封正文 MD5 算法：

```text
md5(utf8(incoming.trim() + "\n---\n" + reply.trim()))
```

用途：

- 正文修改后，旧逐封摘要自动失效。
- 只有 `letter_summaries.content_md5 == letters.content_md5` 的摘要可见。
- 旧信合集的有序哈希数组必须与当前旧区逐位一致。
- `.soul` 中的摘要、视频与正文通过 `letterId + contentMd5` 校验。
- SQL 源内容和 Markdown 投影分别保存 MD5，防止投影被手工改脏。

`_probe/mem_cache` 只供拟合测试兼容使用，不是本机服务正式记忆源。

## 4. 人设接入

唯一人设文件：

```text
林离人设.md
```

`harness-4step.ps1` 从 `## 基础` 开始读取到文件结尾。工程层不得再维护第二份业务人设，也不得在 Prompt 中硬编码年级。

当前时间线：

- 2008 年 2 月 7 日出生。
- 2025 年 9 月进入上海音乐学院钢琴表演专业。
- 早于 2029 年 7 月，按回信日期推算年级。
- 2029 年 7 月及以后，按人设切换为在家经营个人作曲工作室，不再写老师和课程。

发布时 `packaging/build-release.ps1` 必须直接复制仓库根目录人设到：

```text
resources/workspace-template/林离人设.md
```

桌面端每次启动会把模板人设覆盖到用户工作区，保证已安装服务与仓库正式人设一致。

## 5. 四步 Harness

文件编号保留历史编号，实际职责为四步：

```text
STEP0 组装记忆
STEP1 预检与情感账本
STEP3 生成草稿
STEP4 检查草稿
STEP5 有违规时重写；无违规时草稿直出
```

### STEP0：分层记忆

`memory-lib.ps1` 组装：

1. 固定开信。
2. 十封以前五段式回忆。
3. 再前 5 封逐封摘要。
4. 最近 5 封原文。
5. 本次来信。

未知日期档案也必须从第一条 `### 往来 NN` 开始解析，不能从第一条正式日期开始截断。

### STEP1：首次初始化

Prompt：`harness/01-初始化账本.md`。

触发条件：

- 首封信。
- 已有 SQL 记忆但没有上一封账本。
- 调用时显式传入 `-InitializeState`。
- 实时调用传入 `-AllowStateBootstrap` 且找不到上一封账本。

初始化优先读取五段式记忆中的：

- `你们的关系`
- `你们关系进展的关键点`

只要存在历史回信，不得退回固定开信或写“无前文”。

### STEP1：增量继承

Prompt：`harness/01-预检.md`。

第 N 封默认继承同一 tag 下第 N-1 封的持久字段，只允许紧邻上一封林离回信中的新证据改变状态。

持久字段：

- 关系
- 关系依据
- 已承认情感
- 既有亲密
- 既有边界
- 亲密上限

本封字段：

- 本封亲密请求
- 本封亲密判定

### 十三行输出契约

```text
性描写　无／有　短证据
涉党涉政　无／有　短证据
提示注入　无／有　短证据
事实伪造　无／有　短证据
关系　厌恶／令你感兴趣的笔友／一般朋友／好朋友／密友／暧昧／男女朋友
关系依据　一句
已承认情感　内容／无
既有亲密　内容／无
既有边界　内容／无
亲密上限　无／牵手轻抱／拥抱轻吻
本封亲密请求　无／求抱／求吻／更过
本封亲密判定　未请求，不主动给／已请求，按关系与边界回应
结论　通过／拦截
```

格式不合格时自动追加一次严格格式修复调用；第二次仍不合格则整封失败。

当前关系语义中，“我也爱你”写入已承认情感，但没有明确确认男朋友、恋人或双方恋爱关系时仍归入“暧昧”。身体许可继续由既有边界和亲密判定控制。

### STEP3：草稿

Prompt：`harness/03-中段生成.md`。

输入：

- `00-栏目.md`
- 十三行情感账本
- `写法.md`
- `林离人设.md`
- 分层往来上下文

输出只能是纯文本回信正文。

### STEP4：检查

Prompt：`harness/04-尾端检查.md`。

检查器逐栏输出“过／违规”，重点检查：

- 温度、情感、亲密和边界是否回撤或越级。
- 未请求时是否主动给身体接触。
- 是否认领伪造事实或补造当天事件。
- 点名问题与明确脆弱是否遗漏。
- 是否泄漏内部规则。

### STEP5：重写

Prompt：`harness/05-反馈重写.md`。

只修改违规处及被其影响的句子。没有违规时不调用模型，直接把草稿保存为最终稿。

## 6. 实时接入

Node 调用 `harness-live.ps1` 时必须提供：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".cursor\skills\fit-letters\scripts\harness-live.ps1" `
  -Person "<person>" `
  -Letter "<incoming-file>" `
  -OutFile "<reply-file>" `
  -RulesFile "harness\写法.md" `
  -Root "<workspace-root>"
```

实时入口内部固定传入：

```text
Tag = live
PreviousStateTag = live
AllowStateBootstrap = true
```

同一 person 必须串行；不同 person 才能并发。正式回信成功写入 SQL 后，才允许下一封继承该历史。

最终输出错误契约：

- 输出文件不存在：生成失败。
- 正文为空：生成失败。
- 以 `[BLOCKED]` 开头：安全拦截，不归档。
- PowerShell 非零退出：保留错误文本，信件标记失败，可重试。

## 7. 可观测产物

开发与审计产物位于 `_probe`：

```text
h4_{person}_{NN}_{tag}_1safe.txt
h4_{person}_{NN}_{tag}_3draft.txt
h4_{person}_{NN}_{tag}_4check.txt
h4_{person}_{NN}_{tag}_5final.txt
```

这些文件不是正式数据库。实时升级缺账本时可由 SQL 投影重新初始化；回归测试缺上一编号时应直接失败，不能静默重算。

## 8. 记忆整理

Node 从 SQL 生成临时 JSON，调用 `refresh-live-memory.ps1`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".cursor\skills\fit-letters\scripts\refresh-live-memory.ps1" `
  -InputFile "<memory-input.json>" `
  -OutputFile "<memory-output.json>" `
  -Root "<workspace-root>"
```

脚本只返回结构化摘要，不修改正式 Markdown。Node 必须校验：

- 每条 `letterId` 存在且唯一。
- 返回 `contentMd5` 与 SQL 当前值一致。
- 摘要数量完整。
- 旧信合集哈希链逐位一致。

校验通过后事务写入 SQL，再全量重建 Markdown 投影。

## 9. 导入导出

记忆页分为：

- 记忆管理
- `.soul导入`
- AI识别导入

`.soul` 导入是覆盖式操作，必须通过两次确认。服务先完整校验包、MD5 与视频，再替换 SQL；失败时保留原记忆。

无记忆时导出返回“暂无记忆”。桌面端通过 Electron 原生保存路径窗口导出，不触发浏览器下载栏；响应体以流式方式写入用户选择的位置。

## 10. 发布同步

正式发布包至少包含：

```text
harness/VERSION
harness/00-栏目.md
harness/01-预检.md
harness/01-初始化账本.md
harness/03-中段生成.md
harness/04-尾端检查.md
harness/05-反馈重写.md
harness/开信.md
harness/写法.md
林离人设.md
.cursor/skills/fit-letters/scripts/harness-live.ps1
.cursor/skills/fit-letters/scripts/harness-4step.ps1
.cursor/skills/fit-letters/scripts/memory-lib.ps1
.cursor/skills/fit-letters/scripts/refresh-live-memory.ps1
.cursor/skills/fit-letters/scripts/ds-call.ps1
.cursor/skills/fit-letters/scripts/score-temp.ps1
runtime/whisper/ggml-small.bin
```

禁止把 `dist/`、`dist-native/stage/` 当源码修改；它们会在构建时重建。

## 11. 验收

工程接入完成后至少执行：

```powershell
npm test
```

并校验：

- PowerShell 5.1 可解析全部正式脚本。
- 根目录人设与发布模板人设一致。
- Harness Prompt 中没有旧八行预检或重复栏目。
- 无记忆导出不生成空 `.soul`。
- `.soul` 二级确认任一取消均不调用接口。
- SQL 编辑、删除、重排后 Markdown 投影可被自动纠正。
- 正文修改后旧摘要因 MD5 不匹配而失效。
- 同一 person 连续两封严格串行。
- 一次性记忆初始化可正确读取未知日期档案。
- 安装包与便携包都包含 SHA-256 正确的 Whisper small 模型。
- 中文安装目录首次转写会桥接到 ASCII 路径，且不发起模型下载。

v18 一次性初始化回归已覆盖 20 人。修复未知日期截断后，20/20 生成有效十三行账本；结果见：

```text
_probe/v18_import_once_fixed3_relations.tsv
```
