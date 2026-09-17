/**
 * 极简 JSON Schema 校验（吸收自 DSH 生态 `dsh-tool-schema` / `dsh-toolkit` 的 schema 校验工具）。
 *
 * 为什么需要：模型经常「声称」自己产出的 JSON 符合某 schema，或用户给的 schema 与数据不匹配，
 * 靠模型逐字段肉眼比对极易漏项（尤其 required / 类型 / 枚举）。这里用确定性代码给出**精确错误路径**。
 *
 * 覆盖子集（够用且可解释）：type / enum / const / required / properties / additionalProperties /
 * items / minItems / maxItems / uniqueItems / minLength / maxLength / pattern / minimum / maximum /
 * exclusiveMinimum / exclusiveMaximum / multipleOf / anyOf / allOf / oneOf / not / nullable。
 * 不支持 $ref / format / if-then-else（遇到时忽略，不误报）。
 */

export interface SchemaIssue {
  /** JSON 指针式路径，如 $.user.tags[2] */
  path: string;
  message: string;
}

const MAX_DEPTH = 32;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(expect: string, v: unknown): boolean {
  const t = typeOf(v);
  if (expect === "number") return t === "number" || t === "integer";
  if (expect === "integer") return t === "integer";
  return t === expect;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** 校验数据是否符合 schema；返回全部错误（带路径），符合则返回空数组 */
export function validateJsonSchema(
  schema: unknown,
  data: unknown,
  path = "$",
  depth = 0,
): SchemaIssue[] {
  if (depth > MAX_DEPTH) return [{ path, message: "schema 嵌套过深，已停止校验" }];
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [{ path, message: "schema 为 false：此处不允许任何值" }];
  if (!isPlainObject(schema)) return [];

  const issues: SchemaIssue[] = [];
  const s = schema as Record<string, unknown>;

  // type（可为字符串或字符串数组）
  const nullable = s.nullable === true;
  if (typeof s.type === "string" || Array.isArray(s.type)) {
    const expects = (Array.isArray(s.type) ? s.type : [s.type]).filter(
      (x): x is string => typeof x === "string",
    );
    const ok = expects.some((e) => typeMatches(e, data)) || (nullable && data === null);
    if (!ok) {
      issues.push({ path, message: `期望类型 ${expects.join("|")}，实际为 ${typeOf(data)}` });
      return issues; // 类型都不对，后面的关键字判定无意义
    }
  }

  // enum / const
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).some((x) => deepEqual(x, data))) {
    issues.push({
      path,
      message: `取值必须是 ${(s.enum as unknown[]).map((x) => JSON.stringify(x)).join(" / ")} 之一，实际为 ${JSON.stringify(data)}`,
    });
  }
  if ("const" in s && !deepEqual(s.const, data)) {
    issues.push({ path, message: `取值必须等于 ${JSON.stringify(s.const)}` });
  }

  // 数值
  if (typeof data === "number") {
    const n = data;
    if (typeof s.minimum === "number" && n < s.minimum) {
      issues.push({ path, message: `不能小于 ${s.minimum}（实际 ${n}）` });
    }
    if (typeof s.maximum === "number" && n > s.maximum) {
      issues.push({ path, message: `不能大于 ${s.maximum}（实际 ${n}）` });
    }
    if (typeof s.exclusiveMinimum === "number" && n <= s.exclusiveMinimum) {
      issues.push({ path, message: `必须大于 ${s.exclusiveMinimum}（实际 ${n}）` });
    }
    if (typeof s.exclusiveMaximum === "number" && n >= s.exclusiveMaximum) {
      issues.push({ path, message: `必须小于 ${s.exclusiveMaximum}（实际 ${n}）` });
    }
    if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
      const q = n / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) {
        issues.push({ path, message: `必须是 ${s.multipleOf} 的整数倍（实际 ${n}）` });
      }
    }
  }

  // 字符串
  if (typeof data === "string") {
    if (typeof s.minLength === "number" && data.length < s.minLength) {
      issues.push({ path, message: `长度不能少于 ${s.minLength}（实际 ${data.length}）` });
    }
    if (typeof s.maxLength === "number" && data.length > s.maxLength) {
      issues.push({ path, message: `长度不能超过 ${s.maxLength}（实际 ${data.length}）` });
    }
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern).test(data)) {
          issues.push({ path, message: `不匹配正则 /${s.pattern}/` });
        }
      } catch {
        issues.push({ path, message: `schema 中的 pattern 非法：/${s.pattern}/` });
      }
    }
  }

  // 数组
  if (Array.isArray(data)) {
    if (typeof s.minItems === "number" && data.length < s.minItems) {
      issues.push({ path, message: `元素个数不能少于 ${s.minItems}（实际 ${data.length}）` });
    }
    if (typeof s.maxItems === "number" && data.length > s.maxItems) {
      issues.push({ path, message: `元素个数不能超过 ${s.maxItems}（实际 ${data.length}）` });
    }
    if (s.uniqueItems === true) {
      for (let i = 0; i < data.length; i++) {
        for (let j = i + 1; j < data.length; j++) {
          if (deepEqual(data[i], data[j])) {
            issues.push({ path: `${path}[${j}]`, message: `与 [${i}] 重复（uniqueItems）` });
            i = data.length;
            break;
          }
        }
      }
    }
    if (s.items !== undefined) {
      const items = s.items;
      data.forEach((item, idx) => {
        issues.push(...validateJsonSchema(items, item, `${path}[${idx}]`, depth + 1));
      });
    }
  }

  // 对象
  if (isPlainObject(data)) {
    const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!(key in data)) issues.push({ path, message: `缺少必需字段「${key}」` });
    }
    const props = isPlainObject(s.properties) ? (s.properties as Record<string, unknown>) : {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) {
        issues.push(...validateJsonSchema(sub, data[key], `${path}.${key}`, depth + 1));
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) issues.push({ path: `${path}.${key}`, message: "不允许的额外字段" });
      }
    } else if (isPlainObject(s.additionalProperties)) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) {
          issues.push(
            ...validateJsonSchema(s.additionalProperties, data[key], `${path}.${key}`, depth + 1),
          );
        }
      }
    }
  }

  // 组合关键字
  if (Array.isArray(s.allOf)) {
    (s.allOf as unknown[]).forEach((sub) => {
      issues.push(...validateJsonSchema(sub, data, path, depth + 1));
    });
  }
  if (Array.isArray(s.anyOf)) {
    const ok = (s.anyOf as unknown[]).some(
      (sub) => validateJsonSchema(sub, data, path, depth + 1).length === 0,
    );
    if (!ok)
      issues.push({
        path,
        message: `不满足 anyOf 中任何一个子 schema（共 ${(s.anyOf as unknown[]).length} 个）`,
      });
  }
  if (Array.isArray(s.oneOf)) {
    const hits = (s.oneOf as unknown[]).filter(
      (sub) => validateJsonSchema(sub, data, path, depth + 1).length === 0,
    ).length;
    if (hits !== 1)
      issues.push({ path, message: `oneOf 要求恰好满足 1 个子 schema，实际满足 ${hits} 个` });
  }
  if (s.not !== undefined && validateJsonSchema(s.not, data, path, depth + 1).length === 0) {
    issues.push({ path, message: "不应满足 not 指定的 schema" });
  }

  return issues;
}
