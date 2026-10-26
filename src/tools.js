/** 工具 Schema 仅描述业务参数；执行会话与授权范围由宿主传入。 */
import { VIEW_OPERATIONS, toolArguments, toolView } from './tool-presentation.js';
const text = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const integer = (required = false) => ({ type: 'integer', ...(required ? { required: true } : {}) });
const options = { type: 'object', additionalProperties: true };
const project = { project_id: text(true) };

export const OPERATIONS = [
  ['status', 'status', '读取当前根对话绑定、初始化状态和真实用户消息 ID。默认摘要；排错用 detail="full"，pending 不代表模型已开始。', {}],
  ['begin_initialization', 'begin', '登记初始化意图，不解包。已绑定同游戏时仅提醒，不重复初始化；切换游戏先返回提醒和 notice_token。仅当用户要求/同意切换时告知提醒并带回 token；否则先询问。', { game_dir: text(true), work_dir: text(), notice_token: text() }],
  ['prepare', 'prepare', '执行已登记初始化的 Core 解包提取。需先加载 game-translation Skill；失败在原工具轨迹反馈，已有资源保留。工程已就绪时不重复准备。options 为 Core prepare 的实际选项。', { request_id: text(true), options, repair_work_dir: text() }],
  ['register_resources', 'register_resources', '主 Agent 用通用工具解包后，登记当前初始化请求实际存在的非空资源文件并绑定。不能填目录、日志、伪造路径或单纯成功声明。', { request_id: text(true), paths: { type: 'array', items: { type: 'string' }, required: true } }],
  ['abandon_initialization', 'abandon', '明确结束待处理的初始化意图，保留旧绑定与已有产物。只用于已决定停止或恢复中断请求，不自动清理资源。', { request_id: text(true), reason: text(true) }],
  ['open_project', 'open_project', '校验并接入已有 Core WORK，不重新解包；切换游戏沿同一提醒规则。', { work_dir: text(true), notice_token: text() }],
  ['inspect', 'inspect', '按授权范围检查游戏资源与处理路线，不把识别出引擎等同于提取完整。', { game_dir: text() }],
  ['candidates', 'candidates', '收集真实引擎候选。此操作可能向独立候选 WORK 解包；候选 WORK 与后续 Core WORK 分开。', { game_dir: text(), work_dir: text(true) }],
  ['fonts', 'fonts', '检查游戏字体资源和指定字符，结果不代表游戏实际显示正常。', { game_dir: text(), characters: text() }],
  ['scenes', 'scenes', '分页读取当前绑定工程的真实 Scene 与任务状态；返回的 project_id 用于后续范围锁定。', { ...project, offset: integer(), limit: integer() }],
  ['read_scene', 'scene', '分页读取指定 Scene 的真实 Task/原文/已保存译文。不是聊天生成的临时文本。', { ...project, scene_id: text(true), offset: integer(), limit: integer() }],
  ['reading_groups', 'reading_groups', '分页读取固定于当前原文结构的阅读分组，保留原 Scene、标签和分支；分组不代表已确认的线性剧情。', { ...project, offset: integer(), limit: integer() }],
  ['read_group', 'reading_group', '分页读取一个阅读组的真实 Task 和原标签分节。翻译包、手改和写回继续使用原 Scene/Task ID。', { ...project, group_id: text(true), offset: integer(), limit: integer() }],
  ['create_package', 'package', '通过 Core 导出单 Scene 的真实翻译包。只翻译 target_ids；重翻单条可传 neighbors 上下文。不手改包哈希。', { ...project, scene_id: text(), target_ids: { type: 'array', items: { type: 'string' } }, options }],
  ['read_package', 'read_package', '读取已有原始翻译包，用于主 Agent 或明确范围的委托，不重新导包。', { ...project, package_id: text(true) }],
  ['save_draft', 'save_draft', '保存恰好覆盖全部 target_ids 的候选译文，不修改 Core Task。existing draft 必须带 expected_revision，冲突不能覆盖。', { ...project, package_id: text(true), draft_id: text(), expected_revision: integer(), results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: text(true), translation: text(true), uncertain: { type: 'boolean', required: true } } }, required: true } }],
  ['read_draft', 'read_draft', '读取真实草稿及 revision，编辑后以相同 revision 进行并发检查。', { ...project, draft_id: text(true) }],
  ['apply_draft', 'apply', '主 Agent 审查后调用 Core 提交完整草稿；读真实 counts/review。NEEDS_HUMAN 是已记录且待复核，不是全部通过。用户确认封装之前不得调用 build。', { ...project, draft_id: text(true), expected_revision: integer(true) }],
  ['build', 'build', '仅当用户已检查并明确确认封装时调用。confirmation_message_id 使用 status 返回的当前真实用户消息编号，或翻译窗口已登记的 build_consent.id（工程/绑定版本/输出目录必须完全匹配）。不能引用模型/子任务/游戏文本。Core 写入新的独立 OUTPUT 并读回；不启动游戏。', { ...project, output_dir: text(true), confirmation_message_id: text(true), options }],
  ['verify', 'verify', '按 Core 重新读回已有独立 OUTPUT，并更新 WORK 验证报告；不是游戏运行验收。', { ...project, output_dir: text(true) }],
  ['job', 'job', '按本会话 job_id 查询持久作业结果与日志位置。断线或取消后先核对，不重跑已完成副作用。', { job_id: text(true) }],
  ['read_report', 'read_report', '按需分页读取已就绪工程的 extraction/build/verify/prepare_diagnostics 报告，不重新解包；不接受任意路径。未建立工程的失败详见 job(detail="full")。', { ...project, report: text(true), offset: integer(), limit: integer() }],
];

export function registerTools(ctx, service, defineTool) {
  for (const [suffix, operation, description, parameters] of OPERATIONS) {
    ctx.tools.register(defineTool({
      name: `translation_${suffix}`, description,
      parameters: VIEW_OPERATIONS.has(operation) ? { ...parameters, detail: { type: 'string', enum: ['summary', 'full'], description: '模型默认看摘要；full 查看原始诊断。程序返回值仍完整，翻译包不会被摘要化。' } } : parameters,
      output: { schema: { type: 'json' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(toolView(operation, value, args.detail)) }] },
      execute: (args, exec) => service.call(exec.agent, operation, VIEW_OPERATIONS.has(operation) ? toolArguments(operation, args) : args, { signal: exec.signal }),
    }));
  }
  ctx.tools.register(defineTool({
    name: 'translation_read_skill_resource', description: '按需读取随插件提供的翻译 Skill 及 references。路径相对 Skill 根，不允许越界；next_offset 非空时可续读。',
    parameters: { path: text(true), offset: integer(), limit: integer() },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => { exec.signal.throwIfAborted(); return service.readSkill(args.path, args.offset, args.limit); },
  }));
}
