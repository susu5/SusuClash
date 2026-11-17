# 构建 SusuClash v0.1.26

本仓库提供客户端、Netfix、原生窗口和 MSI 安装器源码。运行依赖与安装包通过 Release 单独提供，用户订阅、认证、配置和运行日志不进入源码。

v0.1.26 是预发布版，包含备用节点编辑与启动修复，保留已知的安装结果／启动提示误判风险。客户端和MSI产品版本为0.1.26；已发布MSI复用经过核验的既有安装组件，未重新编译，程序集版本仍为0.1.25.0。下文的常规公开构建会重新编译安装器，与发行包采用的组件复用路径不同，不承诺产生同一组件或MSI字节。对应关系和组件哈希见 [SOURCE-MAPPING.md](SOURCE-MAPPING.md)，固定输入见 `packaging/release-dependencies-v0.1.26.json`。

## 环境与设计检查

- Windows x64、Python 3.9 或更新版本、Node.js 22 或更新版本；发布输入固定为 Node.js 24.22.1。
- .NET Framework C# 编译器：`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`。
- WiX Toolset 7.0.0 与同版 `WixToolset.UI.wixext`，`wix` 在 PATH 中。原生 DTF 打包使用下面单独核验的 NuGet 包。遵守随组件提供的许可证和维护协议。
- 运行客户端还需 Microsoft Edge WebView2 Runtime。SDK并不包含或安装该运行时。

在独立工作目录准备源码依赖后运行：

```powershell
npm install --ignore-scripts --package-lock=false
npm run design:check
npm run test:design
```

如使用 pnpm，可用 `pnpm install --frozen-lockfile --ignore-scripts`。设计基准为 `DESIGN.md` author-v3：小字12px、卡片18px。共享CSS由规范生成，不要手改；变量检查不代替三主题截图与交互验收。

## 准备发行输入

示例将客户端依赖放在 `C:\susu-build\deps`，安装器输入放在 `C:\susu-build\installer-deps`。两个目录都应独立于正在使用的客户端数据目录。逐项核对依赖清单中的来源、SHA-256；`yaml` 还须匹配锁文件的 SHA-512。打包脚本不下载依赖，不读取真实用户配置，也不执行安装。

| `--deps` 中的文件 | 获取方式 |
| --- | --- |
| `node-official.exe`、`NODE-LICENSE` | 从清单指定的官方 Node.js 24.22.1 Windows x64 ZIP提取 `node.exe` 和 `LICENSE` 后改名。 |
| `mihomo-official.exe` | 从清单指定的 Mihomo v1.19.33 compatible Windows x64 ZIP提取并改名。 |
| `geoip.dat`、`geosite.dat` | 使用清单固定的 V2Fly GeoIP 与 MetaCubeX GeoSite 字节；GeoSite 还需匹配 `runtime/geodata.json`。 |
| `dbip-country-lite-2026-11.mmdb`、`dbip-asn-lite-2026-11.mmdb` | 按清单下载DB-IP归档并解压，核对解压后的哈希。 |
| `microsoft.web.webview2.1.0.4078.44.nupkg`、`yaml-2.8.1.tgz` | 从清单指定的 NuGet、npm地址取得原始归档。 |

| `--installer-deps` 中的文件 | 获取方式 |
| --- | --- |
| `wixtoolset.dtf.windowsinstaller.7.0.0.nupkg` | 清单指定的官方 NuGet 包，保持原始字节。 |
| `wixtoolset.dtf.customaction.7.0.0.nupkg` | 清单指定的官方 NuGet 包，保持原始字节。 |
| `wix-b8977d6-source.tar.gz` | 清单指定的官方固定源码提交；MSI把该对应源码放入 `licenses/`，不执行归档内容。 |
| `SusuClashWindow.exe` | 使用本版 Release 中公开的宿主输入，或从本版MSI纯解包提取，方法见下文。 |

`licenses/` 中的全部许可原文必须保留。打包器核对已固定的许可哈希，不接受用其他版本的同名文件替换。

## 可公开取得的窗口宿主输入

本版更新客户端备用页与启动逻辑，原生窗口宿主源码和固定字节不变。宿主作为v0.1.26 Release的独立构建输入公开，不需要任何未发布版本的本机目录。

从 [v0.1.26 预发布](https://github.com/susu5/SusuClash/releases/tag/v0.1.26) 下载 `SusuClashWindow-x64-v0.1.26.exe`，核对下面哈希，复制到 `--installer-deps` 目录并改名 `SusuClashWindow.exe`。不要为了准备构建输入运行它。

```text
e46640b1a79f13e7a173d2d5273a9064cec97c799b6e1883233e383a570eaebd
```

也可在独立目录用 WiX 的纯解包功能处理本版MSI（不使用 `msiexec /i`）：

```powershell
wix msi decompile -x C:\susu-build\extracted C:\susu-build\SusuClash-Setup-x64-v0.1.26.msi -o C:\susu-build\extracted.wxs
```

在提取出的 `File` 目录按 `extracted.wxs` 的 `File` 记录定位 `runtime/webview2/SusuClashWindow.exe` 对应文件，复制为上述输入并核对哈希。独立 Release 资产提供同一字节，通常无需此替代步骤。

宿主源码是 `src/window-host.cs`，本版源码SHA-256：

```text
42420164237d2e73b2fce8d19b7eaf9e3e49c077c66fc667b2c5c1dac63a0cf7
```

若用于自己的源码构建，可以按下节重新编译；新编译产物的PE元数据可能不同。发行打包入口会严格拒绝与 `buildProducts` 不同的二进制；自己的发行版需审核自己的产物并更新其构建清单，不能把不同字节称为官方输入。

## 构建 MSI

在仓库根目录运行，输出文件必须尚不存在：

```powershell
python packaging\build_msi_release.py `
  --deps C:\susu-build\deps `
  --installer-deps C:\susu-build\installer-deps `
  --work-dir C:\susu-build\work `
  --output C:\susu-build\output\SusuClash-Setup-x64-v0.1.26.msi
```

构建器校验输入与许可，用真实 Mihomo 检查 GeoSite 兼容性，再从当前规范生成原生主题、重新编译内嵌界面和只读重启状态动作。MSI保留既有升级族、安装目录与数据目录；不签名、不运行生成的MSI、不改系统代理。

此常规入口会按当前包版本生成安装器程序集0.1.26.0；发行MSI中的组件则是未重新编译的0.1.25.0。发行时复用路径逐项核对了实际MSI原生流、内含托管程序集与未变更的源码／资源，不把新编译产物冒充旧字节。本版MSI提供这些组件供纯解包核验，不需要取得未发布旧版的本机目录。安装器的当前产品身份从MSI会话读取，不能将组件程序集版本当作应用产品版本。

公开说明文档经过整理，编译器、组件版本、PE与MSI元数据也可能变化，因此不承诺逐字节重现已发布的组件或整个MSI。重新构建仍须独立完成载荷、许可、设计和安装消息验证；安装结果／启动提示的已知风险不会因重新编译而自动消失。

## 从源码编译客户端宿主

从固定 WebView2 SDK NuGet 包提取以下文件到 `runtime\webview2`：

| SDK 内路径 | 目标文件名 |
| --- | --- |
| `lib/net462/Microsoft.Web.WebView2.Core.dll` | `Microsoft.Web.WebView2.Core.dll` |
| `lib/net462/Microsoft.Web.WebView2.WinForms.dll` | `Microsoft.Web.WebView2.WinForms.dll` |
| `runtimes/win-x64/native/WebView2Loader.dll` | `WebView2Loader.dll` |
| `LICENSE.txt`、`NOTICE.txt` | 保留原文件名 |

```powershell
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /out:runtime\webview2\SusuClashWindow.exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:runtime\webview2\Microsoft.Web.WebView2.Core.dll /reference:runtime\webview2\Microsoft.Web.WebView2.WinForms.dll src\window-host.cs
```

开发运行另需准备 `runtime\mihomo.exe` 及规则数据、Node运行时或本机Node环境。运行 `Start-Clash-Glass.cmd` 前确认使用独立测试数据，避免覆盖真实配置。

## 测试与原生安装器验证

```powershell
node --test test/*.test.mjs
powershell -NoProfile -File qa\test-installer-model-v026.ps1
```

单元测试使用临时目录。内核、窗口及原生属性相关用例需要对应运行依赖和Windows权限；跳过项不能视作通过。浏览器预览使用 `scripts/preview-client.cjs` 的内存桥，不能加载到生产客户端。

备用编辑器的可复用检查为 `qa/check-backup-editor-v026.cjs` 和 `qa/check-backup-editor-matched-v026.cjs`。准备Playwright及浏览器后，可安装公开的 `playwright` 模块，或通过 `SUSU_PLAYWRIGHT_MODULE` 指定模块位置；`SUSU_CHROME` 可指定已安装浏览器，否则使用Playwright浏览器。回环访问也需可用。同状态对照还需自己的旧版基线报告及截图，可用 `SUSU_BACKUP_BASELINE_REPORT` 指定该报告，不附带开发者本机的基线产物。

公开QA只适配依赖／浏览器／报告路径与输出目录创建，不属于MSI功能源的逐字节对应范围。包内检查使用 `qa/check-packaged-client-v026.cjs`，由解包目录中的 `runtime/node/node.exe` 运行，以 `--payload` 或 `SUSU_PACKAGE_PAYLOAD` 指定自己的临时载荷路径；`--real-core` 与 `--ui` 分别启用实际内核与浏览器场景。可用 `SUSU_PACKAGE_MANIFEST` 指定独立验证的载荷报告；报告存在时仍严格核对MSI、载荷路径与运行二进制哈希。未提供独立报告时，运行冒烟不能等同于已经核验发行MSI的来源。不能把缺失的本机发布证据当作测试成功。

本版发行前完整复测414项：411通过、0失败、3项条件跳过；342个载荷文件和38项安装消息模型核对通过。备用页三主题两尺寸交互与实际Mihomo新实例端口复用另行检查。这些结果不表示已经执行真实产品升级、写入真实系统代理或验证用户原Codex任务。

制作MSI后，工作目录 `public-msi-build-*/installer/installer-build.json` 绑定原生组件、资源和源码哈希。下面默认只构建随机测试包并做不执行安装序列的初始化烟测；Python参数显式使用自己的安装路径：

```powershell
powershell -NoProfile -File qa\test-installer-native.ps1 -Receipt C:\susu-build\work\public-msi-build-EXAMPLE\installer\installer-build.json -Python C:\Python\python.exe
```

只有在隔离测试环境明确加 `-RunMarker` 才会执行独立随机产品族、单标记文件的安装和清理。不得将该工具用于真实 SusuClash 产品或真实数据目录。安装后启动提示仍有已知风险，标记包测试不能替代真实用户升级与应用启动验证。
