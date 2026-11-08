# 本地构建说明

本仓库只包含项目源码、界面资源和示例设计图，不包含 Node.js、Mihomo、WebView2 SDK 或地理规则文件的二进制副本。当前尚未提供一键下载依赖或现成发布包；请在独立测试环境中自行准备下列文件并确认其来源和许可。不要把真实订阅、运行时配置、日志或浏览器数据放进仓库。

## 依赖与工具

- Windows x64，已安装 Microsoft Edge WebView2 Runtime。
- Node.js 22 或更新版本和 npm（已测试的本地运行时为 Node.js 24.22.1）。
- Python 3、WiX Toolset 4 或更新版本及 `WixToolset.UI.wixext`（仅在制作 MSI 时需要）。
- .NET Framework C# 编译器（Windows x64 的 `Framework64\v4.0.30319\csc.exe`）。
- WebView2 SDK [Microsoft.Web.WebView2 1.0.4078.44](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4078.44)；遵循其许可及通知要求。
- Windows x64 的 [Mihomo 内核](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)及所需的地理规则文件。开发环境曾使用 Mihomo 1.19.33；各地理数据库应核对各自来源和授权，不能假定它们拥有相同许可证。

## 准备源码依赖

在项目根目录执行：

```powershell
npm install --ignore-scripts
```

项目的 YAML 解析器版本为 `yaml@2.8.1`，依赖信息记录在 `package.json` 和 `pnpm-lock.yaml` 中。如果使用 pnpm，可以运行 `pnpm install --frozen-lockfile`。

## 准备窗口宿主

从 Microsoft 官方渠道获取并解压上面指定的 NuGet SDK 包，在项目内创建 `runtime\webview2`，复制 SDK 包中的以下文件：

| SDK 包路径 | 项目中的目标路径 |
| --- | --- |
| `lib\net462\Microsoft.Web.WebView2.Core.dll` | `runtime\webview2\Microsoft.Web.WebView2.Core.dll` |
| `lib\net462\Microsoft.Web.WebView2.WinForms.dll` | `runtime\webview2\Microsoft.Web.WebView2.WinForms.dll` |
| `runtimes\win-x64\native\WebView2Loader.dll` | `runtime\webview2\WebView2Loader.dll` |
| `LICENSE.txt` 和 `NOTICE.txt` | `runtime\webview2\` 下的同名文件 |

在项目根目录编译宿主：

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /out:runtime\webview2\SusuClashWindow.exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:runtime\webview2\Microsoft.Web.WebView2.Core.dll /reference:runtime\webview2\Microsoft.Web.WebView2.WinForms.dll src\window-host.cs
```

## 准备内核和规则

自行获取符合许可要求的 Windows x64 Mihomo 内核并放置为 `runtime\mihomo.exe`。根据自己的使用场景准备 `runtime\geoip.dat`、`runtime\geosite.dat`、`runtime\Country.mmdb` 和 `runtime\ASN.mmdb`。制作 MSI 的脚本会检查以上四个文件均存在；仓库不指定这些数据的来源或再分发授权。

如需制作现有 MSI，打包脚本还要求将自行准备的 Windows x64 Node 运行时置于 `runtime\node\`，包含 `node.exe` 和它所需的 DLL。完成所有依赖和许可核查后，在项目根目录运行：

```powershell
python packaging\build_msi_v3.py
```

输出位于本地 `outputs\candidate\`。现有打包脚本不会替你取得依赖或核查第三方再分发授权，也不会为安装包签名。

## 隔离测试

准备好对应测试依赖后，可在项目根目录运行：

```powershell
node --test test/*.test.mjs
```

原生窗口和内核相关测试依赖已准备的组件；缺失时不代表测试已通过。测试应使用临时数据，不要使用真实订阅、账户配置或系统代理状态。
