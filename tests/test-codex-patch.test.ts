import { it, expect } from "vitest";
import {
  parseCodexPatch,
  hunksToEdits,
  summarizePatch,
  PatchParseError,
} from "../src/utils/codex-patch.ts";

// Codex apply_patch 格式解析（对齐 openai/codex 的 freeform 工具）
// 目的：一次调用完成多文件/多片段编辑，减少替换工具往返。

it("解析 Add File：内容按 + 行聚合、允许空行", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Add File: app.py
+class Base:
+
+  def method():
+    return False
*** End Patch`);
  expect(p.files).toHaveLength(1);
  expect(p.files[0].op).toBe("add");
  expect(p.files[0].path).toBe("app.py");
  expect(p.files[0].content).toBe("class Base:\n\n  def method():\n    return False");
});

it("解析 Update File：上下文 + 删除/新增合成 oldText/newText", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Update File: app.py
@@  def method():
-    return False
+    return True
*** End Patch`);
  const f = p.files[0];
  expect(f.op).toBe("update");
  expect(f.hunks).toHaveLength(1);
  expect(f.hunks[0].oldText).toBe("    return False");
  expect(f.hunks[0].newText).toBe("    return True");
  const edits = hunksToEdits(f.hunks);
  expect(edits).toEqual([{ op: "replace", old: "    return False", new: "    return True" }]);
});

it("上下文行同时进入 old/new（保证替换后其余内容不变）", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
 line1
-old
+new
 line3
*** End Patch`);
  expect(p.files[0].hunks[0].oldText).toBe("line1\nold\nline3");
  expect(p.files[0].hunks[0].newText).toBe("line1\nnew\nline3");
});

it("同一文件多个 hunk → 多个 replace 操作（顺序保留）", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
@@ one
-a1
+a2
@@ two
-b1
+b2
*** End Patch`);
  const edits = hunksToEdits(p.files[0].hunks);
  expect(edits).toHaveLength(2);
  expect(edits[0].old).toBe("a1");
  expect(edits[1].old).toBe("b1");
});

it("一个补丁可含多个文件（Add/Update/Delete 混排）", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Add File: new.txt
+hello
*** Update File: old.txt
-x
+y
*** Delete File: gone.txt
*** End Patch`);
  expect(p.files.map((f) => `${f.op}:${f.path}`)).toEqual([
    "add:new.txt",
    "update:old.txt",
    "delete:gone.txt",
  ]);
  expect(summarizePatch(p)).toContain("3 个文件");
});

it("宽容性：省略 Begin/End 也能解析", () => {
  const p = parseCodexPatch(`好的，我来改这个文件：
*** Update File: a.txt
-a
+b`);
  expect(p.files).toHaveLength(1);
  expect(p.files[0].hunks[0].newText).toBe("b");
});

it("补丁内夹带解释文字 → 报错（严格胜过静默丢改动），并提示用 End Patch 收尾", () => {
  expect(() =>
    parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
-a
+b
希望能通过。`),
  ).toThrowError(/End Patch/);
});

it("仅有新增行、无上下文 → 明确报错并提示替代方案", () => {
  expect(() =>
    parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
+only addition
*** End Patch`),
  ).toThrowError(/上下文/);
});

it("Update 没有任何改动 → 报错（避免空操作当成功）", () => {
  expect(() =>
    parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
*** End Patch`),
  ).toThrowError(/未包含任何有效改动/);
});

it("Add File 无内容 → 报错", () => {
  expect(() =>
    parseCodexPatch(`*** Begin Patch
*** Add File: empty.txt
*** End Patch`),
  ).toThrowError(/没有任何 \+ 行内容/);
});

it("片段内前缀非法 → 报错并指出行号（便于模型自纠）", () => {
  expect(() =>
    parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
@@ x
plain line without prefix
*** End Patch`),
  ).toThrowError(/前缀非法/);
});

it("Move to 不报错但给出警告（改用 git mv 两步走）", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
-a
+b
*** Move to: b.txt
*** End Patch`);
  expect(p.warnings.join()).toContain("Move to");
  expect(p.files[0].path).toBe("a.txt"); // 内容改动仍可用
});

it("非补丁文本 → 报错（避免模型把普通回答当补丁传入）", () => {
  expect(() => parseCodexPatch("我建议把 a.txt 里的 return False 改成 True")).toThrowError(
    PatchParseError,
  );
  expect(() => parseCodexPatch("")).toThrowError(/patch 为空/);
});

it("纯上下文片段（无实质改动）被忽略，不产生操作", () => {
  const p = parseCodexPatch(`*** Begin Patch
*** Update File: a.txt
-a
+b
@@ ctx
 same line
*** End Patch`);
  expect(p.files[0].hunks).toHaveLength(1); // 只有真正改动的那一段
});
