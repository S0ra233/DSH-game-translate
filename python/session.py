"""根会话绑定与初始化状态；仅真实资源证据可以推进绑定。"""
from pathlib import Path
from uuid import uuid4
import os

from storage import PluginError, admit, exclusive, identity, load, now, resolve, save, within


class TranslationSession:
    def __init__(self, request, cancelled):
        self.request, self.cancelled = request, cancelled
        context, config = request["context"], request["config"]
        self.workspace = Path(context["workspace"]).resolve(strict=True)
        self.root = Path(config["dataDirectory"]).resolve()
        self.home = self.root / "sessions" / identity(context["sessionId"])
        self.state_file = self.home / "binding.json"
        self.state = load(self.state_file, {"schema_version": 1, "session_id": context["sessionId"],
            "workspace": str(self.workspace), "version": 0, "binding": None,
            "pending": None, "notice": None, "grants": []})
        if self.state.get("schema_version") != 1:
            raise PluginError("unsupported_state_version", "绑定数据版本暂不受支持，请使用兼容的插件版本；原数据已保留。")
        if self.state["workspace"] != str(self.workspace):
            raise PluginError("workspace_changed", "该根会话的工作目录与已有绑定记录不同，请核对会话。")
        self.game_roots = [self.workspace, *map(Path, config["allowedGameRoots"]),
                           *map(Path, self.state["grants"])]
        self.work_roots = [self.workspace, *map(Path, config["allowedWorkRoots"])]
        self.work_roots.extend(map(Path, self.state.get("work_grants", [])))

    def persist(self):
        self.state["updated_at"] = now()
        save(self.state_file, self.state)

    def check_cancelled(self):
        if self.cancelled.is_set():
            raise PluginError("cancelled", "操作已停止，已有资源、绑定和日志保留。")

    def request_path(self, request_id):
        if not isinstance(request_id, str) or len(request_id) != 32 or any(c not in "0123456789abcdef" for c in request_id):
            raise PluginError("invalid_request", "初始化请求编号无效。")
        return self.home / "requests" / (request_id + ".json")

    def initialization(self, request_id):
        record = load(self.request_path(request_id))
        if not record:
            raise PluginError("unknown_request", "当前根会话没有此初始化请求。")
        binding, pending = self.state["binding"], self.state["pending"]
        if pending and pending["request_id"] != request_id:
            raise PluginError("stale_request", "已有更新的初始化/切换请求，旧请求不能修改当前绑定。")
        active = pending and pending["request_id"] == request_id
        bound = binding and binding["request_id"] == request_id
        if not active and not bound:
            raise PluginError("stale_request", "此初始化请求已失效，不能覆盖当前绑定。")
        return record

    def begin(self, args):
        game = admit(args["game_dir"], self.workspace, self.game_roots, directory=True)
        binding, pending = self.state["binding"], self.state["pending"]
        if pending:
            return {"status": "initialization_pending", "message": "初始化请求已存在，不重复启动。请在原聊天继续或明确结束此请求。", "pending": pending}
        if binding and Path(binding["game_dir"]) == game:
            return {"status": "already_initialized", "message": "该游戏已初始化并绑定当前对话，无需重复初始化；请直接翻译，或在原聊天继续处理问题。", "binding": binding}
        notice = None
        if binding:
            text = f"当前绑定 {binding['game_dir']}；将切换到 {game} 并初始化。模型分析将消耗所用模型额度，旧工程保留。"
            previous = self.state["notice"]
            confirmed = self.request["context"].get("humanCommand", False)
            acknowledged = (previous and previous["token"] == args.get("notice_token")
                            and previous["game_dir"] == str(game) and previous["version"] == self.state["version"])
            if not confirmed and not acknowledged:
                self.state["notice"] = {"token": uuid4().hex, "game_dir": str(game), "version": self.state["version"]}
                self.persist()
                return {"status": "switch_notice", "message": text,
                        "notice_token": self.state["notice"]["token"], "next_step": "仅在用户已要求或同意切换时，告知用户此提醒并带回 notice_token 再调用；否则先询问用户。"}
            notice = text
        request_id = uuid4().hex
        default_work = self.workspace / "translations" / request_id
        work = admit(args.get("work_dir", str(default_work)), self.workspace, self.work_roots)
        if game == work or game in work.parents or work in game.parents:
            raise PluginError("overlapping_directories", "GAME 与 WORK 必须独立，不能互相嵌套。")
        if work.exists() and any(work.iterdir()):
            raise PluginError("work_not_empty", "新初始化需新的空 WORK；已有工程请使用 open_project。")
        record = {"request_id": request_id, "game_dir": str(game), "work_dir": str(work),
                  "base_version": self.state["version"], "phase": "awaiting_agent", "created_at": now(), "notice": notice}
        save(self.request_path(request_id), record)
        self.state.update(pending=record, notice=None)
        self.state["last_request"] = request_id
        self.persist()
        return {"status": "initialization_requested", "message": notice or "初始化请求已登记，尚未解包；由当前会话 Agent 加载 Skill 并继续。", "request": record}

    def bind_resources(self, record, paths, project=None):
        """登记已存在的非空资源文件；目录和自然语言成功声明不是证据。"""
        if not paths:
            raise PluginError("resources_missing", "尚无可登记的实际资源文件。")
        game, work = Path(record["game_dir"]), Path(record["work_dir"])
        evidence = []
        for value in paths:
            path = resolve(value, work)
            if project is None and (path.suffix.lower() == ".log" or path.name.endswith(("_report.json", "_diagnostics.json"))
                                    or path.name in {"adapter.py", "project.json", "entries.json", "tasks.jsonl", "glossary.md", "style.md", "proper_nouns.md"}):
                raise PluginError("invalid_resource", "日志、工程元数据和临时适配代码不能当作已解包资源。", path=str(path))
            if not within(path, [game, work]) or not path.is_file() or path.stat().st_size == 0:
                raise PluginError("invalid_resource", "资源须是当前游戏或本次 WORK 内实际存在的非空文件。", path=str(path))
            evidence.append(str(path))
        current = self.state["binding"]
        if current and current["request_id"] != record["request_id"] and self.state["version"] != record["base_version"]:
            raise PluginError("stale_request", "绑定已更新，拒绝迟到的资源结果。")
        self.state["version"] += 1
        self.state["binding"] = {"version": self.state["version"], "request_id": record["request_id"],
            "game_dir": str(game), "work_dir": str(work), "resources": evidence[:128],
            "project_id": project["project_id"] if project else None,
            "phase": "project_ready" if project else "resources_ready", "bound_at": now()}
        self.state["selected_game"] = str(game)
        self.state["initialization_error"] = None
        record["phase"] = self.state["binding"]["phase"]
        save(self.request_path(record["request_id"]), record)
        self.state["pending"] = None
        self.persist()
        return self.state["binding"]

    def bound_work(self):
        binding = self.state["binding"]
        if not binding or binding["phase"] != "project_ready":
            raise PluginError("project_not_ready", "尚无就绪的 Core 翻译工程，请在原聊天完成初始化。")
        work = admit(binding["work_dir"], self.workspace, self.work_roots, directory=True)
        return work

    def work_lock(self, work):
        return exclusive(self.root / "locks" / ("work-" + identity(os.path.normcase(str(work))) + ".lock"))

    def authorize_game(self, args):
        if not self.request["context"].get("humanCommand", False):
            raise PluginError("user_only", "目录授权仅接受用户命令，Agent 不能给自己授权。")
        path = resolve(args["game_dir"], self.workspace)
        if not path.is_dir():
            raise PluginError("directory_missing", "游戏目录不存在。")
        self.state["grants"] = sorted(set([*self.state["grants"], str(path)]))
        self.persist()
        return {"status": "authorized", "game_dir": str(path), "message": "仅为当前根会话授权此游戏目录；不改变绑定，也不开始解包。"}

    def select_game(self, args):
        if not self.request["context"].get("humanCommand"):
            raise PluginError("user_only", "界面选择游戏目录仅接受用户操作。")
        if self.state["pending"]:
            raise PluginError("busy", "初始化仍在进行，请先在原聊天结束或停止。")
        game = admit(args["game_dir"], self.workspace, self.game_roots, directory=True)
        if self.state["binding"] and Path(self.state["binding"]["game_dir"]) == game:
            return {"status": "unchanged", "state": self.state}
        if self.state["binding"]:
            self.state.setdefault("previous_bindings", []).append(self.state["binding"])
        self.state.update(binding=None, selected_game=str(game), notice=None, initialization_error=None)
        self.state["version"] += 1
        self.persist()
        return {"status": "selected", "state": self.state}

    def authorize_work(self, args):
        if not self.request["context"].get("humanCommand"):
            raise PluginError("user_only", "输出目录授权仅接受真实用户选择。")
        path = resolve(args["path"], self.workspace)
        if not path.is_dir():
            raise PluginError("directory_missing", "输出父目录不存在。")
        self.state["work_grants"] = sorted(set([*self.state.get("work_grants", []), str(path)]))
        self.persist()
        return {"path": str(path)}

    def approve_build(self, args):
        if not self.request["context"].get("humanCommand"):
            raise PluginError("user_only", "写回确认仅接受真实用户操作。")
        binding = self.state["binding"]
        if not binding or binding["phase"] != "project_ready":
            raise PluginError("project_not_ready", "工程尚未就绪。")
        output = admit(args["output_dir"], self.workspace, self.work_roots)
        from game_translation.storage import separate_directories
        separate_directories(Path(binding["game_dir"]), output)
        separate_directories(Path(binding["work_dir"]), output)
        if output.exists():
            raise PluginError("output_exists", "请使用尚不存在的新输出目录。")
        self.state["build_consent"] = {"id": self.request["context"]["userMessage"]["id"],
            "project_id": binding["project_id"], "version": self.state["version"], "output_dir": str(output)}
        self.persist()
        return self.state["build_consent"]

    def abandon(self, args):
        pending = self.state["pending"]
        if not pending or pending["request_id"] != args["request_id"]:
            raise PluginError("stale_request", "没有对应的待处理初始化请求。")
        pending.update(phase="abandoned", reason=args["reason"])
        save(self.request_path(args["request_id"]), pending)
        self.state["pending"] = None
        self.persist()
        return {"status": "abandoned", "message": "请求已结束，旧绑定、资源及日志保留。"}

    def fail_initialization(self, args):
        pending = self.state["pending"]
        if not pending or pending["request_id"] != args["request_id"]:
            raise PluginError("stale_request", "初始化状态已更新，不改写新的请求。")
        pending.update(phase="failed", error=args["reason"])
        save(self.request_path(args["request_id"]), pending)
        self.state.update(pending=None, initialization_error={"request_id": args["request_id"], "message": args["reason"]})
        self.persist()
        return {"status": "failed", "message": args["reason"]}
