/* Isolated UI regression for application identity data. Never touches user settings. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {startPreview} = require('../scripts/preview-client.cjs');
const {createFixture} = require('./preview-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs/working/connection-identity-ui-2026-11-11');
const LOG = path.join(ROOT, 'outputs/log/connection-identity-ui-2026-11-11.json');
const longApp = 'long-process-name-for-a-desktop-application-with-many-components-and-a-very-long-generated-executable-name-example.exe';
const longHost = 'very-long-domain-name-for-an-active-application-connection-with-a-long-route-and-scroll-validation.example.test:443';

function connections() {
  const now = Date.now();
  const make = (id, app, host, processSource = 'core') => ({id, app, address: host, processSource, route: '日常代理 → 香港 02 · 低延迟', startedAt: new Date(now - 65000).toISOString(), upload: 17200, download: 281000});
  return [
    ...Array.from({length: 20}, (_, i) => make('chrome-' + i, 'chrome.exe', i === 19 ? longHost : 'browser-' + i + '.example.test:443', i % 2 ? 'windows' : 'core')),
    make('codex', 'codex.exe', 'api.example.test:443', 'windows'),
    make('node', 'node.exe', 'tool.example.test:443', 'windows'),
    make('long-app', longApp, longHost),
    make('unknown', '未知应用', 'unidentified.example.test:443', 'unknown'),
    ...Array.from({length: 18}, (_, i) => make('app-' + i, 'example-process-' + i + '.exe', 'app-' + i + '.example.test:443'))
  ];
}

async function inspect(page, label) {
  const metrics = await page.evaluate(() => {
    const visible = element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !element.closest('[hidden],.sr-only,.visually-hidden,.doctor-legacy-state,.check-legacy-source') && element.namespaceURI !== 'http://www.w3.org/2000/svg';
    };
    const elements = [...document.querySelectorAll('body *')].filter(visible);
    const tabs = document.querySelector('.tabs').getBoundingClientRect();
    const main = document.querySelector('.app main');
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      smallText: elements.filter(element => parseFloat(getComputedStyle(element).fontSize) < 12).map(element => ({tag: element.tagName, class: String(element.className), size: getComputedStyle(element).fontSize})),
      badCards: elements.filter(element => element.dataset.scSurface === 'card' && getComputedStyle(element).borderTopLeftRadius !== '18px').map(element => ({class: String(element.className), radius: getComputedStyle(element).borderRadius})),
      navigationReachable: tabs.top >= 0 && tabs.bottom <= innerHeight + 1 && tabs.width > 0,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      mainScrollable: main.scrollHeight > main.clientHeight,
      visibleDialogs: document.querySelectorAll('dialog[open]').length
    };
  });
  assert.equal(metrics.horizontalOverflow, false, label + ' horizontal overflow');
  assert.deepEqual(metrics.smallText, [], label + ' text below 12px');
  assert.deepEqual(metrics.badCards, [], label + ' card radius');
  assert.equal(metrics.navigationReachable, true, label + ' navigation');
  assert.equal(metrics.reducedMotion, true, label + ' reduced motion');
  return {label, ...metrics};
}

function compareAppBaseline() {
  const working = path.join(ROOT, 'outputs/working');
  const folders = fs.readdirSync(working).filter(name => name.startsWith('release-v0.1.19-extracted-'));
  if (folders.length !== 1) return {available: false};
  const baseline = path.join(working, folders[0], 'LocalApp/Programs/ClashGlass/app');
  if (!fs.existsSync(baseline)) return {available: false};
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const names = fs.readdirSync(path.join(ROOT, 'app')).filter(name => /\.(css|js|html)$/.test(name));
  const changed = names.filter(name => !fs.existsSync(path.join(baseline, name)) || digest(path.join(ROOT, 'app', name)) !== digest(path.join(baseline, name)));
  assert.deepEqual(changed, [], 'frontend assets unchanged from v0.1.19 payload');
  return {available: true, comparedFiles: names.length, changed};
}

async function run() {
  fs.mkdirSync(OUT, {recursive: true});
  fs.mkdirSync(path.dirname(LOG), {recursive: true});
  const baseline = compareAppBaseline();
  const preview = await startPreview();
  const browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-proxy-server']});
  const results = [], screenshots = [], errors = [];
  try {
    for (const theme of ['cat', 'fish', 'whale']) {
      for (const viewport of [{width: 360, height: 600}, {width: 460, height: 820}]) {
        const size = viewport.width + 'x' + viewport.height;
        const fixture = preview.fixtures[theme] = createFixture(theme);
        fixture.state.connections = connections();
        const context = await browser.newContext({viewport, reducedMotion: 'reduce', deviceScaleFactor: 1});
        const page = await context.newPage();
        page.on('pageerror', error => errors.push({theme, size, error: error.message}));
        page.on('response', response => {if (response.status() >= 400 && !response.url().endsWith('api/connections')) errors.push({theme, size, status: response.status(), path: new URL(response.url()).pathname});});
        const capture = async name => {
          const file = theme + '-' + size + '-' + name + '.png';
          await page.screenshot({path: path.join(OUT, file)}); screenshots.push(file);
        };
        const nav = async name => {
          await page.locator('.tabs [data-open="' + name + '"]').click();
          await page.locator('[data-page="' + name + '"]').waitFor({state: 'visible'});
          await page.waitForTimeout(60);
        };
        await page.goto(preview.url + 'client/' + theme + '/');
        await page.locator('.doctor-home:not([hidden])').waitFor();
        await page.waitForFunction(() => !!ui.core && ui.groups.length > 0);
        for (const name of ['home', 'lines', 'settings']) {
          await nav(name); results.push(await inspect(page, theme + ' ' + size + ' ' + name)); await capture(name);
        }
        await page.locator('.settings-author-entry').click();
        await page.locator('[data-page="about"]').waitFor({state: 'visible'});
        results.push(await inspect(page, theme + ' ' + size + ' about')); await capture('about');
        await nav('connections');
        await page.locator('#connectionList [data-app="chrome.exe"]').waitFor();
        assert.equal(await page.locator('#connectionCount').innerText(), '42 条当前连接');
        assert.equal(await page.locator('#connectionList [data-app]').count(), 23);
        const metrics = await inspect(page, theme + ' ' + size + ' connections');
        assert.equal(metrics.mainScrollable, true, 'many applications scroll'); results.push(metrics); await capture('connections');
        await page.evaluate(() => {const main = document.querySelector('.app main'); main.scrollTop = main.scrollHeight;});
        assert(await page.locator('#connectionList [data-app="example-process-17.exe"]').isVisible());
        await page.locator('#connectionSearch').fill('codex');
        assert.equal(await page.locator('#connectionList [data-app]').count(), 1);
        assert.equal(await page.locator('#connectionList [data-app]').getAttribute('data-app'), 'codex.exe');
        await page.locator('#connectionSearch').fill('unidentified.example.test');
        assert.equal(await page.locator('#connectionList [data-app]').getAttribute('data-app'), '未知应用');
        await page.locator('#connectionSearch').fill('');
        const opener = page.locator('#connectionList [data-app="chrome.exe"]');
        await opener.focus(); await opener.press('Enter');
        await page.locator('.secondary-connections-dialog[open]').waitFor();
        assert.equal(await page.locator('.secondary-connection-row').count(), 20);
        const sheet = await page.locator('.secondary-connection-items').evaluate(element => ({scrollable: element.scrollHeight > element.clientHeight, overflow: element.scrollWidth > element.clientWidth + 1}));
        assert.equal(sheet.scrollable, true); assert.equal(sheet.overflow, false);
        results.push({...await inspect(page, theme + ' ' + size + ' application sheet'), sheet}); await capture('application-sheet');
        await page.locator('.secondary-connection-items').evaluate(element => {element.scrollTop = element.scrollHeight;}); await capture('application-sheet-scrolled');
        await page.keyboard.press('Escape'); await page.locator('.secondary-connections-dialog').waitFor({state: 'hidden'});
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.app), 'chrome.exe', 'Escape restores focus');
        await page.locator('#connectionList [data-app="' + longApp + '"]').click();
        await page.locator('.secondary-connections-dialog[open]').waitFor();
        results.push(await inspect(page, theme + ' ' + size + ' long executable sheet')); await capture('long-executable-sheet');
        await page.keyboard.press('Escape');
        await opener.click(); await page.locator('.secondary-connection-row').first().click();
        await page.locator('[data-page="connectionDetail"]').waitFor({state: 'visible'});
        assert.equal(await page.locator('#detailApp').innerText(), 'chrome.exe');
        results.push(await inspect(page, theme + ' ' + size + ' detail')); await capture('detail');
        await page.locator('#disconnectOne').click(); await page.locator('#connectionDialog[open]').waitFor(); await page.locator('#cancelDisconnect').click();
        assert(fixture.state.connections.some(item => item.id === 'chrome-0'), 'cancel keeps connection');
        await page.locator('#disconnectOne').click(); await page.locator('#confirmDisconnect').click();
        await page.waitForFunction(() => !ui.busy);
        assert(!fixture.state.connections.some(item => item.id === 'chrome-0'), 'only selected connection disconnected');
        assert.equal(fixture.state.connections.length, 41);
        await nav('connections');
        fixture.state.connections = []; await page.evaluate(() => refreshConnections());
        assert.match(await page.locator('#connectionList').innerText(), /暂无当前连接/); results.push(await inspect(page, theme + ' ' + size + ' empty'));
        fixture.state.scenario = 'error'; await page.evaluate(() => refreshConnections());
        assert.equal(await page.locator('#connectionCount').innerText(), '暂不可用');
        assert.match(await page.locator('#connectionList').innerText(), /连接数据暂不可用/); results.push(await inspect(page, theme + ' ' + size + ' error'));
        fixture.state.scenario = 'normal'; fixture.state.connections = connections();
        await page.locator('#connectionList [data-retry-connections]').click(); await page.locator('#connectionList [data-app="codex.exe"]').waitFor();
        assert.equal(await page.locator('#connectionCount').innerText(), '42 条当前连接');
        results.push({label: theme + ' ' + size + ' interactions', passed: true, searchAppAndAddress: true, keyboardSheet: true, escapeFocus: true, detail: true, disconnectCancelAndConfirm: true, emptyErrorRetry: true});
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
    const report = {passed: true, isolated: true, scope: 'Current production frontend with isolated in-memory connection API fixtures; no live user connections or settings changed', themes: 3, viewports: ['360x600', '460x820'], scale: 1, reducedMotion: true, baseline, screenshots: screenshots.length, screenshotDirectory: path.relative(ROOT, OUT).replaceAll('\\', '/'), checks: results.length, errors, results};
    fs.writeFileSync(LOG, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({passed: true, themes: 3, viewports: 2, screenshots: screenshots.length, checks: results.length, baseline}));
  } finally {await browser.close(); await preview.close();}
}

run().catch(error => {console.error(error); process.exitCode = 1;});
