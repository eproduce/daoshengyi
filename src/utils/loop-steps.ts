/**
 * 工具循环的**步进决策**：这一轮的产出该「纠偏重来」还是「收尾交付」。
 *
 * ## 为什么值得单独抽出来
 *
 * 主循环里最容易出事的不是「调工具」，而是这一串**顺序敏感**的判定：
 * 计划纠偏 → 格式无效 → 有意图但未闭合 → 正文空洞 → 假完成。
 * 顺序错了会有真实后果，而且都在历史上出过：
 * - 「意图但未闭合」排在「正文空洞」前面，否则模型半截的 `<tool_call>` 会被当成空洞重试，
 *   永远补不上那个闭合标记；
 * - 「假完成」必须最后，且只警告一次——否则模型刚建完计划就被打断；
 * - 大 `write_file` 截断必须识别成「改成分段写」而不是「重试同样的大输出」，
 *   否则每次重试都在同一个 token 上限被砍断。
 *
 * 这些规则埋在 1,700 行的 async 函数里时**一条都测不了**，抽成纯函数后可以逐条钉住。
 */

import type { PlanNudgeReason } from "./loop-recovery";
import { planCoercionMessage } from "./loop-recovery";

/** 大文件写入被 max_tokens 截断时的分段写入指令（文本只此一份，避免两处措辞分叉） */
export const BIG_WRITE_SPLIT_HINT =
  "⚠️ 你上一次的工具调用/文件内容**因输出长度上限被截断**，内容只发了一半，**文件没有写入**；再一次性输出仍会被截断。\n" +
  "**改用分段写入（禁止一次塞整份文件）**：\n" +
  "① 先 `write_file` 写文件**开头部分**，末尾放唯一占位标记 `<!--MORE-->`（HTML 根标签 `<html>`/`</html>` 在本段内闭合，保证文件合法）；\n" +
  '② 用 `insert_string` 逐段追加：`{"path": 同一路径, "anchor": "<!--MORE-->", "position": "before", "new_text": "<下一段>\\n<!--MORE-->"}`；\n' +
  "③ 重复 ② 直到写完，最后一次 `new_text` 不要留 `<!--MORE-->`，让文件完整收尾。\n" +
  "每次工具调用的内容 ≤ 2500 字符。不要重试一次性大输出；生成大文件也可以改用 `run_command` 的 heredoc 落盘。";

/** 判定一段正文是否为「空洞的过程声明」（口头承诺要做某事，却没执行、也没给实质内容）。 */
export function isVagueBody(s: string): boolean {
  const sc = s.trim();
  if (sc.length === 0) return true; // 空正文
  if (/^###\s*(🔧|🌐)/.test(sc)) return true; // 仍被工具卡片/占位占用
  if (sc.length > 120) return false; // 长正文视为已有实质内容
  // 有列表/编号/冒号/表格/代码块等结构 → 视为有内容。
  // 注意：仅换行不算（agent 常只写个标题如「**检查页面元素**」就结束，仍是空洞）
  if (/^\s*[-•*]\s|\d+[.、]\s|[：]|:\s|\|.+\||```/.test(sc)) return false;
  // 短正文 + 第一人称/过渡词/延续词引导的「过程声明」（我/将/直接/继续/尝试/再…
  // 访问/获取/查…）或「结果无关」→ 空洞。纯建议（如「可访问官网查看最新政策」无
  // 引导词）不算空洞。
  return (
    /(我|将|准备|接下来|让我|直接|先|去|继续|尝试|再|重新).{0,12}(访问|获取|查看|打开|查询|搜索|查|输出|写|写入|整理|生成|拼|创建|保存|补全|重新输出)/.test(
      sc,
    ) || /无关|与问题不相关/.test(sc)
  );
}

/** 无工具调用时的下一步 */
export type NoToolStep =
  /** 任务模式但还没建计划 → 强制先 plan_task */
  | { kind: "plan-nudge"; reason: PlanNudgeReason; assistantText: string; userText: string }
  /** 有闭合标记但解析失败（空标记 / JSON 不合法 / 写成卡片文本） */
  | { kind: "invalid-format"; assistantText: string; userText: string }
  /** 有工具调用意图但没形成完整调用（未闭合 / 半截 / 流式截断） */
  | { kind: "call-intent"; assistantText: string; userText: string }
  /** 只写了过程声明，既没调工具也没给实质内容 */
  | { kind: "vague-body"; assistantText: string; userText: string }
  /** 任务模式建了计划但一次实际工作都没做（只警告一次） */
  | { kind: "fake-completion"; assistantText: string; userText: string }
  /** 没有可纠偏的问题 → 交给收尾（自动续跑规则表 / 最终答案） */
  | { kind: "finish" };

export interface NoToolInput {
  content: string;
  /** 当前轮次（0 基） */
  round: number;
  maxRounds: number;
  /** 是否处于任务模式 */
  taskMode: boolean;
  /** 是否已有任务计划 */
  hasPlan: boolean;
  /** 本轮是否已做过计划纠偏（至多一次） */
  planNudged: boolean;
  /** 本轮是否执行过实际工作类工具（非 plan_*） */
  didRealWork: boolean;
  /** 是否已就「假完成」警告过（至多一次） */
  fakeCompletionWarned: boolean;
  /** 正文里是否有**完整**的工具调用标记（由 tool-call 解析器判定） */
  hasCompleteCall: boolean;
  /** 正文里是否有工具调用**意图**（开标记/半截） */
  hasIntent: boolean;
}

const INVALID_FORMAT_HINT =
  "⚠️ 你上一条回复里的工具调用格式无效：要么是空的 <tool_call></tool_call>，要么 JSON 不合法，" +
  "要么写成了「### 🔧 调用工具」卡片文本——这些都**不会真正执行工具**。\n" +
  "请重新用**唯一合法格式**输出：\n" +
  '<tool_call>\n{"server":"文件系统","tool":"工具名","arguments":{...}}\n</tool_call>\n' +
  "JSON 必须是合法对象且含 server、tool、arguments 三个字段；不要写卡片文本，不要输出空标记。";

const INTENT_HINT =
  "⚠️ 你上一条回复想调用工具，但工具调用标记不完整/格式异常（未闭合、半截或乱码），" +
  "工具**没有真正执行**，回复因此中断。\n" +
  "请重新输出**完整合法**的工具调用：\n" +
  '<tool_call>\n{"server":"app","tool":"工具名","arguments":{...}}\n</tool_call>\n' +
  "必须是完整的开/闭合标记、JSON 合法且含 server、tool、arguments 字段。若确实不需要工具，直接在正文给出完整答案。";

const VAGUE_HINT =
  "⚠️ 你上一条回复只声明了『要做某事』（例如“访问官网获取信息”“接下来去查询”“搜索与问题无关，我直接…”），" +
  "既没有实际调用工具，也没有给出实质内容——这样的回复不算完成任务。\n" +
  "请二选一：\n" +
  "1) 若确实还需要信息：立即输出 <tool_call> 调用对应工具（如 fetch_page 抓取网页 / web_search 重新搜索）真正获取数据，再继续；\n" +
  "2) 若已有足够信息：直接在正文给出**完整、详细、结构化的最终回答**（结论 / 步骤 / 要点）。\n" +
  "不要只写过程声明，不要输出空 <tool_call>。";

const FAKE_COMPLETION_HINT =
  "⚠️ 你创建了任务计划，但到目前为止**还没有执行任何实际操作**（未调用任何文件/命令/测试/检索等工具），" +
  "不能算完成，更不要声称“全部完成”。\n" +
  "请二选一：\n" +
  "1) 真正去执行目标：调用相应工具（如 list_dir / read_file / write_file / run_command / run_tests / web_search 等）完成工作并验证结果；\n" +
  "2) 若确实无需任何工具即可回答，直接在正文给出完整答案并说明“无需工具即可完成”。";

/** `write_file` 把整份大内容塞进一次输出、被长度上限砍断的特征 */
export function looksLikeBigWriteTruncation(content: string): boolean {
  return /write_file/.test(content) && /"content"\s*:/.test(content) && content.length > 2000;
}

/**
 * 决定「这一轮没有工具调用」时该干什么。
 *
 * **顺序即语义**（改顺序会引入真 bug，见文件头）：计划纠偏 → 格式无效 → 意图未闭合
 * → 正文空洞 → 假完成 → 收尾。除计划纠偏外都要求「还有下一轮可用」。
 */
export function decideNoToolStep(input: NoToolInput): NoToolStep {
  const { content, round, maxRounds } = input;
  const hasNextRound = round + 1 < maxRounds;

  // ① 任务模式没建计划：先纠正规划，其他问题都往后放（没计划就干活的活都要重来）
  if (input.taskMode && !input.hasPlan && !input.planNudged) {
    return {
      kind: "plan-nudge",
      reason: "no-call",
      assistantText: content,
      userText: planCoercionMessage("no-call"),
    };
  }
  // ② 有闭合标记但解析失败：最容易"看起来正常"的失败（正文有内容、工具没执行）
  if (input.hasCompleteCall && hasNextRound) {
    return { kind: "invalid-format", assistantText: content, userText: INVALID_FORMAT_HINT };
  }
  // ③ 有意图但没形成调用：必须先于「正文空洞」，否则半截标记会被当成空洞反复重试
  if (input.hasIntent && hasNextRound) {
    return {
      kind: "call-intent",
      assistantText: content,
      userText: looksLikeBigWriteTruncation(content) ? BIG_WRITE_SPLIT_HINT : INTENT_HINT,
    };
  }
  // ④ 只写了过程声明
  if (isVagueBody(content) && hasNextRound) {
    return { kind: "vague-body", assistantText: content, userText: VAGUE_HINT };
  }
  // ⑤ 建了计划却一次实际工作都没做（只警告一次，避免打断刚开始执行的模型）
  if (input.taskMode && input.hasPlan && !input.didRealWork && !input.fakeCompletionWarned) {
    return { kind: "fake-completion", assistantText: content, userText: FAKE_COMPLETION_HINT };
  }
  return { kind: "finish" };
}

/** 原生 tool_calls 分支的下一步 */
export type NativeStep =
  /** 参数被 max_tokens 截断 → 不派发空参数调用，改注入分段写入指令 */
  | { kind: "truncated"; assistantText: string; userText: string }
  /** 任务模式没建计划就直接调了实际工具 → 丢掉本轮调用，强制先 plan_task */
  | { kind: "plan-nudge"; assistantText: string; userText: string }
  /** 正常派发 */
  | { kind: "invoke" };

export interface NativeInput {
  content: string;
  finishReason?: string | null;
  /** 其中被判为「参数被截断」的调用数 */
  truncatedCount: number;
  /** 本轮调用里是否已经包含 plan_task */
  hasPlanCall: boolean;
  taskMode: boolean;
  hasPlan: boolean;
  planNudged: boolean;
}

export function decideNativeStep(input: NativeInput): NativeStep {
  // 截断优先：这些调用的 arguments 是半截的，派发出去只会得到「缺参数」的无意义报错
  if (input.finishReason === "length" && input.truncatedCount > 0) {
    return { kind: "truncated", assistantText: input.content, userText: BIG_WRITE_SPLIT_HINT };
  }
  if (input.taskMode && !input.hasPlan && !input.planNudged && !input.hasPlanCall) {
    return {
      kind: "plan-nudge",
      assistantText: "",
      userText: planCoercionMessage("native-calls"),
    };
  }
  return { kind: "invoke" };
}
