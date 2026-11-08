# 第三方组件与数据声明

SusuClash 自身源码采用 GNU GPL-3.0-only；以下随 Windows 安装包提供的第三方组件、数据及其许可相互独立。各许可原文和通知文件位于安装目录的 `licenses` 文件夹中。

| 组件或数据 | 来源与版本 | 许可及声明 |
| --- | --- | --- |
| Mihomo | [v1.19.33 官方源码和发行版](https://github.com/MetaCubeX/mihomo/tree/v1.19.33) | GPL-3.0；原文见 `licenses/Mihomo-GPL-3.0.txt`。对应版本源码也随本项目的 v0.1.8 GitHub Release 提供。 |
| Node.js | [v24.22.1 Windows x64 官方发行版](https://nodejs.org/dist/v24.22.1/) | Node.js 及其包含的组件的完整许可和通知见 `licenses/Node-LICENSE.txt`。 |
| Microsoft WebView2 SDK | [1.0.4078.44 官方 NuGet 包](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4078.44) | 许可和通知分别见 `licenses/WebView2-LICENSE.txt`、`licenses/WebView2-NOTICE.txt`。目标机器需要另行安装 WebView2 Runtime。 |
| yaml | [2.8.1 npm 包](https://www.npmjs.com/package/yaml/v/2.8.1) | ISC；原文见 `licenses/yaml-ISC.txt`。 |
| DB-IP Lite Country 和 ASN 数据库 | [Country Lite](https://db-ip.com/db/download/ip-to-country-lite)、[ASN Lite](https://db-ip.com/db/download/ip-to-asn-lite)，2026 年 11 月版 | CC BY 4.0；原文见 `licenses/DB-IP-CC-BY-4.0.txt`。**IP Geolocation by DB-IP, https://db-ip.com**。 |
| V2Fly GeoIP 数据 | [202611080027 官方发行数据](https://github.com/v2fly/geoip/releases/tag/202611080027) | CC BY-SA 4.0；项目许可见 `licenses/V2Fly-GeoIP-CC-BY-SA-4.0.txt`，许可正文见 `licenses/CC-BY-SA-4.0.txt`。该上游项目使用 DB-IP Lite 数据。 |
| V2Fly Domain List Community | [20261108011013 官方发行数据](https://github.com/v2fly/domain-list-community/releases/tag/20261108011013)；安装包将 `dlc.dat` 命名为 `geosite.dat` | MIT；原文及版权声明见 `licenses/V2Fly-GeoSite-MIT.txt`。 |

各发行输入的固定 SHA-256、下载地址和核验方式见 `packaging/release-dependencies-v0.1.8.json`。安装包不会包含个人订阅、配置、日志或浏览器资料。

本版 V2Fly 地理规则数据不一定包含 Mihomo Meta 专用的全部分类，使用相关规则的订阅可能需要兼容的规则数据。
