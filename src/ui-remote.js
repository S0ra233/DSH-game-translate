import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol';

const initializers = [];
const ACTIONS = new Set(['snapshot', 'scenes', 'scene', 'reading-groups', 'reading-group', 'pick-game', 'pick-output', 'save-model', 'edit-translation']);

/** 目录与阅读只观察 Session；旧预设缺失不能阻断系统目录选择器。 */
export class TranslationUi extends TypertRemoteService {
  constructor(ctx, service) {
    super(ctx, 'translationUi');
    for (const initialize of initializers) initialize.call(this);
    this.translationService = service;
  }

  async openNative(sessionId, rawAppearance, signal) {
    try {
      if (principalOf(this.ctx.invocation) !== undefined) throw new Error('只有 DSH 本机所有者可以打开宿主原生窗口');
      if (rawAppearance.length > 4096) throw new Error('窗口外观参数过大');
      if (!this.translationService.nativeWindows) throw new Error('原生窗口服务尚未就绪');
      return success(await this.translationService.nativeWindows.open(sessionId, JSON.parse(rawAppearance), signal));
    } catch (error) { return JSON.stringify({ ok: false, error: String(error.message) }); }
  }

  /** 仅接收自有窗口进程的本机 QFileDialog 结果，不对网页公开路径授权接口。 */
  async acceptNativeDirectory(sessionId, action, directory, signal) {
    if (!['pick-game', 'pick-output'].includes(action)) throw new Error('目录操作不正确');
    const observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
    try {
      this.translationService.sessionContext(observation.header, observation.events);
      if (!directory) return success({ cancelled: true });
      const options = { signal, human: { uiActionId: randomUUID(), rawInput: action } };
      const call = async (op, args = {}) => (await this.translationService.callObserved(observation, op, args, options)).data;
      if (action === 'pick-game') {
        await call('authorize_game', { game_dir: directory });
        return success(await call('select_game', { game_dir: directory }));
      }
      await call('authorize_work', { path: directory });
      const { state } = await call('status');
      return success({ output_dir: join(directory, `${basename(state.binding?.game_dir ?? 'game')}-translated-${Date.now()}`) });
    } finally { observation[Symbol.dispose](); }
  }

  async request(sessionId, raw, signal) {
    let body, observation;
    try {
      if (raw.length > 100000) throw new Error('翻译窗口请求过大');
      body = JSON.parse(raw);
      if (!body || !ACTIONS.has(body.action)) throw new Error('此接口只接受阅读、目录选择和设置操作');
      const { action, ...args } = body;
      const owner = principalOf(this.ctx.invocation) === undefined;
      if (!owner && ['save-model', 'pick-game', 'pick-output', 'edit-translation'].includes(action)) throw new Error('只有 DSH 本机所有者可以选择宿主目录、配置翻译模型或手改译文');
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' });
      const options = { signal, human: { uiActionId: randomUUID(), rawInput: action } };
      const call = async (operation, value = {}) => (await this.translationService.callObserved(observation, operation, value, options)).data;
      if (action === 'save-model') {
        // 即使只是设置也核对真实根会话，不能借子任务地址修改父工程设置。
        this.translationService.sessionContext(observation.header, observation.events);
        if (!this.translationService.models) throw new Error('DSH 模型/凭据服务尚未就绪');
        return success(await this.translationService.models.save(args));
      }
      if (action === 'edit-translation') return success(await call('edit_translation', args));
      if (action === 'reading-groups' || action === 'reading-group') return success(await call(action.replaceAll('-', '_'), args));
      if (action === 'scenes' || action === 'scene') return success(await call(action, args));
      if (action === 'pick-game' || action === 'pick-output') {
        this.translationService.sessionContext(observation.header, observation.events);
        const capability = this.ctx.get('directoryPicker')?.capability();
        if (capability?.kind !== 'native') throw new Error('当前宿主没有本机原生目录选择器，请启用 directory-picker-native');
        const picked = await capability.pick(signal);
        if (!picked) return success({ cancelled: true });
        if (action === 'pick-game') {
          await call('authorize_game', { game_dir: picked });
          return success(await call('select_game', { game_dir: picked }));
        }
        await call('authorize_work', { path: picked });
        const { state } = await call('status');
        return success({ output_dir: join(picked, `${basename(state.binding?.game_dir ?? 'game')}-translated-${Date.now()}`) });
      }
      const { state } = await call('status');
      const presets = this.ctx.get('agentPresets');
      const preset = observation.events.findLast(event => event.type === 'agent-preset/selected')?.agentPreset
        ?? observation.header.agentPreset ?? presets?.defaultId;
      const [stamp, agentIssue, models] = await Promise.all([
        (async () => {
          if (state.binding?.work_dir) try { const file = await stat(join(state.binding.work_dir, 'tasks.jsonl')); return `${file.mtimeMs}:${file.size}`; } catch {}
          return '';
        })(),
        (async () => {
          if (preset && presets) try { await presets.resolve(preset); }
          catch (error) { if (error.code === 'agent-preset/not-found') return `此对话引用的 Agent 预设 ${preset} 已不存在。目录选择和阅读可用；开始 Agent 任务前，请在 DSH 恢复该预设，或使用有效预设的新对话。`; else throw error; }
          return '';
        })(),
        owner ? this.translationService.models?.list() ?? [] : [],
      ]);
      return success({ state, stamp, agentIssue, models,
        modelsAvailable: owner && Boolean(this.translationService.models), nativePicker: owner && this.ctx.get('directoryPicker')?.capability().kind === 'native' });
    } catch (error) {
      const secret = body?.apiKey;
      return JSON.stringify({ ok: false, error: secret ? String(error.message).replaceAll(secret, '••••') : String(error.message) });
    } finally { observation?.[Symbol.dispose](); }
  }
}

// 按公开标准装饰器契约标记方法；所有 Remote 调用按实际 sessionId 做资源访问检查。
Remote({ resources: { session: sessionId => sessionId } })(TranslationUi.prototype.request,
  { name: 'request', kind: 'method', private: false, static: false, addInitializer: fn => initializers.push(fn) });
Remote({ resources: { session: sessionId => sessionId } })(TranslationUi.prototype.openNative,
  { name: 'openNative', kind: 'method', private: false, static: false, addInitializer: fn => initializers.push(fn) });
function success(value) { return JSON.stringify({ ok: true, value }); }

export function registerUiRemote(ctx, service) {
  ctx.inject(['sessionQuery'], scope => { new TranslationUi(scope, service); });
}
