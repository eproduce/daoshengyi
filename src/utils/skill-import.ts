// P1-9a 技能外部导入：把别处攒的技能（Claude Code / Codex / Cursor）搬进来。
//
// ## 分工
//
// - **发现**：Rust 侧 `scan_external_skills` 递归扫描并原样返回文件内容（只读，带深度/体积边界）。
// - **规划**（本模块，纯函数）：解析 → 判定「新增 / 更新 / 冲突 / 跳过」→ 产出可执行计划。
//   放在这里是因为只有它能同时看到「现有技能表」和「外部文件」，才谈得上不误覆盖。
//
// ## 判定规则（刻意保守）
//
// | 情形 | 处置 |
// | --- | --- |
// | 解析失败 / 正文为空 | 跳过（说明原因） |
// | 同 `importUrl` 已导入 | **更新**（来源文件改了，刷新正文） |
// | 同名且是用户手写/目录安装（source=user/catalog） | **冲突**，不覆盖（用户的东西优先） |
// | 同名且来源文件不同 | **冲突**（避免两个来源互相顶替） |
// | 同批次重复 | 后者跳过 |
//
// 一句话：**永不覆盖用户手写的技能**，只更新「本来就是这个文件导入的」那条。

import { parseSkillMd } from "./skill-md";

/** Rust 扫描回传的文件（与 skill_import.rs 的 ExternalSkillFile 对应） */
export interface ExternalSkillFile {
  source: string;
  label: string;
  path: string;
  /** 文件名（无 frontmatter 时用于兜底命名） */
  name: string;
  content: string;
  bytes: number;
}

/** 扫描来源规格（与 skill_import.rs 的 SkillSourceSpec 对应） */
export interface SkillSourceSpec {
  id: string;
  label: string;
  dir: string;
  file_name?: string;
  /** 是否同时接受**扁平**的 `<name>.md`（agentskills / DSH 允许，Claude Code 不允许） */
  flat?: boolean;
}

/**
 * 默认扫描来源（2026-10-13 扩展：DSH / 项目级 / 自定义目录）：
 * - Claude Code：`~/.claude/skills/<name>/SKILL.md` + `~/.claude/commands/*.md`
 * - 通用技能目录：`~/.agents/skills/**`（`npx skills add -a <agent>` 装在「其它 agent」的位置）
 * - DSH（DeepSeek Harness）：`~/.dsh/skills/**`（其 `user-dsh` 根，`DSH_HOME` 自定义时请用下面的自定义目录）
 * - Codex：`~/.codex/prompts/*.md`
 * - 通用：`~/Documents/道生一技能/*.md`（用户自己放的地方）
 * - 项目级（有工作区时）：`<ws>/.agents/skills`（agentskills 项目级）、`<ws>/.dsh/skills`（DSH 项目级）、`<ws>/.cursor/rules/*.mdc`
 * - 自定义：`customDirs`（设置里的「自定义技能目录」，等价 DSH 的 `Config.customSkillDirs`）
 *
 * `flat: true` 的来源同时接受扁平的 `<name>.md`；Claude Code 只认 `<name>/SKILL.md`，
 * 故不开（避免把目录里顺带放的 README 之类当技能收进来）。
 */
export function skillSourceSpecs(
  home: string,
  workspace = "",
  customDirs: string[] = [],
): SkillSourceSpec[] {
  const h = (home || "").replace(/\/+$/, "");
  const specs: SkillSourceSpec[] = [];
  if (h) {
    specs.push(
      {
        id: "claude-code",
        label: "Claude Code 技能",
        dir: `${h}/.claude/skills`,
        file_name: "SKILL.md",
      },
      { id: "claude-commands", label: "Claude Code 命令", dir: `${h}/.claude/commands` },
      // 上游 `npx -y skills add <repo> -a <agent>` 把技能装在 ~/.agents/skills；
      // 我们的 agent 不在它的已知名单里，但**同一个目录我们照样能读**。
      {
        id: "agents-skills",
        label: "通用技能目录",
        dir: `${h}/.agents/skills`,
        file_name: "SKILL.md",
        flat: true,
      },
      // DSH 的 user-dsh 根：`<dshHome>/skills`（默认 ~/.dsh）
      {
        id: "dsh-skills",
        label: "DSH 技能",
        dir: `${h}/.dsh/skills`,
        file_name: "SKILL.md",
        flat: true,
      },
      { id: "codex", label: "Codex 提示词", dir: `${h}/.codex/prompts` },
      { id: "generic", label: "道生一技能目录", dir: `${h}/Documents/道生一技能` },
    );
  }
  const ws = (workspace || "").replace(/\/+$/, "");
  if (ws) {
    specs.push(
      // DSH project-agents / agentskills 项目级
      {
        id: "project-agents",
        label: "项目通用技能",
        dir: `${ws}/.agents/skills`,
        file_name: "SKILL.md",
        flat: true,
      },
      // DSH project-dsh
      {
        id: "project-dsh",
        label: "项目 DSH 技能",
        dir: `${ws}/.dsh/skills`,
        file_name: "SKILL.md",
        flat: true,
      },
      { id: "cursor", label: "Cursor 规则（当前项目）", dir: `${ws}/.cursor/rules` },
    );
  }
  // 自定义目录：逐行一个路径；去空行、去重（避免与内置来源重复扫同一目录）
  const seen = new Set(specs.map((s) => s.dir));
  for (const raw of customDirs || []) {
    const dir = String(raw || "")
      .trim()
      .replace(/\/+$/, "");
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const base = dir.split("/").filter(Boolean).pop() || dir;
    specs.push({
      id: `custom:${dir}`,
      label: `自定义目录 · ${base}`,
      dir,
      file_name: "SKILL.md",
      flat: true,
    });
  }
  return specs;
}

/** 导入来源识别结果 */
export interface ImportOrigin {
  kind: string;
  label: string;
}

/** 来源识别规则（按路径片段判定，与 skillSourceSpecs 的目录一一对应） */
const ORIGIN_RULES: { kind: string; label: string; re: RegExp }[] = [
  { kind: "pack", label: "技能包", re: /^pack:/ },
  { kind: "claude-code", label: "Claude Code", re: /\/\.claude\/skills\// },
  { kind: "claude-commands", label: "Claude Code 命令", re: /\/\.claude\/commands\// },
  { kind: "dsh", label: "DSH", re: /\/\.dsh\/skills\// },
  { kind: "agents", label: "通用技能目录", re: /\/\.agents\/skills\// },
  { kind: "codex", label: "Codex", re: /\/\.codex\/prompts\// },
  { kind: "cursor", label: "Cursor", re: /\/\.cursor\/rules\// },
  { kind: "generic", label: "道生一技能目录", re: /道生一技能\// },
];

/**
 * 由技能的 `importUrl` 推断来源（用于列表上的来源徽标）。
 * 纯路径判断：对**已经导入过**的旧技能同样有效，无需改数据模型。
 * 识别不出时按「URL 导入 / 外部导入」区分，空值返回 null。
 */
export function importOrigin(url?: string): ImportOrigin | null {
  const u = String(url || "");
  if (!u) return null;
  for (const r of ORIGIN_RULES) if (r.re.test(u)) return { kind: r.kind, label: r.label };
  return /^https?:\/\//i.test(u)
    ? { kind: "url", label: "URL 导入" }
    : { kind: "external", label: "外部导入" };
}

/** 技能名归一化（判定同名） */
export function normalizeSkillName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, "");
}

/** 重命名导入时找一个未占用的名字：`原名 (2)`、`原名 (3)`… */
export function uniqueSkillName(base: string, taken: Set<string>): string {
  for (let i = 2; i < 200; i++) {
    const cand = `${base} (${i})`;
    if (!taken.has(normalizeSkillName(cand))) return cand;
  }
  return `${base} (${Date.now() % 1000})`;
}

/** 现有技能表里与导入判定相关的最小字段 */
export interface ExistingSkillRef {
  id: string;
  name: string;
  source: string;
  importUrl?: string;
}

/** 可执行的导入项 */
export interface ImportItem {
  action: "add" | "update";
  /** action=update 时给出要更新的技能 id */
  targetId?: string;
  file: ExternalSkillFile;
  draft: {
    name: string;
    description: string;
    prompt: string;
    category: string;
    whenToUse?: string;
  };
  /** 同名冲突选择「重命名导入」时，写入技能库用的新名字 */
  renameTo?: string;
}

/** 导入选项（默认行为与历史一致：同名就冲突并跳过） */
export interface ImportOptions {
  /** 遇同名技能时的策略：skip 跳过（默认）/ overwrite 覆盖已有（手写的仍受保护）/ rename 重命名导入 */
  onNameConflict?: "skip" | "overwrite" | "rename";
}

export interface ImportPlan {
  items: ImportItem[];
  conflicts: { path: string; name: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  /** 来源统计（用于给用户看「扫到了哪些来源的多少文件」） */
  bySource: Record<string, number>;
}

/// 无 frontmatter 时用文件名兜底命名（比「未命名技能」有用）
export function fallbackName(file: ExternalSkillFile): string {
  const base = (file.name || "").replace(/\.(md|mdc|markdown)$/i, "");
  if (base && !/^skill$/i.test(base)) return base.slice(0, 60);
  // SKILL.md → 用所在目录名
  const parts = (file.path || "").split("/").filter(Boolean);
  return (parts[parts.length - 2] || "导入技能").slice(0, 60);
}

/**
 * 生成导入计划（纯函数）。`existing` 传现有技能表（只需 id/name/source/importUrl）。
 *
 * 冲突策略（`opts.onNameConflict`）：默认 `skip`——同名一律进 conflicts 不覆盖；
 * `overwrite` 覆盖已有（**用户手写的仍受保护**，这是硬规则）；`rename` 改名后新增。
 */
export function planSkillImport(
  files: ExternalSkillFile[],
  existing: ExistingSkillRef[],
  opts: ImportOptions = {},
): ImportPlan {
  const items: ImportItem[] = [];
  const conflicts: ImportPlan["conflicts"] = [];
  const skipped: ImportPlan["skipped"] = [];
  const bySource: Record<string, number> = {};
  const seenNames = new Set<string>();
  const byUrl = new Map<string, ExistingSkillRef>();
  const byName = new Map<string, ExistingSkillRef>();
  for (const s of existing) {
    if (s.importUrl) byUrl.set(s.importUrl, s);
    byName.set(normalizeSkillName(s.name), s);
  }

  for (const file of files) {
    bySource[file.source] = (bySource[file.source] ?? 0) + 1;
    if (!file.content || !file.content.trim()) {
      skipped.push({ path: file.path, reason: "文件为空" });
      continue;
    }
    const parsed = parseSkillMd(file.content);
    if (!parsed || !parsed.prompt.trim()) {
      skipped.push({ path: file.path, reason: "解析失败或无正文" });
      continue;
    }
    const rawName =
      parsed.name === "未命名技能" || parsed.name === "导入技能" ? fallbackName(file) : parsed.name;
    const name = rawName.trim() || fallbackName(file);
    const key = normalizeSkillName(name);

    // 同一文件再次导入 → 更新（来源文件可能已改）
    const bySameUrl = byUrl.get(file.path);
    if (bySameUrl) {
      items.push({
        action: "update",
        targetId: bySameUrl.id,
        file,
        draft: {
          name,
          description: parsed.description,
          prompt: parsed.prompt,
          category: parsed.category || "导入",
          whenToUse: parsed.whenToUse,
        },
      });
      seenNames.add(key);
      continue;
    }
    // 同批次重复 → 跳过后面的
    if (seenNames.has(key)) {
      skipped.push({ path: file.path, reason: `同批次已有同名技能「${name}」` });
      continue;
    }
    // 同名已存在 → 按策略处置（默认冲突跳过；手写技能永不被覆盖）
    const sameName = byName.get(key);
    if (sameName) {
      const strategy = opts.onNameConflict ?? "skip";
      const handWritten = sameName.source === "user";
      if (strategy === "overwrite" && !handWritten) {
        items.push({
          action: "update",
          targetId: sameName.id,
          file,
          draft: {
            name,
            description: parsed.description,
            prompt: parsed.prompt,
            category: parsed.category || "导入",
            whenToUse: parsed.whenToUse,
          },
        });
        seenNames.add(key);
        continue;
      }
      if (strategy === "rename") {
        const taken = new Set<string>([...byName.keys(), ...seenNames]);
        const renamed = uniqueSkillName(name, taken);
        items.push({
          action: "add",
          renameTo: renamed,
          file,
          draft: {
            name: renamed,
            description: parsed.description,
            prompt: parsed.prompt,
            category: parsed.category || "导入",
            whenToUse: parsed.whenToUse,
          },
        });
        seenNames.add(normalizeSkillName(renamed));
        continue;
      }
      const reason =
        handWritten && strategy === "overwrite"
          ? "同名技能是你手写的，受保护不覆盖（可改用「重命名导入」）"
          : sameName.source === "import"
            ? "同名技能已存在（来自其它文件的导入）"
            : `同名技能已存在（来源：${sameName.source === "user" ? "你手写的" : "技能目录"}）`;
      conflicts.push({ path: file.path, name, reason });
      continue;
    }
    items.push({
      action: "add",
      file,
      draft: {
        name,
        description: parsed.description,
        prompt: parsed.prompt,
        category: parsed.category || "导入",
        whenToUse: parsed.whenToUse,
      },
    });
    seenNames.add(key);
  }
  return { items, conflicts, skipped, bySource };
}

/// 计划摘要（给通知/面板用，避免把细节撒得到处都是）
export function summarizePlan(plan: ImportPlan): string {
  const parts: string[] = [];
  const adds = plan.items.filter((i) => i.action === "add").length;
  const updates = plan.items.length - adds;
  if (adds) parts.push(`新增 ${adds}`);
  if (updates) parts.push(`更新 ${updates}`);
  if (plan.conflicts.length) parts.push(`同名冲突 ${plan.conflicts.length}`);
  if (plan.skipped.length) parts.push(`跳过 ${plan.skipped.length}`);
  return parts.length ? parts.join(" · ") : "没有可导入的技能";
}
