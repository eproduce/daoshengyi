import { describe, it, expect } from "vitest";
import {
  DEFAULT_TIMEOUT_SECS,
  MAX_INJECTIONS_PER_EVENT,
  MAX_INJECT_CHARS,
  MAX_TIMEOUT_SECS,
  describeHook,
  hookMatches,
  isPrivateUrl,
  parseHooks,
  planHooks,
  renderAction,
  renderTemplate,
  sanitizeTextValue,
  selectHooks,
  shellQuote,
  toolMatches,
  validateHooks,
  type HookContext,
  type HookRule,
} from "../src/utils/hooks";

const ctx = (p: Partial<HookContext> = {}): HookContext => ({ event: "tool_after", ...p });

describe("P1-3 钩子 · 模板与转义（边界 1：不接受模型拼接）", () => {
  it("shellQuote 把单引号拆开，注入字符串无法逃逸", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    // 危险字符在单引号内全部失去特殊含义
    const evil = "x; rm -rf ~ ; $(whoami) `id` && echo pwned";
    expect(shellQuote(evil)).toBe(`'${evil}'`);
    expect(shellQuote(evil).startsWith("'")).toBe(true);
  });

  it("shell 模式：占位符值被转义（tool 名里的分号不会变成第二条命令）", () => {
    const out = renderTemplate("echo {{tool}}", ctx({ tool: "a; rm -rf /" }), "shell");
    expect(out).toBe("echo 'a; rm -rf /'");
    // 引号内的单引号也被拆开而不是关闭引号
    expect(renderTemplate("echo {{tool}}", ctx({ tool: "it's" }), "shell")).toBe("echo 'it'\\''s'");
  });

  it("text 模式：净化控制字符、压缩空行、超长截断", () => {
    expect(renderTemplate("结果：{{result}}", ctx({ result: "a\u0007b" }), "text")).toBe(
      "结果：ab",
    );
    expect(renderTemplate("{{result}}", ctx({ result: "a\n\n\n\nb" }), "text")).toBe("a\n\nb");
    const long = "x".repeat(600);
    const out = renderTemplate("{{result}}", ctx({ result: long }), "text");
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("已截断");
    expect(sanitizeTextValue("ok")).toBe("ok");
  });

  it("未知占位符原样保留（便于发现写错），已知但缺值 → 空串", () => {
    expect(renderTemplate("{{unknown_key}}", ctx(), "text")).toBe("{{unknown_key}}");
    expect(renderTemplate("[{{path}}]", ctx(), "text")).toBe("[]");
    // 大小写与空格容错
    expect(renderTemplate("{{ TOOL }}", ctx({ tool: "read_file" }), "text")).toBe("read_file");
  });

  it("多个占位符与混合模式（url 用 text、command 用 shell）", () => {
    const rule: HookRule = {
      event: "tool_after",
      action: "shell",
      command: "notify-send {{tool}} {{path}}",
    };
    const a = renderAction(rule, 0, ctx({ tool: "write_file", path: "/tmp/a b.txt" }));
    expect(a.command).toBe("notify-send 'write_file' '/tmp/a b.txt'");
    expect(a.timeout).toBe(DEFAULT_TIMEOUT_SECS);
    // 超时上限被钳制
    expect(renderAction({ ...rule, timeout: 9999 }, 0, ctx()).timeout).toBe(MAX_TIMEOUT_SECS);
    expect(renderAction({ ...rule, timeout: 0 }, 0, ctx()).timeout).toBe(DEFAULT_TIMEOUT_SECS);
  });
});

describe("P1-3 钩子 · 事件/工具/状态匹配", () => {
  it("事件必须一致；tool 支持前缀通配与 *", () => {
    expect(
      hookMatches({ event: "turn_end", action: "notify", text: "x" }, ctx({ event: "turn_end" })),
    ).toBe(true);
    expect(
      hookMatches({ event: "turn_end", action: "notify", text: "x" }, ctx({ event: "turn_start" })),
    ).toBe(false);
    expect(toolMatches("puppeteer_*", "puppeteer_navigate")).toBe(true);
    expect(toolMatches("puppeteer_*", "browser_navigate")).toBe(false);
    expect(toolMatches("*", "anything")).toBe(true);
    expect(toolMatches(undefined, "anything")).toBe(true);
    expect(toolMatches("read_file", undefined)).toBe(false);
    // 不带通配是精确匹配，不能前缀误伤
    expect(toolMatches("run", "run_command")).toBe(false);
  });

  it("tool_after 的状态过滤只作用于 tool_after", () => {
    const onlyError: HookRule = {
      event: "tool_after",
      action: "notify",
      text: "fail",
      when: "error",
    };
    expect(hookMatches(onlyError, ctx({ status: "error" }))).toBe(true);
    expect(hookMatches(onlyError, ctx({ status: "success" }))).toBe(false);
    expect(hookMatches(onlyError, ctx({ status: undefined }))).toBe(false);
    // 缺省 any → 两种状态都触发
    const any: HookRule = { event: "tool_after", action: "notify", text: "x" };
    expect(hookMatches(any, ctx({ status: "success" }))).toBe(true);
    expect(hookMatches(any, ctx({ status: "error" }))).toBe(true);
  });

  it("enabled:false 被跳过；selectHooks 保持配置顺序", () => {
    const hooks: HookRule[] = [
      { id: "a", event: "turn_end", action: "notify", text: "1" },
      { id: "b", event: "turn_end", action: "notify", text: "2", enabled: false },
      { id: "c", event: "turn_end", action: "notify", text: "3" },
    ];
    expect(selectHooks(hooks, ctx({ event: "turn_end" })).map((h) => h.id)).toEqual(["a", "c"]);
    expect(selectHooks(hooks, ctx({ event: "tool_before" }))).toEqual([]);
  });
});

describe("P1-3 钩子 · 配置期校验（边界 2/3：危险命令与内网地址）", () => {
  it("forbidden 级命令直接拒绝入表", () => {
    const errs = validateHooks([
      { event: "turn_end", action: "shell", command: "rm -rf /" },
      { event: "turn_end", action: "shell", command: "mkfs.ext4 /dev/disk2" },
      { event: "turn_end", action: "shell", command: ":(){ :|:& };:" },
    ]);
    expect(errs).toHaveLength(3);
    for (const e of errs) expect(e).toContain("禁止");
  });

  it("danger 级命令必须显式 allow_danger", () => {
    // 递归强删用户目录 → 危险级
    const risky = "rm -rf ~/Documents/important";
    expect(validateHooks([{ event: "turn_end", action: "shell", command: risky }])[0]).toContain(
      "allow_danger",
    );
    expect(
      validateHooks([{ event: "turn_end", action: "shell", command: risky, allow_danger: true }]),
    ).toEqual([]);
  });

  it("safe 命令（含占位符）通过校验：占位符按最坏形态评估", () => {
    expect(
      validateHooks([
        { event: "tool_after", action: "shell", command: "npm run build", tool: "write_file" },
        { event: "tool_after", action: "shell", command: "echo {{tool}} >> /tmp/hooks.log" },
      ]),
    ).toEqual([]);
  });

  it("http：只允许 http/https，内网默认拒绝、可显式放行", () => {
    expect(
      validateHooks([{ event: "turn_end", action: "http", url: "file:///etc/passwd" }])[0],
    ).toContain("http/https");
    expect(validateHooks([{ event: "turn_end", action: "http", url: "" }])[0]).toContain(
      "需要 url",
    );
    expect(
      validateHooks([{ event: "turn_end", action: "http", url: "http://127.0.0.1:8080/hook" }])[0],
    ).toContain("内网");
    expect(
      validateHooks([
        {
          event: "turn_end",
          action: "http",
          url: "http://127.0.0.1:8080/hook",
          allow_private: true,
        },
      ]),
    ).toEqual([]);
    expect(
      validateHooks([
        { event: "turn_end", action: "http", url: "https://example.com/hook", method: "PUT" },
      ])[0],
    ).toContain("method");
    expect(
      validateHooks([{ event: "turn_end", action: "http", url: "https://example.com/hook" }]),
    ).toEqual([]);
  });

  it("isPrivateUrl 覆盖常见内网/环回形态", () => {
    for (const u of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://172.31.255.1/x",
      "http://169.254.1.1/x",
      "http://mac.local/x",
      "http://[::1]/x",
    ]) {
      expect(isPrivateUrl(u)).toBe(true);
    }
    for (const u of ["https://example.com/x", "http://8.8.8.8/x", "http://172.32.0.1/x"]) {
      expect(isPrivateUrl(u)).toBe(false);
    }
  });

  it("结构错误：非法 event/action、block 用错事件、缺 text、非法 timeout", () => {
    const errs = validateHooks([
      { event: "nope", action: "notify", text: "x" },
      { event: "turn_end", action: "nope", text: "x" },
      { event: "turn_end", action: "block", text: "x" },
      { event: "tool_before", action: "inject" },
      { event: "turn_end", action: "notify", text: "ok", timeout: -1 },
      { event: "turn_end", action: "notify", text: "ok", enabled: "yes" },
      "junk",
    ]);
    expect(errs.join("\n")).toContain("event 必须是");
    expect(errs.join("\n")).toContain("action 必须是");
    expect(errs.join("\n")).toContain("block 只能用于 tool_before");
    expect(errs.join("\n")).toContain("inject 动作需要 text");
    expect(errs.join("\n")).toContain("timeout 必须是正数秒");
    expect(errs.join("\n")).toContain("enabled 必须是布尔值");
    expect(errs.join("\n")).toContain("必须是对象");
    expect(validateHooks({})[0]).toContain("必须是数组");
  });

  it("parseHooks 容错：非法项跳过并报错，合法项保留", () => {
    const { hooks, errors } = parseHooks([
      { event: "turn_end", action: "notify", text: "ok" },
      { event: "bad", action: "notify", text: "x" },
      null,
    ]);
    expect(hooks).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("P1-3 钩子 · 计划与预算", () => {
  it("planHooks 分流：注入进 injections，其余进 actions，顺序保持", () => {
    const hooks: HookRule[] = [
      { id: "n", event: "tool_after", action: "notify", text: "改完 {{path}} 了" },
      { id: "i", event: "tool_after", action: "inject", text: "记住：{{tool}} 已执行" },
      { id: "s", event: "tool_after", action: "shell", command: "echo {{tool}}" },
      { id: "x", event: "turn_end", action: "notify", text: "不该触发" },
    ];
    const { actions, injections, skipped } = planHooks(
      hooks,
      ctx({ tool: "write_file", path: "/tmp/a.ts" }),
    );
    expect(actions.map((a) => a.kind)).toEqual(["notify", "shell"]);
    expect(actions[0].text).toBe("改完 /tmp/a.ts 了");
    expect(injections).toEqual(["记住：write_file 已执行"]);
    expect(skipped).toEqual([]);
  });

  it("注入有条数与长度上限，超限放进 skipped 说明原因", () => {
    const many: HookRule[] = Array.from({ length: MAX_INJECTIONS_PER_EVENT + 2 }, (_, i) => ({
      id: `i${i}`,
      event: "tool_after",
      action: "inject" as const,
      text: "x",
    }));
    const res = planHooks(many, ctx());
    expect(res.injections).toHaveLength(MAX_INJECTIONS_PER_EVENT);
    expect(res.skipped.join("\n")).toContain("注入超限");

    const huge: HookRule[] = [
      { event: "tool_after", action: "inject", text: "y".repeat(MAX_INJECT_CHARS + 500) },
      { event: "tool_after", action: "inject", text: "第二条" },
    ];
    const res2 = planHooks(huge, ctx());
    expect(res2.injections[0].length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    // 预算耗尽 → 后续注入被跳过
    expect(res2.skipped.join("\n")).toContain("注入超限");
  });

  it("describeHook 覆盖所有动作类型", () => {
    expect(describeHook({ action: "notify", event: "turn_end", text: "完事" }, 0)).toContain(
      "通知",
    );
    expect(describeHook({ action: "inject", event: "tool_after", text: "x" }, 1)).toContain("#2");
    expect(describeHook({ action: "block", event: "tool_before", text: "别" }, 0)).toContain(
      "拦截",
    );
    expect(
      describeHook({ action: "shell", event: "tool_after", command: "npm run build" }, 0),
    ).toContain("执行命令 npm run build");
    expect(
      describeHook({ action: "http", event: "turn_end", url: "https://x/y", method: "POST" }, 0),
    ).toContain("POST https://x/y");
    expect(
      describeHook(
        { id: "g", action: "shell", event: "tool_after", command: "ls", tool: "b_*" },
        0,
      ),
    ).toContain("tool=b_*");
  });
});
