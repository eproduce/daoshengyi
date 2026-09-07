// 内置工具的原生 function calling 参数 schema（OpenAI JSON Schema 风格）。
// 仅当内置工具名在此表内有条目时使用显式 schema；未收录的走 tool-schema 的通用
// fallback（{type:"object", additionalProperties:true}，配合 desc 中的「参数 {...}」示例）。
// 设计约定：
// - parameters 一律 type:"object"；属性给足类型与描述，便于 DeepSeek/OpenAI 稳定产出参数；
// - required 只列**必需**参数（可选参数不列，避免强制模型补齐）；
// - additionalProperties:true，允许模型给出示例未覆盖的扩展字段（绝不被 schema 校验拒绝）。

export const BUILTIN_PARAMETERS: Record<string, Record<string, unknown>> = {
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
  run_command: {
    type: "object",
    properties: { command: { type: "string", description: "完整 shell 命令" } },
    required: ["command"],
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
};
