import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const themes = new Set(['cat', 'fish', 'whale']);

// A dedicated file avoids mixing presentation preferences with subscription data.
export function createThemePreferences({ directory } = {}) {
  if (!directory) throw new TypeError('directory is required');
  const file = path.join(directory, 'theme.json');
  let tail = Promise.resolve();
  async function get() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return { theme: themes.has(data?.theme) ? data.theme : 'cat' };
    } catch (error) {
      if (error.code === 'ENOENT') return { theme: 'cat' };
      throw new Error('无法读取主题设置。');
    }
  }
  function set(value) {
    if (!themes.has(value?.theme)) return Promise.reject(new TypeError('不支持的主题。'));
    const next = tail.then(async () => {
      await mkdir(directory, { recursive: true });
      const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await writeFile(temp, JSON.stringify({ theme: value.theme }), { mode: 0o600, flag: 'wx' });
        await rename(temp, file);
      } finally { await rm(temp, { force: true }).catch(() => {}); }
      return { theme: value.theme };
    });
    tail = next.catch(() => {});
    return next;
  }
  return { get, set };
}
