/** Publish the first page immediately; batch subsequent updates to avoid copying per row. */
export async function readScenePages({ api, projectId, sceneId, current, publish }) {
  const rows = []; let offset = 0, published = 0;
  do {
    let result;
    try { result = await api('scene', { project_id: projectId, scene_id: sceneId, offset, limit: 200 }); }
    catch (error) { if (!current()) return; throw error; }
    if (!current()) return;
    rows.push(...result.tasks); offset = result.next_offset;
    if (published === 0 || offset === null || rows.length - published >= 1000) {
      publish(rows.slice()); published = rows.length;
    }
  } while (offset !== null);
}

/** One paginated Worker read per group page, never one request per original label. */
export async function readReadingGroupPages({ api, projectId, groupId, current, publish, sections }) {
  const rows = []; let offset = 0, published = 0;
  do {
    let result;
    try { result = await api('reading-group', { project_id: projectId, group_id: groupId, offset, limit: 200 }); }
    catch (error) { if (!current()) return; throw error; }
    if (!current()) return;
    if (result.project_id !== projectId || result.group?.id !== groupId) throw new Error('阅读分组已改变，请重新选择。');
    if (offset === 0) sections(result.sections);
    rows.push(...result.tasks); offset = result.next_offset;
    if (published === 0 || offset === null || rows.length - published >= 1000) { publish(rows.slice()); published = rows.length; }
  } while (offset !== null);
}
