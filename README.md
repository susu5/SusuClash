# SusuClash v0.1.20

Windows x64 独立代理客户端，管理受控 Mihomo、订阅、线路和活动连接，并提供代理综合检查与 Codex 连接检查和可回滚修复。

## 本版修复

【连接】运行配置统一启用主动进程采集；内核未返回进程时，使用 Windows 本机 TCP 源端点与受控代理入口精确匹配补查，保留中文程序名。仅在同一连接存续期间复用结果，不按域名、目标网站或已复用端口猜测应用。进程退出、权限不足、非本机来源或归属不明确时仍显示未知；UDP 由内核识别。本页只显示经过内核的活动连接。

## 使用与边界

- 从本项目 Releases 下载 Windows x64 MSI，以当前用户安装；需要 Microsoft Edge WebView2 Runtime。默认目录为 `%LOCALAPPDATA%\Programs\ClashGlass`。
- 添加有效订阅或导入完整 YAML 并启用，然后管理模式、系统代理和线路。系统代理、固定代理与直连按实际使用路径分别检查。
- 自动 Codex 修复只在支持的本机桌面/CLI、受控系统代理路径内工作；独立请求可能消耗模型额度。保留原有认证，不自动登录、绕过证书或处理账号额度问题。
- 独立请求通过不等于当前桌面聊天恢复。当前缺少安全保存草稿并自动重开 Codex 桌面的接口，必要时仍显示当前窗口待确认。
- 不实现 TUN，不自动获取管理员权限；远程 proxy-providers/rule-providers 配置暂不支持。后台自动恢复与换线需分别启用。
- 用户数据保留于 `%LOCALAPPDATA%\ClashStandalone`，不随源码发布；卸载不会主动删除该目录。

## 开发

准备 Node.js 22 或更新版本，运行 `pnpm install --frozen-lockfile`；正式构建依赖来源和哈希在 `packaging/release-dependencies-v0.1.20.json`。构建、许可证及依赖准备见 [BUILDING.md](BUILDING.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

三主题视觉规范为 [DESIGN.md](DESIGN.md) author-v3：小字12px、卡片18px。运行 `npm run design:check`、`npm run test:design`；开发预览运行 `npm run preview:themes`，只使用独立内存示例数据。

本源码快照的 package.json、app 与 src 均与 v0.1.20 MSI 载荷逐字节对应；公开文档精简了本地开发与检测记录。对应关系见 [SOURCE-MAPPING.md](SOURCE-MAPPING.md)。项目源码为 GPL-3.0-only。
