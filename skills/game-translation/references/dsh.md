# DSH-translate 宿主适配

此页只适用于随 DSH-translate 提供的 Skill 副本。Core 与通用引擎规则来自原 Skill；具体执行优先使用本插件工具，不猜测旁边的 run.py、EXE 或用户盘符。

常规翻译按 SKILL.md 的闭环操作；本页主要用于初始化、切换、修复和权限核对。工具默认模型呈现为摘要，detail="full" 显示完整诊断，程序和 UI 的完整返回值不变。scenes/reading_groups 默认每页 20 项，read_scene/read_group 默认每页 40 条。真实包和草稿保留完整内容。

## 原会话与初始化

1. 用 `translation_status` 取得当前根对话绑定。工具执行上下文来自真实 Agent，不能通过参数选择另一个会话。子 Agent 使用主 Agent 提供的包和资料，不能改绑/提交父工程。
2. 新游戏使用 `translation_begin_initialization(game_dir, work_dir?)`。同目录已绑定只提醒；pending 时继续已登记 request，不反复创建。
3. 切换时工具先返回 `switch_notice`。仅当用户已明确请求/同意切换时，将提醒告知用户并带回 notice_token 继续；否则先询问。token 是看过提醒的凭据，不是用户授权或跳过 DSH 权限。
4. 调用 `translation_prepare(request_id, options?)`，由原 Core 检测、解包并建立工程。依赖缺失、提取不足和适配需求沿原 references 分支处理。失败的真实工具结果、日志位置和绑定状态保留，在原聊天说明。
5. 通用工具完成了可信解包而 Core 工程尚未建立时，可以用 `translation_register_resources` 登记真实非空资源文件。只能引用该请求 GAME/WORK 内的资源；不得用日志、报告或空文件冒充资源。需要局部适配时，在授权 WORK 编写原 Skill 规定的 adapter.py，通过 prepare options.adapter_file 接回。
6. 资源绑定后不能再次走普通初始化。工程未就绪时可继续同 request_id 的 prepare；旧 WORK 有残留导致 Core 拒绝时，明确说明并使用新的 repair_work_dir，失败产物保留。

prepare 失败会释放 pending，保留产物和错误，允许修复后重试；失败本身不建立初始化锁。主 Agent 明确登记真实资源后可进入 resources_ready，之后普通初始化锁定，继续同 request 修复即可。UI 选择新目录时先解除旧绑定；聊天发起切换时，新资源成功前保留旧绑定。Agent 回合的错误/中断会按已消费的 request_id 对应恢复；仍在排队的意图不会被其他回合误取消。中断或重启状态不明时先查询作业；明确结束后使用 `translation_abandon_initialization`，不自动重做副作用。

## 翻译与封装

绑定返回 Core project_id，后续 Scene/包/草稿/提交/构建必须显式携带这个 project_id。已切换工程时旧请求会被拒绝，不允许重新填当前 ID 强行把旧译文应用到新游戏。

`translation_scenes/read_scene → create_package → 翻译/审校 → save_draft → apply_draft`。只返回包内全部 target_ids；草稿仅含 id、translation、uncertain。编辑已有草稿先 read_draft 并带回 expected_revision。提交读 counts/review/duplicate；NEEDS_HUMAN 不是规则通过，ERROR 不是成功。

`translation_delegate(project_id, package_id, model_id?, retry?)` 将真实包交给 DSH 原生子 Agent，省略 model_id 继承主模型，也可使用用户在设置保存的翻译模型。同一父会话/工程/包/模型默认复用已有任务，active 不重派；只有核对已结束任务且明确重试时才 retry=true。DSH 的 parent delivery 自动投递完成通知。

`translation_delegation_result(child_id, wait_ms?)` 读取真实终态与完整结构化结果，wait_ms=0 立即查询，最多等待 60000ms；running 是未完成，不是失败。`translation_wait_delegations(child_ids, mode?, timeout_ms?)` 可等待首个或全部完成，返回小摘要和 completed_ids，再逐项取完整译文。等待超时/取消不取消或重派子任务。主 Agent 按原 collaboration.md 核对全部 target_ids、审校并统一提交。协议适配归 DSH，Skill 不实现另一套工具循环。插件重启后进程内缓存不代表 DSH 子任务历史，先核对原生轨迹和已保存草稿。

用户检查结果并明确确认封装后，调用 `translation_status` 获取当前真实用户消息 ID，作为 `translation_build.confirmation_message_id`，同时提供新的独立 output_dir。这个字段只能引用真实用户消息，不能引用主/子 Agent、资源文本或插件通知。是否表达封装授权由主 Agent 根据真实用户原话判断；Host 校验来源和当前消息身份，DSH 原权限策略仍生效，不声称通过自然语言自动证明了用户意图。

窗口“确认封装”已记录真实用户命令同意时，可以使用随请求提供的 `build_consent.id`；只对同工程、同绑定版本、同输出目录有效，不能自行改输出位置或工程。窗口只登记并通知，仍由主 Agent 调用 build。

Core build 内含读回，无疑点时不用等价重跑 verify。输出的读回匹配、提取覆盖、译文质量、字体和游戏运行分别报告。不自动启动游戏。

## 目录与错误

工作区内路径及管理员配置的根目录可用。工作区外游戏未授权时，由用户使用真实命令 `/translation allow-game {"game_dir":"D:/Games/Example"}`，或 `/翻译` 的原生目录选择入口授权；没有模型工具能给自己新增目录权限。Core 的目录独立规则继续适用。

`translation_job(job_id)` 查询本会话完整作业记录。失败后先核对状态；提交成功但展示失败不能重提交。Worker 取消会协作通知 Core，必要时回收进程树；已有产物与记录保留，不保证回滚。

job 默认模型摘要，日志路径/完整记录用 detail="full"；已就绪工程的提取/构建/读回报告可用 translation_read_report(project_id, report="extraction"|"build"|"verify"|"prepare_diagnostics", offset?, limit?) 按需读。未建立工程时使用原作业记录排错，不为看报告重复初始化。

按需用 `translation_read_skill_resource(path, offset?, limit?)` 读取本目录其他 references。`/翻译` 打开辅助独立窗口，不发模型请求；具体处理在原聊天。`/translation status` 等带参数命令保留用于后台操作。
