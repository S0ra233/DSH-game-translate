import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TranslationService } from '../src/service.js';
import { apply } from '../src/index.js';
import { Context } from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { OPERATIONS } from '../src/tools.js';

const base = resolve('.test-output');
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, 'backend-'));
const pythonExecutable = process.env.DSH_TRANSLATE_PYTHON ?? 'python';

function agent(workspace, id = 'root-a') {
  return { id, session: { header: { id, cwd: workspace }, snapshotEvents: () => [{ type: 'user/message', id: 'u-confirm', source: { kind: 'user' }, content: [{ type: 'text', text: '翻译已检查，确认封装。' }] }] }, inbox: [], followup(message) { this.inbox.push(message); } };
}

async function fixture(name) {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  const service = new TranslationService({ pythonExecutable, dataDirectory: join(workspace, 'plugin-data') });
  return { workspace, service, owner: agent(workspace), call: async (op, args = {}, options) => (await service.call(agent(workspace), op, args, options)).data };
}

async function game(workspace, name, actor = 'Alice') {
  const path = join(workspace, name);
  await mkdir(join(path, 'data'), { recursive: true });
  await writeFile(join(path, 'data', 'Actors.json'), JSON.stringify([null, { id: 1, name: actor, nickname: 'Friend', profile: '' }]));
  return path;
}

const errorCode = code => error => error.result?.error?.code === code;

test('真实 Core 闭环：绑定、防重、完整草稿、重复提交、用户引用与独立副本', async () => {
  const { workspace, service, owner, call } = await fixture('e2e');
  const gameA = await game(workspace, 'game-a');
  const original = await readFile(join(gameA, 'data', 'Actors.json'), 'utf8');
  const begin = await call('begin', { game_dir: gameA });
  const requestId = begin.request.request_id;
  const prepared = await call('prepare', { request_id: requestId });
  const projectId = prepared.binding.project_id;
  assert.equal(prepared.binding.phase, 'project_ready');
  assert.equal((await call('begin', { game_dir: gameA })).status, 'already_initialized');
  const restarted = new TranslationService({ pythonExecutable, dataDirectory: join(workspace, 'plugin-data') });
  assert.equal((await restarted.call(owner, 'status')).data.state.binding.project_id, projectId);
  assert.equal((await service.call(agent(workspace, 'root-b'), 'status')).data.state.binding, null);
  await assert.rejects(call('package', { project_id: 'wrong' }), errorCode('project_changed'));

  const packageValue = await call('package', { project_id: projectId });
  const args = { project_id: projectId, package_id: packageValue.id };
  const taskFile = join(prepared.binding.work_dir, 'tasks.jsonl');
  const before = await readFile(taskFile, 'utf8');
  await assert.rejects(call('save_draft', { ...args, results: [] }), errorCode('incomplete_targets'));
  assert.equal(await readFile(taskFile, 'utf8'), before);
  const results = packageValue.target_ids.map((id, index) => ({ id, translation: `译文${index}`, uncertain: false }));
  const draft = await call('save_draft', { ...args, results });
  await assert.rejects(call('save_draft', { ...args, results, draft_id: draft.draft_id, expected_revision: 0 }), errorCode('draft_conflict'));
  const submission = { project_id: projectId, draft_id: draft.draft_id, expected_revision: draft.revision };
  const applied = await call('apply', submission);
  assert.equal(applied.report.counts.PROCESSED, results.length);
  assert.equal((await call('apply', submission)).report.duplicate, true);
  const output = join(workspace, 'output-a');
  await assert.rejects(call('build', { project_id: projectId, output_dir: output, confirmation_message_id: 'fake' }), errorCode('confirmation_required'));
  const built = await call('build', { project_id: projectId, output_dir: output, confirmation_message_id: 'u-confirm' });
  assert.equal(built.success, true);
  assert.equal(built.verification.indexed_values_match, true);
  assert.equal(built.runtime_verified, false);
  assert.equal(await readFile(join(gameA, 'data', 'Actors.json'), 'utf8'), original);

  const newPackage = await call('package', { project_id: projectId, target_ids: packageValue.target_ids });
  const newDraft = await call('save_draft', { ...args, package_id: newPackage.id, results });
  await writeFile(join(prepared.binding.work_dir, 'style.md'), '术语和风格已改变。');
  const after = await readFile(taskFile, 'utf8');
  await assert.rejects(call('apply', { ...submission, draft_id: newDraft.draft_id }), /过期/);
  assert.equal(await readFile(taskFile, 'utf8'), after);

  const gameB = join(workspace, 'game-b');
  await mkdir(gameB);
  const notice = await call('begin', { game_dir: gameB });
  assert.equal(notice.status, 'switch_notice');
  const switching = await call('begin', { game_dir: gameB, notice_token: notice.notice_token });
  await assert.rejects(call('prepare', { request_id: requestId }), errorCode('stale_request'));
  await assert.rejects(call('prepare', { request_id: switching.request.request_id }));
  assert.equal((await call('status')).state.binding.game_dir, gameA);
  assert.equal((await call('status')).state.pending, null);
  await game(workspace, 'game-b', 'Bob');
  const notice2 = await call('begin', { game_dir: gameB });
  const next = await call('begin', { game_dir: gameB, notice_token: notice2.notice_token });
  const readyB = await call('prepare', { request_id: next.request.request_id });
  assert.notEqual(readyB.binding.project_id, projectId);
  await assert.rejects(call('prepare', { request_id: requestId }), errorCode('stale_request'));
  await assert.rejects(call('apply', submission), errorCode('project_changed'));
  await service.dispose(); await restarted.dispose();
});

const adapter = `from pathlib import Path
from time import sleep
from game_translation.process_control import check_cancelled
def probe(game): return {"family":"test", "evidence":["自编样例"]}
def font_options(info): return []
def prepare(info, work):
    Path(work).mkdir(parents=True, exist_ok=True)
    (Path(work)/"resource.bin").write_bytes(b"self-authored-resource")
    for _ in range(1000):
        check_cancelled()
        sleep(0.01)
    return {"root":str(work)}
def extract(info, resources): raise ValueError("自编样例提取失败")
def read(path, entries): return []
def write(path, entries): return 0
def configure_font(*args): return {}
`;

test('真实取消与锁：失败资源保留但不锁定初始化，运行中不重复初始化', async () => {
  const { workspace, service, call } = await fixture('cancellation');
  const gameA = await game(workspace, 'game');
  const work = join(workspace, 'work');
  const request = await call('begin', { game_dir: gameA, work_dir: work });
  await mkdir(work);
  const adapterFile = join(work, 'adapter.py');
  await writeFile(adapterFile, adapter);
  const abort = new AbortController();
  const running = call('prepare', { request_id: request.request.request_id, options: { adapter_file: adapterFile } }, { signal: abort.signal });
  // 提前绑定拒绝处理器，避免取消后出现未处理 Promise。
  const settled = running.then(value => ({ value }), error => ({ error }));
  let exists = false;
  for (let i = 0; i < 100; i++) {
    try { await access(join(work, 'resource.bin')); exists = true; break; } catch { await delay(30); }
  }
  assert.equal(exists, true, JSON.stringify(await Promise.race([settled, delay(1).then(() => null)])));
  assert.equal((await call('status')).state.pending.phase, 'preparing');
  await assert.rejects(call('begin', { game_dir: gameA }), errorCode('busy'));
  abort.abort(new Error('自编取消验证'));
  const outcome = await settled;
  assert.equal(outcome.error?.result?.error?.code, 'cancelled');
  const state = (await call('status')).state;
  assert.equal(state.binding, null);
  assert.ok(state.initialization_error.partial_resources.length);
  assert.equal(state.pending, null);
  assert.equal((await call('begin', { game_dir: gameA })).status, 'initialization_requested');
  const record = await call('job', { job_id: outcome.error.result.job_id });
  assert.equal(record.status, 'cancelled');
  await access(join(work, 'resource.bin'));
  await service.dispose();
});

test('来源与目录范围：模型不能自授权、不能伪造会话、不能读越界 Skill', async () => {
  const { workspace, service, owner, call } = await fixture('scope');
  const outside = await game(root, 'outside');
  await assert.rejects(call('begin', { game_dir: outside }), errorCode('directory_access_required'));
  await assert.rejects(call('authorize_game', { game_dir: outside }), errorCode('user_only'));
  await service.call(owner, 'authorize_game', { game_dir: outside }, { human: { commandId: 'human-grant', rawInput: outside } });
  assert.equal((await call('begin', { game_dir: outside })).status, 'initialization_requested');
  const child = agent(workspace, 'child'); child.session.header.origin = 'subagent';
  await assert.rejects(service.call(child, 'status'), /子 Agent/);
  await assert.rejects(service.readSkill('../../package.json'), /资料路径/);
  assert.match((await service.readSkill('references/dsh.md')).text, /宿主适配/);
  await service.dispose();
});

test('官方 defineTool 与消息实现：全部工具注册、命令去重、投递回原会话', async () => {
  const workspace = join(root, 'host-registration'); await mkdir(workspace);
  const tools = [], commands = [], skills = [], cleanup = [];
  let service;
  const ctx = { inject: () => {}, tools: { register: tool => tools.push(tool) }, commands: { register: command => commands.push(command) }, skills: { register: skill => skills.push(skill) },
    provide: (_name, value) => { service = value; }, effect: effect => { cleanup.push(effect()); } };
  apply(ctx, { pythonExecutable, dataDirectory: join(workspace, 'plugin-data') });
  assert.equal(tools.length, OPERATIONS.length + 1 + 3); // operations + Skill resource + native delegation tools
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
  assert.equal(skills[0].name, 'game-translation');
  assert.match(skills[0].content, /DSH 游戏翻译/);
  assert.match(skills[0].content, /translation_status/);
  const owner = agent(workspace);
  const status = tools.find(tool => tool.name === 'translation_status');
  const result = await status.execute({}, { agent: owner, signal: new AbortController().signal });
  assert.equal(result.data.state.binding, null);
  const gameA = await game(workspace, 'game');
  const invoke = rawInput => commands.find(row => row.name === 'translation').handler({ agent: owner, commandId: 'actual-user-command', rawInput, signal: new AbortController().signal });
  assert.equal((await invoke(`init ${JSON.stringify({ game_dir: gameA })}`)).kind, 'success');
  assert.equal(owner.inbox.length, 1);
  assert.equal(owner.inbox[0].source.kind, 'dsh-translate');
  assert.equal((await invoke(`init ${JSON.stringify({ game_dir: gameA })}`)).kind, 'success');
  assert.equal(owner.inbox.length, 1);
  for (const dispose of cleanup) await dispose();
  assert.equal(service.closed, true);
});

test('真实 Cordis 生命周期：官方工具/命令/Skill 服务加载并撤回插件贡献', async () => {
  const workspace = join(root, 'cordis-runtime'); await mkdir(workspace);
  const ctx = new Context();
  // 此处只替代不参与本次工具注册的提示词座，不创建模型或调用网络。
  ctx.provide('systemPrompt', { tools: () => () => {} });
  const tools = ctx.plugin(ToolsService); await tools.await();
  const commands = ctx.plugin(CommandRuntime); await commands.await();
  const skills = ctx.plugin(SkillRegistry); await skills.await();
  const plugin = ctx.plugin({ name: 'dsh-translate-test', inject: ['tools', 'commands', 'skills'], apply },
    { pythonExecutable, dataDirectory: join(workspace, 'plugin-data') });
  try {
    await plugin.await();
    assert.ok(ctx.tools.get('translation_status'));
    assert.equal((await ctx.skills.get('game-translation')).resourceBase.kind, 'directory');
    const response = await ctx.tools.get('translation_status').execute({}, { agent: agent(workspace), signal: new AbortController().signal });
    assert.equal(response.data.state.binding, null);
  } finally {
    await plugin.dispose();
  }
  assert.equal(ctx.tools.get('translation_status'), undefined);
  assert.equal(await ctx.skills.get('game-translation'), undefined);
  await skills.dispose(); await commands.dispose(); await tools.dispose();
});
