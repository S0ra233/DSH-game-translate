"""单作业 Worker：stdin 首行请求，后续行接取消；stdout 只传协议。"""
from pathlib import Path
from threading import Event, Thread
from uuid import uuid4
import contextlib
import json
import sys
import traceback

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
from storage import PluginError, exclusive, identity, load, now, save
from session import TranslationSession


FIELDS = {
    "status": set(), "authorize_game": {"game_dir"},
    "select_game": {"game_dir"}, "authorize_work": {"path"}, "approve_build": {"output_dir"},
    "begin": {"game_dir", "work_dir", "notice_token"},
    "prepare": {"request_id", "options", "repair_work_dir"},
    "register_resources": {"request_id", "paths"}, "abandon": {"request_id", "reason"},
    "fail_initialization": {"request_id", "reason"},
    "open_project": {"work_dir", "notice_token"}, "inspect": {"game_dir"},
    "fonts": {"game_dir", "characters"}, "candidates": {"game_dir", "work_dir"},
    "scenes": {"offset", "limit"}, "scene": {"scene_id", "offset", "limit"},
    "reading_groups": {"offset", "limit"}, "reading_group": {"group_id", "offset", "limit"},
    "resolve_reading_groups": {"group_ids"},
    "package": {"scene_id", "target_ids", "options"}, "read_package": {"package_id"},
    "save_draft": {"package_id", "results", "draft_id", "expected_revision"},
    "read_draft": {"draft_id"}, "apply": {"draft_id", "expected_revision"},
    "edit_translation": {"task_id", "translation", "expected_revision", "expected_source_hash", "expected_translation"},
    "build": {"output_dir", "confirmation_message_id", "options"}, "verify": {"output_dir"},
    "job": {"job_id"},
    "read_report": {"project_id", "report", "offset", "limit"},
}
for _name in ("scenes", "scene", "reading_groups", "reading_group", "resolve_reading_groups", "package", "read_package", "save_draft", "read_draft", "apply", "edit_translation", "build", "verify"):
    FIELDS[_name].add("project_id")


def listen(cancelled):
    for line in sys.stdin:
        try:
            if json.loads(line).get("cancel") is True:
                cancelled.set()
        except (ValueError, AttributeError):
            cancelled.set()
    # 父连接关闭时协作停止，不能留下失去所有者的引擎作业。
    cancelled.set()


def main():
    protocol = sys.stdout
    session, job_file, job = None, None, None
    try:
        line = sys.stdin.readline(32 * 1024 * 1024 + 1)
        if len(line) > 32 * 1024 * 1024:
            raise PluginError("request_too_large", "Worker 请求过大，请缩小批次。")
        request = json.loads(line)
        operation, args = request["operation"], request.get("args", {})
        if operation not in FIELDS or not isinstance(args, dict) or set(args) - FIELDS[operation]:
            raise PluginError("invalid_operation", "未知操作或未允许的参数。")
        cancelled = Event()
        Thread(target=listen, args=(cancelled,), daemon=True).start()
        data = Path(request["config"]["dataDirectory"])
        key = identity(request["context"]["sessionId"])
        # status 读取原子快照，不等待当前长作业，也不改其状态。
        guard = contextlib.nullcontext() if operation in {"status", "job"} else exclusive(data / "locks" / ("session-"+key+".lock"))
        with guard:
            session = TranslationSession(request, cancelled)
            if operation in {"status", "job"}:
                from operations import dispatch
                result = dispatch(session, operation, args)
                protocol.write(json.dumps({"ok": True, "data": result}, ensure_ascii=False)+"\n")
                protocol.flush()
                return
            job_id = uuid4().hex
            job_file = session.home / "operations" / (job_id+".json")
            log_path = session.home / "operations" / (job_id+".log")
            job = {"job_id": job_id, "operation": operation, "status": "running", "started_at": now(),
                   "session_id": request["context"]["sessionId"], "log_path": str(log_path),
                   "request_id": args.get("request_id"), "binding_version": session.state["version"]}
            if operation == "build":
                job["user_confirmation"] = request["context"].get("userMessage")
            save(job_file, job)
            with log_path.open("a", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                from game_translation.process_control import process_scope
                from operations import dispatch
                with process_scope(cancelled):
                    result = dispatch(session, operation, args)
            job.update(status="succeeded", finished_at=now(), result=result)
            envelope = {"ok": True, "job_id": job_id, "data": result, "record_path": str(job_file)}
            try:
                save(job_file, job)
            except OSError as exc:
                envelope["record_error"] = f"业务已完成，作业结果记录保存失败；不要因此重跑：{exc}"
    except Exception as exc:
        code = getattr(exc, "code", "core_error")
        if type(exc).__name__ == "EngineCancelled":
            code = "cancelled"
        error = {"code": code, "message": str(exc), "details": getattr(exc, "details", {})}
        envelope = {"ok": False, "error": error}
        if session:
            envelope["state"] = session.state
        if job is not None:
            envelope["side_effects_may_have_completed"] = True
            envelope.update(job_id=job["job_id"], record_path=str(job_file), log_path=job["log_path"])
            job.update(status="cancelled" if code == "cancelled" else "failed", error=error, finished_at=now())
            try:
                with Path(job["log_path"]).open("a", encoding="utf-8") as log:
                    traceback.print_exc(file=log)
                save(job_file, job)
            except OSError as save_error:
                envelope["record_error"] = str(save_error)
    protocol.write(json.dumps(envelope, ensure_ascii=False, allow_nan=False)+"\n")
    protocol.flush()


if __name__ == "__main__":
    main()
