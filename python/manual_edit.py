"""Human-only single-Task edits, committed under the existing WORK lock."""
from collections import defaultdict, deque
from uuid import uuid4

import game_translation as core
from game_translation.glossary import load_glossary, term_error
from game_translation.text import TOKEN_RE, protect_tags, validate_translation
from storage import PluginError, now, save


def edit_translation(work, manifest, tasks, args, context):
    if not context.get("humanCommand"):
        raise PluginError("human_required", "手工修改只接受本机用户在翻译窗口中的操作。")
    task = next((item for item in tasks if item["id"] == args.get("task_id")), None)
    if task is None:
        raise PluginError("unknown_task", "当前工程没有这条文本。")
    if (type(args.get("expected_revision")) is not int
            or args["expected_revision"] != task["revision"]
            or args.get("expected_source_hash") != task["source_hash"]
            or args.get("expected_translation") != task["translation"]):
        raise PluginError("task_conflict", "这条译文已被更新，请取消后重新编辑；当前输入尚未覆盖新内容。")
    text = args.get("translation")
    if not isinstance(text, str) or len(text) > 60000:
        raise PluginError("invalid_translation", "译文须为不超过 60000 字符的文本。")
    reason = validate_translation(task, text)
    reason = reason or term_error(task["text"], text, load_glossary(work))
    if reason:
        raise PluginError("invalid_translation", reason + "；原有译文未修改。")

    # The reader shows real control codes; Core submissions use their original
    # placeholder identities. Map repeated/reordered format codes without editing source.
    protected, codes = protect_tags(text, syntax=task.get("structure", {}).get("text_syntax"))
    identities = defaultdict(deque)
    for index, code in enumerate(task.get("codes", [])):
        identities[code].append(index)

    def token(match):
        code = codes[int(match.group(1))]
        if not identities[code]:
            raise PluginError("invalid_translation", "控制码身份无法对应；原有译文未修改。")
        return "{p" + str(identities[code].popleft()) + "}"

    protected = TOKEN_RE.sub(token, protected)
    reason = validate_translation(task, protected, protected=True)
    if reason:
        raise PluginError("invalid_translation", reason + "；原有译文未修改。")
    package = core.make_package(work, target_ids=[task["id"]], context="neighbors", window=0, max_chars=1000000)
    results = [{"id": task["id"], "translation": protected, "uncertain": False}]
    draft_id = uuid4().hex
    path = work / ".dsh-translate" / "drafts" / (draft_id + ".json")
    draft = {"id": draft_id, "revision": 1, "package_id": package["id"], "project_id": manifest["project_id"],
             "input_hash": package["input_hash"], "results": results, "updated_at": now(), "status": "draft",
             "origin": "manual_ui", "previous_revision": task["revision"]}
    save(path, draft)
    report = core.apply_results(work, package["id"], results)
    updated = next(item for item in core.load_project(work)[2] if item["id"] == task["id"])
    result = {"status": "saved", "task": updated, "draft_id": draft_id, "report": report}
    try:
        draft.update(status="applied", apply_report=report, applied_at=now())
        save(path, draft)
    except OSError as exc:
        result["notice"] = f"译文已保存，附属记录未更新：{exc}。不要重复提交。"
    return result
