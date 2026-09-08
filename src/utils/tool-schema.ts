// 原生 function calling 工具 schema 构造（Stage 2 核心）。
// 把「内置工具 + MCP 工具」映射成 OpenAI `tools` 数组 + 名字反向映射：
// - 每个可执行工具得到唯一、ASCII 合法（^[A-Za-z0-9_-]{1,64}$）的函数名；
// - 模型流式返回 `function.name` 后，用 byName 反查回 {server, tool} 交给执行器。
// 纯函数、无副作用，便于单元测试。

import { BUILTIN_PARAMETERS } from "../data/builtin-params.ts";

export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 一个可执行工具（server="app" 表示内置；否则为 MCP 服务器名） */
export interface NativeToolSource {
  server: string;
  name: string;
  description: string;
  /** MCP 服务器自带的 JSON schema；内置工具无此字段 */
  inputSchema?: Record<string, unknown>;
  kind: "builtin" | "mcp";
}

/** 由函数名反查回的执行目标 */
export interface NativeToolRef {
  server: string;
  tool: string;
  kind: "builtin" | "mcp";
}

export interface NativeToolRegistry {
  /** 发给模型的 OpenAI tools 数组 */
  tools: OpenAIFunctionTool[];
  /** 函数名 → {server, tool} 反向映射 */
  byName: Map<string, NativeToolRef>;
}

/** 单次请求最多声明的工具数：优先保证内置，MCP 截尾 */
export const MAX_NATIVE_TOOLS = 80;

/** 未收录显式 schema 时的兜底参数（宽松对象，配合描述文本中的参数示例） */
export const GENERIC_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/** 名字片段清洗：只保留 [A-Za-z0-9_-]，中文服务器名清洗后可能为空 → 返回 fallback */
export function sanitizeNamePart(s: string, fallback = "mcp"): string {
  const slug = s
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return slug || fallback;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidNativeName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * 解析模型返回的 `function.arguments` JSON 字符串为参数对象。
 * 原生 function calling 返回的 arguments 是字符串，可能为 ""/非法 JSON/非对象
 * （模型偶发）→ 一律容错回退空对象，绝不让解析异常打断工具执行。
 * 主代理 handleNativeRound 与子代理 runSubagentLoop 共用。
 */
export function parseNativeArguments(jsonStr?: string | null): Record<string, unknown> {
  if (!jsonStr) return {};
  const t = jsonStr.trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 候选名唯一化：保证最终名 ≤64 且 ASCII 合法。
 * 超长（>60）先截断基名（函数名上限 64、留 "_N" 后缀空间）；被占用则追加 _2/_3/...。 */
function ensureUnique(base: string, used: Set<string>): string {
  const cap = 60;
  const trimmed = base.length > cap ? base.slice(0, cap) : base;
  if (!used.has(trimmed)) return trimmed;
  let n = 2;
  while (used.has(`${trimmed}_${n}`)) n++;
  return `${trimmed}_${n}`;
}

/** 内置工具的参数：优先显式 schema（BUILTIN_PARAMETERS），缺省用宽松兜底 */
export function builtinParameters(name: string): Record<string, unknown> {
  const p = BUILTIN_PARAMETERS[name];
  return p ? p : GENERIC_PARAMETERS;
}

function toolDescription(server: string, desc: string): string {
  const prefix = server === "app" ? "（内置工具，server=app）" : `（MCP 服务器「${server}」）`;
  return `${desc}${prefix}`;
}

export interface BuildNativeRegistryOptions {
  /** 内置工具（BUILTIN_TOOLS 或其子集，按给定顺序优先保留） */
  builtins: { name: string; desc: string }[];
  /** MCP 工具（来自 mcpToolsCache），可能为空 */
  mcp?: NativeToolSource[];
  /** 可选：内置工具白名单（如角色工具集约束）；未提供则全部内置 */
  allowedBuiltin?: Set<string>;
  /** 单次请求最大工具数（默认 MAX_NATIVE_TOOLS） */
  maxTools?: number;
}

/**
 * 构建原生 function calling 工具注册表。
 * 命名规则：
 * - 内置工具直接用其名（如 `create_file`）；
 * - MCP 工具先用其名（通常全局唯一，如 `puppeteer_navigate`）；与内置/先前冲突时
 *   加服务器 slug 前缀（如 `filesystem_list_dir`），仍冲突再追加序号。
 *   这样**内置优先**：即便某 MCP 也有同名 `write_file`，模型调用 `write_file` 走的也是内置。
 */
export function buildNativeToolRegistry(opts: BuildNativeRegistryOptions): NativeToolRegistry {
  const maxTools = opts.maxTools ?? MAX_NATIVE_TOOLS;
  const tools: OpenAIFunctionTool[] = [];
  const byName = new Map<string, NativeToolRef>();
  const used = new Set<string>();

  const push = (src: NativeToolSource, base: string) => {
    if (tools.length >= maxTools) return; // 截尾（内置在前，MCP 在后被截）
    const name = ensureUnique(base, used);
    used.add(name);
    const params =
      src.kind === "builtin"
        ? builtinParameters(src.name)
        : src.inputSchema && src.inputSchema.type === "object"
          ? src.inputSchema
          : GENERIC_PARAMETERS;
    tools.push({
      type: "function",
      function: {
        name,
        description: toolDescription(src.server, src.description),
        parameters: params,
      },
    });
    byName.set(name, { server: src.server, tool: src.name, kind: src.kind });
  };

  // 1) 内置工具（可被角色白名单过滤）
  const allow = opts.allowedBuiltin;
  for (const b of opts.builtins) {
    if (allow && !allow.has(b.name)) continue;
    push({ server: "app", name: b.name, description: b.desc, kind: "builtin" }, b.name);
  }
  // 2) MCP 工具
  const mcpList = opts.mcp ?? [];
  for (const m of mcpList) {
    // 与内置/先前同名冲突 → 用服务器 slug 前缀消歧（服务器名可能是中文，需清洗）
    const serverSlug = sanitizeNamePart(m.server);
    const base = used.has(m.name) ? `${serverSlug}_${m.name}` : m.name;
    push(m, base);
  }
  return { tools, byName };
}

/** 已知明确支持原生 function calling 的端点域名关键字；未知端点保守起见不开原生 */
export function supportsNativeTools(baseUrl: string): boolean {
  const u = (baseUrl || "").toLowerCase();
  return (
    u.includes("deepseek") ||
    u.includes("openai") ||
    u.includes("openrouter") ||
    u.includes("moonshot") ||
    u.includes("dashscope") ||
    u.includes("zhipu") ||
    u.includes("bigmodel") ||
    u.includes("qwen") ||
    u.includes("siliconflow") ||
    u.includes("volces") ||
    u.includes("anthropic")
  );
}
