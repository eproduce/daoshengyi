import { describe, it, expect } from "vitest";
import {
  ORDER,
  disabledToolRule,
  modelVisibleContent,
  pathWhitelistRule,
  runPreTool,
  type ToolInterceptor,
} from "../src/utils/intercepts.ts";
import { splitLeadingToolCards } from "../src/utils/tool-summary.ts";

/**
 * 拦截点（pre-tool）：把散落在主循环里的判定收敛成一条**有序、可短路、可改写**的链。
 * 这里钉住三条语义（DSH 的 waterfall 契约）：
 *   ① 顺序由 order 决定；② deny 立即短路（后面的规则不再执行）；③ rewrite 传给下一环。
 */
const fake = (
  id: string,
  order: number,
  run: (args: Record<string, unknown>) => ReturnType<ToolInterceptor["run"]>,
): ToolInterceptor => ({ id, order, run: ({ args }) => run(args) });

describe("runPreTool：有序 / 短路 / 改写", () => {
  it("空链放行（没有规则 ≠ 拦截）", () => {
    const out = runPreTool([], { server: "app", tool: "read_file", args: { path: "/a" } });
    expect(out.allowed).toBe(true);
    expect(out.args).toEqual({ path: "/a" });
    expect(out.applied).toEqual([]);
  });

  it("按 order 升序执行，deny 立即短路（后续规则不执行）", () => {
    const ran: string[] = [];
    const out = runPreTool(
      [
        fake("late", 30, () => {
          ran.push("late");
          return { kind: "allow" };
        }),
        fake("first", 10, () => {
          ran.push("first");
          return { kind: "deny", message: "nope" };
        }),
        fake("mid", 20, () => {
          ran.push("mid");
          return { kind: "allow" };
        }),
      ],
      { server: "app", tool: "x", args: {} },
    );
    expect(out.allowed).toBe(false);
    expect(out.message).toBe("nope");
    expect(ran).toEqual(["first"]); // mid/late 不该跑
    expect(out.applied).toEqual(["first"]);
  });

  it("rewrite 把新参数交给下一环（下一环看到的是改写后的）", () => {
    const seen: unknown[] = [];
    const out = runPreTool(
      [
        fake("normalize", 10, () => ({ kind: "rewrite", args: { path: "/fixed" } })),
        fake("observe", 20, (args) => {
          seen.push(args);
          return { kind: "allow" };
        }),
      ],
      { server: "app", tool: "read_file", args: { file_path: "/raw" } },
    );
    expect(out.allowed).toBe(true);
    expect(out.args).toEqual({ path: "/fixed" });
    expect(seen).toEqual([{ path: "/fixed" }]);
  });

  it("拦截器抛异常 → 视为放行（一次异常不能把工具系统整体打死）", () => {
    const out = runPreTool(
      [
        fake("boom", 10, () => {
          throw new Error("bug");
        }),
        fake("after", 20, () => ({ kind: "allow" })),
      ],
      { server: "app", tool: "x", args: { a: 1 } },
    );
    expect(out.allowed).toBe(true);
    expect(out.applied).toEqual(["boom", "after"]);
  });
});

describe("内置拦截器：工具开关与路径白名单", () => {
  const disabled = disabledToolRule(["run_command"], (t) => t === "run_command");
  const allowed = pathWhitelistRule(
    ["/Users/me/work"],
    (args) => (typeof args.path === "string" ? args.path : undefined),
    (p, list) => list.some((d) => p === d || p.startsWith(d + "/")),
  );

  it("禁用工具 → deny，且话术与权限矩阵一致（同一件事只有一种说法）", () => {
    const out = runPreTool([disabled], { server: "app", tool: "run_command", args: {} });
    expect(out.allowed).toBe(false);
    expect(out.message).toContain("已在权限矩阵中禁用");
  });

  it("未禁用 → 放行", () => {
    expect(runPreTool([disabled], { server: "app", tool: "read_file", args: {} }).allowed).toBe(
      true,
    );
  });

  it("路径白名单：白名单内放行、外拒绝、无路径参数放行、未配置白名单放行", () => {
    expect(
      runPreTool([allowed], {
        server: "app",
        tool: "read_file",
        args: { path: "/Users/me/work/a.md" },
      }).allowed,
    ).toBe(true);
    const denied = runPreTool([allowed], {
      server: "app",
      tool: "read_file",
      args: { path: "/etc/passwd" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.message).toContain("不在权限白名单内");
    expect(runPreTool([allowed], { server: "app", tool: "calc", args: {} }).allowed).toBe(true);
    const open = pathWhitelistRule(
      [],
      () => "/etc/passwd",
      () => false,
    );
    expect(
      runPreTool([open], { server: "app", tool: "read_file", args: { path: "/etc/x" } }).allowed,
    ).toBe(true);
  });

  it("链路顺序：先工具开关（10）后路径白名单（20）", () => {
    expect(ORDER.disabled).toBeLessThan(ORDER.pathWhitelist);
    expect(ORDER.pathWhitelist).toBeLessThan(ORDER.approval);
  });
});

describe("modelVisibleContent：发给模型的历史里不许有 UI 卡片", () => {
  const legacy =
    "### 🔧 调用工具：`web_search`\n\n" +
    "<details><summary>参数</summary>\n\n```json\n{}\n```\n\n</details>" +
    "\n<details><summary>✅ 工具结果</summary>\n\n```\nok\n```\n\n</details>" +
    "\n\n最终答案：金价 780。";

  it("老会话的 assistant 正文：剥掉遗留卡片，只留答案", () => {
    const out = modelVisibleContent(
      { role: "assistant", content: legacy, tools: [{ name: "web_search" }] },
      (c) => splitLeadingToolCards(c).body,
    );
    expect(out).toBe("最终答案：金价 780。");
    expect(out).not.toContain("🔧");
    expect(out).not.toContain("<details>");
  });

  it("只有卡片、没有正文：给一句如实占位（空 assistant 消息对上游不安全）", () => {
    const cardsOnly = legacy.split("\n\n最终答案")[0];
    const out = modelVisibleContent(
      { role: "assistant", content: cardsOnly, tools: [{ name: "web_search" }] },
      (c) => splitLeadingToolCards(c).body,
    );
    expect(out).toBe("（本轮执行了工具，未给出文字结论）");
  });

  it("用户消息原样返回（用户可能真的在问「怎么写这种卡片」）", () => {
    const q = "请解释这段：### 🔧 调用工具：`x`";
    expect(modelVisibleContent({ role: "user", content: q }, () => "")).toBe(q);
  });

  it("空内容且无工具 → 空串（由调用方决定跳过该条）", () => {
    expect(modelVisibleContent({ role: "assistant", content: "" }, (c) => c)).toBe("");
  });
});
