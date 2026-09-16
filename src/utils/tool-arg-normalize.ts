/**
 * 工具调用参数「自愈」（吸收自 DSH 生态的 dsh-tool-normalizer：实测把可见调用错误率
 * 从 7.95% 降到 2.20%）。
 *
 * 模型犯错的三类高频形态，都不该让整个调用失败：
 * 1) **参数名不同写法**：`file_path` / `filepath` / `filename` 其实是 `path`；`cmd` 是 `command`；
 *    `old_string` 是 `old_text`……（模型训练语料里各家工具名混在一起）
 * 2) **类型不对**：schema 要 number 却给 `"10"`；要 boolean 却给 `"true"`/`1`；要 array 却给
 *    `"a,b"`；要 string 却给了数组。
 * 3) **嵌套包了一层**：把参数放进 `arguments` / `params` / `input` 里。
 *
 * 原则：**只在规范参数缺失时**才做映射（绝不覆盖模型给对的值）；无法确定的一律保持原样，
 * 让下游照常报错（宁可明确失败，也不要静默猜错语义）。
 * 纯函数、零依赖、可测试。
 */

export interface NormalizeResult {
  args: Record<string, unknown>;
  /** 做过哪些修正（供调试日志/审计，不注入模型上下文，避免噪声） */
  notes: string[];
}

/** 常见别名 → 规范参数名（按工具族分组，多组可叠加） */
const ALIASES: Record<string, string[]> = {
  path: ["file_path", "filepath", "filename", "file", "file_name", "dir_path", "directory", "folder", "target_path", "abs_path"],
  content: ["file_content", "body", "text_content", "contents"],
  old_text: ["old_string", "old_str", "search", "find", "from_text", "before"],
  new_text: ["new_string", "new_str", "replace", "replacement", "to_text", "after"],
  anchor: ["anchor_text", "insert_after", "insert_before"],
  command: ["cmd", "shell_command", "script", "exec", "command_line"],
  cwd: ["workdir", "working_directory", "working_dir", "work_dir"],
  url: ["uri", "link", "href", "address"],
  query: ["q", "keyword", "keywords", "search_query", "text_query"],
  selector: ["css", "css_selector", "element_selector"],
  expression: ["expr", "formula", "math", "calculation"],
  pattern: ["regex", "regexp", "re", "pattern_text"],
  input: ["value", "text", "data"],
  kb_name: ["knowledge_base", "kb", "knowledgebase"],
  root: ["project_path", "project_dir", "repo_path", "repository"],
  offset: ["start", "start_offset", "from_index"],
  length: ["limit", "size", "count", "max_length"],
  seconds: ["duration", "wait", "timeout_seconds"],
  patch: ["diff", "patch_text"],
  json_path: ["jsonpath", "jmespath", "query_path", "pointer"],
  values: ["numbers", "nums", "data_points", "samples"],
  schema: ["json_schema"],
};

/** 包裹层：模型有时把参数整体塞进一层 */
const WRAPPER_KEYS = ["arguments", "params", "parameters", "input", "tool_input", "args"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 展开包裹层（只在最外层只含包裹键 + 少量元数据时展开，避免误伤正常嵌套） */
function unwrap(args: Record<string, unknown>): { args: Record<string, unknown>; wrapped: boolean } {
  for (const key of WRAPPER_KEYS) {
    const inner = args[key];
    if (isPlainObject(inner)) {
      const rest = Object.keys(args).filter((k) => k !== key);
      if (rest.length === 0) return { args: inner, wrapped: true };
    }
  }
  return { args, wrapped: false };
}

function coerce(value: unknown, schema: Record<string, unknown> | undefined): { value: unknown; changed: boolean } {
  if (!schema) return { value, changed: false };
  const type = schema.type;
  if (typeof type !== "string") {
    // 联合类型（如 ["string","null"]）：能原样通过就不动
    return { value, changed: false };
  }
  if (type === "number" || type === "integer") {
    if (typeof value === "number") return { value, changed: false };
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      const n = Number(value);
      return { value: type === "integer" ? Math.trunc(n) : n, changed: true };
    }
    return { value, changed: false };
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return { value, changed: false };
    if (value === "true" || value === 1) return { value: true, changed: true };
    if (value === "false" || value === 0) return { value: false, changed: true };
    return { value, changed: false };
  }
  if (type === "array") {
    if (Array.isArray(value)) return { value, changed: false };
    if (typeof value === "string" && value.trim() !== "") {
      return { value: value.split(",").map((x) => x.trim()).filter(Boolean), changed: true };
    }
    return { value, changed: false };
  }
  if (type === "string") {
    if (typeof value === "string") return { value, changed: false };
    if (typeof value === "number" || typeof value === "boolean") return { value: String(value), changed: true };
    if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
      return { value: value.join("\n"), changed: true };
    }
  }
  return { value, changed: false };
}

/**
 * 规范化一次工具调用的参数。
 * @param args  模型给出的原始参数
 * @param schema 该工具的 JSON Schema（内置工具传 BUILTIN_PARAMETERS[tool]）
 */
export function normalizeToolArgs(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): NormalizeResult {
  const notes: string[] = [];
  let current = isPlainObject(args) ? { ...args } : {};

  const unwrapped = unwrap(current);
  if (unwrapped.wrapped) {
    current = { ...unwrapped.args };
    notes.push("展开了一层包裹参数（arguments/params/input）");
  }

  const props = isPlainObject(schema?.properties) ? (schema.properties as Record<string, unknown>) : undefined;
  const allowed = props ? new Set(Object.keys(props)) : undefined;

  // 1) 别名映射：仅当规范名缺失时生效
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (allowed && !allowed.has(canonical)) continue;
    if (current[canonical] !== undefined && current[canonical] !== null) continue;
    for (const alias of aliases) {
      const v = current[alias];
      if (v === undefined || v === null || v === "") continue;
      current[canonical] = v;
      delete current[alias];
      notes.push(`参数改名：${alias} → ${canonical}`);
      break;
    }
  }

  // 2) 类型纠正（按 schema）：只修上层类型明显不符的字段
  if (props) {
    for (const [key, rawSchema] of Object.entries(props)) {
      if (!isPlainObject(rawSchema)) continue;
      const v = current[key];
      if (v === undefined || v === null) continue;
      const fixed = coerce(v, rawSchema);
      if (fixed.changed) {
        current[key] = fixed.value;
        notes.push(`参数类型纠正：${key} → ${String(rawSchema.type)}`);
      }
    }
    // 3) 丢弃未知的、明显是别家工具留下的空壳键（值为 undefined/null 的额外键）
    if (schema?.additionalProperties === false) {
      for (const key of Object.keys(current)) {
        if (!allowed?.has(key) && (current[key] === undefined || current[key] === null)) {
          delete current[key];
          notes.push(`移除空参数：${key}`);
        }
      }
    }
  }

  return { args: current, notes };
}
