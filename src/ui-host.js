import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 专用 UI 命令不记录原始参数，尤其不将 API key 写入 command/run。 */
export function registerUiHost(ctx, service) {
  ctx.commands.register({ name: 'translation-ui', description: '翻译窗口的用户操作接口', recordInput: false,
    async handler(invocation) {
      let body;
      try {
        body = JSON.parse(invocation.rawInput);
        if (!body || typeof body.action !== 'string') throw new Error('操作格式不正确');
        const { action, ...args } = body;
        const options = { signal: invocation.signal, human: { commandId: invocation.commandId, rawInput: action } };
        const call = async (op, value = {}) => (await service.call(invocation.agent, op, value, options)).data;
        if (action === 'snapshot') {
          const { state } = await call('status');
          const binding = state.binding;
          let stamp = '';
          if (binding?.work_dir) {
            try { const value = await stat(join(binding.work_dir, 'tasks.jsonl')); stamp = `${value.mtimeMs}:${value.size}`; } catch {}
          }
          return ok({ state, stamp, models: await service.models?.list() ?? [],
            modelsAvailable: Boolean(service.models), nativePicker: ctx.get('directoryPicker')?.capability().kind === 'native' });
        }
        if (action === 'scenes' || action === 'scene') return ok(await call(action, args));
        if (action === 'reading-groups' || action === 'reading-group') return ok(await call(action.replaceAll('-', '_'), args));
        if (action === 'pick-game' || action === 'pick-output') {
          const capability = ctx.get('directoryPicker')?.capability();
          if (capability?.kind !== 'native') throw new Error('此 DSH 组合没有原生目录选择器，请启用本机 directory-picker-native');
          const picked = await capability.pick(invocation.signal);
          if (!picked) return ok({ cancelled: true });
          if (action === 'pick-game') {
            await call('authorize_game', { game_dir: picked });
            return ok(await call('select_game', { game_dir: picked }));
          }
          await call('authorize_work', { path: picked });
          const { state } = await call('status');
          return ok({ output_dir: join(picked, `${basename(state.binding?.game_dir ?? 'game')}-translated-${Date.now()}`) });
        }
        if (action === 'initialize') {
          const { state } = await call('status');
          const game = state.selected_game ?? state.binding?.game_dir;
          if (!game) throw new Error('请先选择游戏目录');
          const result = await call('begin', { game_dir: game });
          if (result.status === 'initialization_requested') {
            try { enqueue(invocation.agent, `用户在翻译窗口确认初始化（会消耗模型额度）。先加载 game-translation Skill，使用 translation_prepare 处理以下真实请求。所有工作与错误反馈留在本对话；失败保留产物，可修复后重试。\n${JSON.stringify(result.request)}`, result.request.request_id); }
            catch (error) { await call('abandon', { request_id: result.request.request_id, reason: '原会话派发失败' }); throw error; }
          }
          return ok(result);
        }
        if (action === 'translate') {
          const { state } = await call('status');
          if (state.binding?.phase !== 'project_ready') throw new Error('请先完成初始化');
          let selection;
          if (args.group_ids !== undefined) {
            const resolved = await call('resolve_reading_groups', { project_id: args.project_id, group_ids: args.group_ids });
            if (!resolved.scene_ids.length) throw new Error('所选分组已无待处理内容，请刷新后查看。');
            selection = { group_ids: resolved.group_ids, scene_batches: resolved.scene_batches };
          } else {
            if (!Array.isArray(args.scene_ids) || !args.scene_ids.length || args.scene_ids.length > 100 || new Set(args.scene_ids).size !== args.scene_ids.length) throw new Error('请选择 1 至 100 个不重复的场景');
            selection = { scene_ids: args.scene_ids };
          }
          if (!['main', 'delegate'].includes(args.mode)) throw new Error('翻译方式不正确');
          if (args.model_id) service.models?.get(args.model_id);
          enqueue(invocation.agent, `用户在翻译窗口请求翻译以下工程/场景，禁止自行扩大范围。阅读组是来源容器，组内标签/分支不代表一条线性剧情，保留原 Scene/Task 身份。先按 Skill 逐场景导出真实包，scene_batches 每批最多 100 个原 Scene；包仍受字符预算和控制码校验。${args.mode === 'delegate' ? '使用 translation_delegate 交 DSH 原生子 Agent（选定模型见 model_id；未选则继承主模型），读取真实终态后由你审校并统一保存草稿、提交 Core。' : '由你翻译、审校并通过 Core 保存。'}不要封装，待用户核对后确认。\n${JSON.stringify({ project_id: state.binding.project_id, ...selection, model_id: args.model_id ?? null })}`);
          return ok({ status: 'queued', message: '翻译请求已交给当前对话的 Agent。' });
        }
        if (action === 'build') {
          const consent = await call('approve_build', { output_dir: args.output_dir });
          enqueue(invocation.agent, `用户已在翻译窗口检查结果并确认封装。按 Skill 调用 translation_build，不能改写输出位置或工程身份。build 内含读回；无疑点不重复 verify。反馈实际报告、警告和运行未验证边界。\n${JSON.stringify({ project_id: consent.project_id, output_dir: consent.output_dir, confirmation_message_id: consent.id })}`);
          return ok({ status: 'queued', message: '封装确认已交给当前对话 Agent，详细结果在原聊天。' });
        }
        if (action === 'save-model') {
          if (!service.models) throw new Error('DSH llm/credentials 服务尚未就绪');
          return ok(await service.models.save(args));
        }
        throw new Error('未知翻译窗口操作');
      } catch (error) {
        const secret = body?.apiKey;
        const message = secret ? String(error.message).replaceAll(secret, '••••') : String(error.message);
        return { kind: 'error', text: message };
      }
    } });
}

function ok(data) { return { kind: 'success', text: JSON.stringify(data) }; }
function enqueue(agent, text, initializationRequestId) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-translate', form: 'notice', summary: '用户在翻译窗口发起本对话任务',
    ...(initializationRequestId ? { initializationRequestId } : {}) } }));
}
