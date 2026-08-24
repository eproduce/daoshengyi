/** ReAct 工具调用解析 */

export interface ToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

function parseJsonObject(s: string): ToolCall | null {
  try {
    const parsed = JSON.parse(s);
    // 兼容 DeepSeek DSML 原生 tool_call 用 name 字段、自定义 <tool_call> 用 tool 字段
    const tool = typeof parsed.tool === "string" ? parsed.tool : typeof parsed.name === "string" ? parsed.name : "";
    if (tool && parsed.arguments && typeof parsed.arguments === "object") {
      return { server: parsed.server || "default", tool, arguments: parsed.arguments };
    }
  } catch { /* ignore */ }
  return null;
}

/// 从内容中提取所有可能的工具调用 JSON 对象（支持模型直接输出裸 JSON）
function extractToolCalls(content: string): ToolCall[] {
  const results: ToolCall[] = [];
  // 匹配花括号对象（支持一层嵌套），逐个尝试解析
  const re = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const parsed = parseJsonObject(m[0]);
    if (parsed) results.push(parsed);
  }
  return results;
}

/// 匹配 DeepSeek DSML 原生 tool_call 标签：<｜DSML｜tool_call｜>...</｜DSML｜tool_call｜>
/// 只要标签内同时含 DSML 与 tool_call 即命中，兼容：全角｜ / 半角| / 双竖线 / 空格等变体
const DSML_TOOL_CALL_RE =
  /<(?=[^>]*DSML)(?=[^>]*tool_call)[^>]*>\s*([\s\S]*?)\s*<(?=[^>]*DSML)(?=[^>]*tool_call)[^>]*\/[^>]*>/i;
const DSML_TOOL_CALL_GLOBAL_RE =
  /<(?=[^>]*DSML)(?=[^>]*tool_call)[^>]*>[\s\S]*?<(?=[^>]*DSML)(?=[^>]*tool_call)[^>]*\/[^>]*>/gi;

/// 判断工具调用块是否已完整闭合，避免把流式中途的半截 JSON 当工具调用提前解析。
/// 兼容三种闭合标记：
/// 1. 标准格式 </tool_call>
/// 2. DeepSeek DSML 原生格式 </｜DSML｜tool_call｜>（含全角/半角竖线/双竖线/空格变体，
///    < 与 / 之间可能有 |，如 <|/DSML|tool_call|>）
/// 3. 模型手写的伪卡片「### 🔧 调用工具 + <details>参数</details>」完整出现
///    （模型误把 UI 卡片当调用格式时，也要能识别并执行）
export function hasCompleteToolCall(buffer: string): boolean {
  return (
    /<\s*\/\s*tool_call\s*>/.test(buffer) ||
    /<\s*[^>]*\/\s*[^>]*DSML[^>]*tool_call[^>]*>/i.test(buffer) ||
    /###\s*🔧\s*调用工具[\s\S]*?<\/details>/.test(buffer)
  );
}

/// 从模型手写的伪卡片「### 🔧 调用工具：\`tool\` + 参数 JSON 代码块」中提取工具调用。
/// 模型可能把历史消息里的 UI 卡片格式误当成工具调用格式写在正文里，
/// 这里兜底识别，让工具仍能真正执行（否则卡片只是文本、工具不执行、回复中断）。
const FAKE_TOOL_CARD_RE = /###\s*🔧\s*调用工具：\s*`?([\w-]+)`?[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
function parseFakeToolCard(content: string): ToolCall | null {
  const m = content.match(FAKE_TOOL_CARD_RE);
  if (!m) return null;
  const tool = m[1];
  if (!tool) return null;
  try {
    const args = JSON.parse(m[2]);
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return { server: "default", tool, arguments: args as Record<string, unknown> };
    }
  } catch { /* ignore */ }
  return null;
}

/// 解析 LLM 响应中的工具调用：
/// 1. 优先匹配标准 <tool_call> JSON 块
/// 2. 匹配 DeepSeek DSML 原生 tool_call（deepseek 思考模式常输出此格式，name 字段）
/// 3. 匹配模型手写的伪卡片（### 🔧 调用工具：\`tool\` + 参数 JSON）
/// 4. 兼容模型直接输出裸 JSON（可能夹杂叙述文字，如"让我先查看允许访问的目录：{...}"）
export function parseToolCall(content: string): ToolCall | null {
  const tagMatch = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (tagMatch) {
    const parsed = parseJsonObject(tagMatch[1]);
    if (parsed) return parsed;
  }
  const dsmlMatch = content.match(DSML_TOOL_CALL_RE);
  if (dsmlMatch) {
    const parsed = parseJsonObject(dsmlMatch[1]);
    if (parsed) return parsed;
  }
  const fakeCard = parseFakeToolCard(content);
  if (fakeCard) return fakeCard;
  return extractToolCalls(content)[0] ?? null;
}

/// 把目录树/树状目录结果压缩成更易读的预览，保留层级结构，避免过长输出淹没 UI。
export function formatToolResultPreview(tool: string | undefined, result: string): string {
  const raw = (result ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "（空结果）";

  const lowerName = (tool || "").toLowerCase();
  const looksLikeTree =
    /^(?:【目录】|目录\s)/.test(raw) ||
    /(?:^|\n)[├└│─]/.test(raw) ||
    /(?:^|\n)[📁📄]/.test(raw) ||
    lowerName.includes("tree") ||
    lowerName.includes("dir");

  if (looksLikeTree) {
    const lines = raw
      .replace(/^【目录】.*?\n\n?/i, "")
      .split(/\n/)
      .map(line => line.trimEnd())
      .filter(line => line.length > 0)
      .slice(0, 24);

    if (lines.length === 0) return raw.slice(0, 300);
    const preview = lines.join("\n");
    return preview.length > 500 ? `${preview.slice(0, 500)}\n\n...(结果已截断)` : preview;
  }

  return raw.length > 400 ? `${raw.slice(0, 400)}\n\n...(结果已截断)` : raw;
}

/// 流式实时显示用：只保留第一个工具开标记之前的可见正文，其余（工具调用 JSON、
/// 及其后的内容）一律不显示。模型连续输出多个工具调用时，若直接 append 原始 content
/// 会把 <｜DSML｜tool_call｜> 这类开/闭合标记实时显示成"乱码"；
/// 这里保证工具标记及其后内容永远不进正文（工具执行后卡片会替换整段流式正文）。
/// 兼容：<tool_call> 标准格式、<｜DSML｜tool_call｜> DSML 格式（含 < 与 DSML 之间有
/// 全角/半角竖线的变体）、以及刚开头尚无 > 的半截（如 <｜DSML｜tool_）。
export function visibleText(raw: string): string {
  const open = raw.search(/<\s*[^<>]*(?:tool_call|DSML|tool)/i);
  const head = open === -1 ? raw : raw.slice(0, open);
  return head.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "").trim();
}

/// 从文本中剥离工具调用 JSON（<tool_call> / <tool_result> / DSML 块或含 tool/name 键的裸 JSON），
/// 用于流式输出兜底清理，避免模型把工具调用原样展示给用户。
export function stripToolJson(text: string): string {
  let t = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(DSML_TOOL_CALL_GLOBAL_RE, "")
    .trim();

  const re = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
  let m: RegExpExecArray | null;
  const toRemove: string[] = [];
  while ((m = re.exec(t)) !== null) {
    try {
      const p = JSON.parse(m[0]);
      const key = p && typeof p === "object" ? (p.tool || p.name) : undefined;
      if (typeof key === "string") {
        toRemove.push(m[0]);
      }
    } catch { /* ignore */ }
  }
  for (const s of toRemove) t = t.split(s).join("");
  // 清理行尾残留的冒号/句号，以及多余空行
  return t.replace(/[：:]\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
