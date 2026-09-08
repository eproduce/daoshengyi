import { it, expect } from "vitest";
import { BUILTIN_TOOLS } from "../src/data/builtin-tools.ts";
import {
  buildNativeToolRegistry,
  supportsNativeTools,
  isValidNativeName,
  sanitizeNamePart,
  parseNativeArguments,
  GENERIC_PARAMETERS,
} from "../src/utils/tool-schema.ts";

const builtins = BUILTIN_TOOLS.map((t) => ({ name: t.name, desc: t.desc }));

it("内置工具生成的名字全部 ASCII 合法且唯一，且能反查回 app/server", () => {
  const reg = buildNativeToolRegistry({ builtins });
  expect(reg.tools.length).toBe(builtins.length);
  expect(reg.byName.size).toBe(builtins.length);
  for (const t of reg.tools) {
    expect(isValidNativeName(t.function.name)).toBe(true); // 名字合法
  }
  // 内置名 = 工具原名
  expect(reg.byName.get("create_file")).toEqual({
    server: "app",
    tool: "create_file",
    kind: "builtin",
  });
  expect(reg.byName.get("write_file")).toEqual({
    server: "app",
    tool: "write_file",
    kind: "builtin",
  });
});

it("显式参数 schema：write_file 必须 path/content，未收录工具走宽松兜底", () => {
  const reg = buildNativeToolRegistry({ builtins });
  const wf = reg.tools.find((t) => t.function.name === "write_file")!;
  const props = wf.function.parameters.properties as Record<string, unknown>;
  expect(props.path).toBeTruthy();
  expect(props.content).toBeTruthy();
  expect(wf.function.parameters.required).toEqual(["path", "content"]);
  // workflow_list 无参数，schema 也要是合法 object
  const wl = reg.tools.find((t) => t.function.name === "workflow_list")!;
  expect(wl.function.parameters.type).toBe("object");
});

it("MCP 工具：inputSchema 直接作为 parameters；无 schema 走宽松兜底", () => {
  const mcp: {
    server: string;
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    kind: "builtin" | "mcp";
  }[] = [
    {
      server: "浏览器自动化",
      name: "puppeteer_navigate",
      description: "打开网页",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      kind: "mcp",
    },
    {
      server: "浏览器自动化",
      name: "puppeteer_screenshot",
      description: "截图（无 schema）",
      kind: "mcp",
    },
  ];
  const reg = buildNativeToolRegistry({ builtins, mcp });
  const nav = reg.tools.find((t) => t.function.name === "puppeteer_navigate")!;
  expect(nav.function.parameters).toEqual({
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  });
  // 名称无冲突 → 保留原名，能反查回 MCP 服务器
  expect(reg.byName.get("puppeteer_navigate")).toEqual({
    server: "浏览器自动化",
    tool: "puppeteer_navigate",
    kind: "mcp",
  });
  const shot = reg.tools.find((t) => t.function.name === "puppeteer_screenshot")!;
  expect(shot.function.parameters).toEqual(GENERIC_PARAMETERS);
});

it("内置优先：MCP 与内置同名时被加服务器前缀消歧，两工具并存且可反查", () => {
  const mcp: {
    server: string;
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    kind: "builtin" | "mcp";
  }[] = [
    {
      server: "文件系统",
      name: "write_file",
      description: "MCP 写文件（不应被优先使用）",
      kind: "mcp",
    },
  ];
  const reg = buildNativeToolRegistry({ builtins, mcp });
  // 内置 write_file 保留原名
  expect(reg.byName.has("write_file")).toBe(true);
  expect(reg.byName.get("write_file")!.kind).toBe("builtin");
  // MCP 同名 → 服务器 slug 前缀名，仍可反查回原服务器
  const mcpNames = [...reg.byName.entries()].filter(
    ([, ref]) => ref.server === "文件系统" && ref.tool === "write_file",
  );
  expect(mcpNames.length).toBe(1);
  const [mcpName] = mcpNames[0];
  expect(mcpName).toMatch(/^.+_write_file$/);
  expect(reg.byName.get(mcpName)).toEqual({
    server: "文件系统",
    tool: "write_file",
    kind: "mcp",
  });
  // 生成名全部合法
  for (const t of reg.tools) expect(isValidNativeName(t.function.name)).toBe(true);
});

it("数量上限：优先保留内置，MCP 截尾", () => {
  const mcp: {
    server: string;
    name: string;
    description: string;
    kind: "builtin" | "mcp";
  }[] = [];
  for (let i = 0; i < 50; i++)
    mcp.push({ server: "s", name: `mcp_tool_${i}`, description: "x", kind: "mcp" });
  const reg = buildNativeToolRegistry({ builtins, mcp, maxTools: 50 });
  expect(reg.tools.length).toBe(50);
  // 全部内置保留（43 < 50）
  for (const b of builtins) expect(reg.byName.has(b.name)).toBe(true);
  // 只剩 7 个 MCP 位
  const mcpCount = [...reg.byName.values()].filter((r) => r.kind === "mcp").length;
  expect(mcpCount).toBe(7);
});

it("角色白名单：allowedBuiltin 只保留放行工具", () => {
  const allow = new Set(["read_file", "write_file", "replace_string"]);
  const reg = buildNativeToolRegistry({ builtins, allowedBuiltin: allow });
  expect(reg.tools.length).toBe(3);
  expect(reg.byName.has("plan_task")).toBe(false);
  expect(reg.byName.has("write_file")).toBe(true);
});

it("sanitizeNamePart：ASCII/下划线保留，中文等清洗掉、空则回退", () => {
  expect(sanitizeNamePart("filesystem")).toBe("filesystem");
  expect(sanitizeNamePart("browser-automation_1")).toBe("browser-automation_1");
  expect(sanitizeNamePart("文件系统")).toBe("mcp"); // 全中文 → 空 → 回退默认
  expect(sanitizeNamePart("浏览器 自动化")).toBe("mcp");
  expect(sanitizeNamePart("浏览器", "srv")).toBe("srv"); // 显式 fallback
});

it("supportsNativeTools：deepseek/openai 等明确支持，未知端点不开", () => {
  expect(supportsNativeTools("https://api.deepseek.com")).toBe(true);
  expect(supportsNativeTools("https://api.openai.com/v1")).toBe(true);
  expect(supportsNativeTools("https://api.openrouter.ai")).toBe(true);
  expect(supportsNativeTools("https://dashscope.aliyuncs.com")).toBe(true);
  expect(supportsNativeTools("https://custom.llm.example.com")).toBe(false);
  expect(supportsNativeTools("")).toBe(false);
});

it("超长工具名（>60）也被截断到合法长度，绝不产出非法函数名", () => {
  const longName = `tool_with_a_ridiculously_long_name_${"x".repeat(70)}`;
  expect(longName.length).toBeGreaterThan(64);
  const reg = buildNativeToolRegistry({
    builtins: [],
    mcp: [{ server: "s", name: longName, description: "x", kind: "mcp" }],
  });
  expect(reg.tools.length).toBe(1);
  const n = reg.tools[0].function.name;
  expect(isValidNativeName(n)).toBe(true);
  expect(n.length).toBeLessThanOrEqual(64);
  expect(n.startsWith("tool_with_a_ridiculously")).toBe(true);
  expect(reg.byName.get(n)).toEqual({ server: "s", tool: longName, kind: "mcp" });
});

it("maxTools 极小（1）：只保留首个内置，名字仍合法", () => {
  const reg = buildNativeToolRegistry({ builtins, maxTools: 1 });
  expect(reg.tools.length).toBe(1);
  expect(reg.tools[0].function.name).toBe(builtins[0].name);
  expect(isValidNativeName(reg.tools[0].function.name)).toBe(true);
});

it("MCP inputSchema 非 object（如 string）→ 回退宽松兜底参数", () => {
  const reg = buildNativeToolRegistry({
    builtins: [],
    mcp: [
      {
        server: "s",
        name: "weird",
        description: "x",
        inputSchema: { type: "string" } as unknown as Record<string, unknown>,
        kind: "mcp",
      },
    ],
  });
  expect(reg.tools[0].function.parameters).toEqual(GENERIC_PARAMETERS);
});

it("两个中文服务器同名工具都与内置冲突 → 前缀+序号消歧，均合法且反查各自服务器", () => {
  const mcp: {
    server: string;
    name: string;
    description: string;
    kind: "builtin" | "mcp";
  }[] = [
    { server: "文件系统A", name: "list_dir", description: "a", kind: "mcp" },
    { server: "文件系统B", name: "list_dir", description: "b", kind: "mcp" },
  ];
  const reg = buildNativeToolRegistry({ builtins, mcp });
  // 内置 list_dir 保留原名；两个 MCP 都被 slug 前缀消歧且序号唯一
  expect(reg.byName.get("list_dir")!.kind).toBe("builtin");
  const mcpEntries = [...reg.byName.entries()].filter(
    ([, r]) => r.kind === "mcp" && r.tool === "list_dir",
  );
  expect(mcpEntries.length).toBe(2);
  const names = mcpEntries.map(([n]) => n);
  expect(new Set(names).size).toBe(2);
  expect(names[0]).not.toBe(names[1]);
  for (const n of names) expect(isValidNativeName(n)).toBe(true);
  const servers = mcpEntries.map(([, r]) => r.server).sort();
  expect(servers).toEqual(["文件系统A", "文件系统B"]);
});

it("parseNativeArguments：合法对象解析、非法/空/非对象一律回退空对象", () => {
  expect(parseNativeArguments('{"path":"/tmp/a","content":"x"}')).toEqual({
    path: "/tmp/a",
    content: "x",
  });
  expect(parseNativeArguments("")).toEqual({});
  expect(parseNativeArguments(undefined)).toEqual({});
  expect(parseNativeArguments(null)).toEqual({});
  expect(parseNativeArguments("   ")).toEqual({});
  expect(parseNativeArguments("not json {")).toEqual({});
  expect(parseNativeArguments('["a","b"]')).toEqual({}); // 数组不是对象
  expect(parseNativeArguments('"hello"')).toEqual({}); // 原始值不是对象
  expect(parseNativeArguments("42")).toEqual({});
});
