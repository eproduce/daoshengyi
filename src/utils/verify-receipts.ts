/**
 * 验证凭据（吸收自 DSH 生态的 pavangupta352/dstalegreen「verification receipts」、
 * bpc-oss/dsh-verification「完成门禁需真实工具证据」、PerryLink/dsh-doublecheck）。
 *
 * 要解决的问题：模型最伤信任的失败模式是**声称「测试通过 / 构建成功 / lint 干净」但实际没跑过**，
 * 或**跑完之后又改了代码**（结论已过期）。靠提示词反复叮嘱是无效的（属于「靠提醒别忘」），
 * 必须做成**代码门禁**：把真实执行过的验证命令记成「凭据」，回合收尾时用凭据校验断言。
 *
 * 三层信息：
 * - `classifyVerificationCommand(cmd)`：这条命令属于哪类验证（test / typecheck / lint / build）
 * - `noteVerification(...)`：本回合真实跑过一条验证命令（含成功与否、当时的文件改动计数）
 * - `evaluateVerificationClaims(text)`：正文里的「通过/成功」断言，是否被**新鲜**凭据支撑
 *
 * 判定三态：missing（根本没跑）/ failed（最近一次是失败）/ stale（跑完之后又改过文件）。
 * 本模块持有回合内的模块级凭据表（应用同一时刻只有一条主对话流），纯逻辑函数全部可单测。
 */

export type VerificationKind = "test" | "typecheck" | "lint" | "build";

export interface VerificationReceipt {
  kind: VerificationKind;
  ok: boolean;
  command: string;
  at: number;
  /** 记录时的文件改动计数——用于判断「之后是否又改过代码」 */
  mutationSeq: number;
}

export type VerificationStatus = "missing" | "failed" | "stale";

export interface VerificationIssue {
  kind: VerificationKind;
  status: VerificationStatus;
  label: string;
  /** 可直接注入模型的纠偏指令 */
  notice: string;
}

export const VERIFICATION_LABEL: Record<VerificationKind, string> = {
  test: "测试",
  typecheck: "类型检查",
  lint: "Lint",
  build: "构建",
};

/** 建议模型执行的代表性命令（纠偏提示里给出，避免它不知道跑什么） */
const SAMPLE_COMMAND: Record<VerificationKind, string> = {
  test: "npm test",
  typecheck: "npx vue-tsc --noEmit",
  lint: "npx eslint .",
  build: "npx vite build",
};

/** 会改动工作区的工具：它们之后，之前的验证凭据即失效 */
export const MUTATION_TOOLS = new Set([
  "write_file",
  "create_file",
  "replace_string",
  "insert_string",
  "apply_patch",
  "apply_edits",
  "delete_file",
  "str_replace_editor",
]);

/** 命令 → 验证类别。顺序敏感：build 放最后（`tsc -p` 更像类型检查，`npm run build` 才是构建） */
const COMMAND_RULES: { kind: VerificationKind; re: RegExp }[] = [
  {
    kind: "test",
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest)\b|\b(?:vitest|jest|pytest|mocha|ava)\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+(?:test|verify)\b|gradlew?\s+test\b|\bdotnet\s+test\b|\brake\s+test\b/i,
  },
  {
    kind: "typecheck",
    re: /\b(?:vue-tsc|tsc)\b|\btype-?check\b|\bmypy\b|\bpyright\b|\bcargo\s+check\b|\bgo\s+vet\b|\bdotnet\s+build\s+--no-restore\b/i,
  },
  {
    kind: "lint",
    re: /\beslint\b|\bcargo\s+clippy\b|\bclippy\b|\bruff\s+check\b|\bflake8\b|\bpylint\b|\bprettier\s+--check\b|\bgolangci-lint\b/i,
  },
  {
    kind: "build",
    re: /\bvite\s+build\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b|\bwebpack\b|\bdotnet\s+build\b|\bgradlew?\s+(?:build|assemble)\b|\bxcodebuild\b/i,
  },
];

/** 识别命令属于哪类验证；不是验证命令则返回 null */
export function classifyVerificationCommand(command: string): VerificationKind | null {
  const cmd = String(command ?? "");
  if (!cmd.trim()) return null;
  for (const rule of COMMAND_RULES) {
    if (rule.re.test(cmd)) return rule.kind;
  }
  return null;
}

interface ClaimRule {
  kind: VerificationKind;
  re: RegExp;
}

/**
 * 正文里的「验证通过」断言。句子级匹配 + 否定/假设过滤，避免把
 * 「若测试通过就…」「测试未通过」「尚未运行测试」误判成断言。
 */
const CLAIM_RULES: ClaimRule[] = [
  {
    kind: "test",
    re: /(?:测试|单测|用例|集成测试|回归测试)(?:用例)?\s*(?:已|全部|均|都|全部已)?\s*(?:通过|全绿|跑通|正常)|\btests?\s+(?:all\s+)?(?:pass|passed|are\s+green)\b|\ball\s+\d+\s+tests?\s+pass|\b\d+\s*\d*\s*tests?\s+passed\b|\btest\s+suite\b[^。.;]{0,16}\bpass/i,
  },
  {
    kind: "typecheck",
    re: /类型(?:检查)?\s*(?:已)?\s*(?:通过|无错误|无误|干净)|\btype-?check(?:ing)?\s+(?:clean|passes|passed|green)\b|\bno\s+type\s+errors\b|\btypes?\s+(?:are\s+)?(?:clean|fine|ok)\b/i,
  },
  {
    kind: "lint",
    re: /\blint\s*(?:已)?\s*(?:通过|干净|清洁|无(?:错误|告警|警告))|\b(?:eslint|clippy|ruff|pylint)\b[^。.;]{0,12}(?:通过|干净|无(?:错误|告警|警告)|clean|pass(?:ed)?)|\blint\s+(?:clean|passes|passed)\b|\bno\s+lint\s+(?:errors|warnings)\b/i,
  },
  {
    kind: "build",
    re: /(?:构建|编译)\s*(?:已)?\s*(?:成功|通过|完成|无报错)|\bbuild\s+(?:succeeded|successful|passes|passed|clean)\b|\bbuilds?\s+(?:fine|ok)\b/i,
  },
];

/** 否定/假设语境：命中则该句不算断言 */
const NEGATION_RE =
  /(?:尚未|还未|还没|没有|未曾|未)\s*(?:运行|执行|跑|做|进行)?\s*(?:过)?\s*(?:测试|类型检查|lint|构建|验证)|(?:未|不|没有)通过|测试失败|构建失败|lint\s*(?:报错|失败)|\b(?:failed|failing|failure|fails)\b|如果|若|假设|预计|应当会|应该会|将会|\?|？/i;

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/[。！!；;\n]+|(?<=[a-z0-9%)\]])\.\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 抽取正文中「声称验证通过」的验证类别（去重，保持出现顺序） */
export function detectVerificationClaims(text: string): VerificationKind[] {
  const found: VerificationKind[] = [];
  for (const sentence of splitSentences(text)) {
    if (NEGATION_RE.test(sentence)) continue;
    for (const rule of CLAIM_RULES) {
      if (found.includes(rule.kind)) continue;
      if (rule.re.test(sentence) && !found.includes(rule.kind)) found.push(rule.kind);
    }
  }
  return found;
}

/** 纯函数：给定断言、凭据表与当前改动计数，返回第一个未被支撑的问题 */
export function findVerificationIssue(
  claims: VerificationKind[],
  receipts: VerificationReceipt[],
  mutationSeq: number,
): VerificationIssue | null {
  for (const kind of claims) {
    const list = receipts.filter((r) => r.kind === kind);
    const label = VERIFICATION_LABEL[kind];
    if (list.length === 0) {
      return {
        kind,
        status: "missing",
        label,
        notice:
          `⚠️ 你在回复中声称「${label}通过」，但本回合**没有任何真实的${label}凭据**（没有执行过${label}命令，或执行结果不是通过）。\n` +
          "请二选一：\n" +
          `1) 立即真实执行并据结果作答：用 run_command 执行 \`${SAMPLE_COMMAND[kind]}\`（或 run_tests，参数 {"cwd":"<项目目录>"}），把真实输出作为结论依据；\n` +
          `2) 如果确实没有验证过，请**删掉「通过/成功/全绿」这类断言**，如实说明（如「改动已完成，尚未运行${label}」）。\n` +
          "不要用未经验证的结论收尾——这比说明「未验证」严重得多。",
      };
    }
    const last = list[list.length - 1];
    if (!last.ok) {
      return {
        kind,
        status: "failed",
        label,
        notice:
          `⚠️ 你声称「${label}通过」，但本回合最近一次${label}是**失败**的（命令：\`${last.command}\`）。\n` +
          `不能声称通过。请：① 按失败输出修复后重新运行并展示结果；或 ② 如实说明当前失败状态与原因。`,
      };
    }
    if (last.mutationSeq < mutationSeq) {
      return {
        kind,
        status: "stale",
        label,
        notice:
          `⚠️ 你声称「${label}通过」，但那次${label}之后你**又修改了文件**（${mutationSeq - last.mutationSeq} 次改动），结论已过期、不可作为验收凭据。\n` +
          `请重新运行 \`${last.command}\` 确认仍然通过后再给出结论；若不想重跑，请删掉该断言并说明「改动后尚未重新验证」。`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- 回合内凭据表

let receipts: VerificationReceipt[] = [];
let mutationSeq = 0;

/** 回合开始（sendMessage 进入本轮）时重置 */
export function resetVerificationReceipts(): void {
  receipts = [];
  mutationSeq = 0;
}

/** 记录一条真实执行过的验证命令 */
export function noteVerification(
  kind: VerificationKind | null,
  ok: boolean,
  command: string,
  at = Date.now(),
): void {
  if (!kind) return;
  receipts.push({ kind, ok, command, at, mutationSeq });
}

/** 记录一次文件改动（使此前的验证凭据过期） */
export function noteMutation(): void {
  mutationSeq++;
}

export function currentMutationSeq(): number {
  return mutationSeq;
}

export function getVerificationReceipts(): VerificationReceipt[] {
  return receipts.slice();
}

/** 便捷入口：正文 + 当前凭据 → 问题（无问题返回 null） */
export function evaluateVerificationClaims(text: string): VerificationIssue | null {
  const claims = detectVerificationClaims(text);
  if (claims.length === 0) return null;
  return findVerificationIssue(claims, receipts, mutationSeq);
}
