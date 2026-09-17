/**
 * 工具结果的「内容感知压缩」（吸收自 DSH 生态 dsh-funnel / toolshrink / dsh-headroom / dsh-dcp 的思路）。
 *
 * 与「粗暴截断」的区别：
 * - 只压缩**冗余**（重复行、栈帧中段、通过用例、超大 JSON/表格的中间行、超长单行）；
 * - 错误/失败/异常行**永不丢弃**，且在最终裁剪时优先保留；
 * - 每次压缩都产出可读说明（丢了什么、丢了多少），让模型知道自己看到的是压缩视图；
 * - 真正需要原文时由调用方落盘并提供路径（本模块不做 IO）。
 */

export interface ReduceOptions {
  /** 小于该长度不压缩（默认 1600） */
  minChars?: number;
  /** 最终硬上限（默认 16000；调用方仍可能再落盘折叠） */
  maxChars?: number;
  /** 单行软上限（默认 1500），超出则首尾保留 */
  maxLineChars?: number;
}

export interface ReduceResult {
  text: string;
  /** 人类可读的压缩说明（供回填模型时附在末尾） */
  notes: string[];
  removedChars: number;
}

// 剥离 ANSI 颜色/光标控制序列：**这里就必须匹配控制字符** \u001b（ESC），
// 不是笔误 —— 否则工具输出里的彩色转义噪声会被当正文塞进上下文。
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** 失败/错误信号（中英混合；CJK 无 \b，故不用词边界） */
const IMPORTANT_RE =
  /error|errors|fail|failed|failure|fatal|panic|exception|traceback|cannot|refused|denied|timeout|not found|✗|✖|\b×\b|失败|错误|异常|拒绝|超时|无法/i;
/** 通过信号（用于折叠噪声，仅在失败数 ≥1 且通过行很多时才折叠） */
const PASS_RE =
  /^\s*(?:ok\s+\d+|✓|✔|√|PASS(?:ED)?\b|test .* \.\.\. ok|Tests:.*\bpassed\b|Test Suites:.*\bpassed\b|test result: ok)/i;
/** 栈帧行 */
const FRAME_RE = /^\s*(?:at\s|#\d+\s|File "|\S+\([^)]*:\d+\)|.*:\d+:\d+\)?$)/;
const FRAME_STRICT_RE = /^\s*(?:at\s+\S|#\d+\s+\S|File ")/;

function stripAnsi(s: string): { text: string; changed: boolean } {
  const out = s.replace(ANSI_RE, "");
  return { text: out, changed: out !== s };
}

/** 折叠连续重复行：> keep 次时保留前 keep 行 + 计数说明 */
function collapseRepeats(lines: string[], keep = 2): { lines: string[]; folded: number } {
  const out: string[] = [];
  let folded = 0;
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run > keep + 1 && lines[i].trim() !== "") {
      out.push(...lines.slice(i, i + keep));
      out.push(`…[同一行重复 ${run} 次，已省略 ${run - keep} 行]`);
      folded += run - keep;
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return { lines: out, folded };
}

/** 折叠栈帧中段（保留首 3 + 尾 2 + 计数） */
function collapseFrames(lines: string[]): { lines: string[]; folded: number } {
  const out: string[] = [];
  let folded = 0;
  let i = 0;
  while (i < lines.length) {
    if (!FRAME_STRICT_RE.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && FRAME_RE.test(lines[j]) && lines[j].trim() !== "") j++;
    const run = lines.slice(i, j);
    if (run.length > 6) {
      out.push(...run.slice(0, 3));
      out.push(`…[栈帧 ${run.length} 层中省略 ${run.length - 5} 层]`);
      out.push(...run.slice(-2));
      folded += run.length - 5;
    } else {
      out.push(...run);
    }
    i = j;
  }
  return { lines: out, folded };
}

/** 折叠「通过用例」噪声（有失败出现时才折叠，避免把全绿输出压成一行） */
function collapsePassing(lines: string[]): { lines: string[]; folded: number } {
  const failIdx = lines.filter((l) => IMPORTANT_RE.test(l)).length;
  const passLines = lines.filter((l) => PASS_RE.test(l));
  if (failIdx === 0 || passLines.length < 10) return { lines, folded: 0 };
  const kept: string[] = [];
  let dropped = 0;
  for (const l of lines) {
    if (PASS_RE.test(l) && !IMPORTANT_RE.test(l)) {
      dropped++;
      continue;
    }
    kept.push(l);
  }
  if (dropped < 10) return { lines, folded: 0 };
  kept.push(`…[${dropped} 行「通过/成功」条目已省略，仅保留失败与汇总]`);
  return { lines: kept, folded: dropped };
}

/** 超大 JSON 采样：数组 >30 项留首 8 + 末 2；对象按键数截断；深度 ≤6 */
function sampleJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…[层级过深已省略]";
  if (Array.isArray(value)) {
    if (value.length <= 30) return value.map((v) => sampleJson(v, depth + 1));
    const head = value.slice(0, 8).map((v) => sampleJson(v, depth + 1));
    const tail = value.slice(-2).map((v) => sampleJson(v, depth + 1));
    return [...head, `…[数组共 ${value.length} 项，已省略中间 ${value.length - 10} 项]`, ...tail];
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};
    for (const k of keys.slice(0, 40)) out[k] = sampleJson(obj[k], depth + 1);
    if (keys.length > 40) out["…"] = `共 ${keys.length} 个键，已省略 ${keys.length - 40} 个`;
    return out;
  }
  return value;
}

/** 表格/CSV 采样：表头 + 前 12 行 + 末 4 行 */
function sampleTable(lines: string[]): { lines: string[]; folded: number } | null {
  if (lines.length < 40) return null;
  const delim = ["\t", ",", "|", ";"].find((d) => {
    const c = lines[0].split(d).length - 1;
    if (c >= 2) return true;
    return false;
  });
  if (!delim) return null;
  const cols = lines.filter((l) => l.split(delim).length >= 3).length;
  if (cols / lines.length < 0.8) return null;
  const head = lines.slice(0, 13);
  const tail = lines.slice(-4);
  const omitted = lines.length - head.length - tail.length;
  return {
    lines: [...head, `…[表格共 ${lines.length} 行，已省略中间 ${omitted} 行]`, ...tail],
    folded: omitted,
  };
}

/** 单行钳制：超长行保留首尾（base64、单行 JSON、长 hash 列表） */
function clampLongLines(
  lines: string[],
  maxLineChars: number,
): { lines: string[]; folded: number } {
  let folded = 0;
  const out = lines.map((l) => {
    if (l.length <= maxLineChars) return l;
    const head = l.slice(0, Math.round(maxLineChars * 0.55));
    const tail = l.slice(-Math.round(maxLineChars * 0.15));
    folded += l.length - head.length - tail.length;
    return `${head}…[该行共 ${l.length} 字符，已省略中间 ${l.length - head.length - tail.length} 字符]${tail}`;
  });
  return { lines: out, folded };
}

/** 最终硬裁剪：错误行优先保留 + 首尾，其余丢弃并计数 */
function capWithPriority(lines: string[], maxChars: number): { lines: string[]; folded: number } {
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  if (size <= maxChars) return { lines, folded: 0 };
  const important: string[] = [];
  const others: string[] = [];
  for (const l of lines) {
    if (IMPORTANT_RE.test(l)) important.push(l);
    else others.push(l);
  }
  const budgetImportant = Math.round(maxChars * 0.4);
  const keptImportant: string[] = [];
  let used = 0;
  for (const l of important.slice(0, 80)) {
    if (used + l.length > budgetImportant) break;
    keptImportant.push(l);
    used += l.length + 1;
  }
  const remain = Math.max(400, maxChars - used - 120);
  const headBudget = Math.round(remain * 0.75);
  const tailBudget = remain - headBudget;
  const head: string[] = [];
  let hu = 0;
  for (const l of others) {
    if (hu + l.length > headBudget) break;
    head.push(l);
    hu += l.length + 1;
  }
  const tail: string[] = [];
  let tu = 0;
  for (let i = others.length - 1; i >= head.length; i--) {
    const l = others[i];
    if (tu + l.length > tailBudget) break;
    tail.unshift(l);
    tu += l.length + 1;
  }
  const omitted = others.length - head.length - tail.length;
  const out = [
    ...keptImportant,
    ...(keptImportant.length
      ? [`…[以上为全部「错误/失败」相关行，共 ${Math.min(important.length, 80)} 行]`]
      : []),
    ...head,
    `…[已省略 ${omitted} 行低信息量内容（可按需缩小查询范围，或用 offset/length 读取落盘原文）]`,
    ...tail,
  ];
  return { lines: out, folded: omitted };
}

/**
 * 压缩工具结果。返回的 text 仍可能超过调用方的折叠阈值（由调用方决定是否落盘），
 * 但已剔除绝大部分冗余。notes 为空表示「未做任何压缩」。
 */
export function reduceToolResult(
  tool: string,
  input: string,
  opts: ReduceOptions = {},
): ReduceResult {
  const minChars = opts.minChars ?? 1600;
  const maxChars = opts.maxChars ?? 16000;
  const maxLineChars = opts.maxLineChars ?? 1500;
  const raw = String(input ?? "");
  const notes: string[] = [];
  const original = raw.length;

  const ansi = stripAnsi(raw);
  let text = ansi.text;
  if (ansi.changed) notes.push("清除终端颜色/控制字符");

  // 廉价折叠（重复行/栈帧/通过条目）**与长度无关**：它们只丢冗余，任何长度都值得丢；
  // 否则中等长度的测试输出（1300 字符）会带着几十行重复信息进上下文。
  let lines = text.split("\n");

  const rep = collapseRepeats(lines);
  if (rep.folded > 0) {
    lines = rep.lines;
    notes.push(`折叠连续重复行 ${rep.folded} 行`);
  }

  const frames = collapseFrames(lines);
  if (frames.folded > 0) {
    lines = frames.lines;
    notes.push(`折叠调用栈 ${frames.folded} 层`);
  }

  // 「通过条目折叠」只对命令/测试类输出有意义（其它工具不会产出 ✓/ok 这类噪声行）
  const commandLike =
    /test|command|exec|build|lint|compile|cargo|npm|pnpm|pytest|make|git|stdin/i.test(tool);
  if (commandLike) {
    const pass = collapsePassing(lines);
    if (pass.folded > 0) {
      lines = pass.lines;
      notes.push(`省略「通过」条目 ${pass.folded} 行（失败信息全部保留）`);
    }
  }

  text = lines.join("\n");
  if (text.length < minChars) {
    return { text, notes, removedChars: original - text.length };
  }

  lines = text.split("\n");

  // JSON：整体可解析时做结构化采样
  const trimmed = lines.join("\n").trim();
  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    trimmed.length > 2000 &&
    /JSON (?:错误|非法)|Unexpected token/.test(trimmed) === false
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const sampled = sampleJson(parsed);
      const sampledText = JSON.stringify(sampled, null, 2);
      if (sampledText.length < trimmed.length * 0.7) {
        text = sampledText;
        lines = text.split("\n");
        notes.push("对超大 JSON 做了结构采样（大数组留首尾、键数截断）");
      }
    } catch {
      /* 不是合法 JSON → 走文本路径 */
    }
  }

  const table = sampleTable(lines);
  if (table) {
    lines = table.lines;
    notes.push(`对表格输出做了首尾采样（省略 ${table.folded} 行）`);
  }

  const clamped = clampLongLines(lines, maxLineChars);
  if (clamped.folded > 0) {
    lines = clamped.lines;
    notes.push(`钳制超长单行（省略 ${clamped.folded} 字符）`);
  }

  const capped = capWithPriority(lines, maxChars);
  if (capped.folded > 0) {
    lines = capped.lines;
    notes.push(`按预算裁剪 ${capped.folded} 行（错误行已优先保留）`);
  }

  text = lines.join("\n");
  return { text, notes, removedChars: original - text.length };
}
