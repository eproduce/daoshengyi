// 待发消息队列的纯操作（与 Pinia / UI 解耦，便于单测）。
//
// ## 背景
//
// agent 正在生成/执行（isStreaming）时用户仍可发送消息：新消息先入队，当前轮彻底结束后
// 自动逐条发出（串行、不打断）。但**入队之后必须能撤回或取回编辑**——否则发错内容只能
// 眼睁睁等它被发出（2026-10-09 用户反馈「排队的用户消息没法撤回也没法修改」）。
//
// 这两步操作都要求：① 不可变（返回新数组，避免 Vue 响应式丢失更新）；② 越界安全
// （队列在「取出队首自动发送」时会变短，UI 里的下标可能已过期）。

/** 移除第 `index` 项（越界则原样返回） */
export function queueRemoveAt<T>(list: readonly T[], index: number): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return [...list];
  return list.filter((_, i) => i !== index);
}

/** 取出第 `index` 项：返回 `{ item, list }`（list 为移除后的新数组）；越界返回 `null` */
export function queueTakeAt<T>(list: readonly T[], index: number): { item: T; list: T[] } | null {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  return {
    item: list[index],
    list: list.filter((_, i) => i !== index),
  };
}
