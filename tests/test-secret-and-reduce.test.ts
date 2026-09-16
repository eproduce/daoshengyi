import { describe, it, expect } from "vitest";
import { redactSecrets, containsSecret } from "../src/utils/secret-redact.ts";
import { reduceToolResult } from "../src/utils/tool-result-reduce.ts";

describe("secret-redact：凭据脱敏", () => {
  it("常见密钥形态被掩码", () => {
    const text = [
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx",
      "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnop",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123.signature",
      "url: https://user:s3cretPass@example.com/repo",
      "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP",
      "aws=AKIAIOSFODNN7EXAMPLE",
      'password: "ab12cd34ef56gh78"',
    ].join("\n");
    const r = redactSecrets(text);
    expect(r.text).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(r.text).not.toContain("ghp_123");
    expect(r.text).not.toContain("abc123.signature");
    expect(r.text).not.toContain("s3cretPass");
    expect(r.text).not.toContain("dBjftJeZ4CVP");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).not.toContain("ab12cd34ef56gh78");
    expect(r.kinds.length).toBeGreaterThanOrEqual(5);
    expect(r.hits).toBeGreaterThanOrEqual(5);
  });

  it("私钥块整体替换", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const r = redactSecrets(`看这个：${pem}`);
    expect(r.text).toContain("[已脱敏：私钥内容]");
    expect(r.text).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("不误伤正常文本（token 计数、UUID、git sha、路径）", () => {
    const text = [
      "cache_read_input_tokens: 12345",
      "prompt_tokens: 999",
      "completion_tokens: 4096",
      "id=550e8400-e29b-41d4-a716-446655440000",
      "commit=3f786850e387550fdab836ed7e6dc881de23001b",
      "path=/Users/wanghuan/op/daoshengyi/src/utils/tokens.ts",
    ].join("\n");
    const r = redactSecrets(text);
    expect(r.text).toBe(text);
    expect(r.hits).toBe(0);
    expect(containsSecret(text)).toBe(false);
  });

  it("enabled=false 时原样返回", () => {
    const text = "key=sk-abcdefghijklmnopqrstuvwx";
    expect(redactSecrets(text, false).text).toBe(text);
    expect(redactSecrets(text, false).hits).toBe(0);
  });
});

describe("tool-result-reduce：内容感知压缩", () => {
  const mk = (n: number, line = "普通行内容，占位文本。") => Array.from({ length: n }, () => line);

  it("短输入不做任何压缩", () => {
    const r = reduceToolResult("run_command", "ok\nshort");
    expect(r.text).toBe("ok\nshort");
    expect(r.notes).toEqual([]);
  });

  it("清除 ANSI 控制字符", () => {
    const r = reduceToolResult("run_command", "\u001b[31m红色错误\u001b[0m");
    expect(r.text).toBe("红色错误");
    expect(r.notes).toContain("清除终端颜色/控制字符");
  });

  it("折叠连续重复行", () => {
    const text = [...mk(5), ...mk(20, "重复的一行"), ...mk(5)].join("\n");
    const r = reduceToolResult("run_command", text);
    expect(r.text).toContain("同一行重复 20 次");
    expect(r.notes.join()).toContain("连续重复行");
    expect(r.text.length).toBeLessThan(text.length);
  });

  it("折叠调用栈中段", () => {
    const frames = Array.from({ length: 20 }, (_, i) => `    at fn${i} (/src/a.ts:${i}:1)`);
    const text = ["Error: boom", ...frames].join("\n");
    const r = reduceToolResult("run_command", text);
    expect(r.text).toContain("栈帧 20 层中省略");
    expect(r.text).toContain("Error: boom");
  });

  it("有失败时省略「通过」条目，但绝不丢失败行", () => {
    const pass = Array.from({ length: 40 }, (_, i) => `✓ tests/case-${i}.test.ts (1 test)`);
    const text = [...pass, "FAIL tests/real.test.ts", "AssertionError: expected 1 to be 2"].join("\n");
    const r = reduceToolResult("run_test", text);
    expect(r.text).toContain("FAIL tests/real.test.ts");
    expect(r.text).toContain("AssertionError");
    expect(r.text).toContain("已省略");
  });

  it("超大 JSON 数组做结构采样", () => {
    const arr = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item-${i}`, value: i * 3 }));
    const r = reduceToolResult("mcp_tool", JSON.stringify(arr, null, 2));
    expect(r.notes.join()).toContain("结构采样");
    expect(r.text).toContain("数组共 400 项");
  });

  it("大表格做首尾采样", () => {
    const head = "id,name,value";
    const rows = Array.from({ length: 120 }, (_, i) => `${i},name-${i},${i * 2}`);
    const r = reduceToolResult("run_command", [head, ...rows].join("\n"));
    expect(r.notes.join()).toContain("表格");
    expect(r.text).toContain("表格共 121 行");
    expect(r.text).toContain("id,name,value");
  });

  it("超长单行被钳制", () => {
    const longLine = "x".repeat(5000);
    const r = reduceToolResult("read_file", `${mk(40).join("\n")}\n${longLine}`);
    expect(r.text).toContain("已省略中间");
    expect(r.text.length).toBeLessThan(6000);
  });

  it("按预算裁剪时，错误行优先保留", () => {
    const noise = Array.from({ length: 300 }, (_, i) => `noise line ${i} ${"y".repeat(60)}`);
    const important = Array.from({ length: 20 }, (_, i) => `ERROR: critical failure ${i}`);
    const r = reduceToolResult("run_command", [...noise, ...important, ...noise].join("\n"), { maxChars: 5000 });
    expect(r.text).toContain("ERROR: critical failure 0");
    expect(r.text).toContain("ERROR: critical failure 19");
    expect(r.text).toContain("已省略");
    expect(r.text.length).toBeLessThanOrEqual(6000);
  });
});
