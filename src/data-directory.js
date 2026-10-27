import { cp, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILES = ['models.json', 'native-appearance.json'];

/** Keep state independent of npm's replaceable package directory and version. */
export function storageLocation(configured, { env = process.env, home = homedir() } = {}) {
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !configured.trim()) throw new Error('dataDirectory 须为非空目录路径');
    return resolve(configured);
  }
  let root = env.DSH_HOME?.trim() ? env.DSH_HOME : join(home, '.dsh');
  if (root === '~') root = home;
  else if (/^~[/\\]/.test(root)) root = join(home, root.slice(2));
  return resolve(root, 'plugin-data', 'DSH-game-translate');
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function hasState(path) {
  for (const file of FILES) if (await exists(join(path, file))) return true;
  try { return (await readdir(join(path, 'sessions'))).length > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** One-time, copy-only migration; never merge or overwrite an existing store. */
export async function prepareStorage(directory, { configured, packageRoot }) {
  if (configured !== undefined || await hasState(directory)) return;
  const candidates = [...new Set([join(packageRoot, '.local'), join(dirname(packageRoot), 'dsh-translate', '.local')])];
  const legacy = [];
  for (const path of candidates) if (resolve(path) !== directory && await hasState(path)) legacy.push(path);
  if (!legacy.length) return;
  if (legacy.length > 1) throw new Error('发现多份旧插件数据，请在 dataDirectory 指定需要保留的目录；原数据未改动。');
  const source = legacy[0];
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  // A sibling staging directory is published in one rename only after every
  // authoritative file has copied. Chromium caches and disposable locks stay out.
  const stage = join(parent, `.DSH-game-translate-migration-${randomUUID()}`);
  await mkdir(stage);
  const filter = async path => {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('旧数据包含链接，请显式指定原 dataDirectory，避免错误迁移。');
    return true;
  };
  for (const item of ['sessions', ...FILES]) {
    if (await exists(join(source, item))) await cp(join(source, item), join(stage, item), { recursive: true, errorOnExist: true, force: false, filter });
  }
  await writeFile(join(stage, 'storage-migration.json'), JSON.stringify({ schemaVersion: 1, source, copiedAt: new Date().toISOString() })+'\n', { flag: 'wx' });
  try {
    // Do not replace even an apparently empty target: it may belong to another
    // active process. Failed staging is retained for inspection, never published.
    if (await exists(directory)) {
      if (await hasState(directory)) return;
      throw new Error('数据目标目录已存在，请设置原 dataDirectory 后重试；原数据与迁移副本均保留。');
    }
    await rename(stage, directory);
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) && await hasState(directory)) return;
    throw error;
  }
  // Read the marker after publication, so startup observes a complete migration.
  await readFile(join(directory, 'storage-migration.json'), 'utf8');
}
