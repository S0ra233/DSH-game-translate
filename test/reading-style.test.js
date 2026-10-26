import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { headlessCheck } from './headless-check.mjs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { legacySample, sampleTranslation } from './fixtures/sample-translations.mjs';

test('测试翻译按 Task 类型填姓名；台词编号跟随原文，不按含姓名的 Task 下标递增', () => {
  assert.equal(sampleTranslation({ type: 'speaker', text: 'ミナ' }), '米娜');
  assert.equal(sampleTranslation({ type: 'name', text: 'ミナ' }), '米娜');
  assert.equal(sampleTranslation({ type: 'nickname', text: '友達' }), '朋友');
  assert.equal(sampleTranslation({ type: 'map_name', text: '朝の村' }), '清晨的村庄');
  const text = sampleTranslation({ type: 'dialogue', text: '007・朝の村。また明日、ここで会いましょう。' });
  assert.match(text, /^007・清晨的村庄。/);
  assert.match(text, /较长的中文译文/);
  assert.throws(() => sampleTranslation({ type: 'speaker', text: '真实游戏中的姓名' }), /synthetic/);
  assert.notEqual(legacySample(0), '米娜');
});

test('离屏 Chromium：切换纯白/玻璃后正文坐标、换行、行高及滚动位置一致（两种宿主、三种宽度）', { timeout: 45000 }, async t => {
  const browser = process.env.DSH_TEST_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  try { await access(browser); } catch { t.skip('需要本机 Chromium；不打开 DSH 或可见窗口'); return; }
  const folder = await mkdtemp(resolve('.test-output/reading-style-'));
  const outfile = join(folder, 'reader.mjs');
  await build({ entryPoints: ['src/client/Reader.jsx'], bundle: true, platform: 'node', format: 'esm', outfile, external: ['react'], jsx: 'transform' });
  const { PairedText } = await import(pathToFileURL(outfile).href);
  const tasks = Array.from({ length: 24 }, (_, index) => [
    { id: `speaker-${index}`, type: 'speaker', scene_id: index < 12 ? 's_a' : 's_b', text: 'ミナ', translation: '米娜' },
    { id: `text-${index}`, type: 'dialogue', scene_id: index < 12 ? 's_a' : 's_b', speaker: 'ミナ', text: `${index}・原文の長い文章です。`.repeat(index % 3 + 1), translation: `${index}・译文换行与正文坐标对照。`.repeat(index % 4 + 1) },
  ]).flat();
  const reader = renderToStaticMarkup(React.createElement(PairedText, { tasks, projectId: 'fixture', sections: ['s_a', 's_b'].map(id => ({ id, short_title: id, title: id, boundary: '标签片段', paragraph_count: 12 })) }));
  const css = await readFile('src/client/surface.css', 'utf8');
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><pre id="result">pending</pre><script>
    const css=${JSON.stringify(css)}, reader=${JSON.stringify(reader)};
    const frame=()=>new Promise(resolve=>setTimeout(resolve, 30));
    (async()=>{
      const reports=[];
      for(const native of [true,false]) for(const width of [1120,640,440]) {
        const iframe=document.createElement('iframe'); iframe.width=width; iframe.height=600;
        const loaded=new Promise(resolve=>iframe.onload=resolve);
        iframe.srcdoc='<html data-material-host="'+(native?'native':'browser')+'"><style>html,body{margin:0;height:100%;background:white}'+css+'</style><div class="dsh-translate" data-surface="white" '+(native?'data-native="true"':'')+' style="--reader-font-size:16px;--reader-line-height:1.8;--reader-left:50fr;--reader-right:50fr"><header class="reader-header"><select class="scene-pill"><option>data/Map001.json</option></select><div class="header-space"></div><button class="icon-pill">•••</button></header><div class="reader-scroll">'+reader+'</div></div></html>';
        document.body.append(iframe); await loaded;
        const doc=iframe.contentDocument, root=doc.querySelector('.dsh-translate'), scroll=doc.querySelector('.reader-scroll');
        await doc.fonts.ready;
        const settle=async()=>{for(let i=0;i<5;i++)await frame()};
        const rect=el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
        const measure=()=>({scrollTop:scroll.scrollTop,clientWidth:scroll.clientWidth,scrollHeight:scroll.scrollHeight,reader:rect(scroll),
          paragraphs:[...doc.querySelectorAll('.text-pair p')].slice(0,12).map(el=>{
            const range=doc.createRange();range.selectNodeContents(el);
            return {box:rect(el),lines:[...range.getClientRects()].map(r=>[r.x,r.y,r.width,r.height])};
          })});
        await settle(); measure(); scroll.scrollTop=260; await settle(); const before=measure();
        for(const surface of ['glass','white','glass']) {
          root.dataset.surface=surface; await settle(); const after=measure();
          reports.push({native,width,surface,before,after});
        }
        iframe.remove();
      }
      document.getElementById('result').textContent=JSON.stringify({reports});
    })().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:String(error),stack:error.stack}));
  </script>`;
  const file = join(folder, 'check.html'); await writeFile(file, html);
  const result = await headlessCheck(browser, folder, file);
  await writeFile(join(folder, 'result.html'), result);
  const encoded = /<pre id="result">([^<]*)<\/pre>/.exec(result)?.[1];
  assert.ok(encoded && encoded !== 'pending', 'Headless browser must finish measurements');
  const report = JSON.parse(encoded.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
  assert.ok(!report.error, report.error);
  assert.equal(report.reports.length, 18);
  for (const { native, width, surface, before, after } of report.reports) {
    assert.ok(before.scrollTop > 0 && before.clientWidth > 0 && before.paragraphs.some(row => row.lines.length > 1), '必须测到真实滚动与文字行');
    assert.deepEqual(after, before, `native=${native} width=${width} surface=${surface}`);
  }
  await writeFile(join(folder, 'report.json'), JSON.stringify({ cases: 18, equal: true, actualDSH: false }));
});
