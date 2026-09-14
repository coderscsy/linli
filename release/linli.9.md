# OliviaSoul R10.7 · 中转 API 兼容更新

更新标识：`2008.2.7-linli.9`。程序版本保持 `2008.2.7`，客户端补丁仍为 **FE v44 / WebPlayer v18**，包含 R10.6 全部功能。

## 新增

- 支持手动填写模型名，模型列表查询为可选操作；中转站与本地接口统一使用“通用兼容 API”档案。
- 支持完整 Chat Completions 地址、JSON 分段正文及 SSE 正文处理。
- 安装版与便携版均附中文 API 配置说明，包含 seekai.cc 示例、地址用途、鉴权方式及常见错误处理。

## 修复与优化

- 修复模型查询覆盖手填名称的问题；查询失败仍可手动填写并测试。
- 修复非 DeepSeek 模型接收专用参数的问题。
- 统一检测、AI 导入、文本整理和实际回信的正文处理，避免仅推理、截断、断流或错误响应被误判成功。
- 明确拒绝 `max_tokens` 时，以相同上限改用 `max_completion_tokens` 重试一次；认证或限流错误不触发参数重试。
- 加强地址校验、响应大小限制及重定向保护，调整 DeepSeek 推理检测的输出预算。

## 下载与使用

提供 `OliviaSoul-2008.2.7-Setup.exe`、`OliviaSoul-2008.2.7-Portable.zip`、`SHA256SUMS.txt` 和中文说明。

升级前关闭游戏并从托盘退出程序，备份整个 `UserData` 和外部音乐目录。安装版覆盖原目录；便携版完整解压，勿从 ZIP 内直接运行。保留已有配置，不附个人密钥、信件或曲库。

[API 配置使用说明](https://github.com/coderscsy/linli/blob/2008.2.7-linli.9/source/local-service/packaging/API配置使用说明.md) · [累计更新说明](https://github.com/coderscsy/linli/blob/2008.2.7-linli.9/source/local-service/packaging/发布说明.md)

支持 Chat Completions 兼容端点，不代表原生接入全部厂商协议；seekai.cc 为配置示例，尚未使用该用户密钥实测。Windows 可能提示未知发布者，请核对来源与 SHA-256。
