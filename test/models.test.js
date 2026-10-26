import './workspace.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import { TranslationModels } from '../src/models.js';
import { registerDelegation } from '../src/delegation.js';

const base = resolve('.test-output'); await mkdir(base, { recursive: true });

function sse(events, named = false) {
  return events.map(item => `${named ? `event: ${item.type}\n` : ''}data: ${JSON.stringify(item)}\n\n`).join('');
}
const finalMessage = { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] };
const fixtures = {
  'openai-completions': sse([
    { id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
    { id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ])+'data: [DONE]\n\n',
  'openai-responses': sse([
    { type: 'response.created', response: { id: 'resp-1', model: 'test-model', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...finalMessage, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
    { type: 'response.output_item.done', output_index: 0, item: finalMessage },
    { type: 'response.completed', response: { id: 'resp-1', model: 'test-model', status: 'completed', output: [finalMessage], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
  ], true),
  'anthropic-messages': sse([
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ], true),
  'google-generative-ai': sse([{ candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }]),
};

test('真实 DSH 适配：四协议请求/工具声明/流式结果、持久化脱敏与密钥隔离', async () => {
  const directory = await mkdtemp(join(base, 'models-'));
  const credentials = new Map();
  const ctx = new Context();
  ctx.provide('credentials', { set: async (ref, value) => credentials.set(ref, value), resolve: async ref => ({ value: credentials.get(ref) }), describe: async ref => ({ configured: credentials.has(ref), writable: true }) });
  const fiber = ctx.plugin(LlmRuntime); await fiber.await();
  const models = new TranslationModels(ctx, directory); await models.load();
  const savedFetch = globalThis.fetch;
  let active, captured;
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options);
    captured = { url: request.url, headers: request.headers, body: JSON.parse(await request.text()) };
    return new Response(fixtures[active], { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    await assert.rejects(models.save({ name: '空密钥', protocol: 'openai-completions', baseURL: 'https://translate.test/v1', apiKey: '   ', model: 'test-model' }), /新模型需要 API key/);
    assert.equal(credentials.size, 0);
    for (const protocol of Object.keys(fixtures)) {
      active = protocol;
      const secret = `test-only-${protocol}`;
      const saved = await models.save({ name: protocol, protocol, baseURL: protocol === 'google-generative-ai' ? 'https://translate.test/v1beta' : 'https://translate.test/v1', apiKey: secret, model: 'test-model' });
      const entry = models.get(saved.id);
      const catalog = await ctx.llm.listModels(entry.provider);
      assert.equal(catalog.length, 1);
      const chunks = [];
      for await (const chunk of ctx.llm.stream({ provider: entry.provider, model: entry.model, messages: [createUserMessage({ content: [{ type: 'text', text: 'Translate' }], source: { kind: 'user' } })],
        tools: [{ name: 'echo', description: '示例工具', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }], maxTokens: 100 })) chunks.push(chunk);
      assert.ok(JSON.stringify(chunks).includes('你好'), protocol);
      const request = captured;
      assert.ok(request, protocol);
      if (protocol === 'openai-completions') { assert.match(request.url, /\/v1\/chat\/completions$/); assert.equal(request.body.tools[0].function.name, 'echo'); }
      if (protocol === 'openai-responses') { assert.match(request.url, /\/v1\/responses$/); assert.equal(request.body.tools[0].name, 'echo'); }
      if (protocol === 'anthropic-messages') { assert.match(request.url, /\/v1\/messages/); assert.equal(request.body.tools[0].name, 'echo'); }
      if (protocol === 'google-generative-ai') { assert.match(request.url, /\/v1beta\/models\/test-model:streamGenerateContent/); assert.equal(request.body.tools[0].functionDeclarations[0].name, 'echo'); }
      assert.ok(!JSON.stringify(await models.list()).includes(secret));
      assert.ok(!(await readFile(join(directory, 'models.json'), 'utf8')).includes(secret));
    }
  } finally { globalThis.fetch = savedFetch; models.dispose(); await fiber.dispose(); }
});

test('翻译委托仅调用 DSH 原生 startActivation，并把结构化结果交回主 Agent', async () => {
  const tools = [], activation = { childId: 'child-1', result: Promise.resolve({ stopReason: 'completed', structured: { results: [{ id: 't-1', translation: '你好', uncertain: false }] }, output: [] }), dispose: async () => {} };
  let request;
  const ctx = { tools: { register: tool => tools.push(tool) }, inject: () => {}, effect: () => {},
    get: name => name === 'subagents' ? { getProvider: () => ({}), startActivation: async value => { request = value; return activation; } } : undefined };
  const service = { models: { get: () => ({ provider: 'translation-route', model: 'test-model', maxTokens: 100 }) }, call: async () => ({ data: { id: 'p-1', target_ids: ['t-1'] } }) };
  registerDelegation(ctx, service);
  const agent = { id: 'parent-1' }, exec = { agent, signal: new AbortController().signal };
  const started = await tools[0].execute({ project_id: 'project-1', package_id: 'p-1', model_id: 'configured-model' }, exec);
  assert.equal(started.child_id, 'child-1');
  assert.equal(request.request.parent, agent);
  assert.equal(request.request.agentOptions.provider, 'translation-route');
  assert.equal(request.delivery, 'parent');
  assert.equal(request.request.outputSchema.type, 'object');
  const result = await tools[1].execute({ child_id: 'child-1' }, exec);
  assert.equal(result.structured.results[0].translation, '你好');
  await assert.rejects(tools[1].execute({ child_id: 'child-1' }, { ...exec, agent: { id: 'other' } }));
});
