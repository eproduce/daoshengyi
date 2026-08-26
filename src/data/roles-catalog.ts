// P-M3 角色分工：面向任务的 agent 角色模板。
// 每个角色 = 定位 + 系统提示（角色指令）+ 允许工具集（tools，与 `builtin-tools.ts` 名字一致）。
// 工具集约束双保险：①提示词只展示允许工具；②runSubagentLoop 执行层拦截不允许的工具。
import { BUILTIN_TOOL_NAMES } from "./builtin-tools.ts";

export interface AgentRole {
  id: string;
  name: string; // 中文名
  emoji: string;
  desc: string; // 一句话定位
  sysPrompt: string; // 角色指令（追加到子代理基础提示）
  tools: string[]; // 允许调用的工具名（必须是 BUILTIN_TOOL_NAMES 中的名字）
}

export const AGENT_ROLES: AgentRole[] = [
  {
    id: "planner",
    name: "规划者",
    emoji: "📐",
    desc: "负责任务拆解、计划制定与前期调研，不直接改动文件",
    sysPrompt:
      "你的职责是**规划与调研**：把大任务拆解为有序、可执行、可验证的子步骤，明确每步的目标/产出/依赖；" +
      "通过调研（搜索/读文件/分析项目结构）验证可行性、识别风险与前置条件。" +
      "产出物是**清晰的行动计划**（步骤 + 每步要做什么 + 验证方式），交给执行者落地。不要改动代码或文件。",
    tools: ["plan_task", "plan_update", "analyze_project", "list_dir", "web_search", "fetch_page", "memory_recall", "pdf_read"],
  },
  {
    id: "executor",
    name: "执行者",
    emoji: "🔧",
    desc: "负责实际落地：修改代码/文件、运行命令、提交 Git",
    sysPrompt:
      "你的职责是**执行落地**：把规划好的步骤真正实现——修改代码/文件、必要时提交 Git。" +
      "遵循：精确编辑优先（replace_string/insert_string）、改完用 run_tests 验证、git 提交前先 status 看改动。" +
      "完成后报告：改了什么（含 diff 关键行）、测试结果、下一步建议。",
    tools: ["write_file", "replace_string", "insert_string", "create_file", "delete_file", "git", "run_tests", "analyze_project", "list_dir", "pdf_read", "plan_update"],
  },
  {
    id: "verifier",
    name: "验证者",
    emoji: "🧪",
    desc: "负责运行测试、核对实现是否通过",
    sysPrompt:
      "你的职责是**验证**：运行测试/检查实现是否满足要求。自动检测测试框架（npm test / cargo test / pytest），" +
      "失败时给出**失败项列表 + 关键错误信息**，并给出修复建议，但由执行者修复。" +
      "产出物是明确的验证结论：通过 / 失败（附证据）。",
    tools: ["run_tests", "analyze_project", "list_dir", "git", "pdf_read"],
  },
  {
    id: "reviewer",
    name: "评审者",
    emoji: "🔍",
    desc: "负责代码评审：审阅改动、发现缺陷与改进点",
    sysPrompt:
      "你的职责是**评审**：审阅代码改动（git diff / 相关文件）、评估正确性/健壮性/可读性。" +
      "重点：逻辑错误、边界情况、安全隐患（路径穿越/注入/危险命令）、性能问题、命名与可维护性。" +
      "产出物：问题清单（严重度分级：🔴 阻塞 / 🟡 建议 / 🔵 可选）+ 每条的依据与修改建议。",
    tools: ["git", "analyze_project", "list_dir", "pdf_read", "run_tests"],
  },
  {
    id: "researcher",
    name: "研究助手",
    emoji: "🔎",
    desc: "负责网络调研：搜索、抓取、汇总外部信息",
    sysPrompt:
      "你的职责是**调研**：通过搜索/抓取收集外部信息并整理。" +
      "要求：先 web_search 发现来源，需要具体数据/细节时必须 fetch_page 抓正文；来源链接**逐字原样**引用完整 URL，禁止编造；" +
      "多来源冲突时并列标注各来源。产出物：结构化调研结果（结论 + 要点 + 来源）。",
    tools: ["web_search", "fetch_page", "describe_image", "ocr_image", "pdf_read", "memory_recall", "memory_save"],
  },
];

/** 按 id 取角色（找不到返回 undefined）。 */
export function getRoleById(id: string | undefined | null): AgentRole | undefined {
  if (!id) return undefined;
  return AGENT_ROLES.find((r) => r.id === id);
}

/** 取角色的允许工具名数组（角色不存在或未指定返回空 = 不限）。 */
export function roleAllowedToolNames(id: string | undefined | null): string[] {
  const role = getRoleById(id);
  return role ? [...role.tools] : [];
}

/** 校验角色目录：tools 里引用到不存在的内置工具名（供测试）。 */
export function invalidRoleTools(): { role: string; tools: string[] }[] {
  const known = new Set(BUILTIN_TOOL_NAMES);
  const bad: { role: string; tools: string[] }[] = [];
  for (const r of AGENT_ROLES) {
    const unknown = r.tools.filter((t) => !known.has(t));
    if (unknown.length) bad.push({ role: r.id, tools: unknown });
  }
  return bad;
}
