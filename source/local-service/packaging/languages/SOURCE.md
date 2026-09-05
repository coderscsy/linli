# 简体中文安装语言

英文语言来自 Inno Setup 6.5 的官方 Default.isl，原样保存为 English.isl，许可证为 INNO-LICENSE.txt。两种语言均使用仓库固定副本，避免构建时加载外部未审计文件。

- 来源：https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation
- 固定提交：1ff90acc4ed4aee82b1cda43253243deee3daed4
- 上游文件：ChineseSimplified.isl，适配 Inno Setup 6.5.0+。
- 授权：MIT，原许可证保存在 LICENSE.txt；语言文件保留作者署名。
- 构建使用仓库内固定副本，复制到审计 stage 的 installer 目录，不从构建机器的语言目录或网络临时加载。
- OliviaSoul 专用说明位于 OliviaSoul.iss 的 Messages 节。
