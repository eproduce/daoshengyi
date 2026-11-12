/**
 * 工具循环里的「纠偏与降级判定」。
 *
 * 这些判定原先散在 `chat.ts` 的 `sendMessage` 主循环里，是纯字符串/状态判断，
 * 却被埋在一个 1,700 行的 async 函数中，没有任何测试能触达。抽出来的动机不是整洁：
 *
 * - **降级判定错一次就会永久丢工具**（原生 tools 降成文本模式且不回滚），
 *   靠 `/tool|function/i` 这种宽匹配必然误伤「上下文超长」类错误
 *   （OpenAI 原文：`reduce the length of the messages or tools` —— 含 tools）；
 * - **任务模式护栏的话术有三份拷贝**，native/text/无调用三种场景措辞分叉，
 *   改一处忘两处就会让模型收到自相矛盾的指令。
 */

export type PlanNudgeReason =
  /** 原生路径：模型直接返回了实际工作的 tool_calls，跳过了规划 */
  | "native-calls"
  /** 文本路径：模型返回了实际工作工具调用，跳过了规划 */
  | "text-call"
  /** 两条路径都没有工具调用：模型在空想，没真正建计划 */
  | "no-call";

const PLAN_TASK_ARGS = '{"title":"目标标题","steps":["子步骤1","子步骤2",...]}';
/** 原生路径要强调「用原生工具调用」，否则模型会退回文本卡片语法。 */
const planTail = (verb: string) =>
  `请**立即**${verb} \`plan_task\` 为当前目标创建任务计划（参数 ${PLAN_TASK_ARGS}），` +
  "再用 `plan_update` 逐步标记进度并执行";

const PLAN_LEAD: Record<PlanNudgeReason, string> = {
  "native-calls": "你上一条直接要调用实际工作工具而跳过了规划。",
  "text-call": "你正准备执行实际工作而跳过了规划。",
  "no-call": "",
};

const PLAN_TAIL_BY_REASON: Record<PlanNudgeReason, string> = {
  "native-calls": `${planTail("用原生工具调用")}；在计划建立前**不要**调用其它实际工作工具。`,
  "text-call": `${planTail("调用")}；在计划建立前不要调用其它实际工作工具。`,
  "no-call": `${planTail("调用")}。不要继续空想。`,
};

/** 任务模式的「先建计划」纠偏指令：一句话说明为什么被拦，再给确定的下一步。 */
export function planCoercionMessage(reason: PlanNudgeReason): string {
  return `⚠️ 你处于【任务模式】，但还没有创建任务计划。${PLAN_LEAD[reason]}\n${PLAN_TAIL_BY_REASON[reason]}`;
}

/**
 * 本轮请求异常的分类。`degradeNativeTools` 表示「端点/模型根本不支持 tools」，
 * 这是唯一该降级为文本工具语法的情形。
 */
export type RoundErrorKind =
  "native-unsupported" | "context-overflow" | "transient" | "auth" | "other";

export interface RoundErrorVerdict {
  kind: RoundErrorKind;
  degradeNativeTools: boolean;
}

/** 上下文超长：换什么语法都救不了，且通常含 "tools" 字样，必须先排除。 */
const CONTEXT_OVERFLOW_RE =
  /maximum context length|context[ _]length|too many tokens|exceeds? the (?:maximum|model'?s)|reduce the length|prompt is too long|input is too long|超出.*长度|上下文.*(?:超|过长)/i;

/** 可重试的网络/服务端抖动：降级毫无帮助，原样抛出交给上层。 */
const TRANSIENT_RE =
  /\b429\b|rate[ _]?limit|too many requests|\b5\d\d\b|overload|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|network error|服务繁忙/i;

/** 鉴权/额度：降级只会掩盖真因。 */
const AUTH_RE =
  /\b401\b|\b403\b|unauthori[sz]ed|invalid[ _]api[ _]key|incorrect api key|insufficient|quota|余额|额度/i;

/**
 * 端点/模型明确拒绝 tools：这些才是「换个调用方式还能继续」的情形。
 * 刻意只匹配**明确的拒绝语义**，不做 `tool` 单词的裸匹配。
 */
const UNSUPPORTED_RE = new RegExp(
  [
    "does not support (?:tools?|function)",
    "tool[s]? (?:is|are) not supported",
    "unsupported (?:parameter|value).*tools?",
    "(?:function|tool)[ _]?calling is not supported",
    "no tools? support",
    "tools? not (?:enabled|allowed)",
    "invalid[ _]request_error.*tools?",
    "不支持.*(?:工具|tool)",
    // 有些网关把「不认识 tools 字段」报成参数校验失败
    "unknown (?:field|parameter).*tools?",
  ].join("|"),
  "i",
);

/**
 * 判断某轮异常是否应触发「原生 tools → 文本模式」降级。
 *
 * 优先级很重要：上下文超长 / 抖动 / 鉴权都**不降级**（它们常含 `tool`/`function`
 * 字样，宽匹配会误判）。只有在排除这些之后，仍能匹配到明确「不支持 tools」时才降级。
 */
export function classifyRoundError(message: string): RoundErrorVerdict {
  const m = (message ?? "").trim();
  if (!m) return { kind: "other", degradeNativeTools: false };
  if (CONTEXT_OVERFLOW_RE.test(m)) return { kind: "context-overflow", degradeNativeTools: false };
  if (UNSUPPORTED_RE.test(m)) return { kind: "native-unsupported", degradeNativeTools: true };
  if (AUTH_RE.test(m)) return { kind: "auth", degradeNativeTools: false };
  if (TRANSIENT_RE.test(m)) return { kind: "transient", degradeNativeTools: false };
  // 兜底：只认「明确提到 tools/function 的 400 参数错误」，其余交给上层重试。
  if (/\b400\b/.test(m) && /tool|function/i.test(m)) {
    return { kind: "native-unsupported", degradeNativeTools: true };
  }
  return { kind: "other", degradeNativeTools: false };
}
