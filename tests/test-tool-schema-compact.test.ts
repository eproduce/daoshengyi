import { it, expect, describe } from "vitest";
import {
  compactToolSchema,
  schemaChars,
  DEFAULT_SCHEMA_BUDGET_CHARS,
} from "../src/utils/tool-schema-compact.ts";

describe("compactToolSchema（大 schema 瘦身，吸收自 Codex json_schema/compaction）", () => {
  it("未超预算：原样返回（同一引用，不做无谓改写真）", () => {
    const s = {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    };
    expect(compactToolSchema(s)).toBe(s);
  });

  it("超预算：清理注释性字段（title/examples/default/$schema 等）", () => {
    const s = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "大工具",
      properties: {
        a: {
          type: "string",
          title: "A 参数",
          examples: ["x", "y"],
          default: "z",
          description: "这是一个描述",
        },
      },
      required: ["a"],
    };
    // 构造到超预算（塞一个超长 examples）
    (s.properties.a as Record<string, unknown>).examples = [
      "x".repeat(DEFAULT_SCHEMA_BUDGET_CHARS),
    ];
    const out = compactToolSchema(s) as Record<string, unknown>;
    expect(out.$schema).toBeUndefined();
    expect(out.title).toBeUndefined();
    const a = (out.properties as Record<string, unknown>).a as Record<string, unknown>;
    expect(a.examples).toBeUndefined();
    expect(a.default).toBeUndefined();
    expect(a.title).toBeUndefined();
    expect(a.type).toBe("string");
    expect(out.required).toEqual(["a"]);
  });

  it("超预算：深层嵌套折叠为 {type}（保类型语义、丢细节）", () => {
    const deep = {
      type: "object",
      properties: {
        cfg: {
          type: "object",
          description: "配置",
          properties: {
            inner: {
              type: "object",
              properties: { leaf: { type: "string", description: "y".repeat(6000) } },
            },
          },
        },
      },
    };
    const out = compactToolSchema(deep) as Record<string, unknown>;
    const cfg = (out.properties as Record<string, unknown>).cfg as Record<string, unknown>;
    const inner = (cfg.properties as Record<string, unknown>).inner as Record<string, unknown>;
    // depth>=2 → 折叠成 {type}
    expect(inner).toEqual({ type: "object" });
  });

  it("仍超预算：退化为「只保顶层参数面」（additionalProperties: true）", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      props[`p${i}`] = {
        type: "string",
        description: "d".repeat(DEFAULT_SCHEMA_BUDGET_CHARS / 100),
      };
    }
    const s = { type: "object", properties: props, required: ["p0"] };
    const out = compactToolSchema(s) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(true);
    expect(out.required).toEqual(["p0"]);
    // 顶层参数名必须全部保留（模型据此填参，不能丢）
    const outProps = out.properties as Record<string, unknown>;
    expect(Object.keys(outProps).length).toBe(200);
    expect((outProps.p7 as Record<string, unknown>).type).toBe("string");
  });

  it("枚举/必填等关键语义在顶层不被丢弃", () => {
    const s = {
      type: "object",
      properties: { mode: { type: "string", enum: ["a", "b"], description: "x".repeat(5000) } },
      required: ["mode"],
    };
    const out = compactToolSchema(s) as Record<string, unknown>;
    const mode = (out.properties as Record<string, unknown>).mode as Record<string, unknown>;
    expect(mode.enum).toEqual(["a", "b"]);
    expect(mode.type).toBe("string");
  });

  it("不改动原对象（纯函数）", () => {
    const s = {
      type: "object",
      properties: { big: { type: "string", examples: ["z".repeat(9000)] } },
    };
    const before = JSON.stringify(s);
    compactToolSchema(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("非对象/空 schema 直接返回，不抛异常", () => {
    expect(compactToolSchema(undefined)).toEqual({});
    expect(compactToolSchema({ type: "string" })).toEqual({ type: "string" });
    expect(schemaChars(undefined)).toBe(0);
  });
});
