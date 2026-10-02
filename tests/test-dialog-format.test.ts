// 应用内确认/提示弹窗的文案解析单测：用的是真实调用点的原文
import { describe, it, expect } from "vitest";
import { parseDialogText, parseInline, deriveDialogUi } from "../src/utils/dialog-format";

describe("parseDialogText", () => {
  it("危险命令确认：首行做标题、命令进等宽块、结尾问句成段落", () => {
    const p = parseDialogText(
      "⚠️ 检测到危险命令：\n\n$ rm -rf /tmp/build\n\n确定要执行吗？",
      "warning",
    );
    expect(p.tone).toBe("warning");
    expect(p.title).toBe("检测到危险命令");
    expect(p.blocks[0]).toEqual({ kind: "mono", lines: ["rm -rf /tmp/build"] });
    expect(p.blocks[1].kind).toBe("p");
    expect(JSON.stringify(p.blocks[1])).toContain("确定要执行吗？");
  });

  it("⛔ 拦截类文案 → error 语气", () => {
    const p = parseDialogText("⛔ 命令被「命令执行策略」拦截：\n\n$ mkfs /dev/sda", "warning");
    expect(p.tone).toBe("error");
    expect(p.title).toBe("命令被「命令执行策略」拦截");
  });

  it("IM 配对请求：连续的「键：值」渲染成键值行，long 值不丢", () => {
    const p = parseDialogText(
      "收到新的 IM 会话请求：\n\n会话 ID：wx_10086\n发送者：张三\n配对码：A1B2-C3D4\n\n是否批准该会话加入白名单（批准后即可自动回复）？",
      "warning",
    );
    const kv = p.blocks.find((b) => b.kind === "kv");
    expect(kv).toBeTruthy();
    expect(JSON.stringify(kv)).toContain("wx_10086");
    expect(JSON.stringify(kv)).toContain("A1B2-C3D4");
    // 问句应保留为独立段落，而不是被并进键值块
    const last = p.blocks[p.blocks.length - 1];
    expect(JSON.stringify(last)).toContain("是否批准");
  });

  it("列表与内联样式（粗体/代码）都能解析", () => {
    const p = parseDialogText(
      "需要授权\n\n- 允许 **本会话** 内执行\n- 使用 `run_command`\n\n继续吗？",
      "info",
    );
    const list = p.blocks.find((b) => b.kind === "list");
    expect(list && list.kind === "list" ? list.items.length : 0).toBe(2);
    expect(JSON.stringify(list)).toContain("本会话");
    expect(JSON.stringify(list)).toContain("run_command");
  });

  it("多行命令连续出现时合并成一个等宽块", () => {
    const p = parseDialogText("确认执行\n\n$ cd /tmp && ls\n$ rm -f a.txt\n\n执行吗？");
    const mono = p.blocks[0];
    expect(mono.kind).toBe("mono");
    expect(mono.kind === "mono" ? mono.lines.length : 0).toBe(2);
  });

  it("空文本/无 emoji 时不崩，走兜底语气与标题", () => {
    expect(parseDialogText("")).toMatchObject({ title: "请确认", tone: "info" });
    expect(parseDialogText(null, "warning").tone).toBe("warning");
    expect(parseDialogText("   \n  \n").title).toBe("请确认");
  });

  it("超长标题被截断（避免标题撑爆卡片）", () => {
    const p = parseDialogText("长".repeat(120));
    expect(p.title.length).toBeLessThanOrEqual(60);
  });
});

describe("parseInline", () => {
  it("混排粗体/代码/普通文本，顺序不乱", () => {
    expect(parseInline("a **b** `c` d")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", code: true },
      { text: " d" },
    ]);
  });

  it("没有标记时原样返回一段", () => {
    expect(parseInline("plain")).toEqual([{ text: "plain" }]);
  });
});

describe("deriveDialogUi", () => {
  it("命令类 → 危险 + 按钮「执行」", () => {
    const ui = deriveDialogUi("⚠️ 检测到危险命令：\n\n$ rm -rf /tmp/x\n\n确定要执行吗？");
    expect(ui.danger).toBe(true);
    expect(ui.confirmText).toBe("执行");
    expect(ui.tone).toBe("warning");
  });

  it("删除类 → 按钮「删除」", () => {
    expect(deriveDialogUi("确认删除文件\n\n/Users/me/a.md").confirmText).toBe("删除");
  });

  it("批准类 → 按钮「批准」", () => {
    expect(
      deriveDialogUi("收到新的 IM 会话请求：\n\n会话 ID：x\n发送者：y\n\n是否批准？").confirmText,
    ).toBe("批准");
  });

  it("普通提示 → 不标危险、按钮「确认」", () => {
    const ui = deriveDialogUi("依赖的服务没起：请先确认端口是否在跑");
    expect(ui.danger).toBe(false);
    expect(ui.confirmText).toBe("确认");
  });
});
