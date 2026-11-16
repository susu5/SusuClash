/* Actual production UI, isolated in-memory preview only. Never starts the
 * production server, imports adapters, reads user home, or contacts a proxy. */
const fs = require('node:fs/promises'), nativeFs = require('node:fs');
const path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { startPreview } = require('../scripts/preview-client.cjs');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const OUT = path.resolve(ROOT, option('--out') || 'outputs/working/netfix-ui');
const LOG = path.resolve(ROOT, option('--log') || 'outputs/log/netfix-ui.json');
const THEMES = ['cat', 'fish', 'whale'];
const SIZES = [{ width: 460, height: 868 }, { width: 360, height: 600 }];
const SCENARIOS = ['dead-port', 'no-candidate', 'drift', 'auth', 'transport', 'recurrence', 'normal', 'unknown', 'verify-fail', 'rollback-conflict', 'long-content'];
const ACTION = name => `[data-nf-action="${name}"]`;
const results = [], errors = [], forbidden = [], requests = [], screenshots = [];
const report = { passed: false, scope: 'Actual app files with isolated preview fixtures; no production API, user config, authentication, network probes or model requests.', themes: THEMES, sizes: SIZES, scenarios: SCENARIOS, results, errors, forbidden, requests, screenshots };
const label = (theme, size, name) => `${theme} ${size.width}x${size.height} ${name}`;
function record(theme, size, name, detail = {}) { results.push({ theme, size, name, passed: true, ...detail }); }
async function get(page) { return page.evaluate(() => { const x = window.netfixRepair.getState(); return x.snapshot || x; }); }
async function idle(page) {
  await page.waitForFunction(() => { const x = window.netfixRepair.getState(), s = x.snapshot || x; return s && !s.busy && !s.ui?.pending; }, null, { timeout: 15000 });
}
async function click(page, action) {
  const inSheet = ['confirm', 'cancel-dialog', 'close-result', 'select-report'].includes(action) || action === 'stop' && await page.locator('#nf-sheet').isVisible();
  await page.locator(inSheet ? `#nf-sheet .nf-sheet-actions ${ACTION(action)}` : `.netfix-shell ${ACTION(action)}`).click();
}
async function scenario(page, fixture, id) {
  fixture.setNetfixScenario(id);
  await page.evaluate(async () => { await window.netfixRepair.open(); await window.netfixRepair.refresh(); });
  await idle(page);
  await page.locator('.netfix-shell').waitFor({ state: 'visible' });
}
async function closeResult(page) {
  const button = page.locator(ACTION('close-result'));
  if (await button.isVisible()) { await button.click(); await idle(page); }
}
async function shot(page, theme, size, name) {
  const file = path.join(OUT, `${theme}-${name}-${size.width}x${size.height}.png`);
  await page.screenshot({ path: file }); screenshots.push(path.relative(ROOT, file));
}
async function inspect(page) {
  return page.evaluate(() => {
    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !e.closest('[hidden],.sr-only,.visually-hidden,.doctor-legacy-state') && e.namespaceURI !== 'http://www.w3.org/2000/svg'; };
    const nodes = [...document.body.querySelectorAll('*')].filter(visible);
    const summary = e => ({ tag: e.tagName, id: e.id, className: String(e.className), text: e.textContent.trim().slice(0, 60) });
    const small = nodes.filter(e => parseFloat(getComputedStyle(e).fontSize) < 12).map(e => ({ ...summary(e), size: getComputedStyle(e).fontSize }));
    const cards = nodes.filter(e => e.dataset.scSurface === 'card');
    const badCards = cards.filter(e => ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].some(p => getComputedStyle(e)[p] !== '18px')).map(e => ({ ...summary(e), radius: getComputedStyle(e).borderRadius }));
    const moving = nodes.filter(e => { const c = getComputedStyle(e); return c.animationName !== 'none' && c.animationDuration.split(',').some(x => parseFloat(x) > .001) || c.transitionDuration.split(',').some(x => parseFloat(x) > .001); }).map(summary);
    const sheet = document.querySelector('#nf-sheet[open]');
    const dialog = sheet ? { topLeft: getComputedStyle(sheet).borderTopLeftRadius, topRight: getComputedStyle(sheet).borderTopRightRadius, x: sheet.getBoundingClientRect().x, right: sheet.getBoundingClientRect().right, bottom: sheet.getBoundingClientRect().bottom, focusInside: sheet.contains(document.activeElement) } : null;
    const netfix = document.querySelector('.netfix-shell');
    const headings = nodes.filter(e => e.matches('h1,h2') && e.getBoundingClientRect().width > 1 && e.getBoundingClientRect().height > 1);
    const home = document.querySelector('[data-page="home"] .home-node'), lines = document.querySelector('[data-page="lines"] .line-group-button');
    const active = document.querySelector('.tabs [aria-current="page"]');
    const legacyContext = active && visible(active) && ((active.textContent.includes('首页') && home && visible(home) && home.textContent.trim()) || (active.textContent.includes('线路') && lines && visible(lines) && lines.textContent.trim()));
    const plate = document.querySelector('.tabs .nav-indicator');
    const navAligned = !active || !plate ? false : Math.abs(active.getBoundingClientRect().left - plate.getBoundingClientRect().left) <= 1.5 && Math.abs(active.getBoundingClientRect().width - plate.getBoundingClientRect().width) <= 1.5 && plate.getBoundingClientRect().right <= innerWidth + 1;
    return { small, badCards, cards: cards.length, moving, dialog, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      overflow: document.documentElement.scrollWidth > innerWidth + 1, headingAvailable: headings.length > 0 || Boolean(legacyContext), navAligned,
      specialist: netfix && visible(netfix), width: innerWidth, height: innerHeight };
  });
}
function assertStyle(x, name) {
  assert.deepEqual(x.small, [], name + ' text below 12px'); assert.deepEqual(x.badCards, [], name + ' cards not 18px');
  assert.deepEqual(x.moving, [], name + ' reduced-motion violation'); assert.equal(x.reducedMotion, true);
  assert.equal(x.overflow, false, name + ' horizontal overflow'); assert.equal(x.headingAvailable, true, name + ' missing visible page heading/context');
  assert.equal(x.navAligned, true, name + ' navigation plate is misaligned');
  if (x.dialog) {
    assert.equal(x.dialog.topLeft, '24px'); assert.equal(x.dialog.topRight, '24px');
    assert(x.dialog.x >= -1 && x.dialog.right <= x.width + 1 && x.dialog.bottom <= x.height + 1, name + ' dialog outside viewport');
  }
}
async function disclosure(page, name) {
  const sheet = page.locator('#nf-sheet'); await sheet.waitFor({ state: 'visible' });
  assert.equal(await sheet.locator('.nf-disclosure-row').count(), 6, name + ' six disclosures');
  const text = await sheet.innerText();
  for (const field of ['目标文件', '变更内容', '并发改动', '回滚方式', '生效条件']) assert(text.includes(field), name + ' disclosure ' + field);
  assert(/备份|属性恢复点|属性快照/.test(text));
  const x = await inspect(page); assertStyle(x, name); assert.equal(x.dialog.focusInside, true, 'dialog must receive focus');
}
async function applyConfirmation(page) { await click(page, 'confirm'); await idle(page); }

async function operations(page, fixture, theme, size) {
  await scenario(page, fixture, 'dead-port'); const original = await get(page);
  await click(page, 'main'); await disclosure(page, 'port repair'); await shot(page, theme, size, 'disclosure');
  await click(page, 'cancel-dialog'); assert.equal((await get(page)).env.port, original.env.port, 'cancelled preview is read only');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.nfAction), 'main', 'cancelled disclosure returns focus to its invoker');
  await page.locator(ACTION('main')).focus(); await page.keyboard.press('Enter'); await disclosure(page, 'keyboard opening');
  for (let i = 0; i < 8; i++) { await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab'); assert(await page.evaluate(() => document.querySelector('#nf-sheet').contains(document.activeElement)), 'focus trap'); }
  await applyConfirmation(page); const fixed = await get(page);
  assert.notEqual(fixed.env.port, original.env.port); assert(fixed.backups.length > original.backups.length);
  assert.equal(fixed.stage, 'awaiting_restart'); assert.equal(fixed.waitingRestart, true); assert.notEqual(fixed.verification, 'app_verified');
  assert(/未验证|尚未验证/.test(await page.locator('.netfix-shell').innerText()));
  await shot(page, theme, size, 'saved'); await closeResult(page);
  await click(page, 'restore'); await disclosure(page, 'restore'); await applyConfirmation(page);
  assert.equal((await get(page)).env.port, original.env.port); await closeResult(page);
  record(theme, size, 'opaque six-disclosure preview, cancel, keyboard execution and backup restore');

  await scenario(page, fixture, 'recurrence'); await click(page, 'lock'); await disclosure(page, 'lock'); await applyConfirmation(page);
  assert.equal((await get(page)).env.locked, true); await closeResult(page);
  await click(page, 'lock'); await disclosure(page, 'unlock'); await applyConfirmation(page);
  assert.equal((await get(page)).env.locked, false); await closeResult(page); record(theme, size, 'independent lock and unlock');

  for (const id of ['verify-fail', 'rollback-conflict']) {
    await scenario(page, fixture, id); const before = await get(page);
    await click(page, 'main'); await disclosure(page, id); await applyConfirmation(page); const after = await get(page);
    assert.equal(after.stage, id === 'verify-fail' ? 'rolled_back' : 'rollback_conflict');
    if (id === 'verify-fail') assert.equal(after.env.port, before.env.port, 'failed verification restores port');
    assert.notEqual(after.verification, 'app_verified'); assertStyle(await inspect(page), id);
    await shot(page, theme, size, id + '-result'); await closeResult(page); record(theme, size, id + ' result');
  }
  for (const id of ['no-candidate', 'auth']) {
    await scenario(page, fixture, id); assert(await page.locator(ACTION('main')).isDisabled(), id + ' blocks automatic repair'); record(theme, size, id + ' primary guard');
  }
  for (const id of ['drift', 'transport']) {
    await scenario(page, fixture, id); const before = await get(page); await click(page, 'main');
    await page.locator('#nf-sheet').waitFor({ state: 'visible' }); assert.equal(await page.locator(ACTION('confirm')).count(), 0, id + ' only guidance');
    await click(page, 'cancel-dialog'); assert.equal((await get(page)).env.port, before.env.port); record(theme, size, id + ' read-only guidance');
  }
  await scenario(page, fixture, 'unknown'); assert(await page.locator(ACTION('lock')).isDisabled()); assert(await page.locator(ACTION('restore')).isDisabled());
  assert((await page.locator('.netfix-shell').innerText()).includes('尚不能确认')); record(theme, size, 'unknown blocks every write');

  await scenario(page, fixture, 'normal'); await click(page, 'main');
  await page.waitForFunction(() => Boolean(window.__netfixUiClipboard) || document.querySelector('#nf-report-text'));
  const copied = await page.evaluate(() => window.__netfixUiClipboard || document.querySelector('#nf-report-text')?.value);
  assert(/当前窗口和原任务.*未验证|不等于模型请求|尚未验证/.test(copied), 'report preserves verification boundary');
  if (await page.locator('#nf-sheet').isVisible()) await click(page, 'cancel-dialog'); record(theme, size, 'report copy or selectable fallback');

  await scenario(page, fixture, 'dead-port'); const beforeDiagnose = await get(page); await click(page, 'diagnose');
  await page.waitForFunction(() => { const x = window.netfixRepair.getState(); return (x.snapshot || x).busy; });
  const stop = page.locator(ACTION('stop-diagnose'));
  if (await stop.count()) await stop.click(); else await click(page, 'stop');
  await idle(page); assert.equal((await get(page)).stage, 'cancelled');
  await click(page, 'diagnose'); await idle(page); const fresh = await get(page);
  assert.notEqual(fresh.diagnosisId, beforeDiagnose.diagnosisId); assert.notEqual(fresh.stage, 'cancelled'); record(theme, size, 'safe diagnosis cancellation and fresh run identity');

  await scenario(page, fixture, 'dead-port'); const beforeStop = await get(page);
  assert.equal(typeof fixture.holdNetfixExecutionAfterWrite, 'function');
  fixture.holdNetfixExecutionAfterWrite(true); // Hold server fixture after mutation; do not race a 700ms polling window.
  await click(page, 'main'); await disclosure(page, 'safe execution stop'); await click(page, 'confirm');
  await page.waitForFunction(port => { const x = window.netfixRepair.getState(), s = x.snapshot || x; return s.busy && s.stage === 'executing' && s.env.port !== port; }, beforeStop.env.port);
  assert(await page.evaluate(() => document.querySelector('#nf-sheet').contains(document.activeElement)), 'execution updates retain focus inside the dialog');
  await click(page, 'stop'); await idle(page); const stopped = await get(page);
  assert.equal(stopped.stage, 'cancelled'); assert.equal(stopped.env.port, beforeStop.env.port, 'stop after simulated write waits for compensating restore');
  assert.notEqual(stopped.verification, 'app_verified'); await shot(page, theme, size, 'safe-stop-after-write');
  await closeResult(page); record(theme, size, 'safe execution stop after write restores original port');

  await scenario(page, fixture, 'long-content'); await click(page, 'details');
  const scroll = await page.locator('.netfix-shell .app-body').evaluate(el => { const before = el.scrollTop; el.scrollTop = el.scrollHeight; const moved = el.scrollTop > before; el.scrollTop = 0; return { moved, client: el.clientHeight, scroll: el.scrollHeight }; });
  assert(scroll.moved && scroll.scroll > scroll.client, 'expanded long content remains scrollable'); assertStyle(await inspect(page), 'long content');
  await shot(page, theme, size, 'long-expanded'); record(theme, size, 'long paths and evidence scroll', { scroll });
  await page.locator(ACTION('diagnose')).focus(); await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => { const x = document.activeElement, c = getComputedStyle(x); return { tag: x.tagName, outline: c.outlineStyle, width: parseFloat(c.outlineWidth) }; });
  assert.notEqual(focus.tag, 'BODY'); assert(focus.outline !== 'none' && focus.width >= 1, 'visible keyboard focus'); record(theme, size, 'visible keyboard focus', { focus });
}

async function latePoll(page, fixture, theme, size) {
  await scenario(page, fixture, 'normal');
  const original = await get(page);
  let release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), arrival = new Promise(resolve => { entered = resolve; });
  const handler = async route => {
    if (!held && route.request().method() === 'GET') {
      held = true; const response = await route.fetch(); const body = await response.text(); entered(); await gate;
      return route.fulfill({ response, body });
    }
    return route.continue();
  };
  await page.route('**/api/netfix', handler);
  const older = page.evaluate(() => window.netfixRepair.refresh());
  let newer;
  try {
    await Promise.race([arrival, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Netfix poll was not intercepted within five seconds')), 5000); timer.unref(); })]);
    fixture.setNetfixScenario('auth'); await click(page, 'diagnose');
    await page.waitForFunction(revision => { const x = window.netfixRepair.getState(), s = x.snapshot || x; return s.revision > revision && s.busy; }, original.revision);
    newer = await get(page);
  } finally { release(); await older; await page.unroute('**/api/netfix', handler); }
  const after = await get(page); assert(after.revision >= newer.revision, 'older poll response cannot overwrite newer in-progress diagnosis'); assert.equal(after.busy, true);
  await idle(page); const finished = await get(page); assert.match(finished.verdict.tag, /C/);
  record(theme, size, 'late poll cannot overwrite newer diagnosis');
}

async function run() {
  await fs.mkdir(OUT, { recursive: true }); await fs.mkdir(path.dirname(LOG), { recursive: true });
  const sources = ['app/netfix.js', 'app/netfix.css', 'app/doctor.js', 'app/index.html', 'qa/preview-fixture.cjs'];
  const fingerprint = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(ROOT, name))).digest('hex')])));
  report.sourceHashes = await fingerprint();
  const preview = await startPreview(), origin = new URL(preview.url).origin;
  const executablePath = [process.env.NETFIX_QA_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(x => nativeFs.existsSync(x));
  let browser;
  try {
    assert(executablePath, 'installed browser required'); browser = await chromium.launch({ headless: true, executablePath, args: ['--no-proxy-server'] });
    for (const size of SIZES) for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
      await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__netfixUiClipboard = String(value); } } }); });
      await context.route('**/*', async route => {
        const r = route.request(), url = new URL(r.url());
        if (url.origin !== origin || /\/api\/(?:doctor\/(?:auto-start|request)|codex-repair\/)/.test(url.pathname)) { forbidden.push({ url: r.url(), method: r.method() }); return route.abort(); }
        if (url.pathname.includes('/api/')) requests.push({ theme, size, path: url.pathname, method: r.method() });
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push({ theme, size, message: e.message }));
      await page.goto(preview.url + 'client/' + theme + '/'); await page.locator('#statusOrb').waitFor();
      await page.waitForFunction(() => !!window.netfixRepair && !!window.connectionDoctor);
      const fixture = preview.fixtures[theme]; assert.equal(typeof fixture.setNetfixScenario, 'function', 'isolated fixture exposes scenarios');
      await page.evaluate(() => connectionDoctor.open('codex')); await page.locator('.netfix-shell').waitFor({ state: 'visible' });
      record(theme, size, 'existing Codex specialist entry delegates to Netfix');
      for (const id of SCENARIOS) {
        await scenario(page, fixture, id); const x = await inspect(page); assertStyle(x, label(theme, size, id));
        assert.equal(x.width, size.width); assert.equal(x.height, size.height); await shot(page, theme, size, id);
        record(theme, size, 'scenario ' + id, { style: x, state: await get(page) });
      }
      await operations(page, fixture, theme, size);
      if (theme === 'cat' && size.width === 460) await latePoll(page, fixture, theme, size);
      for (const name of ['home', 'lines', 'settings', 'about']) {
        await page.evaluate(async name => { await window.netfixRepair.close(); openPage(name, true); }, name);
        await page.locator(`[data-page="${name}"]`).waitFor({ state: 'visible' });
        const x = await inspect(page); assertStyle(x, label(theme, size, name)); await shot(page, theme, size, name); record(theme, size, 'adjacent ' + name, { style: x });
      }
      await context.close(); console.log(`Netfix production UI passed ${theme} ${size.width}x${size.height}`);
    }
    assert.deepEqual(errors, [], 'production UI runtime errors'); assert.deepEqual(forbidden, [], 'no legacy repair/model/external requests');
    assert(requests.some(r => /\/netfix\/preview$/.test(r.path)), 'actual UI must request server-bound previews');
    assert(requests.some(r => /\/netfix\/apply$/.test(r.path)), 'actual UI must apply opaque previews');
    assert.deepEqual(await fingerprint(), report.sourceHashes, 'UI and isolated fixture sources must stay unchanged during this acceptance run');
    report.passed = true;
  } catch (error) { report.failure = { message: error.message, stack: error.stack }; throw error; }
  finally { if (browser) await browser.close(); await preview.close(); await fs.writeFile(LOG, JSON.stringify({ ...report, completedAt: new Date().toISOString(), checks: results.length, screenshotCount: screenshots.length }, null, 2)); }
  console.log(JSON.stringify({ passed: true, checks: results.length, screenshots: screenshots.length, log: path.relative(ROOT, LOG) }));
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
