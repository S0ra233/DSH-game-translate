export const normalizeSearch = value => value.normalize('NFC').replace(/[A-Z]/g, ch => ch.toLowerCase());

export function parseSearchTerms(text, punctuation = false) {
  const chars = Array.from(text), terms = []; let word = '', quoted = false;
  const flush = () => { if (word) terms.push(normalizeSearch(word)); word = ''; };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quoted) {
      if (ch === '\\' && ['"', '\\'].includes(chars[i + 1])) word += chars[++i];
      else if (ch === '"') quoted = false;
      else word += ch;
    } else if (ch === '"') quoted = true;
    else if (/\s/u.test(ch) || (punctuation && ',，;；、'.includes(ch))) flush();
    else word += ch;
  }
  if (quoted) return { error: '请补齐双引号；上一批结果仍保留。', terms: [] };
  flush(); return { terms: [...new Set(terms)] };
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
export function searchParts(text, terms) {
  if (!text || !terms?.length) return [{ text, match: false }];
  const parts = segmenter ? [...segmenter.segment(text)] : [...text].map((segment, i, a) => ({ segment, index: a.slice(0, i).join('').length }));
  let normalized = ''; const map = [], spans = [];
  for (const part of parts) {
    const value = normalizeSearch(part.segment); normalized += value;
    for (let i = 0; i < value.length; i++) map.push([part.index, part.index + part.segment.length]);
  }
  for (const term of terms) {
    if (!term) continue;
    let start = 0, found;
    while ((found = normalized.indexOf(term, start)) >= 0) {
      if (map[found] && map[found + term.length - 1]) spans.push([map[found][0], map[found + term.length - 1][1]]);
      start = found + Math.max(1, term.length);
    }
  }
  spans.sort((a, b) => a[0] - b[0]); const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]); else merged.push(span);
  }
  let start = 0; const result = [];
  for (const [from, to] of merged) { result.push({ text: text.slice(start, from), match: false }, { text: text.slice(from, to), match: true }); start = to; }
  result.push({ text: text.slice(start), match: false }); return result;
}

/** Only accepted result membership can grant a highlight; inputs alone never do. */
export function rowSearchTerms(row, hit) {
  const result = { source: [], target: [], sourceName: [], targetName: [] };
  if (!hit || hit.task_id !== row.task.id) return result;
  for (const match of hit.matches) {
    const fields = match.fields;
    if (match.task_id === row.task.id) {
      result.source.push(...(fields.source ?? [])); result.target.push(...(fields.target ?? []));
      if (row.task.type === 'speaker') { result.source.push(...(fields.name ?? [])); result.target.push(...(fields.name ?? [])); }
      else { result.sourceName.push(...(fields.name ?? [])); result.targetName.push(...(fields.name ?? [])); }
    } else if (match.task_id === row.speakerTask?.id) {
      result.sourceName.push(...(fields.source ?? []), ...(fields.name ?? []));
      result.targetName.push(...(fields.target ?? []), ...(fields.name ?? []));
    }
  }
  return result;
}
