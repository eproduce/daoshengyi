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
    name: "fetch_page",
    desc: "抓取网页 HTML 并转为纯文本返回。特点：快、稳定、无需浏览器；适合获取静态网页正文（新闻、天气、文档、说明等）。**注意**：JS 动态渲染的页面（数据靠脚本加载）、需登录的页面、或遇到反爬拦截（如“安全验证”）时，fetch_page 拿不到内容——此时必须改用浏览器自动化工具（puppeteer_navigate 打开 → 等待/提取/截图）。参数 {\"url\": \"完整网址\"}",
  },
  {
    name: "web_search",
    desc: "网络搜索，返回相关网页标题/链接/摘要（前几条会自动附带正文片段）。特点：适合需要发现多个信息源、获取最新信息、或不确定具体网址时的探索。参数 {\"query\": \"关键词\"}。**注意：搜索结果摘要常不完整，若需要具体数据/细节/数字，必须对相关结果用 fetch_page 抓取正文获取，禁止只罗列链接让用户自己点开。**",
  },
  {
    name: "describe_image",
    desc: "用本地视觉模型描述图片内容。参数 {\"path\": \"本地图片文件路径\"}。用于理解截图/图片内容（可配合浏览器截图后使用）。",
  },
  {
    name: "ocr_image",
    desc: "用本地 OCR（macOS Vision）提取图片中的文字。参数 {\"path\": \"本地图片文件路径\"}。用于从截图/图片提取文字。",
  },
  {
    name: "subagent_delegate",
    desc: "委派**单个**子代理独立处理子任务（独立上下文、独立回答），返回其结论。参数 {\"goal\": \"子任务目标\", \"context\": \"可选补充上下文\", \"allow_tools\": true, \"role\": \"可选角色 planner/executor/verifier/reviewer/researcher\"}。适合单个子任务研究/独立验证；**有多个相互独立的子任务时用 subagent_parallel 并行委派**。子代理结论会作为工具结果返回。",
  },
  {
    name: "subagent_parallel",
    desc: "**并行委派多个子代理**（多个子代理并发执行、互不等待，可视化面板同时显示各子代理进度）。参数 {\"tasks\": [{\"goal\": \"子任务1\", \"context\": \"可选\", \"allow_tools\": true, \"role\": \"可选角色\"}, ...], \"concurrency\": 可选并发数（默认最多 4）, \"synth\": 可选，true 时并行完成后用评审角色汇总仲裁}. **使用时机**：任务可拆分为多个**相互独立**的子任务（分头研究多个话题 / 分别验证多处代码 / 多角度调研）时，用本工具并行推进大幅节省时间；结果会按子任务顺序汇总返回。**注意**：①子任务必须真正独立（互不依赖彼此结论），否则不要并行；②浏览器自动化是单一实例，多个子任务同时操作浏览器会被自动串行化——若多个子任务都要操作不同网页，建议由主代理串行处理；③子代理一般不应继续递归并行委派，避免递归失控。",
  },
  {
    name: "pdf_read",
    desc: "分段读取 PDF 文件内容（一次读一段，返回纯文本）。参数 {\"path\": \"PDF 路径\", \"offset\": 起始字符偏移, \"length\": 读取长度}。用于浏览长 PDF 时按需分段读取，避免一次性加载全部内容。",
  },
  {
    name: "write_file",
    desc: "**把内容写入本地文件（应用自身真实写盘并校验）**。参数 {\"path\": \"目标文件绝对路径（或以 ~/ 开头）\", \"content\": \"文件内容\"}。仅支持写入用户主目录内文件，可写 CSV/Excel 文本等任意文本格式。**写文件必须用本工具（server 填 app）**：返回真实绝对路径，回复用户时**必须原样引用**该路径，禁止改名、改目录或编造路径。**新建/整文件覆盖用本工具；修改已有文件优先用 replace_string / insert_string 精确编辑（见下）。**",
  },
  {
    name: "replace_string",
    desc: "**精确替换文件中一段文本（返回 unified diff 供你确认改动）**。参数 {\"path\": \"文件绝对路径\", \"old_text\": \"要替换的原文（须与文件内容完全一致）\", \"new_text\": \"新文本（可为空=删除该段）\", \"occurrence\": 可选，第几次出现（默认 1）}。**修改已有文件的推荐方式**：只替换需要改动的片段，不改动部分保持原样（比整体重写更精确、diff 更小、不易破坏文件）。文件里可能有多处相同文本时用 occurrence 指定第几次出现。",
  },
  {
    name: "insert_string",
    desc: "**在文件指定锚点文本前/后插入内容（返回 unified diff）**。参数 {\"path\": \"文件绝对路径\", \"anchor\": \"锚点文本（须唯一且与文件内容完全一致）\", \"position\": \"before 之前 | after 之后（默认 before）\", \"new_text\": \"要插入的内容\"}。适合在函数/代码块末尾、配置项列表中添加新条目。",
  },
  {
    name: "create_file",
    desc: "**新建文件（仅当目标不存在，避免误覆盖）**。参数 {\"path\": \"绝对路径或以 ~/ 开头\", \"content\": \"文件内容\"}。文件已存在时不会覆盖，返回提示。",
  },
  {
    name: "delete_file",
    desc: "**删除文件（仅主目录内文件，不删除目录）**。参数 {\"path\": \"文件绝对路径\"}。删除前先确认用户确实要求删除该文件。",
  },
  {
    name: "list_dir",
    desc: "列出本地目录内容（含子目录与文件）。参数 {\"path\": \"目录绝对路径\"}。用于查看磁盘上存在哪些文件、确认文件是否真实存在。",
  },
  {
    name: "git",
    desc: "在指定仓库目录执行 Git 操作（编程 Agent）。参数 {\"cwd\": \"仓库目录绝对路径\", \"action\": \"status 状态 | diff 改动 | log 历史 | branch 分支 | add 暂存 | commit 提交 | pull 拉取 | push 推送 | checkout 切换 | rev-parse 解析\", \"args\": [附加参数]}。**使用时机**：用户要求查看/提交/推送代码、对比改动、查看历史或分支时调用；提交用 action=\"commit\" args=[\"-m\",\"提交说明\"]；先 status 看改动再 add+commit。只读操作（status/diff/log）安全；push/pull 会联网。",
  },
  {
    name: "run_tests",
    desc: "在项目目录自动检测并运行测试（编程 Agent 验证循环）。参数 {\"cwd\": \"项目目录绝对路径\", \"command\": \"可选，显式指定测试命令（如 pytest -q）\", \"args\": [可选附加参数]}。自动识别：package.json→npm test、Cargo.toml→cargo test、pyproject/requirements→pytest。返回结构化结果（框架/命令/通过或失败/失败项列表），供你判断并迭代修复。**使用时机**：修改代码后必须运行测试验证；测试失败时分析失败项、修复、再运行直到通过（验证循环门禁）。",
  },
  {
    name: "analyze_project",
    desc: "分析项目目录结构（编程 Agent 代码库理解）。参数 {\"path\": \"项目目录绝对路径\"}。返回：技术栈识别（Rust/TypeScript/Python/Vue 等）、清单文件信息（Cargo 包名/npm 包名+scripts）、源码文件按扩展名统计、顶层目录/文件结构（跳过 node_modules/.git/target 等大目录）。**使用时机**：用户要求分析/修改某项目前，先调用它快速建立项目认知（技术栈、结构、脚本），再深入读具体文件。",
  },
  {
    name: "memory_save",
    desc: "把用户明确告诉你的重要信息保存到长期记忆（跨会话生效，下次对话自动想起）。参数 {\"fact\": \"要记住的内容\", \"fact_type\": \"preference\" 偏好 | \"info\" 信息 | \"decision\" 决策 | \"todo\" 待办, \"importance\": 重要度 1-10}。**使用时机**：用户告知个人偏好（如「我喜欢简洁回答」）、重要个人信息（姓名/职业/所在地）、作出的决定、或叮嘱你要记住的待办事项时——主动调用记住，不要只放在本次回答里。",
  },
  {
    name: "memory_recall",
    desc: "按关键词检索长期记忆，回忆以前会话中记住的信息。参数 {\"query\": \"关键词\", \"limit\": 条数}。**使用时机**：用户问「我之前说过…吗」「记得我上次…」或需要结合历史偏好/决策回答时，先调用回忆，再基于回忆内容回答（不要凭编造）。",
  },
  {
    name: "memory_forget",
    desc: "用户要求「忘掉/删除某条记忆」时，按关键词检索并删除相关记忆。参数 {\"query\": \"要遗忘的记忆关键词\"}。",
  },
  {
    name: "send_im",
    desc: "主动推送一条消息到飞书/企业微信/钉钉群机器人（只发不收，无代理直连）。参数 {\"platform\": \"feishu\" 或 \"wecom\" 或 \"dingtalk\", \"text\": \"要推送的内容\"}。用于用户要求把信息/提醒推送到聊天工具时。",
  },
  {
    name: "plan_task",
    desc: "**创建/替换任务计划（进度卡片实时显示在对话区顶部）**。参数 {\"title\": \"任务标题\", \"steps\": [\"子任务1\", \"子任务2\", ...]}。**使用时机**：用户下达**多步骤/多文件/多研究点**的复杂任务时，先分解为子任务并调用本工具，让用户看到计划与进度；简单任务（1-2 步）不必用。",
  },
  {
    name: "plan_update",
    desc: "**更新任务计划某一步骤的进度**。参数 {\"step\": 步骤序号(从1开始), \"status\": \"doing\" 进行中 | \"done\" 已完成 | \"failed\" 失败}。**使用时机**：开始执行某步时标记 doing、完成后标记 done、某步失败标记 failed 并调整后续计划；配合 plan_task 实现 Plan→Act→Observe→修正 循环。",
  },
  {
    name: "delegate_coding_agent",
    desc: "**外部编码 Agent 委派（隐藏兜底，慎用）**。参数 {\"agent_id\": \"claude 或 codex\", \"task\": \"任务描述\", \"cwd\": 可选工作目录, \"mode\": \"print 单次 | exec 自动批准 | review 代码评审\"}。**仅当内置编码能力（git/编辑/测试/规划）确实无法完成、且用户明确要求使用外部 Claude Code/Codex 时**才调用（需本机已安装对应 CLI）。**通常不使用**——优先用内置工具（replace_string/run_tests/git 等）完成编码任务。",
  },
];

export const BUILTIN_TOOL_NAMES: string[] = BUILTIN_TOOLS.map((t) => t.name);

/** 校验给定工具名集合是否全部是真实内置工具（供测试与角色目录使用）。 */
export function validBuiltinTools(tools: string[]): string[] {
  const known = new Set(BUILTIN_TOOL_NAMES);
  return tools.filter((t) => !known.has(t));
}
