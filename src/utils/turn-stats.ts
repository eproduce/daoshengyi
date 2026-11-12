// 一轮（turn）里的工具成败统计：给收尾规则表与停滞中止提供事实。
//
// ## 为什么从 `chat.ts` 抽出来
//
// 原来这五个变量是**模块级全局**（`turnToolOk / turnToolFail / turnFailedTools /
// turnFailStreak / turnStuck`），被所有工具调用路径共享 —— 包括**并行子代理**里的工具调用
// （`subagent_parallel` 的子循环同样走 `callToolStoppable`）。后果是双向污染：
//   - 子代理失败会累加主回合的失败数 → 收尾规则可能误判「全军覆没」；
//   - 子代理的「同一错误反复失败」会打断**主回合**（`stuck` 一旦置位就中止）；
//   - 反过来主回合的计数也会被子代理的成功冲淡，「失败数」不再可解释。
//
// 抽成**可实例化的作用域**（每个回合 / 每个子代理各一个），跨代理串扰从结构上消失。
// 内部只用 `bumpFailureStreak`（纯函数、已单测），因此这里也可以直接单测。

import { bumpFailureStreak } from "./failure-ledger";

/** 停滞信息：哪个工具、什么病因、失败了几次 */
export interface StuckInfo {
  tool: string;
  signature: string;
  count: number;
}

export interface TurnStatsOptions {
  /** 首次判定停滞时回调（用于打日志/给用户看；只触发一次） */
  onStuck?: (info: StuckInfo) => void;
}

export interface TurnStats {
  /** 成功次数（真实工作工具，含子代理内部的调用） */
  readonly ok: number;
  /** 失败次数 */
  readonly fail: number;
  /** 失败过的工具名（按发生顺序，可重复） */
  readonly failedTools: readonly string[];
  /** 已判定停滞（非空 → 收尾要如实告知「被卡住了」） */
  readonly stuck: StuckInfo | null;
  /** 记一次成功 */
  noteOk(): void;
  /** 记一次失败；首次达到停滞阈值时返回该信息（便于调用方立即收尾） */
  noteFail(tool: string, errorText: unknown): StuckInfo | null;
  /** 回合开始/结束时重置 */
  reset(): void;
}

/**
 * 创建一份独立的回合统计。
 *
 * 注意「停滞」是**粘性**的：一旦判定，本回合不再重复回调，也不会因为后续成功而清除 ——
 * 语义是「这个回合已经被判定卡住了」（清除只发生在 `reset()`）。
 */
export function createTurnStats(opts: TurnStatsOptions = {}): TurnStats {
  let ok = 0;
  let fail = 0;
  let failedTools: string[] = [];
  const streak = new Map<string, number>();
  let stuck: StuckInfo | null = null;

  return {
    get ok() {
      return ok;
    },
    get fail() {
      return fail;
    },
    get failedTools() {
      return failedTools;
    },
    get stuck() {
      return stuck;
    },
    noteOk() {
      ok++;
    },
    noteFail(tool: string, errorText: unknown) {
      fail++;
      failedTools.push(tool);
      let hit: StuckInfo | null = null;
      try {
        const r = bumpFailureStreak(streak, tool, errorText);
        if (r.stuck && !stuck) {
          stuck = { tool, signature: r.signature, count: r.count };
          hit = stuck;
          opts.onStuck?.(stuck);
        }
      } catch {
        // 统计只是护栏：自己出错绝不能让主流程挂掉
      }
      return hit;
    },
    reset() {
      ok = 0;
      fail = 0;
      failedTools = [];
      streak.clear();
      stuck = null;
    },
  };
}

/** 工具返回「字符串形式的错误」（内置工具普遍以 ⛔/❌ 开头）也算失败 */
export function looksLikeToolError(text: unknown): boolean {
  return /^(?:\s*)(?:⛔|❌)/.test(String(text ?? ""));
}
