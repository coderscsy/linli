# 模型与中转 API 兼容说明

适用版本：R10.7（2008.2.7-linli.9），2026-09-14。此前发布的 R10.6 安装包不包含本页新增兼容处理。面向使用者的逐步说明见 [API 配置使用说明](../source/local-service/packaging/API配置使用说明.md)。

验证说明：服务、设置页与回信脚本经过隔离浏览器和 PowerShell 入口验证，并在维护者当前配置的兼容服务上完成短请求验证。未使用 seekai.cc 用户密钥验证；其他用户的旧安装包需升级后才包含本次改动。

## 配置

进入「AI 模型」，普通中转或本地推理服务选择「通用兼容 API（本地 / 中转）」。配置格式仍沿用原 local 档案，无需迁移已有密钥或模型。

1. 地址填写服务商提供的基础地址，如 `https://example.com/v1`。也可填写 `https://example.com/v1/chat/completions`，程序只去掉末尾重复端点，保留 `/v1` 和其他自定义路径。不自动猜测或添加版本号。
2. 按需选择 `Bearer API Key` 或无需鉴权。不要把密钥塞进 URL；查询参数、URL 内嵌账号密码及片段不受支持。
3. 模型名可直接手动填写，也可点击「查询模型列表」后从候选中选择。查询失败不会清空输入，不影响手动模型的测试。
4. 点击「保存并测试通用模型」。失败保留原配置；成功保存后，尚未启用的档案仍需点击「检测并设为当前模型」。

使用中转会把请求内容发送到所配置的服务商，包括回信所需的文本上下文。不要在反馈、截图或公开 Issue 中提交 API Key。

## 中转站接入

面向用户统一使用“中转站”这一称呼，不要求用户了解或部署其底层项目。seekai.cc 的配置示例已合并到 [API 配置使用说明](../source/local-service/packaging/API配置使用说明.md)，此处不重复步骤。

客户端原样发送所填模型名；渠道和模型映射由中转站处理。模型列表出现某个名称不代表账户额度、授权或渠道一定可用，仍需实际测试。

契约模拟覆盖模型列表及别名、空 SSE 增量与用量尾包、HTTP 200 错误对象，同时经过 Node 与 PowerShell 入口；不等同于使用 seekai.cc 用户账号进行验证。第三方项目名称仅保留在下方开发参考中。

## 已覆盖行为

| 场景 | 行为 |
| --- | --- |
| Chat Completions 非流式 JSON | 支持字符串正文、text/output_text 分段正文及部分兼容文本包装 |
| 请求非流式但上游返回 SSE | 识别 `text/event-stream`，合并正文增量，校验结束标记 |
| 仅返回 reasoning/thinking | 不作为最终正文；测试与实际回信均报告失败 |
| SSE 断流、错误，或 JSON/SSE 明确报告输出被截断 | 不保存半封回复为成功结果 |
| 不提供 `/models` | 允许手动填写模型名并测试 |
| 拒绝 `max_tokens` | 仅在 HTTP 400/422 明确表明参数不支持时，改为 `max_completion_tokens` 重试一次，保持原上限 |
| 401、429、无关 400 | 不触发参数改名；报告状态，不自动切换到其他平台 |
| 自定义远程模型 | 非 DeepSeek 名称不发送 DeepSeek 专用参数；通用档案从不发送这些参数 |

DeepSeek 专用参数目前仅用于远程档案中以 `deepseek` 命名的模型（也支持 `厂商/deepseek-…`）；给模型设置了不透明别名时，按通用参数发送。JSON/SSE 响应限制为 8 MiB，凭据请求不跟随重定向。

Node 的连通性测试、信件导入识别、逐字稿整理共用一个解析器；PowerShell 实际回信保持原入口，通过真实 loopback HTTP 对照测试保证相同的正文提取和请求规则。探测输出上限为通用模型 128 token、启用推理参数的 DeepSeek 模型 4096 token，并保留 30 秒超时；避免推理把过小预算耗尽后误判无正文。这不保证长文本、真实账号额度、供应商网络或限流条件下的所有请求成功。

## 范围限制

不包含 Claude 原生 Messages、原生 Responses、Gemini 原生接口、Azure 特殊路由、自定义请求头或完整多协议网关。某些中转虽然能返回兼容文本结构，但仍须提供 Chat Completions 请求端点。只允许 `stream:true` 请求而拒绝 `stream:false` 的服务暂不在本次范围内。

## 设计参考

借鉴行为设计，未复制第三方实现或引入其依赖：

- [LibreChat 自定义端点示例](https://github.com/danny-avila/LibreChat/blob/main/librechat.example.yaml)：手动模型与可选查询。
- [Cherry Studio 供应商地址处理](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/ai/utils/provider.ts)：区分基础地址和具体端点。
- [Vercel AI SDK 兼容适配器](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts)：正文/推理分离，JSON 和 SSE 独立解析。
- [One API 适配器契约](https://github.com/songquanpeng/one-api/blob/main/relay/adaptor/interface.go)：地址、鉴权、请求转换和响应处理职责分离；沿用现有轻量兼容层，以 One API 输出格式补充契约测试，不引入网关依赖。

验证入口：`source/local-service/test/relay-compatibility.test.js`、`model-transport.test.js`、`relay-ui.test.js`。测试只用临时档案与模拟密钥，未验证具体商业中转站。
