// 命令执行门禁（审批链）：把「策略 → 语义风险 → 审批模式」三段判定收敛成一个可测的纯编排。
//
// ## 为什么抽出来
//
// 这条链**原来有两份拷贝**，而且已经不一致：
// - Agent 调 `run_command`：`chat.ts::gateAgentCommand`（策略 deny / forbidden / 会话授权 /
//   三档审批，拒绝话术是写给**模型**的「请改用更安全的命令」）；
// - 用户输入 `/run`：`chat.ts` 里一段内联复制（同样的策略与风险判定，但话术是给**人**的，
//   也没有 forbid 级别与 session permit 的判断）。
//
// 两份拷贝意味着「改了一处、漏了另一处」——安全判定上这是最不该有的形态。抽成一份编排后：
// 依赖（IPC / 弹窗 / 辅助模型判断 / 设置）全部**注入**，因此能单测每一条分支；
// `actor` 只决定**拒绝话术的受众**（模型 or 人），判定逻辑完全共享。

import type { RiskVerdict } from "./danger-rules";

export type ApprovalMode = "manual" | "smart" | "yolo" | "on-failure";

/** 拒绝时给谁看：`agent` → 模型（要告诉它怎么改）；`user` → 人（说明为什么没执行） */
export type GateActor = "agent" | "user";

export interface CommandPolicy {
  decision: string;
  matched: string | null;
}

/** 门禁依赖（全部可注入 → 编排逻辑可单测，不碰 Tauri / 弹窗 / 模型） */
export interface CommandGateDeps {
  /** 命令执行策略（execpolicy）：查询失败由实现方返回 null（按未命中处理） */
  checkPolicy(command: string): Promise<CommandPolicy | null>;
  /** 语义风险分级（纯函数 `assessCommandRisk`） */
  riskOf(command: string): RiskVerdict;
  /** 风险描述（纯函数 `describeRisk`） */
  describeRisk(verdict: RiskVerdict, command: string): string;
  /** 本会话是否已授权「命令执行」（request_permissions） */
  hasPermit(tool: string): boolean;
  approvalMode(): ApprovalMode;
  askConfirm(text: string): Promise<boolean>;
  /** 辅助模型判断（smart 档）；失败/不可用时由实现方保守返回 false */
  judgeSafety(command: string): Promise<boolean>;
}

export type GateResult =
  | { decision: "allow" }
  /** `message` 为空 = 用户自己取消，不必再通知 */
  | { decision: "deny"; message: string };

/** 需要人工确认的判定（策略 prompt 优先；风险 + 非 allow 策略 + 无会话授权） */
export function needsConfirm(policyDecision: string, risky: boolean, permitted: boolean): boolean {
  return policyDecision === "prompt" || (risky && policyDecision !== "allow" && !permitted);
}

/**
 * 跑一次门禁。顺序**固定**（改动前两份拷贝的顺序也一致）：
 * ① 策略 deny（最高优先级，连语义判定都不做）
 * ② forbidden 语义风险（绝不执行）
 * ③ 是否需要确认 → 按审批模式（manual / smart / yolo / on-failure）
 *
 * `manual` 拒绝 / `smart` 判危且拒绝 → deny（带话术）；其余放行。
 * `on-failure`：此处一律放行，失败后由调用方升级询问（Codex 的 OnFailure 语义）。
 */
export async function runCommandGate(
  command: string,
  actor: GateActor,
  deps: CommandGateDeps,
): Promise<GateResult> {
  const policy = await deps.checkPolicy(command).catch(() => null);
  const policyDecision = policy?.decision ?? "none";

  if (policyDecision === "deny") {
    const matched = policy?.matched ?? "?";
    return {
      decision: "deny",
      message:
        actor === "agent"
          ? `⛔ 命令被「命令执行策略」拦截（命中：\`${matched}\`）：$ ${command}\n此类破坏性命令不允许 Agent 执行；若确需，请让用户手动输入 /run 或调整 设置→权限→命令执行策略。`
          : `⛔ 命令被「命令执行策略」拦截：\n\n$ ${command}\n\n命中规则：\`${matched}\`\n\n可在 设置→权限→命令执行策略 中调整规则。`,
    };
  }

  const risk = deps.riskOf(command);
  if (risk.level === "forbidden") {
    return {
      decision: "deny",
      message: `${deps.describeRisk(risk, command)}\n\n（该命令不会被执行。请改用安全替代方案，或由用户手动执行。）`,
    };
  }

  // forbidden 已在上面直接拒绝；这里只剩 danger 需要考虑
  const risky = risk.level === "danger";
  const confirm = needsConfirm(policyDecision, risky, deps.hasPermit("run_command"));
  if (!confirm) return { decision: "allow" };

  const mode = deps.approvalMode();
  if (mode === "manual") {
    const ok = await deps.askConfirm(
      actor === "agent"
        ? `⚠️ Agent 想执行一条危险命令，请确认：\n\n$ ${command}${riskLine(risk)}\n\n（拒绝后 Agent 会改用更安全的方式）`
        : `⚠️ 检测到危险命令：\n\n$ ${command}${riskLine(risk)}\n\n确定要执行吗？`,
    );
    if (ok) return { decision: "allow" };
    return {
      decision: "deny",
      message:
        actor === "agent"
          ? `（未获授权：危险命令 $ ${command} 被用户拒绝${risk.level === "danger" ? `（风险项：${risk.title}）` : ""}，请改用更安全的命令，或请用户手动执行）`
          : "",
    };
  }

  if (mode === "smart") {
    const safe = await deps.judgeSafety(command);
    if (safe) return { decision: "allow" }; // 判定安全 → 自动放行
    const ok = await deps.askConfirm(
      actor === "agent"
        ? `⚠️ 智能审批判定该命令有风险，Agent 请求执行：\n\n$ ${command}${riskLine(risk)}\n\n是否仍允许？`
        : `⚠️ 智能审批判定该命令存在风险：\n\n$ ${command}${riskLine(risk)}\n\n确定仍要执行吗？`,
    );
    if (ok) return { decision: "allow" };
    return {
      decision: "deny",
      message: actor === "agent" ? `（未获授权：危险命令 $ ${command} 被拒绝）` : "",
    };
  }

  // yolo / on-failure → 自动放行（on-failure 的升级询问在命令失败后由调用方触发）
  return { decision: "allow" };
}

/** 危险项的补充说明（只对 danger 级展示；forbidden 已在前面直接拒绝） */
function riskLine(risk: RiskVerdict): string {
  if (risk.level !== "danger") return "";
  const parts = [`\n\n风险项：${risk.title}`, `原因：${risk.reason}`];
  if (risk.suggestion) parts.push(`建议：${risk.suggestion}`);
  return parts.join("\n");
}
