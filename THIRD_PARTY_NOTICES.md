# 第三方组件与数据声明

SusuClash 自身源码采用 GNU GPL-3.0-only；以下随 Windows 安装包提供的第三方组件、数据及其许可相互独立。各许可原文和通知文件位于安装目录的 `licenses` 文件夹中。

| 组件或数据 | 来源与版本 | 许可及声明 |
| --- | --- | --- |
| Mihomo | [v1.19.33 官方源码和发行版](https://github.com/MetaCubeX/mihomo/tree/v1.19.33) | GPL-3.0；原文见 `licenses/Mihomo-GPL-3.0.txt`。对应版本源码也随本项目的 v0.1.26 预发布提供。 |
| Node.js | [v24.22.1 Windows x64 官方发行版](https://nodejs.org/dist/v24.22.1/) | Node.js 及其包含的组件的完整许可和通知见 `licenses/Node-LICENSE.txt`。 |
| Microsoft WebView2 SDK | [1.0.4078.44 官方 NuGet 包](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4078.44) | 许可和通知分别见 `licenses/WebView2-LICENSE.txt`、`licenses/WebView2-NOTICE.txt`。目标机器需要另行安装 WebView2 Runtime。 |
| yaml | [2.8.1 npm 包](https://www.npmjs.com/package/yaml/v/2.8.1) | ISC；原文见 `licenses/yaml-ISC.txt`。 |
| WiX Deployment Tools Foundation | [WiX 7.0.0 源码提交 b8977d6](https://github.com/wixtoolset/wix/tree/b8977d6f88e7b68e000bac226a2814f236770570)，DTF WindowsInstaller 与 CustomAction 官方 NuGet 包 | Copyright (c) .NET Foundation and contributors. MSI 内嵌界面使用未修改的 DTF 程序集及 SfxCA 加载器，客户端不加载。MS-RL 原文见 `licenses/WiX-MS-RL.txt`，发行包附带的维护协议见 `licenses/WiX-OSMF-EULA.txt`，对应完整源码见 `licenses/wix-b8977d6-source.tar.gz`。自有安装界面源文件与这些组件相互独立。 |
| DB-IP Lite Country 和 ASN 数据库 | [Country Lite](https://db-ip.com/db/download/ip-to-country-lite)、[ASN Lite](https://db-ip.com/db/download/ip-to-asn-lite)，2026 年 11 月版 | CC BY 4.0；原文见 `licenses/DB-IP-CC-BY-4.0.txt`。**IP Geolocation by DB-IP, https://db-ip.com**。 |
| V2Fly GeoIP 数据 | [202611080027 官方发行数据](https://github.com/v2fly/geoip/releases/tag/202611080027) | CC BY-SA 4.0；项目许可见 `licenses/V2Fly-GeoIP-CC-BY-SA-4.0.txt`，许可正文见 `licenses/CC-BY-SA-4.0.txt`。该上游项目使用 DB-IP Lite 数据。 |
| MetaCubeX GeoSite | [meta-rules-dat 官方完整发行数据](https://github.com/MetaCubeX/meta-rules-dat/releases/tag/latest)，2026-11-09；固定资产 ID、SHA-256 和来源见本版依赖清单 | GPL-3.0；原文见 `licenses/MetaCubeX-GeoSite-GPL-3.0.txt`。构建脚本与来源见 [上游源码快照](https://github.com/MetaCubeX/meta-rules-dat/tree/4178770badecb1b349fbcd62c737e0d7a2079729)。 |
| V2Fly Domain List Community（GeoSite 构建输入） | [上游域名表](https://github.com/v2fly/domain-list-community)，由 MetaCubeX 构建流程使用 | MIT；原文及版权声明见 `licenses/V2Fly-GeoSite-MIT.txt`。 |

各发行输入的固定 SHA-256、下载地址和核验方式见 `packaging/release-dependencies-v0.1.26.json`。安装包不会包含个人订阅、配置、日志或浏览器资料。

MetaCubeX GeoSite 的其他上游域名表及转换工具来源见其 README 与构建脚本，包括 V2Fly Domain List Community、Loyalsoldier/domain-list-custom、dnsmasq-china-list、GFWList 等。本版沿用 v0.1.20 的已核验运行依赖和数据，GeoSite、GeoIP、Country 和 ASN 数据及其来源保持不变。
