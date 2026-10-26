import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader';
import { TranslationService } from '../src/service.js';
import { TranslationUi } from '../src/ui-remote.js';
import { TYPERT } from '../src/remote-host.js';
import { REMOTE_INFO } from '../src/remote-info.js';
import { fitRect, initialRect, maximizedRect } from '../src/client/window-state.js';

test('窗口位置受视口约束，最大化始终居中且不覆盖旧还原位置', () => {
  const viewport = { width: 1455, height: 943 };
  const original = initialRect(viewport);
  assert.equal(original.x*2+original.width, viewport.width);
  assert.equal(original.y*2+original.height, viewport.height);
  const full = maximizedRect(viewport);
  assert.equal(full.x*2+full.width, viewport.width);
  assert.equal(full.y*2+full.height, viewport.height);
  assert.deepEqual(fitRect({ ...original, x: -200, y: 5000 }, viewport), { ...original, x: 0, y: viewport.height-original.height });
  assert.ok(fitRect(original, { width: 420, height: 380 }).width <= 420);
  assert.deepEqual(initialRect(viewport), original);
});

test('真实 Core 会话状态：旧 preset 失效仍可读取和原生选择目录；Remote 不恢复 Agent、不放行子会话', async () => {
  const folder = await mkdtemp(resolve('.test-output/ui-regression-'));
  const game = join(folder, 'game'); await mkdir(game);
  let observation = { header: { id: 'legacy-root', cwd: folder, agentPreset: 'minimal-v3' }, events: [], [Symbol.dispose]() {} };
  let picks = 0, resumptions = 0;
  const ctx = new Context();
  ctx.provide('sessionQuery', { observeSession: async () => observation });
  ctx.provide('agents', { resolveAgent: async () => { resumptions++; throw new Error('不应恢复 Agent'); } });
  const presets = ctx.plugin({ apply(scope) { scope.provide('agentPresets', { resolve: async () => { throw Object.assign(new Error('Unknown agent preset'), { code: 'agent-preset/not-found' }); } }); } });
  await presets.await();
  ctx.provide('directoryPicker', { capability: () => ({ kind: 'native', pick: async () => { picks++; return game; } }) });
  const service = new TranslationService({ pythonExecutable: process.env.DSH_TRANSLATE_PYTHON ?? 'python', dataDirectory: join(folder, 'state') });
  let ui;
  const scope = ctx.plugin({ inject: ['sessionQuery'], apply: injected => { ui = new TranslationUi(injected, service); } });
  await scope.await();
  const request = action => ui.request(observation.header.id, JSON.stringify({ action }), new AbortController().signal).then(JSON.parse);
  try {
    const snapshot = await request('snapshot');
    assert.equal(snapshot.ok, true); assert.match(snapshot.value.agentIssue, /minimal-v3/);
    const chosen = await request('pick-game');
    assert.equal(chosen.ok, true); assert.equal(chosen.value.state.selected_game, game);
    assert.equal(picks, 1); assert.equal(resumptions, 0);
    const nativeGame = join(folder, 'native-picked'); await mkdir(nativeGame);
    const nativeChoice = JSON.parse(await ui.acceptNativeDirectory(observation.header.id, 'pick-game', nativeGame, new AbortController().signal));
    assert.equal(nativeChoice.ok, true); assert.equal(nativeChoice.value.state.selected_game, nativeGame);
    assert.equal(picks, 1); assert.equal(resumptions, 0); // native shell does not use the DSH picker or resume an Agent.
    const marker = remoteMethods(ui).find(row => row.method === 'request');
    assert.equal(marker.resources.session('legacy-root'), 'legacy-root');
    validateTypertManifest('dsh-game-translate', TYPERT);
    assert.deepEqual(REMOTE_INFO.descriptors[0].parameters.map(row => row.name), ['sessionId', 'request']);
    observation = { ...observation, header: { ...observation.header, origin: 'subagent', delegationDepth: 1 } };
    const denied = await request('pick-game');
    assert.equal(denied.ok, false); assert.equal(picks, 1);
    const data = await readFile(join(folder, 'state', 'models.json'), 'utf8').catch(() => '');
    assert.equal(data, '');
  } finally { await service.dispose(); await scope.dispose(); await ctx.fiber.dispose(); }
});
