/** A bounded view over one complete reading group. All positions stay reachable. */
export class ReadingWindow {
  constructor(page) {
    this.pages = []; this.averageHeight = 95;
    this.add(page, 'around');
  }

  add(page, direction = 'around') {
    if (!page.window || page.window.end <= page.window.start) throw new Error('正文读取没有返回有效段落。');
    if (direction === 'around' || this.projectId !== page.project_id || this.generation !== page.generation || this.group?.id !== page.group.id) this.pages = [];
    this.projectId = page.project_id; this.generation = page.generation; this.group = page.group;
    this.pages = this.pages.filter(item => item.window.end <= page.window.start || item.window.start >= page.window.end);
    this.pages.push(page); this.pages.sort((a, b) => a.window.start - b.window.start);
    while (this.pages.length > 6) direction === 'before' ? this.pages.pop() : this.pages.shift();
    this.cachedView = null;
    return this.view();
  }

  view() {
    if (this.cachedView) return this.cachedView;
    const tasks = new Map(), order = new Map(), positions = new Map();
    for (const page of this.pages) {
      for (const task of page.tasks) { tasks.set(task.id, task); order.set(task.id, page.task_order[task.id]); }
      for (const [id, position] of page.positions) positions.set(id, position);
    }
    const rows = [...tasks.values()].sort((a, b) => order.get(a.id) - order.get(b.id));
    const first = this.pages[0].window, last = this.pages.at(-1).window;
    const scenes = new Set(rows.map(task => task.scene_id));
    return this.cachedView = { tasks: rows, sections: this.group.sections.filter(section => scenes.has(section.id)), positions,
      start: first.start, end: last.end, total: first.total, before: first.before, after: last.after,
      beforeHeight: first.start * this.averageHeight, afterHeight: (first.total - last.end) * this.averageHeight };
  }

  cursor(position) {
    return JSON.stringify({ project_id: this.projectId, generation: this.generation, group_id: this.group.id, position: Math.max(0, Math.min(this.view().total - 1, position)) });
  }
}
