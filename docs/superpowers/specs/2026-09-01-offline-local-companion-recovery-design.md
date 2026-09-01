# BSide: Olivia Lin 离线本地陪伴版设计

日期：2026-09-01

状态：已进入实施规划（本地曲库恢复已纳入）

代码仓库：`I:\Tools\OliviaSoul-reference-2b56a78e`
独立运行目录：`I:\OliviaSoulLocal\BSide`

## 1. 目标

在不覆盖 Steam 原版、不依赖已关闭官方服务器的前提下，建立一个 I 盘独立版本，使本地客户端能够：

1. 显示信箱和写信入口；
2. 把来信保存到本地，由 Gemma 阅读并生成文字回信；
3. 在游戏内播放已生成或手动附加的 MP4 视频回信；
4. 取消官方“每天 3 封”限制，改为本地可配置；
5. 恢复 MIDI 上传界面和本地任务接口；
6. 恢复已备份的本地曲库，至少完整显示轻音乐、古典和 ACG，并从本地播放已保存资源；
7. 在存在合法原生渲染器时生成林离同步演奏视频；不存在时明确显示渲染器不可用，不伪造完成状态。

当前 Steam 离线版和 I 盘备份属于同一 Build，覆盖恢复不会恢复在线服务。功能代码壳仍在前端中，但被 `offlineMode`、`N3=false`、`Ss=false` 和离线网络拦截器隐藏或阻断。

## 2. 已确认事实

- 当前客户端与备份均为 `ToyPianist-win-x64-rel-v0.0.9.627`。
- Steam BuildID 为 `24943426`，Depot manifest 为 `3483511100282414030`。
- 当前游戏目录有 185 个文件，约 3.44 GiB。
- 当前前端仍包含信箱、写信、视频回信展示和 MIDI 页面代码。
- OliviaSoul 已实现本地登录、信件保存、文字回信、信件列表、MP4 附加、Range 播放和 `.soul` 备份。
- 当前 worker 只自动生成文字回信，固定写入 `reply_type=1`；MP4 附加后才变为 `reply_type=2`。
- 当前 local-service 没有本地 MIDI 上传、任务、进度、结果或渲染接口。
- I 盘备份已保存 3 个分类、129 首曲目和 1,218/1,218 个目录资源，共 59,365,972,637 字节；其中轻音乐 13 首的元数据、WAV、封面和各时段视频均已保存。
- 当前 `%APPDATA%\miHoYo\Olivia-steam` 仍有覆盖全部 13 首轻音乐的 69 个视频，约 4.12 GB；离线日志也证明 `getOfflineSongList` 曾正常返回曲库，并成功播放《梦中的婚礼》和《送别》。
- 当前工程发布边界没有包含曲库索引或媒体资源；现有前端补丁只接管登录和信箱接口，因此“项目里没有轻音乐”是尚未接入归档，而不是下载内容丢失。
- 当前游戏和完整备份中均没有 `wallpaper\TPRender\Binaries\Win64\Olivia.exe`、配套 PAK、配置和原生场景资产。
- I 盘为 exFAT，系统报告 `Warning / Full Repair Needed`。用户仍选择在 I 盘建立独立版本。

## 3. 方案比较

### 方案 A：完整 I 盘独立副本（采用）

把 3.44 GiB 客户端复制到 `I:\OliviaSoulLocal\BSide\game`，只修改该副本。Steam 的 Z 盘版本保持原样。

优点：边界清楚、容易回退、不会被 Steam 更新直接覆盖。

代价：占用约 3.44 GiB；需要验证复制版是否能经合法 Steam 登录独立启动。

### 方案 B：只给 Steam 安装目录挂载补丁（不采用）

继续修改 Z 盘 `feapp.dat`，启动前挂载、退出后恢复。

优点：空间占用小。

缺点：Steam 更新、崩溃或恢复失败会污染唯一安装，不符合“独立版本”要求。

### 方案 C：只做浏览器/管理端陪伴工具（保留为诊断入口）

不恢复游戏 UI，只在管理网页写信、收信、上传 MIDI 和视频。

优点：实现简单。

缺点：失去游戏内信箱和林离陪伴体验，不能满足主要目标。

## 4. 目录与隔离

```text
I:\OliviaSoulLocal\BSide\
├─ game\                 独立游戏副本，只由本项目修改
├─ service\              可双击启动的本地服务发布包
├─ runtime\
│  ├─ data\              SQLite、信件、记忆、配置
│  ├─ midi\              MIDI 原文件和任务元数据
│  ├─ videos\            视频回信和 MIDI 渲染结果
│  ├─ catalog\           本地曲库索引、资源映射和完整性状态
│  └─ logs\              已脱敏、可轮转日志
├─ recovery\
│  ├─ source-hashes.json  Z 盘源文件复制前哈希
│  ├─ copy-hashes.json    I 盘副本复制后哈希
│  └─ feapp-original.dat  独立副本修改前前端
└─ Start-Olivia-Local.cmd 双击入口
```

源码继续保留在 `I:\Tools\OliviaSoul-reference-2b56a78e`。Z 盘 Steam 游戏、Steam manifest 和 I 盘既有备份均视为只读输入。

由于 I 盘是 exFAT：

- 不使用 hard link；
- 不假设多文件 rename 事务具备 NTFS 语义；
- 复制前后逐文件 SHA-256；
- 所有重要状态采用单写者、带校验的 generation/snapshot；
- 不自动运行磁盘修复、格式化或转换命令；
- 任何新读写错误都会停止安装，不继续启动副本。

## 5. 分阶段架构

### 阶段 1：独立客户端、本地信箱和 Gemma 回信

这是第一个实施子项目。

#### 5.1 独立副本

1. 对 Z 盘 185 个源文件生成 SHA-256 清单；
2. 普通复制到 `I:\OliviaSoulLocal\BSide\game`；
3. 对副本重新计算 SHA-256，要求全部匹配；
4. 保存未修改的 `feapp.dat`；
5. 先验证原样副本是否能够由用户合法拥有的 Steam 会话启动；
6. 如果 Steam 强制跳回 Z 盘安装，停止，不做 DRM 绕过，并重新设计启动挂载方式。

#### 5.2 离线前端补丁

补丁只适用于已确认哈希的 `frontend-tp-beta_cn_b776ad35_455e162`，任何目标出现次数不符合预期时直接失败。

补丁内容：

- `N3=true`：显示写信入口；
- `Ss=true`：显示本地 MIDI 入口；
- 允许离线信箱加载本地列表和未读数；
- 取消 `hide-write=true` 的离线强制覆盖；
- 只对本地信箱和本地 MIDI 路由绕过 `ERR_OFFLINE_BLOCKED`；
- 登录后恢复本地信箱轮询和本地 MIDI 任务轮询；
- 保留 `replyVideoUrl` 到视频回信视图的映射；
- 官方域名和未知在线接口继续保持离线阻断。

补丁工具必须同时产出：原文件哈希、补丁后哈希、命中计数和可逆恢复文件。

补丁不得破坏离线版原生 `getOfflineSongList`、`checkLocalSongs` 和本地播放桥。若原生桥能完整返回 3 类 129 首，则优先复用；只有资源 URL 或本地可用状态缺失时，才由本地曲库适配层补齐。

#### 5.3 本地信件服务

复用现有 `/toy/*` 接口：

- `POST /toy/signIn`
- `GET /toy/getUserInfo`
- `POST /toy/letter/send`
- `GET /toy/letter/list`
- `GET /toy/letter/detail`
- `GET /toy/letter/unread_count`
- `POST /toy/letter/share`
- `POST /toy/letter/resend`
- `GET|HEAD /toy/letter/video/:letterId`

本地发信限制改成配置项：默认无限制，也可由用户设置每日上限。管理页继续提供手动重置。

#### 5.4 DeepSeek / 本地 Gemma 手动切换

模型层保留两套彼此独立的 OpenAI Chat Completions 配置，并持久化当前选择：

- `activeProvider=deepseek|local`，只允许用户在管理页手动切换；
- DeepSeek 配置继续兼容现有 `deepseek.env`，默认使用 `https://api.deepseek.com`、`deepseek-v4-pro` 和 Bearer API Key；
- 本地配置示例使用 `http://127.0.0.1:8000/v1`、`your-local-model` 和 `authMode=none`；
- 两套配置分别保存 `baseUrl`、`model`、`authMode` 和 `apiKey`，切换时不得覆盖未选中的配置；
- 本地服务允许空密钥；若用户明确选择 Bearer，则必须填写密钥；
- 本地 Gemma 请求不发送 DeepSeek 专属 `thinking` 和 `reasoning_effort` 字段；
- 写信回信、逐封摘要、旧信合集、AI 导入和转写整理统一读取同一个 `activeProvider`，不得各自漂移；
- 当前接口失败时明确报告当前 provider、地址和安全处理后的错误，不自动回退到另一接口，也不重试另一个模型；
- 两套连通性测试互相独立，测试或保存一套配置不得改变当前 provider，只有显式“设为当前”才切换；
- 密钥只保存在 `.cursor/secrets` 下的本地配置，不写日志、导出包或游戏前端；
- 启动时检查当前模型兼容性，失败时保留来信为待处理，不生成伪回信。

配置迁移采用兼容读取：首次加载新配置时投影现有 `DEEPSEEK_*` 值，但不删除或重写旧 `deepseek.env`。新配置同时保存 DeepSeek 和本地两套档案，以便离线服务升级、回滚和再次切换。

数据流：

```text
管理页手动选择 DeepSeek / 本地 Gemma
                    ↓
游戏写信 → local-service/SQLite → 当前 provider → 文字回信
                                               └→ 记忆摘要、AI 导入和转写整理
已有关联 MP4 → reply_type=2 → 游戏内视频回信播放器
```

#### 5.5 本地曲库恢复

曲库恢复使用两个已经确认的数据源：

- `0.0.9.627\assets\songlist.dat`：离线客户端原生曲库索引；
- `I:\Backups\BSide-Olivia-Lin-2026-08-31\remote-content`：完整 API 元数据、资源清单和 1,218 个本地资源。

第一版不重复复制约 59.4 GB 归档，而是在独立版中保存只读数据源路径、清单哈希和本地资源映射。服务不得修改备份目录；路径失效或哈希不符时只报告曲库不可用，不回退访问官方服务器。

本地适配层负责：

- 核对轻音乐 13、古典 48、ACG 68，总计 129 首；
- 根据 `catalog-resource-manifest.json` 把原官方 URL 映射到本地 WAV、MP4 和图片；
- 为媒体请求提供 Range、正确 MIME 和内容长度；
- 保留歌曲名称、分类、演奏类型、时段和视角信息；
- 显示资源完整性，缺单个时段时只降级该时段，不隐藏整首歌；
- 优先复用当前已下载缓存，但不自动移动或删除 C 盘现有文件。

若用户后续要求释放 C 盘空间，另做一次“复制到 I 盘、逐文件哈希验证、切换存储路径、用户确认后再清理旧缓存”的独立迁移；本阶段不删除 C 盘缓存。

### 阶段 2：本地 MIDI 上传和任务系统

第二个实施子项目负责恢复旧 MIDI 页面需要的兼容接口：

- 本地上传替代 `/genObjectUploadUrl`；
- `POST /midi/generate`；
- `GET /midi/getGenerateResult`；
- `GET /midi/listJobs`；
- `GET /midi/batchGetResult`；
- `POST /midi/cancelGenerate`；
- `POST /midi/deleteJob`；
- `/midi/importShareCode` 返回明确的“离线不支持”，不访问官方服务；
- 本地 MIDI、音频和 MP4 支持 Range 下载。

上传规则：

- 只接受真实 MIDI 文件头和受限大小；
- 解析轨道、速度、时长、音符数和 tempo map；
- 防止路径穿越、压缩炸弹和无限任务；
- 本地不设置官方每日生成次数；
- 状态明确区分 `queued/running/complete/failed/renderer_unavailable/cancelled`。

没有渲染器时仍可完成上传、解析和排队，但不能把任务标记为 `complete`。

### 阶段 3：演奏视频渲染

渲染器采用可替换适配器：

```text
MIDI job → performance plan → renderer adapter → MP4/audio
                                      ├─ native-tprender
                                      ├─ generic-piano
                                      └─ unavailable
```

#### 原生 TPRender

`TPRender` 是游戏原在线流程使用的独立原生渲染程序名称。现有 DLL 中仍保留 `LivePlayerManager`、`PerformanceManager`、`RenderPlaySource`、`startPlayingMusic`、`render_ready` 等控制协议，但真正负责林离模型、钢琴、场景、动作和 Unreal 渲染的程序及资产不在离线包内。

一个可用候选至少应包含：

```text
wallpaper\TPRender\
├─ Binaries\Win64\Olivia.exe
├─ Binaries\Win64\*.dll
├─ Config\*.ini
└─ Content\Paks\*.pak
```

即使找到这些文件，也要先只读验证版本、哈希和结构，再写单独的 Stage 1B 协议计划；本设计不直接启动未知候选。

#### 通用钢琴渲染器

若原生资产一直找不到，可以实现 MIDI 与琴键、音频严格同步的通用钢琴视频，并复用视频回信接口。但角色不是林离，UI 必须明确标注“通用钢琴可视化”，不能冒充原版演奏。

#### 关于“弹唱”

MIDI 通常只有音符和控制信息，不包含人声、歌词、合法角色声线或口型数据。第一版只承诺钢琴演奏。唱歌需要用户另行提供合法音频/歌词，并单独设计声音授权、混音和口型同步；不把声音克隆默认纳入本项目。

## 6. TPRender 应去哪里找

只查找用户合法拥有或官方提供的来源：

1. 你自己的其他电脑、旧硬盘、Windows.old、旧 Steam Library 或停服前完整备份；
2. 官方发布过的旧安装包、离线包或官方客服/QQ群提供的补充资产；
3. Steam 对你账号仍有权限的历史 depot，但只能使用 Steam 正常提供的内容，不绕过授权；
4. 其他玩家自己合法保存的同版本文件时，先确认其再分发权限和版本来源。

不使用随机网盘中的未知 EXE、破解包、去 DRM 工具或来源不明的 PAK。OliviaSoul GitHub 项目只包含本地服务和补丁思路，不包含米哈游专有的 TPRender 资产。

后续可以对用户自有磁盘做只读精确搜索：

- `TPRender\Binaries\Win64\Olivia.exe`
- `TPRender-Win64-Shipping.dll`
- `TPRender-Windows.pak`
- 包含 `LivePlayerProcessReadyNotify` 或 `render_ready` 的同目录配置

## 7. 启动与失败处理

双击入口负责：

1. 检查 I 盘目录和关键文件哈希；
2. 启动只监听 `127.0.0.1` 的 local-service；
3. 检查当前手动选择的 DeepSeek 或本地 Gemma provider；
4. 启动独立游戏副本；
5. 退出时停止本次启动的本地服务，不结束其他 Node 进程。

失败行为：

- 副本哈希不匹配：拒绝补丁和启动；
- 前端补丁命中数变化：拒绝写入；
- Gemma 不可用：信件保留待处理，可稍后重试；
- 视频缺失：回退显示文字，不删除文字回信；
- TPRender 缺失：MIDI 状态为 `renderer_unavailable`；
- I 盘出现新的读写错误：停止写入并提示先处理磁盘健康；
- 复制版不能合法启动：停止，不绕过 Steam/DRM。

## 8. 安全与数据边界

- Steam Z 盘安装和 appmanifest 永不由独立版修改；
- 既有 I 盘备份只读；
- 不连接已关闭的官方业务接口；
- 本地服务只监听 loopback；
- 所有文件名由服务生成，用户输入不能成为路径；
- MIDI、视频和信件均有大小上限；
- 日志不记录信件全文、模型密钥、Authorization、Cookie 或 JWT；
- 数据备份使用 SQLite backup API 和内容哈希；
- 删除任务时先移入独立版回收区，默认不永久删除；
- 不下载、启动或修补来源不明的原生程序。

## 9. 验证与验收

### 阶段 1 验收

- Z 盘 185 个源文件扫描前后 SHA-256 不变；
- I 盘副本与源清单逐文件一致；
- 独立副本能够合法启动，Z 盘原版仍能启动；
- 游戏内可见信箱、写信入口和历史回信；
- 连续发送超过 3 封本地信件不被官方日限额阻断；
- DeepSeek 与本地 Gemma 均可独立保存和测试，手动切换后配置互不覆盖；
- 本地 Gemma 成功生成文字回信，当前接口失败时不自动调用 DeepSeek；
- 手动附加 MP4 后，游戏内以视频回信播放且支持 Range；
- 游戏内显示轻音乐 13、古典 48、ACG 68，总计 129 首；
- 13 首轻音乐均能从本地资源打开，断网时不访问官方资源域名；
- 随机抽查每类至少 3 首，验证封面、音频、默认视频和 Range 播放；
- 归档目录保持只读，验收前后资源清单哈希不变；
- 无官方业务网络请求、无秘密写入日志。

### 阶段 2 验收

- 游戏内可上传合法 MIDI；
- 非法文件和超限文件被拒绝；
- 任务列表、进度、取消、删除和结果接口与旧页面兼容；
- 无渲染器时诚实显示 `renderer_unavailable`。

### 阶段 3 验收

- 原生候选只有在 EXE/DLL/PAK/INI 结构和哈希通过后才进入协议测试；
- 原生方案必须证明 MIDI 音符、琴键和画面时间轴同步；
- 通用方案必须明确标注，不冒充林离原版演奏；
- 生成 MP4 可自动关联到信件并作为 `reply_type=2` 播放。

## 10. 实施拆分

本设计不作为一个巨型实现任务执行，而拆成三个独立 spec/plan：

1. **Local Companion Restore**：I 盘副本、启动验证、离线前端、DeepSeek/本地 Gemma 手动切换、信件、现有视频回信和 129 首本地曲库；
2. **Local MIDI Jobs**：MIDI 上传、解析、任务协议、存储和旧 UI 兼容；
3. **Renderer Integration**：TPRender 合法恢复与协议，或通用钢琴适配器。

用户批准本文后，只为第 1 项编写详细实施计划。第 2、3 项在前一项验收后分别设计、计划和实现。

## 11. 非目标

- 不恢复或冒充官方云服务器；
- 不伪造已经丢失的官方账号数据；
- 不绕过 Steam 或其他 DRM；
- 不从不明来源下载原生 EXE/PAK；
- 不在缺少 TPRender 时声称已实现林离真实同步演奏；
- 第一阶段不实现声音克隆、歌词生成或口型同步。
