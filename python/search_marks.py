"""Current manual provenance, separate from the disposable search database."""
from hashlib import sha256
from storage import PluginError, load, save


def digest(text):
    return sha256(text.encode("utf-8")).hexdigest()


def path_for(work):
    path = (work / ".dsh-translate" / "manual-marks.json").resolve()
    if not path.is_relative_to(work.resolve()):
        raise PluginError("invalid_marks", "人工标记位置必须位于当前工程内。")
    return path


def read_marks(work):
    value = load(path_for(work), {})
    if not isinstance(value, dict):
        raise PluginError("invalid_marks", "人工标记格式损坏，请保留文件并检查。")
    return value


def record_manual(work, project_id, task, previous):
    if task["translation"] == previous:
        return
    marks = read_marks(work)
    marks[str(task["id"])] = {"project_id": project_id, "source_hash": task["source_hash"],
                              "translation_hash": digest(task["translation"])}
    save(path_for(work), marks)


def current_marks(work, project_id, tasks):
    marks = read_marks(work)
    if not marks:
        return {}
    valid = {str(task["id"]): marks[str(task["id"])] for task in tasks
             if isinstance(marks.get(str(task["id"])), dict)
             and marks[str(task["id"])].get("project_id") == project_id
             and marks[str(task["id"])].get("source_hash") == task["source_hash"]
             and marks[str(task["id"])].get("translation_hash") == digest(task["translation"])}
    if valid != marks:
        save(path_for(work), valid)
    return valid
