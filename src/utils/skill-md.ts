// 技能 Markdown 解析（纯函数，零依赖）。
//
// 从 `stores/skill.ts` 抽出来，理由有两条：
// 1. **分层**：`utils/skill-import.ts` 需要它，但 util 依赖 store 是反向依赖（且 store
//    模块带 Pinia / localStorage，单测里加载会引入不必要的副作用）；
// 2. **可测**：解析规则（frontmatter 可选、字段兜底、能力需求）值得单独用单测钉住。
//
// 兼容三类外部格式（都是 Markdown + 可选 `---` frontmatter）：
// - Claude Code `SKILL.md`：`name` / `description`
// - Cursor `.mdc`：`description` / `globs`
// - 自家 / Codex 提示词：无 frontmatter，整篇即正文

/** 解析结果（与 `types.Skill` 的字段命名对齐，便于直接落库） */
export interface ParsedSkillMd {
  name: string;
  description: string;
  prompt: string;
  category: string;
  author?: string;
  whenToUse?: string;
  /** 能力需求（命中技能时自动激活工具 / 连接 MCP 服务器） */
  requires?: { tools?: string[]; servers?: string[] };
}

/** 解析 .md / .mdc 技能文件；`null` 表示无法解析出任何可用正文 */
export function parseSkillMd(md: string): ParsedSkillMd | null {
  const text = md ?? "";
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fmMatch) {
    const front = fmMatch[1];
    const body = fmMatch[2].trim();
    const get = (key: string) => {
      const m = front.match(new RegExp(`${key}:\\s*(.+)`, "i"));
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    };
    const name = get("name") || get("title") || "未命名技能";
    const desc = get("description");
    const cat = get("category") || "导入";
    const author = get("author");
    const whenToUse = get("when_to_use") || get("whenToUse");
    // 能力需求（与 tool_search 延迟加载配套）：`requires_tools: browser_navigate, ocr_image`
    // `requires_servers: GitHub, PostgreSQL`（逗号分隔；中英文逗号均可）
    const csv = (v: string) =>
      v
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
    const reqTools = csv(get("requires_tools") || get("requiresTools"));
    const reqServers = csv(get("requires_servers") || get("requiresServers"));
    const requires =
      reqTools.length || reqServers.length
        ? {
            tools: reqTools.length ? reqTools : undefined,
            servers: reqServers.length ? reqServers : undefined,
          }
        : undefined;
    if (!body) return null; // 只有 frontmatter 没有正文 → 不是可用的技能
    return { name, description: desc, prompt: body, category: cat, author, whenToUse, requires };
  }
  // 无 frontmatter：整个文件就是 prompt
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split("\n");
  const name = lines[0].replace(/^#+\s*/, "").slice(0, 50) || "导入技能";
  return { name, description: "", prompt: trimmed, category: "导入" };
}
