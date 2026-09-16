/**
 * 密钥 / 凭据脱敏（吸收自 DSH 生态的 dsh-secret-redactor · secret-guard · dsh-mask · dsh-redaction）。
 *
 * 为什么必须在「进上下文之前」做：工具结果是不可信文本（网页、命令输出、日志、MCP 返回），
 * 里面可能夹带 `sk-...`、`ghp_...`、Bearer 头、私钥块、带密码的连接串。一旦回填给模型，
 * 就同时进入了 ①上下文（可能被转发给第三方端点）②应用日志 ③落盘的工具结果文件。
 *
 * 设计原则：
 * - 只掩码「高置信度凭据形态」，不误伤普通文本（UUID、git sha、纯数字统计、路径）。
 * - 保留少量前缀便于排查（如 `sk-***`），中间一律替换为 `***`。
 * - 纯函数、可测试、可关闭（设置项）。
 */

export interface SecretRule {
  kind: string;
  re: RegExp;
  replace: string;
}

/** 规则顺序敏感：先处理「上下文更具体」的形态，再处理宽泛的键值对 */
export const SECRET_RULES: SecretRule[] = [
  {
    kind: "pem-private-key",
    re: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
    replace: "[已脱敏：私钥内容]",
  },
  {
    kind: "url-basic-auth",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]{3,})@/gi,
    replace: "$1:***@",
  },
  {
    kind: "authorization-header",
    re: /\b(authorization\s*[:=]\s*)(?:bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "$1***",
  },
  {
    kind: "openai-style-key",
    re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replace: "sk-***",
  },
  {
    kind: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: "gh-***",
  },
  {
    kind: "aws-access-key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: "AKIA***",
  },
  {
    kind: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: "xox-***",
  },
  {
    kind: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: "AIza***",
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: "[已脱敏：JWT]",
  },
  {
    // 键值形态：要求值 ≥16 位、且同时含字母与数字（避免误伤 token 计数、路径、纯数字 ID）
    kind: "key-value-secret",
    re: /\b(api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|access[_-]?key|secret|password|passwd|pwd)\b(\s*[:=]\s*)(["'`]?)(?=[A-Za-z0-9_\-./+=]{16,})(?=[^\s"'`]*[A-Za-z])(?=[^\s"'`]*[0-9])[A-Za-z0-9_\-./+=]{16,}\3/gi,
    replace: "$1$2$3***$3",
  },
];

export interface RedactResult {
  text: string;
  /** 命中的规则种类（去重），便于面板提示「本次脱敏了 N 类凭据」 */
  kinds: string[];
  /** 命中次数 */
  hits: number;
}

/**
 * 脱敏。enabled=false 时原样返回（设置项可关闭）。
 * 注意：返回值同时用于「回填模型」「写日志」「落盘」，调用方不要再拿原始文本落盘。
 */
export function redactSecrets(input: string, enabled = true): RedactResult {
  const text = String(input ?? "");
  if (!enabled || !text) return { text, kinds: [], hits: 0 };
  let out = text;
  const kinds: string[] = [];
  let hits = 0;
  for (const rule of SECRET_RULES) {
    // 每次使用前重置 lastIndex（规则对象是共享常量，带 g 的正则是有状态的）
    rule.re.lastIndex = 0;
    const before = out;
    out = out.replace(rule.re, rule.replace);
    rule.re.lastIndex = 0;
    if (out !== before) {
      kinds.push(rule.kind);
      // 命中次数：用「原文本命中数」近似统计（替换后无法直接计数）
      const m = before.match(rule.re);
      hits += m ? m.length : 1;
    }
  }
  return { text: out, kinds, hits };
}

/** 便捷断言：文本中是否含疑似凭据（用于日志/审计，不修改文本） */
export function containsSecret(input: string): boolean {
  return redactSecrets(input, true).hits > 0;
}
