import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDelegation } from '../src/delegation.js';

function setup(){
  const registered=[],children=[],requests=[];let invalid=false,failStart=false,disposals=0;
  const subagents={getProvider:()=>({}),startActivation:async request=>{
    requests.push(request);if(failStart)throw Error('start failed');let complete,fail;
    const child={childId:'child-'+(children.length+1),result:new Promise((yes,no)=>{complete=yes;fail=no}),dispose:async()=>{disposals++}};
    children.push({...child,complete,fail});return child;
  }};
  const ctx={tools:{register:t=>registered.push(t)},inject:()=>{},effect:()=>{},get:()=>subagents};
  const service={models:{get:()=>({provider:'configured',model:'other',maxTokens:100})},call:async(_agent,op,args)=>{assert.equal(op,'read_package');if(invalid)throw Error('project changed');return {data:{id:args.package_id,target_ids:['t']}}}};
  registerDelegation(ctx,service);const tools=Object.fromEntries(registered.map(t=>[t.name,t]));
  const exec={agent:{id:'parent'},signal:new AbortController().signal},run=(name,args,execution=exec)=>tools['translation_'+name].execute(args,execution);
  return {run,exec,children,requests,setInvalid:()=>{invalid=true},setFailure:value=>{failStart=value},disposed:()=>disposals};
}
const args={project_id:'p',package_id:'pkg'};
const result={stopReason:'completed',structured:{results:[{id:'t',translation:'译文',uncertain:false}]},output:[]};

test('委托去重覆盖同时点击、运行中与已完成；显式重试、模型和绑定校验保持独立',async()=>{
  const s=setup();const [a,b]=await Promise.all([s.run('delegate',args),s.run('delegate',args)]);
  assert.equal(a.child_id,b.child_id);assert.equal(s.requests.length,1);assert.equal(s.requests[0].delivery,'parent');
  assert.equal((await s.run('delegate',{...args,retry:true})).reused,true);
  s.children[0].complete(result);await Promise.resolve();assert.equal((await s.run('delegate',args)).reused,true);
  const retried=await s.run('delegate',{...args,retry:true});assert.notEqual(retried.child_id,a.child_id);
  await s.run('delegate',{...args,model_id:'m'});assert.equal(s.requests.length,3);assert.equal(s.requests[2].request.agentOptions.provider,'configured');
  s.setInvalid();await assert.rejects(s.run('delegate',args),/project changed/);
});

test('单项/批量等待返回真实状态；超时和取消等待不取消子任务，越会话拒绝',async()=>{
  const s=setup(),a=await s.run('delegate',args),b=await s.run('delegate',{...args,package_id:'other'});
  const snapshot=await s.run('delegation_result',{child_id:a.child_id});assert.equal(snapshot.status,'running');assert.equal(snapshot.can_resubmit,false);assert.equal(snapshot.terminal,false);
  const ids=[a.child_id,b.child_id];assert.equal((await s.run('wait_delegations',{child_ids:ids,timeout_ms:0})).timed_out,false);
  assert.equal((await s.run('wait_delegations',{child_ids:ids,timeout_ms:5})).timed_out,true);assert.equal(s.disposed(),0);
  const wait=s.run('wait_delegations',{child_ids:ids,mode:'any',timeout_ms:1000});s.children[0].complete(result);
  const any=await wait;assert.deepEqual(any.completed_ids,[a.child_id]);assert.equal(any.children[0].structured,undefined);
  assert.equal((await s.run('delegation_result',{child_id:a.child_id,wait_ms:20})).structured.results[0].translation,'译文');
  const controller=new AbortController(),cancelled=s.run('delegation_result',{child_id:b.child_id,wait_ms:1000},{...s.exec,signal:controller.signal});controller.abort(Error('cancel wait'));
  await assert.rejects(cancelled,/cancel wait/);assert.equal(s.disposed(),0);
  const all=s.run('wait_delegations',{child_ids:ids,mode:'all',timeout_ms:1000});s.children[1].complete(result);assert.equal((await all).completed_ids.length,2);
  await assert.rejects(s.run('delegation_result',{child_id:a.child_id},{...s.exec,agent:{id:'other-parent'}}));
  await assert.rejects(s.run('wait_delegations',{child_ids:[a.child_id,a.child_id]}));await assert.rejects(s.run('delegation_result',{child_id:a.child_id,wait_ms:60001}));
});

test('启动失败可恢复，结果读取失败为终态；取消前请求不派发',async()=>{
  const s=setup();s.setFailure(true);await assert.rejects(s.run('delegate',args),/start failed/);
  s.setFailure(false);const a=await s.run('delegate',args);s.children[0].fail(Error('private failure'));await Promise.resolve();
  const failed=await s.run('delegation_result',{child_id:a.child_id});assert.equal(failed.status,'error');assert.equal(failed.terminal,true);assert.ok(!JSON.stringify(failed).includes('private failure'));
  const aborted=new AbortController();aborted.abort();await assert.rejects(s.run('delegate',args,{...s.exec,signal:aborted.signal}));assert.equal(s.children.length,1);
});
