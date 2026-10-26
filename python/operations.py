"""翻译操作的唯一业务入口；UI/命令/Agent 均通过 Worker 调用。"""
from pathlib import Path
from collections import Counter
from uuid import uuid4
import json

import game_translation as core
from storage import PluginError, admit, exclusive, identity, load, now, resolve, save, within


PREPARE_OPTIONS = {"source_locale", "target_locale", "text_locale", "text_overrides", "adapter_file",
                   "candidate_selection", "godot_executable"}
IGNORED_EVIDENCE = {"project.json", "entries.json", "tasks.jsonl", "tasks.previous.jsonl",
                    "proper_nouns.md", "glossary.md", "style.md", "prepare_diagnostics.json", "adapter.py"}


def resource_files(work):
    """只观察本次 WORK 的有界资源文件；不把错误报告或日志当作解包成功。"""
    found = []
    if not work.exists():
        return found
    visited = 0
    for path in work.rglob("*"):
        visited += 1
        if visited > 4096:
            break
        resolved = path.resolve()
        if (within(resolved, [work]) and path.is_file() and path.stat().st_size
                and path.name not in IGNORED_EVIDENCE and not path.name.endswith(("_report.json", ".log"))
                and ".dsh-translate" not in path.parts):
            found.append(str(resolved))
            if len(found) >= 128:
                break
    return found


def options_for(session, options, names, roots):
    if not isinstance(options, dict) or set(options) - names:
        raise PluginError("invalid_options", "选项含未支持的字段。", allowed=sorted(names))
    result = dict(options)
    for key in {"adapter_file", "font", "tmp_font"} & result.keys():
        if result[key] is not None:
            result[key] = str(admit(result[key], session.workspace, roots))
    for key in {"text_overrides", "candidate_selection", "font_plan"} & result.keys():
        if result[key] is not None and not isinstance(result[key], dict):
            path = admit(result[key], session.workspace, roots)
            result[key] = json.loads(path.read_text(encoding="utf-8-sig"))
        if result[key] is not None and not isinstance(result[key], dict):
            raise PluginError("invalid_options", f"{key} 须为 JSON 对象或受允许的 JSON 文件。")
    plan = result.get("font_plan")
    if plan:
        if plan.get("donor_game_dir"):
            plan["donor_game_dir"] = str(admit(plan["donor_game_dir"], session.workspace, session.game_roots, directory=True))
        for item in plan.get("replacements", []):
            if isinstance(item, dict) and item.get("font_file"):
                item["font_file"] = str(admit(item["font_file"], session.workspace, roots))
    return result


def prepare(session, args):
    record = session.initialization(args["request_id"])
    binding = session.state["binding"]
    if binding and binding["request_id"] == record["request_id"] and binding["phase"] == "project_ready":
        return {"status": "already_initialized", "message": "工程已就绪，不重复初始化。", "binding": binding}
    game = admit(record["game_dir"], session.workspace, session.game_roots, directory=True)
    work = admit(args.get("repair_work_dir", record["work_dir"]), session.workspace, session.work_roots)
    if str(work) != record["work_dir"]:
        record["previous_work_dir"] = record["work_dir"]
        record["work_dir"] = str(work)
    options = options_for(session, args.get("options", {}), PREPARE_OPTIONS, [*session.work_roots, work])
    if options.get("godot_executable"):
        options["godot_executable"] = str(admit(options["godot_executable"], game, [game]))
    before = set(resource_files(work))
    with session.work_lock(work):
        session.check_cancelled()
        record.update(phase="preparing", started_at=now())
        save(session.request_path(record["request_id"]), record)
        session.state["pending"] = record
        session.persist()
        try:
            report = core.prepare(game, work, **options)
            if report.get("project_updated") is False:
                raise PluginError("project_not_created", "提取未建立新的 Core 工程，请查看提取报告并在原聊天继续处理。", report=report)
            manifest, _, _ = core.load_project(work)
            binding = session.bind_resources(record, [str(work / "project.json")], manifest)
            return {"status": "project_ready", "binding": binding, "report": report}
        except Exception as exc:
            # 最新 UI 规则：失败产物保留，但失败不建立初始化锁。
            paths = [value for value in resource_files(work) if value not in before]
            record.update(phase="failed", partial_resources=paths, error=str(exc))
            save(session.request_path(record["request_id"]), record)
            session.state.update(pending=None, initialization_error={"request_id": record["request_id"], "message": str(exc), "partial_resources": paths})
            session.persist()
            raise


def open_project(session, args):
    work = admit(args["work_dir"], session.workspace, session.work_roots, directory=True)
    with session.work_lock(work):
        manifest, _, _ = core.load_project(work)
        game = admit(manifest["game_dir"], session.workspace, session.game_roots, directory=True)
        current = session.state["binding"]
        if current and current["game_dir"] == str(game) and current["work_dir"] == str(work):
            if current["phase"] != "project_ready":
                record = session.initialization(current["request_id"])
                current = session.bind_resources(record, [str(work / "project.json")], manifest)
            return {"status": "already_bound", "binding": current}
        # 与新初始化共用切换提醒；现有工程接入不重新解包。
        result = session.begin({"game_dir": str(game), "notice_token": args.get("notice_token")})
        if result["status"] != "initialization_requested":
            return result
        record = result["request"]
        record["work_dir"] = str(work)
        binding = session.bind_resources(record, [str(work / "project.json")], manifest)
        return {"status": "project_ready", "binding": binding}


def project(session):
    work = session.bound_work()
    manifest, entries, tasks = core.load_project(work)
    if manifest["project_id"] != session.state["binding"]["project_id"]:
        raise PluginError("project_replaced", "WORK 的工程身份已改变，请核对当前绑定。")
    if Path(manifest["game_dir"]).resolve() != Path(session.state["binding"]["game_dir"]):
        raise PluginError("project_game_changed", "工程内的游戏来源与会话绑定不一致。")
    temporary = manifest["engine"].get("temporary_adapter")
    if temporary:
        admit(temporary["path"], work, [work])
    return work, manifest, entries, tasks


def draft_path(work, draft_id):
    if not isinstance(draft_id, str) or len(draft_id) != 32 or any(c not in "0123456789abcdef" for c in draft_id):
        raise PluginError("invalid_draft", "草稿编号无效。")
    return work / ".dsh-translate" / "drafts" / (draft_id + ".json")


def package_from(work, package_id):
    if not isinstance(package_id, str) or not package_id.startswith("p_") or len(package_id) != 26 or any(c not in "0123456789abcdef" for c in package_id[2:]):
        raise PluginError("invalid_package", "翻译包编号无效。")
    package = load(work / "packages" / (package_id + ".json"))
    if not package or package["id"] != package_id:
        raise PluginError("unknown_package", "翻译包不存在。")
    return package


def complete_results(package, results):
    if not isinstance(results, list):
        raise PluginError("invalid_results", "翻译结果须为数组。")
    ids = []
    for item in results:
        if (not isinstance(item, dict) or set(item) != {"id", "translation", "uncertain"}
                or not isinstance(item["id"], str) or not isinstance(item["translation"], str)
                or type(item["uncertain"]) is not bool):
            raise PluginError("invalid_results", "每项须且只能含 id、字符串 translation、布尔 uncertain。")
        ids.append(item["id"])
    wanted = set(package["target_ids"])
    if len(set(ids)) != len(ids) or set(ids) != wanted:
        raise PluginError("incomplete_targets", "结果必须恰好覆盖全部目标；尚未调用 Core，任务未修改。",
                          missing=sorted(wanted - set(ids)), unexpected=sorted(set(ids) - wanted))


def project_operation(session, operation, args):
    work = session.bound_work()
    with session.work_lock(work):
        work, manifest, entries, tasks = project(session)
        if args.get("project_id") != manifest["project_id"]:
            raise PluginError("project_changed", "请求的工程与当前绑定不同，拒绝将旧任务写入新游戏。")
        if operation == "read_report":
            names = {"extraction": "extraction_report.json", "build": "build_report.json", "verify": "verify_report.json", "prepare_diagnostics": "prepare_diagnostics.json"}
            if args.get("report") not in names:
                raise PluginError("invalid_report", "报告仅支持 extraction/build/verify/prepare_diagnostics。")
            offset, limit = args.get("offset", 0), args.get("limit", 6000)
            if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 20000:
                raise PluginError("invalid_page", "报告 offset 须非负，limit 须为 1 至 20000 的整数。")
            path = (work / names[args["report"]]).resolve()
            if not within(path, [work]) or not path.is_file():
                raise PluginError("report_unavailable", "当前工程尚无该报告，或报告位置不在 WORK 内。")
            content = path.read_text(encoding="utf-8-sig")
            return {"project_id": manifest["project_id"], "report": args["report"], "text": content[offset:offset+limit],
                    "total_characters": len(content), "next_offset": offset+limit if offset+limit < len(content) else None}
        if operation in {"reading_groups", "reading_group", "resolve_reading_groups"}:
            from reading_groups import build_groups, select_groups
            plan = build_groups(manifest, entries, tasks)
            if operation == "reading_groups":
                offset, limit = page(args)
                return {"project_id": manifest["project_id"], "rule_version": plan["rule_version"],
                        "capacity": plan["capacity"], "original_scene_count": plan["original_scene_count"],
                        "total": len(plan["groups"]), "groups": plan["groups"][offset:offset+limit],
                        "next_offset": offset+limit if offset+limit < len(plan["groups"]) else None}
            selected = select_groups(plan, args.get("group_ids") if operation == "resolve_reading_groups" else [args.get("group_id")])
            wanted = {scene for group in selected for scene in group["scene_ids"]}
            if operation == "resolve_reading_groups":
                pending = {task["scene_id"] for task in tasks if task["status"] != "PROCESSED"}
                ids = [scene["id"] for scene in manifest["scenes"] if scene["id"] in wanted and scene["id"] in pending]
                return {"project_id": manifest["project_id"], "group_ids": [group["id"] for group in selected],
                        "scene_ids": ids, "scene_batches": [ids[index:index+100] for index in range(0, len(ids), 100)]}
            offset, limit = page(args)
            members = [task for task in tasks if task["scene_id"] in wanted]
            return {"project_id": manifest["project_id"], "group": selected[0], "total": len(members),
                    "sections": selected[0]["sections"], "tasks": members[offset:offset+limit],
                    "next_offset": offset+limit if offset+limit < len(members) else None}
        if operation == "edit_translation":
            from manual_edit import edit_translation
            return edit_translation(work, manifest, tasks, args, session.request["context"])
        if operation == "scenes":
            offset, limit = page(args)
            counts = Counter(t["status"] for t in tasks)
            by_scene = {}
            for task in tasks:
                by_scene.setdefault(task["scene_id"], Counter())[task["status"]] += 1
            scenes = [{**row, "counts": dict(by_scene.get(row["id"], {}))} for row in manifest["scenes"]]
            return {"project_id": manifest["project_id"], "counts": dict(counts), "total": len(scenes),
                    "scenes": scenes[offset:offset+limit], "next_offset": offset+limit if offset+limit < len(scenes) else None}
        if operation == "scene":
            selected = next((s for s in manifest["scenes"] if s["id"] == args["scene_id"]), None)
            if selected is None:
                raise PluginError("unknown_scene", "当前工程没有此 Scene。")
            selected_tasks = [t for t in tasks if t["scene_id"] == selected["id"]]
            offset, limit = page(args)
            return {"project_id": manifest["project_id"], "scene": selected, "total": len(selected_tasks),
                    "tasks": selected_tasks[offset:offset+limit], "next_offset": offset+limit if offset+limit < len(selected_tasks) else None}
        if operation == "package":
            options = options_for(session, args.get("options", {}), {"context", "window", "include_review", "max_chars"}, [])
            return core.make_package(work, args.get("scene_id"), args.get("target_ids"), **options)
        if operation == "read_package":
            return package_from(work, args["package_id"])
        if operation == "save_draft":
            package = package_from(work, args["package_id"])
            complete_results(package, args["results"])
            draft_id = args.get("draft_id", uuid4().hex)
            path = draft_path(work, draft_id)
            existing = load(path)
            revision = existing["revision"] if existing else 0
            if args.get("expected_revision", 0) != revision:
                raise PluginError("draft_conflict", "草稿已更新，请重新读取后合并，不能覆盖新的人工编辑。", revision=revision)
            if existing and existing["package_id"] != package["id"]:
                raise PluginError("draft_package_changed", "不能将现有草稿改绑另一个翻译包。")
            value = {"id": draft_id, "revision": revision+1, "package_id": package["id"],
                     "project_id": manifest["project_id"], "input_hash": package["input_hash"],
                     "results": args["results"], "updated_at": now(), "status": "draft"}
            save(path, value)
            return {"status": "draft_saved", "draft_id": draft_id, "revision": value["revision"], "path": str(path)}
        if operation in {"read_draft", "apply"}:
            path = draft_path(work, args["draft_id"])
            draft = load(path)
            if not draft or draft["project_id"] != manifest["project_id"]:
                raise PluginError("unknown_draft", "当前工程没有此草稿。")
            if operation == "read_draft":
                return draft
            if args["expected_revision"] != draft["revision"]:
                raise PluginError("draft_conflict", "草稿版本已改变，不能提交旧内容。")
            package = package_from(work, draft["package_id"])
            complete_results(package, draft["results"])
            report = core.apply_results(work, package["id"], draft["results"])
            # Core 成功后先返回真实事实；附属草稿状态写失败不能诱导重提交。
            result = {"status": "applied", "report": report, "draft_id": draft["id"], "revision": draft["revision"]}
            try:
                draft.update(status="applied", apply_report=report, applied_at=now())
                save(path, draft)
            except OSError as exc:
                result["notice"] = f"Core 提交已完成，草稿附属状态保存失败；请只核对/重读：{exc}"
            return result
        if operation in {"build", "verify"}:
            output = admit(args["output_dir"], session.workspace, session.work_roots, directory=operation == "verify")
            from game_translation.storage import separate_directories
            separate_directories(Path(manifest["game_dir"]).resolve(), output)
            separate_directories(work, output)
            if operation == "verify":
                return core.verify(work, output)
            approval = session.request["context"].get("userMessage")
            consent = session.state.get("build_consent")
            ui_approved = (consent and consent["id"] == args["confirmation_message_id"]
                and consent["project_id"] == manifest["project_id"] and consent["version"] == session.state["version"]
                and consent["output_dir"] == str(output))
            if not ui_approved and (not approval or approval["id"] != args["confirmation_message_id"]):
                raise PluginError("confirmation_required", "封装须引用当前真实用户确认消息，不能引用 Agent 或子任务文本。")
            options = options_for(session, args.get("options", {}), {"allow_partial", "font", "tmp_font", "font_plan"}, session.work_roots)
            return core.build(work, output, **options)
    raise PluginError("unknown_operation", "没有此工程操作。")


def page(args):
    offset, limit = args.get("offset", 0), args.get("limit", 100)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise PluginError("invalid_page", "offset 须非负，limit 须为 1 至 200 的整数。")
    return offset, limit


def dispatch(session, operation, args):
    session.check_cancelled()
    if operation == "status":
        records = []
        folder = session.home / "operations"
        if folder.exists():
            for path in sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
                value = load(path)
                if value["operation"] not in {"status", "job"}:
                    records.append({key: value.get(key) for key in ("job_id", "operation", "status", "started_at", "finished_at", "log_path")})
        return {"state": session.state, "user_message": session.request["context"].get("userMessage"), "recent_operations": records,
                "message": "绑定是持久状态；pending 不代表模型已经开始。处理详情见当前 DSH 对话。"}
    if operation == "job":
        job_id = args["job_id"]
        session.request_path(job_id)
        value = load(session.home / "operations" / (job_id+".json"))
        if not value:
            raise PluginError("unknown_job", "当前根会话没有此作业。")
        if value["status"] == "running":
            try:
                with exclusive(session.root / "locks" / ("session-"+identity(session.state["session_id"])+".lock")):
                    value["observed_status"] = "interrupted_or_result_unknown"
                    value["notice"] = "当前无会话写作业持锁；原作业可能中断，需核对工程与结果，不自动重跑。"
            except PluginError:
                value["observed_status"] = "session_operation_active"
        return value
    if operation == "authorize_game":
        return session.authorize_game(args)
    if operation == "select_game":
        return session.select_game(args)
    if operation == "authorize_work":
        return session.authorize_work(args)
    if operation == "approve_build":
        return session.approve_build(args)
    if operation == "begin":
        return session.begin(args)
    if operation == "abandon":
        return session.abandon(args)
    if operation == "fail_initialization":
        return session.fail_initialization(args)
    if operation == "prepare":
        return prepare(session, args)
    if operation == "register_resources":
        record = session.initialization(args["request_id"])
        binding = session.state["binding"]
        if binding and binding["request_id"] == record["request_id"] and binding["phase"] == "project_ready":
            return {"status": "already_initialized", "binding": binding}
        manifest = None
        work = Path(record["work_dir"])
        if (work / "project.json").is_file():
            with session.work_lock(work):
                manifest, _, _ = core.load_project(work)
                if Path(manifest["game_dir"]).resolve() != Path(record["game_dir"]):
                    raise PluginError("project_game_changed", "待登记工程属于另一个游戏。")
        binding = session.bind_resources(record, args["paths"], manifest)
        return {"status": binding["phase"], "binding": binding}
    if operation == "open_project":
        return open_project(session, args)
    if operation in {"inspect", "candidates", "fonts"}:
        binding = session.state["binding"]
        value = args.get("game_dir") or (binding and binding["game_dir"])
        game = admit(value, session.workspace, session.game_roots, directory=True)
        if operation == "inspect":
            return core.inspect_resources(game)
        if operation == "fonts":
            return core.inspect_fonts(game, characters=args.get("characters", ""))
        work = admit(args["work_dir"], session.workspace, session.work_roots)
        with session.work_lock(work):
            return core.collect_candidates(game, work_dir=work)
    return project_operation(session, operation, args)
