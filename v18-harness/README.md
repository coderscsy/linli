# v18 Harness

这是不依赖主工程目录结构的 v18 四阶段 Harness。

快速入口：

```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
.\run-live.ps1 -Person "示例对象" -Letter ".\incoming.txt" -OutFile ".\reply.txt"
```

完整配置、档案格式、回归运行和连续状态传递见 [`../docs/HARNESS.md`](../docs/HARNESS.md)。

请勿提交 API 密钥、`_probe/` 产物或真实私密往来。
