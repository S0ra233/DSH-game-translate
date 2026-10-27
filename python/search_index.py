"""Plugin-only persistent search. Core remains the source of truth."""
import json
import sqlite3
import unicodedata
from bisect import bisect_left
from time import perf_counter
from uuid import uuid4
from storage import PluginError, identity, exclusive
from search_marks import current_marks, path_for

VERSION = 2
STATUSES = {"NONE", "NEEDS_HUMAN", "PROCESSED", "ERROR"}
KEYS = ("name", "source", "target")
ASCII_FOLD = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def norm(text):
    return unicodedata.normalize("NFC", text).translate(ASCII_FOLD)


def parse_terms(text, punctuation=False):
    terms, word, quoted, index = [], "", False, 0
    while index < len(text):
        ch = text[index]
        if quoted:
            if ch == "\\" and index + 1 < len(text) and text[index+1] in ('"', "\\"):
                index += 1
                word += text[index]
            elif ch == '"':
                quoted = False
            else:
                word += ch
        elif ch == '"':
            quoted = True
        elif ch.isspace() or (punctuation and ch in ",，;；、"):
            if word:
                terms.append(norm(word))
                word = ""
        else:
            word += ch
        index += 1
    if quoted:
        raise PluginError("search_quote", "请补齐双引号；上一批检索结果仍保留。")
    if word:
        terms.append(norm(word))
    terms = list(dict.fromkeys(terms))
    if len(terms) > 32:
        raise PluginError("invalid_search", "每个字段最多使用 32 个关键词。")
    return terms


def clean_query(raw):
    if not isinstance(raw, dict) or set(raw) - {"fields", "relation", "statuses", "manual", "scope", "group_id", "punctuation"}:
        raise PluginError("invalid_search", "检索条件格式不正确。")
    fields = raw.get("fields", {})
    if not isinstance(fields, dict) or set(fields) - set(KEYS):
        raise PluginError("invalid_search", "检索字段只能是人名、原文和译文。")
    for key in ("manual", "punctuation"):
        if type(raw.get(key, False)) is not bool:
            raise PluginError("invalid_search", "筛选开关须为布尔值。")
    relation, scope = raw.get("relation", "all"), raw.get("scope", "project")
    statuses = raw.get("statuses", [])
    if relation not in ("all", "any") or scope not in ("project", "group"):
        raise PluginError("invalid_search", "检索组合或范围不正确。")
    if not isinstance(statuses, list) or any(not isinstance(s, str) or s not in STATUSES for s in statuses):
        raise PluginError("invalid_search", "状态须来自 Core。")
    group_id = raw.get("group_id", "") if scope == "group" else ""
    if not isinstance(group_id, str) or (scope == "group" and not group_id):
        raise PluginError("invalid_search", "限定当前显示时须选择阅读组。")
    clauses = {}
    for key in KEYS:
        value = fields.get(key, {})
        if not isinstance(value, dict) or set(value) - {"text", "relation"}:
            raise PluginError("invalid_search", "字段条件格式不正确。")
        text, mode = value.get("text", ""), value.get("relation", "all")
        if not isinstance(text, str) or len(text) > 2048 or mode not in ("all", "any"):
            raise PluginError("invalid_search", "每个字段须为不超过 2048 字符的文字。")
        terms = parse_terms(text, raw.get("punctuation", False))
        if terms:
            clauses[key] = {"terms": terms, "relation": mode}
    return {"clauses": clauses, "relation": relation, "statuses": sorted(set(statuses)) if len(set(statuses)) < 4 else [],
            "manual": raw.get("manual", False), "scope": scope, "group_id": group_id}


def stamp(work):
    result = []
    for path in (work / "project.json", work / "entries.json", work / "tasks.jsonl", path_for(work)):
        try:
            info = path.stat()
            result.append([info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns])
        except FileNotFoundError:
            result.append(None)
    return json.dumps(result)


class SearchIndex:
    def __init__(self, session):
        self.work = session.bound_work()
        self.project_id = session.state["binding"]["project_id"]
        key = identity(str(self.work) + ":" + self.project_id)
        directory = session.root / "search"
        directory.mkdir(parents=True, exist_ok=True)
        self.database = directory / (key + f".v{VERSION}.sqlite")
        self.lock = session.root / "locks" / ("search-" + key + ".lock")
        try:
            self._open()
        except sqlite3.DatabaseError as error:
            if getattr(error, "sqlite_errorcode", None) not in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB):
                raise
            self.db.close()
            suffix = ".corrupt-" + uuid4().hex
            for tail in ("", "-journal", "-wal", "-shm"):
                source = self.database.with_name(self.database.name + tail)
                if source.exists():
                    source.rename(source.with_name(source.name + suffix))
            self._open()

    def _open(self):
        self.db = sqlite3.connect(self.database, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA cache_size=-32768")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS names(id INTEGER PRIMARY KEY,source TEXT,target TEXT,nsource TEXT,ntarget TEXT,speaker_doc INTEGER);
          CREATE TABLE IF NOT EXISTS docs(doc_id INTEGER PRIMARY KEY,task_id TEXT UNIQUE,scene_id TEXT,group_id TEXT,
            anchor INTEGER,kind TEXT,source TEXT,target TEXT,source_norm TEXT,target_norm TEXT,status TEXT,manual INTEGER,
            name_id INTEGER,payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS docs_anchor ON docs(anchor);
          CREATE INDEX IF NOT EXISTS docs_group_order ON docs(group_id,anchor);
          CREATE INDEX IF NOT EXISTS docs_status_order ON docs(status,anchor);
          CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS payloads(doc_id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
        """)
        self.fts = True
        try:
            self.db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(source_norm,target_norm,content='docs',content_rowid='doc_id',tokenize='trigram case_sensitive 1')")
        except sqlite3.OperationalError:
            self.fts = False

    def close(self):
        self.db.close()

    def meta(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def ensure(self, session):
        if self.meta("stamp") == stamp(self.work) and self.meta("version") == str(VERSION):
            return self.meta("generation")
        with exclusive(self.lock):
            if self.meta("stamp") == stamp(self.work) and self.meta("version") == str(VERSION):
                return self.meta("generation")
            from operations import project
            from reading_groups import build_groups
            started = perf_counter()
            session.check_cancelled()
            with session.work_lock(self.work):
                before = stamp(self.work)
                work, manifest, entries, tasks = project(session)
                if stamp(work) != before:
                    raise PluginError("search_updating", "工程正在更新，请稍后重试检索。")
                marks = current_marks(work, self.project_id, tasks)
                source_stamp = stamp(work)
            loaded = perf_counter()
            plan = build_groups(manifest, entries, tasks)
            scene_group = {scene: group["id"] for group in plan["groups"] for scene in group["scene_ids"]}
            links, name_records, fallback, active_speaker, used = [], [], {}, None, set()
            for ordinal, task in enumerate(tasks, 1):
                if ordinal % 256 == 0:
                    session.check_cancelled()
                task_id = str(task["id"])
                name_id = None
                if task["type"] == "speaker":
                    name_id = len(name_records) + 1
                    name_records.append((name_id, task["text"], task["translation"], norm(task["text"]), norm(task["translation"]), ordinal))
                    active_speaker = (task, ordinal, name_id)
                else:
                    linked = (active_speaker and active_speaker[0]["scene_id"] == task["scene_id"]
                              and task.get("speaker") and active_speaker[0]["text"] == task["speaker"])
                    if linked:
                        name_id = active_speaker[2]
                        if active_speaker[1] not in used:
                            links[active_speaker[1]-1][1] = ordinal
                            used.add(active_speaker[1])
                    else:
                        active_speaker = None
                        if task.get("speaker"):
                            key = (task["scene_id"], task["speaker"])
                            if key not in fallback:
                                fallback[key] = len(name_records) + 1
                                name_records.append((fallback[key], task["speaker"], "", norm(task["speaker"]), "", None))
                            name_id = fallback[key]
                links.append([name_id, ordinal])
            generation = uuid4().hex
            prepared = perf_counter()
            session.check_cancelled()
            self.db.set_progress_handler(lambda: int(session.cancelled.is_set()), 1000)
            self.db.execute("BEGIN IMMEDIATE")
            try:
                old = {row["doc_id"]: row for row in self.db.execute("SELECT doc_id,task_id,source_norm,target_norm FROM docs")}
                rebuild = len(old) != len(tasks) or any(old.get(i+1) is None or old[i+1]["task_id"] != task["id"] for i, task in enumerate(tasks))
                if rebuild:
                    self.db.execute("DELETE FROM docs")
                    self.db.execute("DELETE FROM payloads")
                    old = {}
                self.db.execute("DELETE FROM names")
                self.db.executemany("INSERT INTO names VALUES(?,?,?,?,?,?)", name_records)
                columns = ("task_id", "scene_id", "group_id", "anchor", "kind", "source", "target", "source_norm", "target_norm", "status", "manual", "name_id")
                upsert = "INSERT INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET " + ",".join(f"{c}=excluded.{c}" for c in columns) + " WHERE " + " OR ".join(f"docs.{c} IS NOT excluded.{c}" for c in columns)
                for count, task in enumerate(tasks):
                    if count % 256 == 0:
                        session.check_cancelled()
                    name_id, anchor = links[count]
                    record = [count+1, task["id"], task["scene_id"], scene_group[task["scene_id"]], anchor,
                        task["type"], task["text"], task["translation"], norm(task["text"]), norm(task["translation"]),
                        task["status"], int(str(task["id"]) in marks), name_id, ""]
                    previous = old.pop(record[0], None)
                    text_changed = previous is None or (previous["source_norm"], previous["target_norm"]) != (record[8], record[9])
                    if previous and text_changed and self.fts:
                        self.db.execute("INSERT INTO doc_fts(doc_fts,rowid,source_norm,target_norm) VALUES('delete',?,?,?)", (record[0], previous["source_norm"], previous["target_norm"]))
                    self.db.execute(upsert, record)
                    self.db.execute("INSERT INTO payloads VALUES(?,?) ON CONFLICT(doc_id) DO UPDATE SET payload=excluded.payload WHERE payloads.payload<>excluded.payload", (record[0], json.dumps(task, ensure_ascii=False)))
                    if text_changed and self.fts and not rebuild:
                        self.db.execute("INSERT INTO doc_fts(rowid,source_norm,target_norm) VALUES(?,?,?)", (record[0], record[8], record[9]))
                for doc_id, previous in old.items():
                    if self.fts:
                        self.db.execute("INSERT INTO doc_fts(doc_fts,rowid,source_norm,target_norm) VALUES('delete',?,?,?)", (doc_id, previous["source_norm"], previous["target_norm"]))
                    self.db.execute("DELETE FROM docs WHERE doc_id=?", (doc_id,))
                    self.db.execute("DELETE FROM payloads WHERE doc_id=?", (doc_id,))
                if rebuild and self.fts:
                    self.db.execute("INSERT INTO doc_fts(doc_fts) VALUES('rebuild')")
                self.db.execute("DELETE FROM groups")
                self.db.executemany("INSERT INTO groups VALUES(?,?)", [(g["id"], json.dumps(g, ensure_ascii=False)) for g in plan["groups"]])
                self.db.executemany("INSERT OR REPLACE INTO meta VALUES(?,?)", [("stamp", source_stamp), ("version", str(VERSION)), ("generation", generation)])
                if stamp(self.work) != source_stamp:
                    raise PluginError("search_updating", "工程正在更新，正在等待完整检索快照。")
                session.check_cancelled()
                self.db.commit()
                self.reader_cache = None
                self.build_count = getattr(self, "build_count", 0) + 1
                self.last_build = {"rows": len(tasks), "core_ms": round((loaded-started)*1000, 2),
                    "prepare_ms": round((prepared-loaded)*1000, 2), "write_ms": round((perf_counter()-prepared)*1000, 2)}
            except Exception as error:
                self.db.set_progress_handler(None, 0)
                self.db.rollback()
                if isinstance(error, sqlite3.OperationalError):
                    session.check_cancelled()
                raise
            finally:
                self.db.set_progress_handler(None, 0)
            return generation

    def predicate(self, query):
        params, filters, clauses = [], [], []
        candidate_budget = 512  # Also fits runtimes with the older 999-parameter limit.
        if query["scope"] == "group":
            if not self.db.execute("SELECT 1 FROM groups WHERE id=?", (query["group_id"],)).fetchone():
                raise PluginError("group_changed", "当前阅读组已改变，请刷新。")
            filters.append("d.group_id=?")
            params.append(query["group_id"])
        if query["statuses"]:
            filters.append("d.status IN (" + ",".join("?" for _ in query["statuses"]) + ")")
            params.extend(query["statuses"])
        if query["manual"]:
            filters.append("d.manual=1")
        for field, clause in query["clauses"].items():
            terms_sql = []
            for term in clause["terms"]:
                if field == "name":
                    terms_sql.append("(instr(n.nsource,?)>0 OR instr(n.ntarget,?)>0)")
                    params.extend((term, term))
                else:
                    column = "source_norm" if field == "source" else "target_norm"
                    part = f"instr(d.{column},?)>0"
                    params.append(term)
                    if self.fts and len(term) >= 3 and "\0" not in term:
                        expression = column + ': "' + term.replace('"', '""') + '"'
                        candidates = [r[0] for r in self.db.execute("SELECT rowid FROM doc_fts WHERE doc_fts MATCH ? LIMIT 257", (expression,))]
                        # Expanding a frequent posting list can cost more than
                        # reading the first page in source order. A bounded probe
                        # chooses the path without computing a full hit count.
                        if len(candidates) <= 256 and len(candidates) <= candidate_budget:
                            part += " AND d.doc_id IN (" + (",".join("?" for _ in candidates) or "NULL") + ")"
                            params.extend(candidates)
                            candidate_budget -= len(candidates)
                    terms_sql.append("(" + part + ")")
            clauses.append("(" + (" AND " if clause["relation"] == "all" else " OR ").join(terms_sql) + ")")
        if clauses:
            filters.append("(" + (" AND " if query["relation"] == "all" else " OR ").join(clauses) + ")")
        return " AND ".join(filters) or "1", params

    def fields_for(self, row, query):
        matched = {}
        for field, clause in query["clauses"].items():
            values = [row["nsource"] or "", row["ntarget"] or ""] if field == "name" else [row[field + "_norm"]]
            checks = [any(term in value for value in values) for term in clause["terms"]]
            if (all(checks) if clause["relation"] == "all" else any(checks)):
                matched[field] = [term for term, yes in zip(clause["terms"], checks) if yes]
        return matched

    def _read(self, session, args, operation):
        self.ensure(session)
        self.db.execute("BEGIN")
        try:
            return operation(session, args, self.meta("generation"))
        finally:
            # One response (including all merged members) reads one generation,
            # even when another conversation refreshes the shared cache.
            self.db.rollback()

    def query(self, session, args):
        return self._read(session, args, self._query)

    def _query(self, session, args, generation):
        query = clean_query(args.get("query", {}))
        query_key = identity(json.dumps(query, sort_keys=True))
        limit = args.get("limit", 40)
        if type(limit) is not int or not 1 <= limit <= 40:
            raise PluginError("invalid_search", "检索每页为 1 至 40 个位置。")
        after, seen = 0, 0
        if args.get("cursor"):
            try:
                cursor = json.loads(args["cursor"])
                if cursor["generation"] != generation or cursor["query"] != query_key:
                    raise PluginError("search_stale", "检索内容已更新，请重新读取结果。")
                after, seen = cursor["after"], cursor["seen"]
                if type(after) is not int or type(seen) is not int or after < 0 or seen < 0:
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise PluginError("invalid_search", "检索游标不正确。")
        active = bool(query["clauses"] or query["statuses"] or query["manual"] or query["scope"] == "group")
        where, params = self.predicate(query)
        join = " FROM docs d LEFT JOIN names n ON d.name_id=n.id WHERE "
        self.db.set_progress_handler(lambda: int(session.cancelled.is_set()), 1000)
        try:
            anchors = [r[0] for r in self.db.execute("SELECT DISTINCT d.anchor" + join + where + " AND d.anchor>? ORDER BY d.anchor LIMIT ?", [*params, after, limit+1])] if active else []
            more, anchors = len(anchors) > limit, anchors[:limit]
            hits = []
            for anchor in anchors:
                session.check_cancelled()
                members = list(self.db.execute("SELECT d.*,n.nsource,n.ntarget" + join + where + " AND d.anchor=? ORDER BY d.doc_id", [*params, anchor]))
                display = self.db.execute("SELECT d.*,n.source AS speaker_source,n.target AS speaker_target,sp.task_id AS speaker_task_id FROM docs d LEFT JOIN names n ON d.name_id=n.id LEFT JOIN docs sp ON sp.doc_id=n.speaker_doc WHERE d.doc_id=?", (anchor,)).fetchone()
                matches = [{"task_id": r["task_id"], "kind": r["kind"], "fields": self.fields_for(r, query), "status": r["status"], "manual": bool(r["manual"])} for r in members]
                group = json.loads(self.db.execute("SELECT payload FROM groups WHERE id=?", (display["group_id"],)).fetchone()[0])
                hits.append({"anchor": anchor, "task_id": display["task_id"], "group_id": display["group_id"], "label": group["title"],
                    "kind": display["kind"], "speaker_task_id": display["speaker_task_id"],
                    "speaker_source": excerpt(display["speaker_source"] or "", query["clauses"].get("name", {}).get("terms", [])) if display["kind"] != "speaker" else "",
                    "speaker_target": excerpt(display["speaker_target"] or "", query["clauses"].get("name", {}).get("terms", [])) if display["kind"] != "speaker" else "",
                    "source": excerpt(display["source"], query["clauses"].get("source", {}).get("terms", [])),
                    "target": excerpt(display["target"], query["clauses"].get("target", {}).get("terms", [])), "matches": matches})
        except sqlite3.OperationalError as error:
            session.check_cancelled()
            raise error
        finally:
            self.db.set_progress_handler(None, 0)
        cursor = json.dumps({"generation": generation, "query": query_key, "after": anchors[-1], "seen": seen+len(hits)}) if more else None
        return {"project_id": self.project_id, "generation": generation, "query_key": query_key, "active": active,
                "hits": hits, "next_cursor": cursor, "has_more": more, "total": None if more else seen+len(hits)}

    def locate(self, session, args):
        return self._read(session, args, self._locate)

    def _locate(self, session, args, generation):
        if not args.get("rebase", False) and args.get("generation") != generation:
            raise PluginError("search_stale", "工程已更新，正在重新核对检索结果。")
        if args.get("window_cursor"):
            try:
                cursor = json.loads(args["window_cursor"])
                if cursor["generation"] != generation or cursor["project_id"] != self.project_id:
                    raise PluginError("search_stale", "正文已更新，正在重新读取当前位置。")
                group_id, position = cursor["group_id"], cursor["position"]
                if not isinstance(group_id, str) or type(position) is not int:
                    raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise PluginError("invalid_search", "正文游标不正确。")
            return self._window(session, group_id, position, args.get("direction", "after"), generation)
        query = clean_query(args.get("query", {}))
        where, params = self.predicate(query)
        anchor = args.get("anchor")
        if args.get("section_id"):
            section = self.db.execute("SELECT anchor FROM docs WHERE scene_id=? AND group_id=? ORDER BY doc_id LIMIT 1", (args["section_id"], args.get("group_id"))).fetchone()
            if not section:
                raise PluginError("search_stale", "来源片段已改变，请重新选择。")
            anchor = section[0]
        if args.get("task_id"):
            located = self.db.execute("SELECT anchor FROM docs WHERE task_id=?", (args["task_id"],)).fetchone()
            if not located:
                raise PluginError("search_stale", "目标段落已移除，请刷新检索。")
            anchor = located[0]
        if type(anchor) is not int or not self.db.execute("SELECT 1 FROM docs d LEFT JOIN names n ON d.name_id=n.id WHERE " + where + " AND d.anchor=?", [*params, anchor]).fetchone():
            raise PluginError("search_stale", "这处内容已不符合检索条件，请刷新。")
        target = self.db.execute("SELECT * FROM docs WHERE doc_id=?", (anchor,)).fetchone()
        anchors = self._reader_order(target["group_id"], generation)
        result = self._window(session, target["group_id"], bisect_left(anchors, anchor), "around", generation)
        result["task_id"] = target["task_id"]
        return result

    def _reader_order(self, group_id, generation):
        key = (group_id, generation)
        if not getattr(self, "reader_cache", None) or self.reader_cache[0] != key:
            anchors = [r[0] for r in self.db.execute("SELECT DISTINCT anchor FROM docs WHERE group_id=? ORDER BY anchor", (group_id,))]
            self.reader_cache = (key, anchors)
        return self.reader_cache[1]

    def _window(self, session, group_id, position, direction, generation):
        found = self.db.execute("SELECT payload FROM groups WHERE id=?", (group_id,)).fetchone()
        if not found:
            raise PluginError("search_stale", "阅读组已改变，请重新选择。")
        group = json.loads(found[0])
        anchors = self._reader_order(group_id, generation)
        if not 0 <= position <= len(anchors) or direction not in ("before", "after", "around"):
            raise PluginError("invalid_search", "正文读取范围不正确。")
        start = max(0, position - (40 if direction == "before" else 20 if direction == "around" else 0))
        end = min(len(anchors), position if direction == "before" else start+40)
        chosen = anchors[start:end]
        records = list(self.db.execute("SELECT d.*,p.payload AS body FROM docs d JOIN payloads p ON d.doc_id=p.doc_id WHERE group_id=? AND anchor IN ("+(",".join("?" for _ in chosen) or "NULL")+") ORDER BY d.doc_id", [group_id, *chosen]))
        by_anchor = {}
        for row in records:
            by_anchor.setdefault(row["anchor"], []).append(row)
        size = sum(len(row["body"].encode("utf-8")) for row in records)
        while size > 512*1024 and end-start > 1:
            drop_left = direction == "before" or (direction == "around" and position-start > end-position-1)
            removed = anchors[start] if drop_left else anchors[end-1]
            size -= sum(len(r["body"].encode("utf-8")) for r in by_anchor[removed])
            if drop_left:
                start += 1
            else:
                end -= 1
        window = {r["doc_id"]: r for a in anchors[start:end] for r in by_anchor[a]}
        for row in list(window.values()):
            session.check_cancelled()
            name = self.db.execute("SELECT speaker_doc FROM names WHERE id=?", (row["name_id"],)).fetchone()
            if name and name[0] and name[0] not in window:
                dependency = self.db.execute("SELECT d.*,p.payload AS body FROM docs d JOIN payloads p ON d.doc_id=p.doc_id WHERE d.doc_id=?", (name[0],)).fetchone()
                window[name[0]] = dependency
        tasks = [json.loads(row["body"]) for _, row in sorted(window.items())]
        scenes = {t["scene_id"] for t in tasks}
        def cursor(offset):
            return json.dumps({"project_id": self.project_id, "generation": generation, "group_id": group_id, "position": offset})
        return {"project_id": self.project_id, "generation": generation, "group": group,
                "sections": [s for s in group["sections"] if s["id"] in scenes], "tasks": tasks,
                "task_order": {r["task_id"]: r["doc_id"] for r in window.values()}, "partial": start > 0 or end < len(anchors),
                "positions": [[window[a]["task_id"], p] for p, a in enumerate(anchors[start:end], start)],
                "window": {"start": start, "end": end, "total": len(anchors),
                    "before": cursor(start) if start else None, "after": cursor(end) if end < len(anchors) else None}}


def excerpt(text, terms):
    normalized = norm(text)
    found = [normalized.find(term) for term in terms if term in normalized]
    # A preview is bounded; full text is loaded only by locate().
    start = max(0, min(found, default=0)-70)
    return ("…" if start else "") + text[start:start+280] + ("…" if start+280 < len(text) else "")
