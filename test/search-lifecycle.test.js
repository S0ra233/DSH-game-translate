import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { SearchWorker } from '../src/search-worker.js';

const python = process.env.DSH_TRANSLATE_PYTHON ?? 'python';
async function run(args) {
  const child = spawn(python, ['-B', ...args], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise((accept, reject) => { child.on('error', reject); child.once('close', accept); });
  assert.equal(code, 0, stderr); return stdout.trim();
}

test('真实冷构建连续输入只完成一份索引、取消不丢失已发布快照、关闭可回收', { timeout: 60000 }, async () => {
  const folder = await run(['test/fixtures/synthetic-project.py', '12000']);
  assert.ok(resolve(folder).startsWith(resolve('.test-output')));
  const request = JSON.parse(await readFile(join(folder, 'request.json'), 'utf8'));
  const config = { ...request.config, pythonExecutable: python };
  const worker = new SearchWorker(config, () => {});
  const first = worker.request({ ...request, config }).then(value => ({ value }), error => ({ cancelled: error.message.includes('cancelled') }));
  await delay(230);
  const started = performance.now();
  const burst = Array.from({ length: 100 }, (_, i) => worker.request({ ...request, config, args: { ...request.args, query: { fields: { target: { text: i === 99 ? '明天' : '过期条件'+i } } } } })
    .then(value => ({ value }), error => ({ cancelled: error.message.includes('cancelled') })));
  assert.equal((await first).cancelled, true);
  assert.ok(performance.now()-started < 200, 'superseded input settles without waiting for Core/index building');
  assert.equal(worker.pending.size, 1);
  const results = await Promise.all(burst);
  assert.equal(results.filter(value => value.cancelled).length, 99);
  const result = results.at(-1).value;
  assert.equal(result.ok, true); assert.equal(result.data.hits.length, 40);
  assert.equal(result.data.metrics.build_count, 1, 'a shared cold build is not restarted for each key');
  const reading = { ...request, config, args: { ...request.args, client_id: 'reader' } };
  assert.equal((await worker.request(reading)).ok, true);
  worker.release('perf'); assert.equal(worker.closed, false, 'closing the search pane retains the active reader');
  assert.equal((await worker.request(reading)).ok, true);
  worker.release('reader'); await worker.done;

  const script = `import sys,json\nfrom pathlib import Path\nfrom threading import Event\nsys.path[:0]=['python','python/vendor']\nfrom session import TranslationSession\nfrom search_index import SearchIndex\nfrom storage import PluginError\nr=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))\ns=TranslationSession(r,Event());i=SearchIndex(s);i.query(s,r['args']);generation=i.meta('generation')\np=s.bound_work()/'tasks.jsonl';tasks=[json.loads(t) for t in p.read_text(encoding='utf-8').splitlines()];tasks[0]['translation']='全新译文';tasks[0]['revision']+=1;p.write_text(''.join(json.dumps(t,ensure_ascii=False)+'\\n' for t in tasks),encoding='utf-8')\ncount=0\ndef trace(sql):\n global count\n if sql.startswith('INSERT INTO docs'):\n  count+=1\n  if count==40:s.cancelled.set()\ni.db.set_trace_callback(trace)\ntry:\n i.ensure(s)\n raise AssertionError('cancel was ignored')\nexcept PluginError as error:\n assert error.code=='cancelled'\ni.db.set_trace_callback(None);assert i.meta('generation')==generation;assert i.db.execute('SELECT target FROM docs ORDER BY doc_id LIMIT 1').fetchone()[0]!='全新译文'\ns.cancelled.clear();fresh=i.query(s,{'query':{'fields':{'target':{'text':'全新译文'}}}});assert len(fresh['hits'])==1;assert fresh['generation']!=generation;i.close();print('rollback-ok')`;
  assert.equal(await run(['-c', script, join(folder, 'request.json')]), 'rollback-ok');

  const secondDirectory = join(folder, 'second-state');
  await cp(join(config.dataDirectory, 'sessions'), join(secondDirectory, 'sessions'), { recursive: true });
  const otherConfig = { ...config, dataDirectory: secondDirectory };
  const closing = new SearchWorker(otherConfig, () => {});
  const pending = closing.request({ ...request, config: otherConfig }).catch(error => error);
  await delay(200); const closeStarted = performance.now(); closing.close();
  assert.ok(await pending instanceof Error); await closing.done;
  assert.ok(performance.now()-closeStarted < 2500, 'closing reclaims its own worker promptly');
  const reopened = new SearchWorker(otherConfig, () => {});
  try { const ready = await reopened.request({ ...request, config: otherConfig }); assert.equal(ready.ok, true); }
  finally { reopened.close(); await reopened.done; }
});
