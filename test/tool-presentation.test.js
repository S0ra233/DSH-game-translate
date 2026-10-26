import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { toolArguments, toolView } from '../src/tool-presentation.js';
import { registerTools } from '../src/tools.js';
import { TranslationService } from '../src/service.js';

test('工具摘要只改变模型展示：原始数据/完整文本/真实翻译包保持完整', () => {
  const scenes = Array.from({length:400}, (_,i)=>({id:'s'+i,task_ids:Array.from({length:20},(_,n)=>'t'+i+'_'+n)}));
  const raw={ok:true,data:{status:'project_ready',binding:{project_id:'p',phase:'project_ready'},report:{tasks:8000,scenes,engine:{family:'tyrano',variant:'ks'}}}};
  const before=JSON.stringify(raw),view=toolView('prepare',raw);
  assert.equal(JSON.stringify(raw),before);assert.equal(toolView('prepare',raw,'full'),raw);
  assert.ok(JSON.stringify(view).length<before.length/20);assert.equal(view.data.report.scene_count,400);
  const status=toolView('status',{ok:true,data:{state:{binding:{phase:'project_ready',project_id:'p'},grants:['private']},user_message:{id:'real-user',text:'long conversation'},recent_operations:[{log:'private path'}]}});
  assert.equal(status.data.user_message.id,'real-user');assert.ok(!JSON.stringify(status).includes('private'));assert.ok(!JSON.stringify(status).includes('long conversation'));
  const fullText='原文'.repeat(5000),rows={ok:true,data:{group:{id:'g',scene_ids:['s'],task_ids:['t']},tasks:[{id:'t',text:fullText,translation:fullText,protected_text:'duplicate',structure:{kind:'dialogue'}}]}};
  const read=toolView('reading_group',rows);assert.equal(read.data.tasks[0].text,fullText);assert.equal(read.data.tasks[0].translation,fullText);assert.equal(read.data.group.scene_count,1);assert.equal(read.data.tasks[0].protected_text,undefined);
  for(const operation of ['package','read_package','save_draft','read_draft','apply','build'])assert.equal(toolView(operation,rows),rows);
  assert.deepEqual(toolArguments('scenes',{}),{limit:20});assert.deepEqual(toolArguments('scene',{limit:100,detail:'full'}),{limit:100});assert.throws(()=>toolArguments('status',{detail:'bad'}));
});

test('宿主工具执行返回完整规范值，渲染才摘要；分页默认生效且 detail 不进入 Worker',async()=>{
  const tools=[],calls=[],raw={ok:true,data:{groups:[{id:'g',scene_ids:['s'],task_ids:['t']}],total:1,next_offset:null}};
  registerTools({tools:{register:t=>tools.push(t)}},{call:async(...args)=>{calls.push(args);return raw}},x=>x);
  const tool=tools.find(t=>t.name==='translation_reading_groups'),exec={agent:{id:'a'},signal:new AbortController().signal};
  assert.equal(await tool.execute({project_id:'p',detail:'full'},exec),raw);assert.deepEqual(calls[0][2],{project_id:'p',limit:20});
  assert.ok(!tool.output.render({},raw)[0].text.includes('task_ids'));assert.equal(tool.output.render({detail:'full'},raw)[0].text,JSON.stringify(raw));
});

test('真实 Core 报告按需分页，限制报告名和工程；无需重复解包',async()=>{
  const dir=await mkdtemp(resolve('.test-output/report-')),game=join(dir,'game');await mkdir(join(game,'data'),{recursive:true});
  const source=JSON.stringify([null,{id:1,name:'Alice',nickname:'Friend',profile:''}]);await writeFile(join(game,'data','Actors.json'),source);
  const service=new TranslationService({pythonExecutable:process.env.DSH_TRANSLATE_PYTHON??'python',dataDirectory:join(dir,'state')});
  const agent={id:'reports',session:{header:{id:'reports',cwd:dir},snapshotEvents:()=>[{type:'user/message',id:'confirm-test-output',source:{kind:'user'},content:[{type:'text',text:'确认封装到测试输出目录。'}]}]}},call=async(op,args={})=>(await service.call(agent,op,args)).data;
  try{
    const request=await call('begin',{game_dir:game}),prepared=await call('prepare',{request_id:request.request.request_id}),project_id=prepared.binding.project_id;
    const pack=await call('package',{project_id});
    const draft=await call('save_draft',{project_id,package_id:pack.id,results:pack.target_ids.map((id,i)=>({id,translation:'样例'+i,uncertain:false}))});
    await call('apply',{project_id,draft_id:draft.draft_id,expected_revision:draft.revision});
    await call('build',{project_id,output_dir:join(dir,'output'),confirmation_message_id:'confirm-test-output'});
    const report=await readFile(join(prepared.binding.work_dir,'verify_report.json'),'utf8');
    let combined='',offset=0;do{const page=await call('read_report',{project_id,report:'verify',offset,limit:90});combined+=page.text;offset=page.next_offset;}while(offset!==null);
    assert.equal(combined,report.replace(/^\uFEFF/,''));
    const reject=code=>error=>error.result?.error?.code===code;
    await assert.rejects(call('read_report',{project_id,report:'../tasks.jsonl'}),reject('invalid_report'));
    await assert.rejects(call('read_report',{project_id:'other',report:'extraction'}),reject('project_changed'));
    await assert.rejects(call('read_report',{project_id,report:'extraction',limit:0}),reject('invalid_page'));
    await assert.rejects(call('read_report',{project_id,report:'extraction'}),reject('report_unavailable'));
    assert.equal(await readFile(join(game,'data','Actors.json'),'utf8'),source);
  }finally{await service.dispose()}
});
