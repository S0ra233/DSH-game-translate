/** Fold speaker metadata into its actual dialogue, keeping every Core Task intact. */
export function readingRows(tasks) {
  const rows = [], used = new Set(); let speaker = null;
  for (const task of tasks) {
    if (task.type === 'speaker') { speaker = task; rows.push({ task, speakerTask: null }); continue; }
    const linked = speaker && speaker.scene_id === task.scene_id && task.speaker && speaker.text === task.speaker ? speaker : null;
    if (linked) used.add(linked.id);
    else speaker = null;
    rows.push({ task, speakerTask: linked });
  }
  return rows.filter(row => row.task.type !== 'speaker' || !used.has(row.task.id));
}

export function saveTranslation(api, projectId, task, translation) {
  return api('edit-translation', { project_id: projectId, task_id: task.id, translation,
    expected_revision: task.revision, expected_source_hash: task.source_hash, expected_translation: task.translation });
}
