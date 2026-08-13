/** ReAct 工具调用解析 */

export interface ToolCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/// 解析 LLM 响应中的 <tool_call> JSON 块
export function parseToolCall(content: string): ToolCall | null {
  const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.tool && parsed.arguments) {
      return { server: parsed.server || "default", tool: parsed.tool, arguments: parsed.arguments };
    }
  } catch { /* ignore */ }
  return null;
}
