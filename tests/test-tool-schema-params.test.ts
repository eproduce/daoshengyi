import { it, expect } from "vitest";
import { describeSchemaParams, buildNativeToolRegistry } from "../src/utils/tool-schema.ts";

// 背景（AGENT_DIAGNOSIS 问题 4）：模型常凭印象猜 MCP 工具的参数名
// （把 puppeteer_evaluate 的真实参数 script 写成 expression/function），
// 服务端拿到 undefined 直接报错（实测 12/17 失败）。故把参数名显式写进描述。

it("describeSchemaParams：列出参数名并标出必填项", () => {
  const s = describeSchemaParams({
    type: "object",
    properties: { script: { type: "string" }, timeout: { type: "number" } },
    required: ["script"],
  });
  expect(s).toContain("script(必填)");
  expect(s).toContain("timeout");
  expect(s).toContain("严格使用这些名字");
});

it("describeSchemaParams：无 properties / 空对象 → 返回空串（不污染描述）", () => {
  expect(describeSchemaParams(undefined)).toBe("");
  expect(describeSchemaParams({ type: "object" })).toBe("");
  expect(describeSchemaParams({ type: "object", properties: {} })).toBe("");
});

it("describeSchemaParams：参数过多时截断并给出总数", () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 15; i++) properties[`p${i}`] = { type: "string" };
  const s = describeSchemaParams({ type: "object", properties, required: [] });
  expect(s).toContain("p0");
  expect(s).toContain("p11");
  expect(s).not.toContain("p12"); // 只展示前 12 个
  expect(s).toContain("等 15 个");
});

it("MCP 工具描述带上参数名；内置工具保持原描述（不追加）", () => {
  const reg = buildNativeToolRegistry({
    builtins: [{ name: "write_file", desc: "写文件" }],
    mcp: [
      {
        name: "puppeteer_evaluate",
        // 字段名必须是 description：mcp_connect 返回的就是这个（内置工具才用 desc）——
        // 写错过一次，导致这条断言变成空转（描述里根本没出现服务端文案）
        description: "执行页面脚本",
        server: "浏览器自动化",
        kind: "mcp",
        inputSchema: {
          type: "object",
          properties: { script: { type: "string" } },
          required: ["script"],
        },
      },
    ],
  });
  const mcpTool = reg.tools.find((t) => t.function.name === "puppeteer_evaluate")!;
  // 三件事都要成立：原描述在、服务名在、参数名在；并显式盯住 undefined——
  // 字段名对不上时描述会变成 “undefined（服务名）…”，光看“含参数名”是发现不了的
  const desc = mcpTool.function.description;
  expect(desc).toContain("执行页面脚本");
  expect(desc).toContain("浏览器自动化");
  expect(desc).toContain("script(必填)");
  expect(desc).not.toContain("undefined");
  const builtinTool = reg.tools.find((t) => t.function.name === "write_file")!;
  expect(builtinTool.function.description).toContain("写文件");
  expect(builtinTool.function.description).not.toContain("严格使用这些名字");
});
