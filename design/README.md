# 共享设计系统

DESIGN.md的YAML frontmatter维护颜色、字体、圆角、间距与组件；.impeccable/design.json维护阴影、动效、几何尺寸和批准摘要。app/design-system.css由scripts/design-system.cjs生成，禁止手改。

三主题为cat、fish、whale；author-v3要求小字12px、卡片18px。按钮、导航、外窗及弹层使用各自固定形状。公开参考图为reference/author-about-approved-v3.png。

运行npm run design:build生成样式，npm run design:check及npm run test:design核对一致性。实际界面仍须按AGENTS.md同尺寸对照三主题。开发预览使用npm run preview:themes，数据只存在预览进程内存中，不注入生产客户端。
