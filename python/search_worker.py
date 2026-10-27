"""Long-lived, passive UI search worker. No Agent/model session is resumed."""
from pathlib import Path
from threading import Event, Thread, Lock
from queue import Queue
import json
import sqlite3
import sys
from time import perf_counter

sys.path.insert(0, str(Path(__file__).parent / "vendor"))
from storage import PluginError
from session import TranslationSession
from search_index import SearchIndex

queue, cancellations, mutex = Queue(), {}, Lock()
waiting, building = {}, {"project": None, "cancelled": Event()}
stopped = Event()


def memory_stats():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        *[(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]]
        value = Counters(); value.cb = ctypes.sizeof(value)
        handle = ctypes.windll.kernel32.GetCurrentProcess
        handle.restype = wintypes.HANDLE
        read = ctypes.windll.psapi.GetProcessMemoryInfo
        read.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        if read(handle(), ctypes.byref(value), value.cb):
            return {"rss_mib": round(value.WorkingSetSize / 1048576, 2), "peak_mib": round(value.PeakWorkingSetSize / 1048576, 2)}
    return {}


def receive():
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                with mutex:
                    if "cancel" in message:
                        if message["cancel"] in cancellations:
                            cancellations[message["cancel"]].set()
                    else:
                        cancelled = Event()
                        cancellations[message["id"]] = cancelled
                        if building["project"] and building["project"] != message.get("args", {}).get("project_id"):
                            building["cancelled"].set()
                        client = message.get("args", {}).get("client_id", "")
                        key = (message.get("operation"), client) if client or message.get("operation") == "search_query" else ("request", message["id"])
                        if key in waiting:
                            slot = waiting[key]
                            slot["cancelled"].set()
                            cancellations.pop(slot["request"]["id"], None)
                            slot.update(request=message, cancelled=cancelled)
                        else:
                            slot = {"key": key, "request": message, "cancelled": cancelled}
                            waiting[key] = slot
                            queue.put(slot)
            except (ValueError, KeyError, TypeError):
                pass
    finally:
        with mutex:
            stopped.set()
            building["cancelled"].set()
            for event in cancellations.values():
                event.set()
        queue.put(None)


def main():
    Thread(target=receive, daemon=True).start()
    index = None
    try:
        while True:
            item = queue.get()
            if item is None:
                break
            with mutex:
                waiting.pop(item["key"], None)
                request, cancelled = item["request"], item["cancelled"]
            try:
                if request.get("operation") not in {"search_query", "search_locate"}:
                    raise PluginError("invalid_search", "此进程仅接受只读检索与定位。")
                session = TranslationSession(request, cancelled)
                session.check_cancelled()
                work = session.bound_work()
                if request.get("args", {}).get("project_id") != session.state["binding"]["project_id"]:
                    raise PluginError("project_changed", "检索工程与当前根对话绑定不一致。")
                if index and (index.work != work or index.project_id != session.state["binding"]["project_id"]):
                    index.close()
                    index = None
                index = index or SearchIndex(session)
                started = perf_counter()
                # Keyword changes replace the pending query, not a shared build
                # which the same project still needs. Closing/switching cancels it.
                with mutex:
                    if stopped.is_set():
                        raise PluginError("cancelled", "检索窗口已关闭。")
                    building["project"] = session.state["binding"]["project_id"]
                    building["cancelled"].clear()
                session.cancelled = building["cancelled"]
                try:
                    index.ensure(session)
                finally:
                    session.cancelled = cancelled
                    with mutex:
                        building["project"] = None
                prepared = perf_counter()
                session.check_cancelled()
                data = index.query(session, request["args"]) if request["operation"] == "search_query" else index.locate(session, request["args"])
                if request["args"].get("diagnostics") is True:
                    data["metrics"] = {"prepare_ms": round((prepared-started)*1000, 2), "query_ms": round((perf_counter()-prepared)*1000, 2),
                                       "last_build": getattr(index, "last_build", None), "build_count": getattr(index, "build_count", 0), **memory_stats()}
                result = {"id": request["id"], "ok": True, "data": data}
            except Exception as error:
                if isinstance(error, sqlite3.DatabaseError) and index:
                    index.close()
                    index = None
                result = {"id": request["id"], "ok": False, "error": {"code": getattr(error, "code", "search_error"), "message": str(error)}}
            with mutex:
                cancellations.pop(request["id"], None)
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    finally:
        if index:
            index.close()


if __name__ == "__main__":
    main()
