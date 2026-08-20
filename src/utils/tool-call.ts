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
/// 兼容全角竖线｜ / 半角竖线 | / 中间带空格等变体
const DSML_TOOL_CALL_RE =
  /<\s*[｜|]\s*DSML\s*[｜|]\s*tool_call\s*[｜|]\s*>\s*([\s\S]*?)\s*<\/\s*[｜|]\s*DSML\s*[｜|]\s*tool_call\s*[｜|]\s*>/;

/// 解析 LLM 响应中的工具调用：
/// 1. 优先匹配标准 <tool_call> JSON 块
/// 2. 匹配 DeepSeek DSML 原生 tool_call（deepseek 思考模式常输出此格式，name 字段）
/// 3. 兼容模型直接输出裸 JSON（可能夹杂叙述文字，如"让我先查看允许访问的目录：{...}"）
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

/// 从文本中剥离工具调用 JSON（<tool_call> / <tool_result> / DSML 块或含 tool/name 键的裸 JSON），
/// 用于流式输出兜底清理，避免模型把工具调用原样展示给用户。
export function stripToolJson(text: string): string {
  let t = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(DSML_TOOL_CALL_RE, "")
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
