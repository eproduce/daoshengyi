// 内置工具的原生 function calling 参数 schema（OpenAI JSON Schema 风格）。
// 仅当内置工具名在此表内有条目时使用显式 schema；未收录的走 tool-schema 的通用
// fallback（{type:"object", additionalProperties:true}，配合 desc 中的「参数 {...}」示例）。
// 设计约定：
// - parameters 一律 type:"object"；属性给足类型与描述，便于 DeepSeek/OpenAI 稳定产出参数；
// - required 只列**必需**参数（可选参数不列，避免强制模型补齐）；
// - additionalProperties:true，允许模型给出示例未覆盖的扩展字段（绝不被 schema 校验拒绝）。

export const BUILTIN_PARAMETERS: Record<string, Record<string, unknown>> = {
  // ---- 融合 Codex 的内置工具 ----
  apply_patch: {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description:
          "Codex 格式补丁文本：*** Begin Patch / *** Add File|Update File|Delete File: 路径 / @@ / 空格(-/+ 前缀)行 / *** End Patch",
      },
    },
    required: ["patch"],
    additionalProperties: true,
  },
  current_time: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: true,
  },
  view_image: {
    type: "object",
    properties: { path: { type: "string", description: "本地图片文件路径" } },
    required: ["path"],
    additionalProperties: true,
  },
  sleep: {
    type: "object",
    properties: { seconds: { type: "number", description: "等待秒数（0~60）" } },
    required: ["seconds"],
    additionalProperties: true,
  },

  // ---- 内置浏览器（CDP 直连，替代 puppeteer MCP 插件）----
  browser_navigate: {
    type: "object",
    properties: { url: { type: "string", description: "完整网址（含 http:// 或 file://）" } },
    required: ["url"],
    additionalProperties: true,
  },
  browser_evaluate: {
    type: "object",
    properties: { script: { type: "string", description: "要执行的 JS 表达式或 IIFE" } },
    required: ["script"],
    additionalProperties: true,
  },
  browser_screenshot: {
    type: "object",
    properties: { path: { type: "string", description: "可选，PNG 保存路径（缺省存到应用数据目录）" } },
    required: [],
    additionalProperties: true,
  },
  browser_click: {
    type: "object",
    properties: { selector: { type: "string", description: "CSS 选择器" } },
    required: ["selector"],
    additionalProperties: true,
  },
  browser_fill: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS 选择器" },
      value: { type: "string", description: "要填写的值" },
    },
    required: ["selector", "value"],
    additionalProperties: true,
  },
  browser_close: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: true,
  },

  // ---- 网页 / 搜索 ----
  fetch_page: {
    type: "object",
    properties: { url: { type: "string", description: "完整网址" } },
    required: ["url"],
    additionalProperties: true,
  },
  web_search: {
    type: "object",
    properties: { query: { type: "string", description: "搜索关键词" } },
    required: ["query"],
    additionalProperties: true,
  },

  // ---- 图片 ----
  describe_image: {
    type: "object",
    properties: { path: { type: "string", description: "本地图片文件路径" } },
    required: ["path"],
    additionalProperties: true,
  },
  ocr_image: {
    type: "object",
    properties: { path: { type: "string", description: "本地图片文件路径" } },
    required: ["path"],
    additionalProperties: true,
  },

  // ---- 子代理 ----
  subagent_delegate: {
    type: "object",
    properties: {
      goal: { type: "string", description: "子任务目标" },
      context: { type: "string", description: "可选补充上下文" },
      allow_tools: { type: "boolean", description: "是否允许子代理调用工具，默认 true" },
      role: {
        type: "string",
        description: "可选角色：planner/executor/verifier/reviewer/researcher",
      },
    },
    required: ["goal"],
    additionalProperties: true,
  },
  subagent_parallel: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            goal: { type: "string", description: "子任务目标" },
            context: { type: "string", description: "可选补充上下文" },
            allow_tools: { type: "boolean", description: "是否允许调用工具，默认 true" },
            role: { type: "string", description: "可选角色" },
          },
          required: ["goal"],
          additionalProperties: true,
        },
        description: "相互独立的子任务列表",
      },
      concurrency: { type: "integer", description: "可选并发数（默认最多 4）" },
      synth: {
        type: "boolean",
        description: "true 时并行完成后用评审角色汇总仲裁",
      },
    },
    required: ["tasks"],
    additionalProperties: true,
  },

  // ---- PDF ----
  pdf_read: {
    type: "object",
    properties: {
      path: { type: "string", description: "PDF 路径" },
      offset: { type: "integer", description: "起始字符偏移，从 0 起" },
      length: { type: "integer", description: "读取长度" },
    },
    required: ["path"],
    additionalProperties: true,
  },

  // ---- 文件系统 ----
  write_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "目标文件绝对路径（或以 ~/ 开头）" },
      content: { type: "string", description: "文件内容（长文件严禁一次性塞满，须分段写入）" },
    },
    required: ["path", "content"],
    additionalProperties: true,
  },
  create_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径（或以 ~/ 开头）" },
      content: { type: "string", description: "文件内容" },
    },
    required: ["path", "content"],
    additionalProperties: true,
  },
  replace_string: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
      old_text: { type: "string", description: "要替换的原文（须与文件内容完全一致）" },
      new_text: { type: "string", description: "新文本（可为空=删除该段）" },
      occurrence: { type: "integer", description: "第几次出现（默认 1）" },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: true,
  },
  insert_string: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
      anchor: { type: "string", description: "锚点文本（须唯一且与文件内容完全一致）" },
      position: { type: "string", description: "before 之前 | after 之后（默认 before）" },
      new_text: { type: "string", description: "要插入的内容" },
    },
    required: ["path", "anchor", "new_text"],
    additionalProperties: true,
  },
  delete_file: {
    type: "object",
    properties: { path: { type: "string", description: "文件绝对路径（仅主目录内文件）" } },
    required: ["path"],
    additionalProperties: true,
  },
  list_dir: {
    type: "object",
    properties: { path: { type: "string", description: "目录绝对路径" } },
    required: ["path"],
    additionalProperties: true,
  },
  read_file: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
      offset: { type: "integer", description: "起始偏移（行/字符，长文件分段读取用）" },
      length: { type: "integer", description: "读取长度" },
    },
    required: ["path"],
    additionalProperties: true,
  },

  // ---- 命令 / 代码 ----
  list_mcp_resources: {
    type: "object",
    properties: { server: { type: "string", description: "MCP 服务器名" } },
    required: ["server"],
    additionalProperties: true,
  },
  read_mcp_resource: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP 服务器名" },
      uri: { type: "string", description: "资源 uri（由 list_mcp_resources 获取）" },
    },
    required: ["server", "uri"],
    additionalProperties: true,
  },
  request_user_input: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问用户的问题" },
      context: { type: "string", description: "可选，补充背景/为什么要问" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "可选，快捷选项（≤6 个，点一下即提交）",
      },
      default: { type: "string", description: "可选默认值" },
      placeholder: { type: "string", description: "可选输入框提示" },
    },
    required: ["question"],
    additionalProperties: true,
  },
  request_permissions: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "run_command | replace_string | insert_string | delete_file | apply_patch",
      },
      reason: { type: "string", description: "申请理由（展示给用户）" },
    },
    required: ["capability"],
    additionalProperties: true,
  },
  get_goal: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: true,
  },
  create_goal: {
    type: "object",
    properties: {
      objective: { type: "string", description: "可验收的目标描述" },
      token_budget: { type: "number", description: "可选，token 上限（仅在显式要求时设置）" },
    },
    required: ["objective"],
    additionalProperties: true,
  },
  update_goal: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "active | complete | blocked | abandoned",
      },
      note: { type: "string", description: "可选备注（如阻塞原因）" },
    },
    required: ["status"],
    additionalProperties: true,
  },
  get_context_remaining: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: true,
  },
  new_context_window: {
    type: "object",
    properties: {
      keep_last_messages: {
        type: "number",
        description: "保留最近几条原始消息（默认 6，范围 2–20）",
      },
    },
    required: [],
    additionalProperties: true,
  },
  tool_search: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "自然语言描述你要做的事/需要的能力（中英文均可）",
      },
      limit: { type: "number", description: "可选，返回条数（默认 8）" },
    },
    required: ["query"],
    additionalProperties: true,
  },
  run_command: {
    type: "object",
    properties: { command: { type: "string", description: "完整 shell 命令" } },
    required: ["command"],
    additionalProperties: true,
  },
  exec_command: {
    type: "object",
    properties: {
      command: { type: "string", description: "完整 shell 命令" },
      cwd: { type: "string", description: "可选工作目录" },
      yield_time_ms: {
        type: "number",
        description: "等待输出的毫秒数（默认 1000，最大 30000）",
      },
    },
    required: ["command"],
    additionalProperties: true,
  },
  write_stdin: {
    type: "object",
    properties: {
      session_id: { type: "number", description: "exec_command 返回的 session_id" },
      input: {
        type: "string",
        description: "要写入的字符（回车写 \\n；Ctrl-C 写 \\u0003）；省略=只等待取输出",
      },
      yield_time_ms: { type: "number", description: "等待毫秒数（默认 1000）" },
    },
    required: ["session_id"],
    additionalProperties: true,
  },
  git: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "仓库目录绝对路径" },
      action: {
        type: "string",
        description: "status | diff | log | branch | add | commit | pull | push | checkout | rev-parse",
      },
      args: { type: "array", items: { type: "string" }, description: "附加参数" },
    },
    required: ["cwd", "action"],
    additionalProperties: true,
  },
  run_tests: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "项目目录绝对路径" },
      command: { type: "string", description: "可选，显式指定测试命令（如 pytest -q）" },
      args: { type: "array", items: { type: "string" }, description: "可选附加参数" },
    },
    required: ["cwd"],
    additionalProperties: true,
  },
  analyze_project: {
    type: "object",
    properties: { path: { type: "string", description: "项目目录绝对路径" } },
    required: ["path"],
    additionalProperties: true,
  },
  code_index: {
    type: "object",
    properties: { root: { type: "string", description: "项目目录绝对路径" } },
    required: ["root"],
    additionalProperties: true,
  },
  code_search: {
    type: "object",
    properties: {
      root: { type: "string", description: "项目目录绝对路径（可选，默认已索引项目）" },
      query: { type: "string", description: "自然语言描述要查的代码" },
      limit: { type: "integer", description: "可选条数（默认 6）" },
    },
    required: ["query"],
    additionalProperties: true,
  },
  code_roots: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },
  code_stats: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },
  code_delete: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },

  // ---- 知识库 ----
  kb_create: {
    type: "object",
    properties: { kb_name: { type: "string", description: "知识库名，如「个人」" } },
    required: ["kb_name"],
    additionalProperties: true,
  },
  kb_add: {
    type: "object",
    properties: {
      kb_name: { type: "string", description: "知识库名" },
      source: { type: "string", description: "来源/文档名（如 笔记.md）" },
      text: { type: "string", description: "要录入的完整文本内容" },
    },
    required: ["kb_name", "source", "text"],
    additionalProperties: true,
  },
  kb_index: {
    type: "object",
    properties: {
      kb_name: { type: "string", description: "知识库名" },
      path: { type: "string", description: "目录绝对路径" },
    },
    required: ["kb_name", "path"],
    additionalProperties: true,
  },
  kb_search: {
    type: "object",
    properties: {
      kb_name: { type: "string", description: "知识库名" },
      query: { type: "string", description: "检索词" },
      limit: { type: "integer", description: "可选条数（默认 6）" },
    },
    required: ["kb_name", "query"],
    additionalProperties: true,
  },
  kb_list: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },

  // ---- 记忆 ----
  memory_save: {
    type: "object",
    properties: {
      fact: { type: "string", description: "要记住的内容" },
      fact_type: { type: "string", description: "preference | info | decision | todo" },
      importance: { type: "integer", description: "重要度 1-10" },
    },
    required: ["fact"],
    additionalProperties: true,
  },
  memory_recall: {
    type: "object",
    properties: {
      query: { type: "string", description: "关键词" },
      limit: { type: "integer", description: "条数" },
    },
    required: ["query"],
    additionalProperties: true,
  },
  memory_forget: {
    type: "object",
    properties: { query: { type: "string", description: "要遗忘的记忆关键词" } },
    required: ["query"],
    additionalProperties: true,
  },

  // ---- IM ----
  send_im: {
    type: "object",
    properties: {
      platform: { type: "string", description: "feishu | wecom | dingtalk" },
      text: { type: "string", description: "要推送的内容" },
    },
    required: ["platform", "text"],
    additionalProperties: true,
  },

  // ---- 任务计划 ----
  plan_task: {
    type: "object",
    properties: {
      title: { type: "string", description: "任务标题" },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "子步骤列表",
      },
    },
    required: ["title", "steps"],
    additionalProperties: true,
  },
  plan_update: {
    type: "object",
    properties: {
      step: { type: "integer", description: "步骤序号(从 1 开始)" },
      status: { type: "string", description: "doing | done | failed" },
    },
    required: ["step", "status"],
    additionalProperties: true,
  },

  // ---- 后台子会话 ----
  session_spawn: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "后台任务的完整指令" },
      name: { type: "string", description: "可选子会话名（默认 子任务）" },
    },
    required: ["prompt"],
    additionalProperties: true,
  },
  session_status: {
    type: "object",
    properties: { session_id: { type: "string", description: "session_spawn 返回的 id" } },
    required: ["session_id"],
    additionalProperties: true,
  },
  session_resume: {
    type: "object",
    properties: { session_id: { type: "string", description: "session_spawn 返回的 id" } },
    required: ["session_id"],
    additionalProperties: true,
  },

  // ---- 工作流 ----
  list_agents: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: true,
  },
  interrupt_agent: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "session_spawn 返回的 id" },
      reason: { type: "string", description: "可选，中断原因" },
    },
    required: ["session_id"],
    additionalProperties: true,
  },
  workflow_list: {
    type: "object",
    properties: {},
    additionalProperties: true,
  },
  workflow_run: {
    type: "object",
    properties: {
      name: { type: "string", description: "工作流名称或 id" },
      input: { type: "string", description: "可选外部输入（节点里以 {{user}} 引用）" },
    },
    required: ["name"],
    additionalProperties: true,
  },
  workflow_create: {
    type: "object",
    properties: {
      name: { type: "string", description: "工作流名称" },
      graph: {
        type: "object",
        description: "nodes + edges 的有向图（见描述）",
        additionalProperties: true,
      },
    },
    required: ["name", "graph"],
    additionalProperties: true,
  },
  workflow_improve: {
    type: "object",
    properties: {
      name: { type: "string", description: "工作流名称或 id" },
      note: { type: "string", description: "可选改进诉求" },
    },
    required: ["name"],
    additionalProperties: true,
  },
  workflow_suggest: {
    type: "object",
    properties: {
      task: { type: "string", description: "任务描述" },
      limit: { type: "integer", description: "可选条数默认 3" },
    },
    required: ["task"],
    additionalProperties: true,
  },
  workflow_remember: {
    type: "object",
    properties: {
      task_type: { type: "string", description: "任务类型描述" },
      workflow_name: { type: "string", description: "工作流名" },
    },
    required: ["task_type", "workflow_name"],
    additionalProperties: true,
  },

  // ---- 确定性工具集（零依赖、不联网、结果可复现）----
  calc: {
    type: "object",
    properties: {
      expression: { type: "string", description: "算术表达式，如 (1+2)*3/4、sqrt(2)、2^10、round(3.14159,2)" },
      precision: { type: "number", description: "可选，结果保留的小数位（0~15）" },
    },
    required: ["expression"],
    additionalProperties: true,
  },
  convert_unit: {
    type: "object",
    properties: {
      value: { type: "number", description: "数值" },
      from: { type: "string", description: "原单位（如 km/h、斤、°C、GB）" },
      to: { type: "string", description: "目标单位" },
      list: { type: "boolean", description: "true = 列出全部可用单位" },
    },
    required: [],
    additionalProperties: true,
  },
  time_convert: {
    type: "object",
    properties: {
      action: { type: "string", description: "now | convert | add | sub | diff" },
      time: { type: "string", description: "时间，如 2026-03-01T09:30（无后缀时按 from_tz 解释）" },
      from_tz: { type: "string", description: "源时区（IANA，如 Asia/Shanghai）" },
      to_tz: { type: "string", description: "目标时区" },
      tz: { type: "string", description: "to_tz 的别名" },
      amount: { type: "number", description: "add/sub 的数量" },
      unit: { type: "string", description: "add/sub/diff 的单位：ms/s/min/h/d/wk" },
      from: { type: "string", description: "diff 的起始时间" },
      to: { type: "string", description: "diff 的结束时间" },
    },
    required: [],
    additionalProperties: true,
  },
  csv_query: {
    type: "object",
    properties: {
      text: { type: "string", description: "CSV/TSV 文本" },
      path: { type: "string", description: "或 CSV 文件路径" },
      delimiter: { type: "string", description: "分隔符，缺省自动识别" },
      select: { type: "array", items: { type: "string" }, description: "要输出的列名" },
      where: { type: "object", description: "筛选条件：{\"列\": 值} 或 {\"列\": {\"op\":\"gt\",\"value\":10}}" },
      sort_by: { type: "string", description: "排序列" },
      sort_desc: { type: "boolean", description: "是否降序" },
      limit: { type: "integer", description: "最多显示行数（默认 30）" },
      group_by: { type: "string", description: "分组列" },
      agg: {
        type: "array",
        items: { type: "string" },
        description: "聚合：count / sum:列 / avg:列 / min:列 / max:列 / count_distinct:列",
      },
      profile: { type: "boolean", description: "true = 只输出列画像（非空/空值/去重/数值范围）" },
    },
    required: [],
    additionalProperties: true,
  },
  json_query: {
    type: "object",
    properties: {
      json: { type: "string", description: "JSON 文本" },
      text: { type: "string", description: "JSON 文本（json 的别名）" },
      path: { type: "string", description: "或 JSON 文件路径" },
      json_path: { type: "string", description: "取值路径，如 data.items[0].name、items[*].id、*" },
      keys: { type: "boolean", description: "true = 只列出结构（字段名/数组长度）" },
      table: { type: "boolean", description: "true = 对象数组转 Markdown 表格" },
    },
    required: [],
    additionalProperties: true,
  },
  regex_test: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      flags: { type: "string", description: "修饰符，默认 g（如 gi / gs / gim）" },
      text: { type: "string", description: "待匹配文本" },
      path: { type: "string", description: "或文本文件路径" },
      replace: { type: "string", description: "可选，替换串（给替换预览）" },
      max: { type: "integer", description: "最多展示的匹配条数（默认 30）" },
    },
    required: ["pattern"],
    additionalProperties: true,
  },
  hash_encode: {
    type: "object",
    properties: {
      op: {
        type: "string",
        description:
          "sha256 | sha1 | sha384 | sha512 | hmac_sha256 | base64 | base64url | base64_decode | hex | hex_decode | url | url_decode | uuid | random_hex",
      },
      input: { type: "string", description: "输入文本" },
      key: { type: "string", description: "hmac_sha256 的密钥" },
      length: { type: "integer", description: "random_hex 的字节数（1~256）" },
    },
    required: ["op"],
    additionalProperties: true,
  },
  stats_describe: {
    type: "object",
    properties: {
      values: { type: "array", items: { type: "number" }, description: "数值数组" },
      text: { type: "string", description: "或文本（空格/换行/逗号分隔的数字）" },
      path: { type: "string", description: "或文件路径" },
      column: { type: "string", description: "从 CSV 某列取数" },
      delimiter: { type: "string", description: "CSV 分隔符" },
      values2: { type: "array", items: { type: "number" }, description: "可选第二组（算相关与回归）" },
      column2: { type: "string", description: "可选，第二组取自 CSV 某列" },
    },
    required: [],
    additionalProperties: true,
  },
  diff_text: {
    type: "object",
    properties: {
      a: { type: "string", description: "改前文本" },
      b: { type: "string", description: "改后文本" },
      text_a: { type: "string", description: "a 的别名" },
      text_b: { type: "string", description: "b 的别名" },
      path_a: { type: "string", description: "改前文件路径" },
      path_b: { type: "string", description: "改后文件路径" },
      a_label: { type: "string", description: "a 侧标题" },
      b_label: { type: "string", description: "b 侧标题" },
      context: { type: "integer", description: "上下文行数（默认 3）" },
    },
    required: [],
    additionalProperties: true,
  },
  schema_validate: {
    type: "object",
    properties: {
      schema: { type: "string", description: "JSON Schema（文本或对象）" },
      data: { description: "待校验数据（对象，或 JSON 字符串）" },
      text: { type: "string", description: "待校验的 JSON 文本" },
      path: { type: "string", description: "待校验数据的文件路径" },
    },
    required: ["schema"],
    additionalProperties: true,
  },
};
