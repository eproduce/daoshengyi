// P1-9a 技能包（批量导入导出）：把 Rust `skill_pack` 的读写结果翻译成「技能导入管线」能吃的形状。
//
// ## 分工
//
// - **打包/解包在 Rust**（zip 读写 + 安全边界：路径穿越、条目数与体积上限，见 `src-tauri/src/skill_pack.rs`）
// - **本模块只做纯映射**（包内条目 → 导入文件；技能 → 打包入参），不碰文件系统，便于单测
//
// ## 包内布局（v1）
//
// ```text
// manifest.json                 # 包元信息 + 每个技能的路由/能力声明/references 索引
// <slug>/SKILL.md
// <slug>/references/<file>.md
// ```
//
// 导入路径统一带上 `pack:<包名>/` 前缀：① 保证不同包里的同名技能 `importUrl` 不互相撞车
// （`planSkillImport` 靠 importUrl 判「同一文件再次导入 = 更新」）；② 列表里能显示「技能包」来源徽标。

import type { Skill, SkillReference, SkillRequires } from "../types";
import type { ExternalSkillFile } from "./skill-import";

/** Rust `SkillPackEntry` */
export interface SkillPackEntry {
  path: string;
  content: string;
  bytes: number;
}

/** manifest 里记录的单个技能元数据 */
export interface SkillPackManifestSkill {
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  version?: string;
  whenToUse?: string;
  tags?: string[];
  requires?: { tools?: string[]; servers?: string[] };
  file?: string;
  references?: { title?: string; file?: string }[];
}

export interface SkillPackManifest {
  format?: string;
  version?: number;
  exportedAt?: number;
  count?: number;
  skills?: SkillPackManifestSkill[];
}

/** Rust `SkillPackRead` */
export interface SkillPackRead {
  manifest: SkillPackManifest | null;
  entries: SkillPackEntry[];
  /** 被 Rust 忽略的条目数（越界路径 / 超限 / 非 UTF-8） */
  ignored: number;
}

/** Rust `SkillPackInput`（Tauri 会把 camelCase 参数名映射到 snake_case 字段） */
export interface SkillPackInput {
  name: string;
  description: string;
  category: string;
  version: string;
  whenToUse: string;
  tags: string[];
  requiresTools: string[];
  requiresServers: string[];
  content: string;
  references: { title: string; content: string }[];
}

/** 包内技能的路由/能力元数据（导入完成后补写到技能上） */
export interface PackSkillMeta {
  slug: string;
  name?: string;
  description?: string;
  category?: string;
  version?: string;
  whenToUse?: string;
  tags?: string[];
  requires?: SkillRequires;
  references?: SkillReference[];
}

/**
 * 由技能生成打包入参。`mdOf` 注入 `store.exportAsMd`，避免本模块反向依赖 store。
 */
export function packInputsFromSkills(
  skills: Skill[],
  mdOf: (id: string) => string,
): SkillPackInput[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description ?? "",
    category: s.category ?? "",
    version: s.version ?? "",
    whenToUse: s.whenToUse ?? "",
    tags: s.tags ?? [],
    requiresTools: s.requires?.tools ?? [],
    requiresServers: s.requires?.servers ?? [],
    content: mdOf(s.id) || "",
    references: (s.references ?? []).map((r) => ({ title: r.title, content: r.content })),
  }));
}

/** 取导入路径里的 slug：技能包是 `pack:<包名>/<slug>/SKILL.md`，外部目录是 `<slug>/SKILL.md`/`<file>.md` */
export function packSlugOf(importPath: string): string {
  const segs = (importPath || "").split("/");
  return importPath.startsWith("pack:") ? (segs[1] ?? "") : (segs[0] ?? "");
}

/**
 * 解包结果 → ① 交给 `planSkillImport` 的文件列表 ② slug → 元数据（含 references 正文）。
 *
 * 只认 `<slug>/SKILL.md` 与 `<slug>/references/<file>` 两种形状（Rust 已做安全过滤）。
 * manifest 缺失也能用：此时元数据只有 references（标题回退成文件名）。
 */
export function readPack(
  read: SkillPackRead,
  packName = "技能包",
): { files: ExternalSkillFile[]; metaBySlug: Map<string, PackSkillMeta> } {
  const metaBySlug = new Map<string, PackSkillMeta>();
  // 包内文件路径 → manifest 里声明的标题（用于给 references 起名）
  const titleByPath = new Map<string, string>();
  for (const m of read.manifest?.skills ?? []) {
    if (!m) continue;
    for (const r of m.references ?? []) {
      if (r?.file) titleByPath.set(r.file, r.title || "");
    }
    if (!m.slug) continue;
    metaBySlug.set(m.slug, {
      slug: m.slug,
      name: m.name,
      description: m.description,
      category: m.category,
      version: m.version,
      whenToUse: m.whenToUse,
      tags: m.tags,
      requires: m.requires,
      references: [],
    });
  }

  const files: ExternalSkillFile[] = [];
  for (const e of read.entries) {
    const segs = (e.path || "").split("/");
    if (segs.length === 2 && segs[1] === "SKILL.md") {
      files.push({
        source: "pack",
        label: "技能包",
        path: `pack:${packName}/${e.path}`,
        name: "SKILL.md",
        content: e.content,
        bytes: e.bytes,
      });
      continue;
    }
    if (segs.length === 3 && segs[1] === "references") {
      const slug = segs[0];
      const meta = metaBySlug.get(slug) ?? { slug, references: [] };
      metaBySlug.set(slug, meta);
      const title = titleByPath.get(e.path) || segs[2].replace(/\.md$/i, "");
      (meta.references ??= []).push({
        id: `${slug}:${segs[2]}`,
        title,
        content: e.content,
      });
    }
  }
  return { files, metaBySlug };
}
