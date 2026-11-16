# v0.1.24 源码对应关系

本次公开同步对应 **v0.1.24 预发布版**，不是新的功能修复版本。

对应安装包：`SusuClash-Setup-x64-v0.1.24.msi`，75,469,040 字节，SHA-256：

```text
06274d125b32eebabf63d56b45d6920275ce8cc960f1c1d0223362fe4f80adcd
```

## 功能源与编译输入

`package.json`、`app/`、`src/`、启动与恢复入口、运行数据清单和本版依赖清单保留经过 MSI 逐文件核验的功能源与生产资源。客户端与 Netfix 逻辑沿用 v0.1.23；安装后结果／启动提示的已知判定问题没有在本次同步中修复。

关键生产文件、安装器输入与设计合同的逐文件 SHA-256 见仓库根目录 [PUBLIC-SOURCE-SHA256.json](PUBLIC-SOURCE-SHA256.json)。该清单不包含经过公开精简的文档自身，避免将文档对应关系误当成功能源逐字节对应，亦避免自引用哈希。

安装器 C# 源码、主题生成器和构建脚本是编译输入，不能把它们与 MSI 中的已编译 DLL 混称为同一组文件。最终 MSI 内嵌的安装器组件为：

| 组件 | SHA-256 |
| --- | --- |
| `SusuClash.InstallerUI.dll` | `a87fdb536759796b813f6021213058ab2b508a02fe63a2bbcd368dfbecb6eac1` |
| `SusuClash.InstallerStateCA.dll` | `bd3b570cb0e1b9ddfd77aecdaa2e1b3b4119bf9d67cc09dc5786ddcc1ada663f` |

安装器源码位于 `packaging/installer/`；其构建输入和许可说明见 [BUILDING.md](BUILDING.md)、[依赖清单](packaging/release-dependencies-v0.1.24.json) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。构建脚本、锁文件、测试与可复用 QA 源码随版公开，不附带本机测试产物或预编译运行时。

本版 Release 另提供固定宿主构建输入 `SusuClashWindow-x64-v0.1.24.exe`（27,648 字节），SHA-256 为 `e46640b1a79f13e7a173d2d5273a9064cec97c799b6e1883233e383a570eaebd`。它与本版 MSI 中的 `runtime/webview2/SusuClashWindow.exe` 字节相同；也可从本版 MSI 纯提取。对应 `src/window-host.cs` 的 SHA-256 为 `42420164237d2e73b2fce8d19b7eaf9e3e49c077c66fc667b2c5c1dac63a0cf7`。构建时按 BUILDING 改名并放入 `--installer-deps`，不依赖未公开版本或个人机器缓存。

## 公开文档与设计合同

README、BUILDING、AGENTS、PRODUCT、运行依赖与设计使用说明已按公开仓库精简，删除个人机器路径和本地运行历史。因此这些公开文档不承诺与 MSI 内说明文件逐字节相同。

`DESIGN.md` 的源变量、`.impeccable/design.json` 的参数及批准合同摘要、共享 CSS 和有效批准参照保持不变。主分支 `images/` 的旧图保留为历史设计稿，不能当作当前界面截图或新批准合同。

## 验证范围

客户端回归为355通过、0失败、3项条件跳过；安装消息模型38项通过，MSI解包339文件核对通过。正式安装组件在隔离随机产品族、单标记文件的真实 MSI 流程中核验；正常流程使用右上角关闭，没有据此宣称完成后启动路径已修复。测试证据不代表每台用户机器、真实网络或 Codex 原会话都已通过验证。

此对应关系不承诺 MSI 可按字节重构建：编译器、宿主输入与 MSI 元数据可能影响二进制字节，公开说明文档也经过精简。请按本版公开校验清单区分功能源、编译输入与文档，完整构建步骤以 BUILDING 为准。
