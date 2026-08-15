/** ReAct 工具调用解析 */

export interface ToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

function parseJsonObject(s: string): ToolCall | null {
  try {
    const parsed = JSON.parse(s);
    if (parsed.tool && parsed.arguments && typeof parsed.tool === "string") {
      return { server: parsed.server || "default", tool: parsed.tool, arguments: parsed.arguments };
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

/// 解析 LLM 响应中的工具调用：
/// 1. 优先匹配标准 <tool_call> JSON 块
/// 2. 兼容模型直接输出裸 JSON（可能夹杂叙述文字，如"让我先查看允许访问的目录：{...}"）
export function parseToolCall(content: string): ToolCall | null {
  const tagMatch = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (tagMatch) {
    const parsed = parseJsonObject(tagMatch[1]);
    if (parsed) return parsed;
  }
  return extractToolCalls(content)[0] ?? null;
}
