# 共享设计系统

当前有效合同为 **author-v3**：猫、鱼、鲸三主题，柔和拟物材料，直角外窗，既有动物资源，小字 12px、卡片圆角 18px。按钮、导航、外窗、弹层和圆形控件继续使用各自规格，不能全部改为18px。

| 文件 | 职责 |
| --- | --- |
| [`DESIGN.md`](../DESIGN.md) | YAML frontmatter 中的颜色、字体、圆角、间距和组件规范 |
| [`.impeccable/design.json`](../.impeccable/design.json) | 阴影、动效、几何尺寸和批准摘要 |
| [`app/design-system.css`](../app/design-system.css) | 从规范生成的 `--sc-*` 变量与 `sc-*` 组件，禁止手改 |
| [`reference/author-about-approved-v3.png`](reference/author-about-approved-v3.png) | 当前批准参照图 |
| [`installer.md`](installer.md) | MSI 内嵌界面的局部布局和状态规范，不改变客户端合同 |

客户端通过共享角色接入规范，不复制另一套颜色、字号或阴影。`app/visual-contract.css` 与 `app/visual-contract.js` 只适配呈现角色，不替换控件、事件或 API。

原生安装器由 `packaging/installer/generate-theme.cjs` 从同一合同生成主题代码，不另设主题数据。MSI 动效可以循环播放，圆环及最终结果必须由实际安装消息驱动；不能用计时器制造进度或成功。减少动态效果时使用原海报。

运行 `npm run design:build` 生成样式，运行 `npm run design:check` 和 `npm run test:design` 核对一致性。实际界面仍须按 [`AGENTS.md`](../AGENTS.md) 比较三主题、相同尺寸和状态，覆盖滚动、键盘焦点与减少动态效果；不能只凭令牌检查宣称完成视觉验收。

开发预览使用 `npm run preview:themes`，只使用独立内存数据。预览桥与模拟 API 不进入生产客户端。仓库 `images/` 中的首页、窗口、作者图是历史设计稿，不是当前版本截图，也不能覆盖现行合同。规范中的历史相对引用用于溯源，不作为公开构建输入。
