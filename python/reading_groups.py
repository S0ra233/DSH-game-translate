"""Stable, source-aware reading containers; Core Scenes/Tasks stay intact.

Source adjacency is not a claim of narrative continuity. Original labels, event
pages and branch boundaries remain explicit sections inside each container.
"""
from collections import Counter, defaultdict
from hashlib import sha256
from pathlib import PurePosixPath
import json
import re

from storage import PluginError

RULE_VERSION = 1
CHAR_BUDGET = 6000


def paragraph_count(tasks):
    speaker, used = None, set()
    for task in tasks:
        if task["type"] == "speaker":
            speaker = task
        elif (speaker and speaker["scene_id"] == task["scene_id"]
              and task.get("speaker") and speaker["text"] == task["speaker"]):
            used.add(speaker["id"])
        else:
            speaker = None
    return len(tasks) - len(used)


def _section(scene, entries, tasks):
    files = list(dict.fromkeys(entry["file"] for entry in entries))
    file = files[0] if len(files) == 1 else ""
    kind = scene.get("kind", "unknown")
    context = scene.get("source_context", {})
    # Respect explicit adapter boundaries; do not guess routes/chapters from names.
    declared = {key: context[key] for key in ("chapter", "route", "branch", "function", "screen") if key in context}
    scope = [file, kind, declared]
    if not file or kind not in {"script_label", "event", "database", "text_group"}:
        scope.append(scene["id"])
    elif kind == "event":
        # Separate unrelated RPG Maker events. Alternative pages remain labelled.
        match = re.search(r"(/events/[^/]+)", entries[0].get("path", "")) if entries else None
        scope.append(match[1] if match else scene["id"])
    if context.get("hard_boundary"):
        scope.append(scene["id"])
    title = scene.get("title", scene["id"])
    short = title[len(file) + 1:] if file and title.startswith(file + ":") else title
    boundary = {"script_label": "标签片段", "event": "事件 / 页面", "database": "数据条目", "text_group": "来源片段"}.get(kind, "来源片段")
    return {"id": scene["id"], "title": title, "short_title": short, "file": file,
            "kind": kind, "boundary": boundary, "paragraph_count": paragraph_count(tasks),
            "task_count": len(tasks), "characters": sum(len(task["text"]) for task in tasks),
            "_scope": json.dumps(scope, ensure_ascii=False, sort_keys=True)}


def _pack(sections, capacity):
    groups, scope, paragraphs, characters = [], None, 0, 0
    for section in sections:
        previous = groups[-1] if groups else None
        if (previous and scope == section["_scope"]
                and paragraphs + section["paragraph_count"] <= capacity
                and characters + section["characters"] <= CHAR_BUDGET):
            previous.append(section)
        else:
            groups.append([section])
            scope, paragraphs, characters = section["_scope"], 0, 0
        paragraphs += section["paragraph_count"]
        characters += section["characters"]
    return groups


def build_groups(manifest, entries, tasks):
    by_scene, sources = defaultdict(list), defaultdict(list)
    for task in tasks:
        by_scene[task["scene_id"]].append(task)
    for entry in entries:
        sources[entry["scene_id"]].append(entry)
    sections = [_section(scene, sources[scene["id"]], by_scene[scene["id"]]) for scene in manifest["scenes"]]
    capacity, packed = 140, []
    for capacity in (140, 160, 200, 240, 320):
        packed = _pack(sections, capacity)
        if len(packed) <= 60:
            break
    file_totals = Counter(group[0]["file"] for group in packed)
    file_order = Counter()
    result = []
    for members in packed:
        file = members[0]["file"]
        file_order[file] += 1
        ids = [item["id"] for item in members]
        identity = json.dumps([RULE_VERSION, manifest["project_id"], ids], separators=(",", ":"))
        paragraphs = sum(item["paragraph_count"] for item in members)
        name = PurePosixPath(file).name if file else members[0]["short_title"]
        suffix = f" · {file_order[file]}/{file_totals[file]}" if file_totals[file] > 1 else ""
        counts = Counter(task["status"] for scene_id in ids for task in by_scene[scene_id])
        result.append({"id": "g_" + sha256(identity.encode()).hexdigest()[:24],
                       "title": f"{name}{suffix} · {paragraphs} 段", "file": file,
                       "kind": "reading_group", "scene_ids": ids, "counts": dict(counts),
                       "paragraph_count": paragraphs, "task_count": sum(counts.values()),
                       "sections": [{key: value for key, value in item.items() if not key.startswith("_")} for item in members]})
    return {"rule_version": RULE_VERSION, "capacity": capacity, "character_budget": CHAR_BUDGET,
            "original_scene_count": len(sections), "groups": result}


def select_groups(plan, ids):
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 100
            or any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids)):
        raise PluginError("invalid_groups", "请选择 1 至 100 个不重复的阅读分组。")
    wanted = set(ids)
    selected = [group for group in plan["groups"] if group["id"] in wanted]
    if len(selected) != len(wanted):
        raise PluginError("group_changed", "阅读分组与当前工程不符，请刷新后重新选择。")
    return selected
