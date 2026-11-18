/**
 * 成员信箱的消费逻辑（纯函数）。
 *
 * ## 为什么消费逻辑要单独抽出来
 *
 * 信箱最容易写坏的地方是**什么时候读、读完之后还留不留**：
 * - 读到一半又来了新消息 → 如果按「把所有未读都标成已读」写库，新来的会被静默吞掉；
 * - 同一批消息被消费两次 → 成员会重复执行同一件事；
 * - 把消息塞进历史中段 → 破坏「请求前缀稳定」，提示词缓存全部失效（成本直接翻倍）。
 *
 * 所以这里的规则是纯函数：**只取本回合要注入的那一批，并返回它们的 id**，
 * 由调用方在写库时按 id 标记（而不是「标记全部未读」）。
 */

export interface MailMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  kind: string;
  content: string;
  created_at: number;
}

export interface MailBatch {
  /** 本回合要注入的文本（空串表示没有消息） */
  text: string;
  /** 需要标记为已读的 id（只包含本批） */
  ids: number[];
}

/** 单条消息注入时的长度上限（太长会把最后一条 user 挤爆，也淹没有效信息） */
const MAX_PER_MESSAGE = 1200;
/** 本回合最多注入几条（其余留到下一回合，绝不在中段插入） */
export const MAX_PER_TURN = 6;

/**
 * 组装本回合的信箱注入文本。
 *
 * @param messages 未读消息（已按时间正序）
 * @param selfName 收件人（用于标注「谁发给你的」；`main` 表示主代理）
 */
export function composeMailBatch(
  messages: readonly MailMessage[],
  selfName: string,
  max = MAX_PER_TURN,
): MailBatch {
  const take = messages.slice(0, Math.max(0, max));
  if (!take.length) return { text: "", ids: [] };
  const lines = take.map((m) => {
    const body = m.content.replace(/\s+/g, " ").trim().slice(0, MAX_PER_MESSAGE);
    return `- [${m.kind}] 来自 ${m.from_agent}：${body}`;
  });
  const rest = messages.length - take.length;
  const text =
    `【成员信箱】你有 ${take.length} 条新消息` +
    (selfName ? `（收件人：${selfName}）` : "") +
    `。这些是**异步留言**，不代表用户当前发言；需要时据此调整，不必逐条回复。\n` +
    lines.join("\n") +
    (rest > 0 ? `\n（另有 ${rest} 条未读，留到下一回合）` : "");
  return { text, ids: take.map((m) => m.id) };
}

/** 单条消息的展示行（`agent_inbox` 工具用） */
export function formatMail(m: MailMessage): string {
  const when = new Date(m.created_at);
  const p = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}`;
  return `- #${m.id} ${stamp} ｜ ${m.from_agent} → ${m.to_agent} ｜ [${m.kind}] ${m.content.slice(0, 300)}`;
}

/** 允许的消息类型（写错时给可读错误，而不是存进一个没人认识的 kind） */
export const MAIL_KINDS = ["task", "question", "answer", "note", "result"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export function normalizeMailKind(raw: unknown): MailKind {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (MAIL_KINDS as readonly string[]).includes(k) ? (k as MailKind) : "note";
}
