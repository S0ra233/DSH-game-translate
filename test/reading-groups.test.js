import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TranslationService } from '../src/service.js';
import { TranslationUi } from '../src/ui-remote.js';
import { NativeWindows } from '../src/native-windows.js';
import { registerUiHost } from '../src/ui-host.js';
import { readReadingGroupPages } from '../src/client/scene-reader.js';
import { nativeRequest } from './native-request.mjs';

test('通用分组保留来源/事件/显式分支边界、完整长 Scene、孤立姓名和不可变输入，译文变化不改分组', async () => {
  const script = `import sys,json,copy
sys.path[:0]=['python','python/vendor']
from reading_groups import build_groups, paragraph_count
scenes=[];entries=[];tasks=[]
def scene(id,file,kind='script_label',rows=1,context=None,path='/text'):
 s={'id':id,'title':file+':'+id,'kind':kind,'task_ids':[]}
 if context:s['source_context']=context
 scenes.append(s)
 for i in range(rows):
  tid=id+'-'+str(i);s['task_ids'].append(tid)
  entries.append({'scene_id':id,'file':file,'path':path})
  tasks.append({'id':tid,'scene_id':id,'type':'dialogue','text':'原文','speaker':'','status':'NONE','translation':'','revision':0})
scene('a','one.ks');scene('b','one.ks');scene('long','one.ks',rows=180);scene('c','one.ks');scene('d','two.ks')
scene('left','branch.ks',context={'branch':'left'});scene('right','branch.ks',context={'branch':'right'})
scene('event1','Map.json','event',path='/events/1/pages/0/list/0');scene('event2','Map.json','event',path='/events/2/pages/0/list/0')
scene('hard','one.ks',context={'hard_boundary':True});scene('last','one.ks')
manifest={'project_id':'p','scenes':scenes};before=copy.deepcopy([manifest,entries,tasks]);plan=build_groups(manifest,entries,tasks)
assert [g['scene_ids'] for g in plan['groups']]==[['a','b'],['long'],['c'],['d'],['left'],['right'],['event1'],['event2'],['hard'],['last']]
assert [manifest,entries,tasks]==before
for task in tasks:task.update(translation='人工修改',revision=7,status='PROCESSED')
after=build_groups(manifest,entries,tasks)
assert [g['id'] for g in plan['groups']]==[g['id'] for g in after['groups']]
assert all(g['counts'].get('PROCESSED')==g['task_count'] for g in after['groups'])
assert paragraph_count([{'id':'s','scene_id':'a','type':'speaker','text':'名'},{'id':'t','scene_id':'a','type':'dialogue','text':'文','speaker':'名'}])==1
assert paragraph_count([{'id':'s','scene_id':'a','type':'speaker','text':'名'}])==1
print(json.dumps({'ok':True,'groups':len(plan['groups'])}))`;
  const output = await new Promise((accept, reject) => {
    const child = spawn(process.env.DSH_TRANSLATE_PYTHON ?? 'python', ['-c', script], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => code === 0 ? accept(stdout) : reject(Error(stderr)));
  });
  assert.equal(JSON.parse(output).ok, true);
});

test('真实宿主/Worker/Core：150 个标签变成 2 组，分页覆盖、手改后稳定、翻译范围按原 ID 分批且不调用模型', async () => {
  const folder = await mkdtemp(resolve('.test-output/reading-groups-')), game = join(folder, 'game');
  await mkdir(join(game, 'data/scenario'), { recursive: true });
  const source = Array.from({ length: 150 }, (_, index) => `*label_${index}\n#ミナ\nこんにちは、また明日。[p]\n`).join('\n');
  await writeFile(join(game, 'data/scenario/story.ks'), source);
  const service = new TranslationService({ pythonExecutable: process.env.DSH_TRANSLATE_PYTHON ?? 'python', dataDirectory: join(folder, 'state') });
  const observation = { header: { id: 'group-root', cwd: folder }, events: [], [Symbol.dispose]() {} };
  const call = async (operation, args = {}) => (await service.callObserved(observation, operation, args, { human: { uiActionId: 'groups-code-test', rawInput: operation } })).data;
  const ctx = new Context(); ctx.provide('sessionQuery', { observeSession: async () => observation });
  let ui; const scope = ctx.plugin({ inject: ['sessionQuery'], apply: injected => { ui = new TranslationUi(injected, service); } }); await scope.await();
  const native = new NativeWindows({ on() {}, get: name => name === 'translationUi' ? ui : undefined }, service);
  const record = { sessionId: observation.header.id, lifetime: new AbortController() };
  const request = (action, args) => nativeRequest(resolve('native/wpf/TranslationWindow-0.3.7.exe'), record.sessionId, action, args, message => native.dispatch(record, message));
  const api = async (action, args) => { const result = await request(action, args); if (!result.ok) throw Error(result.error); return result.value; };
  try {
    const begin = await call('begin', { game_dir: game }); const ready = await call('prepare', { request_id: begin.request.request_id }); const pid = ready.binding.project_id;
    const listed = await api('reading-groups', { project_id: pid });
    assert.equal(listed.original_scene_count, 150); assert.equal(listed.total, 2);
    const first = listed.groups[0]; assert.equal(first.scene_ids.length, 140); assert.equal(first.paragraph_count, 140);
    const published = [], meta = []; let reads = 0;
    await readReadingGroupPages({ projectId: pid, groupId: first.id, current: () => true, sections: value => meta.push(value), publish: value => published.push(value), api: async (...args) => { reads++; return api(...args); } });
    assert.equal(reads, 2); assert.equal(meta[0].length, 140); assert.equal(published[0].length, 200); assert.equal(published.at(-1).length, 280);
    assert.equal(new Set(published.at(-1).map(task => task.id)).size, 280);
    const resolved = await call('resolve_reading_groups', { project_id: pid, group_ids: [first.id] });
    assert.deepEqual(resolved.scene_batches.map(batch => batch.length), [100, 40]); assert.deepEqual(resolved.scene_ids, first.scene_ids);
    for (const task of published[0].filter(task => task.scene_id === first.scene_ids[0])) {
      const edited = await api('edit-translation', { project_id: pid, task_id: task.id, translation: task.type === 'speaker' ? '米娜' : '你好，明天见。', expected_revision: task.revision, expected_source_hash: task.source_hash, expected_translation: task.translation });
      assert.equal(edited.task.revision, 1);
    }
    const changed = await api('reading-groups', { project_id: pid });
    assert.deepEqual(changed.groups.map(group => group.id), listed.groups.map(group => group.id));
    assert.equal(changed.groups[0].counts.PROCESSED, 2);
    const inbox = []; let handler;
    registerUiHost({ commands: { register(command) { handler = command.handler; } } }, service);
    const agent = { id: record.sessionId, session: { header: observation.header, snapshotEvents: () => [] }, followup: value => inbox.push(value) };
    const invoke = args => handler({ agent, commandId: 'groups-human', rawInput: JSON.stringify({ action: 'translate', mode: 'main', ...args }) });
    assert.equal((await invoke({ project_id: pid, group_ids: [first.id] })).kind, 'success');
    assert.equal(inbox.length, 1); assert.match(JSON.stringify(inbox[0]), /scene_batches/);
    assert.equal((await invoke({ project_id: pid, group_ids: ['g_missing'] })).kind, 'error');
    assert.equal((await invoke({ project_id: 'stale-project', group_ids: [first.id] })).kind, 'error');
    assert.equal(inbox.length, 1);
    await assert.rejects(api('reading-group', { project_id: pid, group_id: 'g_missing' }), /当前工程不符/);
    assert.equal((await call('scene', { project_id: pid, scene_id: first.scene_ids[0] })).total, 2);
    assert.equal(await readFile(join(game, 'data/scenario/story.ks'), 'utf8'), source);
  } finally { await service.dispose(); await scope.dispose(); await ctx.fiber.dispose(); }
});

test('切换阅读组后不发布旧页或旧分节元数据', async () => {
  const published = [], sections = []; let release, current = true;
  const request = readReadingGroupPages({ projectId: 'p', groupId: 'g', current: () => current, publish: value => published.push(value), sections: value => sections.push(value), api: async () => new Promise(resolve => { release = resolve; }) });
  current = false; release({ project_id: 'p', group: { id: 'g' }, sections: [{ id: 's' }], tasks: [{ id: 't' }], next_offset: null }); await request;
  assert.deepEqual(published, []); assert.deepEqual(sections, []);
});
