// 内置工具目录：与 `src/stores/chat.ts` 的 `getMcpToolsPrompt` 同步。
// 把每个内置工具的描述集中在这里，供：
// 1) 系统提示词生成内置工具列表（getMcpToolsPrompt 按需过滤）
// 2) P-M3 角色工具集约束（roles-catalog 的 tools 只引用这些名字）
// 3) 单元测试校验：角色允许的工具名必须都真实存在（防拼错）

export interface BuiltinToolDef {
  name: string;
  desc: string; // 描述文本（不含 "- **name** (app): " 前缀）
}

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  {
    name: "apply_patch",
    desc: '**一次调用完成多文件/多片段编辑**（格式来自 openai/codex 的 apply_patch，模型与用户都已充分验证）。**优先用它而不是多次 replace_string**：改 3 个文件、或同一文件 5 处改动时，一次 apply_patch 即可，显著减少往返。\n格式（严格）：\n*** Begin Patch\n*** Add File: 相对或绝对路径\n+第一行\n+第二行\n*** Update File: 路径\n@@ 可选定位提示（用于报错提示，不参与匹配）\n 上下文行（前缀一个空格，用于定位）\n-被删除的原文行\n+替换后的新行\n*** Delete File: 路径\n*** End Patch\n要点：①片段内每行必须以「空格/ -/+」开头；②Update 的片段**必须包含至少一行上下文**（否则无法定位，会报错）；③上下文行会原样保留，改动后其余内容不动；④Add 的目标已存在会拒绝执行（要改内容请用 Update）；⑤不支持改名/移动（Move to）——请先用本工具改内容，再用 run_command 执行 mv/git mv；⑥代码块式的解释文字不要写进补丁，以 *** End Patch 收尾。\n参数 {"patch": "完整补丁文本"}',
  },
  {
    name: "current_time",
    desc: '获取**当前真实时间**（本地时间 + 星期 + ISO 8601 + 时区）。**何时用**：需要「今天/现在/本周」这类判断（写日报、算日期差、判断交易日、生成带日期文件名）时**先调它**，不要凭训练数据猜日期或用「今天」含糊表述。无参数。',
  },
  {
    name: "view_image",
    desc: '把本地图片**直接放进模型上下文**（视觉模型原生看图），用于核验截图/页面渲染/图表效果。参数 {"path": "本地图片文件路径"}。**与 describe_image 的区别**：describe_image/ocr_image 走本地小模型，可能失真/幻觉；view_image 让你真的看到原图，判断「渲染是否正常/图表是否画出来」时应优先用它。若当前模型不支持图片输入（如 DeepSeek）：本工具会**立刻**返回替代方案提示或云端视觉档的识图结果（不会让你干等）。可配合 browser_screenshot 使用。',
  },
  {
    name: "sleep",
    desc: '等待若干秒（上限 60 秒）。用于给外部进程/服务启动留时间（如刚 `run_command` 起本地服务、重启服务后）。参数 {"seconds": 秒数}。**不要用它做长时间轮询**——轮询请用 run_command 内的 shell 循环。',
  },
  {
    name: "browser_navigate",
    desc: '用**内置浏览器**打开网址并返回【标题 + 最终地址 + 正文前 4000 字】。这是验证网页产物（本地 HTML 预览、图表是否渲染）与抓取 JS 动态页面的首选：比 fetch_page 能拿到脚本渲染后的内容。参数 {"url": "完整网址"}。**注意**：内置浏览器已自带，不要再依赖 puppeteer 插件；打开后可用 browser_evaluate 进一步取数、browser_screenshot 截图存证。',
  },
  {
    name: "browser_evaluate",
    desc: '在**当前已打开的页面**里执行 JavaScript 并返回结果（表达式或 IIFE，返回值会被转成字符串）。用于取 DOM 数据、判断元素是否存在、读取 canvas/ECharts 实例状态、检查渲染是否成功等。参数 {"script": "JS 代码"}。注意：必须先 browser_navigate 打开页面。',
  },
  {
    name: "browser_screenshot",
    desc: '对**当前页面**截图并保存为 PNG（缺省存到应用数据目录 screenshots/）。用于给"产物是否真的渲染出来"留下可视证据（可再用 ocr_image / describe_image 复核）。参数 {"path": "可选，保存路径"}。',
  },
  {
    name: "browser_click",
    desc: '在当前页面点击 CSS 选择器命中的元素（自动滚动到可视区）。参数 {"selector": "CSS 选择器"}。找不到元素会明确返回 NOT_FOUND，便于改写选择器。',
  },
  {
    name: "browser_fill",
    desc: '在当前页面的输入框填写内容（触发 input/change 事件，兼容 React 受控组件）。参数 {"selector": "CSS 选择器", "value": "要填的值"}。',
  },
  {
    name: "browser_close",
    desc: '关闭内置浏览器，释放进程与端口。任务结束时调用（应用也会在每轮对话收尾自动关闭）。无参数。',
  },
  {
    name: "fetch_page",
    desc: '抓取网页 HTML 并转为纯文本返回。特点：快、稳定、无需浏览器；适合获取静态网页正文（新闻、天气、文档、说明等）。**注意**：JS 动态渲染的页面（数据靠脚本加载）、需登录的页面、或遇到反爬拦截（如“安全验证”）时，fetch_page 拿不到内容——此时必须改用内置浏览器（browser_navigate 打开 → browser_evaluate 提取 / browser_screenshot 截图）。参数 {"url": "完整网址"}',
  },
  {
    name: "web_search",
    desc: '网络搜索，返回相关网页标题/链接/摘要（前几条会自动附带正文片段）。特点：适合需要发现多个信息源、获取最新信息、或不确定具体网址时的探索。参数 {"query": "关键词"}。**注意：搜索结果摘要常不完整，若需要具体数据/细节/数字，必须对相关结果用 fetch_page 抓取正文获取，禁止只罗列链接让用户自己点开。**',
  },
  {
    name: "describe_image",
    desc: '用本地视觉模型描述图片内容。参数 {"path": "本地图片文件路径"}。**慢**：本机实测 1440×900 截图需 30–120 秒（Intel 无 GPU），且输出可能失真/幻觉。**只想读截图里的文字请优先用 ocr_image（秒级）**；确需画面描述时才用本工具，不要为了「核验渲染」反复调用。',
  },
  {
    name: "ocr_image",
    desc: '用本地 OCR（macOS Vision）提取图片中的文字。参数 {"path": "本地图片文件路径"}。用于从截图/图片提取文字。',
  },
  {
    name: "subagent_delegate",
    desc: '委派**单个**子代理独立处理子任务（独立上下文、独立回答），返回其结论。参数 {"goal": "子任务目标", "context": "可选补充上下文", "allow_tools": true, "role": "可选角色 planner/executor/verifier/reviewer/researcher"}。适合单个子任务研究/独立验证；**有多个相互独立的子任务时用 subagent_parallel 并行委派**。子代理结论会作为工具结果返回。',
  },
  {
    name: "subagent_parallel",
    desc: '**并行委派多个子代理**（多个子代理并发执行、互不等待，可视化面板同时显示各子代理进度）。参数 {"tasks": [{"goal": "子任务1", "context": "可选", "allow_tools": true, "role": "可选角色"}, ...], "concurrency": 可选并发数（默认最多 4）, "synth": 可选，true 时并行完成后用评审角色汇总仲裁}. **使用时机**：任务可拆分为多个**相互独立**的子任务（分头研究多个话题 / 分别验证多处代码 / 多角度调研）时，用本工具并行推进大幅节省时间；结果会按子任务顺序汇总返回。**注意**：①子任务必须真正独立（互不依赖彼此结论），否则不要并行；②浏览器自动化是单一实例，多个子任务同时操作浏览器会被自动串行化——若多个子任务都要操作不同网页，建议由主代理串行处理；③子代理一般不应继续递归并行委派，避免递归失控。',
  },
  {
    name: "pdf_read",
    desc: '分段读取 PDF 文件内容（一次读一段，返回纯文本）。参数 {"path": "PDF 路径", "offset": 起始字符偏移, "length": 读取长度}。用于浏览长 PDF 时按需分段读取，避免一次性加载全部内容。',
  },
  {
    name: "write_file",
    desc: '**把内容写入本地文件（应用自身真实写盘并校验）**。参数 {"path": "目标文件绝对路径（或以 ~/ 开头）", "content": "文件内容"}。仅支持写入用户主目录内文件，可写 CSV/Excel 文本等任意文本格式。**写文件必须用本工具（server 填 app）**：返回真实绝对路径，回复用户时**必须原样引用**该路径，禁止改名、改目录或编造路径。**新建/整文件覆盖用本工具；修改已有文件优先用 replace_string / insert_string 精确编辑（见下）。** **产物目录规范**：演示文件/报告/导出物一律写到 `~/Documents/道生一产物/`（自动创建）；**禁止写到主目录根**（如 `~/demo.svg`）——写到主目录根的文件会被自动改写到产物目录并在结果里告知新路径。',
  },
  {
    name: "replace_string",
    desc: '**精确替换文件中一段文本（返回 unified diff 供你确认改动）**。参数 {"path": "文件绝对路径", "old_text": "要替换的原文（须与文件内容完全一致）", "new_text": "新文本（可为空=删除该段）", "occurrence": 可选，第几次出现（默认 1）}。**修改已有文件的推荐方式**：只替换需要改动的片段，不改动部分保持原样（比整体重写更精确、diff 更小、不易破坏文件）。文件里可能有多处相同文本时用 occurrence 指定第几次出现。',
  },
  {
    name: "insert_string",
    desc: '**在文件指定锚点文本前/后插入内容（返回 unified diff）**。参数 {"path": "文件绝对路径", "anchor": "锚点文本（须唯一且与文件内容完全一致）", "position": "before 之前 | after 之后（默认 before）", "new_text": "要插入的内容"}。适合在函数/代码块末尾、配置项列表中添加新条目。',
  },
  {
    name: "create_file",
    desc: '**新建文件（仅当目标不存在，避免误覆盖）**。参数 {"path": "绝对路径或以 ~/ 开头", "content": "文件内容"}。文件已存在时不会覆盖，返回提示。产物同样应放到 `~/Documents/道生一产物/`（写主目录根会被自动改写）。',
  },
  {
    name: "delete_file",
    desc: '**删除文件（仅主目录内文件，不删除目录）**。参数 {"path": "文件绝对路径"}。删除前先确认用户确实要求删除该文件。',
  },
  {
    name: "list_dir",
    desc: '列出本地目录内容（含子目录与文件）。参数 {"path": "目录绝对路径"}。用于查看磁盘上存在哪些文件、确认文件是否真实存在。（兼容名：list_directory）',
  },
  {
    name: "read_file",
    desc: '读取本地文本文件内容。参数 {"path": "文件绝对路径"}。用于精读文件、查看代码/配置/文档的具体内容。（兼容名：read_file 也接受 read_multiple_files 批量读多个）',
  },
  {
    name: "git",
    desc: '在指定仓库目录执行 Git 操作（编程 Agent）。参数 {"cwd": "仓库目录绝对路径", "action": "status 状态 | diff 改动 | log 历史 | branch 分支 | add 暂存 | commit 提交 | pull 拉取 | push 推送 | checkout 切换 | rev-parse 解析", "args": [附加参数]}。**使用时机**：用户要求查看/提交/推送代码、对比改动、查看历史或分支时调用；提交用 action="commit" args=["-m","提交说明"]；先 status 看改动再 add+commit。只读操作（status/diff/log）安全；push/pull 会联网。',
  },
  {
    name: "run_tests",
    desc: '在项目目录自动检测并运行测试（编程 Agent 验证循环）。参数 {"cwd": "项目目录绝对路径", "command": "可选，显式指定测试命令（如 pytest -q）", "args": [可选附加参数]}。自动识别：package.json→npm test、Cargo.toml→cargo test、pyproject/requirements→pytest。返回结构化结果（框架/命令/通过或失败/失败项列表），供你判断并迭代修复。**使用时机**：修改代码后必须运行测试验证；测试失败时分析失败项、修复、再运行直到通过（验证循环门禁）。',
  },
  {
    name: "analyze_project",
    desc: '分析项目目录结构（编程 Agent 代码库理解）。参数 {"path": "项目目录绝对路径"}。返回：技术栈识别（Rust/TypeScript/Python/Vue 等）、清单文件信息（Cargo 包名/npm 包名+scripts）、源码文件按扩展名统计、顶层目录/文件结构（跳过 node_modules/.git/target 等大目录）。**使用时机**：用户要求分析/修改某项目前，先调用它快速建立项目认知（技术栈、结构、脚本），再深入读具体文件。',
  },
  {
    name: "kb_index",
    desc: '把本地目录/项目**索引成知识库**（Phase 3 RAG，支持 md/txt/代码/PDF，自动分块 + 关键词索引；重建式：同名知识库会重新索引）。参数 {"kb_name": "知识库名", "path": "目录绝对路径"}。**使用时机**：用户要求基于某目录/文档集做知识问答或检索时，先 kb_index 建立索引，再 kb_search 检索。',
  },
  {
    name: "kb_search",
    desc: '在已索引的**知识库**中检索（关键词 + 中文分词；若本地 Ollama 的 nomic-embed-text 可用则叠加**语义向量**补充召回，返回命中的文件与片段）。参数 {"kb_name": "知识库名", "query": "检索词", "limit": 可选条数（默认 6）}。**使用时机**：用户问题涉及已索引知识库的内容时，先检索再基于命中片段作答；检索不到可换关键词或提示用户先 kb_index。',
  },
  {
    name: "kb_list",
    desc: "列出已建立的知识库及分块数。参数 {}。**使用时机**：不确定有哪些知识库、或要确认某目录是否已索引时调用。",
  },
  {
    name: "kb_create",
    desc: '**创建命名知识库**（空库注册，之后可用 kb_add 录入内容或 kb_index 索引目录）。参数 {"kb_name": "知识库名，如「个人」"}。**使用时机**：用户要求「创建/新建一个叫 XX 的知识库」时先调用本工具建库，再按需录入内容。',
  },
  {
    name: "kb_add",
    desc: '向知识库**录入一段文本/文档内容**（自动分块 + 关键词索引；本地 Ollama embedding 可用时叠加语义向量）。参数 {"kb_name": "知识库名", "source": "来源/文档名（如 笔记.md）", "text": "要录入的完整文本内容"}。**使用时机**：用户把一段文字/笔记/文档内容给你要求「存进 XX 知识库」时调用；内容在文件里可先 read_file/list_dir 读取再录入。',
  },
  {
    name: "code_index",
    desc: '把项目代码目录**向量化索引**（P-A3 自然语言找代码，重建式；需本地 Ollama + nomic-embed-text）。参数 {"root": "项目目录绝对路径"}。**使用时机**：用户要求「在 XX 项目里找 XX 代码/功能」前，先 code_index 索引该项目，再用 code_search 检索。',
  },
  {
    name: "code_search",
    desc: '在已索引项目里**按自然语言找代码**（语义向量检索，返回相关文件与代码片段）。参数 {"root": "项目目录绝对路径", "query": "自然语言描述要查的代码（如「处理用户登录」「解析配置文件」）", "limit": 可选条数（默认 6）}。**使用时机**：用户要求找某功能/逻辑的代码实现时，先用自然语言描述检索；命中后可用 read_file 精读相关文件。',
  },
  {
    name: "code_roots",
    desc: "列出已索引的项目目录。参数 {}。**使用时机**：不确定哪些项目已建立语义索引时调用。",
  },
  {
    name: "code_stats",
    desc: '查看某项目的语义索引统计（文件数/分块数）。参数 {"root": "项目目录绝对路径"}。',
  },
  {
    name: "code_delete",
    desc: '删除某项目的语义索引。参数 {"root": "项目目录绝对路径"}。',
  },
  {
    name: "memory_save",
    desc: '把用户明确告诉你的重要信息保存到长期记忆（跨会话生效，下次对话自动想起）。参数 {"fact": "要记住的内容", "fact_type": "preference" 偏好 | "info" 信息 | "decision" 决策 | "todo" 待办, "importance": 重要度 1-10}。**使用时机**：用户告知个人偏好（如「我喜欢简洁回答」）、重要个人信息（姓名/职业/所在地）、作出的决定、或叮嘱你要记住的待办事项时——主动调用记住，不要只放在本次回答里。',
  },
  {
    name: "memory_recall",
    desc: '按关键词检索长期记忆，回忆以前会话中记住的信息。参数 {"query": "关键词", "limit": 条数}。**使用时机**：用户问「我之前说过…吗」「记得我上次…」或需要结合历史偏好/决策回答时，先调用回忆，再基于回忆内容回答（不要凭编造）。',
  },
  {
    name: "memory_forget",
    desc: '用户要求「忘掉/删除某条记忆」时，按关键词检索并删除相关记忆。参数 {"query": "要遗忘的记忆关键词"}。',
  },
  {
    name: "send_im",
    desc: '主动推送一条消息到飞书/企业微信/钉钉群机器人（只发不收，无代理直连）。参数 {"platform": "feishu" 或 "wecom" 或 "dingtalk", "text": "要推送的内容"}。用于用户要求把信息/提醒推送到聊天工具时。',
  },
  {
    name: "plan_task",
    desc: '**创建/替换任务计划（进度卡片实时显示在对话区顶部）**。参数 {"title": "任务标题", "steps": ["子任务1", "子任务2", ...]}。**使用时机**：用户下达**多步骤/多文件/多研究点**的复杂任务时，先分解为子任务并调用本工具，让用户看到计划与进度；简单任务（1-2 步）不必用。',
  },
  {
    name: "plan_update",
    desc: '**更新任务计划某一步骤的进度**。参数 {"step": 步骤序号(从1开始), "status": "doing" 进行中 | "done" 已完成 | "failed" 失败}。**使用时机**：开始执行某步时标记 doing、完成后标记 done、某步失败标记 failed 并调整后续计划；配合 plan_task 实现 Plan→Act→Observe→修正 循环。',
  },
  {
    name: "session_spawn",
    desc: '**创建后台子会话并异步投递任务，不阻塞当前对话**。参数 {"prompt": "后台任务的完整指令", "name": "可选子会话名（默认 子任务）"}。返回 session_id。适合耗时/独立的后续工作（长研究、批量抓取、多步改造），spawn 后当前对话可继续做别的；子会话以 🧵 前缀出现在左侧历史、可点击查看/续聊。查进度用 session_status；取结果用 session_resume。**注意**：子会话后台运行且消耗 LLM 额度，完成后不会自动回填当前对话，需主动 resume。',
  },
  {
    name: "session_status",
    desc: '**查询后台子会话的执行进度/最近结果**。参数 {"session_id": "session_spawn 返回的 id"}。返回 执行中/已完成 + 消息数 + 最近结果前 600 字。',
  },
  {
    name: "session_resume",
    desc: '**等待后台子会话完成并把完整结果取回当前对话继续分析**。参数 {"session_id": "session_spawn 返回的 id"}。轮询等待（最长约 4 分钟，用户可随时停止）；子会话仍在执行时阻塞至完成，完成后返回其最终回复全文，据此继续作答。',
  },
  {
    name: "workflow_list",
    desc: "列出已保存的工作流（名称 + id）。参数 {}。**使用时机**：接到多步骤/可复用任务时，先查是否已有匹配的工作流。",
  },
  {
    name: "workflow_run",
    desc: '**按名称或 id 执行已保存的工作流**（复用可视化工作流引擎：text/llm/tool/condition/code/end 节点按拓扑执行；LLM 节点用模型、工具节点调内置工具）。参数 {"name": "工作流名称或 id", "input": "可选外部输入（节点里以 {{user}} 引用）"}。返回节点日志与最终输出。**使用时机**：用户需求与已沉淀的工作流同类（同一流程复用）时，先 workflow_list 查匹配，命中直接 workflow_run。',
  },
  {
    name: "workflow_create",
    desc: '**把多步骤/可复用任务抽象成工作流并保存**。参数 {"name": "工作流名称", "graph": {"nodes": [{"id":"n1","type":"text|llm|tool|condition|code|end","label":"节点名","config":{...}}], "edges": [{"id":"e1","source":"n1","target":"n2"}]}}。节点 config：text→{text} 字面量；llm→{prompt} 提示词（可用 {{上游nodeId}} 引用上游输出）；tool→{tool:工具名, toolArgs:参数模板}；condition→{expression} 布尔表达式，出边带 label true/false 分支；code→{code} JS 函数体（入参 input/outputs）；end 收尾。**使用时机**：用户要做的事多步骤且以后可能重复时，先抽象成工作流保存，同类任务后续直接 workflow_run 复用。',
  },
  {
    name: "workflow_improve",
    desc: '**基于该工作流最近运行历史（含失败节点轨迹）自动优化并保存新版本**。参数 {"name": "工作流名称或 id", "note": "可选改进诉求"}。模型分析最近运行（失败/被跳过/慢节点）修复问题（换工具/加分支/细化提示词）；判定无需改动则保留原样。保存后建议 workflow_run 验证。**使用时机**：用户反馈某工作流结果不佳/报错，或你看到 workflow_run 返回里有失败节点时。',
  },
  {
    name: "workflow_suggest",
    desc: '**按任务文本在已保存工作流中做相关度建议**（关键词打分，返回候选与流程链）。参数 {"task": "任务描述", "limit": "可选条数默认 3"}。**使用时机**：接到任务先判断是否已有同类可复用工作流时调用；命中则 workflow_run，未命中且会重复则 workflow_create + workflow_remember。',
  },
  {
    name: "workflow_remember",
    desc: '**沉淀处理模式记忆：把「某类任务 → 已沉淀工作流」记住**（存长期记忆 type=workflow，跨会话自动注入）。参数 {"task_type": "任务类型描述如 月度研究/日报生成", "workflow_name": "工作流名"}。**使用时机**：你 workflow_create 固化了一个会重复的流程后，调用本工具记住映射，以后同类任务会自动想起并 workflow_run 复用。',
  },
  {
    name: "request_user_input",
    desc: '**向用户提问并等待回答（融合自 Codex，长任务中途用）**。参数 {"question": "要问的问题（一次只问真正阻塞你的事）", "context": 可选补充背景, "choices": 可选的快捷选项数组（不超过 6 个）, "default": 可选默认值, "placeholder": 可选输入提示}。**使用时机**：关键信息缺失/需求歧义/需要在两个方案间选择，而**猜错的代价很高**时。**不要滥用**：能自己合理假设推进的就先推进（并在结论里标注假设）；用户回答前工具会挂起等待（用户可点「跳过」，此时请按合理假设继续、不要反复追问）。',
  },
  {
    name: "request_permissions",
    desc: '**主动申请会话级授权（融合自 Codex）**。参数 {"capability": "run_command | replace_string | insert_string | delete_file | apply_patch", "reason": "为什么要这个权限"}。授权**仅本会话有效**（重启失效，不落盘）；得到授权后本会话内同类操作不再逐次弹确认（命令执行策略里的 deny 规则仍不可绕过）。**使用时机**：你预计要连续做多次同类写操作/命令（如批量改文件、反复跑构建），每次弹确认会很低效时——先说明理由申请一次，而不是逐条触发弹窗。',
  },
  {
    name: "get_context_remaining",
    desc: '**查询当前上下文的占用与剩余预算（融合自 Codex）**。无参数。返回：已用/剩余 tokens、占用百分比、本次将发送多少条历史、以及**收尾建议**。**使用时机**：长任务中途、或准备把大段内容回填给模型前，先看一眼预算；接近上限（≥85%）时应**先收尾**——给结论与产物路径，把未完成部分写进文件/待办，必要时用 new_context_window 压缩历史。',
  },
  {
    name: "new_context_window",
    desc: '**压缩历史上下文（融合自 Codex）：把较早的对话历史压缩成要点摘要，腾出上下文空间后继续工作**。参数 {"keep_last_messages": 可选，保留最近几条原始消息（默认 6，范围 2–20）}。**使用时机**：历史很长/上下文接近上限，但又不能丢掉前文已完成工作的结论时；摘要会保留用户目标、已确认事实与结论、关键路径/命令、未完成待办。**注意**：只影响**发给模型的历史**（界面仍完整保留原始消息）；压缩后若要引用被压缩掉的细节，请从已落盘的文件读取，不要凭记忆臆测。会调用一次模型（消耗少量 tokens）。',
  },
  {
    name: "tool_search",
    desc: '**检索并激活未直接列出的工具（融合自 Codex，BM25 检索）**。参数 {"query": "自然语言描述你要做的事或能力，中英文均可", "limit": 可选返回条数（默认 8）}。**使用时机**：你需要某类能力（如「数据库查询」「发消息」「抓股票数据」「提交代码」），但当前可用工具列表里**找不到对应工具**时——先用它搜一下，系统会把命中的工具**立即加入你的可用工具**，下一轮即可直接调用。此外可用于**确认某个工具的真实参数名**（不要靠猜）。**不要**用它做普通信息搜索（那用 web_search）。',
  },
  {
    name: "run_command",
    desc: '**执行一条 shell 命令并把结果返回给你**（受「命令执行策略」门禁：deny 规则直接拦截、危险/破坏性命令需用户确认或智能审批——勿尝试绕过）。参数 {"command": "完整 shell 命令"}。**使用时机**：打开本机 App/文件/照片库（macOS `open -a 应用名` / `open 路径`）、运行构建/工具脚本、查询系统状态等专用工具覆盖不了时。能用专用工具（git/run_tests/list_dir/read_file/replace_string/workflow_*）优先用专用工具，只读优先、慎用写/删/安装类。**一次性短命令用本工具；需要交互或可能长时间运行 → 用 `exec_command`（不会被超时杀掉）**。**辨析**：用户要「打开浏览器跳转到某网址/网页」时**不要**用 `open -a "<浏览器>" "<网址>"`（浏览器已在运行时**不会可靠跳转**，退出码 0 ≠ 已加载）；请改用内置浏览器工具 `browser_navigate` 真实打开加载；`open -a` 只用于纯启动应用/打开文件/文件夹。',
  },
  {
    name: "exec_command",
    desc: '**启动命令并持续交互（交互式 / 长驻进程专用，融合自 Codex）**：基于 PTY 执行，等待至多 `yield_time_ms`（默认 1000，最大 30000）后返回【本次新增输出 + session_id】，**进程不会因超时被杀**，用 `write_stdin` 继续喂输入/取输出。参数 {"command": "完整 shell 命令", "cwd": "可选工作目录", "yield_time_ms": 可选等待毫秒}。**使用时机**：① 交互式 CLI（`python3 -i`、`psql`、`npm init`、需要确认密码/输入的命令）② 长驻服务（dev server、watch、tail -f）③ 需要分段观察输出的长任务。**与 run_command 的区别**：run_command 超时即终止（适合一次性命令）；本工具返回会话号，可反复交互。同样受「命令执行策略」门禁。**收尾**：不需要时用 `write_stdin` 发 `\\u0003`（Ctrl-C）中断，或告知用户会话号。',
  },
  {
    name: "write_stdin",
    desc: '**向运行中的 exec_command 会话写输入，并取回新输出（融合自 Codex）**。参数 {"session_id": exec_command 返回的会话号, "input": "可选，要写入的字符（回车需自己写 \\n；中断交互程序用 \\u0003 = Ctrl-C）", "yield_time_ms": 可选等待毫秒（默认 1000）}。**input 省略 = 只等待并取回后续输出**（轮询长任务进度）；进程已结束时返回剩余输出与退出码。',
  },
];

export const BUILTIN_TOOL_NAMES: string[] = BUILTIN_TOOLS.map((t) => t.name);

/** 校验给定工具名集合是否全部是真实内置工具（供测试与角色目录使用）。 */
export function validBuiltinTools(tools: string[]): string[] {
  const known = new Set(BUILTIN_TOOL_NAMES);
  return tools.filter((t) => !known.has(t));
}
