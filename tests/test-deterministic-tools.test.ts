import { describe, it, expect } from "vitest";
import { evalExpression, runDeterministicTool, parseCsv } from "../src/utils/deterministic-tools.ts";

describe("calc：精确算术（不使用 eval）", () => {
  it("四则、括号、幂与优先级", () => {
    expect(evalExpression("(1+2)*3/4")).toBe(2.25);
    expect(evalExpression("2^10")).toBe(1024);
    expect(evalExpression("2**3")).toBe(8);
    expect(evalExpression("-2^2")).toBe(-4); // 幂优先于一元负号
    expect(evalExpression("7%3")).toBe(1);
    expect(evalExpression("1_000 + 2")).toBe(1002); // 千分位下划线
  });

  it("函数、常量与可变参数", () => {
    expect(evalExpression("sqrt(2)^2")).toBeCloseTo(2, 10);
    expect(evalExpression("round(3.14159,2)")).toBe(3.14);
    expect(evalExpression("min(3,5,1)")).toBe(1);
    expect(evalExpression("sum(1,2,3)")).toBe(6);
    expect(evalExpression("avg(2,4)")).toBe(3);
    expect(evalExpression("factorial(5)")).toBe(120);
    expect(evalExpression("gcd(12,18)")).toBe(6);
    expect(evalExpression("pi")).toBeCloseTo(Math.PI, 12);
  });

  it("错误输入给出可读报错（除零/未知函数/未知标识符/括号）", () => {
    expect(() => evalExpression("1/0")).toThrow(/除数不能为 0/);
    expect(() => evalExpression("foo(1)")).toThrow(/未知函数/);
    expect(() => evalExpression("bar + 1")).toThrow(/未知标识符/);
    expect(() => evalExpression("(1+2")).toThrow(/缺少右括号/);
  });

  it("工具输出带表达式与结果，可直接引用核对", async () => {
    const out = await runDeterministicTool("calc", { expression: "0.1+0.2", precision: 2 });
    expect(out).toContain("计算结果：0.30");
  });
});

describe("convert_unit：表驱动单位换算", () => {
  it("同类线性换算（含中文单位）", async () => {
    const speed = await runDeterministicTool("convert_unit", { value: 100, from: "km/h", to: "m/s" });
    expect(speed).toContain("27.77");
    const jin = await runDeterministicTool("convert_unit", { value: 1, from: "kg", to: "斤" });
    expect(jin).toContain("= 2 ");
    const mu = await runDeterministicTool("convert_unit", { value: 1, from: "公顷", to: "亩" });
    expect(mu).toContain("15");
  });

  it("bit / byte 区分大小写（b=bit，B=byte）", async () => {
    const r1 = await runDeterministicTool("convert_unit", { value: 1, from: "B", to: "bit" });
    expect(r1).toContain("= 8 bit");
    const r2 = await runDeterministicTool("convert_unit", { value: 1, from: "GiB", to: "MiB" });
    expect(r2).toContain("= 1024 MiB");
  });

  it("温度走特殊路径", async () => {
    const r = await runDeterministicTool("convert_unit", { value: 100, from: "C", to: "F" });
    expect(r).toContain("= 212 F");
    const back = await runDeterministicTool("convert_unit", { value: 32, from: "F", to: "C" });
    expect(back).toContain("= 0 C");
  });

  it("跨类别与未知单位拒绝并给出提示", async () => {
    await expect(runDeterministicTool("convert_unit", { value: 1, from: "kg", to: "m" })).rejects.toThrow(
      /不能直接换算/,
    );
    await expect(runDeterministicTool("convert_unit", { value: 1, from: "斤", to: "光年" })).rejects.toThrow(
      /未知单位/,
    );
  });

  it("list 模式列出全部单位", async () => {
    const out = await runDeterministicTool("convert_unit", { list: true });
    expect(out).toContain("长度");
    expect(out).toContain("温度");
  });
});

describe("time_convert：时区与日期差", () => {
  it("时区换算（Asia/Shanghai → UTC）", async () => {
    const out = await runDeterministicTool("time_convert", {
      action: "convert",
      time: "2026-03-01T09:30",
      from_tz: "Asia/Shanghai",
      to_tz: "UTC",
    });
    expect(out).toContain("2026-03-01T01:30:00.000Z");
    expect(out).toContain("UTC+08:00");
  });

  it("日期差与工作日折算", async () => {
    const out = await runDeterministicTool("time_convert", {
      action: "diff",
      from: "2026-01-01T00:00",
      to: "2026-01-03T12:00",
      from_tz: "UTC",
    });
    expect(out).toContain("2 天 12 小时");
    expect(out).toContain("工作日");
  });

  it("加时长", async () => {
    const out = await runDeterministicTool("time_convert", {
      action: "add",
      time: "2026-01-01T00:00",
      amount: 90,
      unit: "min",
      from_tz: "UTC",
      to_tz: "UTC",
    });
    expect(out).toContain("01:30");
  });

  it("非法时区/时间给出可读报错", async () => {
    await expect(
      runDeterministicTool("time_convert", { action: "convert", time: "2026-01-01T00:00", to_tz: "Mars/Base" }),
    ).rejects.toThrow(/未知时区/);
    await expect(
      runDeterministicTool("time_convert", { action: "convert", time: "下周三", from_tz: "UTC" }),
    ).rejects.toThrow(/无法识别/);
  });
});

describe("csv_query：解析、筛选、分组聚合", () => {
  const csv = "name,amount,city\nAlice,100,Shanghai\nBob,250,Beijing\nCara,50,Shanghai";

  it("CSV 解析支持引号与逗号转义", () => {
    const rows = parseCsv('a,b\n"x,1","y""2"\n');
    expect(rows[1]).toEqual(["x,1", 'y"2']);
  });

  it("筛选 + 排序 + 选列", async () => {
    const out = await runDeterministicTool("csv_query", {
      text: csv,
      where: { amount: { op: "gt", value: 60 } },
      sort_by: "amount",
      sort_desc: true,
      select: ["name", "amount"],
    });
    expect(out).toContain("命中 2 行");
    expect(out).toContain("Bob");
    expect(out.indexOf("Bob")).toBeLessThan(out.indexOf("Alice"));
  });

  it("分组聚合（sum / avg / count）", async () => {
    const out = await runDeterministicTool("csv_query", {
      text: csv,
      group_by: "city",
      agg: ["count", "sum:amount", "avg:amount"],
    });
    expect(out).toContain("共 2 组");
    expect(out).toContain("Shanghai");
    expect(out).toContain("150"); // 100 + 50
  });

  it("列画像模式", async () => {
    const out = await runDeterministicTool("csv_query", { text: csv, profile: true });
    expect(out).toContain("列画像");
    expect(out).toContain("去重值");
  });

  it("未知操作符给出可用清单", async () => {
    await expect(
      runDeterministicTool("csv_query", { text: csv, where: { amount: { op: "about", value: 1 } } }),
    ).rejects.toThrow(/不支持的操作符/);
  });
});

describe("json_query：路径取值与结构探查", () => {
  const json = JSON.stringify({ data: { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] } });

  it("路径取值（含数组下标与映射）", async () => {
    expect(await runDeterministicTool("json_query", { json, json_path: "data.items[1].name" })).toContain('"b"');
    const mapped = await runDeterministicTool("json_query", { json, json_path: "data.items[*].id" });
    expect(mapped).toContain("1");
    expect(mapped).toContain("2");
  });

  it("keys 模式列出结构；table 模式转表格", async () => {
    const keys = await runDeterministicTool("json_query", { json, keys: true });
    expect(keys).toContain("data");
    const table = await runDeterministicTool("json_query", { json, json_path: "data.items", table: true });
    expect(table).toContain("| id | name |");
  });

  it("未命中与非法 JSON 都有明确提示", async () => {
    expect(await runDeterministicTool("json_query", { json, json_path: "data.nope" })).toContain("未命中");
    await expect(runDeterministicTool("json_query", { json: "{oops" })).rejects.toThrow(/解析失败/);
  });
});

describe("regex_test：先验证再断言", () => {
  it("列出匹配位置、长度与分组", async () => {
    const out = await runDeterministicTool("regex_test", { pattern: "(\\d+)", text: "a1b22", max: 5 });
    expect(out).toContain("命中 2 处");
    expect(out).toContain("分组");
  });

  it("替换预览", async () => {
    const out = await runDeterministicTool("regex_test", { pattern: "\\d", text: "a1b2", replace: "#" });
    expect(out).toContain("替换预览");
    expect(out).toContain("a#b#");
  });

  it("非法正则报错；嵌套量词预警", async () => {
    await expect(runDeterministicTool("regex_test", { pattern: "(", text: "x" })).rejects.toThrow(/编译失败/);
    const warned = await runDeterministicTool("regex_test", { pattern: "(a+)+", text: "aa" });
    expect(warned).toContain("嵌套量词");
  });
});

describe("hash_encode：哈希与编解码", () => {
  it("sha256 已知向量", async () => {
    const out = await runDeterministicTool("hash_encode", { op: "sha256", input: "abc" });
    expect(out).toContain("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("base64 / hex / url 往返", async () => {
    expect(await runDeterministicTool("hash_encode", { op: "base64", input: "hello" })).toBe("aGVsbG8=");
    const b64 = await runDeterministicTool("hash_encode", { op: "base64", input: "中文 ok" });
    expect(await runDeterministicTool("hash_encode", { op: "base64_decode", input: b64 })).toBe("中文 ok");
    expect(await runDeterministicTool("hash_encode", { op: "hex", input: "hi" })).toBe("6869");
    expect(await runDeterministicTool("hash_encode", { op: "url_encode", input: "a b&c" })).toBe("a%20b%26c");
    expect(await runDeterministicTool("hash_encode", { op: "url_decode", input: "a%20b" })).toBe("a b");
  });

  it("uuid / random_hex 形态正确；未知 op 报错", async () => {
    const uuid = await runDeterministicTool("hash_encode", { op: "uuid" });
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await runDeterministicTool("hash_encode", { op: "random_hex", length: 8 })).toMatch(/^[0-9a-f]{16}$/);
    await expect(runDeterministicTool("hash_encode", { op: "md5", input: "x" })).rejects.toThrow(/不支持的 op/);
  });
});

describe("stats_describe：统计、离群与回归", () => {
  it("描述统计与 IQR 离群", async () => {
    const out = await runDeterministicTool("stats_describe", { values: [1, 2, 3, 4, 100] });
    expect(out).toContain("样本数：5");
    expect(out).toContain("中位数：3");
    expect(out).toContain("IQR 离群");
    expect(out).toContain("100");
  });

  it("两组数据的相关与线性回归", async () => {
    const out = await runDeterministicTool("stats_describe", { values: [1, 2, 3], values2: [2, 4, 6] });
    expect(out).toContain("皮尔逊相关系数 r：1.000000");
    expect(out).toContain("y = 2.000000x + 0.000000");
  });

  it("从文本解析并跳过非数值；空输入报错", async () => {
    const out = await runDeterministicTool("stats_describe", { text: "1 2 abc 3\n4" });
    expect(out).toContain("样本数：4");
    expect(out).toContain("已跳过 1 个非数值项");
    await expect(runDeterministicTool("stats_describe", { text: "a b c" })).rejects.toThrow(/没有解析到任何数值/);
  });
});

describe("diff_text 与 schema_validate", () => {
  it("unified diff 带统计与区段头", async () => {
    const out = await runDeterministicTool("diff_text", { a: "a\nb\nc", b: "a\nB\nc" });
    expect(out).toContain("+1 行 / -1 行");
    expect(out).toContain("@@");
    expect(out).toContain("-b");
    expect(out).toContain("+B");
  });

  it("相同文本明确标注无差异", async () => {
    const out = await runDeterministicTool("diff_text", { a: "x", b: "x" });
    expect(out).toContain("完全一致");
  });

  it("schema 校验给出精确路径；通过时明确告知", async () => {
    const schema = JSON.stringify({
      type: "object",
      required: ["name", "age"],
      properties: { name: { type: "string" }, age: { type: "number", minimum: 0 } },
      additionalProperties: false,
    });
    const bad = await runDeterministicTool("schema_validate", {
      schema,
      data: { name: 1, age: -2, extra: true },
    });
    expect(bad).toContain("校验失败，共 3 处问题");
    expect(bad).toContain("$.name");
    expect(bad).toContain("$.age");
    expect(bad).toContain("$.extra");

    const ok = await runDeterministicTool("schema_validate", { schema, data: { name: "x", age: 1 } });
    expect(ok).toContain("校验通过");
  });

  it("枚举与 anyOf", async () => {
    const schema = JSON.stringify({ anyOf: [{ enum: ["a"] }, { type: "number", minimum: 10 }] });
    expect(await runDeterministicTool("schema_validate", { schema, data: "a" })).toContain("校验通过");
    expect(await runDeterministicTool("schema_validate", { schema, data: 5 })).toContain("不满足 anyOf");
  });
});
