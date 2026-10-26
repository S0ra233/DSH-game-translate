import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { TranslationService } from './service.js';
import { registerTools } from './tools.js';
import { TranslationModels } from './models.js';
import { registerDelegation } from './delegation.js';
import { registerUiHost } from './ui-host.js';
import { registerUiRemote } from './ui-remote.js';
import { registerNativeWindows } from './native-windows.js';

export const name = 'dsh-game-translate';
export const inject = ['tools', 'commands', 'skills'];

/** Host 业务统一供原生工具、命令和翻译 Client 使用。 */
export function apply(ctx, config = {}) {
  const service = new TranslationService(config);
  ctx.provide('translation', service);
  ctx.effect(() => () => service.dispose(), 'dsh-translate: workers');
  registerTools(ctx, service, defineTool);
  registerUiHost(ctx, service);
  registerNativeWindows(ctx, service);
  registerUiRemote(ctx, service);
  registerDelegation(ctx, service);
  ctx.inject(['llm', 'credentials'], scope => {
    const models = new TranslationModels(scope, service.config.dataDirectory);
    scope.effect(() => () => models.dispose(), 'translation: model routes');
    return models.load().then(() => { service.models = models; });
  });

  const root = fileURLToPath(new URL('../skills/game-translation/', import.meta.url));
  const skillFile = `${root}/SKILL.md`;
  const body = readFileSync(skillFile, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  ctx.skills.register({
    name: 'game-translation', description: '在当前根对话初始化游戏、按真实 Scene 翻译并经 Core 提交；用户确认后构建独立副本。',
    source: 'bundled', path: skillFile, resourceBase: { kind: 'directory', path: root }, content: body,
  });

  // 官方命令名只接受 ASCII；中文 /翻译 由 Client 输入触发器接入。
  ctx.commands.register({
    name: 'translation', description: '游戏翻译窗口；带参数时使用后台 status、allow-game、init、translate、build、abandon。',
    input: { hint: 'status | allow-game {"game_dir":"..."} | init {"game_dir":"..."} | translate {"scene_id":"..."} | build {"output_dir":"..."}' },
    async handler(invocation) {
      const raw = invocation.rawInput.trim();
      const split = raw.search(/\s/u);
      const verb = (split < 0 ? raw : raw.slice(0, split)) || 'status';
      const input = split < 0 ? '' : raw.slice(split).trim();
      const human = { commandId: invocation.commandId, rawInput: raw };
      const call = (operation, args = {}) => service.call(invocation.agent, operation, args, { signal: invocation.signal, human });
      try {
        const args = input ? JSON.parse(input) : {};
        if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('命令参数须为 JSON 对象');
        if (verb === 'status') return success(await call('status'));
        if (verb === 'allow-game') return success(await call('authorize_game', args));
        if (verb === 'abandon') return success(await call('abandon', args));
        if (verb === 'init') {
          const result = await call('begin', args);
          if (result.data.status !== 'initialization_requested') return success(result);
          const request = result.data.request;
          try {
            enqueue(invocation.agent, `用户通过 /translation init 请求初始化游戏。${request.notice ?? ''}\n先加载 game-translation Skill 并读取 references/dsh.md，然后使用 translation_prepare，request_id=${request.request_id}。游戏与 WORK 见下列真实登记记录；所有处理和错误在本对话反馈。\n${JSON.stringify(request)}`, request.request_id);
          } catch (error) {
            await call('abandon', { request_id: request.request_id, reason: `会话派发失败：${error.message}` });
            throw error;
          }
          return success({ ...result, dispatch: 'accepted_into_agent_inbox', message: '任务已进入本会话 Agent 收件队列；不代表模型请求已开始。' });
        }
        if (verb === 'translate') {
          if (Object.keys(args).some(key => !['scene_id', 'target_ids'].includes(key))) throw new Error('翻译命令仅接受 scene_id 和 target_ids');
          const result = await call('status');
          const binding = result.data.state.binding;
          if (binding?.phase !== 'project_ready') throw new Error('请先在原聊天完成 Core 翻译工程初始化');
          enqueue(invocation.agent, `用户通过 /translation translate 请求翻译下列范围。先按 Skill 读取真实包；可使用宿主实际开放的子 Agent/模型，由你审查并提交。若工程身份已改变则停止并说明；不要封装游戏，封装需之后用户确认。\n${JSON.stringify({ project_id: binding.project_id, binding_version: binding.version, ...args })}`);
          return { kind: 'success', text: '翻译请求已进入当前会话 Agent 收件队列，反馈仍在本对话。' };
        }
        if (verb === 'build') {
          const result = await call('status');
          return success(await call('build', { ...args, project_id: result.data.state.binding?.project_id,
            confirmation_message_id: `command:${invocation.commandId}` }));
        }
        throw new Error('支持 status、allow-game、init、translate、build、abandon；独立窗口入口为 /翻译');
      } catch (error) {
        return { kind: 'error', text: error.message };
      }
    },
  });
}

function success(value) { return { kind: 'success', text: JSON.stringify(value) }; }

function enqueue(agent, text, initializationRequestId) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }],
    source: { kind: 'dsh-translate', form: 'notice', summary: '用户通过翻译命令发起本会话任务',
      ...(initializationRequestId ? { initializationRequestId } : {}) } }));
}
