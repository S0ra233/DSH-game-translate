/** Model-facing views only. Worker/Core values and UI Remote responses stay complete. */
export const VIEW_OPERATIONS = new Set(['status', 'prepare', 'scenes', 'reading_groups', 'scene', 'reading_group', 'job']);
export const PAGE_DEFAULTS = { scenes: 20, reading_groups: 20, scene: 40, reading_group: 40 };
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const binding = value => value ? pick(value, ['version', 'request_id', 'project_id', 'phase', 'game_dir', 'work_dir']) : null;
const scene = value => value ? { ...pick(value, ['id', 'title', 'kind', 'file', 'counts', 'paragraph_count']),
  task_count: value.task_count ?? value.task_ids?.length,
  ...(value.scene_ids ? { scene_count: value.scene_ids.length } : {}) } : null;

function dataView(operation, data) {
  if (!data) return data;
  if (operation === 'status') {
    const state = data.state;
    if (!state) return data;
    const next = state.pending ? '初始化请求已登记；核对当前作业，勿重复初始化。'
      : state.binding?.phase === 'project_ready' ? '读取所选阅读组或导出真实翻译包。'
      : state.binding ? '沿绑定 request_id 完成 Core 工程，勿重新创建初始化意图。'
      : state.initialization_error ? '按需读取诊断，保留产物并修复后重试。' : '等待用户选择目录并确认初始化。';
    return { state: { ...pick(state, ['version', 'selected_game']), binding: binding(state.binding),
      pending: state.pending ? pick(state.pending, ['request_id', 'phase', 'game_dir', 'work_dir']) : null,
      ...(state.initialization_error ? { initialization_error: pick(state.initialization_error, ['request_id', 'message']) } : {}),
      ...(state.build_consent ? { build_consent: state.build_consent } : {}) },
    user_message: data.user_message ? { id: data.user_message.id } : null, next_action: next,
    diagnostics: { recent_operation_count: data.recent_operations?.length ?? 0, hint: '需要历史、授权目录或日志路径时使用 detail="full"。' } };
  }
  if (operation === 'prepare') {
    const report = data.report;
    return { ...pick(data, ['status', 'message']), ...(data.binding ? { binding: binding(data.binding) } : {}),
      ...(report ? { report: { ...pick(report, ['project_id', 'entries', 'tasks', 'counts', 'warnings', 'text_selection', 'localization', 'project_updated']),
        engine: pick(report.engine, ['family', 'variant']), scene_count: report.scenes?.length ?? 0 } } : {}),
      next_action: '按需读取目录；提取诊断使用 translation_read_report(report="extraction")，不要为查看报告重新 prepare。' };
  }
  if (operation === 'scenes') return { ...pick(data, ['project_id', 'counts', 'total', 'next_offset']), scenes: data.scenes.map(scene) };
  if (operation === 'reading_groups') return { ...pick(data, ['project_id', 'rule_version', 'capacity', 'original_scene_count', 'total', 'next_offset']), groups: data.groups.map(scene) };
  if (operation === 'scene' || operation === 'reading_group') return {
    ...pick(data, ['project_id', 'total', 'next_offset']), ...(data.scene ? { scene: scene(data.scene) } : { group: scene(data.group) }),
    ...(data.sections ? { sections: data.sections.map(section => pick(section, ['id', 'short_title', 'boundary', 'paragraph_count'])) } : {}),
    tasks: data.tasks.map(task => pick(task, ['id', 'scene_id', 'type', 'speaker', 'text', 'translation', 'status', 'revision', 'source_hash', 'structure'])),
    hint: '原文与译文完整；受保护文本和完整上下文以 create_package/read_package 的真实包为准。' };
  if (operation === 'job') return { ...pick(data, ['job_id', 'operation', 'status', 'observed_status', 'started_at', 'finished_at', 'notice', 'error']),
    ...(data.result ? { result: VIEW_OPERATIONS.has(data.operation) && data.operation !== 'job' ? dataView(data.operation, data.result)
      : pick(data.result, ['status', 'project_id', 'draft_id', 'revision', 'success', 'output_dir', 'written', 'runtime_verified', 'counts', 'message']) } : {}), hint: '需要日志路径或原始作业结果时使用 detail="full"。' };
  return data;
}

export function toolView(operation, result, detail = 'summary') {
  if (detail === 'full' || !VIEW_OPERATIONS.has(operation) || !result?.ok) return result;
  return { ...pick(result, ['ok', 'job_id', 'lifecycle_notice', 'record_error']), data: dataView(operation, result.data) };
}

export function toolArguments(operation, input) {
  const { detail = 'summary', ...args } = input;
  if (!['summary', 'full'].includes(detail)) throw new Error('detail 仅支持 summary 或 full。');
  if (PAGE_DEFAULTS[operation] && args.limit === undefined) args.limit = PAGE_DEFAULTS[operation];
  return args;
}
