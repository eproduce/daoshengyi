import { describe, it, expect } from "vitest";
import {
  contextsFromAudit,
  describeRule,
  dryRun,
  evaluateRules,
  expandPathVariants,
  globToRegExp,
  parseRules,
  ruleMatches,
  validateRules,
  type PermissionRule,
} from "../src/utils/permission-rules";

const HOME = "/Users/tester";

describe("P1-4 权限规则 · 校验与解析", () => {
  it("合法规则表无错误", () => {
    expect(
      validateRules([
        { action: "allow", tool: "run_command", command: "^npm test\\b" },
        { action: "deny", tool: "run_command", command: "rm -rf /" },
        { action: "ask", path: "~/proj/**", reason: "改代码前确认" },
      ]),
    ).toEqual([]);
  });

  it("非法 action / 非法正则 / 类型错误 / 空条件都给出**带下标**的错误", () => {
    const errs = validateRules([
      { action: "allow", tool: "read_file" },
      { action: "maybe", tool: "run_command" },
      { action: "allow", tool: "run_command", command: "([unclosed" },
      { action: "ask" },
      { action: "allow", tool: 123 },
      { action: "allow", tool: "x", enabled: "yes" },
      "not-an-object",
    ]);
    expect(errs.length).toBe(6);
    expect(errs[0]).toContain("第 2 条");
    expect(errs[0]).toContain("action 必须是");
    expect(errs[1]).toContain("正则非法");
    expect(errs[2]).toContain("至少要有一个匹配条件");
    expect(errs[3]).toContain("tool 必须是字符串");
    expect(errs[4]).toContain("enabled 必须是布尔值");
    expect(errs[5]).toContain("必须是对象");
  });

  it("非数组直接报错；parseRules 容错跳过非法项但保留合法项", () => {
    expect(validateRules(null)).toEqual(["规则表必须是数组（每项形如 {\"action\":\"allow\",\"tool\":\"run_command\"}）"]);
    expect(validateRules({ action: "allow" }).length).toBe(1);
    const { rules, errors } = parseRules([
      { action: "deny", command: "rm -rf" },
      { action: "nope" },
      null,
      { action: "allow", tool: "read_file" },
    ]);
    expect(rules).toHaveLength(2);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("P1-4 权限规则 · 匹配", () => {
  it("工具名精确匹配（不做模糊/前缀匹配，避免误伤同名族）", () => {
    const r: PermissionRule = { action: "allow", tool: "run_command" };
    expect(ruleMatches(r, { tool: "run_command" })).toBe(true);
    expect(ruleMatches(r, { tool: "run_command_x" })).toBe(false);
    expect(ruleMatches(r, { tool: "read_file" })).toBe(false);
  });

  it("命令正则：缺 command 参数则不命中（不会误放行任何命令）", () => {
    const r: PermissionRule = { action: "allow", tool: "run_command", command: "^npm test" };
    expect(ruleMatches(r, { tool: "run_command", command: "npm test -- --run" })).toBe(true);
    expect(ruleMatches(r, { tool: "run_command", command: "npm run test" })).toBe(false);
    expect(ruleMatches(r, { tool: "run_command" })).toBe(false);
  });

  it("非法正则在匹配阶段视为不命中（不抛异常）", () => {
    const r: PermissionRule = { action: "allow", tool: "run_command", command: "([bad" };
    expect(ruleMatches(r, { tool: "run_command", command: "x" })).toBe(false);
  });

  it("enabled:false 的规则被跳过", () => {
    const r: PermissionRule = { action: "deny", tool: "read_file", enabled: false };
    expect(ruleMatches(r, { tool: "read_file" })).toBe(false);
  });

  it("路径 glob：`*` 不跨目录、`**` 跨段、`**/` 可匹配零层", () => {
    const re = globToRegExp("/Users/tester/proj/**/*.ts");
    expect(re.test("/Users/tester/proj/a.ts")).toBe(true);
    expect(re.test("/Users/tester/proj/src/deep/a.ts")).toBe(true);
    expect(re.test("/Users/tester/proj/src/a.js")).toBe(false);
    const single = globToRegExp("/tmp/*.log");
    expect(single.test("/tmp/a.log")).toBe(true);
    expect(single.test("/tmp/sub/a.log")).toBe(false);
    // 特殊字符被转义（点号不当通配符）
    expect(globToRegExp("/a/b.txt").test("/a/bXtxt")).toBe(false);
    expect(globToRegExp("/a/b.txt").test("/a/b.txt")).toBe(true);
  });

  it("`~` 展开：同时匹配 `~/x` 与展开后的绝对路径", () => {
    const r: PermissionRule = { action: "ask", path: "~/proj/**" };
    expect(ruleMatches(r, { tool: "write_file", path: "/Users/tester/proj/a.ts" }, HOME)).toBe(true);
    expect(ruleMatches(r, { tool: "write_file", path: "~/proj/a.ts" }, HOME)).toBe(true);
    expect(ruleMatches(r, { tool: "write_file", path: "/Users/tester/other/a.ts" }, HOME)).toBe(false);
    expect(ruleMatches(r, { tool: "write_file" }, HOME)).toBe(false);
    expect(expandPathVariants("~/a.txt", HOME)).toEqual(["~/a.txt", "/Users/tester/a.txt"]);
    expect(expandPathVariants("~", HOME)).toEqual(["~", HOME]);
    expect(expandPathVariants("/abs/a.txt", HOME)).toEqual(["/abs/a.txt"]);
  });

  it("相对 glob（没有前缀）按「任意位置」匹配，方便写 `*.env`", () => {
    const r: PermissionRule = { action: "deny", path: "**/*.env" };
    expect(ruleMatches(r, { tool: "write_file", path: "/Users/tester/proj/.env" }, HOME)).toBe(true);
    expect(ruleMatches(r, { tool: "write_file", path: "/Users/tester/proj/config.ts" }, HOME)).toBe(false);
  });
});

describe("P1-4 权限规则 · 求值（有序、第一条命中）", () => {
  const rules: PermissionRule[] = [
    { id: "no-rm", action: "deny", tool: "run_command", command: "rm -rf" },
    { id: "test-ok", action: "allow", tool: "run_command", command: "^npm (test|run lint)\\b" },
    { id: "code-ask", action: "ask", path: "~/proj/**", reason: "改代码前确认" },
  ];

  it("deny 命中即拒绝，并带规则说明与理由", () => {
    const v = evaluateRules(rules, { tool: "run_command", command: "rm -rf /tmp/x" }, HOME);
    expect(v.decision).toBe("deny");
    if (v.decision === "deny") {
      expect(v.index).toBe(0);
      expect(v.rule.id).toBe("no-rm");
      expect(v.message).toContain("已被权限规则拒绝");
      expect(v.message).toContain("设置 → 权限规则");
    }
  });

  it("allow 命中免确认；不匹配的命令 → none（交回原有审批流程）", () => {
    expect(evaluateRules(rules, { tool: "run_command", command: "npm test" }, HOME).decision).toBe(
      "allow",
    );
    expect(
      evaluateRules(rules, { tool: "run_command", command: "npm publish" }, HOME).decision,
    ).toBe("none");
  });

  it("顺序决定优先级：deny 写在 allow 之后时，allow 先命中（用户自己用顺序表达优先级）", () => {
    const reversed: PermissionRule[] = [
      { action: "allow", tool: "run_command", command: "rm" },
      { action: "deny", tool: "run_command", command: "rm -rf /" },
    ];
    expect(evaluateRules(reversed, { tool: "run_command", command: "rm -rf /" }, HOME).decision).toBe(
      "allow",
    );
  });

  it("ask 命中 → 返回确认要求；未命中任何规则 → none 且无文案", () => {
    const v = evaluateRules(rules, { tool: "write_file", path: "/Users/tester/proj/a.ts" }, HOME);
    expect(v.decision).toBe("ask");
    if (v.decision === "ask") expect(v.message).toContain("要求确认");
    const none = evaluateRules(rules, { tool: "read_file", path: "/tmp/a" }, HOME);
    expect(none.decision).toBe("none");
    expect(none.message).toBe("");
  });

  it("空规则表 → 永远 none（未配置不影响任何行为）", () => {
    expect(evaluateRules([], { tool: "run_command", command: "rm -rf /" }, HOME).decision).toBe("none");
  });

  it("describeRule 覆盖三种处置与全部条件", () => {
    expect(describeRule({ action: "allow", tool: "run_command", command: "^npm test" }, 0)).toContain(
      "允许（免确认）",
    );
    const d = describeRule({ id: "x", action: "deny", path: "~/a/**", reason: "别动" }, 3);
    expect(d).toContain("「x」");
    expect(d).toContain("禁止");
    expect(d).toContain("别动");
    // 无 id 时回显序号
    expect(describeRule({ action: "ask" }, 2)).toContain("#3");
  });
});

describe("P1-4 权限规则 · dry-run（启用前先看清会拦住什么）", () => {
  it("逐条给判定与命中规则，并统计各处置数量", () => {
    const rules: PermissionRule[] = [
      { id: "deny-rm", action: "deny", tool: "run_command", command: "rm -rf" },
      { id: "allow-test", action: "allow", tool: "run_command", command: "^npm test" },
    ];
    const { rows, counts } = dryRun(
      rules,
      [
        { tool: "run_command", command: "npm test" },
        { tool: "run_command", command: "rm -rf ~/tmp" },
        { tool: "read_file", path: "/tmp/a.txt" },
      ],
      HOME,
    );
    expect(rows.map((r) => r.decision)).toEqual(["allow", "deny", "none"]);
    expect(rows[0].matched).toContain("allow-test");
    expect(rows[1].detail).toContain("rm -rf");
    expect(rows[2].matched).toBe("");
    expect(counts).toEqual({ allow: 1, deny: 1, ask: 0, none: 1 });
  });

  it("contextsFromAudit 从审计行抽参数；坏 JSON 只按工具名", () => {
    const ctx = contextsFromAudit([
      { tool_name: "run_command", arguments: '{"command":"npm test"}' },
      { tool_name: "write_file", arguments: '{"path":"/Users/tester/a.ts"}' },
      { tool_name: "run_command", arguments: "not-json" },
      { tool_name: "run_command", arguments: '{"command":123}' },
    ]);
    expect(ctx[0]).toEqual({ tool: "run_command", command: "npm test", path: undefined });
    expect(ctx[1].path).toBe("/Users/tester/a.ts");
    expect(ctx[2]).toEqual({ tool: "run_command", command: undefined, path: undefined });
    expect(ctx[3].command).toBeUndefined(); // 非字符串不当作命令
  });

  it("dry-run 全部匹配上 allow → 提示「会放开」的真实观感（用例：只放行只读命令）", () => {
    const { counts } = dryRun(
      [{ action: "allow", tool: "run_command", command: "^(git status|npm test)\\b" }],
      [
        { tool: "run_command", command: "git status" },
        { tool: "run_command", command: "npm test" },
        { tool: "run_command", command: "git push" },
      ],
      HOME,
    );
    expect(counts).toEqual({ allow: 2, deny: 0, ask: 0, none: 1 });
  });
});
