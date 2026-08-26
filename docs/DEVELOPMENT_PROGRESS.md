# 道生一 · 开发进度

> 按时间记录已完成功能、修复与验证结果，便于回溯与跨会话续接。配套《开发计划》`DEVELOPMENT_PLAN.md`。
>
> **最后更新：2026-08-25**

---

## 2026-08-26

### ✅ 编程代理 P-A4 多文件编辑 + diff（精确编辑原语 + unified diff 预览）
- **背景**：P-A1 Git / P-A2 验证循环 / P-A3 代码库理解 之后，编程 Agent 修改代码的能力闭环
- **Rust（src-tauri/src/lib.rs）**：
  - `sanitize_home_path(path)` helper：展开 ~/ 并校验主目录内（write_file_agent / apply_edits / delete_file_agent 三处复用安全边界）
  - `apply_edits(path, edits)` 命令：一次调用对单文件应用多个**精确编辑操作**——`replace`（old→new，`occurrence` 指定第几次出现，默认第 1 次）、`insert`（在 anchor 文本 before/after 插入 text）、`delete`（精确删除一段，occurrence 支持）；任一 op 未匹配文本即报错且**不写盘**；写盘后校验；返回 `EditResult{path, diff, new_len, summary}`
  - `line_diff(old, new)` 纯函数：行级 LCS diff → `(char, String)` 操作序列；`format_unified_diff` 渲染**标准 unified diff**（@@ 头 + 3 行上下文 + 相邻 hunk 合并）；无改动返回"（无改动）"
  - `nth_occurrence(hay, needle, occ)`：字节偏移定位第 N 次出现；`truncate_disp` 错误信息截断
  - `delete_file_agent(path)` 命令：仅删除主目录内文件、拒绝目录
- **前端（src/stores/chat.ts）**：
  - 新增 4 个内置工具：`replace_string`（精确替换 + 返回 diff，new_text 可空=删除）、`insert_string`（锚点前/后插入）、`create_file`（**仅当目标不存在时创建**，防误覆盖，返回提示）、`delete_file`（删文件）；均走 `apply_edits` / `delete_file_agent` / `write_file_agent`（存在性校验），只允许主目录内
  - 写入类 MCP 守卫更新：`create_file` 从转发覆盖式 write_file 改为转发内置非覆盖版 create_file
  - 系统提示词：内置工具列表加 4 个编辑工具描述（修改已有文件优先 replace_string / insert_string 精确编辑，勿整体重写）；新增「文件编辑规范」区块——编辑前先 read_file 核对、old_text/anchor 逐字一致、编辑后必须在回复中**说明改动**（列出新增/修改/删除行）、改代码必须 run_tests 验证、失败用 read_file 核对后重试
- **验证**：Rust 测试新增 7 项（diff 标记、unified diff 格式、无改动、occurrence 定位、三原语端到端、坏路径/未匹配拒绝且文件不变、delete_file 安全边界）→ cargo test 全过（38 项含 db/settings/search，31 passed + 7 ignored live）；npm test 35 + vite build 通过
- 踩坑：①unified diff context 行是 `" "+text`、删除/新增行是 `-text`/`+text`（**无中间空格**），测试断言 context 行用 ` line2`、删除行用 `-line4`；②`delete "hello"` 不含换行时删完会留空行，断言按"剩 N 处出现"而非精确内容；③追加测试到已闭合 tests 模块需先确认模块结尾
- **后续**：P-A5 任务规划增强（Plan 模式）为下一优先级；应用内 diff「确认后应用」UI 并入 P-A7 权限矩阵

### ✅ 编程代理 P-A5 任务规划增强（Plan 模式：plan_task/plan_update + 进度卡片）
- **背景**：P-A4 之后，编程 Agent 对复杂任务缺乏「先规划、可视进度、逐步推进」能力
- **前端（src/stores/chat.ts + src/components/TaskPlanCard.vue）**：
  - `types/index.ts` 新增 `PlanStepStatus`/`PlanStep`/`TaskPlan` 类型
  - chat store 新增 `taskPlan` ref + `setTaskPlan()`（跨轮/跨消息保留），`clearCurrentConversation` 清空（新对话重置）
  - 内置工具 `plan_task`（app）：`{title, steps[]}` 创建/替换任务计划 → 返回计划清单 + 执行规范；`plan_update`（app）：`{step(1-based), status}` 更新步骤状态（pending/doing/done/failed）→ 返回进度「N/M 完成」；均用 `useChatStore()` 更新 store（模块级函数内取 store 实例，工具循环时 pinia 已激活）
  - `TaskPlanCard.vue`：对话区顶部进度卡片——标题 + 计数（N/M 或「✅ 全部完成」）+ 渐变进度条 + 每步图标（pending 圆圈/doing 旋转 Loader2/done 对勾/failed 红叉）+ 状态徽标 + 手动关闭按钮；lucide 线性图标、主题变量适配深浅色
  - 系统提示词：内置工具加 plan_task/plan_update 描述 + 「任务规划规范」区块——复杂任务（多步骤/多文件/多研究）先 plan_task 分解、逐步 plan_update 更新（Plan→Act→Observe→修正）、全部 done 后给完整最终答案、简单任务不用
- **验证**：npm test 35 + vite build 通过；get_errors 无报错；dev HMR 正常加载（App.vue 8:45 hmr update，日志 EPIPE 为管道噪音非应用错误）
- **踩坑**：模块级 callBuiltinTool 内调用 `useChatStore()` 取 store 实例需在函数体内（运行时 pinia 已激活），不能在模块顶层调用
- **后续**：P-A6 本地语义 embedding 为下一优先级

### ✅ 外部编码 Agent 降级 + 多 agent 协作路线确立（2026-08-26 架构决策）
- **背景决策**：道生一已具备内置编码能力（P-A1~P-A5），外部编码 Agent（Claude Code/Codex）委派是过渡方案；终局为**零外部编码依赖、多 agent 协作内置化**
- **退役路线（写入 ROADMAP §4.5）**：阶段一（当前）外部委派降级为隐藏兜底 → 阶段二内置多 agent 协作（子代理带工具/并行/角色分工/主代理仲裁）→ 阶段三多 agent 成熟后彻底移除外部委派代码
- **第一步落地**：
  - `SettingsDialog.vue` 移除「编码 Agent」tab（import/tab 按钮/面板/类型）；`ui.ts` SettingsTab 去 agents；`main.ts` 菜单分发去 open-agents；Rust 菜单去「编码 Agent 委派」菜单项；**删除 `CodingAgents.vue` 组件**
  - 委派能力保留为**内置工具 `delegate_coding_agent`**（前端 callBuiltinTool 分支调 Rust `delegate_coding_agent` 命令，支持 agent_id/task/cwd/mode/max_turns/resume_session，返回退出码/耗时/token/输出）；提示词标注「外部兜底，慎用，仅当内置编码能力不足且用户明确要求时调用」
  - Rust 命令 `check_coding_agents` / `delegate_coding_agent` 保留（阶段三再彻底移除）
- **多 agent 协作计划（写入 DEVELOPMENT_PLAN §3.8，P-M1~P-M4）**：P-M1 子代理带工具（复用 sendMessage 工具循环）→ P-M2 并行子代理（Promise.all / futures join）→ P-M3 角色分工（规划/执行/验证/评审模板）→ P-M4 主代理汇总仲裁（orchestrator-subagent 树 + 监视面板）；建议推进顺序 P-A6 → P-M1~P-M4 → P-A7/P-A8
- **验证**：cargo check 通过（菜单移除）；npm test 35 + vite build 通过；全工作区 grep 确认无 CodingAgents/agents tab 残留（仅文档记录）

### ✅ 修复：停止按钮无法停止子代理/工具循环（真正的中断机制）
- **用户报告**：两个停止按钮（对话区「⏹ 停止生成」+ 输入框「⏹」）都无法停止正在运行的子代理（召回 agent）操作
- **根因**：`stopStreaming()` 只做 `isStreaming.value = false`（隐藏按钮），**没有真正的取消机制**——正在跑的 `runSubagentLoop`（每轮 `chatOnce` 最长 60s）、主代理工具循环（`while round < MAX`）都不会中断；主代理还阻塞在 `await callMcpTool(subagent_delegate)` 上，停止后它返回仍会继续下一轮
- **修复（src/stores/chat.ts）**：
  - 引入**可取消停止信号**（模块级）：`stopRequested` + `stopWaiters` + `requestStop()`/`resetStop()`/`waitStopSignal()` + `AgentStoppedError`
  - `stopStreaming()` 现在调 `requestStop()`（不只是改标志）；`sendMessage` 主流程开头 `resetStop()`（新消息重置）
  - **子代理循环**：每轮 `Promise.race([chatOnce, waitStopSignal()])`，点停止立即抛 `AgentStoppedError`（不等 60s 超时）；工具执行前/后检查；`subagent_delegate` 捕获 `AgentStoppedError` → 子代理标记「已由用户停止」→ 返回"（子代理已由用户停止）"
  - **主代理工具循环**：`while` 顶部 / `await streamRound` 后 / 执行工具前 / `await callMcpTool` 后 四处检查 `stopRequested` → break（停止后不再调新工具/发起新一轮）
  - **streamRound**：`doneP` race 加 `waitStopSignal()`，停止时提前结束当前流式轮（工具循环随后 break）
- **踩坑**：`runSubagentLoop` 的 race 最初用 `waitStopSignal().then(() => { throw ... })` ——race 已结算后停止信号才触发会 unhandled rejection；改用 **kind 标记**（`{kind:"ok"}` / `{kind:"stop"}`）让停止信号只 resolve 不 throw
- **验证**：npm test 35 + vite build 通过；get_errors 无报错
- **注意**：正在执行的单个工具（如子代理正在调的长工具/`chatOnce` 单次）无法中途掐断（Tauri invoke 无 abort），停止在「当前 await 返回后」立即生效——点停止后子代理不会进入下一轮，主代理不再继续，但正在跑的那一次请求最多等到其自然结束（子代理最多 1 轮 chatOnce 60s）

### ✅ 编程代理 P-M1 子代理带工具（多 agent 协作地基）
- **背景**：外部编码 Agent 降级后，研发重心转向内置多 agent 协作；P-M1 是第一步——让子代理从"纯对话"升级为"能调内置工具"
- **实现（src/stores/chat.ts）**：
  - 新增模块级 `runSubagentLoop(config, sysPrompt, goal, opts)`：子代理工具循环——`chatOnce`（非流式）→ `parseToolCall` 从返回内容解析工具调用 → `callMcpTool` 执行（复用主代理工具执行器，内置工具+安全边界一致）→ `<tool_result>` 回填上下文 → 继续下一轮，直到无工具调用返回最终结论；`opts.allowTools` 可关（纯对话子代理）、`maxRounds` 默认 8
  - `subagent_delegate` 工具改造：新增 `allow_tools` 参数（默认 true）；子代理系统提示词注入工具列表（`getMcpToolsPrompt()`）+「可调用内置工具完成子任务，能动手查证/修改/测试就不只靠推理」引导
  - 与主代理差异：非流式 + 无 UI 流式副作用（后台任务，SubagentPanel 只显示状态），符合子代理定位
- **验证**：npm test 35 + vite build 通过；get_errors 无报错
- **注意**：子代理工具循环复用 `callMcpTool`（模块级状态 mcpToolsCache/browserNavigated），P-M2 并行子代理时需处理状态竞争（各子代理独立上下文已隔离，MCP 连接状态共享需加锁/串行浏览器操作）
- **后续**：P-M2 并行子代理（Promise.all 多 runSubagentLoop 并发）→ P-M3 角色分工 → P-M4 主代理汇总仲裁

### ✅ 联网搜索无关结果修复（三层根因：关键词清洗 / 单源填满 / 相关性过滤）
- **用户报告**：搜索"说说什么是人工智能神经网络"返回 11 条全是微软股票（MSFT）等完全无关内容
- **根因链（三层叠加）**：
  1. **关键词清洗 bug（主因）**：`extractSearchKeywords("说说什么是人工智能神经网络")` 返回**完整整句**——疑问词正则是"是什么"（X 是什么），用户是"**什么是**X"方向反了没匹配；"说说/介绍一下"等请求动词没清。整句含疑问词传给搜索引擎，质量天然差
  2. **单源填满**：综合搜索 `search_web` 原实现 4 源无限制合并，当百度反爬（实测 1488 字节验证页）、搜狗对整句返回 0 个 rb 块时，**Bing 一家结果填满 20 条**——Bing 对中文整句返回英文无关（MSFT 股票）
  3. **无相关性过滤**：任何来源的无关结果都会被原样返回
- **修复**：
  - `extractSearchKeywords` 重写：补"什么是/说说/讲讲/介绍一下/是做什么的/干什么的/干嘛的/的最新"等 30+ 词；截断 12 字；清洗后为空回退前 12 字。实测："说说什么是人工智能神经网络"→"人工智能神经网络"、"华为技术有限公司是做什么的"→"华为技术有限公司"
  - `search_web` 多源合并改**每源最多 5 条、总上限 15 条**（防单源填满）+ **`filter_relevant` 相关性过滤**（纯函数）：剔除与查询词无共现的结果 + 低质噪声（词典释义"的意思/怎么读/拼音/造句"、股票行情 stock/quote、问答链接）
  - `search_sogou` 增强：整句查询搜狗返回 vr-title 卡片而非 rb 块 → 新增 `extract_vr_title`（提取 h3.vr-title 内 <a> 文本，修复原来把整个 block 当标题的 bug）
- **验证**：问题场景"人工智能神经网络"从"12 条含 MSFT 股票+4 条'人工'单字释义"→"6 条高质量相关结果"（MBA智库/搜狐科普/知乎入门/微信简史）；cargo test 24 项（search 8 项含 3 个 filter_relevant 测试）+ npm test 35 通过
- **经验**：①搜索引擎对高频请求 IP 级限流是常态（诊断时多次 curl 被限），低频真实使用正常；②"单源结果填满"是多源综合的隐藏陷阱，必须限制单源占比；③中文查询词清洗要同时覆盖"是什么/什么是"两种语序 + 口语请求动词

### ✅ 编程代理 P-A2 验证循环 + P-A3 代码库理解（analyze_project）
- **P-A2 验证循环**：Rust `run_tests(cwd, command?, args?, timeout)` 命令——自动检测项目测试框架（`detect_test_framework` 纯函数：package.json→npm test、Cargo.toml→cargo test、pyproject/requirements→pytest，可显式 command 覆盖）；tokio 子进程 + 超时(默认 300s) + 审计，返回结构化 `TestOutput`（framework/command/stdout/stderr/exit_code/timed_out）。前端 `run_tests` 内置工具：返回「【测试结果】框架/命令/✅通过❌失败 + 失败项/错误摘要(正则提取 FAILED/error/panicked 前 15 行)」；系统提示词加「验证循环」门禁：改代码必跑测试、失败必修复再跑直到通过
- **P-A3 代码库理解**：Rust `analyze_project(root)` 命令——技术栈识别（Cargo.toml→Rust、package.json→TS/JS、pyproject→Python、go.mod→Go、vite.config/App.vue→Vue）、manifest 信息（Cargo 包名/npm 包名+scripts）、源码按扩展名统计（跳过 node_modules/.git/target/dist/build 等）、顶层结构（限制 60 项）；返回结构化 `ProjectAnalysis`。前端 `analyze_project` 工具：返回「【项目分析】技术栈/包信息/源码文件数/顶层结构」；提示词引导分析项目前先调用建立认知
- **验证**：cargo test 21 项（lib 新增 2 个 detect_test_framework 测试 + 3 个 git 校验）；npm test 35 + vite build 通过；analyze_project 对项目自身验证正确（技术栈 TS+Vue、源码 23 ts/16 vue）
- 踩坑：①追加测试时原 tests 模块已以 `}` 结尾，再 cat >> 会多一个 `}` 编译错——追加前先确认模块闭合；②`detect_test_framework` 检查顺序 package.json 优先，测试里同时写 package.json+Cargo.toml 会返回 npm 而非 cargo，须先删 package.json 再测 Cargo；③`&[String]` 参数传 `&["str"]` 字面量 E0308，需 to_string()

## 2026-08-25

### ✅ ROADMAP 整合进开发计划 + 编程代理 P-A1 Git 集成
- **计划整合**：新增 `DEVELOPMENT_PLAN.md §3.7 编程代理能力路线`——把 ROADMAP 全部未实现项（Git/验证循环/代码库索引/多文件编辑 diff/Plan 模式/本地 embedding/权限矩阵/沙箱/记忆复习/插件生态/跨设备同步/多模型路由）按优先级+前置依赖排成 P-A1~P-A12，建议推进顺序 Git→验证循环→代码库索引→diff→Plan→embedding→权限沙箱
- **P-A1 Git 集成**：
  - Rust 新增 `git_operation(cwd, action, args, timeout)` 命令：用 git CLI 子进程（零新依赖，复用 execute_command 的 tokio 进程+超时+审计模式）；白名单子命令（status/diff/log/branch/remote/show/ls-files/rev-parse 只读 + add/commit/pull/push/checkout/init/clone 常规）+ 拒绝危险参数（--force/--hard/reset/rm/clean/--delete），防 agent 误操作
  - 安全校验提取为纯函数 `validate_git_operation` + 3 个单元测试（允许安全操作/拒绝未知子命令/拒绝危险参数）
  - 前端 `git` 内置工具（app）：参数 cwd/action/args，输出截断 6000 字符；系统提示词加 git 工具描述（使用时机：查看/提交/推送/对比/历史/分支）
- **验证**：cargo test --lib 19 项通过（含 3 个 git 校验）；npm test 35 + vite build 通过；真实 git CLI 链路正常（status/log 输出正确）

### ✅ 长期记忆 1.5 用户画像 + 2.1 意图扩展 + 3.1 记忆编辑 + 记忆库净化
- **1.5 用户画像沉淀**：`memory.ts` 新增 `getUserProfile()`——聚合 preference 偏好 + 高重要度(≥7)身份/环境信息，形成结构化「用户画像」；`sendMessage` 每次对话稳定注入 volatileCtx（5 秒超时兜底）；`retrieveMemories` 改为只补重要度≥7 的偏好（避免与画像重复）；`MemoryPanel` 新增「用户画像」高亮区块（chip 展示，粉色调，标注"每次对话自动注入"）
- **2.1 意图关键词扩展**：`retrieveMemories` 在 FTS 首轮无结果时，用 LLM 从问题提取 2-3 个核心检索词（`expandKeywords`）逐个重试检索——解决"模糊提问"（如"我上次说的那家公司"）召回差问题；仅空结果时触发不增加正常路径成本
- **Phase 3.1 记忆编辑**：Rust 新增 `update_fact`（更新文本/类型/重要度 + 同步重建 FTS 索引）与 `update_fact_cmd` 命令；`MemoryPanel` 每条事实加「编辑」按钮 → 行内编辑表单（文本/类型下拉/重要度数字/保存/取消）；用 Pencil 图标
- **记忆库净化**：删除历史遗留的过程性垃圾事实（"截图已保存到…""浏览器已导航…""查询今日金价""无法联网查询…"等 4 条），清理孤儿 FTS 行；75→71 条
- **测试**：db.rs 新增 `update_fact_rebuilds_fts`（编辑后新词可检索），cargo test 15 项全通过；npm test 35 + vite build 通过

### ✅ 长期记忆 Phase 2.4：主动记忆工具（memory_save / memory_recall / memory_forget）
- **动机**：让 Agent 在对话中**主动**保存/回忆/遗忘记忆，而不只是被动等对话结束提取——这是「越用越聪明」的闭环
- **chat.ts**：新增 3 个内置工具（server 填 `app`）：
  - `memory_save(fact, fact_type, importance)`：记住用户明确告知的偏好/个人信息/决策/待办；返回 merged:/saved: 反馈（去重合并自动生效）
  - `memory_recall(query, limit)`：按关键词走 `search_facts`（FTS5 中文 unigram）回忆跨会话记忆；无结果返回"未找到"
  - `memory_forget(query)`：用户要求遗忘时按关键词检索并删除相关记忆
- **系统提示词**：内置工具列表加 3 个工具描述 + 「长期记忆使用要点」区块（主动记忆时机 / 回忆优先勿编造 / 遗忘 / 说明系统也会自动注入记忆）
- **验证**：`memory_recall` 检索链路真实库验证（"深圳"命中 5 条相关记忆）；npm test 35 项通过
- 说明：系统本就在每次对话前自动检索注入记忆（retrieveMemories），主动工具用于更精确的查证/写入/遗忘，二者互补

### ✅ 长期记忆验证基础设施：记忆管理面板（设置「记忆」tab + 菜单入口）
- **动机**：要验证「越用越聪明」，必须先能直观看到记忆状态（写了什么/召回什么/去重没/遗忘没）——此前前端看不到记忆只能手动 sqlite 查
- **Rust**：新增 `list_facts`（按类型过滤/全部，按 重要度×最近访问 排序）、`list_all_summaries`（全部会话摘要倒序）两个命令
- **前端**：新建 `MemoryPanel.vue`（设置「记忆」tab + 菜单栏「工具 → 长期记忆」入口）：
  - 记忆列表：类型徽标（偏好/信息/决策/待办）、重要度星级、访问次数、最近访问时间、可删除单条
  - 类型筛选 + 刷新 + 「执行维护」按钮（手动触发 `maintain_facts` 看衰减/遗忘效果）
  - 顶部统计：事实总数 / 平均重要度 / 各类型分布；底部展示会话摘要列表
- **验证**：dev 日志确认记忆维护线程启动自动运行（`[memory] 记忆维护完成，当前 75 条事实`）；真实库 75 条事实（66 info/4 decision/1 preference/4 todo）可按重要度列出
- **测试**：db.rs 新增 `list_facts_sorts_and_filters`（全部按重要度降序 + 类型过滤），cargo test 6 项通过

### ✅ 长期记忆验证方案（三层）
1. **单元/集成测试**（自动化）：FTS5 中文 unigram 检索、去重合并（同字重排合并/语义相反不误并）、衰减+遗忘+preference 保护、list_facts 排序过滤——db.rs 6 项测试已覆盖
2. **记忆可视化**（直观）：设置「记忆」tab 查看全部事实/摘要，筛选类型、看重要度/访问/时间，可删除、可手动执行维护
3. **端到端场景验证**（用户手测）：见「记忆验证清单」——跨会话「记住→召回」

### ✅ 长期记忆验证清单（用户手测）
- **写入**：对话说「我喜欢简洁的回答」，结束后打开 设置→记忆，应看到 preference 事实（重要度★8）
- **召回**：新开会话说「我有什么偏好？」，agent 应自动注入记忆并回答（无需用户提关键词）
- **去重**：再说一次「简洁的回答方式我喜欢」→ 记忆面板应仍是 1 条（合并），重要度上升
- **遗忘**：点「执行维护」→ 低价值冷记忆消失、preference 保留
- **衰减**：长期不访问的 info 事实重要度逐步下降（daily 维护自动）

### ✅ 长期记忆 Phase 1 启动：FTS5 全文索引 + 事实去重 + 自动遗忘（开发计划 §3.2，1.1/1.2/1.3）
- **背景**：用户进入长期记忆功能研发（"让 agent 越用越聪明"）。最大短板 = DeepSeek 无 embeddings 端点 → 只有 `LIKE` 全表扫，跨会话中文召回差
- **FTS5 全文索引（1.3）**：`memory_facts_fts` FTS5 虚拟表（`rowid` 与 `memory_facts` 关联）；`cjk_terms()` 中文 unigram 分词（"华为技术"→"华 为 技 术"，英文/数字按空白词切分小写）；`search_facts` 改为 FTS5 `MATCH`（bm25 相关度）× importance × recency 加权排序 + LIKE 兜底；`Database::new` 对旧库幂等回填索引；`save_fact`/`delete_fact` 同步维护 FTS。**验证**：rusqlite bundled 内置 FTS5（SQLite 3.45），中文 unigram 检索命中正确
- **事实去重合并（1.1）**：`save_fact` 前查同类型已有事实做字符集 Jaccard 相似度（>0.62 + 长度比 >0.55 惩罚，避免"喜欢简洁"vs"喜欢详细"误并）→ 合并：累加 importance（上限 10）、文本取更长、复用原 id；`save_fact` 命令返回 `saved:id` / `merged:id`；`mcp_server` memory_save 与前端 `extractFacts` 均适配反馈合并状态
- **记忆衰减与自动遗忘（1.2）**：新增 `maintain_facts()`——>45 天未访问的非 preference importance 降 1（最低 1）；importance≤2 且 60 天未访问的删除；清理孤儿 FTS 行；lib.rs 后台线程启动即跑 + 每 6 小时检查；`prune_facts` 命令复用。`preference`（用户偏好）永久保护不衰减不遗忘
- **前端 memory.ts**：`retrieveMemories` 改为 FTS5 全文为主 + 语义向量补充（有 embedding 时）+ 偏好合并的混合检索，去重后注入；`extractFacts` 处理 save_fact 合并返回值（embedding 写入目标 id）
- **测试**：db.rs 新增 3 个测试（中文 unigram FTS 检索、同字重排去重合并 + 语义相反不误并、衰减+遗忘+preference 保护），cargo test 14 项全通过；npm test 35 项通过
- 待做：Phase 1 的 1.4（记忆分层/跨会话摘要汇总）、1.5（用户画像沉淀）；Phase 2 检索注入优化（意图扩展/排序剪裁/主动记忆工具）

### ✅ 搜索源重构：彻底移除 Brave + 多源并行综合（百度/必应/360/搜狗）
- **背景**：Brave Search API 在境内无法直连（需代理），留着鸡肋 → 用户要求彻底移除；同时 web_search 质量一般（摘要常被截断、agent 只给链接让用户自己点）
- **Rust `search.rs`**：删除 `search_brave` + `BraveResponse/BraveWeb/BraveResult` 结构体；`search_web(query)` 改为**四源并行综合**（`futures::join!`）：百度 + 必应 + 360 + 搜狗，按 域名+路径 去重合并，上限 20 条，全空再兜底 DuckDuckGo
  - **新增 `search_baidu`**：`https://www.baidu.com/s?wd=`；真实 URL 在结果块 `mu="http..."` 属性（标题 `<a>` 的 href 是 baidu.com/link 跳转，不可直接用）；标题 `extract_tag(block,"<h3","</h3>")`；摘要藏在 `<!--s-data:{"summaryData":...}-->` JSON 注释 → `extract_baidu_summary` 用 `serde_json` 解析取 `generalLines[].data[].text`
  - **新增 `search_360`**：`https://www.so.com/s?q=`；真实 URL 在 `data-mdurl="http..."` 属性（href 是 so.com/link 跳转）；标题 `<h3 class="res-title">`、摘要 `<p class="res-desc">`
  - **新增 `search_sogou`**：`https://www.sogou.com/web?query=`；普通结果块 `class="rb"`，标题 `<h3 class="pt">`、摘要 `<div class="ft">`；链接是 `/link?url=` 相对跳转 → 补全 `https://www.sogou.com` 前缀
  - **反爬检测**（各源内置）：页面 <3000 字节 或含明确反爬特征（`antispider`/`wappass`/`安全验证`/`请输入验证码`/`captcha`/`访问过于频繁`）→ 静默返回空（该源失败不影响其它源）；360 判定修正：只要页面含 `res-list` 结果标记就继续解析（避免误伤正常页里的"已验证"等字样）
  - **实测**：`test_web_live` 综合搜索 11 条（华为官网/知乎/华为商城/consumer.huawei.com 等），首条即真实结果；多源合并去重效果显著
- **关键经验**：搜索引擎对**高频/连续请求**有 IP 级限流（连发 live 测试会触发，curl 也中招），真实低频使用不受影响；多源并行综合正是为此设计——单源被反爬返回空时其它源照常补上
- **前端清理**：`web_search` 命令去 `braveKey` 参数；删 `set_brave_api_key` 内置工具与系统提示词条目；`appSettings.ts` 删 `braveApiKey` 字段；`McpSettings.vue` 删 brave-search 安装时 prompt 逻辑 + 未使用的 `getSettings/updateSettings/Search` 图标导入；`mcp-catalog.ts` 删 brave-search 插件条目；`settings.rs` 删 `brave_api_key` 字段 + 加解密 + 测试引用
- **搜索信息不足优化**：web_search 工具对最相关**前 2 个结果自动 fetch_page 抓正文片段**（取 600 字符）注入上下文，让模型基于具体信息回答而非只给链接；提示词三处强化「摘要常不完整 → 需要具体数据/细节必须 fetch_page 抓正文，严禁只罗列链接让用户自己点开」（web_search 工具描述、formatSearchResults 注入文本、web_search 工具结果文案）
- 验证：cargo test 全部通过（search 5 单测 + settings + db 等 11 项）、前端无错误、`test_web_live` 端到端 11 条结果

### ✅ 收尾：Puppeteer MCP env 支持（开发计划 §2.1，核心提交 `0930eda`）
- 确认全链路已完成并推送：`McpServerConfig.env` 透传（mcp.rs）、`mcp_connect` env 参数（lib.rs）、`McpServerPersist.env`（appSettings.ts）、mcp.ts 透传 + `applyPuppeteerEnv` 迁移自动补 Edge 路径、`mcp-catalog.ts` puppeteer 条目带 `env: { PUPPETEER_EXECUTABLE_PATH: "...Edge..." }`、`McpSettings.vue` 编辑表单支持 `KEY=VALUE` 多行 env
- 本次仅补文档标记（§2.1 半成品 → 已完成）并验证 `cargo check` + `npm test`(35) + `vite build`
- 至此开发计划 §2「进行中」积压清零，可干净启动长期记忆 Phase 1

### 📌 规划：Agent 长期记忆功能（详见 `DEVELOPMENT_PLAN.md` §3）
- 现状：已有事实提取 / 摘要压缩 / 关键词+向量检索（DeepSeek 无 embeddings 则关键词回退）/ 偏好 / `touch_fact`+`prune_facts` 遗忘命令
- 短板：语义检索在 DeepSeek 下不可用、无事实去重合并、遗忘不自动、无记忆管理 UI、注入无权重排序
- 四阶段计划：①记忆内核增强（去重合并 / 自动遗忘 / FTS5 索引 / 用户画像）②检索注入（混合检索 / 排序剪裁 / 主动记忆工具）③记忆 UI（管理面板 / 配置 / 可视化）④增强（本地 embedding / 记忆复习）
- 待启动：Phase 1（事实去重 + FTS5 索引 + 自动遗忘调度）

### ✅ 用量统计历史累计（081b7ed，92bbd13 修复）
- 后端新增 `usage_agg`（总量）+ `usage_agg_daily`（按天）持久化累计表，删除会话不清零；新增 `accumulate_usage` / `get_usage_agg` 命令；启动时从历史 messages 幂等聚合
- 修复前后端结构不匹配（`{total:{...}}` 嵌套字段层级）；主界面顶栏与「用量统计」页均改为显示**历史累计**（含已删除会话）
- 实测：56649 tokens / ¥0.67 / 8 条；验证：cargo test（9 通过 + 2 新增）、npm test 35、vite build

### ✅ 引用链接 404 修复（a830e19）
- 根因：marked 裸 URL autolink 把 URL 后紧跟的中文正文吞进 href（`...shtml。结束` → href 含中文）→ 点击必 404；叠加模型正文改写 / 截断 URL
- 修复：自定义 marked `url` tokenizer（URL 结尾排除中英文标点 / 空白 / 汉字）；三处提示词强制「逐字原样复制完整 URL，禁止截断 / 删改扩展名 / 编造」

### ✅ 搜索引用地址误判本地文件（4a27944）
- `LOCAL_FILE_RE` 负向后顾 `(?<![\w\/])` → `(?<![\w\/:])`，`https://` 等外链路径不再被当本地文件（不再显示「文件不存在」）

### ✅ 附件按文件类型图标（bbca256）
- 新增 `src/utils/file-icons.ts`：按扩展名 / MIME 映射 lucide 图标（PDF / Excel / Word / PPT / 代码 / 压缩 / 音视频 / JSON / 数据库等）；消息气泡附件卡片与输入框附件栏均动态图标；图片仍走缩略图

### ✅ 五彩光圈穿透 + 搜索结果 URL 截断（f80e699）
- 光圈：`-webkit-mask` 在 WKWebView 失效 → 改 `background-clip: padding-box/border-box` 双背景（仅描边渐变）
- URL：搜索卡片 `[标题](url)` 在 URL 含 `)` 时被 marked 截断 → 改用 `<url>` autolink

### ✅ UI 图标统一为线性图标（e01d1ec）
- 引入 `lucide-vue-next`，替换应用内静态 emoji 图标（按钮 / 设置 tab / 面板标题 / 状态 / 头像等）；`main.css` 加 `.lucide` 统一样式

### ✅ 彻底解决「分析 op 目录」工具循环中断（ead45ae + 6097fea）
- 多层根因：工具调用写在 reasoning 需同时检测；空 `<tool_call>` 与伪卡片注入修正重试；工具轮上限 8→20 + 收尾提示；无正文自动补一轮；`callMcpTool` 拦截 `directory_tree` 引导 `list_directory`；前端 debug_log 诊断埋点
- 验证：9 轮工具 + 2956 字符完整答案

---

## 2026-08-18

### ✅ 功能：数学公式渲染（KaTeX）
- 新增依赖 `katex`；自建 marked 扩展 `src/utils/katex-marked.ts`（替代 `marked-katex-extension`——其类型入口是裸 TS 源码，与项目 `strict + noUnusedParameters` 冲突报 TS6133）
- 支持 `$...$` / `$$...$$` / `\(...\)` / `\[...\]` 写法；行内公式要求前后空格/标点，避免货币误判（如 `$5 和 $10`）
- `ChatMessage.vue` 的 `md()` 前置 `normalizeMath()`：①保护代码块/行内代码 ②中文（汉字+全角标点）紧贴美元符补空格 ③反斜杠括号归一化
- 修复两个渲染 bug：
  1. 公式前紧贴中文全角标点（`，` `；` `（` 等）不被识别 → 补空格字符类扩为 `\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef`，且 inlineRule 结尾标点集合加中文标点
  2. **自定义 marked `text` renderer 忽略 `token.tokens`** 导致加粗/斜体/公式以字面量显示（如 `**xx**`、`$...$`）→ 改为有嵌套 tokens 时先 `this.parser.parseInline(token.tokens)` 渲染，纯文本才做路径链接化
- 样式：main.css 加 katex `white-space:nowrap` + `.katex-display` 横向滚动（长公式不撑破气泡）
- 验证：`vue-tsc` + `vite build` + 15 项解析用例（中文标点紧贴、货币不误判、代码保护、加粗/公式/路径混合）通过

### ✅ 功能：中文系统菜单栏（替代 Tauri 默认英文菜单）
- Rust `build_app_menu()` 构建 6 个菜单（道生一/文件/编辑/视图/窗口/工具）；预定义项（隐藏/退出/撤销/复制/最小化等）系统原生处理
- 自定义项点击 → `on_menu_event` → `emit("menu://action", id)` → 前端 `main.ts` listen 分发
- 新增 `src/stores/ui.ts`（设置 tab / 关于 / 技能库 / 侧边栏 / 主题 / 导出请求状态）；`src/components/AboutDialog.vue` 关于弹窗（版本动态读取 + GitHub 外链经 shell open）
- 坑：安装的 `@tauri-apps/api@2.1.0` 无 `getCurrentWindow().onMenuEvent`（新版本才有）→ 用 Rust emit + 前端 listen 通道最稳
- 验证：`cargo check` + `vue-tsc` + `vite build` + 浏览器驱动 ui store 联动（关于/设置 tab/技能库/侧边栏）通过

### ✅ UI 优化
- **消息内容宽度自适应**：容器 920px → `min(100% - 48px, 1400px)`（小屏填满、大屏封顶），气泡 `78%→85%`，减少高分屏全屏时的两侧空白与内容高度
- **图标统一**：`AppLogo.vue` 与 Dock 图标同源造型（圆点"道" + 横条"一"），颜色随明暗主题切换，底色与背景增加色差 + 边框 + 投影，呈现独立图块
- **设置弹窗**：删除此配置/保存按钮仅「API 配置」tab 显示（其余 tab 只留取消）
- 验证：`vue-tsc` + `vite build` + 浏览器实测（两主题、多视口宽度）通过
- **文档更新**：README 新增界面截图（浅/深主题、设置、关于）；项目结构/技术栈同步

---

## 2026-08-17

### ✅ 修复 + 功能：web_search 多源回退链（Bing 修复 + DuckDuckGo 源）
- **根因**：`[Bing] 0 results` —— Bing DOM 改版后标题开标签带属性（`<h2 class=...>`），`extract_tag` 精确匹配 `<h2>` 失败
- **修复**：`search.rs` 新增宽松 `extract_h2`（允许属性）+ `extract_h2_link`（从 h2 内取真实链接，跳过 CSS link）+ `extract_bing_caption`
- **新增 DuckDuckGo 源**（回退链 Brave → Bing → DDG）：cookie 会话 + 多 UA 轮换 + 202 anomaly 反爬自动重试 3 次；结果链接从 `uddg` 参数双重 percent-decode
- **实测**：Bing 10 results（华为官网/百度百科/爱企查）；DDG 在本环境被 202 反爬拦截（保留重试兜底）；`reqwest` 加 `cookies` feature
- **验证**：Rust 7 项测试通过（settings 4 + search 3），编译通过；已推送 `ecd67f1`

### 📌 调研：Hermes-CN-Desktop 对比（交互/对话/工作模式，v0.8.0-rc7）
- 待落地改进（详见仓库记忆 `hermes-compare-and-local-gpu.md`）：
  - 🔴 Smart 智能审批（三档：手动/smart 辅助模型判断/YOLO）
  - 🔴 子代理可视化面板（树 + 实时事件流 + 并行分组）
  - 🔴 CLI 委派增强（Claude Code/Codex 5 模式 + 后台 + Token/退出码）
  - 🟡 辅助任务独立模型槽 / Persona 人格市场 / 切换优雅重启 overlay
- 架构差异（不必照搬）：Hermes 是托管内核外壳（managed/local/remote），道生一是单体

### ✅ 落地：Hermes 借鉴 6 项全部完成（高 3 + 中 3，逐项推送）
- 🔴 Smart 智能审批：审批三档 manual/smart/yolo；smart 用辅助模型判断命令安全（`judgeCommandSafety`，可配独立辅助模型），失败保守走确认（`fedc36e`）
- 🔴 子代理可视化面板：`SubagentPanel.vue` 展示 goal/状态/耗时/结论预览，可清空已结束，支持并行（`fedc36e`）
- 🔴 CLI 委派增强：`delegate_coding_agent` 支持 print/exec/review/resume 4 模式 + max-turns + resume 会话；返回结构化结果（退出码/耗时/token），前端展示（`a5b978f`）
- 🟡 辅助任务模型槽：设置「辅助任务模型」复用已配置 Profile（无需重复存 Key），Smart 审批/子代理优先用辅助模型省主模型额度（`0040449`）
- 🟡 Persona 人格市场：`personas-catalog.ts` 8 个人格，顶栏切换，注入系统提示词角色前缀（与技能库互补）（`5f37971`）
- 🟡 切换优雅 overlay：switchProfile 停止进行中流 + 800ms 切换提示遮罩（`53f3edf`）
- 低价值项：浅色主题道生一已有（`useTheme` 双主题 + 系统偏好），无需新增

### ✅ 本地 GPU 方案 A：结论（此 Intel Mac 不可行）
- 自编译 `LLAMA_METAL=1` 成功枚举 `MTL0: AMD Radeon Pro 5300M (4080 MiB)`，但实测推理仅 2.0-2.2 t/s（比 CPU 9.9 t/s 慢 5 倍）+ 输出异常 → **Metal offload 在 Intel Mac 是负优化**
- 结论：Ollama（0 GPU）/ Homebrew llama.cpp（无 Metal）/ 自编译 Metal（负优化）均无法有效用 AMD 5300M
- 建议：本地模型保持 CPU（轻量图片理解）+ 重推理走云端 DeepSeek；坚持 GPU 需 Apple Silicon

### ✅ 修复：fetch MCP 插件不可用（`npx mcp-server-fetch` 报错）
- **现象**：启动 MCP 报 `mcp-server-fetch: line 1: /Applications: is a directory` / `syntax error`
- **根因**：npm 上 `mcp-server-fetch`（v0.0.2）是安全研究 **canary 占位包**，`npx` 拉取的是遥测脚本而非 MCP server
- **方案**：`src/stores/mcp.ts` 新增 `migrateConfig` 自动禁用此类配置（提示用内置 `fetch_page`）；`mcp-catalog.ts` 移除 fetch 插件条目；清理 `~/.npm/_npx` 污染缓存
- **验证**：30 项测试通过，无类型错误；应用热更新后「网络请求」不再连接
- **已推送**：`56e8fbe`

### ✅ 修复：Puppeteer MCP 不可用（`spawn Unknown system error -88`）
- **现象**：`puppeteer_navigate` 启动失败
- **根因**：
  1. `chrome-headless-shell` 缓存损坏（目录内缺可执行文件，只有 ABOUT/LICENSE）
  2. 完整版 Chrome for Testing（131，2024 年）在 macOS 26.5.2 上**启动即被系统 SIGKILL**（`zsh: killed`），故 `--version` 都失败
  3. 本机无 Google Chrome，仅有 Microsoft Edge
- **方案**（代码已改，待收尾）：
  - 重新安装 `chrome-headless-shell@131.0.6778.204`（修复缓存）
  - MCP 客户端加 **env 支持**（`mcp.rs`/`lib.rs`/`appSettings.ts`/`mcp.ts`），`PUPPETEER_EXECUTABLE_PATH` 指向本机 Edge
  - 待办：`mcp-catalog.ts` + `McpSettings.vue` + 编译验证 + 推送（见计划 §2.1）
- **验证**：puppeteer + Edge `launch` + `goto` 成功（百度天气页标题正常）

### ✅ 修复：日期幻觉 + 编造数据
- **现象**：模型日期幻觉；未调用工具时编造数据（如天气）
- **根因**：
  1. 工具提示为软性（"需要工具时..."），模型被问实时信息（天气/新闻等）时凭训练数据编造
  2. `volatileCtx` 的【当前时间】只有 HH:MM 无日期；系统提示日期措辞不够强硬
- **修复**（`src/stores/chat.ts`）：
  - `withCurrentDate`：强调"唯一可信日期来源，回答前先核对，严禁编造训练数据日期"
  - `volatileCtx`【当前时间】：补全完整日期（年月日 + 星期 + 时分）
  - `getMcpToolsPrompt`：新增「强制要求（实时/时效信息）」——实时数据**必须先调** `web_search`/`fetch_page`，拿不到明确说「无法获取」，**严禁编造**
- **验证**：`vite build` + `npm test`（30 项）通过

### ✅ 功能：YOLO/自动批准高危命令开关（🟢）
- `settings.rs`/`appSettings.ts`：`AppSettings` 加 `yolo_mode`（默认 false）
- `chat.ts runCommand`：危险命令确认前判断 `yoloMode`，开启则自动批准不弹窗
- `SettingsDialog.vue`：Agent 设置新增「⚠️ 高危操作(YOLO 模式)」开关
- 验证：`cargo check` + `cargo test settings`(4) + `vite build` + `npm test`(30) 通过

### ✅ 功能：用量统计图表页（🟢）
- 新增 `UsageStats.vue`：从 SQLite 对话记录聚合——总会话/消息/Token/费用/平均耗时卡片、缓存命中率条、每日 Token 柱状图、会话 Token 分布
- `SettingsDialog.vue`：新增「📊 用量统计」tab
- 纯 CSS 图表（无新依赖），只改前端（HMR 热更新，不重启 dev 客户端）

### ✅ 功能：会话归档/导出（🟢）
- 归档：`chat.ts` 加 `archivedIds`（localStorage 持久化）+ `archiveConversation`/`unarchiveConversation`/`deleteArchived`；主列表只显示未归档，归档视图可恢复/删除
- 导出：复用已有 `export_conversation` 后端（JSON/Markdown）+ 前端 `downloadExport`（Blob 下载）
- `ChatHistory.vue`：每个会话加「⤓ 导出」「🗂 归档」按钮，顶部「🗄」切换归档视图
- 只改前端不重启 dev 客户端

### ✅ 修复：发送图片回复空内容
- **根因**：`describeImages(images)` 在 `try` 块外，若本地视觉模型识别异常会绕过 catch/finally，`assistantMsg.content` 永不赋值 → 气泡停留为空内容
- **修复**：图片预处理调用包 try-catch，异常时走 `ocrFailed` 分支进入错误兜底
- 验证：`vite build` + `npm test`（30 项）通过

### ✅ 功能：运行时健康/日志面板（🟡）
- Rust：新增 `system_diagnostics` 命令（sw_vers/sysctl/vm_stat/df/uptime 组合，无新依赖）返回 OS/版本/内存/磁盘/运行时长 + `daoshengyi.log` 尾部 150 行
- 前端：新增 `HealthPanel.vue`（系统信息卡片 + 内存/磁盘进度条 + 日志查看 + 刷新）
- `SettingsDialog.vue`：新增「🩺 诊断」tab
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：定时任务（🟡）
- Rust：`scheduled_tasks` 表 + `list/save/delete/toggle` 命令 + 后台调度线程（每 30 秒检查，`/bin/sh -c` 执行，300 秒超时，结果存最近 1000 字符）；支持每 N 分钟 / 每天 HH:MM
- 前端：新增 `ScheduledTasks.vue`（任务列表 + 添加表单 + 启停/删除/上次结果）
- `SettingsDialog.vue`：新增「⏰ 定时任务」tab
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：长任务防休眠（🟡）
- Rust：`SleepGuard`（std Mutex）+ `set_prevent_sleep` 命令（macOS `caffeinate -dimsu`，非 macOS 静默跳过）
- 前端：`chat.ts` 加 `setPreventSleep` 辅助；图片识别、`/run` 命令执行前后自动启用/关闭
- 注意坑：lib.rs 的 `Mutex` 默认是 tokio 异步锁，SleepGuard 需显式用 `std::sync::Mutex`；`tokio::process::Command` 无 `.timeout()`，需 `tokio::time::timeout` 包裹
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：编码 Agent 委派（🔵）
- Rust：`check_coding_agents`（which 检测 claude/codex + 版本）、`delegate_coding_agent`（`claude -p` / `codex exec`，`tokio::time::timeout` 超时，返回 stdout/stderr）
- 前端：新增 `CodingAgents.vue`（安装状态卡片 + 委派表单 + 输出查看 + 安装命令提示）
- `SettingsDialog.vue`：新增「🤖 编码 Agent」tab
- 说明：本机未安装 claude/codex，检测返回「未安装」；装好后即可委派
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：子代理委派（🔵，轻量版）
- `chat.ts`：新增内置工具 `subagent_delegate`——模型可委派子任务给独立上下文的子代理（复用 `chatOnce` + `withCurrentDate`），返回子代理结论；工具提示中加入说明
- 轻量版：单层子代理（未做 Hermes 的树状监视面板，后续可迭代）
- 验证：`vite build` + `npm test`(30) 通过

### ✅ UI 优化：参考 Hermes-CN-Desktop 布局（2026-08-17）
- **设置对话框**：顶部 tab → **左侧菜单 + 右侧内容**布局（7 个菜单项垂直排列，弹窗加宽至 640px，左侧 `settings-nav` + 右侧 `settings-content` 独立滚动）
- **消息区**：内容居中容器 `messages-inner`（max-width 920px），宽屏下不贴边（Hermes 工作台风格）
- **空状态**：新增 6 个功能引导卡片（⌘N /run /read /📋粘贴图片 /⏰定时任务 /🩺诊断）
- **气泡**：assistant 用 `--bg-assistant-bubble` 柔和背景，user 用 accent 渐变
- **顶栏**：加品牌 AppLogo
- 浏览器实测：主界面 + 设置左侧菜单布局均正常

### ✅ 修复：会话导出按钮"卡死"
- **根因**：`downloadExport` 用 `<a download>` + Blob URL，WKWebView（macOS）不支持 → 点击无反应
- **修复**：Tauri 环境改「原生保存对话框（plugin-dialog `save()`）+ Rust `write_text_file` 命令落盘」（限制 .md/.json/.txt 扩展名）；浏览器预览回退 `<a download>`
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### 📌 调研：Hermes-CN-Desktop（`Eynzof/Hermes-CN-Desktop`）
- Tauri 2 + React 桌面客户端，1.6k stars，v0.8.0-rc7；许可 **PolyForm Noncommercial**（只借鉴思路不抄代码）
- 借鉴点已纳入《开发计划》§3（YOLO 开关 / 用量图表 / 会话归档 / 健康面板 / 定时任务 / 子代理委派等）
- 完整调研笔记在会话记忆 `hermes-cn-research.md`

### ✅ 改名：MCP 服务器 →「🧩 插件」体系（2026-08-17）
- 插件管理面板改为「🧩 插件」：Tab「已安装」「🌐 插件市场」，按钮「+ 添加插件（第三方）」
- 设置弹窗左侧菜单第 2 项改为「🧩 插件」

### ✅ 功能：社区插件市场（方向 A，Smithery 接入）
- **背景**：用户要求接 mcp.so，实测其 API 全被 Cloudflare 防护（403），Smithery/Glama 开放（HTTP 200）
- **Rust（mcp.rs）**：MCP 客户端新增**远程 HTTP（streamable HTTP MCP）模式**
  - `McpClient` 增加 `http/endpoint/session_id` Option 字段；`connect` 按 command 是否 `http(s)://` 前缀分发远程/stdio
  - `remote_connect` + 共用 `handshake`（initialize → initialized → tools/list）
  - `send_request` 远程分支：POST JSON-RPC，`mcp-session-id` 头保存/回传，响应兼容 JSON 与 SSE（`data:` 行按 id 匹配）
  - `send_notification` 远程分支：POST 通知后忽略响应
  - `Drop` 仅 stdio 模式 kill 进程
- **Rust（lib.rs）**：新增命令 `fetch_community_plugins`（Smithery 列表）、`fetch_remote_plugin_endpoint`（详情 deploymentUrl）
- **前端（McpSettings.vue）**：插件市场加「🌐 社区插件（远程 · 免安装）」区——搜索 + 加载 Smithery 列表（名称/描述/✓已验证/使用量），安装即查远程端点添加为 `command=URL` 的远程插件并自动连接
- **验证**：`cargo check` ✓、`npx vite build` ✓、`npm test`（30 项全绿）✓
- **注意**：Rust 改动需重启 dev 客户端生效（远程模式在前端 HMR 下无法生效）

### ✅ 基础设施
- `npm run tauri dev` 首次完整构建通过（1m 07s），文件系统 MCP 连接成功（14 工具）
- 拉取远程后验证：工作区配置、`/run` 终端卡片、`/read` 文件读取均保留；HEAD 与 origin/main 同步

---

## 2026-08-14 及之前（Phase 1 及演进，详见 ROADMAP.md）

- **Phase 1 完成**：流式对话、多模型切换、记忆系统、技能库、MCP 客户端、联网搜索、网页抓取、SQLite 持久化、API Key 加密、Token/费用统计、图片预处理、提示词模板
- **Agent 能力演进**：ReAct 自动工具调用、MCP 插件市场、API Key AES 加密迁移、动态获取模型、国产模型定位（仅 DeepSeek）、SSE 丢字修复、AI 头像品牌化、IM 气泡布局、DeepSeek Harness 集成（超时守卫/审计/危险命令/工作区/终端卡片/文件读取）、官方价格表计费、UI 滚动/配色修复
- 每次完成均推送 GitHub main

---

## 验证清单（改完必跑）

```bash
cargo check                     # Rust 编译
npx vite build                  # 前端构建
npm test                        # 前端测试（30 项：19 tokens + 11 模板/工具）
cargo test settings             # Rust 加密测试（4 项）
git push origin main            # 推送
```
