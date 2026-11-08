import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const maxBytes = 5 * 1024 * 1024;
const uuid = /^[a-f0-9-]{36}$/i;

// Subscription providers may send numeric traffic metadata in this header.
// Retain only validated numbers, never the raw header or subscription URL.
export function parseSubscriptionUsage(header) {
  if (typeof header !== 'string' || header.length > 1024) return null;
  const values = Object.create(null);
  for (const part of header.split(';')) {
    if (!/^\s*(upload|download|total|expire)\s*=/i.test(part)) continue;
    const match = /^\s*(upload|download|total|expire)\s*=\s*(\d+)\s*$/i.exec(part);
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(values, key)) return null;
    const n = Number(match[2]);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    values[key] = n;
  }
  if (!Object.hasOwn(values, 'upload') || !Object.hasOwn(values, 'download')) return null;
  const used = values.upload + values.download;
  if (!Number.isSafeInteger(used)) return null;
  const total = values.total > 0 ? values.total : null;
  return { used, total, remaining: total === null ? null : Math.max(0, total - used),
    exceeded: total !== null && used > total, expiresAt: values.expire > 0 ? values.expire : null };
}

function publicUsage(value) {
  if (!value || !Number.isSafeInteger(value.used) || value.used < 0) return null;
  const total = Number.isSafeInteger(value.total) && value.total > 0 ? value.total : null;
  const expiresAt = Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0 ? value.expiresAt : null;
  return { used: value.used, total, remaining: total === null ? null : Math.max(0, total - value.used),
    exceeded: total !== null && value.used > total, expiresAt };
}

export class ProfileError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function checkedName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new ProfileError('请输入不超过 80 个字符的配置名称。');
  return name;
}

function checkedUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new ProfileError('请输入有效的 HTTP 或 HTTPS 订阅链接。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ProfileError('请输入有效的 HTTP 或 HTTPS 订阅链接，不能包含地址中的用户名和密码。');
  return parsed.toString();
}

function checkedContent(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ProfileError('配置内容为空。');
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new ProfileError('配置文件超过 5 MiB。', 413);
  if (/^\s*<(?:!doctype|html)\b/i.test(value)) throw new ProfileError('订阅返回了网页，而不是配置文件。');
  return value;
}

// Only classify recognized share-link lists; never include their content in errors.
function isNodeLinkList(value) {
  const text = String(value).trim();
  const links = /^(?:vmess|vless|ss|ssr|trojan|hysteria2|hy2|tuic):\/\//im;
  if (links.test(text)) return true;
  if (text.length < 16 || text.length > maxBytes || !/^[A-Za-z0-9+/_=\-\r\n]+$/.test(text)) return false;
  try { return links.test(Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf8')); }
  catch { return false; }
}

async function atomicWrite(filename, data) {
  const tmp = filename + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tmp, filename);
  } finally { await rm(tmp, { force: true }).catch(() => {}); }
}

/**
 * Isolated profile storage. Validators must test the exact candidate with the
 * chosen core and must reject unsupported content. Application must either
 * load successfully or reject without replacing the previous running config.
 * The returned profile metadata never exposes subscription URLs or config paths.
 */
export function createProfileStore({ directory, validateConfig, applyConfig, fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (!directory || typeof validateConfig !== 'function' || typeof applyConfig !== 'function') throw new TypeError('directory, validateConfig and applyConfig are required');
  const root = path.resolve(directory);
  const filesDir = path.join(root, 'files');
  const manifestPath = path.join(root, 'profiles.json');
  let pending = Promise.resolve();
  let state;

  async function init() {
    if (state) return;
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.profiles) || (parsed.activeId !== null && typeof parsed.activeId !== 'string')) throw new Error('invalid manifest');
      for (const item of parsed.profiles) if (!uuid.test(item.id) || !uuid.test(item.version)) throw new Error('invalid profile identifier');
      state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ProfileError('无法读取配置列表，请检查本地数据。', 500);
      state = { activeId: null, profiles: [] };
    }
  }
  function exclusive(action) {
    const next = pending.then(async () => { await init(); return action(); });
    pending = next.catch(() => {});
    return next;
  }
  function file(version) { return path.join(filesDir, version + '.yaml'); }
  function find(id) {
    const profile = state.profiles.find(item => item.id === id);
    if (!profile) throw new ProfileError('没有找到这条配置。', 404);
    return profile;
  }
  function publicProfile(item) {
    return { id: item.id, name: item.name, kind: item.kind, active: state.activeId === item.id, loaded: true,
      lastSuccess: item.lastSuccess, lastError: item.lastError || null, usage: publicUsage(item.usage) };
  }
  async function persist(next) { await atomicWrite(manifestPath, JSON.stringify(next, null, 2)); state = next; }
  async function candidate(content) {
    const version = randomUUID();
    const target = file(version);
    await writeFile(target, checkedContent(content), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await validateConfig(target); }
    catch (error) {
      await rm(target, { force: true }).catch(() => {});
      // Only publish fixed, audited messages; arbitrary validator output may contain subscription credentials.
      const safeMessages = new Set([
        '暂不支持包含远程代理集或规则集的配置。', '未找到本软件的 Mihomo 内核，请先安装内核。',
        '配置顶层格式暂不受支持，请使用标准 YAML 配置。', '配置 YAML 格式无效或包含暂不支持的标签。',
        '配置中的 DNS 设置格式无效。', '配置中的保留字段名称格式无效。', '配置包含暂不支持的循环引用。',
        '代理内核无法启动，请检查文件和系统权限。', '配置校验超时，请稍后重试。',
        '订阅包含当前内核不支持的节点协议，请向服务商获取 Clash 格式。', '订阅中的节点缺少必要信息，请向服务商检查配置。',
        '订阅中的线路、策略组或规则无法通过校验，请检查配置。', '订阅中的配置字段与内核格式不匹配，请检查配置。'
      ]);
      if (safeMessages.has(error?.message) && [503, 504].includes(error.status)) throw new ProfileError(error.message, error.status);
      if (isNodeLinkList(content)) throw new ProfileError('订阅返回了节点链接列表，当前版本需要 Clash/Mihomo 格式配置。请在订阅服务中选择 Clash 格式。', 422);
      if (safeMessages.has(error?.message)) throw new ProfileError(error.message, [503, 504].includes(error.status) ? error.status : 422);
      throw new ProfileError('配置无法通过内核校验，可能格式或协议不受支持。', 422);
    }
    return { version, target };
  }
  async function download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Subscription providers frequently choose Clash YAML based on this header.
      const response = await fetchImpl(checkedUrl(url), { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/yaml, text/yaml, text/plain, */*', 'User-Agent': 'Clash.Meta/1.19.33' } });
      if (response.status >= 300 && response.status < 400) throw new ProfileError('订阅链接发生跳转；请使用服务商提供的最终订阅地址。', 422);
      if (!response.ok) throw new ProfileError('订阅请求失败（HTTP ' + response.status + '）。', 502);
      if (Number(response.headers.get('content-length')) > maxBytes) throw new ProfileError('订阅内容超过 5 MiB。', 413);
      if (!response.body) throw new ProfileError('订阅没有返回配置内容。', 502);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) { controller.abort(); throw new ProfileError('订阅内容超过 5 MiB。', 413); }
        chunks.push(chunk);
      }
      return { content: checkedContent(Buffer.concat(chunks).toString('utf8')),
        usage: parseSubscriptionUsage(response.headers.get('subscription-userinfo')) };
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      if (controller.signal.aborted) throw new ProfileError('订阅请求超时，请稍后重试。', 504);
      throw new ProfileError('无法获取订阅，请检查网络或链接后重试。', 502);
    } finally { clearTimeout(timer); }
  }
  async function add(name, kind, url, content, usage = null) {
    const c = await candidate(content);
    const item = { id: randomUUID(), name, kind, url, version: c.version, lastSuccess: new Date().toISOString(), lastError: null, usage };
    try { await persist({ ...state, profiles: [...state.profiles, item] }); }
    catch (error) { await rm(c.target, { force: true }).catch(() => {}); throw error; }
    return publicProfile(item);
  }
  async function refresh(item, source = item.url, name = item.name) {
    if (item.kind !== 'url') throw new ProfileError('本地配置不能通过订阅链接更新。', 409);
    const id = item.id;
    let c;
    try {
      const fetched = await download(source);
      c = await candidate(fetched.content);
      if (state.activeId === id) await applyConfig(c.target);
      const changed = { ...item, name, url: source, version: c.version, lastSuccess: new Date().toISOString(), lastError: null, usage: fetched.usage };
      try { await persist({ ...state, profiles: state.profiles.map(p => p.id === id ? changed : p) }); }
      catch (error) {
        if (state.activeId === id) await applyConfig(file(item.version)).catch(() => {});
        throw error;
      }
      await rm(file(item.version), { force: true }).catch(() => {});
      return publicProfile(changed);
    } catch (error) {
      if (c) await rm(c.target, { force: true }).catch(() => {});
      const message = error instanceof ProfileError ? error.message : '应用新配置失败，旧配置文件已保留；请检查运行状态。';
      const changed = { ...item, lastError: message };
      await persist({ ...state, profiles: state.profiles.map(p => p.id === id ? changed : p) }).catch(() => {});
      if (error instanceof ProfileError) throw error;
      throw new ProfileError(message, 502);
    }
  }
  return {
    list: () => exclusive(async () => ({ activeId: state.activeId, profiles: state.profiles.map(publicProfile) })),
    addUrl: ({name, url} = {}) => exclusive(async () => {
      const title = checkedName(name); const source = checkedUrl(url);
      const fetched = await download(source);
      return add(title, 'url', source, fetched.content, fetched.usage);
    }),
    addLocal: ({name, content} = {}) => exclusive(async () => add(checkedName(name), 'local', null, content)),
    update: id => exclusive(async () => refresh(find(id))),
    edit: (id, {name, url} = {}) => exclusive(async () => {
      const item = find(id);
      const title = name === undefined ? item.name : checkedName(name);
      if (typeof url === 'string' && url.trim()) return refresh(item, checkedUrl(url), title);
      const changed = { ...item, name: title };
      await persist({ ...state, profiles: state.profiles.map(p => p.id === id ? changed : p) });
      return publicProfile(changed);
    }),
    restoreActive: () => exclusive(async () => {
      if (!state.activeId) return null;
      const item = find(state.activeId);
      try { await validateConfig(file(item.version)); await applyConfig(file(item.version)); }
      catch { throw new ProfileError('无法恢复上次配置，请检查内核或配置。', 503); }
      return publicProfile(item);
    }),
    activate: id => exclusive(async () => {
      const item = find(id);
      if (state.activeId === id) return publicProfile(item);
      try { await validateConfig(file(item.version)); await applyConfig(file(item.version)); }
      catch { throw new ProfileError('配置启用失败，旧配置文件已保留；请检查运行状态。', 422); }
      const previousId = state.activeId;
      try { await persist({ ...state, activeId: id }); }
      catch (error) {
        const old = state.profiles.find(p => p.id === previousId);
        if (old) await applyConfig(file(old.version)).catch(() => {});
        throw new ProfileError('无法保存当前配置，请重试。', 500);
      }
      return publicProfile(item);
    }),
    remove: id => exclusive(async () => {
      const item = find(id);
      if (state.activeId === id) throw new ProfileError('请先切换到其他配置，再删除当前配置。', 409);
      await persist({ ...state, profiles: state.profiles.filter(p => p.id !== id) });
      await rm(file(item.version), { force: true }).catch(() => {});
      return { removed: true };
    })
  };
}
