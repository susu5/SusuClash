# 构建 SusuClash v0.1.20

源码不包含预编译运行时、用户数据或本地检测记录。生产代码和资源对应 v0.1.20 MSI；公开说明文档与本地交付说明分别维护。

## 工具与依赖

Windows x64、Node.js 22+、pnpm/npm、Python 3、WiX Toolset（含 WixToolset.UI.wixext）、.NET Framework x64 C# 编译器；运行客户端还需要 Microsoft Edge WebView2 Runtime。

运行 `pnpm install --frozen-lockfile`（或 `npm install --ignore-scripts`）。YAML 依赖固定为2.8.1。所有发行二进制和数据从 `packaging/release-dependencies-v0.1.20.json` 指定来源准备到独立依赖目录，按清单核对SHA-256。打包脚本还校验yaml锁文件完整性、许可原文、GeoSite分类兼容性及共享样式。

依赖目录文件名：node-official.exe、NODE-LICENSE、mihomo-official.exe、geoip.dat、geosite.dat、dbip-country-lite-2026-11.mmdb、dbip-asn-lite-2026-11.mmdb、microsoft.web.webview2.1.0.4078.44.nupkg、yaml-2.8.1.tgz。Node来自24.22.1官方Windows x64发行包，Mihomo来自v1.19.33官方compatible发行包；不要使用未核验的本机安装副本。相关许可在licenses/中。

## 检查与打包

```powershell
npm run design:check
npm run test:design
python packaging/build_msi_release.py --deps C:\release-deps --work-dir C:\release-work --output C:\release-output\SusuClash-Setup-x64-v0.1.20.msi
```

输出文件不得预先存在。打包脚本从源码编译WebView2宿主，使用清单指定依赖，不下载、不安装、不修改系统代理，也不为MSI签名。安装范围为当前用户，保留既有安装目录和升级标识。

单元回归运行 `node --test test/*.test.mjs`。部分Windows原生/内核测试需要先准备runtime/mihomo.exe、runtime/地理数据库和runtime/webview2/宿主；缺少依赖的失败或跳过不能视为已验证。开发预览使用 `npm run preview:themes`，不修改真实代理或调用模型请求。
