// Codex `apply_patch` 格式解析（对齐 openai/codex 的 freeform 工具）
//
// 为什么引入：Codex 的 apply_patch 是其最核心的文件编辑工具（GPT-5 专门训练过该格式），
// 一次调用可完成**多文件、多片段**编辑，显著减少「改 5 个文件要 5 次工具往返」。
// 道生一原先只有 replace_string / insert_string（单处编辑），多文件改动要反复往返。
//
// 这里不复刻 Codex 的 Rust 实现，而是把该格式**适配到既有能力**：
// 解析成「每文件若干 hunks」→ 再翻译成本项目 `apply_edits` 命令的 replace/insert 操作，
// 从而自动获得既有的 diff 预览、用户确认（P-A4）、撤销快照（undo_history）与审计。
//
// 支持的语法（Codex 原格式）：
//   *** Begin Patch
//   *** Add File: <path>            → 逐行 +内容（文件已存在则报错，避免误覆盖）
//   *** Update File: <path>         → @@ 定位行（可选）+ 上下文/删除/新增行
//   *** Move to: <path>             → 暂不支持（会给出替代方案提示）
//   *** Delete File: <path>
//   *** End Patch
// 行前缀：' ' 上下文、'-' 删除、'+' 新增。

export interface PatchHunk {
  /** 可选的 @@ 定位提示（仅用于报错信息，匹配仍靠精确文本） */
  anchor?: string;
  /** 原文片段（上下文 + 删除行），去掉前缀后按 \n 连接 */
  oldText: string;
  /** 新文片段（上下文 + 新增行），去掉前缀后按 \n 连接 */
  newText: string;
}

export interface PatchFileOp {
  op: "add" | "update" | "delete";
  path: string;
  /** update：若干片段；add：整份内容放在 content；delete：空 */
  hunks: PatchHunk[];
  /** add：新增文件内容（去掉 '+' 前缀后按 \n 连接） */
  content?: string;
}

export interface ParsedPatch {
  files: PatchFileOp[];
  /** 无法处理但需要告知模型的问题（如 Move to） */
  warnings: string[];
}

/** 解析失败时的可读错误（模型据此改写 patch） */
export class PatchParseError extends Error {}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

/**
 * 解析 Codex 格式补丁。宽容点：允许省略 *** Begin Patch/*** End Patch、允许前后有解释文字，
 * 但一旦出现结构错误（如 Update 里没有 hunk、hunk 的 old 为空）就明确报错，方便模型纠正。
 */
export function parseCodexPatch(raw: string): ParsedPatch {
  const text = (raw ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new PatchParseError("patch 为空");
  if (!/\*\*\*\s+(Add|Update|Delete)\s+File:/.test(text)) {
    throw new PatchParseError(
      "未找到 `*** Add File:` / `*** Update File:` / `*** Delete File:` 段落——请检查是否符合 apply_patch 格式（每段必须以 `*** Begin Patch` 开始）。",
    );
  }

  const lines = text.split("\n");
  const files: PatchFileOp[] = [];
  const warnings: string[] = [];

  let cur: PatchFileOp | null = null;
  let hunk: { anchor?: string; oldLines: string[]; newLines: string[] } | null = null;
  let addLines: string[] = [];
  let moveTo: string | null = null;

  /** 收尾当前 hunk：old 为空且 new 非空 → 纯插入（无上下文）无法定位，明确报错 */
  const flushHunk = (lineNo: number) => {
    if (!hunk || !cur) return;
    const oldText = hunk.oldLines.join("\n");
    const newText = hunk.newLines.join("\n");
    if (oldText === newText) {
      // 无实质改动（例如整段都是上下文）：忽略该片段而不是报错
      hunk = null;
      return;
    }
    if (!oldText) {
      throw new PatchParseError(
        `第 ${lineNo} 行附近的片段只有新增行、没有上下文——请在 @@ 后保留至少一行原文（前缀空格）作为定位锚点，或改用 insert_string。`,
      );
    }
    cur.hunks.push({ anchor: hunk.anchor, oldText, newText });
    hunk = null;
  };

  const flushFile = () => {
    if (!cur) return;
    if (moveTo) {
      warnings.push(
        `「${cur.path}」包含 *** Move to: ${moveTo}（暂不支持改名/移动）——请分两步：先用本工具改内容，再用 run_command 执行 git mv / mv。`,
      );
      moveTo = null;
    }
    if (cur.op === "add") {
      if (addLines.length === 0) {
        throw new PatchParseError(`*** Add File: ${cur.path} 没有任何 + 行内容`);
      }
      cur.content = addLines.join("\n");
    }
    if (cur.op === "update" && cur.hunks.length === 0) {
      throw new PatchParseError(
        `*** Update File: ${cur.path} 未包含任何有效改动片段（hunk）——请检查 - / + 行是否成对出现。`,
      );
    }
    files.push(cur);
    cur = null;
    addLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === BEGIN || trimmed === END) {
      if (trimmed === END) flushHunk(i + 1);
      continue;
    }
    const header = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      flushHunk(i + 1);
      flushFile();
      const kind = header[1];
      const path = header[2];
      if (!path) throw new PatchParseError(`第 ${i + 1} 行：文件路径为空`);
      cur = {
        op: kind === "Add" ? "add" : kind === "Update" ? "update" : "delete",
        path,
        hunks: [],
      };
      continue;
    }
    const move = /^\*\*\*\s+Move to:\s*(.+?)\s*$/.exec(line);
    if (move) {
      moveTo = move[1];
      continue;
    }
    if (/^\*\*\*\s+/.test(line)) {
      // 其它 *** 指令（End of File 等）：忽略但不报错
      continue;
    }
    if (!cur) continue; // patch 之外的解释文字

    if (cur.op === "add") {
      if (line.startsWith("+")) addLines.push(line.slice(1));
      else if (trimmed === "") addLines.push(""); // 允许空行
      continue;
    }
    if (cur.op === "delete") continue;

    // update：@@ 定位行或内容行
    if (line.startsWith("@@")) {
      flushHunk(i + 1);
      hunk = { anchor: line.slice(2).trim(), oldLines: [], newLines: [] };
      continue;
    }
    if (!hunk) {
      if (trimmed === "") continue;
      // Codex 允许省略 @@（片段直接从上下文开始）
      hunk = { oldLines: [], newLines: [] };
    }
    const c = line[0];
    if (c === " ") {
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
    } else if (c === "-") {
      hunk.oldLines.push(line.slice(1));
    } else if (c === "+") {
      hunk.newLines.push(line.slice(1));
    } else if (trimmed === "") {
      hunk.oldLines.push("");
      hunk.newLines.push("");
    } else {
      throw new PatchParseError(
        `第 ${i + 1} 行的前缀非法：${JSON.stringify(line.slice(0, 40))}——片段内每行必须以「空格」(上下文)、「-」(删除)、「+」(新增) 开头；补丁结束后请用 \`*** End Patch\` 收尾，不要把解释文字写进补丁。`,
      );
    }
  }
  flushHunk(lines.length);
  flushFile();

  if (files.length === 0) throw new PatchParseError("补丁中没有任何文件改动");
  return { files, warnings };
}

/**
 * 把 update 类型的片段翻译成本项目 `apply_edits` 的操作数组。
 * 字段：{op:"replace", old, new} / {op:"insert", anchor, position, text} / {op:"delete", old}。
 * 返回 Record<string, unknown>[] 以直接作为 Rust 命令参数（与调用方既有类型一致）。
 */
export function hunksToEdits(hunks: PatchHunk[]): Record<string, unknown>[] {
  return hunks.map((h) => ({ op: "replace", old: h.oldText, new: h.newText }));
}

/** 统计：本次补丁共改了几个文件 / 几处片段 / 增删行数（供结果摘要与 UI 展示） */
export function summarizePatch(p: ParsedPatch): string {
  let added = 0;
  let removed = 0;
  for (const f of p.files) {
    if (f.op === "add") {
      added += (f.content ?? "").split("\n").length;
      continue;
    }
    for (const h of f.hunks) {
      const oldL = h.oldText.split("\n");
      const newL = h.newText.split("\n");
      added += newL.filter((l) => !oldL.includes(l)).length;
      removed += oldL.filter((l) => !newL.includes(l)).length;
    }
  }
  return `${p.files.length} 个文件、+${added}/-${removed} 行`;
}
