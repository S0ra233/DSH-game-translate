import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TranslationService } from '../src/service.js';
import { TranslationUi } from '../src/ui-remote.js';
import { readingRows, saveTranslation } from '../src/client/reading-rows.js';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeWindows } from '../src/native-windows.js';
import { nativeRequest } from './native-request.mjs';

test('实际阅读组件输出同行姓名和方括号，旁白无姓名；正常态无编辑框，原文只读', async () => {
  const folder = await mkdtemp(resolve('.test-output/reader-render-')), outfile = join(folder, 'reader.mjs');
  await build({ entryPoints: ['src/client/Reader.jsx'], bundle: true, platform: 'node', format: 'esm', outfile, external: ['react'], jsx: 'transform' });
  const { PairedText } = await import(pathToFileURL(outfile).href);
  const html = renderToStaticMarkup(React.createElement(PairedText, { tasks: [
    { id: 'name', type: 'speaker', text: '小春', translation: '小春', scene_id: 's' },
    { id: 'dialogue', type: 'dialogue', speaker: '小春', text: 'まだ帰らないの？', translation: '还不回去吗？', scene_id: 's' },
    { id: 'narrative', type: 'dialogue', speaker: '', text: '風が吹いた。', translation: '风吹了起来。', scene_id: 's' },
  ], api() {}, projectId: 'p', onEditing() {}, onSaved() {} }));
  assert.equal((html.match(/class="text-pair"/g) || []).length, 2);
  assert.match(html, /<p><span class="speaker">小春 <\/span>\[<span>まだ帰らないの？<\/span>\]<\/p>/);
  assert.match(html, /<span class="speaker">小春 <\/span>\[<span>还不回去吗？<\/span>\]/);
  assert.match(html, /<p><span>風が吹いた。<\/span><\/p>/);
  assert.ok(!html.includes('textarea') && !html.includes('contenteditable'));
});

test('说话人和对应台词合为一行，保留旁白、孤立姓名和源 Task；跨 Scene 不串人名', () => {
  const name = { id: 'name', type: 'speaker', text: '小春', translation: '小春', scene_id: 's' };
  const text = { id: 'text', type: 'dialogue', speaker: '小春', text: 'また帰らないの？', scene_id: 's' };
  const next = { ...text, id: 'next' };
  const narrative = { id: 'narrative', type: 'dialogue', speaker: '', text: '窓の外で風が吹いた。', scene_id: 's' };
  const orphan = { ...name, id: 'orphan', scene_id: 'other' };
  const other = { ...text, id: 'other-text', scene_id: 'third' };
  const tasks = [name, text, next, narrative, orphan, other];
  const unchanged = structuredClone(tasks), rows = readingRows(tasks);
  assert.deepEqual(rows.map(row => row.task.id), ['text', 'next', 'narrative', 'orphan', 'other-text']);
  assert.equal(rows[0].speakerTask, name); assert.equal(rows[1].speakerTask, name);
  assert.equal(rows.at(-1).speakerTask, null); assert.deepEqual(tasks, unchanged);
  assert.equal(readingRows([name])[0].task, name); // First page must not destroy an unpaired Task.
});

test('手改请求仅发送译文和乐观锁，走本机读取/编辑通道', async () => {
  const calls = [], task = { id: 'task', revision: 4, source_hash: 'source', translation: '旧译文', text: '原文不应被提交为可修改字段' };
  await saveTranslation(async (...args) => { calls.push(args); }, 'project', task, '新译文');
  assert.deepEqual(calls, [['edit-translation', { project_id: 'project', task_id: 'task', translation: '新译文', expected_revision: 4, expected_source_hash: 'source', expected_translation: '旧译文' }]]);
});

test('真实编译宿主→Node→Remote→Core 手改：版本/标签保护、旧包失效、封装读回', async () => {
  const folder = await mkdtemp(resolve('.test-output/manual-edit-'));
  const game = join(folder, 'game'); await mkdir(join(game, 'data'), { recursive: true });
  await writeFile(join(game, 'data/Actors.json'), JSON.stringify([null, { id: 1, name: 'ミナ', nickname: '', profile: '' }]));
  const original = JSON.stringify({ displayName: '図書館', events: [null, { id: 1, pages: [{ list: [
    { code: 101, indent: 0, parameters: ['', 0, 0, 2, 'ミナ'] },
    { code: 401, indent: 0, parameters: ['\\C[2]こんにちは\\C[0] %s'] }, { code: 0, indent: 0, parameters: [] },
  ] }] }] });
  await writeFile(join(game, 'data/Map001.json'), original);
  const service = new TranslationService({ pythonExecutable: process.env.DSH_TRANSLATE_PYTHON ?? 'python', dataDirectory: join(folder, 'state') });
  const observation = { header: { id: 'manual-root', cwd: folder }, events: [], [Symbol.dispose]() {} };
  const agent = { id: observation.header.id, session: { header: observation.header, snapshotEvents: () => [] } };
  const call = async (operation, args = {}, human = {}) => (await service.call(agent, operation, args, { human })).data;
  const ctx = new Context(); ctx.provide('sessionQuery', { observeSession: async () => observation });
  let ui; const scope = ctx.plugin({ inject: ['sessionQuery'], apply: injected => { ui = new TranslationUi(injected, service); } });
  await scope.await();
  const native = new NativeWindows({ on() {}, get: name => name === 'translationUi' ? ui : undefined }, service);
  const record = { sessionId: 'manual-root', lifetime: new AbortController() };
  const request = (action, args) => nativeRequest(resolve('native/wpf/TranslationWindow-0.3.7.exe'), record.sessionId, action, args, message => native.dispatch(record, message));
  try {
    const begin = await call('begin', { game_dir: game });
    const ready = await call('prepare', { request_id: begin.request.request_id }); const pid = ready.binding.project_id;
    const scenes = (await call('scenes', { project_id: pid })).scenes;
    const event = scenes.find(scene => scene.kind === 'event');
    const initial = (await call('scene', { project_id: pid, scene_id: event.id })).tasks;
    const name = initial.find(row => row.type === 'speaker'), text = initial.find(row => row.type === 'dialogue');
    const stale = await call('package', { project_id: pid, target_ids: [text.id], options: { context: 'neighbors', window: 0 } });
    const edit = async (task, translation) => request('edit-translation', { project_id: pid, task_id: task.id, translation, expected_revision: task.revision, expected_source_hash: task.source_hash, expected_translation: task.translation });
    const saved = await edit(text, '\\C[2]你好\\C[0] %s'); assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.value.task.translation, '\\C[2]你好\\C[0] %s'); assert.equal(saved.value.task.revision, text.revision + 1);
    const taskFile = join(ready.binding.work_dir, 'tasks.jsonl'); const after = await readFile(taskFile, 'utf8');
    assert.equal((await edit(text, '不能覆盖新版本')).ok, false);
    const invalid = await edit(saved.value.task, '丢掉控制码'); assert.equal(invalid.ok, false); assert.match(invalid.error, /控制码/);
    assert.equal(await readFile(taskFile, 'utf8'), after);
    const forged = await request('edit-translation', { project_id: pid, task_id: text.id, text: '不能修改原文', translation: '伪造' });
    assert.equal(forged.ok, false); assert.equal(await readFile(taskFile, 'utf8'), after);
    const draft = await call('save_draft', { project_id: pid, package_id: stale.id, results: [{ id: text.id, translation: '{p0}旧模型译文{p1} {p2}', uncertain: false }] });
    await assert.rejects(call('apply', { project_id: pid, draft_id: draft.draft_id, expected_revision: draft.revision }), /过期/);
    assert.equal(await readFile(taskFile, 'utf8'), after);
    const current = (await call('scene', { project_id: pid, scene_id: event.id })).tasks;
    assert.deepEqual(current.find(row => row.id === name.id), name);
    assert.equal(current.find(row => row.id === text.id).text, text.text);
    assert.equal((await edit(name, '米娜')).ok, true);
    for (const scene of scenes.filter(row => row.id !== event.id)) {
      const tasks = (await call('scene', { project_id: pid, scene_id: scene.id })).tasks;
      for (const task of tasks) assert.equal((await edit(task, task.type === 'name' ? '米娜' : '图书馆')).ok, true);
    }
    const output = join(folder, 'output'); const approval = await call('approve_build', { output_dir: output }, { uiActionId: 'manual-test-build', rawInput: '确认封装测试副本' });
    const built = await call('build', { project_id: pid, output_dir: output, confirmation_message_id: approval.id });
    assert.equal(built.verification.indexed_values_match, true);
    const map = JSON.parse(await readFile(join(output, 'data/Map001.json'), 'utf8'));
    assert.equal(map.events[1].pages[0].list[0].parameters[4], '米娜');
    assert.equal(map.events[1].pages[0].list[1].parameters[0], '\\C[2]你好\\C[0] %s');
    assert.equal(await readFile(join(game, 'data/Map001.json'), 'utf8'), original);
  } finally { await service.dispose(); await scope.dispose(); await ctx.fiber.dispose(); }
});
