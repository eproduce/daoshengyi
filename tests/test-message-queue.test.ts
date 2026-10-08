import { describe, it, expect } from "vitest";
import { queueRemoveAt, queueTakeAt } from "../src/utils/message-queue";

/**
 * 回归防线（2026-10-09 用户反馈「排队的用户消息没法撤回也没法修改」）：
 * 忙碌时提交的消息会进待发队列，用户必须能**撤回**（本条不再发送）或**取回编辑**
 * （移除并回填输入框）。两个操作的要求：
 *   ① **不可变**——返回新数组，否则 Vue 响应式视图不更新（队列条数/内容不刷新）；
 *   ② **越界安全**——队列会在「回复结束后自动取出队首」时变短，UI 里的下标可能已过期，
 *      越界不能抛异常、不能误删别的消息。
 */
describe("待发消息队列：撤回 / 取回编辑（纯函数）", () => {
  const list = ["第一条", "第二条", "第三条"];

  it("queueRemoveAt：撤回任意一条（首/中/尾）", () => {
    expect(queueRemoveAt(list, 0)).toEqual(["第二条", "第三条"]);
    expect(queueRemoveAt(list, 1)).toEqual(["第一条", "第三条"]);
    expect(queueRemoveAt(list, 2)).toEqual(["第一条", "第二条"]);
  });

  it("queueRemoveAt：越界/非法下标原样返回（不抛、不误删）", () => {
    expect(queueRemoveAt(list, 3)).toEqual(list);
    expect(queueRemoveAt(list, -1)).toEqual(list);
    expect(queueRemoveAt(list, 1.5)).toEqual(list);
    expect(queueRemoveAt([], 0)).toEqual([]);
    expect(queueRemoveAt(list, Number.NaN)).toEqual(list);
  });

  it("queueTakeAt：取出并返回剩余队列（用于回填输入框）", () => {
    expect(queueTakeAt(list, 1)).toEqual({ item: "第二条", list: ["第一条", "第三条"] });
    expect(queueTakeAt(list, 0)).toEqual({ item: "第一条", list: ["第二条", "第三条"] });
  });

  it("queueTakeAt：越界返回 null（调用方据此不改输入框）", () => {
    expect(queueTakeAt(list, 3)).toBeNull();
    expect(queueTakeAt(list, -1)).toBeNull();
    expect(queueTakeAt([], 0)).toBeNull();
  });

  it("两者都不修改原数组（响应式更新依赖新数组）", () => {
    const snapshot = [...list];
    queueRemoveAt(list, 1);
    queueTakeAt(list, 0);
    expect(list).toEqual(snapshot);
    expect(queueRemoveAt(list, 1)).not.toBe(list);
  });

  it("附件/图片原样带走（取回编辑时不能丢附件）", () => {
    const q = [{ text: "带附件", images: [{ id: "i1" }], files: [{ id: "f1" }] }, { text: "次条" }];
    const taken = queueTakeAt(q, 0);
    expect(taken?.item.images).toEqual([{ id: "i1" }]);
    expect(taken?.item.files).toEqual([{ id: "f1" }]);
    expect(taken?.list).toEqual([{ text: "次条" }]);
  });
});
