import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';

export const PROTOCOLS = {
  'openai-completions': ['OpenAI Chat Completions', openAICompletionsApi],
  'openai-responses': ['OpenAI Responses', openAIResponsesApi],
  'anthropic-messages': ['Anthropic Messages', anthropicMessagesApi],
  'google-generative-ai': ['Gemini generateContent', googleGenerativeAIApi],
};

/** 只适配模型路由，流解析、工具往返与归属仍使用 DSH 的 PiAiAdapter。 */
export class TranslationModels {
  constructor(ctx, directory) {
    this.ctx = ctx; this.directory = directory; this.models = []; this.profiles = new Map();
    this.queue = Promise.resolve(); this.registration = null;
    this.adapter = new PiAiAdapter({ profiles: () => this.profiles,
      resolveApiKey: async (_provider, profile) => {
        const value = (await ctx.credentials.resolve(profile.apiKeyEnv))?.value;
        if (!value) throw new Error('翻译模型密钥未配置，请在设置中重新保存');
        return value;
      },
      // 本功能仅使用用户显式保存的 API key，不执行环境发现或 OAuth。
      auth: { credentials: { read: async () => undefined, list: async () => [],
        modify: async () => { throw new Error('翻译模型仅通过设置保存密钥'); }, delete: async () => {} },
      authContext: { env: async () => undefined, fileExists: async () => false } },
    });
  }

  async load() {
    try { this.models = JSON.parse(await readFile(join(this.directory, 'models.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.refresh();
  }

  refresh() {
    const profiles = new Map();
    for (const entry of this.models) {
      const model = { id: entry.model, name: entry.name, api: entry.protocol, provider: entry.provider,
        baseUrl: entry.baseURL, reasoning: false, input: ['text'],
        contextWindow: entry.contextWindow, maxTokens: entry.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const piProvider = createProvider({ id: entry.provider, name: entry.name, baseUrl: entry.baseURL,
        models: [model], api: PROTOCOLS[entry.protocol][1](),
        auth: { apiKey: { name: entry.name, resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: entry.name }) } } });
      profiles.set(entry.provider, { provider: entry.provider, displayName: entry.name, api: entry.protocol,
        baseURL: entry.baseURL, apiKeyEnv: entry.credentialRef, piProvider, modelErrors: new Map(),
        configuredMaxTokens: new Map([[entry.model, entry.maxTokens]]),
        streamIdleTimeoutMs: 180_000, maxRequestImageBytes: 20_971_520,
        requestImagePixelBudget: 4_194_304, requestImageMaxBytes: 1_048_576,
        retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } });
    }
    const previous = this.profiles; this.profiles = profiles;
    try {
      if (this.registration) this.registration.replace([...profiles.keys()]);
      else if (profiles.size) this.registration = this.ctx.llm.registerAdapter([...profiles.keys()], this.adapter);
    } catch (error) { this.profiles = previous; throw error; }
  }

  async list() {
    return Promise.all(this.models.map(async model => ({ ...model,
      hasKey: Boolean((await this.ctx.credentials.describe(model.credentialRef))?.configured),
      priceKnown: false })));
  }

  save(input) {
    const work = this.queue.catch(() => {}).then(async () => {
      const allowed = ['id', 'name', 'protocol', 'baseURL', 'model', 'apiKey', 'contextWindow', 'maxTokens'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('模型设置含未知字段');
      for (const key of ['name', 'model', 'baseURL']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error('名称、模型名称和 API 地址不能为空');
      if (!PROTOCOLS[input.protocol]) throw new Error('请选择四种受支持协议之一');
      const url = new URL(input.baseURL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址只接受无凭据/查询参数的 HTTP(S) 基址');
      // 用户填写基址；常见完整端点归一化，避免 /v1/v1 或重复方法。
      let baseURL = input.baseURL.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '');
      if (input.protocol === 'google-generative-ai') {
        baseURL = baseURL.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/, '');
        if (new URL(baseURL).pathname === '/') baseURL += '/v1beta';
      }
      const existing = input.id ? this.models.find(row => row.id === input.id) : null;
      if (input.id && !existing) throw new Error('待编辑模型已不存在');
      const id = existing?.id ?? randomUUID().replaceAll('-', '');
      const item = { id, name: input.name.trim(), protocol: input.protocol, baseURL,
        model: input.model.trim(), provider: `dsh-translate-${id}`, credentialRef: `DSH_TRANSLATE_${id.toUpperCase()}`,
        contextWindow: input.contextWindow ?? 65536, maxTokens: input.maxTokens ?? 8192 };
      if (![item.contextWindow, item.maxTokens].every(value => Number.isSafeInteger(value) && value > 0)
          || item.maxTokens >= item.contextWindow) throw new Error('上下文和输出上限须为正整数，输出上限须小于上下文上限');
      if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('API key 格式不正确');
      if (input.apiKey?.trim()) {
        if (/[\r\n]/.test(input.apiKey)) throw new Error('API key 格式不正确');
        await this.ctx.credentials.set(item.credentialRef, input.apiKey.trim());
      } else if (!existing) throw new Error('新模型需要 API key');
      const previous = this.models;
      this.models = [...previous.filter(row => row.id !== id), item];
      try {
        this.refresh();
        await mkdir(this.directory, { recursive: true });
        const temporary = join(this.directory, `models-${randomUUID()}.pending`);
        await writeFile(temporary, JSON.stringify(this.models), { mode: 0o600 });
        await rename(temporary, join(this.directory, 'models.json'));
      } catch (error) { this.models = previous; this.refresh(); throw error; }
      return { saved: true, id };
    });
    this.queue = work; return work;
  }

  get(id) {
    const model = this.models.find(row => row.id === id);
    if (!model) throw new Error('所选翻译模型已不存在，请重新选择');
    return model;
  }

  dispose() { this.registration?.(); }
}
