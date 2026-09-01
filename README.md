# 林离离线增强版

这是面向《BSide: Olivia Lin》离线版本的本地增强工具。它把信件、回信、记忆、音乐与视频附件保存在自己的电脑上，并允许在 DeepSeek 和本地 OpenAI 兼容模型之间手动切换。

项目不会恢复已经关闭的官方服务器，也不包含官方账号数据或游戏资源。使用前请确认你已通过正规渠道安装游戏离线版。

## 下载

推荐下载 Windows 安装版：

- [OliviaSoul-2008.2.7-Setup.exe](https://github.com/coderscsy/linli/releases/download/2008.2.7-linli.1/OliviaSoul-2008.2.7-Setup.exe)

不想安装时可以使用便携版：

- [OliviaSoul-2008.2.7-Portable.zip](https://github.com/coderscsy/linli/releases/download/2008.2.7-linli.1/OliviaSoul-2008.2.7-Portable.zip)
- [SHA256SUMS.txt](https://github.com/coderscsy/linli/releases/download/2008.2.7-linli.1/SHA256SUMS.txt)
- [中文使用说明](https://github.com/coderscsy/linli/releases/download/2008.2.7-linli.1/Linli-Guide-zh-CN.txt)

> [!WARNING]
> 不要把本工具安装或解压到游戏目录中。请使用独立目录，例如 `I:\OliviaSoul`。

## 主要功能

- 离线写信、读取文字回信，并把往来保存到本地 SQLite 和 Markdown 档案。
- DeepSeek 与本地 Gemma 两套模型档案独立保存，在管理页中手动启用。
- 默认本地接口：`https://m4.tailf0d018.ts.net/v1`；默认模型：`gemma-4-26b-a4b-it-ultra-uncensored-heretic`。
- 当前启用的模型统一负责回信、记忆摘要、AI 导入识别和转写文本整理。
- 模型请求失败时只重试当前档案，不会自动把信件发送给另一家接口。
- 恢复离线版中的写信入口、MIDI/音乐入口、本地歌单相关能力。
- 支持 `.soul` 单文件备份与恢复，可保存信件、摘要和视频附件。
- 支持 MP4 视频回信附件的上传、保存、播放与 Range 读取。
- 内置 Whisper small、whisper.cpp 和 FFmpeg，在本机完成音视频转写。

## 首次使用

### 1. 安装或解压

运行安装包，或把便携版解压到游戏目录以外的位置。安装版和便携版不能同时运行。

### 2. 配置模型

打开“基础设置 → AI 设置”：

1. 在“编辑模型档案”中选择 `DeepSeek` 或“本地 Gemma”。
2. 分别填写并保存各自的地址、模型名和鉴权信息。
3. 点击对应的“保存并测试”确认连通性。
4. 点击“设为当前模型”才会真正切换。

仅选择、编辑或测试档案不会改变当前模型。DeepSeek 默认需要自己的 API Key；本地 Gemma 默认使用无鉴权的 OpenAI 兼容接口。

### 3. 导入记忆

官方服务器数据不会自动进入本地版本。可以通过以下方式恢复：

- 导入以前备份的 `.soul` 文件；
- 粘贴完整往来，让当前模型识别为逐封记忆；
- 在“记忆管理”中手动新建或修改。

导入前建议先导出当前 `.soul` 备份。覆盖式导入会替换现有本地记忆。

### 4. 连接游戏

在“基础设置”中选择游戏启动程序，确认本机服务端口，然后点击“启用服务”。界面显示服务已挂载后，让本工具在后台运行，再进入游戏使用信箱、MIDI 和音乐入口。

## 视频回信说明

现有的视频回信附件链路仍然可用：可以为信件保存 MP4，游戏侧能够读取和播放，`.soul` 备份也会包含视频。

自动生成林离人物语音视频目前尚未实现。模型可以阅读来信并生成文字回信，但不会凭空生成角色动画、配音或口型视频；这部分仍需要独立的视频渲染与声音方案。

## 数据与隐私

发布包不包含：

- API Key 或 `.env` 配置；
- 个人信件、回信、摘要、数据库或日志；
- 官方账号凭据和停服前的服务器数据；
- 《BSide: Olivia Lin》游戏客户端及其资源。

模型档案和本地数据保存在使用者自己的电脑上。选择在线 DeepSeek 时，请自行了解其数据政策；选择本地接口时，请确认接口实际运行位置和访问权限。

## 开发与验证

环境：Windows、PowerShell 5.1、Node.js 22、.NET Framework 4.6.2、Inno Setup 6。

```powershell
Set-Location .\source\local-service
npm install
npm test
npm run build:win
```

Harness 使用说明见 [docs/HARNESS.md](docs/HARNESS.md)，工程结构和发布约束见 [docs/ENGINEERING.md](docs/ENGINEERING.md)。

## 来源与声明

本仓库是在 [yilangren/OliviaSoul](https://github.com/yilangren/OliviaSoul) 基础上继续维护的离线增强版本，感谢原项目参与者留下的信件拟合、记忆与客户端接入工作。本仓库的 README、双模型切换、离线恢复和后续发布由 `coderscsy/linli` 独立维护。

本项目仅用于学习、研究与个人数据备份，不隶属于米哈游，也不提供游戏本体或官方服务。请遵守相关软件许可、平台规则和所在地法律。
