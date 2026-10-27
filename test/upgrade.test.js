import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { storageLocation, prepareStorage } from '../src/data-directory.js';
import { TranslationService } from '../src/service.js';

const root = await mkdtemp(resolve('.test-output/upgrade-'));
const pythonExecutable = process.env.DSH_TRANSLATE_PYTHON ?? 'python';

test('默认存储独立于版本与包目录，尊重 DSH_HOME 和用户已有路径', () => {
  const home = join(root, 'home');
  assert.equal(storageLocation(undefined, { home, env: {} }), join(home, '.dsh', 'plugin-data', 'DSH-game-translate'));
  assert.equal(storageLocation(undefined, { home, env: { DSH_HOME: '   ' } }), storageLocation(undefined, { home, env: {} }));
  assert.equal(storageLocation(undefined, { home, env: { DSH_HOME: '~/other' } }), join(home, 'other', 'plugin-data', 'DSH-game-translate'));
  assert.equal(storageLocation(join(root, 'custom'), { home, env: { DSH_HOME: join(root, 'different') } }), join(root, 'custom'));
  assert.throws(() => storageLocation(''), /非空/);
});

test('真实读取跨程序目录替换保留绑定、译文引用和设置；旧数据只复制一次', async () => {
  const home = join(root, 'retained-home');
  const directory = storageLocation(undefined, { home, env: {} });
  const packageRoot = join(root, 'package-v1');
  const legacy = join(packageRoot, '.local');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const sessionId = 'root-upgrade';
  const key = createHash('sha256').update(sessionId).digest('hex');
  const bindingPath = join('sessions', key, 'binding.json');
  await mkdir(join(legacy, 'sessions', key, 'drafts'), { recursive: true });
  const state = { schema_version: 1, session_id: sessionId, workspace, version: 9, binding: {
    project_id: 'existing-project', work_dir: join(workspace, 'WORK'), phase: 'project_ready' }, pending: null, notice: null, grants: [] };
  await mkdir(state.binding.work_dir);
  await writeFile(join(state.binding.work_dir, 'tasks.jsonl'), '{"id":"t1","translation":"人工修改译文","revision":4}\n');
  const binding = JSON.stringify(state);
  await writeFile(join(legacy, bindingPath), binding);
  await writeFile(join(legacy, 'sessions', key, 'drafts', 'saved.json'), '{"translation":"已保存草稿"}');
  await writeFile(join(legacy, 'models.json'), '[{"id":"existing-id","credentialRef":"unchanged-ref"}]');
  await writeFile(join(legacy, 'native-appearance.json'), '{"surface":"glass","milky":5}');
  await mkdir(join(legacy, 'native-ui'));
  await writeFile(join(legacy, 'native-ui', 'cache'), 'disposable');
  await prepareStorage(directory, { packageRoot });
  for (const item of [bindingPath, 'models.json', 'native-appearance.json', join('sessions', key, 'drafts', 'saved.json')]) {
    assert.equal(await readFile(join(directory, item), 'utf8'), await readFile(join(legacy, item), 'utf8'));
  }
  await assert.rejects(readFile(join(directory, 'native-ui', 'cache')), { code: 'ENOENT' });
  // Simulate replacement at a different code path while retaining user storage.
  const nextPackage = join(root, 'package-v2');
  await mkdir(nextPackage);
  await writeFile(join(nextPackage, 'package.json'), '{"type":"module"}');
  await cp(new URL('../src/data-directory.js', import.meta.url), join(nextPackage, 'data-directory.js'));
  const next = await import(pathToFileURL(join(nextPackage, 'data-directory.js')));
  const nextDirectory = next.storageLocation(undefined, { home, env: {} });
  assert.equal(nextDirectory, directory);
  assert.ok(resolve(packageRoot).startsWith(root) && resolve(join(root, 'retired-v1')).startsWith(root));
  await rename(packageRoot, join(root, 'retired-v1'));
  await next.prepareStorage(nextDirectory, { packageRoot: nextPackage });
  const service = new TranslationService({ pythonExecutable, dataDirectory: nextDirectory });
  try {
    const result = await service.callObserved({ header: { id: sessionId, cwd: workspace }, events: [] }, 'status');
    assert.equal(result.data.state.binding.project_id, 'existing-project');
    assert.equal(result.data.state.version, 9);
    assert.equal(await readFile(join(directory, bindingPath), 'utf8'), binding);
    assert.match(await readFile(join(state.binding.work_dir, 'tasks.jsonl'), 'utf8'), /人工修改译文/);
    // An unsupported newer state is rejected before any write, including rollback.
    const future = JSON.stringify({ ...state, schema_version: 2 });
    await writeFile(join(directory, bindingPath), future);
    await assert.rejects(service.callObserved({ header: { id: sessionId, cwd: workspace }, events: [] }, 'status'), error => error.result?.error?.code === 'unsupported_state_version');
    assert.equal(await readFile(join(directory, bindingPath), 'utf8'), future);
  } finally { await service.dispose(); }
});

test('显式目录原样保留；已有数据不覆盖；迁移异常不发布半成品', async () => {
  const packageRoot = join(root, 'legacy-errors');
  const legacy = join(packageRoot, '.local');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'models.json'), 'old');
  const explicit = join(root, 'explicit');
  await prepareStorage(explicit, { configured: explicit, packageRoot });
  await assert.rejects(readFile(join(explicit, 'models.json')), { code: 'ENOENT' });
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'models.json'), 'new');
  await prepareStorage(existing, { packageRoot });
  assert.equal(await readFile(join(existing, 'models.json'), 'utf8'), 'new');
  const destination = join(root, 'not-published');
  await symlink(legacy, join(legacy, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareStorage(destination, { packageRoot }), /包含链接/);
  await assert.rejects(readFile(join(destination, 'models.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(legacy, 'models.json'), 'utf8'), 'old');
});
