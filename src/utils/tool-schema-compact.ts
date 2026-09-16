// 工具 schema 瘦身（吸收自 Codex 的 `tools/json_schema/compaction.rs`）：
// Codex 的做法是「多轮、逐步有损、优先保住顶层参数面」——先做清洗/裁剪，
// 仍超预算就越来越激进地丢细节。我们照同一思路落地，解决 MCP 服务器
// 返回巨型 inputSchema（数千字符、深层嵌套）时挤爆 tools 预算的问题。
//
// 纯函数、确定性（同样输入必得同样输出），便于单测。

/** 工具 schema 的字符预算（超过就走瘦身；Codex 亦有类似 budget 概念） */
export const DEFAULT_SCHEMA_BUDGET_CHARS = 4000;
/** 超过该深度的嵌套对象整体折叠为 `{type}` */
const MAX_KEEP_DEPTH = 2;
/** 描述保留长度（深层描述对模型价值低，截断即可） */
const DESC_KEEP_CHARS = 120;

/** schema 的序列化长度（统一用 JSON.stringify 长度做预算判断，稳定可测） */
export function schemaChars(schema: unknown): number {
  if (schema === null || schema === undefined) return 0;
  try {
    return JSON.stringify(schema).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function truncateDesc(v: unknown): unknown {
  if (typeof v !== "string") return v;
  return v.length > DESC_KEEP_CHARS ? `${v.slice(0, DESC_KEEP_CHARS)}…` : v;
}

/** 只保留「参数面」的关键键，丢掉对模型无用的注释性/巨量字段 */
const DROP_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "examples",
  "example",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * 递归瘦身一个 schema 节点。
 * - `depth >= MAX_KEEP_DEPTH` 的对象/数组一律折叠为 `{ type }`（保住类型语义，丢掉细节）；
 * - 深层 `description` 截断；（顶层保留完整描述，因为那是模型选参数的依据）
 */
function shrink(node: unknown, depth: number): unknown {
  if (Array.isArray(node)) return node.map((x) => shrink(x, depth + 1));
  if (typeof node !== "object" || node === null) return node;
  const src = node as Record<string, unknown>;
  const type = typeof src.type === "string" ? (src.type as string) : undefined;
  if (depth >= MAX_KEEP_DEPTH) {
    return type ? { type } : {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === "description") {
      out[k] = depth === 0 ? v : truncateDesc(v);
      continue;
    }
    if (k === "properties" && typeof v === "object" && v !== null) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = shrink(pv, depth + 1);
      }
      out.properties = props;
      continue;
    }
    if (k === "items" || k === "additionalProperties" || k === "not") {
      out[k] = typeof v === "object" && v !== null ? shrink(v, depth + 1) : v;
      continue;
    }
    if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      out[k] = Array.isArray(v) ? v.map((x) => shrink(x, depth + 1)) : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 最后一轮：只留顶层参数名 + 类型（保 `required`），其余全部放弃 */
function keepTopLevelSurface(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const surface: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const t = (v as Record<string, unknown> | null)?.type;
    const d = (v as Record<string, unknown> | null)?.description;
    surface[k] = t ? { type: t, ...(typeof d === "string" ? { description: truncateDesc(d) } : {}) } : {};
  }
  const out: Record<string, unknown> = { type: "object", properties: surface };
  if (Array.isArray(schema.required)) out.required = schema.required;
  out.additionalProperties = true;
  return out;
}

/**
 * 按预算压缩工具 schema。多轮逐步有损（对齐 Codex 的 escalation 思路）：
 * ① 清洗 + 限深 + 描述截断 → ② 仍超预算则只保顶层参数面（`additionalProperties: true`）。
 * 返回原 schema 的压缩副本（不改原对象）。
 */
export function compactToolSchema(
  schema: Record<string, unknown> | undefined,
  budgetChars = DEFAULT_SCHEMA_BUDGET_CHARS,
): Record<string, unknown> {
  if (!schema || schema.type !== "object") return schema ?? {};
  if (schemaChars(schema) <= budgetChars) return schema; // 不超预算：原样使用
  const pass1 = shrink(schema, 0) as Record<string, unknown>;
  if (schemaChars(pass1) <= budgetChars) return pass1;
  return keepTopLevelSurface(pass1);
}
