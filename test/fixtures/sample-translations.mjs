// Only for the synthetic game-a/game-b fixtures. Never used by the plugin or a model.
export function sampleTranslation(task) {
  if (['speaker', 'name'].includes(task.type) && task.text === 'ミナ') return '米娜';
  if (task.type === 'nickname' && task.text === '友達') return '朋友';
  if (task.type === 'profile' && task.text === '旅の途中で出会った仲間。') return '在旅途中结识的伙伴。';
  if (task.type === 'map_name' && task.text === '朝の村') return '清晨的村庄';
  if (task.type === 'map_name' && task.text === '夕方の広場') return '傍晚的广场';
  const match = task.type === 'dialogue' && /^(\d{3})・(朝の村|夕方の広場)。また明日、ここで会いましょう。/.exec(task.text);
  if (!match) throw new Error(`Not a recognized synthetic Task: ${task.id}`);
  const [, number, location] = match;
  return `${number}・${location === '朝の村' ? '清晨的村庄' : '傍晚的广场'}。明天还在这里见面。${Number(number) % 7 === 0 ? '这是一段较长的中文译文，用于确认双栏对齐及换行显示。'.repeat(3) : ''}`;
}

export const legacySample = index => `${String(index + 1).padStart(3, '0')}・明天还在这里见面。${index % 9 === 0 ? '这是一段较长的中文译文，用于确认双栏对齐及换行显示。'.repeat(3) : ''}`;

export async function sceneTasks(call, projectId, sceneId) {
  const all = []; let offset = 0;
  do {
    const page = await call('scene', { project_id: projectId, scene_id: sceneId, offset, limit: 200 });
    all.push(...page.tasks); offset = page.next_offset;
  } while (offset !== null);
  return all;
}
