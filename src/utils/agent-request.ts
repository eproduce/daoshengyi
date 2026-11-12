// 请求装配（history → 发给模型的消息数组）：把 `sendMessage` 里那段内联拼装抽成**纯函数**。
//
// ## 为什么抽出来
//
// `chat.ts::sendMessage` 有 7,900 行、零行为测试，而「模型看到什么」正是最难靠肉眼保证的部分。
// 这段装配原先内联在主循环里，因此无法单测 —— 而它恰好藏着两个真实不变量：
//   ① **前缀稳定**：system + 历史必须逐字稳定（否则提示词缓存失效、每轮都按全价计费）；
//      易变内容（记忆/RAG/时间）追加到**最后一条 user** 末尾，绝不进 system；
//   ② **模型可见即已记录**：进模型的东西必须能从会话重建 —— 所以老会话遗留的 UI 卡片
//      在这里剥掉（新数据已不含，见 `composeAssistantContent`）。
//
// 抽出来后 `origins`（每条消息对应的原始会话序号）与消息数组**同增同减**，
// 裁剪与「已被摘要覆盖」判定才有意义（原实现里 origins 是无条件 push 的，
// 当某条历史因为正文为空被跳过时，两个数组会错位 —— 这里顺手修掉）。

/** 发给模型的一条消息（content 允许字符串或多模态数组） */
export interface ModelMessage {
  role: string;
  content: unknown;
}

/** 装配时看到的会话消息（只依赖这几个字段，便于测试构造） */
export interface HistoryMessage {
  role: string;
  content: string;
  images?: readonly { base64: string }[];
  streaming?: boolean;
  /**
   * UI 卡片（`ChatMessage.tools`）会跟着真实消息一起传进来，但**绝不能进模型上下文**。
   * 声明成可选字段而不是剔除：装配函数要能直接吃 UI 消息（少一层映射），
   * 而「卡片不进正文」由 `modelVisibleContent` 从 `content` 里剥离（老数据兜底）。
   */
  tools?: readonly unknown[];
}

export interface AssembleOptions {
  /** 系统提示词（空则不注入） */
  systemPrompt?: string;
  /** 最近多少条历史（`maxContextMessages`） */
  maxContextMessages: number;
  /** 是否允许发送图片（DeepSeek 文本模型不支持，一律只发文本，避免 400） */
  supportsImages: boolean;
  /** 已压缩到多少条之前（>0 且摘要非空时生效） */
  compactBefore: number;
  compactSummary: string;
  /** 剥掉老数据里遗留的 UI 卡片（调用方注入，保持本模块零依赖） */
  modelVisibleContent: (m: HistoryMessage) => string;
}

export interface AssembledRequest {
  messages: ModelMessage[];
  /** 与 `messages` 一一对应；null = system / 摘要 / 注入，不来自历史 */
  origins: (number | null)[];
  /** 历史窗口的起点（原始会话序号），供上层日志/诊断 */
  histStart: number;
}

/**
 * 装配请求：system → （可选）压缩摘要 → 最近 N 条历史。
 *
 * 逐条语义（与改造前的内联实现一致）：
 * - 跳过 `role === "system"` 与仍在流式中的消息（流式内容还没定稿）；
 * - 已被压缩覆盖（`compactBefore` 之前）的历史不再逐条发送，由摘要替代；
 * - 允许图片且消息带图片 → 多模态 content 数组；否则只发文本；
 * - 正文清洗后为空的 assistant 消息**不发**（且不占 `origins` 位）。
 */
export function assembleRequest(
  history: readonly HistoryMessage[],
  opts: AssembleOptions,
): AssembledRequest {
  const messages: ModelMessage[] = [];
  const origins: (number | null)[] = [];

  const usable = history.filter((m) => m.role !== "system" && !m.streaming);
  const maxCtx = Math.max(1, opts.maxContextMessages || 50);
  const histStart = Math.max(0, usable.length - maxCtx);
  const win = usable.slice(histStart);

  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt });
    origins.push(null);
  }
  if (opts.compactBefore > 0 && opts.compactSummary) {
    messages.push({
      role: "user",
      content: `[已压缩的历史对话摘要（原始消息已从本次请求移除；需要细节可 read_file 已落盘产物）]\n${opts.compactSummary}`,
    });
    origins.push(null);
  }

  win.forEach((m, i) => {
    const seq = histStart + i;
    if (opts.compactBefore > 0 && seq < opts.compactBefore) return; // 已被摘要覆盖
    if (m.images?.length && opts.supportsImages) {
      messages.push({
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...m.images.map((img) => ({
            type: "image_url",
            image_url: { url: img.base64, detail: "auto" },
          })),
        ],
      });
      origins.push(seq);
      return;
    }
    const visible = opts.modelVisibleContent(m);
    if (!visible) return; // 空正文：不发，也不占 origins（否则两个数组错位）
    messages.push({ role: m.role, content: visible });
    origins.push(seq);
  });

  return { messages, origins, histStart };
}

/**
 * 把本次**易变上下文**（记忆 / RAG / 时间 / 续跑提示）追加到**最后一条 user 消息末尾**。
 *
 * 为什么不进 system：system + 历史是缓存前缀，一旦每轮都变，提示词缓存直接失效
 * （DeepSeek 的 cache_hit 会掉到 0，成本翻倍）。放在最后一条 user 里，前缀保持不变。
 *
 * 没有 user 消息时（极少见）补一条 —— 宁可多一条 user，也不能让易变内容无处安放。
 */
export function appendVolatileContext(
  messages: ModelMessage[],
  volatileCtx: readonly string[],
): ModelMessage[] {
  if (volatileCtx.length === 0) return messages;
  const block = `[本次补充上下文]\n${volatileCtx.join("\n\n")}`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      m.content = `${m.content}\n\n${block}`;
    } else {
      // 多模态 content：追加一个文本片段（OpenAI 兼容形状）
      m.content = [...(m.content as unknown[]), { type: "text", text: block }];
    }
    return messages;
  }
  messages.push({ role: "user", content: block });
  return messages;
}

/** 消息数组的字符总量（粗估上下文体积；不接受 `unknown` 以外的形态） */
export function totalMsgChars(msgs: readonly ModelMessage[]): number {
  return msgs.reduce((sum, m) => {
    const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + t.length;
  }, 0);
}

export interface PruneInput {
  messages: ModelMessage[];
  origins: (number | null)[];
  /** 已被自动摘要覆盖的原始消息序号 */
  covered: ReadonlySet<number>;
  maxChars: number;
}

/**
 * 超预算裁剪：**先删被摘要覆盖的最老段，仍超长再从最早的非 system 删**。
 *
 * 为什么分两相：摘要是对原文的**有损替代**，但至少保留了语义；粗暴裁剪是纯丢信息。
 * 所以先删「已经有摘要兜底」的那些，只在删尽仍超长时才退到粗暴裁剪。
 *
 * 不变量：system（第 0 条，若存在）永不删；至少保留 2 条（避免把对话裁成单条）。
 */
export function pruneToBudget({ messages, origins, covered, maxChars }: PruneInput): void {
  if (totalMsgChars(messages) <= maxChars) return;
  // 第一相：删「已被摘要覆盖」的最老段
  let pruned = true;
  while (totalMsgChars(messages) > maxChars && pruned && messages.length > 2) {
    pruned = false;
    for (let i = 1; i < messages.length; i++) {
      const seq = origins[i];
      if (seq !== null && covered.has(seq)) {
        messages.splice(i, 1);
        origins.splice(i, 1);
        pruned = true;
        break;
      }
    }
  }
  // 第二相：仍超长 → 从最早的非 system 删（保底不超限，不因超长中断回复）
  while (totalMsgChars(messages) > maxChars && messages.length > 2) {
    const idx = messages.findIndex((m) => m.role !== "system");
    if (idx === -1) break;
    messages.splice(idx, 1);
    origins.splice(idx, 1);
  }
}
