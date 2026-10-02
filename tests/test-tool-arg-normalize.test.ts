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

    // 改名只在「schema 声明了该规范名」时发生（见下方「无 schema 不改名」用例）
    const edit = normalizeToolArgs(
      { path: "a.ts", old_string: "x", new_string: "y" },
      schemaOf("replace_string"),
    );
    expect(edit.args.old_text).toBe("x");
    expect(edit.args.new_text).toBe("y");
  });

  // 回归（2026-10-02）：ALIASES 里混着别的工具的**规范参数名**（script→command、
  // value→input、text→data…）。无 schema 时（历史上 list_directory / read_multiple_files
  // 就是这样）全量改名会把模型给对的参数改名甚至删掉 → 静默改坏调用。
  it("没有 schema 时只做包裹展开，绝不改名 / 不做类型纠正", () => {
    const a = normalizeToolArgs({ selector: "#x", value: "hi" });
    expect(a.args.value).toBe("hi");
    expect(a.args.input).toBeUndefined();

    const b = normalizeToolArgs({ script: "1 + 1" });
    expect(b.args.script).toBe("1 + 1");
    expect(b.args.command).toBeUndefined();

    const c = normalizeToolArgs({ path: "/tmp/a", old_string: "x" });
    expect(c.args.path).toBe("/tmp/a");
    expect(c.args.old_text).toBeUndefined();

    // 类型纠正同样需要 schema 才做（"5" 保持字符串）
    const d = normalizeToolArgs({ seconds: "5" });
    expect(d.args.seconds).toBe("5");

    // 但包裹展开与 schema 无关，仍然照做
    const e = normalizeToolArgs({ arguments: { path: "/tmp/x" } });
    expect(e.args.path).toBe("/tmp/x");
    expect(e.notes.join()).toContain("包裹参数");

    // 给了 schema 就按 schema 改名（这是设计意图，别被上一条规则误伤）
    const f = normalizeToolArgs(
      { value: "hi" },
      { type: "object", properties: { input: { type: "string" } } },
    );
    expect(f.args.input).toBe("hi");
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

  // 回归：模型常照抄 OpenAI function-call 的形状，把工具名与参数平铺在一起。
  // 以前只在「只有包裹键」时展开 → 这种调用直接报「run_command 需要 command 参数」
  // （2026-10-02 实战日志里 run_command / write_file 各踩一次）。
  it("包裹键 + 工具身份元数据（name/tool/server）也要展开", () => {
    const r = normalizeToolArgs(
      { name: "run_command", arguments: { command: "ls -la" } },
      schemaOf("run_command"),
    );
    expect(r.args.command).toBe("ls -la");
    expect(r.args.name).toBeUndefined();
    expect(r.notes.join()).toContain("包裹参数");

    const withServer = normalizeToolArgs({
      server: "app",
      tool: "write_file",
      arguments: { path: "/tmp/a.txt", content: "x" },
    });
    expect(withServer.args.path).toBe("/tmp/a.txt");

    // 语义不够强的包裹键（input/params/args 可能就是某个工具的正常参数名）不因元数据放宽
    const keepInput = normalizeToolArgs({ input: { a: 1 }, name: "x" });
    expect(keepInput.args.input).toEqual({ a: 1 });

    // 同级出现非元数据键 → 视为正常嵌套，绝不展开
    const keepMode = normalizeToolArgs({ arguments: { a: 1 }, mode: "x" });
    expect(keepMode.args.arguments).toEqual({ a: 1 });
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
