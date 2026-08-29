// Agent 多模式市场（§3.11）：定义 AI 的运行模式——「怎么做」。
// 与人格（personas-catalog，「我是谁」）正交：人格决定对话风格与身份，模式决定行为方式
// （是否自动规划执行 / 是否侧重文档办公 / 是否检索优先 / 是否禁用工具速答）。
// 模式 = 系统提示词（行为约束）+ 工具白名单（allowedTools）+ 界面入口（输入框切换）。

export type AgentModeId = "chat" | "task" | "office" | "research" | "coding" | "quick";

export interface AgentMode {
  id: AgentModeId;
  name: string;
  emoji: string;
  description: string;
  /** 模式系统提示词（追加到主提示词，行为约束；空=不追加） */
  prompt: string;
  /** 允许的工具名白名单：undefined=不限；[]=禁用全部（速答）；数组=仅允许这些工具 */
  allowedTools?: string[];
}

export const MODES: AgentMode[] = [
  {
    id: "chat",
    name: "对话",
    emoji: "💬",
    description: "日常问答，自由对话按需调用工具",
    prompt: "",
  },
  {
    id: "task",
    name: "任务",
    emoji: "🎯",
    description: "目标驱动，自动规划→执行→验证→汇报",
    prompt:
      "你正处于【任务模式】：收到目标后先调用 plan_task 拆解为可执行步骤（顶部进度卡片会实时展示），然后按步骤逐一推进：每步开始用 plan_update 标记 doing、完成后标记 done、失败标记 failed（可据此调整计划）。执行过程中主动调用工具（文件/命令/git/测试/浏览器/知识库）并验证结果，发现偏差及时修正。全部步骤完成后，在正文给出完整的最终交付汇报（做了什么、结果如何、关键证据）。能自动推进就自动推进，不要等用户逐条确认；文件写入等操作仍遵循应用的权限确认规则。",
  },
  {
    id: "office",
    name: "办公",
    emoji: "📋",
    description: "文档/表格/邮件/纪要，结构化可直接交付",
    prompt:
      "你正处于【办公模式】：专注文档、表格、邮件、纪要、报告等办公产出。输出遵循格式规范：①表格类优先 CSV（Excel 可直接打开）或 HTML 表格，且每行单元格数与表头完全一致、禁止行列错位，跨列用 colspan 显式声明；②生成了几个文件就如实引用几个，禁止谎报文件数量；③可先检索知识库（kb_search）与长期记忆获取背景再产出；④语言正式、结构清晰、适合直接交付。",
  },
  {
    id: "research",
    name: "研究",
    emoji: "🔍",
    description: "信息获取与整理，检索优先、来源可溯",
    prompt:
      "你正处于【研究模式】：优先通过 web_search / fetch_page / kb_search（知识库）检索获取信息后再作答。引用信息注明来源；明确区分「已核实」与「待确认」；信息不足或无法获取时如实说明并给出获取途径，绝不编造事实、数据或来源。",
  },
  {
    id: "coding",
    name: "编码",
    emoji: "💻",
    description: "代码任务：定位→修改→测试→验证",
    prompt:
      "你正处于【编码模式】：专注代码任务。定位问题先用 code_index 建立项目语义索引、code_search 检索相关代码，再精读文件；修改后用 list_dir/read_file 复核，并运行测试（npm test / cargo test）验证；涉及多处改动时给出简洁变更说明。",
  },
  {
    id: "quick",
    name: "速答",
    emoji: "⚡",
    description: "一句话极简回答，不调用工具",
    prompt:
      "你正处于【速答模式】：用户只要一句话答案。直接、极简地作答，不要展开步骤、不要调用工具、不要输出长文档；必要时一句话提示用户可切换其他模式深入。",
    allowedTools: [],
  },
];

export function getModeById(id: string | null | undefined): AgentMode | undefined {
  if (!id) return undefined;
  return MODES.find((m) => m.id === id);
}

/** 是否允许调用某工具（模式白名单；undefined=不限，[]=全部禁用） */
export function isToolAllowedByMode(mode: AgentMode | undefined, tool: string): boolean {
  if (!mode || mode.allowedTools === undefined) return true;
  return mode.allowedTools.includes(tool);
}
