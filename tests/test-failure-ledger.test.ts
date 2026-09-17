// P1-9b 失败台账单测：重点是「相似错误能归组」和「阈值语义准确」
import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeErrorText,
  failureSignature,
  errorSample,
  adviceForError,
  summarizeFailures,
  failureAdvice,
  failureLedgerToMarkdown,
  recordToolFailure,
  toolFailureTotal,
  failureHint,
  failureLedgerRows,
  resetFailureLedger,
  SAME_SIGNATURE_HINT_AT,
  SAME_TOOL_HINT_AT,
  type FailureRow,
} from "../src/utils/failure-ledger";

function row(over: Partial<FailureRow>): FailureRow {
  return {
    tool_name: "read_file",
    is_error: false,
    result: "ok",
    arguments: "{}",
    created_at: 1000,
    duration_ms: 5,
    ...over,
  };
}

describe("normalizeErrorText", () => {
  it("行号/路径/时间戳/哈希不同但错误相同 → 归一化后一致", () => {
    const a = "Error: ENOENT: no such file or directory, open '/Users/me/src/a.md'";
    const b = "Error: ENOENT: no such file or directory, open '/Users/me/other/b.md'";
    expect(normalizeErrorText(a)).toBe(normalizeErrorText(b));
  });

  it("抹平时间戳（日期+时刻写法各一）", () => {
    const s = normalizeErrorText("2026-09-17T23:30:01.123Z 失败 2026-09-18 12:00:00 重试");
    expect(s).not.toContain("2026");
    // 「日期 时刻」连着写 = 一个时间戳（规则允许空格分隔），故两处都是 <ts>
    expect(s).toBe("<ts> 失败 <ts> 重试");
    // 单独的日期 / 时刻各自归一化
    expect(normalizeErrorText("开始于 2026-09-18 的日志")).toBe("开始于 <date> 的日志");
    expect(normalizeErrorText("于 12:00:00 中断")).toBe("于 <time> 中断");
  });

  it("抹平 URL 与 UUID、长哈希", () => {
    const s = normalizeErrorText(
      "GET https://api.x.com/v1/chat?k=1 failed id=4f9a2b31-77cc-4e2a-9a11-2b8c1d0e5f66 sha=9f8e7d6c5b4a39281706 failed",
    );
    expect(s).toContain("<url>");
    expect(s).toContain("<uuid>");
    expect(s).toContain("<hex>");
  });

  it("小数字保留（退出码有语义），大数字抹平（行号无意义）", () => {
    expect(normalizeErrorText("命令失败 退出码 1")).toContain("退出码 1");
    expect(normalizeErrorText("line 12345")).toContain("<n>");
    expect(normalizeErrorText("line 12345")).not.toContain("12345");
  });

  it("剥掉工具自定义前缀，跨工具归到同一签名", () => {
    expect(normalizeErrorText("⛔ ENOENT: no such file")).toBe("ENOENT: no such file");
    expect(normalizeErrorText("错误: ENOENT: no such file")).toBe("ENOENT: no such file");
    expect(normalizeErrorText("❌ Failed: ENOENT: no such file")).toBe("ENOENT: no such file");
  });

  it("只看前三行（栈帧尾巴每次都变，不能进签名）", () => {
    const s = normalizeErrorText("boom\nat a.ts:1:1\nat b.ts:2:2\nat random-tail.ts:99:9");
    expect(s).toContain("boom");
    expect(s).not.toContain("random-tail");
  });

  it("压缩空白并去掉尾部标点，长度截断到 200 字以内", () => {
    expect(normalizeErrorText("  a   b  。")).toBe("a b");
    const long = `x${"y".repeat(500)}`;
    expect(normalizeErrorText(long).length).toBeLessThanOrEqual(201);
  });

  it("空输入安全", () => {
    expect(normalizeErrorText("")).toBe("");
    expect(normalizeErrorText(null)).toBe("");
    expect(normalizeErrorText(undefined)).toBe("");
  });

  it("文件名抹平但保留错误码（前缀目录不得留在签名里）", () => {
    const s = normalizeErrorText("src/a/b/component.vue:12:5 TS2304");
    expect(s).toBe("<path>:<pos> TS2304");
    // 相对路径的不同前缀目录也必须抹平，否则同一错误会分成多组
    expect(normalizeErrorText("lib/a/b/component.vue:12:5 TS2304")).toBe(s);
    expect(normalizeErrorText("/Users/me/a/b/c.md")).toBe("<path>");
    expect(normalizeErrorText("~/notes/todo.md")).toBe("<path>");
  });
});

describe("failureSignature / errorSample", () => {
  it("签名含工具名，不同工具不同签名", () => {
    expect(failureSignature("read_file", "ENOENT")).toBe("read_file｜ENOENT");
    expect(failureSignature("read_file", "ENOENT")).not.toBe(failureSignature("glob", "ENOENT"));
  });

  it("样本取首个非空行并截断", () => {
    expect(errorSample("\n\n  错误发生在 a.md  \n第二行")).toBe("错误发生在 a.md");
    expect(errorSample("")).toBe("(空结果)");
    expect(errorSample("x".repeat(300)).length).toBe(201);
  });
});

describe("adviceForError", () => {
  it("命中已知模式给出可执行建议", () => {
    expect(adviceForError("ENOENT: no such file").join()).toContain("list_dir");
    expect(adviceForError("permission denied").join()).toContain("沙箱");
    expect(adviceForError("command not found: rg").join()).toContain("which");
    expect(adviceForError("invalid arguments: path is not a string").join()).toContain("schema");
  });

  it("按顺序最多两条，未命中给空数组", () => {
    const a = adviceForError("ENOENT: no such file or directory (timeout)");
    expect(a.length).toBe(2);
    expect(a[0]).toContain("list_dir");
    expect(adviceForError("完全无关的文本")).toEqual([]);
    expect(adviceForError("")).toEqual([]);
  });
});

describe("summarizeFailures", () => {
  const rows: FailureRow[] = [
    row({ tool_name: "read_file", is_error: true, result: "⛔ ENOENT: /a/one.md", created_at: 10 }),
    row({ tool_name: "read_file", is_error: true, result: "⛔ ENOENT: /b/two.md", created_at: 20 }),
    row({ tool_name: "read_file", is_error: false, result: "内容", created_at: 30 }),
    row({ tool_name: "read_file", is_error: false, result: "内容", created_at: 40 }),
    row({ tool_name: "run_command", is_error: true, result: "timeout after 30s", created_at: 50 }),
    row({ tool_name: "glob", is_error: false, result: "[]", created_at: 60 }),
  ];

  it("只统计有失败的工具，且计数/失败率/最近失败正确", () => {
    const s = summarizeFailures(rows);
    expect(s.map((x) => x.tool)).toEqual(["read_file", "run_command"]);
    const rf = s[0];
    expect(rf.total).toBe(4);
    expect(rf.failed).toBe(2);
    expect(rf.rate).toBe(0.5);
    expect(rf.lastFailedAt).toBe(20);
  });

  it("同一工具的相似错误归为一组（次数累加）", () => {
    const rf = summarizeFailures(rows)[0];
    expect(rf.groups.length).toBe(1);
    expect(rf.groups[0].count).toBe(2);
    expect(rf.groups[0].signature).toContain("<path>");
    expect(rf.topSignature).toBe(rf.groups[0].signature);
  });

  it("组内错误不同 → 分成多组，组内保留真实样本", () => {
    const s = summarizeFailures([
      row({ tool_name: "t", is_error: true, result: "ENOENT: /a/x.md", created_at: 1 }),
      row({ tool_name: "t", is_error: true, result: "permission denied: /a/y.md", created_at: 2 }),
    ])[0];
    expect(s.groups.length).toBe(2);
    expect(s.groups.map((g) => g.count)).toEqual([1, 1]);
    expect(s.groups[0].sample).toMatch(/ENOENT|permission/);
  });

  it("无失败的工具默认不出现在台账里（includeClean 才列出）", () => {
    expect(summarizeFailures(rows).some((x) => x.tool === "glob")).toBe(false);
    const clean = summarizeFailures(rows, { includeClean: true });
    const g = clean.find((x) => x.tool === "glob");
    expect(g?.failed).toBe(0);
    expect(g?.rate).toBe(0);
    expect(g?.advice).toBeNull();
  });

  it("排序确定：失败多的在前", () => {
    const many: FailureRow[] = [
      row({ tool_name: "b", is_error: true, result: "e1" }),
      row({ tool_name: "a", is_error: true, result: "e1" }),
      row({ tool_name: "a", is_error: true, result: "e2" }),
    ];
    expect(summarizeFailures(many).map((x) => x.tool)).toEqual(["a", "b"]);
  });

  it("每组最多保留 topGroups 组，组内按次数降序", () => {
    const rows2: FailureRow[] = [
      row({ tool_name: "t", is_error: true, result: "常见错误" }),
      row({ tool_name: "t", is_error: true, result: "常见错误" }),
      row({ tool_name: "t", is_error: true, result: "少见的错" }),
    ];
    const s = summarizeFailures(rows2, { topGroups: 1 })[0];
    expect(s.groups.length).toBe(1);
    expect(s.groups[0].count).toBe(2);
  });

  it("忽略空工具名与脏数据，且空输入返回空台账", () => {
    expect(summarizeFailures([])).toEqual([]);
    expect(summarizeFailures([row({ tool_name: "  " })])).toEqual([]);
  });

  it("失败率保留 3 位小数（1/3 不出现浮点尾巴）", () => {
    const rows3: FailureRow[] = [
      row({ tool_name: "t", is_error: true, result: "x" }),
      row({ tool_name: "t" }),
      row({ tool_name: "t" }),
    ];
    expect(summarizeFailures(rows3)[0].rate).toBe(0.333);
  });
});

describe("failureAdvice", () => {
  it("没失败 → null", () => {
    expect(failureAdvice({ tool: "read_file", total: 3, failed: 0, rate: 0 })).toBeNull();
  });

  it("高失败率优先给「换工具」建议", () => {
    const a = failureAdvice({ tool: "glob", total: 4, failed: 3, rate: 0.75 });
    expect(a).toContain("换工具");
  });

  it("写入类工具失败 → 提示先读后改", () => {
    const a = failureAdvice({ tool: "replace_string", total: 2, failed: 2, rate: 1 });
    expect(a).toContain("read_file");
  });

  it("低失败率的偶发 → 给最低限度建议", () => {
    const a = failureAdvice({ tool: "run_command", total: 20, failed: 1, rate: 0.05 });
    expect(a).toContain("核对参数");
  });
});

describe("failureLedgerToMarkdown", () => {
  it("有失败 → 出表格 + 分组", () => {
    const md = failureLedgerToMarkdown(
      summarizeFailures([
        row({ tool_name: "read_file", is_error: true, result: "ENOENT: /a/x.md", created_at: 10 }),
      ]),
      300,
    );
    expect(md).toContain("# 工具失败台账");
    expect(md).toContain("最近 300 条");
    expect(md).toContain("| read_file |");
    expect(md).toContain("## 相似错误分组");
  });

  it("没有失败 → 明确说明样本干净", () => {
    const md = failureLedgerToMarkdown([], 100);
    expect(md).toContain("没有失败记录");
  });

  it("竖线与换行被转义（Markdown 表格不被撑破）", () => {
    const md = failureLedgerToMarkdown(
      summarizeFailures([row({ tool_name: "a|b", is_error: true, result: "x|y" })]),
    );
    expect(md).toContain("a\\|b");
  });
});

describe("会话内失败台账（事中提醒）", () => {
  beforeEach(() => resetFailureLedger());

  it("第一次失败不提醒（可能是偶发）", () => {
    expect(failureHint("read_file", "ENOENT: /a/x.md")).toBeNull();
  });

  it("同一签名第 2 次提醒，并附带可执行建议", () => {
    failureHint("read_file", "ENOENT: /a/x.md");
    const h = failureHint("read_file", "❌ ENOENT: /b/y.md");
    expect(h).toBeTruthy();
    expect(h).toContain("read_file");
    expect(h).toContain("别原样重试");
    expect(h).toContain("list_dir");
    expect(SAME_SIGNATURE_HINT_AT).toBe(2);
  });

  it("同一工具不同签名：累计到第 3 次才提醒（且用的是另一条文案）", () => {
    expect(failureHint("run_command", "错误 A")).toBeNull();
    expect(failureHint("run_command", "错误 B")).toBeNull();
    const h = failureHint("run_command", "错误 C");
    expect(h).toContain("错误各不相同");
    expect(SAME_TOOL_HINT_AT).toBe(3);
  });

  it("提醒会持续出现（第 3、4 次同样提醒，不会只响一次）", () => {
    failureHint("t", "同一错误");
    failureHint("t", "同一错误");
    const third = failureHint("t", "同一错误");
    expect(third).toContain("同样的方式失败 3 次");
  });

  it("不同工具互不干扰计数", () => {
    failureHint("a", "e");
    failureHint("b", "e");
    expect(toolFailureTotal("a")).toBe(1);
    expect(failureHint("a", "e")).toBeTruthy();
  });

  it("recordToolFailure 返回准确的计数，快照按次数降序", () => {
    recordToolFailure("t", "e1");
    const hit = recordToolFailure("t", "e1");
    recordToolFailure("u", "e2");
    expect(hit.sameSignature).toBe(2);
    expect(hit.sameTool).toBe(2);
    expect(failureLedgerRows()[0].count).toBe(2);
    expect(failureLedgerRows()[0].tool).toBe("t");
  });

  it("reset 后归零", () => {
    failureHint("t", "e");
    resetFailureLedger();
    expect(toolFailureTotal("t")).toBe(0);
    expect(failureLedgerRows()).toEqual([]);
  });
});
