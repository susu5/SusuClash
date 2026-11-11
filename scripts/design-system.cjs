const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = 'app/design-system.css';
const FONT = '"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif';

function loadSystem(root = ROOT) {
  const markdown = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error('DESIGN.md 缺少设计变量 frontmatter');
  return { markdown, tokens: yaml.parse(match[1]), sidecar: JSON.parse(fs.readFileSync(path.join(root, '.impeccable/design.json'), 'utf8')) };
}

function digest(system) {
  const { shadows, motion, geometry, assets } = system.sidecar.extensions;
  return crypto.createHash('sha256').update(JSON.stringify({ tokens: system.tokens, shadows, motion, geometry, assets })).digest('hex');
}

function validateSystem(system) {
  const { tokens, sidecar } = system;
  const approval = sidecar.extensions?.approval;
  if (sidecar.schemaVersion !== 2 || approval?.status !== 'approved' || approval.version !== 'author-v3') throw new Error('设计规范必须使用已确认的 author-v3 基准');
  for (const [name, role] of Object.entries(tokens.typography || {})) {
    if (!/^\d+(\.\d+)?px$/.test(role.fontSize) || parseFloat(role.fontSize) < 12) throw new Error(`小字不得低于12px：${name}`);
    if (role.fontFamily !== FONT) throw new Error(`禁止更换系统字体栈：${name}`);
  }
  for (const name of ['caption', 'control', 'nav-label', 'field-label']) {
    if (tokens.typography?.[name]?.fontSize !== '12px') throw new Error(`小字角色必须统一12px：${name}`);
  }
  for (const name of ['panel', 'author-panel']) {
    if (tokens.rounded?.[name] !== '18px') throw new Error(`卡片圆角必须统一18px：${name}`);
  }
  for (const [name, component] of Object.entries(tokens.components || {})) {
    if (/panel|card/.test(name) && component.rounded !== '{rounded.panel}') throw new Error(`卡片必须引用共享18px圆角：${name}`);
  }
  for (const [, ref] of JSON.stringify(tokens).matchAll(/\{([\w.-]+)\}/g)) {
    let value = tokens;
    for (const part of ref.split('.')) value = value?.[part];
    if (value === undefined) throw new Error(`设计变量引用不存在：${ref}`);
  }
  for (const component of sidecar.components || []) {
    if (!tokens.components[component.refersTo]) throw new Error(`组件预览引用不存在：${component.refersTo}`);
  }
  if (approval.contractSha256 !== digest(system)) throw new Error('已确认的设计变量或材料参数发生变化；须按 DESIGN.md 的全局设计变更流程确认，不能直接重写校验值');
  return true;
}

function renderCss(system) {
  validateSystem(system);
  const t = system.tokens, e = system.sidecar.extensions;
  const lines = ['/* Generated from DESIGN.md + .impeccable/design.json. Run npm run design:build. */', '/* Approved author-v3: small text 12px; all cards 18px. */', ':root {'];
  for (const [key, value] of Object.entries(t.colors)) lines.push(`  --sc-color-${key}: ${value};`);
  for (const [key, role] of Object.entries(t.typography)) {
    for (const [property, cssName] of [['fontFamily', 'family'], ['fontSize', 'size'], ['fontWeight', 'weight'], ['lineHeight', 'line-height']]) {
      if (role[property] !== undefined) lines.push(`  --sc-type-${key}-${cssName}: ${role[property]};`);
    }
  }
  for (const [key, value] of Object.entries(t.rounded)) lines.push(`  --sc-radius-${key}: ${value};`);
  for (const [key, value] of Object.entries(t.spacing)) lines.push(`  --sc-space-${key}: ${value};`);
  for (const item of e.shadows) lines.push(`  --sc-shadow-${item.name}: ${item.value};`);
  for (const item of e.motion.filter(item => !item.name.includes('reduced'))) lines.push(`  --sc-motion-${item.name}: ${item.value};`);
  for (const [key, value] of Object.entries(e.geometry)) lines.push(`  --sc-${key}: ${value};`);
  lines.push('}');
  for (const theme of ['cat', 'fish', 'whale']) {
    lines.push(`${theme === 'cat' ? ':root, ' : ''}[data-theme="${theme}"] {`);
    for (const role of ['window', 'surface', 'text', 'muted', 'accent', 'nav-track', 'nav-selected', 'nav-text', 'nav-accent']) lines.push(`  --sc-color-${role}: var(--sc-color-${theme}-${role});`);
    for (const role of ['raised', 'inset', 'nav-inset', 'nav-raised']) lines.push(`  --sc-shadow-${role}: var(--sc-shadow-${theme}-${role});`);
    lines.push('}');
  }
  lines.push(`
.sc-page {
  color: var(--sc-color-text);
  font-family: var(--sc-type-body-family);
  font-size: var(--sc-type-body-size);
  line-height: var(--sc-type-body-line-height);
  padding: var(--sc-space-xl) var(--sc-space-page-inline);
}
.sc-page-title { font-size: var(--sc-type-page-title-size); font-weight: var(--sc-type-page-title-weight); line-height: var(--sc-type-page-title-line-height); }
.sc-caption, .sc-label { font-family: var(--sc-type-caption-family); font-size: var(--sc-type-caption-size); line-height: var(--sc-type-caption-line-height); color: var(--sc-color-muted); }
.sc-card, .sc-author-card, .sc-contact-card {
  font-family: var(--sc-type-body-family);
  font-size: var(--sc-type-body-size);
  line-height: var(--sc-type-body-line-height);
  border-radius: var(--sc-radius-panel);
  background: var(--sc-color-surface);
  color: var(--sc-color-text);
  padding: var(--sc-space-panel);
  box-shadow: var(--sc-shadow-raised);
}
.sc-author-card { display: flex; align-items: center; gap: 15px; }
.sc-author-mark { display: grid; place-items: center; flex: none; width: var(--sc-author-mark-size); height: var(--sc-author-mark-size); border-radius: var(--sc-radius-panel); color: var(--sc-color-accent); background: var(--sc-color-surface); box-shadow: var(--sc-shadow-inset); font-size: 24px; font-weight: 750; }
.sc-author-name { display: block; font-size: var(--sc-type-author-name-size); font-weight: var(--sc-type-author-name-weight); line-height: var(--sc-type-author-name-line-height); }
.sc-contact-card { padding: 2px 15px; }
.sc-copy-button {
  font-family: var(--sc-type-control-family);
  font-size: var(--sc-type-control-size);
  font-weight: var(--sc-type-control-weight);
  line-height: var(--sc-type-control-line-height);
  border: 0;
  border-radius: var(--sc-radius-compact-control);
  padding: 8px 12px;
  color: var(--sc-color-accent);
  background: var(--sc-color-surface);
  box-shadow: var(--sc-shadow-raised);
  cursor: pointer;
}
.sc-copy-button:hover:not(:disabled) { color: var(--sc-color-text); }
.sc-copy-button:active:not(:disabled) { box-shadow: var(--sc-shadow-inset); }
.sc-copy-button:focus-visible, .sc-nav > button:focus-visible { outline: 2px solid var(--sc-color-accent); outline-offset: 2px; }
.sc-copy-button:disabled { opacity: .5; cursor: default; box-shadow: none; }
.sc-nav {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex: none;
  box-sizing: border-box;
  height: var(--sc-nav-height);
  padding: 5px;
  border-radius: var(--sc-radius-navigation);
  background: var(--sc-color-nav-track);
  box-shadow: var(--sc-shadow-nav-inset);
}
.sc-nav > button {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  border: 0;
  border-radius: var(--sc-radius-nav-indicator);
  padding: 0;
  font-family: var(--sc-type-nav-label-family);
  font-size: var(--sc-type-nav-label-size);
  font-weight: var(--sc-type-nav-label-weight);
  line-height: var(--sc-type-nav-label-line-height);
  color: var(--sc-color-nav-text);
  background: transparent;
  cursor: pointer;
}
.sc-nav > button[aria-current="page"] { background: var(--sc-color-nav-selected); color: var(--sc-color-nav-accent); font-weight: 700; box-shadow: var(--sc-shadow-nav-raised); }
.sc-nav svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: reduce) { .sc-page *, .sc-nav, .sc-nav * { animation: none !important; transition: none !important; } }
`);
  return lines.join('\n') + '\n';
}

function checkSystem(root = ROOT) {
  const system = loadSystem(root);
  const expected = renderCss(system);
  if (fs.readFileSync(path.join(root, CSS_PATH), 'utf8') !== expected) throw new Error('共享样式与已确认规范不一致；运行 npm run design:build，不要手改生成文件');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  if (!agents.includes('DESIGN.md') || !agents.includes('design:check') || !agents.includes('12px') || !agents.includes('18px')) throw new Error('项目级设计约束缺失');
  const index = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  if (!index.includes('href="design-system.css"')) throw new Error('应用缺少共享设计变量入口');
  for (const asset of ['visual-contract.css', 'visual-contract.js']) {
    if (!index.includes(asset) || !fs.existsSync(path.join(root, 'app', asset))) throw new Error('客户端缺少统一呈现适配：' + asset);
  }
  if (index.includes('preview-bridge.js')) throw new Error('生产客户端不得加载隔离预览桥');
  const adapter = fs.readFileSync(path.join(root, 'app/visual-contract.css'), 'utf8');
  for (const [, value] of adapter.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
    if (Number(value) < 12) throw new Error('客户端适配不得引入低于12px的小字');
  }
  const reference = system.sidecar.extensions.approval.referenceImage;
  if (!fs.existsSync(path.join(root, reference))) throw new Error('已批准的视觉参照缺失');
  return system;
}

if (require.main === module) {
  try {
    const action = process.argv[2] || 'check';
    if (action === 'build') {
      fs.writeFileSync(path.join(ROOT, CSS_PATH), renderCss(loadSystem()), 'utf8');
      console.log('已生成 app/design-system.css（author-v3）');
    } else if (action === 'check') {
      checkSystem();
      console.log('PASS 已确认规范、设计配置、共享样式及项目约束一致：小字12px，卡片18px。');
      console.log('范围：规范一致性；页面视觉仍需按 AGENTS.md 做三主题对照验收。');
    } else throw new Error('用法：node scripts/design-system.cjs build|check');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { loadSystem, validateSystem, renderCss, digest, checkSystem };
