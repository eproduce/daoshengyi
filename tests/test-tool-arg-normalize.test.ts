import { describe, it, expect } from "vitest";
import { normalizeToolArgs } from "../src/utils/tool-arg-normalize.ts";
import { BUILTIN_PARAMETERS } from "../src/data/builtin-params.ts";

const schemaOf = (tool: string): Record<string, unknown> | undefined => BUILTIN_PARAMETERS[tool];

describe("tool-arg-normalize：参数名自愈", () => {
  it("file_path / filepath / filename → path（仅当 path 缺失）", () => {
    for (const alias of ["file_path", "filepath", "filename", "file"]) {
      const r = normalizeToolArgs({ [alias]: "/tmp/a.txt" }, schemaOf("read_file"));
      expect(r.args.path).toBe("/tmp/a.txt");
      expect(r.notes.join()).toContain("→ path");
    }
  });

  it("cmd → command、old_string/new_string → old_text/new_text", () => {
    const cmd = normalizeToolArgs({ cmd: "ls -la" }, schemaOf("run_command"));
    expect(cmd.args.command).toBe("ls -la");

    const edit = normalizeToolArgs({ path: "a.ts", old_string: "x", new_string: "y" });
    expect(edit.args.old_text).toBe("x");
    expect(edit.args.new_text).toBe("y");
  });

  it("绝不覆盖模型已经给对的规范参数", () => {
    const r = normalizeToolArgs({ path: "/right", file_path: "/wrong" }, schemaOf("read_file"));
    expect(r.args.path).toBe("/right");
    expect(r.notes).toEqual([]);
  });

  it("read_file 分段参数的常见别名 → offset/length", () => {
    // 真实使用里模型会换着写法传行号/行数；schema 缺了就别让它变成“读了但没读到”
    const a = normalizeToolArgs({ path: "a.ts", start_line: 60, lines: 20 }, schemaOf("read_file"));
    expect(a.args.offset).toBe(60);
    expect(a.args.length).toBe(20);

    const b = normalizeToolArgs({ path: "a.ts", start: 5, count: 3 }, schemaOf("read_file"));
    expect(b.args.offset).toBe(5);
    expect(b.args.length).toBe(3);

    // 规范参数在场时不覆盖
    const c = normalizeToolArgs({ path: "a.ts", offset: 1, start_line: 99 }, schemaOf("read_file"));
    expect(c.args.offset).toBe(1);
  });

  it("展开一层包裹参数（arguments / params / input）", () => {
    const r = normalizeToolArgs({ arguments: { path: "/tmp/x" } }, schemaOf("read_file"));
    expect(r.args.path).toBe("/tmp/x");
    expect(r.notes.join()).toContain("包裹参数");

    // 与其它键共存时不展开（避免误伤正常结构）
    const keep = normalizeToolArgs({ arguments: { a: 1 }, mode: "x" });
    expect(keep.args.arguments).toEqual({ a: 1 });
  });
});

describe("tool-arg-normalize：类型自愈", () => {
  it("字符串数字 → number/integer", () => {
    const r = normalizeToolArgs({ seconds: "5" }, schemaOf("sleep"));
    expect(r.args.seconds).toBe(5);
    const ctx = normalizeToolArgs(
      { context: "2", a: "b" },
      { type: "object", properties: { context: { type: "integer" } } },
    );
    expect(ctx.args.context).toBe(2);
  });

  it("字符串布尔 → boolean", () => {
    const r = normalizeToolArgs({ sort_desc: "true" }, schemaOf("csv_query"));
    expect(r.args.sort_desc).toBe(true);
    const off = normalizeToolArgs({ profile: "false" }, schemaOf("csv_query"));
    expect(off.args.profile).toBe(false);
  });

  it("逗号串 → 数组（select / agg）", () => {
    const r = normalizeToolArgs({ select: "name, amount" }, schemaOf("csv_query"));
    expect(r.args.select).toEqual(["name", "amount"]);
  });

  it("数组 → 字符串（不应崩，按行合并）", () => {
    const r = normalizeToolArgs({ content: ["a", "b"] }, schemaOf("write_file"));
    expect(r.args.content).toBe("a\nb");
  });

  it("无法确定的类型保持原样（宁可明确失败，不要静默猜错）", () => {
    const r = normalizeToolArgs({ seconds: "一会儿" }, schemaOf("sleep"));
    expect(r.args.seconds).toBe("一会儿");
    expect(r.notes).toEqual([]);
  });
});

describe("tool-arg-normalize：边界", () => {
  it("空参数/非对象参数安全返回", () => {
    expect(normalizeToolArgs({}).args).toEqual({});
    expect(normalizeToolArgs({}).notes).toEqual([]);
    // 运行时可能收到 null（模型给了空 arguments 字符串）
    const r = normalizeToolArgs(null as unknown as Record<string, unknown>);
    expect(r.args).toEqual({});
  });

  it("只在 schema 允许时做别名映射（防止给某个工具塞入它不认识的参数）", () => {
    // browser_click 只有 selector，不该把 path 类别名塞进去
    const r = normalizeToolArgs({ file_path: "/tmp/x" }, schemaOf("browser_click"));
    expect(r.args.file_path).toBe("/tmp/x");
    expect(r.args.path).toBeUndefined();
  });

  it("真实场景：模型把 json 查询写成 jmespath", () => {
    const r = normalizeToolArgs({ json: '{"a":1}', jmespath: "a" }, schemaOf("json_query"));
    expect(r.args.json_path).toBe("a");
  });
});
