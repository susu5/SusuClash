# 运行依赖

公开源码在本目录只保留 `geodata.json`，不包含预编译 Node、Mihomo、WebView2 宿主、SDK 二进制或地理数据库。MSI 会部署其所需运行文件；不要把本地缓存或用户数据直接提交到仓库。

v0.1.24 客户端运行依赖沿用 v0.1.23：Node.js 24.22.1、Mihomo v1.19.33、固定地理规则数据和 WebView2 宿主。应用窗口仍需要系统安装 Microsoft Edge WebView2 Runtime；SDK 或 WebView2Loader.dll 不能代替该运行时。

按 [`packaging/release-dependencies-v0.1.24.json`](../packaging/release-dependencies-v0.1.24.json) 和 [`BUILDING.md`](../BUILDING.md) 准备经核验的输入。固定宿主的公开取得方式与哈希也以构建说明为准；自行重编译同一源码不保证得到相同二进制字节。

本版 Release 提供固定宿主构建输入 `SusuClashWindow-x64-v0.1.24.exe`（27,648 字节），SHA-256 为 `e46640b1a79f13e7a173d2d5273a9064cec97c799b6e1883233e383a570eaebd`；也可从本版 MSI 纯提取同字节的 `runtime/webview2/SusuClashWindow.exe`。按 BUILDING 改名为 `SusuClashWindow.exe` 放入 `--installer-deps`，无需未发布版本的文件。

新版 MSI 的 WiX DTF 7.0.0 仅用于安装期内嵌界面和只读状态回执，不是新增的客户端代理组件。安装器输入、上游源码、许可证与数据许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
